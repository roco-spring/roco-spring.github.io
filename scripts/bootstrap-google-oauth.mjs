#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { google } from "googleapis";

const PROJECT_ID = "roco-spring-registration-2026";
const OAUTH_CLIENT_ID = "149052181991-dn69v7pid5o7fi89dtnusbklnbnncnho.apps.googleusercontent.com";
const DRIVE_FOLDER_ID = "17UXoH2ldTuSFyhaxOknu6IvGxFbr7QYU";
const REGISTRATION_SENDER = "shashanksagnihotri@gmail.com";
const SCOPES = Object.freeze([
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.send"
]);
const SECRET_NAMES = Object.freeze({
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
    refreshToken: "GOOGLE_OAUTH_REFRESH_TOKEN",
    rateLimit: "RATE_LIMIT_HMAC_SECRET"
});
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

function fail(message) {
    throw new Error(message);
}

class PreflightInvariantError extends Error {
    constructor(category, message) {
        super(message);
        this.name = "PreflightInvariantError";
        this.category = category;
    }
}

function runFirebase(args, { capture = false } = {}) {
    const result = spawnSync(process.execPath, [FIREBASE_SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: sanitizedEnvironment(),
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
    });

    if (result.error) {
        fail(`Firebase CLI could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
        fail(`Firebase CLI failed${detail ? `: ${detail}` : "."}`);
    }

    return capture ? result.stdout : "";
}

function confirmFirebaseAccess() {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn("GOOGLE_APPLICATION_CREDENTIALS is set. This bootstrap still requires organizer OAuth consent and will not read that file for Google Drive/Gmail access.");
    }

    let output;
    try {
        output = runFirebase(["projects:list", "--json"], { capture: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (!/authenticate|firebase login|logged in/iu.test(message)) {
            throw error;
        }
        console.log("Firebase authentication is required. Starting the standard Firebase login flow…");
        runFirebase(["login"]);
        output = runFirebase(["projects:list", "--json"], { capture: true });
    }
    let payload;
    try {
        payload = JSON.parse(output);
    } catch {
        fail("Firebase CLI returned an unreadable project list. Run `node scripts/firebase-safe.mjs login` and retry.");
    }

    const projects = Array.isArray(payload?.result) ? payload.result : [];
    if (!projects.some((project) => project.projectId === PROJECT_ID)) {
        fail(`The authenticated Firebase account cannot access ${PROJECT_ID}. Run \`node scripts/firebase-safe.mjs login --reauth\` with an authorized account and retry.`);
    }

    console.log(`Confirmed Firebase project access: ${PROJECT_ID}`);
    console.log(`Confirmed OAuth client ID: ${OAUTH_CLIENT_ID}`);
}

function promptLine(message) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            reject(new Error("This bootstrap requires an interactive terminal."));
            return;
        }

        process.stdout.write(message);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        let value = "";
        const onData = (chunk) => {
            value += chunk;
            if (!value.includes("\n") && !value.includes("\r")) {
                return;
            }
            cleanup();
            process.stdout.write("\n");
            resolve(value.replace(/[\r\n]+$/, "").trim());
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            process.stdin.off("data", onData);
            process.stdin.off("error", onError);
            process.stdin.pause();
        };

        process.stdin.on("data", onData);
        process.stdin.on("error", onError);
    });
}

function promptHidden(message) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
            reject(new Error("A TTY is required to enter the OAuth client secret securely."));
            return;
        }

        process.stdout.write(message);
        const previousRawMode = Boolean(process.stdin.isRaw);
        let value = "";

        const restore = () => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(previousRawMode);
            process.stdin.pause();
        };
        const onData = (chunk) => {
            for (const character of chunk.toString("utf8")) {
                if (character === "\u0003") {
                    restore();
                    process.stdout.write("\n");
                    reject(new Error("OAuth bootstrap cancelled."));
                    return;
                }
                if (character === "\r" || character === "\n") {
                    restore();
                    process.stdout.write("\n");
                    resolve(value);
                    return;
                }
                if (character === "\u007f" || character === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                if (character >= " ") {
                    value += character;
                }
            }
        };

        process.stdin.setEncoding("utf8");
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
    });
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function receiveAuthorizationCode(clientSecret) {
    const state = randomBytes(32).toString("base64url");
    let callbackResolve;
    let callbackReject;
    const callbackPromise = new Promise((resolve, reject) => {
        callbackResolve = resolve;
        callbackReject = reject;
    });

    const server = createServer((request, response) => {
        try {
            const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
            if (requestUrl.pathname !== "/") {
                response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("Not found");
                return;
            }

            const callbackState = requestUrl.searchParams.get("state") ?? "";
            if (!safeEqual(callbackState, state)) {
                response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("OAuth state mismatch. You may close this window.");
                callbackReject(new Error("OAuth callback state validation failed."));
                return;
            }

            const oauthError = requestUrl.searchParams.get("error");
            const code = requestUrl.searchParams.get("code");
            if (oauthError || !code) {
                response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("OAuth approval was not completed. You may close this window.");
                callbackReject(new Error(`Google OAuth approval failed: ${oauthError || "authorization code missing"}.`));
                return;
            }

            response.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff"
            });
            response.end("<!doctype html><meta charset=\"utf-8\"><title>RoCo-Spring OAuth</title><p>Authorization received. You may close this window and return to the terminal.</p>");
            callbackResolve(code);
        } catch {
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Invalid OAuth callback. You may close this window.");
            callbackReject(new Error("Invalid OAuth callback."));
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    let timeout;
    try {
        const address = server.address();
        if (!address || typeof address === "string") {
            fail("Could not allocate the local OAuth callback port.");
        }

        const redirectUri = `http://127.0.0.1:${address.port}`;
        const oauthClient = new google.auth.OAuth2(OAUTH_CLIENT_ID, clientSecret, redirectUri);
        const { codeVerifier, codeChallenge } = await oauthClient.generateCodeVerifierAsync();
        if (!codeChallenge) {
            fail("Could not generate the OAuth PKCE S256 challenge.");
        }
        const authorizationUrl = oauthClient.generateAuthUrl({
            access_type: "offline",
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            include_granted_scopes: false,
            login_hint: REGISTRATION_SENDER,
            prompt: "consent",
            scope: [...SCOPES],
            state
        });

        console.log(`Approve the two narrow Google scopes while signed in as ${REGISTRATION_SENDER}. Verify the selected account on Google's consent screen.`);
        console.log("If a browser does not open, use this safe URL:");
        console.log(authorizationUrl);
        tryOpenBrowser(authorizationUrl);

        timeout = setTimeout(
            () => callbackReject(new Error("OAuth callback timed out after ten minutes.")),
            10 * 60 * 1000
        );
        const code = await callbackPromise;
        const tokenResponse = await oauthClient.getToken({ code, codeVerifier });
        const refreshToken = tokenResponse.tokens.refresh_token;
        const accessToken = tokenResponse.tokens.access_token;
        if (!refreshToken || !accessToken) {
            fail("Google did not return the required access and refresh tokens. Revoke the prior app grant if necessary, then run this consent flow again.");
        }

        let tokenInfo;
        try {
            tokenInfo = await oauthClient.getTokenInfo(accessToken);
        } catch {
            fail("Google OAuth scopes could not be verified. No token or secret was stored.");
        }
        const grantedScopes = new Set(tokenInfo.scopes);
        if (
            grantedScopes.size !== SCOPES.length ||
            SCOPES.some((scope) => !grantedScopes.has(scope))
        ) {
            fail("Google did not grant exactly the required Drive-file and Gmail-send scopes. No token or secret was stored.");
        }

        oauthClient.setCredentials(tokenResponse.tokens);
        return { oauthClient, refreshToken };
    } finally {
        if (timeout) clearTimeout(timeout);
        if (server.listening) {
            await new Promise((resolve) => server.close(resolve));
        }
    }
}

function tryOpenBrowser(url) {
    const candidates = process.platform === "darwin"
        ? [["open", [url]]]
        : process.platform === "win32"
            ? [["cmd", ["/c", "start", "", url]]]
            : [["xdg-open", [url]]];

    for (const [command, args] of candidates) {
        try {
            const child = spawn(command, args, {
                detached: true,
                env: sanitizedEnvironment(),
                stdio: "ignore"
            });
            child.on("error", () => {
                // The URL is already printed for manual use.
            });
            child.unref();
            return;
        } catch {
            // The printed authorization URL remains available as a safe fallback.
        }
    }
}

function googleErrorSummary(error) {
    if (error instanceof PreflightInvariantError) {
        return `reason=${error.category}`;
    }
    const status = error?.response?.status ?? error?.code ?? "unknown";
    const apiError = error?.response?.data?.error;
    const reasons = Array.isArray(apiError?.errors)
        ? apiError.errors.map((entry) => entry?.reason).filter(Boolean).join(",")
        : "";
    return `status=${status}${reasons ? ` reason=${reasons}` : ""}`;
}

async function findPreflightFileIds(drive, marker) {
    const ids = [];
    let pageToken;

    do {
        const response = await drive.files.list({
            q: [
                "mimeType = 'application/vnd.google-apps.spreadsheet'",
                "trashed = false",
                `'${DRIVE_FOLDER_ID}' in parents`,
                `appProperties has { key='rocoSpringOAuthPreflight' and value='${marker}' }`
            ].join(" and "),
            spaces: "drive",
            fields: "nextPageToken,files(id)",
            pageSize: 100,
            pageToken,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true
        });
        ids.push(...(response.data.files ?? []).map((file) => file.id).filter(Boolean));
        pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return ids;
}

async function deleteAndConfirmPreflightFile(drive, fileId) {
    try {
        await drive.files.delete({ fileId, supportsAllDrives: true });
    } catch (error) {
        const status = error?.response?.status ?? error?.code;
        if (status !== 404) throw error;
    }

    try {
        await drive.files.get({ fileId, fields: "id", supportsAllDrives: true });
        throw new PreflightInvariantError(
            "deletion_not_confirmed",
            "Deleted preflight spreadsheet is still retrievable."
        );
    } catch (error) {
        const status = error?.response?.status ?? error?.code;
        if (status !== 404) throw error;
    }
}

async function runDriveSheetsPreflight(oauthClient) {
    const drive = google.drive({ version: "v3", auth: oauthClient });
    const sheets = google.sheets({ version: "v4", auth: oauthClient });
    const timestamp = new Date().toISOString();
    const preflightMarker = randomBytes(18).toString("hex");
    const preflightTitle = `RoCo-Spring OAuth Preflight - ${timestamp}`;
    let fileId;
    let operation = "create spreadsheet in target folder";

    try {
        const created = await drive.files.create({
            requestBody: {
                name: preflightTitle,
                mimeType: "application/vnd.google-apps.spreadsheet",
                parents: [DRIVE_FOLDER_ID],
                appProperties: {
                    rocoSpringOAuthPreflight: preflightMarker
                }
            },
            fields: "id,parents,trashed",
            supportsAllDrives: true
        });
        fileId = created.data.id ?? undefined;
        if (!fileId) {
            throw new PreflightInvariantError("missing_file_id", "Drive did not return a file ID for the preflight spreadsheet.");
        }
        if (!created.data.parents?.includes(DRIVE_FOLDER_ID)) {
            throw new PreflightInvariantError("parent_mismatch", "Preflight spreadsheet parent did not match the required Drive folder.");
        }

        operation = "write preflight values with Sheets API";
        await sheets.spreadsheets.values.update({
            spreadsheetId: fileId,
            range: "A1:A2",
            valueInputOption: "RAW",
            requestBody: {
                values: [["RoCo-Spring OAuth preflight successful"], [timestamp]]
            }
        });

        operation = "read back preflight values with Sheets API";
        const readBack = await sheets.spreadsheets.values.get({
            spreadsheetId: fileId,
            range: "A1:A2"
        });
        const values = readBack.data.values ?? [];
        if (values[0]?.[0] !== "RoCo-Spring OAuth preflight successful" || values[1]?.[0] !== timestamp) {
            throw new PreflightInvariantError("readback_mismatch", "Sheets preflight read-back did not match the values written.");
        }

        operation = "verify private Drive permissions";
        const allPermissions = [];
        let pageToken;
        do {
            const permissions = await drive.permissions.list({
                fileId,
                fields: "nextPageToken,permissions(id,type,role,allowFileDiscovery)",
                pageSize: 100,
                pageToken,
                supportsAllDrives: true
            });
            allPermissions.push(...(permissions.data.permissions ?? []));
            pageToken = permissions.data.nextPageToken ?? undefined;
        } while (pageToken);
        const publicPermission = allPermissions.find((permission) => (
            permission.type === "anyone" || permission.type === "domain"
        ));
        if (publicPermission) {
            throw new PreflightInvariantError("public_permission", `Preflight spreadsheet unexpectedly has an unsafe ${publicPermission.type ?? "public"} permission (${publicPermission.role ?? "unknown role"}).`);
        }

        operation = "delete preflight spreadsheet";
        await deleteAndConfirmPreflightFile(drive, fileId);

        operation = "confirm preflight spreadsheet deletion";
        fileId = undefined;
        console.log("Live Drive/Sheets preflight passed: exact parent, RAW write/read, private permissions, deletion, and deletion confirmation verified.");
    } catch (error) {
        let cleanupIds = fileId ? [fileId] : [];

        if (!fileId) {
            // Drive create may commit and then return an ambiguous transport error.
            // Poll the unique appProperty marker before declaring cleanup incomplete.
            for (let attempt = 0; attempt < 5 && cleanupIds.length === 0; attempt += 1) {
                try {
                    cleanupIds = await findPreflightFileIds(drive, preflightMarker);
                } catch {
                    break;
                }
                if (cleanupIds.length === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
                }
            }
        }

        let cleanupFailed = cleanupIds.length === 0 && operation === "create spreadsheet in target folder";
        for (const cleanupId of new Set(cleanupIds)) {
            try {
                await deleteAndConfirmPreflightFile(drive, cleanupId);
            } catch {
                cleanupFailed = true;
            }
        }
        if (cleanupFailed) {
            console.error(`Preflight cleanup could not be confirmed. Inspect the exact target folder for '${preflightTitle}' and delete it before retrying.`);
        }
        fail(`Live Google preflight failed during '${operation}' (${googleErrorSummary(error)}). Scopes were not broadened.`);
    }
}

async function setFirebaseSecrets(clientSecret, refreshToken) {
    const temporaryDirectory = path.join(ROOT, ".secrets-tmp");
    const values = new Map([
        [SECRET_NAMES.clientSecret, clientSecret],
        [SECRET_NAMES.refreshToken, refreshToken],
        [SECRET_NAMES.rateLimit, randomBytes(48).toString("base64url")]
    ]);

    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
        for (const [name, value] of values) {
            const temporaryFile = path.join(temporaryDirectory, name.toLowerCase().replaceAll("_", "-"));
            await writeFile(temporaryFile, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
            runFirebase([
                "functions:secrets:set",
                name,
                "--data-file",
                temporaryFile,
                "--project",
                PROJECT_ID
            ]);
        }
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }

    for (const name of values.keys()) {
        runFirebase(["functions:secrets:get", name, "--project", PROJECT_ID, "--json"], { capture: true });
        console.log(`Verified Secret Manager metadata: ${name}`);
    }
}

async function main() {
    console.log("RoCo-Spring one-time Google OAuth bootstrap");
    console.log("Only a freshly rotated/reissued Desktop OAuth client secret is acceptable. Never reuse a secret from chat, source, shell history, logs, or a committed credential file.");
    confirmFirebaseAccess();

    const confirmation = await promptLine("Type ROTATED to confirm the OAuth client secret was freshly rotated/reissued: ");
    if (confirmation !== "ROTATED") {
        fail("Fresh-secret confirmation was not provided. No OAuth or secret changes were made.");
    }

    const clientSecret = await promptHidden("Fresh OAuth client secret (input hidden): ");
    if (clientSecret.trim().length < 12 || /[\r\n\u0000-\u001f\u007f]/.test(clientSecret)) {
        fail("The entered client secret is invalid.");
    }

    const { oauthClient, refreshToken } = await receiveAuthorizationCode(clientSecret);
    await runDriveSheetsPreflight(oauthClient);
    await setFirebaseSecrets(clientSecret, refreshToken);
    oauthClient.setCredentials({});
    console.log("OAuth bootstrap complete. Redeploy every function that binds the updated secrets.");
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : "OAuth bootstrap failed.");
    process.exitCode = 1;
});
