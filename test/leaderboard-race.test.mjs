import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function snapshot(label) {
    return { updatedAt: "2026-08-29T18:00:00.000Z", sourceLabel: label, teams: [] };
}

test("live source waits for static fallback and stale refreshes cannot overwrite newer data", async () => {
    const source = await readFile(path.join(ROOT, "assets/leaderboard.js"), "utf8");
    const staticResponse = deferred();
    const sandbox = {
        console: { warn() {} },
        document: {
            currentScript: { src: "https://roco-spring.github.io/assets/leaderboard.js" },
            querySelectorAll() { return []; },
        },
        fetch() { return staticResponse.promise; },
        Intl,
        location: { href: "https://roco-spring.github.io/evaluation.html" },
        URL,
        window: {},
    };
    vm.runInNewContext(source, sandbox, { filename: "leaderboard.js" });

    let liveCalls = 0;
    const install = sandbox.window.RoCoLeaderboard.setDataSource(() => {
        liveCalls += 1;
        return Promise.resolve(snapshot("live-initial"));
    });
    assert.equal(liveCalls, 0, "live loading must wait until fallback loading settles");
    staticResponse.resolve({
        ok: true,
        json: () => Promise.resolve(snapshot("static")),
    });
    await install;
    assert.equal(liveCalls, 1);
    assert.equal(sandbox.window.RoCoLeaderboard.getSnapshot().sourceLabel, "live-initial");

    const older = deferred();
    const newer = deferred();
    let refreshCalls = 0;
    await sandbox.window.RoCoLeaderboard.setDataSource(() => {
        refreshCalls += 1;
        return Promise.resolve(snapshot("generation-base"));
    });
    const olderRefresh = sandbox.window.RoCoLeaderboard.setDataSource(() => {
        refreshCalls += 1;
        return refreshCalls === 2 ? older.promise : newer.promise;
    });
    await Promise.resolve();
    const newestRefresh = sandbox.window.RoCoLeaderboard.refresh();
    newer.resolve(snapshot("newer"));
    await newestRefresh;
    older.resolve(snapshot("older"));
    await olderRefresh;
    assert.equal(sandbox.window.RoCoLeaderboard.getSnapshot().sourceLabel, "newer");
});
