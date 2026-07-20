import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  advanceRegistration,
  fenceStaleRegistrationForCleanup,
  idempotencyDocumentId,
  markRegistrationFailed,
  reserveRegistration,
} from "../src/idempotency.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

describe("registration idempotency", () => {
  it("binds one key to one payload and replays the safe result", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const first = await reserveRegistration(db, "key-1", "a".repeat(64), "b".repeat(64), 1_000);
    await advanceRegistration(db, first, "active", {
      teamId: "RoCo-1",
      teamNumber: 1,
      emailStatus: "sent",
    });
    const replay = await reserveRegistration(
      db,
      "key-1",
      "a".repeat(64),
      "b".repeat(64),
      2_000,
    );
    expect(replay.result).toEqual({ teamId: "RoCo-1", emailStatus: "sent" });
    expect(fake.values.has(`registrationRequests/${idempotencyDocumentId("key-1")}`)).toBe(true);
  });

  it("rejects the same key with a different payload", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    await reserveRegistration(db, "key-2", "a".repeat(64), "b".repeat(64), 1_000);
    await expect(
      reserveRegistration(db, "key-2", "c".repeat(64), "b".repeat(64), 2_000),
    ).rejects.toMatchObject({ code: "already-exists" });
  });

  it("allows only one active processor for concurrent repeats", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const results = await Promise.allSettled([
      reserveRegistration(db, "key-3", "a".repeat(64), "b".repeat(64), 1_000),
      reserveRegistration(db, "key-3", "a".repeat(64), "b".repeat(64), 1_000),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      [...fake.values.keys()].filter((path) => path.startsWith("registrationRequests/")),
    ).toHaveLength(1);
  });

  it("backfills the cleanup email hash when reacquiring a legacy saga", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const first = await reserveRegistration(
      db,
      "legacy-without-email-ownership",
      "a".repeat(64),
      "b".repeat(64),
      0,
    );
    fake.update(first.reference.path, {
      leaseExpiresAt: Timestamp.fromMillis(0),
    });

    const reacquired = await reserveRegistration(
      db,
      "legacy-without-email-ownership",
      "a".repeat(64),
      "b".repeat(64),
      1,
      undefined,
      "stable-email-ownership-id",
    );

    expect(reacquired.emailOwnershipId).toBe("stable-email-ownership-id");
    expect(fake.read(first.reference.path)?.emailOwnershipId).toBe(
      "stable-email-ownership-id",
    );
  });

  it("does not overwrite a saga owned by a newer lease when marking failure", async () => {
    const fake = new FakeFirestore();
    const reservation = await reserveRegistration(
      fake as unknown as Firestore,
      "key-newer-lease",
      "a".repeat(64),
      "b".repeat(64),
      1_000,
    );
    fake.update(reservation.reference.path, { leaseId: "newer-lease" });

    await expect(
      markRegistrationFailed(
        fake as unknown as Firestore,
        reservation,
        "external_permanent",
        { required: true },
      ),
    ).resolves.toBe(false);
    expect(fake.read(reservation.reference.path)?.state).toBe("allocating");
  });

  it("propagates infrastructure failure instead of pretending cleanup state was recorded", async () => {
    const fake = new FakeFirestore();
    const reservation = await reserveRegistration(
      fake as unknown as Firestore,
      "key-failed-write",
      "a".repeat(64),
      "b".repeat(64),
      1_000,
    );
    const infrastructureError = Object.assign(
      new Error("Firestore temporarily unavailable"),
      { code: "unavailable" },
    );
    vi.spyOn(fake, "runTransaction").mockRejectedValueOnce(infrastructureError);

    await expect(
      markRegistrationFailed(
        fake as unknown as Firestore,
        reservation,
        "external_permanent",
        { required: true },
      ),
    ).rejects.toBe(infrastructureError);
  });

  it("backs off stale cleanup when a client wins a fresh registration lease", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const first = await reserveRegistration(
      db,
      "key-client-wins",
      "a".repeat(64),
      "b".repeat(64),
      0,
    );
    fake.update(first.reference.path, {
      updatedAt: Timestamp.fromMillis(0),
      leaseExpiresAt: Timestamp.fromMillis(0),
    });
    await reserveRegistration(
      db,
      "key-client-wins",
      "a".repeat(64),
      "b".repeat(64),
      700_000,
    );
    fake.update(first.reference.path, { updatedAt: Timestamp.fromMillis(0) });

    await expect(
      fenceStaleRegistrationForCleanup(db, first.requestId, 100_000, 700_001),
    ).resolves.toBe(false);
    expect(fake.read(first.reference.path)?.state).toBe("allocating");
  });

  it("blocks while stale cleanup is pending, then revives the same safe attempt", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const reservation = await reserveRegistration(
      db,
      "key-cleanup-wins",
      "a".repeat(64),
      "b".repeat(64),
      0,
    );
    fake.update(reservation.reference.path, {
      updatedAt: Timestamp.fromMillis(0),
      leaseExpiresAt: Timestamp.fromMillis(0),
      sheetCreateAttemptedAt: Timestamp.fromMillis(1),
      teamId: "RoCo-17",
      teamNumber: 17,
    });

    await expect(
      fenceStaleRegistrationForCleanup(
        db,
        reservation.requestId,
        100_000,
        700_000,
      ),
    ).resolves.toBe(true);
    expect(fake.read(reservation.reference.path)).toMatchObject({
      state: "failed",
      cleanupState: "pending",
      cleanupAmbiguousSheet: true,
    });
    await expect(
      reserveRegistration(
        db,
        "key-cleanup-wins",
        "a".repeat(64),
        "b".repeat(64),
        700_001,
      ),
    ).rejects.toMatchObject({ code: "aborted" });

    fake.update(reservation.reference.path, { cleanupState: "complete" });
    const revived = await reserveRegistration(
      db,
      "key-cleanup-wins",
      "a".repeat(64),
      "b".repeat(64),
      700_002,
    );
    expect(revived).toMatchObject({
      requestId: reservation.requestId,
      state: "allocating",
      isNew: false,
      teamId: "RoCo-17",
      teamNumber: 17,
    });
    expect(revived.leaseId).not.toBe(reservation.leaseId);
    expect(fake.read(reservation.reference.path)).toMatchObject({
      state: "allocating",
      teamId: "RoCo-17",
      teamNumber: 17,
    });
    expect(fake.read(reservation.reference.path)).not.toHaveProperty(
      "cleanupState",
    );
  });

  it.each(["google_transient", "google_configuration"])(
    "revives a fully cleaned %s failure",
    async (safeCategory) => {
      const fake = new FakeFirestore();
      const db = fake as unknown as Firestore;
      const reservation = await reserveRegistration(
        db,
        `key-${safeCategory}`,
        "a".repeat(64),
        "b".repeat(64),
        1_000,
      );
      await markRegistrationFailed(db, reservation, safeCategory, {
        required: false,
      });

      await expect(
        reserveRegistration(
          db,
          `key-${safeCategory}`,
          "a".repeat(64),
          "b".repeat(64),
          2_000,
        ),
      ).resolves.toMatchObject({ state: "allocating", isNew: false });
    },
  );

  it("keeps unsafe failed attempts terminal", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const reservation = await reserveRegistration(
      db,
      "key-unsafe-failure",
      "a".repeat(64),
      "b".repeat(64),
      1_000,
    );
    await markRegistrationFailed(db, reservation, "external_permanent", {
      required: false,
    });

    await expect(
      reserveRegistration(
        db,
        "key-unsafe-failure",
        "a".repeat(64),
        "b".repeat(64),
        2_000,
      ),
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });
});

describe("transactional rate limits", () => {
  it("does not increment rate limits when reviving the same cleaned request", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const reservation = await reserveRegistration(
      db,
      "same-cleaned-request",
      "a".repeat(64),
      "normalized-email",
      100_000,
      { ip: "same-ip", email: "same-email" },
    );
    await markRegistrationFailed(db, reservation, "transient", {
      required: false,
    });

    await reserveRegistration(
      db,
      "same-cleaned-request",
      "a".repeat(64),
      "normalized-email",
      100_001,
      { ip: "same-ip", email: "same-email" },
    );

    expect(fake.read("rateLimits/ip_same-ip")?.count).toBe(1);
    expect(fake.read("rateLimits/email_same-email")?.count).toBe(1);
  });

  it("permits five IP attempts per hour and rejects the sixth", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        reserveRegistration(
          db,
          `ip-key-${index}`,
          "a".repeat(64),
          `normalized-email-${index}`,
          100_000,
          { ip: "same-ip", email: `email-${index}` },
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fake.read("rateLimits/ip_same-ip")?.count).toBe(5);
  });

  it("permits three email attempts per day and rejects the fourth", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    for (let index = 0; index < 3; index += 1) {
      await reserveRegistration(
        db,
        `email-key-${index}`,
        "a".repeat(64),
        "normalized-email",
        100_000,
        { ip: `ip-${index}`, email: "same-email" },
      );
    }
    await expect(
      reserveRegistration(
        db,
        "email-key-4",
        "a".repeat(64),
        "normalized-email",
        100_000,
        { ip: "ip-4", email: "same-email" },
      ),
    ).rejects.toMatchObject({ code: "resource-exhausted" });
    expect(fake.read("rateLimits/email_same-email")?.count).toBe(3);
  });
});
