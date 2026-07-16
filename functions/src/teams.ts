import type { Firestore } from "firebase-admin/firestore";
import type { Auth } from "firebase-admin/auth";
import { logger } from "firebase-functions";
import type { GoogleApiClients } from "./google-auth.js";
import { safeErrorCategory } from "./errors.js";
import { assertLiveAccountMatchesTeam } from "./auth.js";
import {
  renameTeamSpreadsheet,
  verifyPrivateTeamSpreadsheet,
} from "./google-drive.js";
import { synchronizeTeamSpreadsheet } from "./google-sheets.js";
import type { PublicTeam, UpdateTeamInput } from "./models.js";
import {
  claimSheetSynchronization,
  commitTeamUpdate,
  failClaimedSheetSynchronization,
  finishSheetSynchronizationPass,
  getTeamById,
  getOwnedTeam,
  releaseSheetSynchronization,
  toPublicTeam,
} from "./team-repository.js";

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

export async function synchronizeLatestTeamOperation(
  db: Firestore,
  google: GoogleApiClients,
  teamId: string,
  changeType: "Team update" | "Reconciliation",
  allowSyncedAudit = false,
): Promise<"synced" | "pending" | "failed"> {
  const claim = await claimSheetSynchronization(
    db,
    teamId,
    Date.now(),
    allowSyncedAudit,
  );
  if (!claim) return "pending";
  let team = claim.team;
  try {
    for (let pass = 0; pass < 5; pass += 1) {
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
        changeType,
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
      if (outcome.state === "complete") return "synced";
      if (outcome.state === "lost") return "pending";
      team = outcome.team;
    }
    await releaseSheetSynchronization(db, teamId, claim.leaseId);
    return "pending";
  } catch (error: unknown) {
    return failClaimedSheetSynchronization(
      db,
      teamId,
      claim.leaseId,
      safeErrorCategory(error),
    );
  }
}

export async function updateMyTeamOperation(
  db: Firestore,
  adminAuth: Auth,
  google: GoogleApiClients,
  ownerUid: string,
  input: UpdateTeamInput,
): Promise<UpdateTeamResult> {
  const ownedTeam = await getOwnedTeam(db, ownerUid);
  await assertLiveAccountMatchesTeam(adminAuth, ownerUid, ownedTeam);
  const { current } = await commitTeamUpdate(db, ownerUid, input);
  try {
    await synchronizeLatestTeamOperation(
      db,
      google,
      current.teamId,
      "Team update",
    );
    const latest = await getTeamById(db, current.teamId);
    return {
      team: toPublicTeam(latest),
      synchronizationStatus: latest.sheetSyncStatus,
    };
  } catch (error: unknown) {
    // The authoritative edit is already committed. Return that committed
    // revision conservatively as pending so the client does not retry a stale
    // revision while the scheduled reconciler repairs synchronization.
    logger.warn("Team update committed; synchronization status deferred", {
      operation: "updateMyTeam",
      teamId: current.teamId,
      revision: current.revision,
      status: "pending",
      errorCategory: safeErrorCategory(error),
    });
    return {
      team: toPublicTeam(current),
      synchronizationStatus: "pending",
    };
  }
}
