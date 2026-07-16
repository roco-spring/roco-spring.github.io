#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRECTORIES = new Set([
    ".git",
    ".firebase",
    ".secrets-tmp",
    "coverage",
    "lib",
    "node_modules"
]);
const SKIP_FILES = new Set([
    path.normalize("scripts/security-scan.mjs")
]);
const SENSITIVE_BINARY_EXTENSIONS = new Set([
    ".jks",
    ".keystore",
    ".p12",
    ".pfx"
]);

const findings = [];

function scanFilename(relative, displayName = relative) {
    if (SENSITIVE_BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
        findings.push({
            file: displayName,
            label: "credential container file",
            line: null
        });
    }
}

async function inspectTemporarySecretDirectory() {
    try {
        const entries = await readdir(path.join(ROOT, ".secrets-tmp"));
        if (entries.length > 0) {
            findings.push({
                file: ".secrets-tmp",
                label: `leftover temporary secret material (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`,
                line: null
            });
        }
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
}

const secretPatterns = [
    {
        label: "private key material",
        pattern: /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/g
    },
    {
        label: "Google OAuth client secret value",
        pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/g
    },
    {
        label: "Google OAuth refresh token value",
        pattern: /(?:^|[^A-Za-z0-9])1\/(?:\/)?[A-Za-z0-9_-]{20,}/gm
    },
    {
        label: "Google OAuth access token value",
        pattern: /(?:^|[^A-Za-z0-9])ya29\.[A-Za-z0-9_-]{20,}/gm
    },
    {
        label: "service-account credential JSON",
        pattern: /["']type["']\s*:\s*["']service_account["'][\s\S]{0,1600}["']private_key["']\s*:/g
    },
    {
        label: "private key value in JSON",
        pattern: /["']private_key["']\s*:\s*["'][^"'\n]{40,}["']/g
    },
    {
        label: "persisted OAuth client secret assignment",
        pattern: /["']?(?:GOOGLE_OAUTH_CLIENT_SECRET|client_secret)["']?\s*[=:]\s*["'][^"'\n]{12,}["']/gi
    },
    {
        label: "persisted OAuth refresh token assignment",
        pattern: /["']?(?:GOOGLE_OAUTH_REFRESH_TOKEN|refresh_token)["']?\s*[=:]\s*["'][^"'\n]{12,}["']/gi
    },
    {
        label: "persisted OAuth access token assignment",
        pattern: /["']?(?:GOOGLE_OAUTH_ACCESS_TOKEN|access_token)["']?\s*[=:]\s*["'][^"'\n]{12,}["']/gi
    },
    {
        label: "persisted rate-limit HMAC secret assignment",
        pattern: /["']?RATE_LIMIT_HMAC_SECRET["']?\s*[=:]\s*["'][^"'\n]{12,}["']/g
    },
    {
        label: "possible unquoted secret environment assignment",
        pattern: /^(?:export\s+)?(?:GOOGLE_OAUTH_CLIENT_SECRET|GOOGLE_OAUTH_REFRESH_TOKEN|GOOGLE_OAUTH_ACCESS_TOKEN|RATE_LIMIT_HMAC_SECRET)\s*=\s*[A-Za-z0-9_.+\/-]{12,}\s*$/gm
    },
    {
        label: "possible password written to Firestore",
        pattern: /\.(?:set|update|create)\s*\(\s*\{[^}]{0,500}\b(?:temporaryPassword|newPassword|currentPassword)\b/g
    },
    {
        label: "possible password logging",
        pattern: /(?:console\.|logger\.)\w+\s*\([^)]{0,500}\b(?:temporaryPassword|newPassword|currentPassword)\b/g
    }
];

async function collectFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) {
            continue;
        }

        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(absolute));
        } else if (entry.isFile()) {
            files.push(absolute);
        }
    }

    return files;
}

function lineNumberFor(text, index) {
    return text.slice(0, index).split("\n").length;
}

function scanText(relative, text) {
    for (const { label, pattern } of secretPatterns) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            findings.push({ file: relative, label, line: lineNumberFor(text, match.index ?? 0) });
        }
    }
}

await inspectTemporarySecretDirectory();

for (const file of await collectFiles(ROOT)) {
    const relative = path.normalize(path.relative(ROOT, file));
    if (SKIP_FILES.has(relative)) {
        continue;
    }

    scanFilename(relative);

    const bytes = await readFile(file);
    if (bytes.includes(0)) {
        continue;
    }

    const text = bytes.toString("utf8");
    scanText(relative, text);
}

// Inspect the Git index too. This catches a credential staged first and then
// removed only from the working tree before the scan.
let stagedPaths = [];
try {
    stagedPaths = execFileSync(
        "git",
        ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).split("\0").filter(Boolean);
} catch {
    // A non-Git source archive still receives the working-tree scan above.
}

for (const relative of stagedPaths) {
    scanFilename(relative, `${relative} (staged)`);
    try {
        const text = execFileSync("git", ["show", `:${relative}`], {
            cwd: ROOT,
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"]
        });
        if (!text.includes("\0")) {
            scanText(`${relative} (staged)`, text);
        }
    } catch {
        // Binary, oversized, or concurrently removed index entries are skipped.
    }
}

if (findings.length > 0) {
    console.error("Security scan failed. Review these possible secret or password-persistence findings:");
    for (const finding of findings) {
        const location = finding.line === null
            ? finding.file
            : `${finding.file}:${finding.line}`;
        console.error(`- ${location} — ${finding.label}`);
    }
    process.exitCode = 1;
} else {
    console.log("Security scan passed: no configured credential, private-key, or password persistence/logging patterns found. Manual review is still required.");
}
