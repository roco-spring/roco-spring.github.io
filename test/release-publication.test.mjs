import assert from "node:assert/strict";
import test from "node:test";

import {
    EXPECTED_CHECKS,
    PUBLISHED_FILES,
    ReleasePublicationError,
    classifyCheckRuns,
    exactReleaseCommit,
    fetchCheckRuns,
    readCommittedFile,
    verifyPublishedFiles,
    verifyReleasePublication
} from "../scripts/verify-release-publication.mjs";

const COMMIT = "a".repeat(40);
const REQUIRED_PUBLICATION_FILES = Object.freeze([
    "index.html",
    "participate.html",
    "tasks-data.html",
    "team-registration.html",
    "assets/citations.js",
    "assets/firebase-config.js",
    "assets/flow.js",
    "assets/lightbox.js",
    "assets/site-chrome.html",
    "assets/site-layout.js",
    "assets/style.css",
    "assets/team-registration-fallback.js",
    "assets/team-registration.js",
    "assets/team-validation.js",
    "assets/timeline.js"
]);

function checkRun(name, overrides = {}) {
    return {
        name,
        head_sha: COMMIT,
        status: "completed",
        conclusion: "success",
        started_at: "2026-07-20T12:00:00Z",
        app: { slug: "github-actions" },
        ...overrides
    };
}

function successfulChecks() {
    return { check_runs: EXPECTED_CHECKS.map((name) => checkRun(name)) };
}

function jsonResponse(payload, url = "https://api.github.com/test") {
    const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
}

function bytesResponse(bytes, url) {
    const response = new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
    });
    Object.defineProperty(response, "url", { value: url });
    return response;
}

test("check-run classifier requires same-SHA CI and Pages success", () => {
    assert.equal(classifyCheckRuns(successfulChecks(), COMMIT), "success");
    assert.equal(
        classifyCheckRuns({ check_runs: [checkRun("verify")] }, COMMIT),
        "pending"
    );
    assert.equal(
        classifyCheckRuns({
            check_runs: [
                checkRun("verify", { status: "in_progress", conclusion: null }),
                checkRun("deploy")
            ]
        }, COMMIT),
        "pending"
    );
    assert.throws(
        () => classifyCheckRuns({
            check_runs: [
                checkRun("verify", { conclusion: "failure" }),
                checkRun("deploy")
            ]
        }, COMMIT),
        (error) => error instanceof ReleasePublicationError
            && error.stage === "github_check_failed"
            && error.terminal === true
    );
});

test("publication source requires local HEAD to equal origin/main", () => {
    const equalGit = (_command, argumentsList) => (
        argumentsList.at(-1) === "origin/main" ? `${COMMIT}\n` : `${COMMIT}\n`
    );
    assert.equal(exactReleaseCommit(equalGit), COMMIT);
    assert.throws(
        () => exactReleaseCommit((_command, argumentsList) => (
            argumentsList.at(-1) === "origin/main" ? `${"b".repeat(40)}\n` : `${COMMIT}\n`
        )),
        (error) => error instanceof ReleasePublicationError
            && error.stage === "git_source"
    );
});

test("GitHub check transport is exact, bounded, and credential-free", async () => {
    const calls = [];
    const result = await fetchCheckRuns(async (url, options) => {
        calls.push({ url: new URL(url), options });
        return jsonResponse(successfulChecks(), url.href);
    }, COMMIT);
    assert.deepEqual(result, successfulChecks());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, "https://api.github.com");
    assert.match(calls[0].url.pathname, new RegExp(`/commits/${COMMIT}/check-runs$`, "u"));
    assert.equal(calls[0].options.redirect, "error");
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal("authorization" in calls[0].options.headers, false);
});

test("critical public files must match local release bytes exactly", async () => {
    assert.deepEqual(PUBLISHED_FILES, REQUIRED_PUBLICATION_FILES);
    const requested = [];
    const count = await verifyPublishedFiles({
        commit: COMMIT,
        readCommittedFileImplementation: async (commit, relativePath) =>
            Buffer.from(`content:${commit}:${relativePath}`),
        fetchImplementation: async (url) => {
            const parsed = new URL(url);
            requested.push(parsed);
            const relative = decodeURIComponent(parsed.pathname.slice(1));
            return bytesResponse(Buffer.from(`content:${COMMIT}:${relative}`), parsed.href);
        }
    });
    assert.equal(count, PUBLISHED_FILES.length);
    assert.equal(requested.length, PUBLISHED_FILES.length);
    assert.ok(requested.every((url) => (
        url.origin === "https://roco-spring.github.io"
        && url.searchParams.get("release") === COMMIT
    )));
});

test("publication reads immutable blobs from the exact commit, never working-tree files", () => {
    const calls = [];
    const bytes = readCommittedFile(COMMIT, PUBLISHED_FILES[0], (command, args, options) => {
        calls.push({ command, args, options });
        return Buffer.from("committed bytes");
    });
    assert.equal(bytes.toString("utf8"), "committed bytes");
    assert.deepEqual(calls[0].args, ["show", `${COMMIT}:${PUBLISHED_FILES[0]}`]);
    assert.equal(calls[0].options.encoding, null);
    assert.throws(
        () => readCommittedFile(COMMIT, "mutable-working-tree-file.html", () =>
            Buffer.from("working bytes")),
        (error) => error instanceof ReleasePublicationError
            && error.stage === "committed_content"
            && error.terminal === true
    );
});

test("publication polling waits for checks and byte-identical Pages content", async () => {
    let checkCalls = 0;
    const delays = [];
    const result = await verifyReleasePublication({
        commit: COMMIT,
        maxAttempts: 3,
        pollDelayMs: 5,
        sleepImplementation: async (milliseconds) => delays.push(milliseconds),
        readCommittedFileImplementation: async () => Buffer.from("same"),
        fetchImplementation: async (url) => {
            const parsed = new URL(url);
            if (parsed.origin === "https://api.github.com") {
                checkCalls += 1;
                return jsonResponse(
                    checkCalls === 1 ? { check_runs: [] } : successfulChecks(),
                    parsed.href
                );
            }
            return bytesResponse(Buffer.from("same"), parsed.href);
        }
    });
    assert.deepEqual(result, {
        commit: COMMIT,
        attempts: 2,
        files: PUBLISHED_FILES.length
    });
    assert.deepEqual(delays, [5]);
});

test("publication gate fails closed on terminal checks or persistent stale Pages", async () => {
    await assert.rejects(
        verifyReleasePublication({
            commit: COMMIT,
            maxAttempts: 2,
            pollDelayMs: 0,
            sleepImplementation: async () => {},
            fetchImplementation: async (url) => jsonResponse({
                check_runs: [
                    checkRun("verify", { conclusion: "failure" }),
                    checkRun("deploy")
                ]
            }, new URL(url).href)
        }),
        (error) => error instanceof ReleasePublicationError
            && error.stage === "github_check_failed"
    );

    await assert.rejects(
        verifyReleasePublication({
            commit: COMMIT,
            maxAttempts: 2,
            pollDelayMs: 0,
            sleepImplementation: async () => {},
            readCommittedFileImplementation: async () => Buffer.from("new"),
            fetchImplementation: async (url) => {
                const parsed = new URL(url);
                return parsed.origin === "https://api.github.com"
                    ? jsonResponse(successfulChecks(), parsed.href)
                    : bytesResponse(Buffer.from("old"), parsed.href);
            }
        }),
        (error) => error instanceof ReleasePublicationError
            && error.stage === "publication_timeout"
    );
});
