import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
    assertRecoverableSnapshot,
    hardenEnvironment,
    parseArguments,
    requeueSheetReconciliation
} from "../scripts/requeue-sheet-reconciliation.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const INCIDENT_UPDATE_TIME = "2026-08-31T16:21:15.323Z";
const INCIDENT_LAST_ATTEMPT = "2026-08-31T16:21:15.303Z";

function timestamp(iso) {
    return {
        isEqual: (other) => other?.toDate?.().toISOString() === iso,
        toDate: () => new Date(iso)
    };
}

function snapshot(overrides = {}) {
    const fields = {
        teamId: "RoCo-10",
        status: "active",
        registrationEmailStatus: "sent",
        sheetSyncStatus: "failed",
        sheetSyncSafeErrorCategory: "external_permanent",
        sheetSyncRetryCount: 2,
        sheetSyncLastAttemptAt: timestamp(INCIDENT_LAST_ATTEMPT),
        revision: 1,
        sheetLastSyncedRevision: 1,
        sheetId: "private-sheet-id",
        registrationRequestId: "private-request-id",
        sheetSyncLeaseId: null,
        sheetSyncLeaseExpiresAt: null,
        ...overrides
    };
    return {
        exists: true,
        id: "RoCo-10",
        updateTime: timestamp(INCIDENT_UPDATE_TIME),
        get: (field) => fields[field]
    };
}

function database({
    observed = snapshot(),
    confirmed = snapshot({
        sheetSyncStatus: "pending",
        sheetSyncSafeErrorCategory: "google_transient"
    }),
    transactionError = null
} = {}) {
    const updates = [];
    let reads = 0;
    const reference = {
        get: async () => {
            reads += 1;
            return reads === 1 ? observed : confirmed;
        }
    };
    return {
        updates,
        readCount: () => reads,
        collection: () => ({ doc: () => reference }),
        runTransaction: async (operation) => {
            if (transactionError) throw transactionError;
            await operation({
                get: async () => observed,
                update: (target, update) => {
                    assert.equal(target, reference);
                    updates.push(update);
                }
            });
        }
    };
}

test("Sheet recovery CLI is one-team, incident-bound, and dry-run by default", () => {
    assert.deepEqual(parseArguments(["--team", "RoCo-10"]), {
        teamId: "RoCo-10",
        apply: false
    });
    assert.deepEqual(parseArguments(["--apply", "--team", "RoCo-28"]), {
        teamId: "RoCo-28",
        apply: true
    });
    for (const invalid of [
        [],
        ["--team", "RoCo-1"],
        ["--team", "RoCo-10", "--team", "RoCo-14"],
        ["--team", "RoCo-10", "--all"]
    ]) {
        assert.throws(() => parseArguments(invalid));
    }
});

test("Sheet recovery refuses emulator/project redirection and scrubs debug flags", () => {
    assert.doesNotThrow(() => hardenEnvironment({}));
    assert.doesNotThrow(() =>
        hardenEnvironment({ GCLOUD_PROJECT: "roco-spring-registration-2026" })
    );
    const debugEnvironment = {
        FIREBASE_DEBUG: "1",
        NODE_DEBUG: "http",
        DEBUG: "*"
    };
    hardenEnvironment(debugEnvironment);
    assert.deepEqual(debugEnvironment, {});
    for (const environment of [
        { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
        { GCLOUD_PROJECT: "wrong-project" },
        { GOOGLE_CLOUD_PROJECT: "wrong-project" }
    ]) {
        assert.throws(() => hardenEnvironment(environment));
    }
});

test("Sheet recovery preflight rejects changed incident or durable state", () => {
    assert.doesNotThrow(() => assertRecoverableSnapshot(snapshot(), "RoCo-10"));
    const changedUpdateTime = snapshot();
    changedUpdateTime.updateTime = timestamp("2026-08-31T16:21:15.324Z");
    const changedLastAttempt = snapshot({
        sheetSyncLastAttemptAt: timestamp("2026-08-31T16:21:15.304Z")
    });
    for (const candidate of [
        changedUpdateTime,
        changedLastAttempt,
        snapshot({ status: "inactive" }),
        snapshot({ registrationEmailStatus: "pending" }),
        snapshot({ sheetSyncStatus: "pending" }),
        snapshot({ sheetSyncSafeErrorCategory: "google_transient" }),
        snapshot({ sheetSyncRetryCount: 3 }),
        snapshot({ revision: 2 }),
        snapshot({ sheetId: "" }),
        snapshot({ registrationRequestId: "" }),
        snapshot({ sheetSyncLeaseId: undefined }),
        snapshot({ sheetSyncLeaseId: "active-lease" }),
        snapshot({ sheetSyncLeaseExpiresAt: {} })
    ]) {
        assert.throws(() => assertRecoverableSnapshot(candidate, "RoCo-10"));
    }
    assert.throws(() => assertRecoverableSnapshot(snapshot(), "RoCo-14"));
});

test("Sheet recovery dry-run performs no transaction or write", async () => {
    const db = database();
    await assert.doesNotReject(async () => {
        assert.deepEqual(
            await requeueSheetReconciliation({ db, teamId: "RoCo-10", apply: false }),
            { outcome: "dry_run", state: "failed" }
        );
    });
    assert.equal(db.readCount(), 1);
    assert.deepEqual(db.updates, []);
});

test("Sheet recovery changes only the misclassified durable state", async () => {
    const db = database();
    assert.deepEqual(
        await requeueSheetReconciliation({ db, teamId: "RoCo-10", apply: true }),
        { outcome: "applied", state: "pending" }
    );
    assert.deepEqual(db.updates, [{
        sheetSyncStatus: "pending",
        sheetSyncSafeErrorCategory: "google_transient"
    }]);
});

test("Sheet recovery accepts immediate Scheduler claim and completion", async () => {
    const claimed = database({
        confirmed: snapshot({
            sheetSyncStatus: "pending",
            sheetSyncSafeErrorCategory: "google_transient",
            sheetSyncLeaseId: "scheduler-lease",
            sheetSyncLeaseExpiresAt: timestamp("2026-08-31T18:00:00.000Z")
        })
    });
    assert.deepEqual(
        await requeueSheetReconciliation({
            db: claimed,
            teamId: "RoCo-10",
            apply: true
        }),
        { outcome: "applied", state: "claimed" }
    );

    const synced = database({
        confirmed: snapshot({
            sheetSyncStatus: "synced",
            sheetSyncSafeErrorCategory: undefined,
            sheetSyncRetryCount: 0
        })
    });
    assert.deepEqual(
        await requeueSheetReconciliation({
            db: synced,
            teamId: "RoCo-10",
            apply: true
        }),
        { outcome: "applied", state: "synced" }
    );
});

test("Sheet recovery rejects transaction failure and unhealthy forward state", async () => {
    const transactionError = new Error("simulated transaction failure");
    await assert.rejects(
        requeueSheetReconciliation({
            db: database({ transactionError }),
            teamId: "RoCo-10",
            apply: true
        }),
        transactionError
    );
    await assert.rejects(
        requeueSheetReconciliation({
            db: database({
                confirmed: snapshot({
                    sheetSyncStatus: "failed",
                    sheetSyncSafeErrorCategory: "external_permanent"
                })
            }),
            teamId: "RoCo-10",
            apply: true
        }),
        /requeue committed/u
    );
});

test("Sheet recovery wiring exposes only the guarded one-record command", async () => {
    const packageConfig = JSON.parse(await readFile(
        path.join(ROOT, "package.json"),
        "utf8"
    ));
    const script = await readFile(
        path.join(ROOT, "scripts/requeue-sheet-reconciliation.mjs"),
        "utf8"
    );

    assert.equal(
        packageConfig.scripts["registration:requeue-sheet"],
        "node scripts/requeue-sheet-reconciliation.mjs"
    );
    assert.match(script, /sheetSyncStatus: "pending"/u);
    assert.match(script, /sheetSyncSafeErrorCategory: "google_transient"/u);
    assert.doesNotMatch(script, /sheetSyncRetryCount:\s*0/u);
    assert.doesNotMatch(script, /\.collection\("teams"\)\.(?:get|listDocuments)\(/u);
    assert.doesNotMatch(script, /transaction\.(?:delete|set)\(/u);
});
