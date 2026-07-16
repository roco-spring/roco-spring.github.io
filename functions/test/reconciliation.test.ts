import type { Auth } from "firebase-admin/auth";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleApiClients } from "../src/google-auth.js";
import type { TeamDocument } from "../src/models.js";

const mocks = vi.hoisted(() => ({
  claimEmail: vi.fn(),
  deleteResources: vi.fn(),
  deleteSpreadsheet: vi.fn(),
  fenceStale: vi.fn(),
  findSpreadsheets: vi.fn(),
  finishEmail: vi.fn(),
  sendEmail: vi.fn(),
  synchronize: vi.fn(),
}));

vi.mock("../src/gmail.js", () => ({
  sendRegistrationEmail: mocks.sendEmail,
}));
vi.mock("../src/google-drive.js", () => ({
  deleteTeamSpreadsheet: mocks.deleteSpreadsheet,
  findRegistrationSpreadsheets: mocks.findSpreadsheets,
}));
vi.mock("../src/idempotency.js", () => ({
  fenceStaleRegistrationForCleanup: mocks.fenceStale,
}));
vi.mock("../src/team-repository.js", () => ({
  claimRegistrationEmailAttempt: mocks.claimEmail,
  deleteTeamResources: mocks.deleteResources,
  finishRegistrationEmailAttempt: mocks.finishEmail,
}));
vi.mock("../src/teams.js", () => ({
  synchronizeLatestTeamOperation: mocks.synchronize,
}));

import { reconcileRegistrationsOperation } from "../src/reconciliation.js";

function team(teamId: string, overrides: Partial<TeamDocument> = {}): TeamDocument {
  const now = Timestamp.fromMillis(1_000);
  return {
    teamId,
    teamNumber: Number(teamId.replace(/\D/gu, "")) || 1,
    teamName: `${teamId} Team`,
    ownerUid: `${teamId}-owner`,
    primaryContactEmail: `${teamId.toLowerCase()}@example.org`,
    tracks: ["optical-flow"],
    members: [{
      fullName: "Owner Person",
      email: `${teamId.toLowerCase()}@example.org`,
      affiliation: "Example Institute",
    }],
    createdAt: now,
    updatedAt: now,
    revision: 1,
    status: "active",
    sheetId: `${teamId}-sheet`,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${teamId}-sheet/edit`,
    sheetSyncStatus: "pending",
    sheetLastSyncedRevision: 0,
    sheetSyncLastAttemptAt: null,
    sheetSyncRetryCount: 0,
    sheetSyncLeaseId: null,
    sheetSyncLeaseExpiresAt: null,
    sheetAuditAt: now,
    registrationEmailStatus: "pending",
    registrationEmailLastAttemptAt: null,
    registrationEmailRetryCount: 0,
    registrationEmailLeaseId: null,
    registrationEmailLeaseExpiresAt: null,
    registrationEmailRetryIneligible: false,
    registrationRequestId: `${teamId}-request`,
    ...overrides,
  };
}

function documentSnapshot(
  id: string,
  data: Record<string, unknown>,
  afterFenceData: Record<string, unknown> = data,
) {
  const update = vi.fn().mockResolvedValue(undefined);
  const afterFence = {
    id,
    exists: true,
    data: () => afterFenceData,
    ref: { update },
  };
  const ref = {
    update,
    get: vi.fn().mockResolvedValue(afterFence),
  };
  return {
    snapshot: { id, exists: true, data: () => data, ref },
    update,
  };
}

interface QueryRoute {
  collection: string;
  field: string;
  value: unknown;
  docs: unknown[];
}

function routedFirestore(routes: QueryRoute[]): Firestore {
  return {
    collection(collection: string) {
      const filters: Array<{ field: string; value: unknown }> = [];
      const query = {
        where(field: string, _operator: string, value: unknown) {
          filters.push({ field, value });
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        get() {
          const route = routes.find((candidate) =>
            candidate.collection === collection &&
            filters.some((filter) =>
              filter.field === candidate.field &&
              (Array.isArray(candidate.value)
                ? Array.isArray(filter.value)
                : filter.value === candidate.value),
            ),
          );
          return Promise.resolve({ docs: route?.docs ?? [] });
        },
      };
      return query;
    },
  } as unknown as Firestore;
}

function dependencies() {
  const adminAuth = {
    getUser: vi.fn().mockImplementation((uid: string) => Promise.resolve({
      uid,
      email: "roco-email@example.org",
      disabled: false,
      customClaims: { mustChangePassword: true },
    })),
    updateUser: vi.fn().mockResolvedValue(undefined),
    setCustomUserClaims: vi.fn().mockResolvedValue(undefined),
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined),
    deleteUser: vi.fn().mockResolvedValue(undefined),
  } as unknown as Auth;
  const google = {
    auth: {},
    drive: {},
    sheets: {},
    gmail: {},
  } as unknown as GoogleApiClients;
  return { adminAuth, google };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.synchronize.mockResolvedValue("synced");
  mocks.finishEmail.mockResolvedValue("sent");
  mocks.sendEmail.mockResolvedValue(undefined);
  mocks.deleteSpreadsheet.mockResolvedValue(undefined);
  mocks.deleteResources.mockResolvedValue(undefined);
  mocks.findSpreadsheets.mockResolvedValue([]);
  mocks.fenceStale.mockResolvedValue(false);
});

describe("scheduled reconciliation routing", () => {
  it("routes pending sheet, audit, email, and cleanup documents to isolated handlers", async () => {
    const sheetTeam = team("RoCo-11");
    const auditTeam = team("RoCo-12", { sheetSyncStatus: "synced" });
    const emailTeam = team("RoCo-13", {
      primaryContactEmail: "roco-email@example.org",
      ownerUid: "email-owner",
    });
    const cleanup = documentSnapshot("cleanup-request", {
      cleanupOwnerUid: "cleanup-owner",
      cleanupTeamId: "RoCo-14",
      cleanupSheetId: "cleanup-sheet",
      cleanupRetryCount: 0,
      cleanupAmbiguousSheet: false,
    });
    mocks.claimEmail.mockResolvedValue({
      leaseId: "email-lease",
      team: emailTeam,
    });
    const db = routedFirestore([
      { collection: "teams", field: "sheetSyncStatus", value: "pending", docs: [documentSnapshot("RoCo-11", sheetTeam as unknown as Record<string, unknown>).snapshot] },
      { collection: "teams", field: "sheetSyncStatus", value: "synced", docs: [documentSnapshot("RoCo-12", auditTeam as unknown as Record<string, unknown>).snapshot] },
      { collection: "teams", field: "registrationEmailStatus", value: "pending", docs: [documentSnapshot("RoCo-13", emailTeam as unknown as Record<string, unknown>).snapshot] },
      { collection: "registrationRequests", field: "cleanupState", value: "pending", docs: [cleanup.snapshot] },
      { collection: "registrationRequests", field: "state", value: ["allocating"], docs: [] },
    ]);
    const { adminAuth, google } = dependencies();

    await reconcileRegistrationsOperation(db, adminAuth, google);

    expect(mocks.synchronize).toHaveBeenCalledWith(
      db,
      google,
      "RoCo-11",
      "Reconciliation",
      false,
    );
    expect(mocks.synchronize).toHaveBeenCalledWith(
      db,
      google,
      "RoCo-12",
      "Reconciliation",
      true,
    );
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.finishEmail).toHaveBeenCalledWith(
      db,
      "RoCo-13",
      "email-lease",
      "sent",
    );
    expect(mocks.deleteSpreadsheet).toHaveBeenCalledWith(
      google.drive,
      "cleanup-sheet",
    );
    expect(mocks.deleteResources).toHaveBeenCalledWith(
      db,
      "RoCo-14",
      "cleanup-owner",
      "cleanup-request",
    );
    expect(cleanup.update).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupState: "complete" }),
    );
  });

  it("fences a stale incomplete saga before observing ambiguous cleanup", async () => {
    const afterFence = {
      cleanupOwnerUid: "stale-owner",
      cleanupRetryCount: 0,
      cleanupAmbiguousSheet: true,
      cleanupNoSheetObservationCount: 2,
      cleanupSheetCreateAttemptedAt: Timestamp.fromMillis(0),
    };
    const stale = documentSnapshot(
      "stale-request",
      { state: "auth_created", updatedAt: Timestamp.fromMillis(0) },
      afterFence,
    );
    mocks.fenceStale.mockResolvedValue(true);
    const db = routedFirestore([
      { collection: "registrationRequests", field: "state", value: ["allocating"], docs: [stale.snapshot] },
    ]);
    const { adminAuth, google } = dependencies();

    await reconcileRegistrationsOperation(db, adminAuth, google);

    expect(mocks.fenceStale).toHaveBeenCalledWith(
      db,
      "stale-request",
      expect.any(Number),
      expect.any(Number),
    );
    expect(mocks.findSpreadsheets).toHaveBeenCalledWith(
      google.drive,
      "stale-request",
      { requireConfiguredParent: false },
    );
    expect(stale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupState: "complete",
        cleanupNoSheetObservationCount: 3,
      }),
    );
  });

  it("continues other jobs when one email claim throws", async () => {
    const emailTeam = team("RoCo-21");
    const cleanup = documentSnapshot("cleanup-isolated", {
      cleanupOwnerUid: "cleanup-owner",
      cleanupRetryCount: 0,
      cleanupAmbiguousSheet: false,
    });
    mocks.claimEmail.mockRejectedValue(
      Object.assign(new Error("temporary Firestore error"), {
        code: "unavailable",
      }),
    );
    const db = routedFirestore([
      { collection: "teams", field: "registrationEmailStatus", value: "pending", docs: [documentSnapshot("RoCo-21", emailTeam as unknown as Record<string, unknown>).snapshot] },
      { collection: "registrationRequests", field: "cleanupState", value: "pending", docs: [cleanup.snapshot] },
    ]);
    const { adminAuth, google } = dependencies();

    await expect(
      reconcileRegistrationsOperation(db, adminAuth, google),
    ).resolves.toBeUndefined();
    expect(cleanup.update).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupState: "complete" }),
    );
  });
});
