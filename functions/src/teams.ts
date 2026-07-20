import type { Firestore } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import type { GoogleApiClients } from "./google-auth.js";
import {
  AppError,
  safeErrorCategory,
  type SafeErrorCategory,
} from "./errors.js";
import { assertLiveAccountMatchesTeam } from "./auth.js";
import {
  findOrCreateTeamSpreadsheet,
  renameTeamSpreadsheet,
  SpreadsheetCreationPendingError,
  SpreadsheetCreationRejectedError,
  verifyPrivateTeamSpreadsheet,
} from "./google-drive.js";
import { synchronizeTeamSpreadsheet } from "./google-sheets.js";
import type {
  PublicTeam,
  TeamDocument,
  UpdateTeamInput,
} from "./models.js";
import {
  attachTeamSpreadsheet,
  claimSheetSynchronization,
  commitTeamUpdate,
  failClaimedSheetSynchronization,
  finishSheetSynchronizationPass,
  getOwnedTeam,
  markTeamSpreadsheetCreateAttempt,
  releaseSheetSynchronization,
  toPublicTeam,
} from "./team-repository.js";

async function ensureTeamSpreadsheet(
  db: Firestore,
  google: GoogleApiClients,
  leaseId: string,
  team: TeamDocument,
): Promise<TeamDocument> {
  if (typeof team.sheetId === "string" && team.sheetId.length > 0) return team;

  const allowCreate = team.sheetCreateAttemptedAt == null;
  const spreadsheet = await findOrCreateTeamSpreadsheet(
    google.drive,
    team.registrationRequestId,
    team.teamId,
    team.teamName,
    allowCreate,
    allowCreate
      ? async () => {
          const mutation = await markTeamSpreadsheetCreateAttempt(
            db,
            team.teamId,
            leaseId,
          );
          if (mutation.state === "lost") {
            throw new AppError(
              "aborted",
              "Spreadsheet provisioning was superseded.",
              "conflict",
            );
          }
          team = mutation.team;
        }
      : undefined,
  );
  const attached = await attachTeamSpreadsheet(
    db,
    team.teamId,
    leaseId,
    spreadsheet.id,
    spreadsheet.url,
  );
  if (attached.state === "lost") {
    throw new AppError(
      "aborted",
      "Spreadsheet provisioning was superseded.",
      "conflict",
    );
  }
  return attached.team;
}

export async function getMyTeamOperation(
  db: Firestore,
  adminAuth: Auth,
  ownerUid: string,
): Promise<PublicTeam> {
  const team = await getOwnedTeam(db, ownerUid);
  await assertLiveAccountMatchesTeam(adminAuth, ownerUid, team);
  return toPublicTeam(team);
}

export interface UpdateTeamResult {
  team: PublicTeam;
  synchronizationStatus: "synced" | "pending" | "failed";
}

export interface SheetSynchronizationResult {
  status: "synced" | "pending" | "failed";
  errorCategory?: SafeErrorCategory;
}

export async function synchronizeLatestTeamOperationResult(
  db: Firestore,
  google: GoogleApiClients,
  teamId: string,
  changeType: "Registration" | "Team update" | "Reconciliation",
  allowSyncedAudit = false,
): Promise<SheetSynchronizationResult> {
  const claim = await claimSheetSynchronization(
    db,
    teamId,
    Date.now(),
    allowSyncedAudit,
  );
  if (!claim) return { status: "pending" };
  let team = claim.team;
  try {
    team = await ensureTeamSpreadsheet(db, google, claim.leaseId, team);
    if (typeof team.sheetId !== "string" || team.sheetId.length === 0) {
      throw new AppError(
        "failed-precondition",
        "The team spreadsheet has not been provisioned.",
        "internal",
      );
    }
    await verifyPrivateTeamSpreadsheet(
      google.drive,
      team.sheetId,
      team.registrationRequestId,
    );
    await renameTeamSpreadsheet(
      google.drive,
      team.sheetId,
      team.teamId,
      team.teamName,
    );
    await synchronizeTeamSpreadsheet(
      google.sheets,
      team,
      team.sheetLastSyncedRevision === 0 ? "Registration" : changeType,
      changeType === "Reconciliation"
        ? "system reconciliation"
        : team.primaryContactEmail,
    );
    const outcome = await finishSheetSynchronizationPass(
      db,
      team.teamId,
      claim.leaseId,
      team.revision,
    );
    if (outcome.state === "complete") return { status: "synced" };
    if (outcome.state === "lost") return { status: "pending" };
    await releaseSheetSynchronization(db, teamId, claim.leaseId);
    return { status: "pending" };
  } catch (error: unknown) {
    const errorCategory = safeErrorCategory(error);
    const status = await failClaimedSheetSynchronization(
      db,
      teamId,
      claim.leaseId,
      errorCategory,
      {
        ambiguousCreatePending:
          error instanceof SpreadsheetCreationPendingError,
        ambiguousCreateNoFileObserved:
          error instanceof SpreadsheetCreationPendingError &&
          error.noFileObserved,
        definitiveCreateRejected:
          error instanceof SpreadsheetCreationRejectedError,
      },
    );
    return { status, errorCategory };
  }
}

export async function synchronizeLatestTeamOperation(
  db: Firestore,
  google: GoogleApiClients,
  teamId: string,
  changeType: "Registration" | "Team update" | "Reconciliation",
  allowSyncedAudit = false,
): Promise<"synced" | "pending" | "failed"> {
  const result = await synchronizeLatestTeamOperationResult(
    db,
    google,
    teamId,
    changeType,
    allowSyncedAudit,
  );
  return result.status;
}

export async function updateMyTeamOperation(
  db: Firestore,
  adminAuth: Auth,
  ownerUid: string,
  input: UpdateTeamInput,
): Promise<UpdateTeamResult> {
  const ownedTeam = await getOwnedTeam(db, ownerUid);
  await assertLiveAccountMatchesTeam(adminAuth, ownerUid, ownedTeam);
  const { current } = await commitTeamUpdate(db, ownerUid, input);
  // Firestore is authoritative. The managed scheduler performs all Google
  // synchronization so this user-facing operation cannot time out after the
  // edit has already committed.
  return {
    team: toPublicTeam(current),
    synchronizationStatus: "pending",
  };
}
