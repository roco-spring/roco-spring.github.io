import type { drive_v3, sheets_v4 } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FOLDER_ID, EMAIL_SENDER } from "../src/config.js";
import type { GoogleApiClients } from "../src/google-auth.js";
import { verifyRegistrationDependencies } from "../src/registration-health.js";

const scopes = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
];

function clients(overrides: {
  tokenScopes?: string[];
  organizerEmail?: string;
  folderTrashed?: boolean;
  permissionPages?: Array<{
    permissions?: Array<{ type: string; role: string }>;
    nextPageToken?: string;
  }>;
} = {}) {
  const permissions = {
    list: vi.fn(),
  };
  for (const page of overrides.permissionPages ?? [{ permissions: [] }]) {
    permissions.list.mockResolvedValueOnce({ data: page });
  }
  const drive = {
    about: {
      get: vi.fn().mockResolvedValue({
        data: { user: { emailAddress: overrides.organizerEmail ?? EMAIL_SENDER } },
      }),
    },
    files: {
      get: vi.fn().mockResolvedValue({
        data: {
          id: DRIVE_FOLDER_ID,
          mimeType: "application/vnd.google-apps.folder",
          trashed: overrides.folderTrashed ?? false,
          capabilities: { canAddChildren: true },
        },
      }),
    },
    permissions,
  };
  const sheets = {
    spreadsheets: {
      get: vi.fn().mockResolvedValue({ data: { spreadsheetId: "sheet-1" } }),
    },
  };
  return {
    implementation: {
      auth: {} as GoogleApiClients["auth"],
      oauthScopes: overrides.tokenScopes ?? scopes,
      drive: drive as unknown as drive_v3.Drive,
      sheets: sheets as unknown as sheets_v4.Sheets,
      gmail: {} as GoogleApiClients["gmail"],
    },
    drive,
    permissions,
    sheets,
  };
}

describe("registration dependency health", () => {
  it("refreshes OAuth, verifies exact capabilities, and reads a managed sheet", async () => {
    const mock = clients();
    await expect(
      verifyRegistrationDependencies(mock.implementation, "sheet-1"),
    ).resolves.toEqual({ sheetsReadVerified: true });
    expect(mock.drive.files.get).toHaveBeenCalledTimes(1);
    expect(mock.drive.about.get).toHaveBeenCalledWith(
      { fields: "user(emailAddress)" },
      expect.objectContaining({ timeout: 8_000, retry: false }),
    );
    expect(mock.permissions.list).toHaveBeenCalledTimes(1);
    expect(mock.sheets.spreadsheets.get).toHaveBeenCalledTimes(1);
  });

  it("fails safely when the refresh token lacks a required scope", async () => {
    const mock = clients({ tokenScopes: [scopes[0] ?? ""] });
    await expect(
      verifyRegistrationDependencies(mock.implementation),
    ).rejects.toMatchObject({ category: "google_configuration" });
    expect(mock.drive.files.get).not.toHaveBeenCalled();
  });

  it("fails safely when the refresh token was granted a broader scope", async () => {
    const mock = clients({ tokenScopes: [...scopes, "https://www.googleapis.com/auth/drive"] });
    await expect(
      verifyRegistrationDependencies(mock.implementation),
    ).rejects.toMatchObject({ category: "google_configuration" });
    expect(mock.drive.files.get).not.toHaveBeenCalled();
  });

  it("fails safely when the configured folder is unavailable", async () => {
    const mock = clients({ folderTrashed: true });
    await expect(
      verifyRegistrationDependencies(mock.implementation),
    ).rejects.toMatchObject({ category: "google_configuration" });
  });

  it("fails safely when OAuth belongs to a different Google account", async () => {
    const mock = clients({ organizerEmail: "another-user@example.org" });
    await expect(
      verifyRegistrationDependencies(mock.implementation),
    ).rejects.toMatchObject({ category: "google_configuration" });
    expect(mock.drive.files.get).not.toHaveBeenCalled();
  });

  it("paginates permissions and rejects public or domain-wide folder access", async () => {
    const paginated = clients({
      permissionPages: [
        { permissions: [{ type: "user", role: "owner" }], nextPageToken: "p2" },
        { permissions: [{ type: "group", role: "reader" }] },
      ],
    });
    await expect(
      verifyRegistrationDependencies(paginated.implementation),
    ).resolves.toEqual({ sheetsReadVerified: false });
    expect(paginated.permissions.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "p2" }),
      expect.objectContaining({ timeout: 8_000, retry: false }),
    );

    for (const type of ["anyone", "domain"]) {
      const unsafe = clients({
        permissionPages: [{ permissions: [{ type, role: "reader" }] }],
      });
      await expect(
        verifyRegistrationDependencies(unsafe.implementation),
      ).rejects.toMatchObject({ category: "google_configuration" });
    }
  });

  it("rejects repeated permission tokens and stops at three health pages", async () => {
    const repeated = clients({
      permissionPages: [
        { permissions: [], nextPageToken: "p2" },
        { permissions: [], nextPageToken: "p2" },
      ],
    });
    await expect(
      verifyRegistrationDependencies(repeated.implementation),
    ).rejects.toMatchObject({ category: "google_configuration" });
    expect(repeated.permissions.list).toHaveBeenCalledTimes(2);

    const overBound = clients({
      permissionPages: [
        { permissions: [], nextPageToken: "p2" },
        { permissions: [], nextPageToken: "p3" },
        { permissions: [], nextPageToken: "p4" },
      ],
    });
    await expect(
      verifyRegistrationDependencies(overBound.implementation),
    ).rejects.toMatchObject({ category: "google_configuration" });
    expect(overBound.permissions.list).toHaveBeenCalledTimes(3);
  });
});
