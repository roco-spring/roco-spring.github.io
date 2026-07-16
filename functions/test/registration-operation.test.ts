import { randomUUID } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type { drive_v3, gmail_v1, sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FOLDER_ID } from "../src/config.js";
import type { GoogleApiClients } from "../src/google-auth.js";
import type { RegistrationInput } from "../src/models.js";
import { registerTeamOperation } from "../src/registration.js";
import { idempotencyDocumentId } from "../src/idempotency.js";
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

function externalMocks(options: { failSheetWrite?: boolean } = {}) {
  let registrationRequestId = "";
  const drive = {
    files: {
      list: vi.fn().mockResolvedValue({ data: { files: [] } }),
      create: vi.fn().mockImplementation((request) => {
        registrationRequestId = String(
          request.requestBody?.appProperties?.registrationRequestId ?? "",
        );
        return Promise.resolve({
          data: { id: "sheet-1", parents: [DRIVE_FOLDER_ID] },
        });
      }),
      get: vi.fn().mockImplementation(() => Promise.resolve({
          data: {
            id: "sheet-1",
            mimeType: "application/vnd.google-apps.spreadsheet",
            appProperties: { registrationRequestId },
            parents: [DRIVE_FOLDER_ID],
            webViewLink: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
            trashed: false,
          },
        })),
      update: vi.fn().mockResolvedValue({ data: { id: "sheet-1" } }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
    },
    permissions: { list: vi.fn().mockResolvedValue({ data: { permissions: [] } }) },
  };
  const metadata = {
    data: {
      sheets: [
        { properties: { sheetId: 0, title: "Team Details" } },
        { properties: { sheetId: 1, title: "Change Log" } },
      ],
    },
  };
  const update = options.failSheetWrite
    ? vi.fn().mockRejectedValue(new Error("sheets unavailable"))
    : vi.fn().mockResolvedValue({ data: {} });
  const sheets = {
    spreadsheets: {
      get: vi.fn().mockResolvedValue(metadata),
      batchUpdate: vi.fn().mockResolvedValue({ data: {} }),
      values: {
        clear: vi.fn().mockResolvedValue({ data: {} }),
        update,
        get: vi.fn().mockResolvedValue({ data: { values: [] } }),
        append: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
  const send = vi.fn().mockResolvedValue({ data: { id: "message-1" } });
  const gmail = { users: { messages: { send } } };
  return { drive, sheets, gmail, send };
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

function clients(mocks: ReturnType<typeof externalMocks>): GoogleApiClients {
  return {
    auth: {} as GoogleApiClients["auth"],
    drive: mocks.drive as unknown as drive_v3.Drive,
    sheets: mocks.sheets as unknown as sheets_v4.Sheets,
    gmail: mocks.gmail as unknown as gmail_v1.Gmail,
  };
}

describe("complete registration operation", () => {
  it("creates each core resource once and returns no temporary credential", async () => {
    const fake = new FakeFirestore();
    const auth = authMock();
    const external = externalMocks();
    const registration = input();
    const dependencies = {
      db: fake as unknown as Firestore,
      adminAuth: auth.implementation,
      google: clients(external),
      rateLimitHmacSecret: "h".repeat(32),
    };

    const first = await registerTeamOperation(dependencies, registration, "192.0.2.10");
    const replay = await registerTeamOperation(dependencies, registration, "192.0.2.10");

    expect(first).toEqual({ teamId: "RoCo-1", emailStatus: "sent" });
    expect(replay).toEqual(first);
    expect(Object.keys(first)).toEqual(["teamId", "emailStatus"]);
    expect(auth.createUser).toHaveBeenCalledTimes(1);
    expect(auth.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ uid: expect.stringMatching(/^roco_[a-f0-9]{64}$/) }),
    );
    expect(external.drive.files.create).toHaveBeenCalledTimes(1);
    expect(external.send).toHaveBeenCalledTimes(1);
    expect(fake.read("systemCounters/teamRegistration")?.lastAllocatedTeamNumber).toBe(1);
    expect(fake.read("teamOwners/owner-uid")?.teamId).toBe("RoCo-1");
    expect(fake.read("teams/RoCo-1")?.sheetId).toBe("sheet-1");

    const persisted = JSON.stringify([...fake.values.values()]).toLowerCase();
    const sheetCalls = JSON.stringify(external.sheets.spreadsheets.values.update.mock.calls).toLowerCase();
    expect(persisted).not.toContain("password");
    expect(sheetCalls).not.toContain("password");
  });

  it("rejects a changed payload under the same idempotency key", async () => {
    const fake = new FakeFirestore();
    const auth = authMock();
    const external = externalMocks();
    const registration = input();
    const dependencies = {
      db: fake as unknown as Firestore,
      adminAuth: auth.implementation,
      google: clients(external),
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
    expect(external.drive.files.create).toHaveBeenCalledTimes(1);
  });

  it("recovers the deterministic Auth user after an interrupted create call", async () => {
    const fake = new FakeFirestore();
    const external = externalMocks();
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
          google: clients(external),
          rateLimitHmacSecret: "h".repeat(32),
        },
        registration,
        "192.0.2.10",
      ),
    ).resolves.toEqual({ teamId: "RoCo-1", emailStatus: "sent" });
    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).toHaveBeenCalledWith(uid, { password: expect.any(String) });
    expect(revokeRefreshTokens).toHaveBeenCalledWith(uid);
    expect(setCustomUserClaims).toHaveBeenCalledWith(uid, {
      mustChangePassword: true,
      unrelatedClaim: "preserved",
    });
  });

  it("cleans up Auth and Drive resources after a pre-persistence sheet failure", async () => {
    const fake = new FakeFirestore();
    const auth = authMock();
    const external = externalMocks({ failSheetWrite: true });
    await expect(
      registerTeamOperation(
        {
          db: fake as unknown as Firestore,
          adminAuth: auth.implementation,
          google: clients(external),
          rateLimitHmacSecret: "h".repeat(32),
        },
        input(),
        "192.0.2.10",
      ),
    ).rejects.toThrow("sheets unavailable");
    expect(auth.deleteUser).toHaveBeenCalledWith("owner-uid");
    expect(external.drive.files.delete).toHaveBeenCalledWith({
      fileId: "sheet-1",
      supportsAllDrives: true,
    });
    expect(fake.read("teams/RoCo-1")).toBeUndefined();
    expect(fake.read("systemCounters/teamRegistration")?.lastAllocatedTeamNumber).toBe(1);
    const request = [...fake.values.entries()].find(([path]) =>
      path.startsWith("registrationRequests/"),
    )?.[1];
    expect(request?.state).toBe("failed");
  });
});
