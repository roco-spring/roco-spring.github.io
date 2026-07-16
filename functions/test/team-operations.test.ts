import { Timestamp } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type { drive_v3, gmail_v1, sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FOLDER_ID } from "../src/config.js";
import type { GoogleApiClients } from "../src/google-auth.js";
import type { TeamDocument, UpdateTeamInput } from "../src/models.js";
import { getMyTeamOperation, updateMyTeamOperation } from "../src/teams.js";
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

function googleMock(options: { failRename?: boolean } = {}) {
  const updateFile = options.failRename
    ? vi.fn().mockRejectedValue(new Error("drive unavailable"))
    : vi.fn().mockResolvedValue({ data: { id: "stored-sheet-id" } });
  const values = {
    clear: vi.fn().mockResolvedValue({ data: {} }),
    update: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: { values: [] } }),
    append: vi.fn().mockResolvedValue({ data: {} }),
  };
  const drive = {
    files: {
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
      drive: drive as unknown as drive_v3.Drive,
      sheets: sheets as unknown as sheets_v4.Sheets,
      gmail: {} as gmail_v1.Gmail,
    },
    updateFile,
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

  it("commits an optimistic revision and syncs the same stored spreadsheet", async () => {
    const fake = seededTeam();
    const google = googleMock();
    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      google.clients,
      "uid-a",
      update(),
    );
    expect(result.synchronizationStatus).toBe("synced");
    expect(result.team).toMatchObject({
      teamId: "RoCo-1",
      teamName: "Updated Team",
      primaryContactEmail: "owner@example.org",
      revision: 2,
      sheetSyncStatus: "synced",
    });
    expect(google.updateFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "stored-sheet-id" }),
    );
    for (const call of google.values.update.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({ spreadsheetId: "stored-sheet-id", valueInputOption: "RAW" }),
      );
    }
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      teamId: "RoCo-1",
      teamNumber: 1,
      ownerUid: "uid-a",
      primaryContactEmail: "owner@example.org",
      revision: 2,
    });
  });

  it("rejects stale revisions before invoking Google APIs", async () => {
    const fake = seededTeam();
    const google = googleMock();
    await expect(
      updateMyTeamOperation(
        fake as unknown as Firestore,
        matchingAuth(),
        google.clients,
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
        googleMock().clients,
        "uid-a",
        update(),
      ),
    ).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("keeps the Firestore update but reports a terminal synchronization failure", async () => {
    const fake = seededTeam();
    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      googleMock({ failRename: true }).clients,
      "uid-a",
      update(),
    );
    expect(result.synchronizationStatus).toBe("failed");
    expect(result.team.sheetSyncStatus).toBe("failed");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      teamName: "Updated Team",
      revision: 2,
      sheetSyncStatus: "failed",
    });
  });

  it("returns the committed revision as pending when the post-commit sync lease fails", async () => {
    const fake = seededTeam();
    const originalRunTransaction = fake.runTransaction.bind(fake);
    let transactionCount = 0;
    vi.spyOn(fake, "runTransaction").mockImplementation(async (callback) => {
      transactionCount += 1;
      if (transactionCount === 2) {
        throw Object.assign(new Error("Firestore temporarily unavailable"), {
          code: "unavailable",
        });
      }
      return originalRunTransaction(callback);
    });

    const result = await updateMyTeamOperation(
      fake as unknown as Firestore,
      matchingAuth(),
      googleMock().clients,
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

  it("requires the immutable primary contact to remain a member", async () => {
    await expect(
      updateMyTeamOperation(
        seededTeam() as unknown as Firestore,
        matchingAuth(),
        googleMock().clients,
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
