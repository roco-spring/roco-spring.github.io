import { randomUUID } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  idempotencyDocumentId,
} from "../src/idempotency.js";
import type { RegistrationInput } from "../src/models.js";
import { registerTeamOperation } from "../src/registration.js";
import { stableEmailOwnershipId } from "../src/security.js";
import { deleteTeamResources } from "../src/team-repository.js";
import { canonicalRegistrationHash } from "../src/validation.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

function input(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
  return {
    idempotencyKey: randomUUID(),
    teamName: "Flow Masters",
    primaryContactEmail: "owner@example.org",
    tracks: ["optical-flow"],
    members: [
      {
        fullName: "Owner Person",
        email: "owner@example.org",
        affiliation: "Example Institute",
      },
    ],
    registrantConfirmed: true,
    ...overrides,
  };
}

function authMock() {
  const createUser = vi.fn().mockResolvedValue({ uid: "owner-uid" });
  const deleteUser = vi.fn().mockResolvedValue(undefined);
  return {
    implementation: {
      getUserByEmail: vi.fn().mockRejectedValue({ code: "auth/user-not-found" }),
      createUser,
      setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
      revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
      deleteUser,
    } as unknown as Auth,
    createUser,
    deleteUser,
  };
}

describe("complete registration operation", () => {
  it("commits each authoritative Firebase resource once and defers remote side effects", async () => {
    const fake = new FakeFirestore();
    const auth = authMock();
    const registration = input();
    const dependencies = {
      db: fake as unknown as Firestore,
      adminAuth: auth.implementation,
      rateLimitHmacSecret: "h".repeat(32),
    };

    const first = await registerTeamOperation(
      dependencies,
      registration,
      "192.0.2.10",
    );
    const replay = await registerTeamOperation(
      dependencies,
      registration,
      "192.0.2.10",
    );

    expect(first).toEqual({ teamId: "RoCo-1", emailStatus: "pending" });
    expect(replay).toEqual(first);
    expect(Object.keys(first)).toEqual(["teamId", "emailStatus"]);
    expect(auth.createUser).toHaveBeenCalledTimes(1);
    expect(auth.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: expect.stringMatching(/^roco_[a-f0-9]{64}$/),
      }),
    );
    expect(fake.read("systemCounters/teamRegistration")?.lastAllocatedTeamNumber).toBe(1);
    expect(fake.read("teamOwners/owner-uid")?.teamId).toBe("RoCo-1");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetId: null,
      sheetUrl: null,
      sheetSyncStatus: "pending",
      sheetLastSyncedRevision: 0,
      registrationEmailStatus: "pending",
    });
    expect(
      fake.read(`teamEmails/${stableEmailOwnershipId("owner@example.org")}`),
    ).toMatchObject({ teamId: "RoCo-1", ownerUid: "owner-uid" });
    expect(
      fake.read(
        `registrationRequests/${idempotencyDocumentId(registration.idempotencyKey)}`,
      ),
    ).toMatchObject({
      state: "email_pending",
      emailStatus: "pending",
      emailOwnershipId: stableEmailOwnershipId("owner@example.org"),
    });

    const persisted = JSON.stringify([...fake.values.values()]).toLowerCase();
    expect(persisted).not.toContain("password");
  });

  it("rejects a changed payload under the same idempotency key", async () => {
    const fake = new FakeFirestore();
    const auth = authMock();
    const registration = input();
    const dependencies = {
      db: fake as unknown as Firestore,
      adminAuth: auth.implementation,
      rateLimitHmacSecret: "h".repeat(32),
    };

    await registerTeamOperation(dependencies, registration, "192.0.2.10");
    await expect(
      registerTeamOperation(
        dependencies,
        { ...registration, teamName: "Different Team" },
        "192.0.2.10",
      ),
    ).rejects.toMatchObject({ code: "already-exists" });
    expect(auth.createUser).toHaveBeenCalledTimes(1);
  });

  it("recovers the deterministic Auth user after an interrupted create call", async () => {
    const fake = new FakeFirestore();
    const registration = input();
    const uid = `roco_${idempotencyDocumentId(registration.idempotencyKey)}`;
    const createUser = vi.fn();
    const updateUser = vi.fn().mockResolvedValue({
      uid,
      email: registration.primaryContactEmail,
      customClaims: { unrelatedClaim: "preserved" },
    });
    const revokeRefreshTokens = vi.fn().mockResolvedValue(undefined);
    const setCustomUserClaims = vi.fn().mockResolvedValue(undefined);
    const adminAuth = {
      getUserByEmail: vi.fn().mockResolvedValue({
        uid,
        email: registration.primaryContactEmail,
        customClaims: { unrelatedClaim: "preserved" },
      }),
      createUser,
      updateUser,
      revokeRefreshTokens,
      setCustomUserClaims,
      deleteUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as Auth;

    await expect(
      registerTeamOperation(
        {
          db: fake as unknown as Firestore,
          adminAuth,
          rateLimitHmacSecret: "h".repeat(32),
        },
        registration,
        "192.0.2.10",
      ),
    ).resolves.toEqual({ teamId: "RoCo-1", emailStatus: "pending" });
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith(uid, {
      password: expect.any(String),
    });
    expect(revokeRefreshTokens).toHaveBeenCalledWith(uid);
    expect(setCustomUserClaims).toHaveBeenCalledWith(uid, {
      mustChangePassword: true,
      unrelatedClaim: "preserved",
    });
  });

  it("promotes a legacy sheet-created saga without contacting Google", async () => {
    const fake = new FakeFirestore();
    const registration = input();
    const requestId = idempotencyDocumentId(registration.idempotencyKey);
    const ownerUid = `roco_${requestId}`;
    fake.seed(`registrationRequests/${requestId}`, {
      requestHash: canonicalRegistrationHash(registration),
      normalizedPrimaryEmailHash: "legacy-email-hash",
      state: "sheet_created",
      leaseId: "expired-legacy-lease",
      leaseExpiresAt: Timestamp.fromMillis(0),
      teamId: "RoCo-41",
      teamNumber: 41,
      ownerUid,
      sheetId: "legacy-sheet-id",
      sheetCreateAttemptedAt: Timestamp.fromMillis(1_000),
      createdAt: Timestamp.fromMillis(1_000),
      updatedAt: Timestamp.fromMillis(1_000),
    });
    const user = {
      uid: ownerUid,
      email: registration.primaryContactEmail,
      customClaims: { mustChangePassword: true },
    };
    const adminAuth = {
      getUser: vi.fn().mockResolvedValue(user),
      updateUser: vi.fn().mockResolvedValue(user),
      setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
      revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
      deleteUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as Auth;

    await expect(
      registerTeamOperation(
        {
          db: fake as unknown as Firestore,
          adminAuth,
          rateLimitHmacSecret: "h".repeat(32),
        },
        registration,
        "192.0.2.10",
      ),
    ).resolves.toEqual({ teamId: "RoCo-41", emailStatus: "pending" });

    expect(fake.read("teams/RoCo-41")).toMatchObject({
      ownerUid,
      sheetId: "legacy-sheet-id",
      sheetUrl: "https://docs.google.com/spreadsheets/d/legacy-sheet-id/edit",
      sheetSyncStatus: "pending",
      sheetLastSyncedRevision: 0,
    });
    expect(fake.read(`registrationRequests/${requestId}`)).toMatchObject({
      state: "email_pending",
      teamId: "RoCo-41",
      sheetId: "legacy-sheet-id",
    });
  });
});

describe("registration resource cleanup", () => {
  it("deletes only a matching team, owner mapping, and email ownership mapping", async () => {
    const fake = new FakeFirestore();
    const emailOwnershipId = stableEmailOwnershipId("owner@example.org");
    fake.seed("teams/RoCo-7", {
      teamId: "RoCo-7",
      ownerUid: "uid-7",
      primaryContactEmail: "owner@example.org",
      registrationRequestId: "request-7",
    });
    fake.seed("teamOwners/uid-7", { teamId: "RoCo-7" });
    fake.seed(`teamEmails/${emailOwnershipId}`, {
      teamId: "RoCo-7",
      ownerUid: "uid-7",
    });
    fake.seed("registrationRequests/request-7", { emailOwnershipId });

    await deleteTeamResources(
      fake as unknown as Firestore,
      "RoCo-7",
      "uid-7",
      "request-7",
    );

    expect(fake.read("teams/RoCo-7")).toBeUndefined();
    expect(fake.read("teamOwners/uid-7")).toBeUndefined();
    expect(fake.read(`teamEmails/${emailOwnershipId}`)).toBeUndefined();
  });

  it("preserves an unrelated email ownership mapping during matching cleanup", async () => {
    const fake = new FakeFirestore();
    const emailOwnershipId = stableEmailOwnershipId("owner@example.org");
    fake.seed("teams/RoCo-7", {
      teamId: "RoCo-7",
      ownerUid: "uid-7",
      primaryContactEmail: "owner@example.org",
      registrationRequestId: "request-7",
    });
    fake.seed("teamOwners/uid-7", { teamId: "RoCo-7" });
    fake.seed(`teamEmails/${emailOwnershipId}`, {
      teamId: "RoCo-99",
      ownerUid: "uid-99",
    });

    await deleteTeamResources(
      fake as unknown as Firestore,
      "RoCo-7",
      "uid-7",
      "request-7",
    );

    expect(fake.read("teams/RoCo-7")).toBeUndefined();
    expect(fake.read("teamOwners/uid-7")).toBeUndefined();
    expect(fake.read(`teamEmails/${emailOwnershipId}`)).toEqual({
      teamId: "RoCo-99",
      ownerUid: "uid-99",
    });
  });

  it("uses the saga hash to clean exact mappings after the team is already absent", async () => {
    const fake = new FakeFirestore();
    const emailOwnershipId = stableEmailOwnershipId("owner@example.org");
    fake.seed("teamOwners/uid-7", { teamId: "RoCo-7" });
    fake.seed(`teamEmails/${emailOwnershipId}`, {
      teamId: "RoCo-7",
      ownerUid: "uid-7",
    });
    fake.seed("registrationRequests/request-7", {
      cleanupEmailOwnershipId: emailOwnershipId,
    });

    await deleteTeamResources(
      fake as unknown as Firestore,
      "RoCo-7",
      "uid-7",
      "request-7",
    );

    expect(fake.read("teamOwners/uid-7")).toBeUndefined();
    expect(fake.read(`teamEmails/${emailOwnershipId}`)).toBeUndefined();
  });
});
