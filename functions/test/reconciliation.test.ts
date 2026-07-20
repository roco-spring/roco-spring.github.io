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
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  reviveCleanup: vi.fn(),
  reviveEmail: vi.fn(),
  reviveSheet: vi.fn(),
  sendEmail: vi.fn(),
  synchronize: vi.fn(),
  verifyDependencies: vi.fn(),
}));

vi.mock("firebase-functions", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
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
vi.mock("../src/registration-health.js", () => ({
  verifyRegistrationDependencies: mocks.verifyDependencies,
}));
vi.mock("../src/team-repository.js", () => ({
  claimRegistrationEmailAttempt: mocks.claimEmail,
  deleteTeamResources: mocks.deleteResources,
  finishRegistrationEmailAttempt: mocks.finishEmail,
  reviveFailedCleanup: mocks.reviveCleanup,
  reviveFailedRegistrationEmail: mocks.reviveEmail,
  reviveFailedSheetSynchronization: mocks.reviveSheet,
}));
vi.mock("../src/teams.js", () => ({
  synchronizeLatestTeamOperationResult: mocks.synchronize,
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
    get: (field: string) => afterFenceData[field],
    ref: { update },
  };
  const ref = {
    update,
    get: vi.fn().mockResolvedValue(afterFence),
  };
  return {
    snapshot: {
      id,
      exists: true,
      data: () => data,
      get: (field: string) => data[field],
      ref,
    },
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
  const deleteUser = vi.fn().mockResolvedValue(undefined);
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
    deleteUser,
  } as unknown as Auth;
  const google = {
    auth: {},
    drive: {},
    sheets: {},
    gmail: {},
  } as unknown as GoogleApiClients;
  const getGoogle = vi.fn().mockResolvedValue(google);
  return { adminAuth, deleteUser, getGoogle, google };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.synchronize.mockResolvedValue({ status: "synced" });
  mocks.finishEmail.mockResolvedValue("sent");
  mocks.sendEmail.mockResolvedValue(undefined);
  mocks.deleteSpreadsheet.mockResolvedValue(undefined);
  mocks.deleteResources.mockResolvedValue(undefined);
  mocks.findSpreadsheets.mockResolvedValue([]);
  mocks.fenceStale.mockResolvedValue(false);
  mocks.reviveCleanup.mockResolvedValue(true);
  mocks.reviveEmail.mockResolvedValue(true);
  mocks.reviveSheet.mockResolvedValue(true);
  mocks.verifyDependencies.mockResolvedValue({ sheetsReadVerified: false });
});

describe("scheduled reconciliation routing", () => {
  it("gates Google jobs but continues safe cleanup while dependencies are unhealthy", async () => {
    const pendingTeam = team("RoCo-10", {
      sheetId: null,
      sheetUrl: null,
      sheetCreateAttemptedAt: null,
    });
    const pendingEmail = team("RoCo-15");
    const pendingAudit = team("RoCo-18", { sheetSyncStatus: "synced" });
    const cleanup = documentSnapshot("cleanup-deferred-drive", {
      cleanupOwnerUid: "cleanup-owner",
      cleanupTeamId: "RoCo-16",
      cleanupSheetId: "cleanup-sheet",
      cleanupRetryCount: 2,
      cleanupAmbiguousSheet: false,
      cleanupNoSheetObservationCount: 0,
      cleanupSafeErrorCategory: "external-service",
    });
    const cleanupWithoutDrive = documentSnapshot("cleanup-without-drive", {
      cleanupOwnerUid: "safe-only-owner",
      cleanupTeamId: "RoCo-19",
      cleanupRetryCount: 1,
      cleanupAmbiguousSheet: false,
    });
    const db = routedFirestore([
      {
        collection: "teams",
        field: "sheetSyncStatus",
        value: "pending",
        docs: [
          documentSnapshot(
            "RoCo-10",
            pendingTeam as unknown as Record<string, unknown>,
          ).snapshot,
        ],
      },
      {
        collection: "teams",
        field: "registrationEmailStatus",
        value: "pending",
        docs: [
          documentSnapshot(
            "RoCo-15",
            pendingEmail as unknown as Record<string, unknown>,
          ).snapshot,
        ],
      },
      {
        collection: "teams",
        field: "sheetSyncStatus",
        value: "synced",
        docs: [
          documentSnapshot(
            "RoCo-18",
            pendingAudit as unknown as Record<string, unknown>,
          ).snapshot,
        ],
      },
      {
        collection: "registrationRequests",
        field: "cleanupState",
        value: "pending",
        docs: [cleanup.snapshot, cleanupWithoutDrive.snapshot],
      },
    ]);
    const { adminAuth, deleteUser, getGoogle, google } = dependencies();
    mocks.verifyDependencies.mockRejectedValueOnce(
      Object.assign(new Error("OAuth unavailable"), {
        response: { status: 401 },
      }),
    );

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);
    expect(getGoogle).toHaveBeenCalledTimes(1);
    expect(mocks.verifyDependencies).toHaveBeenCalledWith(google);
    expect(mocks.verifyDependencies.mock.calls[0]).toEqual([google]);
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(mocks.claimEmail).not.toHaveBeenCalled();
    expect(mocks.findSpreadsheets).not.toHaveBeenCalled();
    expect(mocks.deleteSpreadsheet).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("cleanup-owner");
    expect(mocks.deleteResources).toHaveBeenCalledWith(
      db,
      "RoCo-16",
      "cleanup-owner",
      "cleanup-deferred-drive",
    );
    expect(cleanup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupState: "pending",
        cleanupRetryCount: 2,
        cleanupNoSheetObservationCount: 0,
      }),
    );
    const deferredUpdate = cleanup.update.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(deferredUpdate).not.toHaveProperty("cleanupSheetId");
    expect(deferredUpdate).not.toHaveProperty("cleanupSafeErrorCategory");
    expect(deleteUser).toHaveBeenCalledWith("safe-only-owner");
    expect(mocks.deleteResources).toHaveBeenCalledWith(
      db,
      "RoCo-19",
      "safe-only-owner",
      "cleanup-without-drive",
    );
    expect(cleanupWithoutDrive.update).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupState: "complete",
        cleanupRetryCount: 0,
      }),
    );

    mocks.verifyDependencies.mockResolvedValueOnce({
      sheetsReadVerified: false,
    });
    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);
    expect(mocks.synchronize).toHaveBeenCalledWith(
      db,
      google,
      "RoCo-10",
      "Reconciliation",
      false,
    );
    expect(mocks.claimEmail).toHaveBeenCalledTimes(1);
    expect(mocks.deleteSpreadsheet).toHaveBeenCalledWith(
      google.drive,
      "cleanup-sheet",
    );
    expect(cleanup.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cleanupState: "complete",
        cleanupRetryCount: 0,
        cleanupSheetId: null,
      }),
    );
  });

  it("fences stale work and defers only its Drive cleanup when Google is unhealthy", async () => {
    const afterFence = {
      cleanupOwnerUid: "stale-owner",
      cleanupTeamId: "RoCo-17",
      cleanupRetryCount: 3,
      cleanupAmbiguousSheet: true,
      cleanupNoSheetObservationCount: 1,
      cleanupSheetCreateAttemptedAt: Timestamp.fromMillis(0),
    };
    const stale = documentSnapshot(
      "stale-unhealthy-request",
      { state: "auth_created", updatedAt: Timestamp.fromMillis(0) },
      afterFence,
    );
    mocks.fenceStale.mockResolvedValue(true);
    const db = routedFirestore([
      {
        collection: "registrationRequests",
        field: "state",
        value: ["allocating"],
        docs: [stale.snapshot],
      },
    ]);
    const { adminAuth, deleteUser, getGoogle } = dependencies();
    getGoogle.mockRejectedValueOnce(
      Object.assign(new Error("Google client initialization unavailable"), {
        response: { status: 503 },
      }),
    );

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);

    expect(mocks.verifyDependencies).not.toHaveBeenCalled();
    expect(mocks.fenceStale).toHaveBeenCalledWith(
      db,
      "stale-unhealthy-request",
      expect.any(Number),
      expect.any(Number),
    );
    expect(mocks.findSpreadsheets).not.toHaveBeenCalled();
    expect(mocks.deleteSpreadsheet).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("stale-owner");
    expect(mocks.deleteResources).toHaveBeenCalledWith(
      db,
      "RoCo-17",
      "stale-owner",
      "stale-unhealthy-request",
    );
    expect(stale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupState: "pending",
        cleanupRetryCount: 3,
        cleanupNoSheetObservationCount: 1,
      }),
    );
  });

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
    const { adminAuth, getGoogle, google } = dependencies();

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);

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
    const { adminAuth, getGoogle, google } = dependencies();

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);

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
    const { adminAuth, getGoogle } = dependencies();

    await expect(
      reconcileRegistrationsOperation(db, adminAuth, getGoogle),
    ).resolves.toBeUndefined();
    expect(cleanup.update).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupState: "complete" }),
    );
  });

  it("stops launching jobs at 100 seconds and reports every deferred item", async () => {
    const pendingTeam = team("RoCo-31");
    const cleanup = documentSnapshot("cleanup-cutoff", {
      cleanupOwnerUid: "cutoff-owner",
      cleanupRetryCount: 0,
      cleanupAmbiguousSheet: false,
    });
    const db = routedFirestore([
      {
        collection: "teams",
        field: "sheetSyncStatus",
        value: "pending",
        docs: [
          documentSnapshot(
            "RoCo-31",
            pendingTeam as unknown as Record<string, unknown>,
          ).snapshot,
        ],
      },
      {
        collection: "registrationRequests",
        field: "cleanupState",
        value: "pending",
        docs: [cleanup.snapshot],
      },
    ]);
    const { adminAuth, getGoogle } = dependencies();
    let firstClockRead = true;
    const now = (): number => {
      if (firstClockRead) {
        firstClockRead = false;
        return 0;
      }
      return 100_000;
    };

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle, { now });

    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(cleanup.update).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Reconciliation scheduler pass completed",
      expect.objectContaining({
        operation: "reconcileRegistrations",
        startedAtMs: 0,
        queuedCount: 2,
        launchedCount: 0,
        deferredCount: 2,
      }),
    );
  });

  it("revives only day-old transient failures for one controlled probe", async () => {
    const lastAttemptAt = Timestamp.fromMillis(1_000);
    const failedSheet = documentSnapshot("RoCo-41", {
      ...team("RoCo-41", {
        sheetSyncStatus: "failed",
        sheetSyncLastAttemptAt: lastAttemptAt,
        sheetSyncRetryCount: 5,
      }),
      sheetSyncSafeErrorCategory: "transient",
    });
    const terminalSheet = documentSnapshot("RoCo-42", {
      ...team("RoCo-42", {
        sheetSyncStatus: "failed",
        sheetSyncLastAttemptAt: lastAttemptAt,
        sheetSyncRetryCount: 5,
      }),
      sheetSyncSafeErrorCategory: "google_configuration",
    });
    const failedEmailTeam = team("RoCo-43", {
      ownerUid: "revived-email-owner",
      primaryContactEmail: "roco-email@example.org",
      registrationEmailStatus: "failed",
      registrationEmailLastAttemptAt: lastAttemptAt,
      registrationEmailRetryCount: 5,
    });
    const failedEmail = documentSnapshot("RoCo-43", {
      ...failedEmailTeam,
      registrationEmailSafeErrorCategory: "google_transient",
    });
    const terminalEmail = documentSnapshot("RoCo-44", {
      ...team("RoCo-44", {
        registrationEmailStatus: "failed",
        registrationEmailLastAttemptAt: lastAttemptAt,
        registrationEmailRetryCount: 5,
      }),
      registrationEmailSafeErrorCategory: "internal",
    });
    const failedCleanup = documentSnapshot("cleanup-revival", {
      cleanupState: "failed",
      cleanupRetryCount: 5,
      cleanupLastAttemptAt: lastAttemptAt,
      cleanupSafeErrorCategory: "transient",
      cleanupAmbiguousSheet: false,
    });
    const terminalCleanup = documentSnapshot("cleanup-terminal", {
      cleanupState: "failed",
      cleanupRetryCount: 5,
      cleanupLastAttemptAt: lastAttemptAt,
      cleanupSafeErrorCategory: "external_permanent",
      cleanupAmbiguousSheet: false,
    });
    mocks.claimEmail.mockResolvedValue({
      leaseId: "revived-email-lease",
      team: failedEmailTeam,
    });
    const db = routedFirestore([
      {
        collection: "teams",
        field: "sheetSyncSafeErrorCategory",
        value: ["transient", "google_transient"],
        docs: [failedSheet.snapshot, terminalSheet.snapshot],
      },
      {
        collection: "teams",
        field: "registrationEmailSafeErrorCategory",
        value: ["transient", "google_transient"],
        docs: [failedEmail.snapshot, terminalEmail.snapshot],
      },
      {
        collection: "registrationRequests",
        field: "cleanupSafeErrorCategory",
        value: ["transient", "google_transient"],
        docs: [failedCleanup.snapshot, terminalCleanup.snapshot],
      },
    ]);
    const { adminAuth, getGoogle } = dependencies();
    const startedAtMs = 2 * 24 * 60 * 60 * 1_000;

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle, {
      now: () => startedAtMs,
    });

    const cutoffMs = startedAtMs - 24 * 60 * 60 * 1_000;
    expect(mocks.reviveSheet).toHaveBeenCalledWith(db, "RoCo-41", cutoffMs);
    expect(mocks.reviveSheet).not.toHaveBeenCalledWith(
      db,
      "RoCo-42",
      expect.any(Number),
    );
    expect(mocks.reviveEmail).toHaveBeenCalledWith(db, "RoCo-43", cutoffMs);
    expect(mocks.reviveEmail).not.toHaveBeenCalledWith(
      db,
      "RoCo-44",
      expect.any(Number),
    );
    expect(mocks.reviveCleanup).toHaveBeenCalledWith(
      db,
      "cleanup-revival",
      cutoffMs,
    );
    expect(mocks.reviveCleanup).not.toHaveBeenCalledWith(
      db,
      "cleanup-terminal",
      expect.any(Number),
    );
    expect(mocks.synchronize).toHaveBeenCalledTimes(1);
    expect(mocks.claimEmail).toHaveBeenCalledTimes(1);
    expect(failedCleanup.update).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupState: "complete" }),
    );
  });

  it("emits structured error logs for every terminal resource outcome", async () => {
    const sheetTeam = team("RoCo-51");
    const emailTeam = team("RoCo-52", {
      ownerUid: "terminal-email-owner",
      primaryContactEmail: "roco-email@example.org",
    });
    const cleanup = documentSnapshot("cleanup-terminal-log", {
      cleanupOwnerUid: "terminal-cleanup-owner",
      cleanupTeamId: "RoCo-53",
      cleanupRetryCount: 4,
      cleanupAmbiguousSheet: false,
    });
    mocks.synchronize.mockResolvedValue({
      status: "failed",
      errorCategory: "external_permanent",
    });
    mocks.claimEmail.mockResolvedValue({
      leaseId: "terminal-email-lease",
      team: emailTeam,
    });
    mocks.sendEmail.mockRejectedValue({
      name: "GaxiosError",
      response: { status: 400 },
      config: {},
    });
    mocks.finishEmail.mockResolvedValue("failed");
    mocks.deleteResources.mockRejectedValue(new Error("Firestore unavailable"));
    const db = routedFirestore([
      {
        collection: "teams",
        field: "sheetSyncStatus",
        value: "pending",
        docs: [
          documentSnapshot(
            "RoCo-51",
            sheetTeam as unknown as Record<string, unknown>,
          ).snapshot,
        ],
      },
      {
        collection: "teams",
        field: "registrationEmailStatus",
        value: "pending",
        docs: [
          documentSnapshot(
            "RoCo-52",
            emailTeam as unknown as Record<string, unknown>,
          ).snapshot,
        ],
      },
      {
        collection: "registrationRequests",
        field: "cleanupState",
        value: "pending",
        docs: [cleanup.snapshot],
      },
    ]);
    const { adminAuth, getGoogle } = dependencies();

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);

    for (const [resourceType, errorCategory] of [
      ["sheet", "external_permanent"],
      ["email", "external_permanent"],
      ["cleanup", "internal"],
    ] as const) {
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          operation: "reconcileRegistrations",
          status: "failed",
          resourceType,
          errorCategory,
        }),
      );
    }
  });

  it("bounds ambiguous Drive cleanup deletions within one scheduler job", async () => {
    const cleanup = documentSnapshot("cleanup-many-sheets", {
      cleanupRetryCount: 0,
      cleanupAmbiguousSheet: true,
      cleanupNoSheetObservationCount: 0,
      cleanupSheetCreateAttemptedAt: Timestamp.fromMillis(0),
    });
    mocks.findSpreadsheets.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({ id: `sheet-${index + 1}` })),
    );
    const db = routedFirestore([
      {
        collection: "registrationRequests",
        field: "cleanupState",
        value: "pending",
        docs: [cleanup.snapshot],
      },
    ]);
    const { adminAuth, getGoogle } = dependencies();

    await reconcileRegistrationsOperation(db, adminAuth, getGoogle);

    expect(mocks.deleteSpreadsheet).toHaveBeenCalledTimes(8);
    expect(cleanup.update).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupState: "pending" }),
    );
  });
});
