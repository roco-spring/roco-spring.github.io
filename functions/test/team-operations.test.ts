import { Timestamp } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type { drive_v3, gmail_v1, sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS,
  DRIVE_FOLDER_ID,
} from "../src/config.js";
import type { GoogleApiClients } from "../src/google-auth.js";
import type { TeamDocument, UpdateTeamInput } from "../src/models.js";
import {
  getMyTeamOperation,
  synchronizeLatestTeamOperation,
  updateMyTeamOperation,
} from "../src/teams.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

function team(overrides: Partial<TeamDocument> = {}): TeamDocument {
  const createdAt = Timestamp.fromDate(new Date("2026-07-01T10:00:00.000Z"));
  return {
    teamId: "RoCo-1",
    teamNumber: 1,
    teamName: "Original Team",
    ownerUid: "uid-a",
    primaryContactEmail: "owner@example.org",
    tracks: ["optical-flow"],
    members: [
      {
        fullName: "Owner Person",
        email: "owner@example.org",
        affiliation: "Example Institute",
      },
    ],
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    status: "active",
    sheetId: "stored-sheet-id",
    sheetUrl: "https://docs.google.com/spreadsheets/d/stored-sheet-id/edit",
    sheetSyncStatus: "synced",
    sheetLastSyncedRevision: 1,
    sheetSyncLastAttemptAt: createdAt,
    sheetSyncRetryCount: 0,
    sheetSyncLeaseId: null,
    sheetSyncLeaseExpiresAt: null,
    sheetAuditAt: createdAt,
    registrationEmailStatus: "sent",
    registrationEmailLastAttemptAt: createdAt,
    registrationEmailRetryCount: 0,
    registrationEmailLeaseId: null,
    registrationEmailLeaseExpiresAt: null,
    registrationEmailRetryIneligible: false,
    registrationRequestId: "request-id",
    ...overrides,
  };
}

function update(overrides: Partial<UpdateTeamInput> = {}): UpdateTeamInput {
  return {
    expectedRevision: 1,
    teamName: "Updated Team",
    tracks: ["optical-flow", "scene-flow"],
    members: [
      {
        fullName: "Owner Person",
        email: "owner@example.org",
        affiliation: "Updated Institute",
      },
    ],
    ...overrides,
  };
}

function googleMock(options: {
  ambiguousCreate?: boolean;
  failRename?: boolean;
} = {}) {
  const updateFile = options.failRename
    ? vi.fn().mockRejectedValue(new Error("drive unavailable"))
    : vi.fn().mockResolvedValue({ data: { id: "stored-sheet-id" } });
  const values = {
    clear: vi.fn().mockResolvedValue({ data: {} }),
    update: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { values: [] } }),
    append: vi.fn().mockResolvedValue({ data: {} }),
  };
  const listFiles = options.ambiguousCreate
    ? vi
        .fn()
        .mockResolvedValueOnce({ data: { files: [] } })
        .mockResolvedValue({
          data: { files: [{ id: "stored-sheet-id" }] },
        })
    : vi.fn().mockResolvedValue({ data: { files: [] } });
  const createFile = options.ambiguousCreate
    ? vi.fn().mockRejectedValue({
        name: "GaxiosError",
        response: { status: 503 },
        config: {},
      })
    : vi.fn().mockResolvedValue({
        data: { id: "stored-sheet-id", parents: [DRIVE_FOLDER_ID] },
      });
  const drive = {
    files: {
      list: listFiles,
      create: createFile,
      update: updateFile,
      get: vi.fn().mockResolvedValue({
        data: {
          id: "stored-sheet-id",
          mimeType: "application/vnd.google-apps.spreadsheet",
          appProperties: { registrationRequestId: "request-id" },
          parents: [DRIVE_FOLDER_ID],
          trashed: false,
        },
      }),
    },
    permissions: {
      list: vi.fn().mockResolvedValue({ data: { permissions: [] } }),
    },
  };
  const sheets = {
    spreadsheets: {
      get: vi.fn().mockResolvedValue({
        data: {
          sheets: [
            { properties: { sheetId: 0, title: "Team Details" } },
            { properties: { sheetId: 1, title: "Change Log" } },
          ],
        },
      }),
      batchUpdate: vi.fn().mockResolvedValue({ data: {} }),
      values,
    },
  };
  return {
    clients: {
      auth: {} as GoogleApiClients["auth"],
      oauthScopes: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/gmail.send",
      ],
      drive: drive as unknown as drive_v3.Drive,
      sheets: sheets as unknown as sheets_v4.Sheets,
      gmail: {} as gmail_v1.Gmail,
    },
    updateFile,
    createFile,
    listFiles,
    values,
  };
}

function seededTeam(overrides: Partial<TeamDocument> = {}) {
  const fake = new FakeFirestore();
  const value = team(overrides);
  fake.seed(`teams/${value.teamId}`, value as unknown as Record<string, unknown>);
  fake.seed(`teamOwners/${value.ownerUid}`, { teamId: value.teamId });
  return fake;
}

function matchingAuth(email = "owner@example.org"): Auth {
  return {
    getUser: vi.fn().mockResolvedValue({
      uid: "uid-a",
      email,
      disabled: false,
    }),
  } as unknown as Auth;
}

describe("team read and update operations", () => {
  it("returns only the authenticated owner's public editable fields", async () => {
    const result = await getMyTeamOperation(
      seededTeam() as unknown as Firestore,
      matchingAuth(),
      "uid-a",
    );
    expect(result.teamId).toBe("RoCo-1");
    expect(result.revision).toBe(1);
    expect(result).not.toHaveProperty("ownerUid");
    expect(result).not.toHaveProperty("sheetId");
    expect(result).not.toHaveProperty("registrationRequestId");
  });

  it("commits an optimistic revision and leaves synchronization to the scheduler", async () => {
    const fake = seededTeam();
    const google = googleMock();
    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      "uid-a",
      update(),
    );
    expect(result.synchronizationStatus).toBe("pending");
    expect(result.team).toMatchObject({
      teamId: "RoCo-1",
      teamName: "Updated Team",
      primaryContactEmail: "owner@example.org",
      revision: 2,
      sheetSyncStatus: "pending",
    });
    expect(google.updateFile).not.toHaveBeenCalled();
    expect(google.values.update).not.toHaveBeenCalled();
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      teamId: "RoCo-1",
      teamNumber: 1,
      ownerUid: "uid-a",
      primaryContactEmail: "owner@example.org",
      revision: 2,
      sheetSyncStatus: "pending",
    });
  });

  it("provisions and synchronizes a missing spreadsheet from the committed core", async () => {
    const fake = seededTeam({
      sheetId: null,
      sheetUrl: null,
      sheetCreateAttemptedAt: null,
      sheetCreateNoFileObservationCount: 0,
      sheetSyncStatus: "pending",
      sheetLastSyncedRevision: 0,
      sheetSyncLastAttemptAt: null,
    });
    const google = googleMock();

    await expect(
      synchronizeLatestTeamOperation(
        fake as unknown as Firestore,
        google.clients,
        "RoCo-1",
        "Reconciliation",
      ),
    ).resolves.toBe("synced");

    expect(google.createFile).toHaveBeenCalledTimes(1);
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetId: "stored-sheet-id",
      sheetUrl: "https://docs.google.com/spreadsheets/d/stored-sheet-id/edit",
      sheetSyncStatus: "synced",
      sheetLastSyncedRevision: 1,
      sheetCreateNoFileObservationCount: 0,
    });
  });

  it("recovers an ambiguous spreadsheet create without issuing a duplicate", async () => {
    const fake = seededTeam({
      sheetId: null,
      sheetUrl: null,
      sheetCreateAttemptedAt: null,
      sheetCreateNoFileObservationCount: 0,
      sheetSyncStatus: "pending",
      sheetLastSyncedRevision: 0,
      sheetSyncLastAttemptAt: null,
    });
    const google = googleMock({ ambiguousCreate: true });

    await expect(
      synchronizeLatestTeamOperation(
        fake as unknown as Firestore,
        google.clients,
        "RoCo-1",
        "Reconciliation",
      ),
    ).resolves.toBe("synced");

    expect(google.createFile).toHaveBeenCalledTimes(1);
    expect(google.listFiles).toHaveBeenCalledTimes(2);
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetId: "stored-sheet-id",
      sheetSyncStatus: "synced",
    });
  });

  it("retains an ambiguous create fence until bounded no-file evidence clears it", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2026-07-20T09:00:00.000Z").getTime();
      vi.setSystemTime(startedAt);
      const fake = seededTeam({
        sheetId: null,
        sheetUrl: null,
        sheetCreateAttemptedAt: null,
        sheetCreateNoFileObservationCount: 0,
        sheetSyncStatus: "pending",
        sheetLastSyncedRevision: 0,
        sheetSyncLastAttemptAt: null,
      });
      const google = googleMock();
      const ambiguousError = {
        name: "GaxiosError",
        response: { status: 503 },
        config: {},
      };
      google.createFile.mockRejectedValueOnce(ambiguousError);

      const runSynchronization = async (): Promise<
        "synced" | "pending" | "failed"
      > => {
        const result = synchronizeLatestTeamOperation(
          fake as unknown as Firestore,
          google.clients,
          "RoCo-1",
          "Reconciliation",
        );
        await vi.runAllTimersAsync();
        return result;
      };

      await expect(runSynchronization()).resolves.toBe("pending");
      expect(google.createFile).toHaveBeenCalledTimes(1);
      expect(fake.read("teams/RoCo-1")).toMatchObject({
        sheetSyncStatus: "pending",
        sheetSyncRetryCount: 1,
        sheetCreateNoFileObservationCount: 1,
      });
      expect(
        fake.read("teams/RoCo-1")?.sheetCreateAttemptedAt,
      ).toBeInstanceOf(Timestamp);

      vi.setSystemTime(startedAt + 5 * 60 * 1_000);
      await expect(runSynchronization()).resolves.toBe("pending");
      expect(google.createFile).toHaveBeenCalledTimes(1);
      expect(fake.read("teams/RoCo-1")).toMatchObject({
        sheetCreateNoFileObservationCount: 2,
      });

      vi.setSystemTime(startedAt + AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS + 1);
      await expect(runSynchronization()).resolves.toBe("pending");
      expect(google.createFile).toHaveBeenCalledTimes(1);
      expect(fake.read("teams/RoCo-1")).toMatchObject({
        sheetCreateAttemptedAt: null,
        sheetCreateNoFileObservationCount: 0,
        sheetSyncRetryCount: 0,
      });

      vi.setSystemTime(
        startedAt + AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS + 5 * 60 * 1_000,
      );
      await expect(runSynchronization()).resolves.toBe("synced");
      expect(google.createFile).toHaveBeenCalledTimes(2);
      expect(fake.read("teams/RoCo-1")).toMatchObject({
        sheetId: "stored-sheet-id",
        sheetSyncStatus: "synced",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the create fence immediately after a definitive 4xx rejection", async () => {
    const fake = seededTeam({
      sheetId: null,
      sheetUrl: null,
      sheetCreateAttemptedAt: null,
      sheetCreateNoFileObservationCount: 0,
      sheetSyncStatus: "pending",
      sheetLastSyncedRevision: 0,
      sheetSyncLastAttemptAt: null,
    });
    const google = googleMock();
    google.createFile.mockRejectedValue({
      name: "GaxiosError",
      response: { status: 400 },
      config: {},
    });

    await expect(
      synchronizeLatestTeamOperation(
        fake as unknown as Firestore,
        google.clients,
        "RoCo-1",
        "Reconciliation",
      ),
    ).resolves.toBe("failed");

    expect(google.listFiles).toHaveBeenCalledTimes(1);
    expect(google.createFile).toHaveBeenCalledTimes(1);
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetCreateAttemptedAt: null,
      sheetCreateNoFileObservationCount: 0,
      sheetSyncRetryCount: 1,
      sheetSyncStatus: "failed",
      sheetSyncSafeErrorCategory: "external_permanent",
    });
  });

  it("rejects stale revisions before invoking Google APIs", async () => {
    const fake = seededTeam();
    const google = googleMock();
    await expect(
      updateMyTeamOperation(
        fake as unknown as Firestore,
        matchingAuth(),
        "uid-a",
        update({ expectedRevision: 99 }),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(google.updateFile).not.toHaveBeenCalled();
  });

  it("does not permit a forged owner mapping to edit another user's team", async () => {
    const fake = seededTeam({ ownerUid: "uid-b" });
    fake.seed("teamOwners/uid-a", { teamId: "RoCo-1" });
    await expect(
      updateMyTeamOperation(
        fake as unknown as Firestore,
        matchingAuth(),
        "uid-a",
        update(),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("does not expose a Google failure path after the Firestore commit", async () => {
    const fake = seededTeam();
    const google = googleMock({ failRename: true });
    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      "uid-a",
      update(),
    );
    expect(result.synchronizationStatus).toBe("pending");
    expect(result.team.sheetSyncStatus).toBe("pending");
    expect(google.updateFile).not.toHaveBeenCalled();
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      teamName: "Updated Team",
      revision: 2,
      sheetSyncStatus: "pending",
    });
  });

  it("returns the committed revision as pending", async () => {
    const fake = seededTeam();

    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      "uid-a",
      update(),
    );

    expect(result).toMatchObject({
      synchronizationStatus: "pending",
      team: {
        teamName: "Updated Team",
        revision: 2,
        sheetSyncStatus: "pending",
      },
    });
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      teamName: "Updated Team",
      revision: 2,
      sheetSyncStatus: "pending",
    });
  });

  it("requires no Google client initialization", async () => {
    const fake = seededTeam();
    const getGoogle = vi.fn().mockRejectedValue(
      new Error("sanitized OAuth failure"),
    );

    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      "uid-a",
      update(),
    );

    expect(getGoogle).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      synchronizationStatus: "pending",
      team: { teamName: "Updated Team", revision: 2 },
    });
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      teamName: "Updated Team",
      revision: 2,
      sheetSyncStatus: "pending",
    });
  });

  it("requires the immutable primary contact to remain a member", async () => {
    await expect(
      updateMyTeamOperation(
        seededTeam() as unknown as Firestore,
        matchingAuth(),
        "uid-a",
        update({
          members: [
            {
              fullName: "Other Person",
              email: "other@example.org",
              affiliation: "Other Institute",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects access after a direct Auth email change", async () => {
    await expect(
      getMyTeamOperation(
        seededTeam() as unknown as Firestore,
        matchingAuth("changed@example.org"),
        "uid-a",
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });
});
