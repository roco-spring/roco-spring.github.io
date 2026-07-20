import type { Timestamp } from "firebase-admin/firestore";
import type { TrackId } from "./config.js";

export interface TeamMember {
  fullName: string;
  email: string;
  affiliation: string;
}

export interface EditableTeamData {
  teamName: string;
  tracks: TrackId[];
  members: TeamMember[];
}

export interface RegistrationInput extends EditableTeamData {
  idempotencyKey: string;
  primaryContactEmail: string;
  registrantConfirmed: true;
}

export interface TeamDocument extends EditableTeamData {
  teamId: string;
  teamNumber: number;
  ownerUid: string;
  primaryContactEmail: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  revision: number;
  status: "active";
  // Firestore is the authoritative registration record. Spreadsheet
  // provisioning is an independently reconciled side effect, so a newly
  // committed team may not have a Drive resource yet.
  sheetId: string | null;
  sheetUrl: string | null;
  // These fields are optional for compatibility with teams created before
  // core-first registration was introduced. A legacy team with a sheetId is
  // treated as already provisioned.
  sheetCreateAttemptedAt?: Timestamp | null;
  sheetCreateNoFileObservationCount?: number;
  sheetSyncStatus: "pending" | "synced" | "failed";
  sheetLastSyncedRevision: number;
  sheetSyncLastAttemptAt: Timestamp | null;
  sheetSyncRetryCount: number;
  sheetSyncLeaseId: string | null;
  sheetSyncLeaseExpiresAt: Timestamp | null;
  sheetAuditAt: Timestamp;
  registrationEmailStatus: "pending" | "sent" | "failed";
  registrationEmailLastAttemptAt: Timestamp | null;
  registrationEmailRetryCount: number;
  registrationEmailLeaseId: string | null;
  registrationEmailLeaseExpiresAt: Timestamp | null;
  registrationEmailRetryIneligible: boolean;
  registrationRequestId: string;
}

export interface PublicTeam {
  teamId: string;
  teamName: string;
  primaryContactEmail: string;
  tracks: TrackId[];
  members: TeamMember[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  status: "active";
  sheetSyncStatus: "pending" | "synced" | "failed";
  sheetLastSyncedRevision: number;
}

export interface UpdateTeamInput extends EditableTeamData {
  expectedRevision: number;
}

export type RegistrationState =
  | "allocating"
  | "auth_created"
  | "sheet_created"
  | "team_persisted"
  | "email_pending"
  | "active"
  | "failed";

export interface RegistrationSafeResult {
  teamId: string;
  emailStatus: "sent" | "pending" | "failed";
}
