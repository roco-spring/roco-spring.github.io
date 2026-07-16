#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const PROJECT_ID = "roco-spring-registration-2026";
const REQUIRED_SECRETS = Object.freeze([
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
    "RATE_LIMIT_HMAC_SECRET"
]);
const ROOT = path.resolve(import.meta.dirname, "..");
const FIREBASE_SCRIPT = path.join(
    ROOT,
    "node_modules",
    "firebase-tools",
    "lib",
    "bin",
    "firebase.js"
);

function sanitizedEnvironment() {
    const environment = { ...process.env };
    delete environment.DEBUG;
    delete environment.FIREBASE_DEBUG;
    delete environment.NODE_DEBUG;
    delete environment.GOOGLE_OAUTH_CLIENT_SECRET;
    delete environment.GOOGLE_OAUTH_REFRESH_TOKEN;
    delete environment.GOOGLE_OAUTH_ACCESS_TOKEN;
    delete environment.RATE_LIMIT_HMAC_SECRET;
    return environment;
}

function readMetadata(name) {
    const result = spawnSync(
        process.execPath,
        [
            FIREBASE_SCRIPT,
            "functions:secrets:get",
            name,
            "--project",
            PROJECT_ID,
            "--json",
            "--non-interactive"
        ],
        {
            cwd: ROOT,
            encoding: "utf8",
            env: sanitizedEnvironment(),
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"]
        }
    );

    if (result.error || result.status !== 0) {
        throw new Error(`Secret Manager metadata is unavailable for ${name}. Run the documented OAuth bootstrap first.`);
    }

    let payload;
    try {
        payload = JSON.parse(result.stdout);
    } catch {
        throw new Error(`Firebase returned unreadable metadata for ${name}.`);
    }

    const versions = payload?.result?.secrets;
    let latestVersion = null;
    if (Array.isArray(versions)) {
        for (const version of versions) {
            if (!/^\d+$/u.test(version?.versionId ?? "")) continue;
            if (
                latestVersion === null
                || BigInt(version.versionId) > BigInt(latestVersion.versionId)
            ) {
                latestVersion = version;
            }
        }
    }
    if (latestVersion?.state !== "ENABLED") {
        throw new Error(`The latest Secret Manager version is not enabled for ${name}.`);
    }
}

try {
    for (const name of REQUIRED_SECRETS) {
        readMetadata(name);
    }
    process.stdout.write("Secret Manager metadata verified: the latest version of all three required secrets is enabled.\n");
} catch (error) {
    const message = error instanceof Error ? error.message : "Secret Manager metadata verification failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}
