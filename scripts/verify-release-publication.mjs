#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const GITHUB_API_ORIGIN = "https://api.github.com";
const SITE_ORIGIN = "https://roco-spring.github.io";
const REPOSITORY_PATH = "roco-spring/roco-spring.github.io";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ATTEMPTS = 40;
const DEFAULT_POLL_DELAY_MS = 15_000;
const EXPECTED_CHECKS = Object.freeze(["verify", "deploy"]);
const PUBLISHED_FILES = Object.freeze([
    "index.html",
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

class ReleasePublicationError extends Error {
    constructor(stage, terminal = false) {
        super("Release publication verification failed.");
        this.name = "ReleasePublicationError";
        this.stage = stage;
        this.terminal = terminal;
    }
}

function isCommitSha(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function exactReleaseCommit(execImplementation = execFileSync) {
    let head;
    let originMain;
    try {
        const options = {
            cwd: ROOT,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"]
        };
        head = execImplementation("git", ["rev-parse", "HEAD"], options).trim();
        originMain = execImplementation("git", ["rev-parse", "origin/main"], options).trim();
    } catch {
        throw new ReleasePublicationError("git_source", true);
    }
    if (!isCommitSha(head) || head !== originMain) {
        throw new ReleasePublicationError("git_source", true);
    }
    return head;
}

async function boundedResponseBytes(response, stage) {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new ReleasePublicationError(stage, true);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
        throw new ReleasePublicationError(stage);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                throw new ReleasePublicationError(stage, true);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
}

async function boundedFetch(
    fetchImplementation,
    stage,
    url,
    { expectedOrigin, headers = {} }
) {
    let target;
    try {
        target = new URL(url);
    } catch {
        throw new ReleasePublicationError(stage, true);
    }
    if (target.origin !== expectedOrigin || target.username || target.password || target.hash) {
        throw new ReleasePublicationError(stage, true);
    }

    let response;
    try {
        response = await fetchImplementation(target, {
            method: "GET",
            headers,
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch {
        throw new ReleasePublicationError(stage);
    }
    if (!response.ok || new URL(response.url || target).origin !== expectedOrigin) {
        throw new ReleasePublicationError(stage);
    }
    return response;
}

async function fetchCheckRuns(fetchImplementation, commit) {
    if (!isCommitSha(commit)) throw new ReleasePublicationError("github_commit", true);
    const url = new URL(
        `/repos/${REPOSITORY_PATH}/commits/${commit}/check-runs`,
        GITHUB_API_ORIGIN
    );
    url.searchParams.set("per_page", "100");
    const response = await boundedFetch(fetchImplementation, "github_checks", url, {
        expectedOrigin: GITHUB_API_ORIGIN,
        headers: {
            accept: "application/vnd.github+json",
            "user-agent": "roco-spring-release-verifier",
            "x-github-api-version": "2022-11-28"
        }
    });
    const bytes = await boundedResponseBytes(response, "github_checks");
    try {
        return JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new ReleasePublicationError("github_checks");
    }
}

function classifyCheckRuns(payload, commit) {
    if (!isCommitSha(commit) || !Array.isArray(payload?.check_runs)) {
        throw new ReleasePublicationError("github_checks", true);
    }
    const matching = payload.check_runs.filter((check) => (
        check?.head_sha === commit
        && check?.app?.slug === "github-actions"
        && EXPECTED_CHECKS.includes(check?.name)
    ));
    const selected = new Map();
    for (const name of EXPECTED_CHECKS) {
        const candidates = matching.filter((check) => check.name === name);
        candidates.sort((left, right) => (
            Date.parse(right.started_at ?? right.created_at ?? "")
            - Date.parse(left.started_at ?? left.created_at ?? "")
        ));
        if (candidates[0]) selected.set(name, candidates[0]);
    }
    if (selected.size !== EXPECTED_CHECKS.length) return "pending";

    for (const check of selected.values()) {
        if (check.status !== "completed") return "pending";
        if (check.conclusion !== "success") {
            throw new ReleasePublicationError("github_check_failed", true);
        }
    }
    return "success";
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function readCommittedFile(
    commit,
    relativePath,
    execImplementation = execFileSync
) {
    if (!isCommitSha(commit) || !PUBLISHED_FILES.includes(relativePath)) {
        throw new ReleasePublicationError("committed_content", true);
    }
    try {
        const bytes = execImplementation(
            "git",
            ["show", `${commit}:${relativePath}`],
            {
                cwd: ROOT,
                encoding: null,
                maxBuffer: MAX_RESPONSE_BYTES,
                stdio: ["ignore", "pipe", "pipe"]
            }
        );
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RESPONSE_BYTES) {
            throw new ReleasePublicationError("committed_content", true);
        }
        return Buffer.from(bytes);
    } catch (error) {
        if (error instanceof ReleasePublicationError) throw error;
        throw new ReleasePublicationError("committed_content", true);
    }
}

async function verifyPublishedFiles({
    commit,
    fetchImplementation = fetch,
    readCommittedFileImplementation = readCommittedFile
}) {
    if (!isCommitSha(commit)) throw new ReleasePublicationError("public_commit", true);
    const comparisons = await Promise.all(PUBLISHED_FILES.map(async (relativePath) => {
        const committed = await readCommittedFileImplementation(commit, relativePath);
        const url = new URL(relativePath, `${SITE_ORIGIN}/`);
        url.searchParams.set("release", commit);
        const response = await boundedFetch(fetchImplementation, "public_site", url, {
            expectedOrigin: SITE_ORIGIN,
            headers: { "user-agent": "roco-spring-release-verifier" }
        });
        const remote = await boundedResponseBytes(response, "public_site");
        return sha256(committed) === sha256(remote);
    }));
    if (comparisons.some((matches) => !matches)) {
        throw new ReleasePublicationError("public_content");
    }
    return PUBLISHED_FILES.length;
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyReleasePublication({
    commit,
    fetchImplementation = fetch,
    readCommittedFileImplementation = readCommittedFile,
    sleepImplementation = sleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    pollDelayMs = DEFAULT_POLL_DELAY_MS
} = {}) {
    if (!isCommitSha(commit)) throw new ReleasePublicationError("github_commit", true);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 60 ||
        !Number.isFinite(pollDelayMs) || pollDelayMs < 0 || pollDelayMs > 60_000) {
        throw new ReleasePublicationError("arguments", true);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const checks = classifyCheckRuns(
                await fetchCheckRuns(fetchImplementation, commit),
                commit
            );
            if (checks === "success") {
                const files = await verifyPublishedFiles({
                    commit,
                    fetchImplementation,
                    readCommittedFileImplementation
                });
                return Object.freeze({ commit, attempts: attempt, files });
            }
        } catch (error) {
            if (error instanceof ReleasePublicationError && error.terminal) throw error;
        }
        if (attempt < maxAttempts) await sleepImplementation(pollDelayMs);
    }
    throw new ReleasePublicationError("publication_timeout", true);
}

async function main() {
    try {
        const commit = exactReleaseCommit();
        const result = await verifyReleasePublication({ commit });
        process.stdout.write(
            `Release publication verified: GitHub CI and Pages succeeded for ${result.commit}; ${result.files} critical public files match byte-for-byte after ${result.attempts} check(s).\n`
        );
    } catch (error) {
        const stage = error instanceof ReleasePublicationError ? error.stage : "unexpected";
        process.stderr.write(`Release publication verification failed [stage=${stage}].\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();

export {
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_POLL_DELAY_MS,
    EXPECTED_CHECKS,
    PUBLISHED_FILES,
    ReleasePublicationError,
    classifyCheckRuns,
    exactReleaseCommit,
    fetchCheckRuns,
    readCommittedFile,
    verifyPublishedFiles,
    verifyReleasePublication
};
