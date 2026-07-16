import {
  FieldValue,
  type Firestore,
} from "firebase-admin/firestore";
import { AppError } from "./errors.js";
import type { RegistrationReservation } from "./idempotency.js";

export interface AllocatedTeamIdentity {
  teamId: string;
  teamNumber: number;
}

export function formatTeamId(teamNumber: number): string {
  if (!Number.isSafeInteger(teamNumber) || teamNumber < 1) {
    throw new RangeError("Team number must be a positive safe integer.");
  }
  return `RoCo-${teamNumber}`;
}

export async function allocateTeamIdentity(
  db: Firestore,
  reservation: RegistrationReservation,
): Promise<AllocatedTeamIdentity> {
  const counterReference = db.collection("systemCounters").doc("teamRegistration");

  const identity = await db.runTransaction(async (transaction) => {
    const [requestSnapshot, counterSnapshot] = await Promise.all([
      transaction.get(reservation.reference),
      transaction.get(counterReference),
    ]);
    if (
      !requestSnapshot.exists ||
      requestSnapshot.get("leaseId") !== reservation.leaseId
    ) {
      throw new AppError(
        "aborted",
        "Registration processing was superseded. Please retry.",
        "conflict",
      );
    }

    const existingNumber: unknown = requestSnapshot.get("teamNumber");
    if (typeof existingNumber === "number") {
      return { teamNumber: existingNumber, teamId: formatTeamId(existingNumber) };
    }

    const lastAllocated: unknown = counterSnapshot.get("lastAllocatedTeamNumber");
    const current = typeof lastAllocated === "number" ? lastAllocated : 0;
    const teamNumber = current + 1;
    if (!Number.isSafeInteger(teamNumber)) {
      throw new AppError(
        "internal",
        "A team ID could not be allocated.",
        "internal",
      );
    }
    const teamId = formatTeamId(teamNumber);
    transaction.set(
      counterReference,
      {
        lastAllocatedTeamNumber: teamNumber,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.update(reservation.reference, {
      teamId,
      teamNumber,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { teamId, teamNumber };
  });

  reservation.teamId = identity.teamId;
  reservation.teamNumber = identity.teamNumber;
  return identity;
}
