import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { AppError, isRetryableSafeCategory } from "./errors.js";
import {
  MAX_RECONCILIATION_ATTEMPTS,
  RESOURCE_LEASE_MS,
} from "./config.js";
import type {
  PublicTeam,
  TeamDocument,
  UpdateTeamInput,
} from "./models.js";
import { assertPrimaryMember } from "./validation.js";

export async function assertPrimaryEmailUnowned(
  db: Firestore,
  normalizedEmailHash: string,
): Promise<void> {
  const snapshot = await db
    .collection("teamEmails")
    .doc(normalizedEmailHash)
    .get();
  if (snapshot.exists) {
    throw new AppError(
      "already-exists",
      "An account already exists for this email address.",
      "conflict",
    );
  }
}

function asTeamDocument(data: FirebaseFirestore.DocumentData): TeamDocument {
  return data as TeamDocument;
}

function timestampToIso(value: unknown): string {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  throw new AppError("internal", "Team timestamps are unavailable.", "internal");
}

export function toPublicTeam(team: TeamDocument): PublicTeam {
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    primaryContactEmail: team.primaryContactEmail,
    tracks: [...team.tracks],
    members: team.members.map((member) => ({ ...member })),
    createdAt: timestampToIso(team.createdAt),
    updatedAt: timestampToIso(team.updatedAt),
    revision: team.revision,
    status: team.status,
    sheetSyncStatus: team.sheetSyncStatus,
    sheetLastSyncedRevision: team.sheetLastSyncedRevision,
  };
}

export async function persistNewTeam(
  db: Firestore,
  team: TeamDocument,
  saga?: { reference: DocumentReference; leaseId: string },
  normalizedEmailHash?: string,
): Promise<void> {
  const teamReference = db.collection("teams").doc(team.teamId);
  const ownerReference = db.collection("teamOwners").doc(team.ownerUid);
  const emailOwnerReference = normalizedEmailHash
    ? db.collection("teamEmails").doc(normalizedEmailHash)
    : undefined;
  const isExactCommittedState = (
    teamSnapshot: { exists: boolean; get(field: string): unknown },
    ownerSnapshot: { exists: boolean; get(field: string): unknown },
    sagaSnapshot: { exists: boolean; get(field: string): unknown } | undefined,
    emailSnapshot: { exists: boolean; get(field: string): unknown } | undefined,
  ): boolean =>
    teamSnapshot.exists &&
    teamSnapshot.get("registrationRequestId") === team.registrationRequestId &&
    teamSnapshot.get("ownerUid") === team.ownerUid &&
    ownerSnapshot.exists &&
    ownerSnapshot.get("teamId") === team.teamId &&
    (!saga ||
      (sagaSnapshot?.exists === true &&
        sagaSnapshot.get("teamId") === team.teamId &&
        ["email_pending", "active"].includes(String(sagaSnapshot.get("state"))))) &&
    (!emailOwnerReference ||
      (emailSnapshot?.exists === true &&
        emailSnapshot.get("teamId") === team.teamId &&
        emailSnapshot.get("ownerUid") === team.ownerUid));

  try {
    await db.runTransaction(async (transaction) => {
    const [teamSnapshot, ownerSnapshot, sagaSnapshot, emailOwnerSnapshot] = await Promise.all([
      transaction.get(teamReference),
      transaction.get(ownerReference),
      saga ? transaction.get(saga.reference) : Promise.resolve(undefined),
      emailOwnerReference
        ? transaction.get(emailOwnerReference)
        : Promise.resolve(undefined),
    ]);
    if (
      isExactCommittedState(
        teamSnapshot,
        ownerSnapshot,
        sagaSnapshot,
        emailOwnerSnapshot,
      )
    ) {
      return;
    }
    if (teamSnapshot.exists || ownerSnapshot.exists || emailOwnerSnapshot?.exists) {
      throw new AppError(
        "already-exists",
        "This account already owns a team.",
        "conflict",
      );
    }
    transaction.create(teamReference, {
      ...team,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.create(ownerReference, {
      teamId: team.teamId,
      createdAt: FieldValue.serverTimestamp(),
    });
    if (emailOwnerReference) {
      transaction.create(emailOwnerReference, {
        teamId: team.teamId,
        ownerUid: team.ownerUid,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    if (saga) {
      if (!sagaSnapshot?.exists || sagaSnapshot.get("leaseId") !== saga.leaseId) {
        throw new AppError(
          "aborted",
          "Registration processing was superseded. Please retry.",
          "conflict",
        );
      }
      transaction.update(saga.reference, {
        state: "email_pending",
        teamId: team.teamId,
        teamNumber: team.teamNumber,
        ownerUid: team.ownerUid,
        sheetId: team.sheetId,
        sheetUrl: team.sheetUrl,
        emailStatus: "pending",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    });
  } catch (error: unknown) {
    // Firestore may commit and then return an ambiguous transport error. Verify
    // the complete cross-document invariant before compensating anything.
    const [teamSnapshot, ownerSnapshot, sagaSnapshot, emailOwnerSnapshot] =
      await Promise.all([
        teamReference.get(),
        ownerReference.get(),
        saga ? saga.reference.get() : Promise.resolve(undefined),
        emailOwnerReference
          ? emailOwnerReference.get()
          : Promise.resolve(undefined),
      ]);
    if (
      isExactCommittedState(
        teamSnapshot,
        ownerSnapshot,
        sagaSnapshot,
        emailOwnerSnapshot,
      )
    ) {
      return;
    }
    throw error;
  }
}

export async function deleteTeamResources(
  db: Firestore,
  teamId: string,
  ownerUid: string,
  registrationRequestId: string,
): Promise<void> {
  const teamReference = db.collection("teams").doc(teamId);
  const ownerReference = db.collection("teamOwners").doc(ownerUid);
  await db.runTransaction(async (transaction) => {
    const [teamSnapshot, ownerSnapshot] = await Promise.all([
      transaction.get(teamReference),
      transaction.get(ownerReference),
    ]);
    const matchingTeam =
      teamSnapshot.exists &&
      teamSnapshot.get("registrationRequestId") === registrationRequestId &&
      teamSnapshot.get("ownerUid") === ownerUid;
    if (matchingTeam) transaction.delete(teamReference);
    if (
      ownerSnapshot.exists &&
      ownerSnapshot.get("teamId") === teamId &&
      (matchingTeam || !teamSnapshot.exists)
    ) {
      transaction.delete(ownerReference);
    }
  });
}

export async function getOwnedTeam(
  db: Firestore,
  ownerUid: string,
): Promise<TeamDocument> {
  const ownerSnapshot = await db.collection("teamOwners").doc(ownerUid).get();
  const teamId: unknown = ownerSnapshot.get("teamId");
  if (typeof teamId !== "string") {
    throw new AppError("not-found", "No team is associated with this account.", "authorization");
  }
  const teamSnapshot = await db.collection("teams").doc(teamId).get();
  if (!teamSnapshot.exists) {
    throw new AppError("not-found", "No team is associated with this account.", "authorization");
  }
  const team = asTeamDocument(teamSnapshot.data() ?? {});
  if (team.ownerUid !== ownerUid || team.teamId !== teamId) {
    throw new AppError("permission-denied", "Team access was denied.", "authorization");
  }
  return team;
}

export interface CommittedTeamUpdate {
  previous: TeamDocument;
  current: TeamDocument;
}

export async function commitTeamUpdate(
  db: Firestore,
  ownerUid: string,
  input: UpdateTeamInput,
): Promise<CommittedTeamUpdate> {
  const ownerReference = db.collection("teamOwners").doc(ownerUid);

  return db.runTransaction(async (transaction) => {
    const ownerSnapshot = await transaction.get(ownerReference);
    const teamId: unknown = ownerSnapshot.get("teamId");
    if (typeof teamId !== "string") {
      throw new AppError("not-found", "No team is associated with this account.", "authorization");
    }

    const teamReference = db.collection("teams").doc(teamId);
    const teamSnapshot = await transaction.get(teamReference);
    if (!teamSnapshot.exists) {
      throw new AppError("not-found", "No team is associated with this account.", "authorization");
    }
    const previous = asTeamDocument(teamSnapshot.data() ?? {});
    if (previous.ownerUid !== ownerUid) {
      throw new AppError("permission-denied", "Team access was denied.", "authorization");
    }
    if (previous.revision !== input.expectedRevision) {
      throw new AppError(
        "aborted",
        "The team was updated elsewhere. Reload it before saving again.",
        "conflict",
      );
    }
    assertPrimaryMember(previous.primaryContactEmail, input.members);

    const updatedAt = Timestamp.now();
    const current: TeamDocument = {
      ...previous,
      teamName: input.teamName,
      tracks: input.tracks,
      members: input.members,
      updatedAt,
      revision: previous.revision + 1,
      sheetSyncStatus: "pending",
      sheetSyncLastAttemptAt: null,
      sheetSyncRetryCount: 0,
    };
    transaction.update(teamReference, {
      teamName: current.teamName,
      tracks: current.tracks,
      members: current.members,
      updatedAt: FieldValue.serverTimestamp(),
      revision: current.revision,
      sheetSyncStatus: "pending",
      sheetSyncLastAttemptAt: null,
      sheetSyncRetryCount: 0,
      sheetSyncSafeErrorCategory: FieldValue.delete(),
    });
    return { previous, current };
  });
}

export interface SheetSynchronizationClaim {
  leaseId: string;
  team: TeamDocument;
}

export async function claimSheetSynchronization(
  db: Firestore,
  teamId: string,
  now = Date.now(),
  allowSyncedAudit = false,
): Promise<SheetSynchronizationClaim | null> {
  const reference = db.collection("teams").doc(teamId);
  const leaseId = randomUUID();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return null;
    const status: unknown = snapshot.get("sheetSyncStatus");
    if (status !== "pending" && !(allowSyncedAudit && status === "synced")) {
      return null;
    }
    const expiresAt: unknown = snapshot.get("sheetSyncLeaseExpiresAt");
    if (expiresAt instanceof Timestamp && expiresAt.toMillis() > now) return null;
    transaction.update(reference, {
      sheetSyncLeaseId: leaseId,
      sheetSyncLeaseExpiresAt: Timestamp.fromMillis(now + RESOURCE_LEASE_MS),
      sheetSyncStatus: "pending",
    });
    return {
      leaseId,
      team: asTeamDocument(snapshot.data() ?? {}),
    };
  });
}

export type SheetPassResult =
  | { state: "complete" }
  | { state: "stale"; team: TeamDocument }
  | { state: "lost" };

export async function finishSheetSynchronizationPass(
  db: Firestore,
  teamId: string,
  leaseId: string,
  synchronizedRevision: number,
): Promise<SheetPassResult> {
  const reference = db.collection("teams").doc(teamId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists || snapshot.get("sheetSyncLeaseId") !== leaseId) {
      return { state: "lost" };
    }
    const current = asTeamDocument(snapshot.data() ?? {});
    if (current.revision !== synchronizedRevision) {
      transaction.update(reference, {
        sheetSyncStatus: "pending",
        sheetSyncLeaseExpiresAt: Timestamp.fromMillis(
          Date.now() + RESOURCE_LEASE_MS,
        ),
      });
      return { state: "stale", team: current };
    }
    transaction.update(reference, {
      sheetSyncStatus: "synced",
      sheetLastSyncedRevision: synchronizedRevision,
      sheetSyncLastAttemptAt: FieldValue.serverTimestamp(),
      sheetSyncRetryCount: 0,
      sheetSyncSafeErrorCategory: FieldValue.delete(),
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
      sheetAuditAt: FieldValue.serverTimestamp(),
    });
    return { state: "complete" };
  });
}

export async function releaseSheetSynchronization(
  db: Firestore,
  teamId: string,
  leaseId: string,
): Promise<void> {
  const reference = db.collection("teams").doc(teamId);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists || snapshot.get("sheetSyncLeaseId") !== leaseId) return;
    transaction.update(reference, {
      sheetSyncStatus: "pending",
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
    });
  });
}

export async function failClaimedSheetSynchronization(
  db: Firestore,
  teamId: string,
  leaseId: string,
  safeCategory: string,
): Promise<"pending" | "failed"> {
  const reference = db.collection("teams").doc(teamId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists || snapshot.get("sheetSyncLeaseId") !== leaseId) {
      return "pending";
    }
    const existingCount: unknown = snapshot.get("sheetSyncRetryCount");
    const retryCount = (typeof existingCount === "number" ? existingCount : 0) + 1;
    const status =
      isRetryableSafeCategory(safeCategory) &&
      retryCount < MAX_RECONCILIATION_ATTEMPTS
        ? "pending"
        : "failed";
    transaction.update(reference, {
      sheetSyncStatus: status,
      sheetSyncLastAttemptAt: FieldValue.serverTimestamp(),
      sheetSyncRetryCount: retryCount,
      sheetSyncSafeErrorCategory: safeCategory,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
    });
    return status;
  });
}

export interface RegistrationEmailAttemptClaim {
  leaseId: string;
  team: TeamDocument;
}

export async function claimRegistrationEmailAttempt(
  db: Firestore,
  teamId: string,
  now = Date.now(),
): Promise<RegistrationEmailAttemptClaim | null> {
  const reference = db.collection("teams").doc(teamId);
  const leaseId = randomUUID();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (
      !snapshot.exists ||
      snapshot.get("registrationEmailStatus") !== "pending" ||
      snapshot.get("registrationEmailRetryIneligible") === true
    ) {
      return null;
    }
    const expiresAt: unknown = snapshot.get("registrationEmailLeaseExpiresAt");
    if (expiresAt instanceof Timestamp && expiresAt.toMillis() > now) return null;
    transaction.update(reference, {
      registrationEmailLeaseId: leaseId,
      registrationEmailLeaseExpiresAt: Timestamp.fromMillis(
        now + RESOURCE_LEASE_MS,
      ),
    });
    return { leaseId, team: asTeamDocument(snapshot.data() ?? {}) };
  });
}

export async function finishRegistrationEmailAttempt(
  db: Firestore,
  teamId: string,
  leaseId: string,
  outcome: "sent" | "failed",
  safeCategory?: string,
): Promise<"pending" | "sent" | "failed"> {
  const teamReference = db.collection("teams").doc(teamId);
  return db.runTransaction(async (transaction) => {
    const teamSnapshot = await transaction.get(teamReference);
    if (!teamSnapshot.exists || teamSnapshot.get("registrationEmailLeaseId") !== leaseId) {
      return "pending";
    }
    const registrationRequestId: unknown = teamSnapshot.get(
      "registrationRequestId",
    );
    if (typeof registrationRequestId !== "string") {
      throw new AppError("internal", "Registration email state is incomplete.", "internal");
    }
    const requestReference = db
      .collection("registrationRequests")
      .doc(registrationRequestId);
    const requestSnapshot = await transaction.get(requestReference);
    if (!requestSnapshot.exists) {
      throw new AppError("internal", "Registration request state is missing.", "internal");
    }

    const existingCount: unknown = teamSnapshot.get("registrationEmailRetryCount");
    const retryCount =
      outcome === "sent"
        ? 0
        : (typeof existingCount === "number" ? existingCount : 0) + 1;
    const status =
      outcome === "sent"
        ? "sent"
        : isRetryableSafeCategory(safeCategory ?? "") &&
            retryCount < MAX_RECONCILIATION_ATTEMPTS
          ? "pending"
          : "failed";
    const categoryValue =
      outcome === "sent" ? FieldValue.delete() : (safeCategory ?? "internal");
    transaction.update(teamReference, {
      registrationEmailStatus: status,
      registrationEmailLastAttemptAt: FieldValue.serverTimestamp(),
      registrationEmailRetryCount: retryCount,
      registrationEmailSafeErrorCategory: categoryValue,
      registrationEmailLeaseId: null,
      registrationEmailLeaseExpiresAt: null,
    });
    transaction.update(requestReference, {
      state: status === "sent" ? "active" : "email_pending",
      emailStatus: status,
      safeErrorCategory: categoryValue,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return status;
  });
}

export async function makeRegistrationEmailRetryIneligible(
  db: Firestore,
  ownerUid: string,
  now = Date.now(),
): Promise<TeamDocument> {
  const ownerReference = db.collection("teamOwners").doc(ownerUid);
  return db.runTransaction(async (transaction) => {
    const ownerSnapshot = await transaction.get(ownerReference);
    const teamId: unknown = ownerSnapshot.get("teamId");
    if (typeof teamId !== "string") {
      throw new AppError("not-found", "No team is associated with this account.", "authorization");
    }
    const teamReference = db.collection("teams").doc(teamId);
    const teamSnapshot = await transaction.get(teamReference);
    if (!teamSnapshot.exists || teamSnapshot.get("ownerUid") !== ownerUid) {
      throw new AppError("permission-denied", "Team access was denied.", "authorization");
    }
    const leaseExpiresAt: unknown = teamSnapshot.get(
      "registrationEmailLeaseExpiresAt",
    );
    if (leaseExpiresAt instanceof Timestamp && leaseExpiresAt.toMillis() > now) {
      throw new AppError(
        "aborted",
        "Registration email delivery is still completing. Retry shortly.",
        "conflict",
      );
    }
    const registrationRequestId: unknown = teamSnapshot.get(
      "registrationRequestId",
    );
    if (typeof registrationRequestId !== "string") {
      throw new AppError("internal", "Registration state is incomplete.", "internal");
    }
    const requestReference = db
      .collection("registrationRequests")
      .doc(registrationRequestId);
    const requestSnapshot = await transaction.get(requestReference);
    transaction.update(teamReference, {
      registrationEmailRetryIneligible: true,
      registrationEmailStatus: "sent",
      registrationEmailLeaseId: null,
      registrationEmailLeaseExpiresAt: null,
      registrationEmailSafeErrorCategory: FieldValue.delete(),
    });
    // Registration requests are retained in production for durable replay,
    // but a participant must not be locked out if an operator or legacy TTL
    // has removed the saga record.
    if (requestSnapshot.exists) {
      transaction.update(requestReference, {
        state: "active",
        emailStatus: "sent",
        safeErrorCategory: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return asTeamDocument(teamSnapshot.data() ?? {});
  });
}

export async function getTeamById(
  db: Firestore,
  teamId: string,
): Promise<TeamDocument> {
  const snapshot = await db.collection("teams").doc(teamId).get();
  if (!snapshot.exists) {
    throw new AppError("not-found", "The team no longer exists.", "internal");
  }
  return asTeamDocument(snapshot.data() ?? {});
}
