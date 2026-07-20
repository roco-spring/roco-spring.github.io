import type { drive_v3 } from "googleapis";
import { DRIVE_FOLDER_ID } from "./config.js";
import { AppError, safeErrorCategory } from "./errors.js";
import {
  GOOGLE_API_REQUEST_OPTIONS,
  withBoundedGoogleRetry,
} from "./google-retry.js";

const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const MAX_DRIVE_LIST_PAGES = 3;
const AMBIGUOUS_RECOVERY_LIST_PAGES = 1;

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

/**
 * The non-idempotent create may have committed without returning a file ID.
 * Callers use this distinct safe error to retain the create fence until Drive
 * search has produced enough no-file observations to permit another create.
 */
export class SpreadsheetCreationPendingError extends AppError {
  public constructor(
    cause?: unknown,
    public readonly noFileObserved = true,
    public readonly recoveryCause: unknown = undefined,
  ) {
    super(
      "aborted",
      "Spreadsheet creation is still being reconciled. Please retry later.",
      cause === undefined ? "transient" : safeErrorCategory(cause),
    );
    this.name = "SpreadsheetCreationPendingError";
    this.cause = cause;
  }
}

/**
 * Drive returned a definitive client rejection, proving that this particular
 * create did not commit. Callers may therefore clear the non-idempotent create
 * fence while retaining the original safe error category and retry policy.
 */
export class SpreadsheetCreationRejectedError extends AppError {
  public constructor(cause: unknown) {
    super(
      "internal",
      "The registration spreadsheet create request was rejected.",
      safeErrorCategory(cause),
    );
    this.name = "SpreadsheetCreationRejectedError";
    this.cause = cause;
  }
}

function isDefinitiveCreateRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const response = (error as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) return false;
  const status = (response as Record<string, unknown>).status;
  // A concrete non-timeout 4xx response proves that Drive rejected the
  // request. A 408 remains ambiguous because the server timed out handling it.
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

export function safeSpreadsheetTitle(teamId: string, teamName: string): string {
  const cleanedName = teamName
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${teamId} - ${cleanedName || "Team"}`;
}

// Three single-attempt marker reads over one second are enough for an
// immediate same-account Drive consistency check. If the file is still not
// visible, Firestore retains the create fence and the scheduled reconciler
// observes it again later; this invocation must not poll for tens of seconds.
const AMBIGUOUS_CREATE_RECOVERY_DELAYS_MS = [250, 750] as const;

export async function findRegistrationSpreadsheets(
  drive: drive_v3.Drive,
  registrationRequestId: string,
  options: {
    requireConfiguredParent?: boolean;
    retryAttempts?: 1 | 2;
    maxPages?: 1 | 2 | 3;
  } = {},
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
  const maxPages =
    options.maxPages === 1 || options.maxPages === 2
      ? options.maxPages
      : MAX_DRIVE_LIST_PAGES;
  let pageToken: string | undefined;
  const observedPageTokens = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const response = await withBoundedGoogleRetry(
      (requestOptions) =>
        drive.files.list(
          {
            q: query,
            spaces: "drive",
            fields: "nextPageToken,files(id,name,webViewLink,parents)",
            pageSize: 100,
            ...(pageToken ? { pageToken } : {}),
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          },
          requestOptions,
        ),
      options.retryAttempts === undefined
        ? {}
        : { attempts: options.retryAttempts },
    );
    files.push(...(response.data.files ?? []));
    const nextPageToken = response.data.nextPageToken ?? undefined;
    if (!nextPageToken) return files;
    if (observedPageTokens.has(nextPageToken)) {
      throw new AppError(
        "internal",
        "Drive returned a repeated spreadsheet page.",
        "external_permanent",
      );
    }
    observedPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  throw new AppError(
    "internal",
    "Drive spreadsheet results exceeded the safety bound.",
    "external_permanent",
  );
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
      { retryAttempts: 1, maxPages: AMBIGUOUS_RECOVERY_LIST_PAGES },
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
  const fileResponse = await withBoundedGoogleRetry((requestOptions) =>
    drive.files.get(
      {
        fileId,
        fields: "id,mimeType,parents,webViewLink,trashed,appProperties",
        supportsAllDrives: true,
      },
      requestOptions,
    ),
  );
  const permissions: drive_v3.Schema$Permission[] = [];
  let pageToken: string | undefined;
  const observedPageTokens = new Set<string>();
  for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
    const permissionResponse = await withBoundedGoogleRetry((requestOptions) =>
      drive.permissions.list(
        {
          fileId,
          fields: "nextPageToken,permissions(id,type,role,allowFileDiscovery)",
          ...(pageToken ? { pageToken } : {}),
          pageSize: 100,
          supportsAllDrives: true,
        },
        requestOptions,
      ),
    );
    permissions.push(...(permissionResponse.data.permissions ?? []));
    const nextPageToken = permissionResponse.data.nextPageToken ?? undefined;
    if (!nextPageToken) {
      pageToken = undefined;
      break;
    }
    if (observedPageTokens.has(nextPageToken)) {
      throw new AppError(
        "internal",
        "Drive returned a repeated permission page.",
        "external_permanent",
      );
    }
    observedPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  if (pageToken) {
    throw new AppError(
      "internal",
      "Drive spreadsheet permissions exceeded the safety bound.",
      "external_permanent",
    );
  }
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
  beforeCreate?: () => Promise<void>,
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
    let recoveredId: string | undefined;
    try {
      recoveredId = await recoverAmbiguousSpreadsheetCreate(
        drive,
        registrationRequestId,
      );
    } catch (error: unknown) {
      // The initial lookup above was a successful post-create no-file
      // observation. Keep that observation even if the longer recovery poll
      // subsequently loses access to Drive.
      if (error instanceof AppError && error.category === "internal") throw error;
      throw new SpreadsheetCreationPendingError(error, true);
    }
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
    throw new SpreadsheetCreationPendingError();
  }

  // Fence the non-idempotent write only after the preceding read has
  // completed. A transient files.list failure means no create was attempted
  // and must remain safely retryable with the same registration key. Keep the
  // fence write outside the Drive-create recovery block: if the Firestore
  // fence itself fails, a Drive create was definitely never issued.
  await beforeCreate?.();
  let createdResponse;
  try {
    // Do not blindly retry a non-idempotent create after an ambiguous response.
    createdResponse = await drive.files.create(
      {
        requestBody: {
          name: title,
          mimeType: SPREADSHEET_MIME_TYPE,
          parents: [DRIVE_FOLDER_ID],
          appProperties: { registrationRequestId },
        },
        fields: "id,webViewLink,parents",
        supportsAllDrives: true,
      },
      GOOGLE_API_REQUEST_OPTIONS,
    );
  } catch (error: unknown) {
    if (isDefinitiveCreateRejection(error)) {
      throw new SpreadsheetCreationRejectedError(error);
    }
    // The API may have created the file before returning a transient error.
    let recoveredId: string | undefined;
    try {
      recoveredId = await recoverAmbiguousSpreadsheetCreate(
        drive,
        registrationRequestId,
      );
    } catch (recoveryError: unknown) {
      if (
        recoveryError instanceof AppError &&
        recoveryError.category === "internal"
      ) {
        throw recoveryError;
      }
      // No post-create observation completed, so retain the fence without
      // incrementing the no-file evidence counter.
      throw new SpreadsheetCreationPendingError(error, false, recoveryError);
    }
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
    throw new SpreadsheetCreationPendingError(error, true);
  }
  const id = createdResponse.data.id;
  if (!id) {
    let recoveredId: string | undefined;
    try {
      recoveredId = await recoverAmbiguousSpreadsheetCreate(
        drive,
        registrationRequestId,
      );
    } catch (recoveryError: unknown) {
      if (
        recoveryError instanceof AppError &&
        recoveryError.category === "internal"
      ) {
        throw recoveryError;
      }
      throw new SpreadsheetCreationPendingError(
        recoveryError,
        false,
        recoveryError,
      );
    }
    if (!recoveredId) {
      throw new SpreadsheetCreationPendingError();
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
  await withBoundedGoogleRetry((requestOptions) =>
    drive.files.update(
      {
        fileId,
        requestBody: { name: safeSpreadsheetTitle(teamId, teamName) },
        fields: "id",
        supportsAllDrives: true,
      },
      requestOptions,
    ),
  );
}

export async function deleteTeamSpreadsheet(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<void> {
  await withBoundedGoogleRetry((requestOptions) =>
    drive.files.delete(
      { fileId, supportsAllDrives: true },
      requestOptions,
    ),
  );
}
