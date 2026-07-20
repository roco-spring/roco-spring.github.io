import { createHash, randomUUID } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import {
  REGISTRATION_LEASE_MS,
  RATE_LIMITS,
} from "./config.js";
import { AppError } from "./errors.js";
import type {
  RegistrationSafeResult,
  RegistrationState,
} from "./models.js";
import { safeDigestEqual } from "./security.js";

export interface RegistrationReservation {
  requestId: string;
  reference: DocumentReference;
  leaseId: string;
  state: RegistrationState;
  isNew: boolean;
  teamId?: string;
  teamNumber?: number;
  ownerUid?: string;
  sheetId?: string;
  sheetCreateAttemptedAt?: Timestamp;
  emailOwnershipId?: string;
  result?: RegistrationSafeResult;
}

const REVIVABLE_FAILED_CATEGORIES = new Set([
  "transient",
  "google_transient",
  "google_configuration",
]);

export function idempotencyDocumentId(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

export async function inspectRegistration(
  db: Firestore,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ exists: boolean; result?: RegistrationSafeResult }> {
  const reference = db
    .collection("registrationRequests")
    .doc(idempotencyDocumentId(idempotencyKey));
  const snapshot = await reference.get();
  if (!snapshot.exists) return { exists: false };
  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  if (
    typeof data.requestHash !== "string" ||
    !safeDigestEqual(data.requestHash, requestHash)
  ) {
    throw new AppError(
      "already-exists",
      "The idempotency key has already been used for different details.",
      "conflict",
    );
  }
  const state = data.state;
  if (
    ["team_persisted", "email_pending", "active"].includes(String(state)) &&
    typeof data.teamId === "string"
  ) {
    const emailStatus =
      data.emailStatus === "sent"
        ? "sent"
        : data.emailStatus === "failed"
          ? "failed"
          : "pending";
    return {
      exists: true,
      result: { teamId: data.teamId, emailStatus },
    };
  }
  return { exists: true };
}

export async function reserveRegistration(
  db: Firestore,
  idempotencyKey: string,
  requestHash: string,
  normalizedPrimaryEmailHash: string,
  now = Date.now(),
  rateLimitDigests?: { ip: string; email: string },
  emailOwnershipId?: string,
): Promise<RegistrationReservation> {
  const requestId = idempotencyDocumentId(idempotencyKey);
  const reference = db.collection("registrationRequests").doc(requestId);
  const leaseId = randomUUID();

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) {
      if (rateLimitDigests) {
        const limits = [
          {
            reference: db.collection("rateLimits").doc(`ip_${rateLimitDigests.ip}`),
            ...RATE_LIMITS.ip,
          },
          {
            reference: db
              .collection("rateLimits")
              .doc(`email_${rateLimitDigests.email}`),
            ...RATE_LIMITS.email,
          },
        ];
        const snapshots = await Promise.all(
          limits.map(async (limit) => transaction.get(limit.reference)),
        );
        limits.forEach((limit, index) => {
          const limitSnapshot = snapshots[index];
          if (!limitSnapshot) throw new Error("Rate-limit state is incomplete.");
          const data = limitSnapshot.data() as Record<string, unknown> | undefined;
          const startedAt: unknown = data?.windowStartedAt;
          const existingStart =
            startedAt instanceof Timestamp ? startedAt.toMillis() : Number.NaN;
          const stillInWindow =
            Number.isFinite(existingStart) &&
            now - existingStart < limit.windowMs;
          const count =
            stillInWindow && typeof data?.count === "number" ? data.count : 0;
          if (count >= limit.maxAttempts) {
            throw new AppError(
              "resource-exhausted",
              "Registration is temporarily unavailable. Please try again later.",
              "rate_limit",
            );
          }
          const windowStartedAt = stillInWindow ? existingStart : now;
          transaction.set(limit.reference, {
            count: count + 1,
            windowStartedAt: Timestamp.fromMillis(windowStartedAt),
            expiresAt: Timestamp.fromMillis(windowStartedAt + limit.windowMs),
            updatedAt: Timestamp.fromMillis(now),
          });
        });
      }
      transaction.create(reference, {
        requestHash,
        normalizedPrimaryEmailHash,
        ...(emailOwnershipId ? { emailOwnershipId } : {}),
        state: "allocating",
        leaseId,
        leaseExpiresAt: Timestamp.fromMillis(now + REGISTRATION_LEASE_MS),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        requestId,
        reference,
        leaseId,
        state: "allocating",
        isNew: true,
        ...(emailOwnershipId ? { emailOwnershipId } : {}),
      };
    }

    const data = (snapshot.data() ?? {}) as Record<string, unknown>;
    if (
      typeof data.requestHash !== "string" ||
      !safeDigestEqual(data.requestHash, requestHash)
    ) {
      throw new AppError(
        "already-exists",
        "The idempotency key has already been used for different details.",
        "conflict",
      );
    }

    const state = data.state as RegistrationState;
    if (
      ["team_persisted", "email_pending", "active"].includes(state) &&
      typeof data.teamId === "string"
    ) {
      const emailStatus =
        data.emailStatus === "sent"
          ? "sent"
          : data.emailStatus === "failed"
            ? "failed"
            : "pending";
      return {
        requestId,
        reference,
        leaseId: "",
        state,
        isNew: false,
        teamId: data.teamId,
        result: { teamId: data.teamId, emailStatus },
      };
    }

    if (state === "failed") {
      const safeCategory =
        typeof data.safeErrorCategory === "string"
          ? data.safeErrorCategory
          : "";
      if (!REVIVABLE_FAILED_CATEGORIES.has(safeCategory)) {
        throw new AppError(
          "failed-precondition",
          "This registration attempt failed. Submit again to start a new attempt.",
          "conflict",
        );
      }
      if (data.cleanupState !== "complete") {
        throw new AppError(
          "aborted",
          "This registration is still being recovered. Please retry shortly.",
          "conflict",
        );
      }
      const storedEmailOwnershipId =
        typeof data.emailOwnershipId === "string"
          ? data.emailOwnershipId
          : emailOwnershipId;

      transaction.update(reference, {
        state: "allocating",
        leaseId,
        leaseExpiresAt: Timestamp.fromMillis(now + REGISTRATION_LEASE_MS),
        ...(storedEmailOwnershipId
          ? { emailOwnershipId: storedEmailOwnershipId }
          : {}),
        ownerUid: FieldValue.delete(),
        sheetId: FieldValue.delete(),
        sheetUrl: FieldValue.delete(),
        sheetCreateAttemptedAt: FieldValue.delete(),
        emailStatus: FieldValue.delete(),
        safeErrorCategory: FieldValue.delete(),
        cleanupState: FieldValue.delete(),
        cleanupRetryCount: FieldValue.delete(),
        cleanupLastAttemptAt: FieldValue.delete(),
        cleanupOwnerUid: FieldValue.delete(),
        cleanupSheetId: FieldValue.delete(),
        cleanupTeamId: FieldValue.delete(),
        cleanupAmbiguousSheet: FieldValue.delete(),
        cleanupNoSheetObservationCount: FieldValue.delete(),
        cleanupSheetCreateAttemptedAt: FieldValue.delete(),
        cleanupEmailOwnershipId: FieldValue.delete(),
        cleanupSafeErrorCategory: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const revived: RegistrationReservation = {
        requestId,
        reference,
        leaseId,
        state: "allocating",
        isNew: false,
      };
      if (typeof data.teamId === "string") revived.teamId = data.teamId;
      if (typeof data.teamNumber === "number") {
        revived.teamNumber = data.teamNumber;
      }
      if (storedEmailOwnershipId) {
        revived.emailOwnershipId = storedEmailOwnershipId;
      }
      return revived;
    }

    const leaseExpiresAt: unknown = data.leaseExpiresAt;
    if (
      leaseExpiresAt instanceof Timestamp &&
      leaseExpiresAt.toMillis() > now &&
      typeof data.leaseId === "string"
    ) {
      throw new AppError(
        "aborted",
        "This registration is already being processed. Please retry shortly.",
        "conflict",
      );
    }

    transaction.update(reference, {
      leaseId,
      leaseExpiresAt: Timestamp.fromMillis(now + REGISTRATION_LEASE_MS),
      ...(typeof data.emailOwnershipId !== "string" && emailOwnershipId
        ? { emailOwnershipId }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    const reservation: RegistrationReservation = {
      requestId,
      reference,
      leaseId,
      state,
      isNew: false,
    };
    if (typeof data.teamId === "string") reservation.teamId = data.teamId;
    if (typeof data.teamNumber === "number") reservation.teamNumber = data.teamNumber;
    if (typeof data.ownerUid === "string") reservation.ownerUid = data.ownerUid;
    if (typeof data.sheetId === "string") reservation.sheetId = data.sheetId;
    if (data.sheetCreateAttemptedAt instanceof Timestamp) {
      reservation.sheetCreateAttemptedAt = data.sheetCreateAttemptedAt;
    }
    const storedEmailOwnershipId =
      typeof data.emailOwnershipId === "string"
        ? data.emailOwnershipId
        : emailOwnershipId;
    if (storedEmailOwnershipId) {
      reservation.emailOwnershipId = storedEmailOwnershipId;
    }
    return reservation;
  });
}

export async function advanceRegistration(
  db: Firestore,
  reservation: RegistrationReservation,
  state: RegistrationState,
  values: Record<string, unknown> = {},
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservation.reference);
    if (!snapshot.exists || snapshot.get("leaseId") !== reservation.leaseId) {
      throw new AppError(
        "aborted",
        "Registration processing was superseded. Please retry.",
        "conflict",
      );
    }
    transaction.update(reservation.reference, {
      ...values,
      state,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  reservation.state = state;
}

export async function markRegistrationFailed(
  db: Firestore,
  reservation: RegistrationReservation,
  safeErrorCategory: string,
  cleanup?: {
    required: boolean;
    ownerUid?: string;
    sheetId?: string;
    teamId?: string;
    emailOwnershipId?: string;
    ambiguousSheet?: boolean;
    sheetCreateAttemptedAt?: Timestamp;
  },
): Promise<boolean> {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservation.reference);
    if (!snapshot.exists || snapshot.get("leaseId") !== reservation.leaseId) {
      // A newer invocation owns the saga and is responsible for its outcome.
      return false;
    }
    transaction.update(reservation.reference, {
      state: "failed",
      safeErrorCategory,
      cleanupState: cleanup?.required ? "pending" : "complete",
      cleanupRetryCount: 0,
      cleanupLastAttemptAt: Timestamp.fromMillis(0),
      cleanupOwnerUid: cleanup?.ownerUid ?? null,
      cleanupSheetId: cleanup?.sheetId ?? null,
      cleanupTeamId: cleanup?.teamId ?? null,
      cleanupEmailOwnershipId:
        cleanup?.emailOwnershipId ?? reservation.emailOwnershipId ?? null,
      cleanupAmbiguousSheet: cleanup?.ambiguousSheet === true,
      cleanupNoSheetObservationCount: 0,
      cleanupSheetCreateAttemptedAt:
        cleanup?.sheetCreateAttemptedAt ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

const INCOMPLETE_REGISTRATION_STATES = new Set<RegistrationState>([
  "allocating",
  "auth_created",
  "sheet_created",
]);

export async function fenceStaleRegistrationForCleanup(
  db: Firestore,
  registrationRequestId: string,
  cutoffMs: number,
  now = Date.now(),
): Promise<boolean> {
  const reference = db
    .collection("registrationRequests")
    .doc(registrationRequestId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return false;
    const state = snapshot.get("state") as RegistrationState;
    if (!INCOMPLETE_REGISTRATION_STATES.has(state)) return false;
    const updatedAt: unknown = snapshot.get("updatedAt");
    if (!(updatedAt instanceof Timestamp) || updatedAt.toMillis() > cutoffMs) {
      return false;
    }
    const leaseExpiresAt: unknown = snapshot.get("leaseExpiresAt");
    if (
      leaseExpiresAt instanceof Timestamp &&
      leaseExpiresAt.toMillis() > now
    ) {
      return false;
    }
    const ownerUid: unknown = snapshot.get("ownerUid");
    const teamId: unknown = snapshot.get("teamId");
    const sheetId: unknown = snapshot.get("sheetId");
    const sheetCreateAttemptedAt: unknown = snapshot.get(
      "sheetCreateAttemptedAt",
    );
    const emailOwnershipId: unknown = snapshot.get("emailOwnershipId");
    transaction.update(reference, {
      state: "failed",
      safeErrorCategory: "transient",
      cleanupState: "pending",
      cleanupRetryCount: 0,
      cleanupLastAttemptAt: Timestamp.fromMillis(0),
      cleanupOwnerUid:
        typeof ownerUid === "string"
          ? ownerUid
          : `roco_${registrationRequestId}`,
      cleanupTeamId: typeof teamId === "string" ? teamId : null,
      cleanupSheetId: typeof sheetId === "string" ? sheetId : null,
      cleanupEmailOwnershipId:
        typeof emailOwnershipId === "string" ? emailOwnershipId : null,
      cleanupAmbiguousSheet: sheetCreateAttemptedAt instanceof Timestamp,
      cleanupNoSheetObservationCount: 0,
      cleanupSheetCreateAttemptedAt:
        sheetCreateAttemptedAt instanceof Timestamp
          ? sheetCreateAttemptedAt
          : null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

export async function releaseRegistrationForRetry(
  db: Firestore,
  reservation: RegistrationReservation,
  safeErrorCategory: string,
): Promise<void> {
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reservation.reference);
    if (!snapshot.exists || snapshot.get("leaseId") !== reservation.leaseId) return;
    transaction.update(reservation.reference, {
      leaseExpiresAt: Timestamp.fromMillis(0),
      safeErrorCategory,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
