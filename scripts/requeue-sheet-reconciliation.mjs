#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "roco-spring-registration-2026";
const VERIFIED_INCIDENTS = new Map([
    ["RoCo-10", {
        updateTime: "2026-08-31T16:21:15.323Z",
        lastAttemptAt: "2026-08-31T16:21:15.303Z",
        retryCount: 2
    }],
    ["RoCo-14", {
        updateTime: "2026-08-30T16:36:14.668Z",
        lastAttemptAt: "2026-08-30T16:36:14.653Z",
        retryCount: 1
    }],
    ["RoCo-20", {
        updateTime: "2026-08-13T14:01:14.941Z",
        lastAttemptAt: "2026-08-13T14:01:14.918Z",
        retryCount: 1
    }],
    ["RoCo-28", {
        updateTime: "2026-08-18T10:46:14.437Z",
        lastAttemptAt: "2026-08-18T10:46:14.422Z",
        retryCount: 1
    }]
]);

class RecoveryError extends Error {}
class RecoveryCommittedError extends RecoveryError {}

function fail(message) {
    throw new RecoveryError(message);
}

function failAfterCommit(message) {
    throw new RecoveryCommittedError(message);
}

function timestampIso(value, field) {
    if (!value || typeof value.toDate !== "function") {
        fail(`The ${field} incident timestamp is missing.`);
    }
    const date = value.toDate();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
        fail(`The ${field} incident timestamp is invalid.`);
    }
    return date.toISOString();
}

export function hardenEnvironment(environment) {
    if (
        typeof environment.FIRESTORE_EMULATOR_HOST === "string" &&
        environment.FIRESTORE_EMULATOR_HOST.length > 0
    ) {
        fail("Refusing recovery while FIRESTORE_EMULATOR_HOST is set.");
    }
    // Remove debug switches before Firebase Admin is dynamically imported, so
    // provider request context cannot be emitted by inherited shell settings.
    for (const key of ["FIREBASE_DEBUG", "NODE_DEBUG", "DEBUG"]) {
        delete environment[key];
    }
    for (const key of ["GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
        const value = environment[key];
        if (typeof value === "string" && value.length > 0 && value !== PROJECT_ID) {
            fail(`Refusing recovery for a conflicting ${key}.`);
        }
    }
}

export function parseArguments(argv) {
    let teamId = "";
    let apply = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--apply") {
            if (apply) fail("The --apply flag was provided more than once.");
            apply = true;
            continue;
        }
        if (argument === "--team") {
            if (teamId) fail("The --team option was provided more than once.");
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) {
                fail("The --team option requires one team ID.");
            }
            teamId = value;
            index += 1;
            continue;
        }
        fail("Unsupported argument. Use --team <incident-id> [--apply].");
    }
    if (!VERIFIED_INCIDENTS.has(teamId)) {
        fail("The team is not in the exact verified incident inventory.");
    }
    return { teamId, apply };
}

export function assertRecoverableSnapshot(snapshot, teamId) {
    const incident = VERIFIED_INCIDENTS.get(teamId);
    if (!incident) fail("The team is not in the exact verified incident inventory.");
    if (!snapshot.exists || snapshot.id !== teamId) {
        fail("The exact incident-bound team record does not exist.");
    }
    if (snapshot.get("teamId") !== teamId) {
        fail("The stored team identifier does not match the document.");
    }
    if (timestampIso(snapshot.updateTime, "document update") !== incident.updateTime) {
        fail("The team changed after the incident audit; no update was applied.");
    }
    if (snapshot.get("status") !== "active") {
        fail("The team is not active.");
    }
    if (snapshot.get("registrationEmailStatus") !== "sent") {
        fail("The registration email is not in the expected sent state.");
    }
    if (snapshot.get("sheetSyncStatus") !== "failed") {
        fail("The Sheet synchronization is no longer in failed state.");
    }
    if (snapshot.get("sheetSyncSafeErrorCategory") !== "external_permanent") {
        fail("The failure category no longer matches the diagnosed timeout incident.");
    }
    if (snapshot.get("sheetSyncRetryCount") !== incident.retryCount) {
        fail("The retry count no longer matches the diagnosed timeout incident.");
    }
    if (
        timestampIso(snapshot.get("sheetSyncLastAttemptAt"), "last attempt") !==
        incident.lastAttemptAt
    ) {
        fail("The last attempt no longer matches the diagnosed timeout incident.");
    }
    const revision = snapshot.get("revision");
    if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        snapshot.get("sheetLastSyncedRevision") !== revision
    ) {
        fail("The authoritative and last-synchronized revisions do not match.");
    }
    for (const field of ["sheetId", "registrationRequestId"]) {
        const value = snapshot.get(field);
        if (typeof value !== "string" || value.length === 0) {
            fail(`The required ${field} binding is missing.`);
        }
    }
    if (
        snapshot.get("sheetSyncLeaseId") !== null ||
        snapshot.get("sheetSyncLeaseExpiresAt") !== null
    ) {
        fail("A Sheet synchronization lease is active or incompletely released.");
    }
}

function assertForwardProgressSnapshot(snapshot, teamId) {
    if (!snapshot.exists || snapshot.id !== teamId || snapshot.get("teamId") !== teamId) {
        failAfterCommit("The requeue committed, but its team record is no longer readable.");
    }
    const revision = snapshot.get("revision");
    if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        snapshot.get("sheetLastSyncedRevision") !== revision
    ) {
        failAfterCommit("The requeue committed, but the team revision changed unexpectedly.");
    }
    const status = snapshot.get("sheetSyncStatus");
    if (status === "synced") {
        if (
            snapshot.get("sheetSyncRetryCount") !== 0 ||
            snapshot.get("sheetSyncSafeErrorCategory") !== undefined ||
            snapshot.get("sheetSyncLeaseId") !== null ||
            snapshot.get("sheetSyncLeaseExpiresAt") !== null
        ) {
            failAfterCommit("The reconciler reported an inconsistent synchronized state.");
        }
        return "synced";
    }
    if (status !== "pending") {
        failAfterCommit("The requeue committed, but reconciliation reached a failed state.");
    }
    if (snapshot.get("sheetSyncSafeErrorCategory") !== "google_transient") {
        failAfterCommit("The pending reconciliation has an unexpected safe category.");
    }
    const leaseId = snapshot.get("sheetSyncLeaseId");
    const leaseExpiresAt = snapshot.get("sheetSyncLeaseExpiresAt");
    if (leaseId === null && leaseExpiresAt === null) return "pending";
    if (
        typeof leaseId === "string" &&
        leaseId.length > 0 &&
        leaseExpiresAt &&
        typeof leaseExpiresAt.toDate === "function"
    ) {
        return "claimed";
    }
    failAfterCommit("The pending reconciliation has an inconsistent lease.");
}

export async function requeueSheetReconciliation({ db, teamId, apply }) {
    const reference = db.collection("teams").doc(teamId);
    const observed = await reference.get();
    assertRecoverableSnapshot(observed, teamId);
    if (!apply) return { outcome: "dry_run", state: "failed" };

    await db.runTransaction(async (transaction) => {
        const current = await transaction.get(reference);
        assertRecoverableSnapshot(current, teamId);
        if (!current.updateTime?.isEqual(observed.updateTime)) {
            fail("The team changed after this command's preflight; no update was applied.");
        }
        // Preserve the original attempt timestamp and retry count as incident
        // history. Only correct the state and category proven to be wrong.
        transaction.update(reference, {
            sheetSyncStatus: "pending",
            sheetSyncSafeErrorCategory: "google_transient"
        });
    });

    let confirmed;
    try {
        confirmed = await reference.get();
    } catch {
        failAfterCommit("The requeue committed, but its read-back was unavailable.");
    }
    return {
        outcome: "applied",
        state: assertForwardProgressSnapshot(confirmed, teamId)
    };
}

async function main() {
    hardenEnvironment(process.env);
    const { teamId, apply } = parseArguments(process.argv.slice(2));
    const [appModule, firestoreModule] = await Promise.all([
        import("firebase-admin/app"),
        import("firebase-admin/firestore")
    ]);
    const app = appModule.initializeApp(
        { credential: appModule.applicationDefault(), projectId: PROJECT_ID },
        `roco-sheet-recovery-${randomUUID()}`
    );
    let result;
    try {
        result = await requeueSheetReconciliation({
            db: firestoreModule.getFirestore(app),
            teamId,
            apply
        });
    } finally {
        try {
            await appModule.deleteApp(app);
        } catch {
            // The one-shot operator process exits immediately. A local client
            // cleanup warning does not negate an already verified cloud write.
            console.error("RECOVERY_CLEANUP_WARNING local_admin_client_cleanup_failed");
        }
    }
    const prefix = result.outcome === "dry_run" ? "DRY_RUN_OK" : "APPLY_OK";
    console.log(`${prefix} teamId=${teamId} state=${result.state} action=requeue_sheet_sync`);
}

const isDirectExecution = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
    main().catch((error) => {
        // Never print provider responses or participant records from this trusted
        // operator tool; bounded local messages are sufficient for recovery.
        const prefix = error instanceof RecoveryCommittedError
            ? "RECOVERY_COMMITTED_BUT_UNHEALTHY"
            : "RECOVERY_FAILED";
        const message = error instanceof RecoveryError
            ? error.message
            : "The Admin operation outcome is unavailable; inspect exact safe state before retrying.";
        console.error(`${prefix} ${message}`);
        process.exitCode = 1;
    });
}
