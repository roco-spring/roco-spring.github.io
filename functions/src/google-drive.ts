import type { drive_v3 } from "googleapis";
import { DRIVE_FOLDER_ID } from "./config.js";
import { AppError, safeErrorCategory } from "./errors.js";
import { withBoundedGoogleRetry } from "./google-retry.js";

const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

export interface TeamSpreadsheetFile {
  id: string;
  url: string;
  wasCreated: boolean;
}

export class SpreadsheetProvisioningError extends AppError {
  public constructor(
    public readonly fileId: string,
    cause: unknown,
  ) {
    super(
      "internal",
      "The registration spreadsheet could not be verified.",
      safeErrorCategory(cause),
    );
    this.name = "SpreadsheetProvisioningError";
    this.cause = cause;
  }
}

export function safeSpreadsheetTitle(teamId: string, teamName: string): string {
  const cleanedName = teamName
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${teamId} - ${cleanedName || "Team"}`;
}

const AMBIGUOUS_CREATE_RECOVERY_DELAYS_MS = [
  250,
  500,
  1_000,
  2_000,
  4_000,
  5_000,
  5_000,
  5_000,
] as const;

export async function findRegistrationSpreadsheets(
  drive: drive_v3.Drive,
  registrationRequestId: string,
  options: { requireConfiguredParent?: boolean } = {},
): Promise<drive_v3.Schema$File[]> {
  const queryParts = [
    `mimeType = '${SPREADSHEET_MIME_TYPE}'`,
    "trashed = false",
    `appProperties has { key='registrationRequestId' and value='${registrationRequestId}' }`,
  ];
  if (options.requireConfiguredParent !== false) {
    queryParts.splice(2, 0, `'${DRIVE_FOLDER_ID}' in parents`);
  }
  const query = queryParts.join(" and ");
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const response = await withBoundedGoogleRetry(() =>
      drive.files.list({
        q: query,
        spaces: "drive",
        fields: "nextPageToken,files(id,name,webViewLink,parents)",
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    files.push(...(response.data.files ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

async function recoverAmbiguousSpreadsheetCreate(
  drive: drive_v3.Drive,
  registrationRequestId: string,
): Promise<string | undefined> {
  for (
    let attempt = 0;
    attempt <= AMBIGUOUS_CREATE_RECOVERY_DELAYS_MS.length;
    attempt += 1
  ) {
    const recovered = await findRegistrationSpreadsheets(
      drive,
      registrationRequestId,
    );
    if (recovered.length > 1) {
      throw new AppError(
        "internal",
        "Duplicate registration spreadsheets require organizer attention.",
        "internal",
      );
    }
    const id = recovered[0]?.id;
    if (id) return id;
    const delay = AMBIGUOUS_CREATE_RECOVERY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delay),
      );
    }
  }
  return undefined;
}

export async function verifyPrivateTeamSpreadsheet(
  drive: drive_v3.Drive,
  fileId: string,
  expectedRegistrationRequestId?: string,
): Promise<{ url: string }> {
  const fileResponse = await withBoundedGoogleRetry(() =>
    drive.files.get({
      fileId,
      fields: "id,mimeType,parents,webViewLink,trashed,appProperties",
      supportsAllDrives: true,
    }),
  );
  const permissions: drive_v3.Schema$Permission[] = [];
  let pageToken: string | undefined;
  do {
    const permissionResponse = await withBoundedGoogleRetry(() =>
      drive.permissions.list({
        fileId,
        fields: "nextPageToken,permissions(id,type,role,allowFileDiscovery)",
        ...(pageToken ? { pageToken } : {}),
        pageSize: 100,
        supportsAllDrives: true,
      }),
    );
    permissions.push(...(permissionResponse.data.permissions ?? []));
    pageToken = permissionResponse.data.nextPageToken ?? undefined;
  } while (pageToken);
  const parents = fileResponse.data.parents ?? [];
  if (
    fileResponse.data.trashed === true ||
    !parents.includes(DRIVE_FOLDER_ID) ||
    (expectedRegistrationRequestId !== undefined &&
      (fileResponse.data.mimeType !== SPREADSHEET_MIME_TYPE ||
        fileResponse.data.appProperties?.registrationRequestId !==
          expectedRegistrationRequestId))
  ) {
    throw new AppError(
      "internal",
      "The registration spreadsheet is not in the configured private folder.",
      "google_configuration",
    );
  }
  if (
    permissions.some(
      (permission) =>
        permission.type === "anyone" || permission.type === "domain",
    )
  ) {
    throw new AppError(
      "internal",
      "The registration spreadsheet has an unsafe sharing permission.",
      "google_configuration",
    );
  }
  return {
    url:
      fileResponse.data.webViewLink ??
      `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/edit`,
  };
}

export async function findOrCreateTeamSpreadsheet(
  drive: drive_v3.Drive,
  registrationRequestId: string,
  teamId: string,
  teamName: string,
  allowCreate = true,
): Promise<TeamSpreadsheetFile> {
  const title = safeSpreadsheetTitle(teamId, teamName);
  const existing = await findRegistrationSpreadsheets(drive, registrationRequestId);
  if (existing.length > 1) {
    throw new AppError(
      "internal",
      "Duplicate registration spreadsheets require organizer attention.",
      "internal",
    );
  }
  const existingId = existing[0]?.id;
  if (existingId) {
    let verified: { url: string };
    try {
      verified = await verifyPrivateTeamSpreadsheet(
        drive,
        existingId,
        registrationRequestId,
      );
    } catch (error: unknown) {
      throw new SpreadsheetProvisioningError(existingId, error);
    }
    return { id: existingId, url: verified.url, wasCreated: false };
  }

  if (!allowCreate) {
    const recoveredId = await recoverAmbiguousSpreadsheetCreate(
      drive,
      registrationRequestId,
    );
    if (recoveredId) {
      try {
        const verified = await verifyPrivateTeamSpreadsheet(
          drive,
          recoveredId,
          registrationRequestId,
        );
        return { id: recoveredId, url: verified.url, wasCreated: false };
      } catch (error: unknown) {
        throw new SpreadsheetProvisioningError(recoveredId, error);
      }
    }
    throw new AppError(
      "aborted",
      "Spreadsheet creation is still being reconciled. Please retry later.",
      "transient",
    );
  }

  let createdResponse;
  try {
    // Do not blindly retry a non-idempotent create after an ambiguous response.
    createdResponse = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: SPREADSHEET_MIME_TYPE,
        parents: [DRIVE_FOLDER_ID],
        appProperties: { registrationRequestId },
      },
      fields: "id,webViewLink,parents",
      supportsAllDrives: true,
    });
  } catch (error: unknown) {
    // The API may have created the file before returning a transient error.
    const recoveredId = await recoverAmbiguousSpreadsheetCreate(
      drive,
      registrationRequestId,
    );
    if (recoveredId) {
      let verified: { url: string };
      try {
        verified = await verifyPrivateTeamSpreadsheet(
          drive,
          recoveredId,
          registrationRequestId,
        );
      } catch (verificationError: unknown) {
        throw new SpreadsheetProvisioningError(recoveredId, verificationError);
      }
      return { id: recoveredId, url: verified.url, wasCreated: false };
    }
    throw error;
  }
  const id = createdResponse.data.id;
  if (!id) {
    const recoveredId = await recoverAmbiguousSpreadsheetCreate(
      drive,
      registrationRequestId,
    );
    if (!recoveredId) {
      throw new AppError(
        "aborted",
        "Spreadsheet creation is still being reconciled. Please retry later.",
        "transient",
      );
    }
    try {
      const verified = await verifyPrivateTeamSpreadsheet(
        drive,
        recoveredId,
        registrationRequestId,
      );
      return { id: recoveredId, url: verified.url, wasCreated: false };
    } catch (error: unknown) {
      throw new SpreadsheetProvisioningError(recoveredId, error);
    }
  }
  let verified: { url: string };
  try {
    verified = await verifyPrivateTeamSpreadsheet(
      drive,
      id,
      registrationRequestId,
    );
  } catch (error: unknown) {
    throw new SpreadsheetProvisioningError(id, error);
  }
  return { id, url: verified.url, wasCreated: true };
}

export async function renameTeamSpreadsheet(
  drive: drive_v3.Drive,
  fileId: string,
  teamId: string,
  teamName: string,
): Promise<void> {
  await withBoundedGoogleRetry(() =>
    drive.files.update({
      fileId,
      requestBody: { name: safeSpreadsheetTitle(teamId, teamName) },
      fields: "id",
      supportsAllDrives: true,
    }),
  );
}

export async function deleteTeamSpreadsheet(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  await withBoundedGoogleRetry(() =>
    drive.files.delete({ fileId, supportsAllDrives: true }),
  );
}
