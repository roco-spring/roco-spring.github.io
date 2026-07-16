import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import type { RegistrationReservation } from "../src/idempotency.js";
import { allocateTeamIdentity, formatTeamId } from "../src/team-id.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

function reservation(
  fake: FakeFirestore,
  requestId: string,
  leaseId: string,
): RegistrationReservation {
  const reference = fake.collection("registrationRequests").doc(requestId);
  fake.seed(reference.path, { state: "allocating", leaseId });
  return {
    requestId,
    reference: reference as unknown as DocumentReference,
    leaseId,
    state: "allocating",
    isNew: true,
  };
}

describe("team ID allocation", () => {
  it("formats the visible ID as RoCo-N", () => {
    expect(formatTeamId(1)).toBe("RoCo-1");
    expect(formatTeamId(438)).toBe("RoCo-438");
  });

  it("rejects invalid team numbers", () => {
    expect(() => formatTeamId(0)).toThrow(RangeError);
    expect(() => formatTeamId(1.5)).toThrow(RangeError);
  });

  it("atomically increments without duplicate IDs under concurrency", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const reservations = Array.from({ length: 40 }, (_, index) =>
      reservation(fake, `request-${index}`, `lease-${index}`),
    );
    const identities = await Promise.all(
      reservations.map(async (item) => allocateTeamIdentity(db, item)),
    );
    expect(new Set(identities.map((identity) => identity.teamId))).toHaveLength(40);
    expect(identities.map((identity) => identity.teamNumber).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect(fake.read("systemCounters/teamRegistration")?.lastAllocatedTeamNumber).toBe(40);
  });

  it("uses only the monotonic counter and never a team-document count", async () => {
    const fake = new FakeFirestore();
    fake.seed("systemCounters/teamRegistration", { lastAllocatedTeamNumber: 8 });
    fake.seed("teams/RoCo-999", { teamId: "RoCo-999" });
    const identity = await allocateTeamIdentity(
      fake as unknown as Firestore,
      reservation(fake, "next", "lease-next"),
    );
    expect(identity).toEqual({ teamId: "RoCo-9", teamNumber: 9 });
  });

  it("does not reuse a number after a failed registration", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const failed = reservation(fake, "failed", "failed-lease");
    expect((await allocateTeamIdentity(db, failed)).teamId).toBe("RoCo-1");
    fake.update("registrationRequests/failed", { state: "failed" });
    const next = reservation(fake, "next", "next-lease");
    expect((await allocateTeamIdentity(db, next)).teamId).toBe("RoCo-2");
  });

  it("returns the same allocation when a request resumes", async () => {
    const fake = new FakeFirestore();
    const db = fake as unknown as Firestore;
    const item = reservation(fake, "same", "same-lease");
    const first = await allocateTeamIdentity(db, item);
    const second = await allocateTeamIdentity(db, item);
    expect(second).toEqual(first);
    expect(fake.read("systemCounters/teamRegistration")?.lastAllocatedTeamNumber).toBe(1);
  });
});
