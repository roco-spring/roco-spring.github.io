import { Timestamp } from "firebase-admin/firestore";
import type { drive_v3, gmail_v1, sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FOLDER_ID, EMAIL_REPLY_TO, EMAIL_SENDER } from "../src/config.js";
import { registrationEmailContent } from "../src/email-templates.js";
import { buildRegistrationMimeMessage, sendRegistrationEmail } from "../src/gmail.js";
import {
  findRegistrationSpreadsheets,
  findOrCreateTeamSpreadsheet,
  renameTeamSpreadsheet,
  safeSpreadsheetTitle,
  verifyPrivateTeamSpreadsheet,
} from "../src/google-drive.js";
import { GOOGLE_API_REQUEST_OPTIONS } from "../src/google-retry.js";
import {
  synchronizeTeamSpreadsheet,
  teamDetailsLiteralRows,
} from "../src/google-sheets.js";
import type { TeamDocument } from "../src/models.js";

function team(overrides: Partial<TeamDocument> = {}): TeamDocument {
  const now = Timestamp.fromDate(new Date("2026-07-15T10:00:00.000Z"));
  return {
    teamId: "RoCo-7",
    teamNumber: 7,
    teamName: "Flow Masters",
    ownerUid: "owner-7",
    primaryContactEmail: "owner@example.org",
    tracks: ["optical-flow", "scene-flow"],
    members: [
      {
        fullName: "Owner Person",
        email: "owner@example.org",
        affiliation: "Example Institute",
      },
    ],
    createdAt: now,
    updatedAt: now,
    revision: 3,
    status: "active",
    sheetId: "sheet-7",
    sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-7/edit",
    sheetSyncStatus: "pending",
    sheetLastSyncedRevision: 2,
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
    registrationRequestId: "request-hash-7",
    ...overrides,
  };
}

function driveMock(existing: Array<Record<string, unknown>> = []) {
  return {
    files: {
      list: vi.fn().mockResolvedValue({ data: { files: existing } }),
      create: vi.fn().mockResolvedValue({
        data: { id: "sheet-7", parents: [DRIVE_FOLDER_ID] },
      }),
      get: vi.fn().mockResolvedValue({
        data: {
          id: "sheet-7",
          mimeType: "application/vnd.google-apps.spreadsheet",
          appProperties: { registrationRequestId: "request-hash-7" },
          parents: [DRIVE_FOLDER_ID],
          webViewLink: "https://docs.google.com/spreadsheets/d/sheet-7/edit",
          trashed: false,
        },
      }),
      update: vi.fn().mockResolvedValue({ data: { id: "sheet-7" } }),
    },
    permissions: {
      list: vi.fn().mockResolvedValue({ data: { permissions: [] } }),
    },
  };
}

describe("private Drive spreadsheet lifecycle", () => {
  it("creates exactly one spreadsheet directly in the configured folder", async () => {
    const mock = driveMock();
    const beforeCreate = vi.fn().mockResolvedValue(undefined);
    const result = await findOrCreateTeamSpreadsheet(
      mock as unknown as drive_v3.Drive,
      "request-hash-7",
      "RoCo-7",
      "Flow Masters",
      true,
      beforeCreate,
    );
    expect(result).toMatchObject({ id: "sheet-7", wasCreated: true });
    expect(mock.files.create).toHaveBeenCalledTimes(1);
    expect(beforeCreate).toHaveBeenCalledTimes(1);
    expect(mock.files.create).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          parents: [DRIVE_FOLDER_ID],
          mimeType: "application/vnd.google-apps.spreadsheet",
          appProperties: { registrationRequestId: "request-hash-7" },
        }),
      }),
      GOOGLE_API_REQUEST_OPTIONS,
    );
    expect(mock.files.list.mock.calls[0]?.[1]).toBe(
      GOOGLE_API_REQUEST_OPTIONS,
    );
  });

  it("does not fence a create when the preceding lookup never completed", async () => {
    const mock = driveMock();
    const lookupError = {
      name: "GaxiosError",
      response: { status: 503 },
      config: {},
    };
    mock.files.list.mockRejectedValue(lookupError);
    const beforeCreate = vi.fn().mockResolvedValue(undefined);

    await expect(
      findOrCreateTeamSpreadsheet(
        mock as unknown as drive_v3.Drive,
        "request-hash-7",
        "RoCo-7",
        "Flow Masters",
        true,
        beforeCreate,
      ),
    ).rejects.toBe(lookupError);
    expect(mock.files.list).toHaveBeenCalledTimes(1);
    for (const call of mock.files.list.mock.calls) {
      expect(call[1]).toBe(GOOGLE_API_REQUEST_OPTIONS);
    }
    expect(beforeCreate).not.toHaveBeenCalled();
    expect(mock.files.create).not.toHaveBeenCalled();
  });

  it("does not enter Drive recovery when the create fence itself fails", async () => {
    const mock = driveMock();
    const fenceError = new Error("fence unavailable");
    const beforeCreate = vi.fn().mockRejectedValue(fenceError);

    await expect(
      findOrCreateTeamSpreadsheet(
        mock as unknown as drive_v3.Drive,
        "request-hash-7",
        "RoCo-7",
        "Flow Masters",
        true,
        beforeCreate,
      ),
    ).rejects.toBe(fenceError);
    expect(mock.files.list).toHaveBeenCalledTimes(1);
    expect(mock.files.create).not.toHaveBeenCalled();
  });

  it("recovers the existing metadata-bound file instead of creating a duplicate", async () => {
    const mock = driveMock([{ id: "sheet-7", parents: [DRIVE_FOLDER_ID] }]);
    const result = await findOrCreateTeamSpreadsheet(
      mock as unknown as drive_v3.Drive,
      "request-hash-7",
      "RoCo-7",
      "Flow Masters",
    );
    expect(result.wasCreated).toBe(false);
    expect(mock.files.create).not.toHaveBeenCalled();
  });

  it("recovers an ambiguously created file without retrying files.create", async () => {
    const mock = driveMock();
    mock.files.list
      .mockResolvedValueOnce({ data: { files: [] } })
      .mockResolvedValueOnce({
        data: { files: [{ id: "sheet-7", parents: [DRIVE_FOLDER_ID] }] },
      });
    mock.files.create.mockRejectedValue({
      name: "GaxiosError",
      response: { status: 503 },
      config: {},
    });
    await expect(
      findOrCreateTeamSpreadsheet(
        mock as unknown as drive_v3.Drive,
        "request-hash-7",
        "RoCo-7",
        "Flow Masters",
      ),
    ).resolves.toMatchObject({ id: "sheet-7", wasCreated: false });
    expect(mock.files.create).toHaveBeenCalledTimes(1);
  });

  it("uses one marker request when an ambiguity-recovery lookup fails", async () => {
    const mock = driveMock();
    const createError = {
      name: "GaxiosError",
      response: { status: 503 },
      config: {},
    };
    const lookupError = {
      name: "GaxiosError",
      response: { status: 503 },
      config: {},
    };
    mock.files.list
      .mockResolvedValueOnce({ data: { files: [] } })
      .mockRejectedValue(lookupError);
    mock.files.create.mockRejectedValue(createError);

    await expect(
      findOrCreateTeamSpreadsheet(
        mock as unknown as drive_v3.Drive,
        "request-hash-7",
        "RoCo-7",
        "Flow Masters",
      ),
    ).rejects.toMatchObject({
      name: "SpreadsheetCreationPendingError",
      cause: createError,
      recoveryCause: lookupError,
      noFileObserved: false,
    });
    expect(mock.files.list).toHaveBeenCalledTimes(2);
    expect(mock.files.create).toHaveBeenCalledTimes(1);
  });

  it("never issues a second create after a fenced ambiguous attempt stays invisible", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-20T09:00:00.000Z"));
      const mock = driveMock();
      const ambiguousError = {
        name: "GaxiosError",
        response: { status: 503 },
        config: {},
      };
      mock.files.create.mockRejectedValue(ambiguousError);

      const firstStartedAt = Date.now();
      const firstAttempt = expect(
        findOrCreateTeamSpreadsheet(
          mock as unknown as drive_v3.Drive,
          "request-hash-7",
          "RoCo-7",
          "Flow Masters",
          true,
        ),
      ).rejects.toMatchObject({
        name: "SpreadsheetCreationPendingError",
        category: "google_transient",
        cause: ambiguousError,
        noFileObserved: true,
      });
      await vi.runAllTimersAsync();
      await firstAttempt;
      expect(Date.now() - firstStartedAt).toBe(1_000);
      expect(mock.files.list).toHaveBeenCalledTimes(4);

      const replayStartedAt = Date.now();
      const replay = expect(
        findOrCreateTeamSpreadsheet(
          mock as unknown as drive_v3.Drive,
          "request-hash-7",
          "RoCo-7",
          "Flow Masters",
          false,
        ),
      ).rejects.toMatchObject({ code: "aborted", category: "transient" });
      await vi.runAllTimersAsync();
      await replay;
      expect(Date.now() - replayStartedAt).toBe(1_000);

      expect(mock.files.create).toHaveBeenCalledTimes(1);
      expect(mock.files.list).toHaveBeenCalledTimes(8);
      for (const call of mock.files.list.mock.calls) {
        expect(call[1]).toBe(GOOGLE_API_REQUEST_OPTIONS);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a definitive Drive 4xx rejection out of the ambiguity state", async () => {
    const mock = driveMock();
    const rejected = {
      name: "GaxiosError",
      response: { status: 400 },
      config: {},
    };
    mock.files.create.mockRejectedValue(rejected);

    await expect(
      findOrCreateTeamSpreadsheet(
        mock as unknown as drive_v3.Drive,
        "request-hash-7",
        "RoCo-7",
        "Flow Masters",
      ),
    ).rejects.toMatchObject({
      name: "SpreadsheetCreationRejectedError",
      category: "external_permanent",
      cause: rejected,
    });
    expect(mock.files.list).toHaveBeenCalledTimes(1);
    expect(mock.files.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an anyone permission", async () => {
    const mock = driveMock();
    mock.permissions.list.mockResolvedValue({
      data: { permissions: [{ id: "public", type: "anyone", role: "reader" }] },
    });
    await expect(
      findOrCreateTeamSpreadsheet(
        mock as unknown as drive_v3.Drive,
        "request-hash-7",
        "RoCo-7",
        "Flow Masters",
      ),
    ).rejects.toMatchObject({ category: "google_configuration" });
  });

  it("caps spreadsheet listing at three pages and rejects repeated tokens", async () => {
    const paginated = driveMock();
    paginated.files.list
      .mockResolvedValueOnce({
        data: { files: [{ id: "sheet-1" }], nextPageToken: "p2" },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: "sheet-2" }], nextPageToken: "p3" },
      })
      .mockResolvedValueOnce({ data: { files: [{ id: "sheet-3" }] } });
    await expect(
      findRegistrationSpreadsheets(
        paginated as unknown as drive_v3.Drive,
        "request-hash-7",
      ),
    ).resolves.toHaveLength(3);
    expect(paginated.files.list).toHaveBeenCalledTimes(3);

    const repeated = driveMock();
    repeated.files.list
      .mockResolvedValueOnce({ data: { files: [], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { files: [], nextPageToken: "p2" } });
    await expect(
      findRegistrationSpreadsheets(
        repeated as unknown as drive_v3.Drive,
        "request-hash-7",
      ),
    ).rejects.toMatchObject({ category: "external_permanent" });
    expect(repeated.files.list).toHaveBeenCalledTimes(2);

    const overBound = driveMock();
    overBound.files.list
      .mockResolvedValueOnce({ data: { files: [], nextPageToken: "p2" } })
      .mockResolvedValueOnce({ data: { files: [], nextPageToken: "p3" } })
      .mockResolvedValueOnce({ data: { files: [], nextPageToken: "p4" } });
    await expect(
      findRegistrationSpreadsheets(
        overBound as unknown as drive_v3.Drive,
        "request-hash-7",
      ),
    ).rejects.toMatchObject({ category: "external_permanent" });
    expect(overBound.files.list).toHaveBeenCalledTimes(3);
  });

  it("caps spreadsheet permission pagination and rejects repeated tokens", async () => {
    const repeated = driveMock();
    repeated.permissions.list
      .mockResolvedValueOnce({
        data: { permissions: [], nextPageToken: "p2" },
      })
      .mockResolvedValueOnce({
        data: { permissions: [], nextPageToken: "p2" },
      });
    await expect(
      verifyPrivateTeamSpreadsheet(
        repeated as unknown as drive_v3.Drive,
        "sheet-7",
        "request-hash-7",
      ),
    ).rejects.toMatchObject({ category: "external_permanent" });
    expect(repeated.permissions.list).toHaveBeenCalledTimes(2);

    const overBound = driveMock();
    overBound.permissions.list
      .mockResolvedValueOnce({
        data: { permissions: [], nextPageToken: "p2" },
      })
      .mockResolvedValueOnce({
        data: { permissions: [], nextPageToken: "p3" },
      })
      .mockResolvedValueOnce({
        data: { permissions: [], nextPageToken: "p4" },
      });
    await expect(
      verifyPrivateTeamSpreadsheet(
        overBound as unknown as drive_v3.Drive,
        "sheet-7",
        "request-hash-7",
      ),
    ).rejects.toMatchObject({ category: "external_permanent" });
    expect(overBound.permissions.list).toHaveBeenCalledTimes(3);
  });

  it("renames the same stored file and sanitizes unsafe title characters", async () => {
    const mock = driveMock();
    await renameTeamSpreadsheet(
      mock as unknown as drive_v3.Drive,
      "stored-sheet-id",
      "RoCo-7",
      "Bad/Name\u0000",
    );
    expect(mock.files.update).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: "stored-sheet-id",
        requestBody: { name: "RoCo-7 - Bad Name" },
      }),
      GOOGLE_API_REQUEST_OPTIONS,
    );
    expect(safeSpreadsheetTitle("RoCo-7", "Bad/Name\u0000")).toBe("RoCo-7 - Bad Name");
  });
});

function sheetsMock(existingRevisions: unknown[][] = []) {
  const metadata = {
    data: {
      sheets: [
        { properties: { sheetId: 0, title: "Team Details" } },
        { properties: { sheetId: 1, title: "Change Log" } },
      ],
    },
  };
  return {
    spreadsheets: {
      get: vi.fn().mockResolvedValue(metadata),
      batchUpdate: vi.fn().mockResolvedValue({ data: {} }),
      values: {
        clear: vi.fn().mockResolvedValue({ data: {} }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        get: vi.fn().mockResolvedValue({ data: { values: existingRevisions } }),
        append: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
}

describe("Sheets synchronization", () => {
  it("writes user values with RAW semantics and appends a revision change log", async () => {
    const mock = sheetsMock();
    const formulaTeam = team({ teamName: "=not-a-formula", revision: 4 });
    await synchronizeTeamSpreadsheet(
      mock as unknown as sheets_v4.Sheets,
      formulaTeam,
      "Team update",
    );
    expect(mock.spreadsheets.values.update).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-7",
        valueInputOption: "RAW",
      }),
      expect.objectContaining({ timeout: 8_000, retry: false }),
    );
    const updateRequest = mock.spreadsheets.values.update.mock.calls[0]?.[0];
    expect(JSON.stringify(updateRequest.requestBody.values)).toContain("=not-a-formula");
    expect(mock.spreadsheets.values.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        range: "'Change Log'!A1:E1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["Timestamp", "Revision", "Change Type", "Changed By", "Summary"]],
        },
      }),
      expect.objectContaining({ timeout: 8_000, retry: false }),
    );
    expect(mock.spreadsheets.values.append).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-7",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
      }),
      expect.objectContaining({ timeout: 8_000, retry: false }),
    );
  });

  it("does not duplicate a change-log revision during reconciliation", async () => {
    const mock = sheetsMock([[3]]);
    await synchronizeTeamSpreadsheet(
      mock as unknown as sheets_v4.Sheets,
      team(),
      "Reconciliation",
    );
    expect(mock.spreadsheets.values.append).not.toHaveBeenCalled();
  });

  it("never includes a password in the sheet representation", () => {
    const rows = JSON.stringify(teamDetailsLiteralRows(team()));
    expect(rows).not.toContain("temporary password");
    expect(rows).not.toContain("VerySecretPassword");
  });
});

describe("Gmail registration message", () => {
  it("sets the exact sender, reply-to, recipient, and confirmation subject", () => {
    const mime = buildRegistrationMimeMessage(team(), "VerySecretPassword123!", "boundary");
    expect(mime).toContain(`From: RoCo-Spring <${EMAIL_SENDER}>`);
    expect(mime).toContain(`Reply-To: ${EMAIL_REPLY_TO}`);
    expect(mime).toContain("To: owner@example.org");
    expect(mime).toContain("Subject: RoCo-Spring team registration confirmed - RoCo-7");
    const content = registrationEmailContent(team(), "VerySecretPassword123!");
    expect(content.text).toContain("Temporary password: VerySecretPassword123!");
    expect(content.html).toContain("VerySecretPassword123!");
  });

  it("sends through Gmail userId me without returning message data", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "gmail-id" } });
    const result = await sendRegistrationEmail(
      { users: { messages: { send } } } as unknown as gmail_v1.Gmail,
      team(),
      "VerySecretPassword123!",
    );
    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "me", requestBody: { raw: expect.any(String) } }),
      expect.objectContaining({ timeout: 8_000, retry: false }),
    );
  });
});
