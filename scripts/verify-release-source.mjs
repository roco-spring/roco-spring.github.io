#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXPECTED_BRANCH = "main";
const EXPECTED_UPSTREAM = "origin/main";
const EXPECTED_ORIGIN_URLS = new Set([
    "git@github.com:roco-spring/roco-spring.github.io.git",
    "https://github.com/roco-spring/roco-spring.github.io.git",
    "https://github.com/roco-spring/roco-spring.github.io"
]);

function runGit(argumentsList, execImplementation = execFileSync) {
    return execImplementation("git", argumentsList, {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
    }).trim();
}

function parseReleaseSourceMode(argumentsList) {
    if (argumentsList.length === 0) return Object.freeze({ allowLocalAhead: false });
    if (argumentsList.length === 1 && argumentsList[0] === "--allow-local-ahead") {
        return Object.freeze({ allowLocalAhead: true });
    }
    throw new Error("Release source verification received invalid arguments.");
}

function verifyReleaseSource(
    execImplementation = execFileSync,
    { allowLocalAhead = false } = {}
) {
    let status;
    let commit;
    let branch;
    let upstream;
    let originUrl;
    let originCommit;

    try {
        status = runGit(["status", "--porcelain=v1", "--untracked-files=all"], execImplementation);
        commit = runGit(["rev-parse", "HEAD"], execImplementation);
        branch = runGit(["symbolic-ref", "--short", "HEAD"], execImplementation);
        upstream = runGit([
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}"
        ], execImplementation);
        originUrl = runGit(["remote", "get-url", "origin"], execImplementation);
        originCommit = runGit(["rev-parse", EXPECTED_UPSTREAM], execImplementation);
    } catch {
        throw new Error("Release source verification requires an accessible Git checkout.");
    }

    if (status !== "") {
        throw new Error(
            "Production deployment requires a clean committed working tree. Commit the reviewed release first."
        );
    }
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
        throw new Error("Release source verification could not resolve an exact commit SHA.");
    }
    if (branch !== EXPECTED_BRANCH) {
        throw new Error("Production deployment requires the checked-out branch to be main.");
    }
    if (upstream !== EXPECTED_UPSTREAM) {
        throw new Error("Production deployment requires main to track origin/main.");
    }
    if (!EXPECTED_ORIGIN_URLS.has(originUrl)) {
        throw new Error("Production deployment requires the reviewed RoCo-Spring GitHub origin.");
    }
    if (!/^[0-9a-f]{40}$/u.test(originCommit)) {
        throw new Error("Production deployment could not resolve the fetched origin/main commit.");
    }
    try {
        runGit(["merge-base", "--is-ancestor", EXPECTED_UPSTREAM, "HEAD"], execImplementation);
    } catch {
        throw new Error(
            "Production deployment requires fetched origin/main to be an ancestor of HEAD; the release is stale or diverged."
        );
    }
    if (!allowLocalAhead && commit !== originCommit) {
        throw new Error(
            "Production deployment requires HEAD to equal freshly fetched origin/main; publish the release before mutating cloud state."
        );
    }

    return commit;
}

function main() {
    try {
        const mode = parseReleaseSourceMode(process.argv.slice(2));
        const commit = verifyReleaseSource(execFileSync, mode);
        process.stdout.write(
            mode.allowLocalAhead
                ? `Release source verified: clean main commit ${commit} is fast-forward safe to publish to fetched origin/main.\n`
                : `Release source verified: clean main commit ${commit} exactly matches freshly fetched origin/main.\n`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Release source verification failed.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();

export { parseReleaseSourceMode, verifyReleaseSource };
