import type { Auth } from "firebase-admin/auth";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  AMBIGUOUS_SHEET_CLEANUP_HORIZON_MS,
  AMBIGUOUS_SHEET_NO_FILE_OBSERVATIONS,
  FAILED_RECONCILIATION_REVIVAL_INTERVAL_MS,
  MAX_RECONCILIATION_ATTEMPTS,
  RECONCILIATION_BATCH_SIZE,
  RECONCILIATION_JOB_LAUNCH_WINDOW_MS,
  RECONCILIATION_MAX_CONCURRENCY,
  SHEET_AUDIT_BATCH_SIZE,
  SHEET_AUDIT_INTERVAL_MS,
  STALE_REGISTRATION_GRACE_MS,
} from "./config.js";
import {
  AppError,
  safeErrorCategory,
  type SafeErrorCategory,
} from "./errors.js";
import { sendRegistrationEmail } from "./gmail.js";
import type {
  GoogleApiClientFactory,
  GoogleApiClients,
} from "./google-auth.js";
import {
  deleteTeamSpreadsheet,
  findRegistrationSpreadsheets,
} from "./google-drive.js";
import { fenceStaleRegistrationForCleanup } from "./idempotency.js";
import type { TeamDocument } from "./models.js";
import { generateTemporaryPassword } from "./password.js";
import { verifyRegistrationDependencies } from "./registration-health.js";
import {
  claimRegistrationEmailAttempt,
  deleteTeamResources,
  finishRegistrationEmailAttempt,
  reviveFailedCleanup,
  reviveFailedRegistrationEmail,
  reviveFailedSheetSynchronization,
} from "./team-repository.js";
import { synchronizeLatestTeamOperationResult } from "./teams.js";

const MAX_CLEANUP_SPREADSHEETS_PER_PASS = 8;

interface ReconciliationRuntime {
  now?: () => number;
}

interface ReconciliationJob {
  resourceId: string;
  resourceType: "cleanup" | "email" | "registration" | "sheet";
  run: () => Promise<void>;
}

function isDailyRevivalCategory(value: unknown): boolean {
  return value === "transient" || value === "google_transient";
}

async function reconcileSheet(
  db: Firestore,
  google: GoogleApiClients,
  team: TeamDocument,
  audit = false,
): Promise<void> {
  try {
    const result = await synchronizeLatestTeamOperationResult(
      db,
      google,
      team.teamId,
      "Reconciliation",
      audit,
    );
    if (result.status === "failed") {
      logger.error("Team sheet reconciliation reached a terminal failure", {
        operation: "reconcileRegistrations",
        status: "failed",
        resourceType: "sheet",
        teamId: team.teamId,
        errorCategory: result.errorCategory ?? "internal",
      });
    } else {
      logger.info("Team sheet reconciliation completed", {
        operation: "reconcileRegistrations",
        resourceType: "sheet",
        teamId: team.teamId,
        status: result.status,
      });
    }
  } catch (error: unknown) {
    const category = safeErrorCategory(error);
    logger.error("Team sheet reconciliation failed unexpectedly", {
      operation: "reconcileRegistrations",
      resourceType: "sheet",
      teamId: team.teamId,
      revision: team.revision,
      status: "failed",
      unexpected: true,
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
    const details = {
      operation: "reconcileRegistrations",
      resourceType: "email",
      teamId: currentTeam.teamId,
      status,
      errorCategory: category,
    };
    if (status === "failed") {
      logger.error("Registration email reached a terminal failure", details);
    } else {
      logger.warn("Registration email reconciliation deferred", details);
    }
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
  google: GoogleApiClients | undefined,
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
  const driveCleanupRequired = ambiguousSheet || sheetId !== undefined;
  const driveCleanupDeferred = driveCleanupRequired && google === undefined;
  let failed = false;
  let category: SafeErrorCategory = "internal";
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
  if (ambiguousSheet && google) {
    await attempt(async () => {
      const files = await findRegistrationSpreadsheets(
        google.drive,
        snapshot.id,
        { requireConfiguredParent: false },
      );
      markerSheetIds = files
        .flatMap((file) => (typeof file.id === "string" ? [file.id] : []))
        .slice(0, MAX_CLEANUP_SPREADSHEETS_PER_PASS);
    });
  }
  const sheetIds = new Set(markerSheetIds);
  if (sheetId && google) sheetIds.add(sheetId);
  if (google) {
    for (const candidateSheetId of sheetIds) {
      await attempt(async () =>
        deleteTeamSpreadsheet(google.drive, candidateSheetId),
      );
    }
  }
  if (ownerUid) await attempt(async () => adminAuth.deleteUser(ownerUid));
  if (ownerUid && teamId) {
    await attempt(async () =>
      deleteTeamResources(db, teamId, ownerUid, snapshot.id),
    );
  }
  const previousCount =
    typeof data.cleanupRetryCount === "number" ? data.cleanupRetryCount : 0;
  const retryCount = failed
    ? previousCount + 1
    : driveCleanupDeferred
      ? previousCount
      : 0;
  const previousObservationCount =
    typeof data.cleanupNoSheetObservationCount === "number"
      ? data.cleanupNoSheetObservationCount
      : 0;
  let noSheetObservationCount = previousObservationCount;
  let awaitingAmbiguousSheetObservation = false;
  if (ambiguousSheet && !failed && google) {
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
    : driveCleanupDeferred || awaitingAmbiguousSheetObservation
      ? "pending"
      : "complete";
  const update: Record<string, unknown> = {
    cleanupState,
    cleanupRetryCount: retryCount,
    cleanupNoSheetObservationCount: noSheetObservationCount,
    cleanupLastAttemptAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (sheetIds.size > 0 && !failed) update.cleanupSheetId = null;
  if (failed) {
    update.cleanupSafeErrorCategory = category;
  } else if (!driveCleanupDeferred) {
    update.cleanupSafeErrorCategory = FieldValue.delete();
  }
  await snapshot.ref.update(update);
  const details = {
    operation: "reconcileRegistrations",
    resourceType: "cleanup",
    registrationRequestId: snapshot.id,
    status: cleanupState,
    driveCleanupDeferred,
    ...(failed ? { errorCategory: category } : {}),
  };
  if (cleanupState === "failed") {
    logger.error("Registration cleanup reached a terminal failure", details);
  } else {
    logger.info("Failed-registration cleanup attempted", details);
  }
}

async function reconcileStaleRegistration(
  db: Firestore,
  adminAuth: Auth,
  google: GoogleApiClients | undefined,
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
    await reconcileCleanup(
      db,
      adminAuth,
      google,
      cleanupSnapshot,
    );
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
  getGoogle: GoogleApiClientFactory,
  runtime: ReconciliationRuntime = {},
): Promise<void> {
  const now = runtime.now ?? Date.now;
  const startedAtMs = now();
  let healthyGoogle: GoogleApiClients | undefined;
  try {
    const google = await getGoogle();
    const health = await verifyRegistrationDependencies(google);
    healthyGoogle = google;
    logger.info("Registration dependencies healthy", {
      operation: "registrationDependencyHealth",
      status: "healthy",
      sheetsReadVerified: health.sheetsReadVerified,
    });
  } catch (error: unknown) {
    logger.error("Registration dependencies unavailable", {
      operation: "registrationDependencyHealth",
      status: "unhealthy",
      errorCategory: safeErrorCategory(error),
    });
  }

  const staleCutoffMs = startedAtMs - STALE_REGISTRATION_GRACE_MS;
  const revivalCutoffMs =
    startedAtMs - FAILED_RECONCILIATION_REVIVAL_INTERVAL_MS;
  const emptyQuerySnapshot = {
    docs: [],
  } as unknown as FirebaseFirestore.QuerySnapshot;
  const [
    sheetSnapshot,
    auditSnapshot,
    emailSnapshot,
    cleanupSnapshot,
    staleSnapshot,
    failedSheetSnapshot,
    failedEmailSnapshot,
    failedCleanupSnapshot,
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
        Timestamp.fromMillis(startedAtMs - SHEET_AUDIT_INTERVAL_MS),
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
    healthyGoogle
      ? db
          .collection("teams")
          .where("sheetSyncStatus", "==", "failed")
          .where(
            "sheetSyncSafeErrorCategory",
            "in",
            ["transient", "google_transient"],
          )
          .where(
            "sheetSyncLastAttemptAt",
            "<=",
            Timestamp.fromMillis(revivalCutoffMs),
          )
          .orderBy("sheetSyncLastAttemptAt", "asc")
          .limit(RECONCILIATION_BATCH_SIZE)
          .get()
      : Promise.resolve(emptyQuerySnapshot),
    healthyGoogle
      ? db
          .collection("teams")
          .where("registrationEmailStatus", "==", "failed")
          .where(
            "registrationEmailSafeErrorCategory",
            "in",
            ["transient", "google_transient"],
          )
          .where(
            "registrationEmailLastAttemptAt",
            "<=",
            Timestamp.fromMillis(revivalCutoffMs),
          )
          .orderBy("registrationEmailLastAttemptAt", "asc")
          .limit(RECONCILIATION_BATCH_SIZE)
          .get()
      : Promise.resolve(emptyQuerySnapshot),
    db
      .collection("registrationRequests")
      .where("cleanupState", "==", "failed")
      .where(
        "cleanupSafeErrorCategory",
        "in",
        ["transient", "google_transient"],
      )
      .where(
        "cleanupLastAttemptAt",
        "<=",
        Timestamp.fromMillis(revivalCutoffMs),
      )
      .orderBy("cleanupLastAttemptAt", "asc")
      .limit(RECONCILIATION_BATCH_SIZE)
      .get(),
    ]);

  const jobs: ReconciliationJob[] = [];
  const count = Math.max(
    sheetSnapshot.docs.length,
    emailSnapshot.docs.length,
    cleanupSnapshot.docs.length,
    auditSnapshot.docs.length,
    staleSnapshot.docs.length,
    failedSheetSnapshot.docs.length,
    failedEmailSnapshot.docs.length,
    failedCleanupSnapshot.docs.length,
  );
  for (let index = 0; index < count; index += 1) {
    const cleanup = cleanupSnapshot.docs[index];
    const stale = staleSnapshot.docs[index];
    const failedCleanup = failedCleanupSnapshot.docs[index];
    const email = emailSnapshot.docs[index];
    const failedEmail = failedEmailSnapshot.docs[index];
    const sheet = sheetSnapshot.docs[index];
    const failedSheet = failedSheetSnapshot.docs[index];
    const audit = auditSnapshot.docs[index];
    if (cleanup) {
      jobs.push({
        resourceId: cleanup.id,
        resourceType: "cleanup",
        run: async () =>
          reconcileCleanup(db, adminAuth, healthyGoogle, cleanup),
      });
    }
    if (stale) {
      jobs.push({
        resourceId: stale.id,
        resourceType: "registration",
        run: async () =>
          reconcileStaleRegistration(
            db,
            adminAuth,
            healthyGoogle,
            stale,
            staleCutoffMs,
            startedAtMs,
          ),
      });
    }
    if (
      failedCleanup &&
      isDailyRevivalCategory(failedCleanup.get("cleanupSafeErrorCategory"))
    ) {
      jobs.push({
        resourceId: failedCleanup.id,
        resourceType: "cleanup",
        run: async () => {
          const revived = await reviveFailedCleanup(
            db,
            failedCleanup.id,
            revivalCutoffMs,
          );
          if (!revived) return;
          const refreshed = await failedCleanup.ref.get();
          if (refreshed.exists) {
            await reconcileCleanup(db, adminAuth, healthyGoogle, refreshed);
          }
        },
      });
    }
    if (email && healthyGoogle) {
      const google = healthyGoogle;
      jobs.push({
        resourceId: email.id,
        resourceType: "email",
        run: async () =>
          reconcileEmail(db, adminAuth, google, teamFromSnapshot(email)),
      });
    }
    if (
      failedEmail &&
      healthyGoogle &&
      failedEmail.get("registrationEmailRetryIneligible") !== true &&
      isDailyRevivalCategory(
        failedEmail.get("registrationEmailSafeErrorCategory"),
      )
    ) {
      const google = healthyGoogle;
      jobs.push({
        resourceId: failedEmail.id,
        resourceType: "email",
        run: async () => {
          const revived = await reviveFailedRegistrationEmail(
            db,
            failedEmail.id,
            revivalCutoffMs,
          );
          if (revived) {
            await reconcileEmail(
              db,
              adminAuth,
              google,
              teamFromSnapshot(failedEmail),
            );
          }
        },
      });
    }
    if (sheet && healthyGoogle) {
      const google = healthyGoogle;
      jobs.push({
        resourceId: sheet.id,
        resourceType: "sheet",
        run: async () =>
          reconcileSheet(db, google, teamFromSnapshot(sheet)),
      });
    }
    if (
      failedSheet &&
      healthyGoogle &&
      isDailyRevivalCategory(failedSheet.get("sheetSyncSafeErrorCategory"))
    ) {
      const google = healthyGoogle;
      jobs.push({
        resourceId: failedSheet.id,
        resourceType: "sheet",
        run: async () => {
          const revived = await reviveFailedSheetSynchronization(
            db,
            failedSheet.id,
            revivalCutoffMs,
          );
          if (revived) {
            await reconcileSheet(db, google, teamFromSnapshot(failedSheet));
          }
        },
      });
    }
    if (audit && healthyGoogle) {
      const google = healthyGoogle;
      jobs.push({
        resourceId: audit.id,
        resourceType: "sheet",
        run: async () =>
          reconcileSheet(db, google, teamFromSnapshot(audit), true),
      });
    }
  }
  let cursor = 0;
  let launchedCount = 0;
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      if (now() - startedAtMs >= RECONCILIATION_JOB_LAUNCH_WINDOW_MS) return;
      const job = jobs[cursor];
      cursor += 1;
      if (!job) continue;
      launchedCount += 1;
      try {
        await job.run();
      } catch (error: unknown) {
        logger.error("Reconciliation item failed in isolation", {
          operation: "reconcileRegistrations",
          status: "failed",
          unexpected: true,
          resourceType: job.resourceType,
          resourceId: job.resourceId,
          errorCategory: safeErrorCategory(error),
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(RECONCILIATION_MAX_CONCURRENCY, jobs.length) },
      worker,
    ),
  );
  const deferredCount = jobs.length - launchedCount;
  logger.info("Reconciliation scheduler pass completed", {
    operation: "reconcileRegistrations",
    status: "complete",
    startedAtMs,
    elapsedMs: Math.max(0, now() - startedAtMs),
    queuedCount: jobs.length,
    launchedCount,
    deferredCount,
  });
}
