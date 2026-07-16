#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const firebase = path.join(
    root,
    "node_modules",
    "firebase-tools",
    "lib",
    "bin",
    "firebase.js"
);
const environment = { ...process.env };

// Firebase tooling and some transitive libraries treat DEBUG as permission to
// print verbose process context. Never inherit debug flags into auth, emulator,
// secret, or deployment commands.
delete environment.DEBUG;
delete environment.FIREBASE_DEBUG;
delete environment.NODE_DEBUG;
delete environment.GOOGLE_OAUTH_CLIENT_SECRET;
delete environment.GOOGLE_OAUTH_REFRESH_TOKEN;
delete environment.GOOGLE_OAUTH_ACCESS_TOKEN;
delete environment.RATE_LIMIT_HMAC_SECRET;

// Invoke the pinned CLI through Node instead of relying on npm's platform
// shim or its executable bit. Some shared filesystems preserve the package
// contents but not that mode bit after a clean install.
const result = spawnSync(process.execPath, [firebase, ...process.argv.slice(2)], {
    cwd: root,
    env: environment,
    stdio: "inherit"
});

if (result.error) {
    console.error(`Firebase CLI could not start: ${result.error.message}`);
    process.exitCode = 1;
} else {
    process.exitCode = result.status ?? 1;
}
