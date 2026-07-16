#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");

function runGit(argumentsList, execImplementation = execFileSync) {
    return execImplementation("git", argumentsList, {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
    }).trim();
}

function verifyReleaseSource(execImplementation = execFileSync) {
    let status;
    let commit;

    try {
        status = runGit(["status", "--porcelain=v1", "--untracked-files=all"], execImplementation);
        commit = runGit(["rev-parse", "HEAD"], execImplementation);
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

    return commit;
}

function main() {
    try {
        const commit = verifyReleaseSource();
        process.stdout.write(`Release source verified: clean committed tree at ${commit}.\n`);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Release source verification failed.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) main();

export { verifyReleaseSource };
