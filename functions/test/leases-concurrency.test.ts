import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { drive_v3, gmail_v1, sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FOLDER_ID } from "../src/config.js";
import type { GoogleApiClients } from "../src/google-auth.js";
import type { TeamDocument } from "../src/models.js";
import {
  claimRegistrationEmailAttempt,
  finishRegistrationEmailAttempt,
  makeRegistrationEmailRetryIneligible,
} from "../src/team-repository.js";
import { synchronizeLatestTeamOperation } from "../src/teams.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

function team(overrides: Partial<TeamDocument> = {}): TeamDocument {
  const now = Timestamp.fromDate(new Date("2026-07-15T10:00:00.000Z"));
  return {
    teamId: "RoCo-1",
    teamNumber: 1,
    teamName: "Revision Two",
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
    createdAt: now,
    updatedAt: now,
    revision: 2,
    status: "active",
    sheetId: "sheet-1",
    sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
    sheetSyncStatus: "pending",
    sheetLastSyncedRevision: 1,
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
    registrationRequestId: "request-1",
    ...overrides,
  };
}

function seed(fake: FakeFirestore, value = team()): void {
  fake.seed("teams/RoCo-1", value as unknown as Record<string, unknown>);
  fake.seed("teamOwners/uid-a", { teamId: "RoCo-1" });
  fake.seed("registrationRequests/request-1", {
    state: "email_pending",
    teamId: "RoCo-1",
    emailStatus: "pending",
  });
}

describe("registration email attempt lease", () => {
  it("serializes email delivery against initial password completion", async () => {
    const fake = new FakeFirestore();
    seed(fake);
    const db = fake as unknown as Firestore;
    const claim = await claimRegistrationEmailAttempt(db, "RoCo-1", 1_000);
    expect(claim).not.toBeNull();
    await expect(
      makeRegistrationEmailRetryIneligible(db, "uid-a", 1_001),
    ).rejects.toMatchObject({ code: "aborted" });

    await finishRegistrationEmailAttempt(
      db,
      "RoCo-1",
      claim?.leaseId ?? "missing",
      "sent",
    );
    await expect(
      makeRegistrationEmailRetryIneligible(db, "uid-a", 1_002),
    ).resolves.toBeDefined();
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      registrationEmailStatus: "sent",
      registrationEmailRetryIneligible: true,
    });
    expect(await claimRegistrationEmailAttempt(db, "RoCo-1", 2_000)).toBeNull();
  });

  it("updates team and saga email state atomically", async () => {
    const fake = new FakeFirestore();
    seed(fake);
    const db = fake as unknown as Firestore;
    const claim = await claimRegistrationEmailAttempt(db, "RoCo-1", 1_000);
    const result = await finishRegistrationEmailAttempt(
      db,
      "RoCo-1",
      claim?.leaseId ?? "missing",
      "failed",
      "google_transient",
    );
    expect(result).toBe("pending");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      registrationEmailStatus: "pending",
      registrationEmailRetryCount: 1,
      registrationEmailLeaseId: null,
    });
    expect(fake.read("registrationRequests/request-1")).toMatchObject({
      state: "email_pending",
      emailStatus: "pending",
    });
  });

  it("allows first-login password completion after the saga TTL expires", async () => {
    const fake = new FakeFirestore();
    seed(fake);
    fake.values.delete("registrationRequests/request-1");
    const db = fake as unknown as Firestore;

    await expect(
      makeRegistrationEmailRetryIneligible(db, "uid-a", 1_000),
    ).resolves.toBeDefined();
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      registrationEmailStatus: "sent",
      registrationEmailRetryIneligible: true,
    });
    expect(fake.read("registrationRequests/request-1")).toBeUndefined();
  });
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syncGoogle(
  onDetailsWrite?: (request: Record<string, unknown>) => Promise<void>,
): { clients: GoogleApiClients; details: Array<Record<string, unknown>>; rename: ReturnType<typeof vi.fn> } {
  const details: Array<Record<string, unknown>> = [];
  const rename = vi.fn().mockResolvedValue({ data: { id: "sheet-1" } });
  const valuesUpdate = vi.fn().mockImplementation(async (request: Record<string, unknown>) => {
    if (request.range === "'Team Details'!A1") {
      details.push(request);
      await onDetailsWrite?.(request);
    }
    return { data: {} };
  });
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
      values: {
        clear: vi.fn().mockResolvedValue({ data: {} }),
        update: valuesUpdate,
        get: vi.fn().mockResolvedValue({ data: { values: [] } }),
        append: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
  return {
    clients: {
      auth: {} as GoogleApiClients["auth"],
      drive: {
        files: {
          update: rename,
          get: vi.fn().mockResolvedValue({
            data: {
              id: "sheet-1",
              mimeType: "application/vnd.google-apps.spreadsheet",
              appProperties: { registrationRequestId: "request-1" },
              parents: [DRIVE_FOLDER_ID],
              trashed: false,
            },
          }),
        },
        permissions: {
          list: vi.fn().mockResolvedValue({ data: { permissions: [] } }),
        },
      } as unknown as drive_v3.Drive,
      sheets: sheets as unknown as sheets_v4.Sheets,
      gmail: {} as gmail_v1.Gmail,
    },
    details,
    rename,
  };
}

describe("sheet synchronization fencing", () => {
  it("serializes writers and repairs to the newest Firestore revision", async () => {
    const fake = new FakeFirestore();
    seed(fake);
    const db = fake as unknown as Firestore;
    const blocked = deferred();
    const started = deferred();
    let firstWrite = true;
    const firstGoogle = syncGoogle(async () => {
      if (!firstWrite) return;
      firstWrite = false;
      started.resolve();
      await blocked.promise;
    });
    const competingGoogle = syncGoogle();

    const first = synchronizeLatestTeamOperation(
      db,
      firstGoogle.clients,
      "RoCo-1",
      "Team update",
    );
    await started.promise;
    fake.update("teams/RoCo-1", {
      teamName: "Revision Three",
      revision: 3,
      updatedAt: Timestamp.fromDate(new Date("2026-07-15T11:00:00.000Z")),
      sheetSyncStatus: "pending",
    });
    await expect(
      synchronizeLatestTeamOperation(
        db,
        competingGoogle.clients,
        "RoCo-1",
        "Reconciliation",
      ),
    ).resolves.toBe("pending");
    expect(competingGoogle.rename).not.toHaveBeenCalled();

    blocked.resolve();
    await expect(first).resolves.toBe("synced");
    expect(firstGoogle.details).toHaveLength(2);
    const finalWrite = JSON.stringify(firstGoogle.details.at(-1));
    expect(finalWrite).toContain("Revision Three");
    expect(finalWrite).toContain("3");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      revision: 3,
      sheetSyncStatus: "synced",
      sheetLastSyncedRevision: 3,
      sheetSyncLeaseId: null,
    });
  });
});
