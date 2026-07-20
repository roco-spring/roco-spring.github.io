import { DRIVE_FOLDER_ID, EMAIL_SENDER } from "./config.js";
import { AppError } from "./errors.js";
import type { GoogleApiClients } from "./google-auth.js";
import { withBoundedGoogleRetry } from "./google-retry.js";

const REQUIRED_OAUTH_SCOPES = new Set([
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
]);
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
// Three pages still permits 300 explicit permissions while preventing a
// degraded Drive endpoint from consuming most of the callable's lifetime.
const MAX_PERMISSION_PAGES = 3;

function configurationFailure(message: string): AppError {
  return new AppError("internal", message, "google_configuration");
}

export interface RegistrationDependencyHealth {
  sheetsReadVerified: boolean;
}

export async function verifyRegistrationDependencies(
  google: GoogleApiClients,
  knownSpreadsheetId?: string,
): Promise<RegistrationDependencyHealth> {
  const grantedScopes = new Set(google.oauthScopes);
  if (grantedScopes.size !== REQUIRED_OAUTH_SCOPES.size) {
    throw configurationFailure("Google OAuth scopes do not match the approved set.");
  }
  for (const requiredScope of REQUIRED_OAUTH_SCOPES) {
    if (!grantedScopes.has(requiredScope)) {
      throw configurationFailure("Google OAuth is missing a required scope.");
    }
  }

  const identity = await withBoundedGoogleRetry((requestOptions) =>
    google.drive.about.get(
      { fields: "user(emailAddress)" },
      requestOptions,
    ),
  );
  if (identity.data.user?.emailAddress !== EMAIL_SENDER) {
    throw configurationFailure("Google OAuth belongs to the wrong organizer account.");
  }

  const folder = await withBoundedGoogleRetry((requestOptions) =>
    google.drive.files.get(
      {
        fileId: DRIVE_FOLDER_ID,
        fields: "id,mimeType,trashed,capabilities(canAddChildren)",
        supportsAllDrives: true,
      },
      requestOptions,
    ),
  );
  if (
    folder.data.id !== DRIVE_FOLDER_ID ||
    folder.data.mimeType !== DRIVE_FOLDER_MIME_TYPE ||
    folder.data.trashed === true ||
    folder.data.capabilities?.canAddChildren !== true
  ) {
    throw configurationFailure("The configured registration folder is unavailable.");
  }

  let pageToken: string | undefined;
  const observedPageTokens = new Set<string>();
  for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
    const response = await withBoundedGoogleRetry((requestOptions) =>
      google.drive.permissions.list(
        {
          fileId: DRIVE_FOLDER_ID,
          fields: "nextPageToken,permissions(type,role,allowFileDiscovery)",
          pageSize: 100,
          supportsAllDrives: true,
          ...(pageToken ? { pageToken } : {}),
        },
        requestOptions,
      ),
    );
    if (
      (response.data.permissions ?? []).some(
        (permission) =>
          permission.type === "anyone" || permission.type === "domain",
      )
    ) {
      throw configurationFailure(
        "The configured registration folder has an unsafe sharing permission.",
      );
    }
    const nextPageToken = response.data.nextPageToken ?? undefined;
    if (!nextPageToken) {
      pageToken = undefined;
      break;
    }
    if (observedPageTokens.has(nextPageToken)) {
      throw configurationFailure("Drive returned a repeated permission page.");
    }
    observedPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  if (pageToken) {
    throw configurationFailure("Drive folder permissions exceeded the safety bound.");
  }

  if (knownSpreadsheetId) {
    const spreadsheet = await withBoundedGoogleRetry((requestOptions) =>
      google.sheets.spreadsheets.get(
        {
          spreadsheetId: knownSpreadsheetId,
          fields: "spreadsheetId",
        },
        requestOptions,
      ),
    );
    if (spreadsheet.data.spreadsheetId !== knownSpreadsheetId) {
      throw configurationFailure("A managed registration spreadsheet is unavailable.");
    }
  }

  return { sheetsReadVerified: knownSpreadsheetId !== undefined };
}
