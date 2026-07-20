import type { Auth, UserRecord } from "firebase-admin/auth";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import {
  AppError,
  isRetryableSafeCategory,
  safeErrorCategory,
} from "./errors.js";
import {
  advanceRegistration,
  inspectRegistration,
  markRegistrationFailed,
  releaseRegistrationForRetry,
  reserveRegistration,
} from "./idempotency.js";
import type {
  RegistrationInput,
  RegistrationSafeResult,
  TeamDocument,
} from "./models.js";
import { generateTemporaryPassword } from "./password.js";
import {
  hmacIdentifier,
  normalizeRequestIp,
  stableEmailOwnershipId,
} from "./security.js";
import { allocateTeamIdentity } from "./team-id.js";
import {
  deleteTeamResources,
  assertPrimaryEmailUnowned,
  persistNewTeam,
} from "./team-repository.js";
import { canonicalRegistrationHash } from "./validation.js";

export interface RegistrationDependencies {
  db: Firestore;
  adminAuth: Auth;
  rateLimitHmacSecret: string;
}

async function idempotentlySetRegistrationPassword(
  adminAuth: Auth,
  uid: string,
  password: string,
): Promise<UserRecord> {
  try {
    return await adminAuth.updateUser(uid, { password });
  } catch {
    // Setting the same value is idempotent and resolves an ambiguous committed
    // update without needing to read or persist the credential.
    return adminAuth.updateUser(uid, { password });
  }
}

async function createRegistrationUser(
  adminAuth: Auth,
  input: RegistrationInput,
  temporaryPassword: string,
  registrationRequestId: string,
): Promise<UserRecord> {
  const deterministicUid = `roco_${registrationRequestId}`;
  let user: UserRecord;
  try {
    const existing = await adminAuth.getUserByEmail(input.primaryContactEmail);
    if (
      existing.uid !== deterministicUid ||
      existing.email?.toLowerCase() !== input.primaryContactEmail
    ) {
      throw new AppError(
        "already-exists",
        "An account already exists for this email address.",
        "conflict",
      );
    }
    user = existing;
    user = await idempotentlySetRegistrationPassword(
      adminAuth,
      user.uid,
      temporaryPassword,
    );
    await adminAuth.revokeRefreshTokens(user.uid);
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "auth/user-not-found"
    ) {
      throw error;
    }
    try {
      user = await adminAuth.createUser({
        uid: deterministicUid,
        email: input.primaryContactEmail,
        password: temporaryPassword,
        emailVerified: false,
        disabled: false,
      });
    } catch (createError: unknown) {
      let recovered: UserRecord;
      try {
        recovered = await adminAuth.getUser(deterministicUid);
      } catch {
        throw createError;
      }
      if (recovered.email?.toLowerCase() !== input.primaryContactEmail) {
        throw new AppError(
          "already-exists",
          "An account already exists for this registration.",
          "conflict",
        );
      }
      user = await idempotentlySetRegistrationPassword(
        adminAuth,
        deterministicUid,
        temporaryPassword,
      );
      await adminAuth.revokeRefreshTokens(deterministicUid);
    }
  }
  try {
    await adminAuth.setCustomUserClaims(user.uid, {
      ...(user.customClaims ?? {}),
      mustChangePassword: true,
    });
  } catch (error: unknown) {
    await adminAuth.deleteUser(user.uid).catch(() => undefined);
    throw error;
  }
  return user;
}

async function restoreTemporaryCredential(
  adminAuth: Auth,
  ownerUid: string,
  temporaryPassword: string,
): Promise<UserRecord> {
  const user = await adminAuth.getUser(ownerUid);
  await idempotentlySetRegistrationPassword(
    adminAuth,
    ownerUid,
    temporaryPassword,
  );
  await adminAuth.setCustomUserClaims(ownerUid, {
    ...(user.customClaims ?? {}),
    mustChangePassword: true,
  });
  await adminAuth.revokeRefreshTokens(ownerUid);
  return user;
}

export async function registerTeamOperation(
  dependencies: RegistrationDependencies,
  input: RegistrationInput,
  requestIp: string | undefined,
): Promise<RegistrationSafeResult> {
  const { db, adminAuth, rateLimitHmacSecret } = dependencies;
  const requestHash = canonicalRegistrationHash(input);
  const emailDigest = hmacIdentifier(
    rateLimitHmacSecret,
    "registration-email",
    input.primaryContactEmail,
  );
  const emailOwnershipId = stableEmailOwnershipId(input.primaryContactEmail);
  const inspection = await inspectRegistration(
    db,
    input.idempotencyKey,
    requestHash,
  );
  if (inspection.result) return inspection.result;
  const ipDigest = hmacIdentifier(
    rateLimitHmacSecret,
    "registration-ip",
    normalizeRequestIp(requestIp),
  );
  const reservation = await reserveRegistration(
    db,
    input.idempotencyKey,
    requestHash,
    emailDigest,
    Date.now(),
    { ip: ipDigest, email: emailDigest },
    emailOwnershipId,
  );
  if (reservation.result) return reservation.result;

  let ownerUid = reservation.ownerUid;
  const sheetId = reservation.sheetId;
  let stage = "email_ownership";
  const startedAt = Date.now();
  try {
    await assertPrimaryEmailUnowned(db, emailOwnershipId);

    stage = "team_identity";
    const identity =
      reservation.teamId && reservation.teamNumber
        ? { teamId: reservation.teamId, teamNumber: reservation.teamNumber }
        : await allocateTeamIdentity(db, reservation);

    // A plaintext temporary credential exists only in this invocation's memory.
    const temporaryPassword = generateTemporaryPassword();
    stage = "authentication";
    if (reservation.state === "allocating") {
      const user = await createRegistrationUser(
        adminAuth,
        input,
        temporaryPassword,
        reservation.requestId,
      );
      ownerUid = user.uid;
      reservation.ownerUid = ownerUid;
      await advanceRegistration(db, reservation, "auth_created", { ownerUid });
    } else if (ownerUid) {
      await restoreTemporaryCredential(adminAuth, ownerUid, temporaryPassword);
    } else {
      throw new Error("Registration owner state is incomplete.");
    }

    const now = Timestamp.now();
    // Firestore is the authoritative registration record. Drive/Sheets are
    // deliberately provisioned after this transaction by the reconciler so a
    // Google outage cannot roll back a valid Auth account and team.
    const legacySheetId = reservation.sheetId ?? null;
    const legacySheetUrl = legacySheetId
      ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(legacySheetId)}/edit`
      : null;
    const team: TeamDocument = {
      teamId: identity.teamId,
      teamNumber: identity.teamNumber,
      teamName: input.teamName,
      ownerUid,
      primaryContactEmail: input.primaryContactEmail,
      tracks: input.tracks,
      members: input.members,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      status: "active",
      sheetId: legacySheetId,
      sheetUrl: legacySheetUrl,
      sheetCreateAttemptedAt: reservation.sheetCreateAttemptedAt ?? null,
      sheetCreateNoFileObservationCount: 0,
      sheetSyncStatus: "pending",
      sheetLastSyncedRevision: 0,
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
      registrationRequestId: reservation.requestId,
    };
    stage = "team_persistence";
    await persistNewTeam(db, team, {
      reference: reservation.reference,
      leaseId: reservation.leaseId,
    }, emailOwnershipId);
    reservation.state = "email_pending";
    logger.info("Registration core committed", {
      operation: "registerTeam",
      teamId: team.teamId,
      status: "email_pending",
      durationMs: Date.now() - startedAt,
    });
    return { teamId: team.teamId, emailStatus: "pending" };
  } catch (error: unknown) {
    const category = safeErrorCategory(error);
    if (isRetryableSafeCategory(category)) {
      try {
        await releaseRegistrationForRetry(db, reservation, category);
      } catch (releaseError: unknown) {
        logger.warn("Registration retry lease release deferred", {
          operation: "registerTeam",
          teamId: reservation.teamId ?? null,
          status: reservation.state,
          stage,
          errorCategory: safeErrorCategory(releaseError),
        });
      }
      logger.warn("Registration deferred for idempotent retry", {
        operation: "registerTeam",
        teamId: reservation.teamId ?? null,
        status: reservation.state,
        stage,
        errorCategory: category,
      });
      throw error;
    }
    const cleanupOwnerUid =
      ownerUid ?? reservation.ownerUid ?? `roco_${reservation.requestId}`;
    let cleanupRequired = false;
    if (reservation.teamId) {
      try {
        await deleteTeamResources(
          db,
          reservation.teamId,
          cleanupOwnerUid,
          reservation.requestId,
        );
      } catch {
        cleanupRequired = true;
      }
    }
    try {
      await adminAuth.deleteUser(cleanupOwnerUid);
    } catch (deleteError: unknown) {
      if (
        typeof deleteError !== "object" ||
        deleteError === null ||
        !("code" in deleteError) ||
        deleteError.code !== "auth/user-not-found"
      ) {
        cleanupRequired = true;
      }
    }
    await markRegistrationFailed(db, reservation, category, {
      required:
        cleanupRequired ||
        sheetId !== undefined ||
        reservation.sheetCreateAttemptedAt !== undefined,
      ownerUid: cleanupOwnerUid,
      emailOwnershipId,
      ...(sheetId ? { sheetId } : {}),
      ...(reservation.teamId ? { teamId: reservation.teamId } : {}),
      ambiguousSheet: reservation.sheetCreateAttemptedAt !== undefined,
      ...(reservation.sheetCreateAttemptedAt
        ? { sheetCreateAttemptedAt: reservation.sheetCreateAttemptedAt }
        : {}),
    });
    logger.error("Registration failed", {
      operation: "registerTeam",
      teamId: reservation.teamId ?? null,
      status: "failed",
      stage,
      errorCategory: category,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
