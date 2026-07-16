import type { Auth } from "firebase-admin/auth";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS,
  AMBIGUOUS_SHEET_NO_FILE_OBSERVATIONS,
  MAX_RECONCILIATION_ATTEMPTS,
  RECONCILIATION_BATCH_SIZE,
  SHEET_AUDIT_BATCH_SIZE,
  SHEET_AUDIT_INTERVAL_MS,
  STALE_REGISTRATION_GRACE_MS,
} from "./config.js";
import { AppError, safeErrorCategory } from "./errors.js";
import { sendRegistrationEmail } from "./gmail.js";
import type { GoogleApiClients } from "./google-auth.js";
import {
  deleteTeamSpreadsheet,
  findRegistrationSpreadsheets,
} from "./google-drive.js";
import { fenceStaleRegistrationForCleanup } from "./idempotency.js";
import type { TeamDocument } from "./models.js";
import { generateTemporaryPassword } from "./password.js";
import {
  claimRegistrationEmailAttempt,
  finishRegistrationEmailAttempt,
  deleteTeamResources,
} from "./team-repository.js";
import { synchronizeLatestTeamOperation } from "./teams.js";

async function reconcileSheet(
  db: Firestore,
  google: GoogleApiClients,
  team: TeamDocument,
  audit = false,
): Promise<void> {
  try {
    const status = await synchronizeLatestTeamOperation(
      db,
      google,
      team.teamId,
      "Reconciliation",
      audit,
    );
    logger.info("Team sheet reconciliation completed", {
      operation: "reconcileRegistrations",
      teamId: team.teamId,
      status,
    });
  } catch (error: unknown) {
    const category = safeErrorCategory(error);
    logger.warn("Team sheet reconciliation deferred", {
      operation: "reconcileRegistrations",
      teamId: team.teamId,
      revision: team.revision,
      status: "error",
      errorCategory: category,
    });
  }
}

async function reconcileEmail(
  db: Firestore,
  adminAuth: Auth,
  google: GoogleApiClients,
  team: TeamDocument,
): Promise<void> {
  const claim = await claimRegistrationEmailAttempt(db, team.teamId);
  if (!claim) return;
  const currentTeam = claim.team;
  try {
    const user = await adminAuth.getUser(currentTeam.ownerUid);
    if (
      user.disabled ||
      user.email?.trim().toLowerCase() !== currentTeam.primaryContactEmail
    ) {
      throw new AppError(
        "permission-denied",
        "The account email no longer matches the registered team.",
        "authorization",
      );
    }
    if (user.customClaims?.mustChangePassword !== true) {
      await finishRegistrationEmailAttempt(
        db,
        currentTeam.teamId,
        claim.leaseId,
        "sent",
      );
      return;
    }

    // Each retry rotates the credential; no plaintext password is recovered or stored.
    const temporaryPassword = generateTemporaryPassword();
    await adminAuth.updateUser(currentTeam.ownerUid, { password: temporaryPassword });
    await adminAuth.setCustomUserClaims(currentTeam.ownerUid, {
      ...(user.customClaims ?? {}),
      mustChangePassword: true,
    });
    await adminAuth.revokeRefreshTokens(currentTeam.ownerUid);
    await sendRegistrationEmail(google.gmail, currentTeam, temporaryPassword);
    await finishRegistrationEmailAttempt(
      db,
      currentTeam.teamId,
      claim.leaseId,
      "sent",
    );
    logger.info("Registration email reconciled", {
      operation: "reconcileRegistrations",
      teamId: currentTeam.teamId,
      status: "sent",
    });
  } catch (error: unknown) {
    const category = safeErrorCategory(error);
    const status = await finishRegistrationEmailAttempt(
      db,
      currentTeam.teamId,
      claim.leaseId,
      "failed",
      category,
    );
    logger.warn("Registration email reconciliation deferred", {
      operation: "reconcileRegistrations",
      teamId: currentTeam.teamId,
      status,
      errorCategory: category,
    });
  }
}

function isAlreadyDeleted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record.code === "auth/user-not-found" || record.code === 404) return true;
  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : undefined;
  return response?.status === 404;
}

async function reconcileCleanup(
  db: Firestore,
  adminAuth: Auth,
  google: GoogleApiClients,
  snapshot: FirebaseFirestore.DocumentSnapshot,
): Promise<void> {
  const data = snapshot.data() as Record<string, unknown>;
  const ownerUid =
    typeof data.cleanupOwnerUid === "string" ? data.cleanupOwnerUid : undefined;
  const sheetId =
    typeof data.cleanupSheetId === "string" ? data.cleanupSheetId : undefined;
  const teamId =
    typeof data.cleanupTeamId === "string" ? data.cleanupTeamId : undefined;
  const ambiguousSheet = data.cleanupAmbiguousSheet === true;
  let failed = false;
  let category = "internal";
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error: unknown) {
      if (!isAlreadyDeleted(error)) {
        failed = true;
        category = safeErrorCategory(error);
      }
    }
  };
  let markerSheetIds: string[] = [];
  if (ambiguousSheet) {
    await attempt(async () => {
      const files = await findRegistrationSpreadsheets(
        google.drive,
        snapshot.id,
        { requireConfiguredParent: false },
      );
      markerSheetIds = files.flatMap((file) =>
        typeof file.id === "string" ? [file.id] : [],
      );
    });
  }
  const sheetIds = new Set(markerSheetIds);
  if (sheetId) sheetIds.add(sheetId);
  for (const candidateSheetId of sheetIds) {
    await attempt(async () =>
      deleteTeamSpreadsheet(google.drive, candidateSheetId),
    );
  }
  if (ownerUid) await attempt(async () => adminAuth.deleteUser(ownerUid));
  if (ownerUid && teamId) {
    await attempt(async () =>
      deleteTeamResources(db, teamId, ownerUid, snapshot.id),
    );
  }
  const previousCount =
    typeof data.cleanupRetryCount === "number" ? data.cleanupRetryCount : 0;
  const retryCount = failed ? previousCount + 1 : 0;
  const previousObservationCount =
    typeof data.cleanupNoSheetObservationCount === "number"
      ? data.cleanupNoSheetObservationCount
      : 0;
  let noSheetObservationCount = previousObservationCount;
  let awaitingAmbiguousSheetObservation = false;
  if (ambiguousSheet && !failed) {
    if (sheetIds.size > 0) {
      noSheetObservationCount = 0;
      awaitingAmbiguousSheetObservation = true;
    } else {
      noSheetObservationCount += 1;
      const attemptedAt = data.cleanupSheetCreateAttemptedAt;
      const ambiguityHorizonPassed =
        attemptedAt instanceof Timestamp &&
        Date.now() - attemptedAt.toMillis() >=
          AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS;
      awaitingAmbiguousSheetObservation =
        !ambiguityHorizonPassed ||
        noSheetObservationCount < AMBIGUOUS_SHEET_NO_FILE_OBSERVATIONS;
    }
  }
  const cleanupState = failed
    ? retryCount < MAX_RECONCILIATION_ATTEMPTS
      ? "pending"
      : "failed"
    : awaitingAmbiguousSheetObservation
      ? "pending"
      : "complete";
  await snapshot.ref.update({
    cleanupState,
    cleanupRetryCount: retryCount,
    cleanupNoSheetObservationCount: noSheetObservationCount,
    ...(sheetIds.size > 0 && !failed ? { cleanupSheetId: null } : {}),
    cleanupLastAttemptAt: FieldValue.serverTimestamp(),
    cleanupSafeErrorCategory: failed
      ? category
      : FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.info("Failed-registration cleanup attempted", {
    operation: "reconcileRegistrations",
    registrationRequestId: snapshot.id,
    status: cleanupState,
    ...(failed ? { errorCategory: category } : {}),
  });
}

async function reconcileStaleRegistration(
  db: Firestore,
  adminAuth: Auth,
  google: GoogleApiClients,
  snapshot: FirebaseFirestore.QueryDocumentSnapshot,
  cutoffMs: number,
  now: number,
): Promise<void> {
  const fenced = await fenceStaleRegistrationForCleanup(
    db,
    snapshot.id,
    cutoffMs,
    now,
  );
  if (!fenced) return;
  const cleanupSnapshot = await snapshot.ref.get();
  if (cleanupSnapshot.exists) {
    await reconcileCleanup(db, adminAuth, google, cleanupSnapshot);
  }
}

function teamFromSnapshot(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot,
): TeamDocument {
  return snapshot.data() as TeamDocument;
}

export async function reconcileRegistrationsOperation(
  db: Firestore,
  adminAuth: Auth,
  google: GoogleApiClients,
): Promise<void> {
  const now = Date.now();
  const staleCutoffMs = now - STALE_REGISTRATION_GRACE_MS;
  const [
    sheetSnapshot,
    auditSnapshot,
    emailSnapshot,
    cleanupSnapshot,
    staleSnapshot,
  ] =
    await Promise.all([
    db
      .collection("teams")
      .where("sheetSyncStatus", "==", "pending")
      .orderBy("sheetSyncLastAttemptAt", "asc")
      .limit(RECONCILIATION_BATCH_SIZE)
      .get(),
    db
      .collection("teams")
      .where("sheetSyncStatus", "==", "synced")
      .where(
        "sheetAuditAt",
        "<=",
        Timestamp.fromMillis(Date.now() - SHEET_AUDIT_INTERVAL_MS),
      )
      .orderBy("sheetAuditAt", "asc")
      .limit(SHEET_AUDIT_BATCH_SIZE)
      .get(),
    db
      .collection("teams")
      .where("registrationEmailStatus", "==", "pending")
      .orderBy("registrationEmailLastAttemptAt", "asc")
      .limit(RECONCILIATION_BATCH_SIZE)
      .get(),
    db
      .collection("registrationRequests")
      .where("cleanupState", "==", "pending")
      .orderBy("cleanupLastAttemptAt", "asc")
      .limit(RECONCILIATION_BATCH_SIZE)
      .get(),
    db
      .collection("registrationRequests")
      .where("state", "in", ["allocating", "auth_created", "sheet_created"])
      .where("updatedAt", "<=", Timestamp.fromMillis(staleCutoffMs))
      .orderBy("updatedAt", "asc")
      .limit(RECONCILIATION_BATCH_SIZE)
      .get(),
    ]);

  const jobs: Array<() => Promise<void>> = [];
  const count = Math.max(
    sheetSnapshot.docs.length,
    emailSnapshot.docs.length,
    cleanupSnapshot.docs.length,
    auditSnapshot.docs.length,
    staleSnapshot.docs.length,
  );
  for (let index = 0; index < count; index += 1) {
    const email = emailSnapshot.docs[index];
    const sheet = sheetSnapshot.docs[index];
    const cleanup = cleanupSnapshot.docs[index];
    const audit = auditSnapshot.docs[index];
    const stale = staleSnapshot.docs[index];
    if (email) {
      jobs.push(async () => reconcileEmail(db, adminAuth, google, teamFromSnapshot(email)));
    }
    if (sheet) {
      jobs.push(async () => reconcileSheet(db, google, teamFromSnapshot(sheet)));
    }
    if (cleanup) {
      jobs.push(async () => reconcileCleanup(db, adminAuth, google, cleanup));
    }
    if (audit) {
      jobs.push(async () =>
        reconcileSheet(db, google, teamFromSnapshot(audit), true),
      );
    }
    if (stale) {
      jobs.push(async () =>
        reconcileStaleRegistration(
          db,
          adminAuth,
          google,
          stale,
          staleCutoffMs,
          now,
        ),
      );
    }
  }
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      if (!job) continue;
      try {
        await job();
      } catch (error: unknown) {
        logger.error("Reconciliation item failed in isolation", {
          operation: "reconcileRegistrations",
          errorCategory: safeErrorCategory(error),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
}
