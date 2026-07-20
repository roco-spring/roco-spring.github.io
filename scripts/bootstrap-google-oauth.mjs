#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { google } from "googleapis";

const PROJECT_ID = "roco-spring-registration-2026";
const OAUTH_CLIENT_ID = "149052181991-dn69v7pid5o7fi89dtnusbklnbnncnho.apps.googleusercontent.com";
const DRIVE_FOLDER_ID = "1gZwIgAcwrtHZN2vW4XttTq5fFA-kU4Y4";
const REGISTRATION_SENDER = "shashanksagnihotri@gmail.com";
const SCOPES = Object.freeze([
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.send"
]);
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REQUEST_TIMEOUT_MS = 8_000;
const FIREBASE_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const GOOGLE_REQUEST_OPTIONS = Object.freeze({
    timeout: GOOGLE_REQUEST_TIMEOUT_MS,
    retry: false
});
const SAFE_PROVIDER_CODES = new Set([
    "access_denied",
    "accessNotConfigured",
    "invalid_client",
    "invalid_grant",
    "invalid_request",
    "invalid_scope",
    "invalid_token",
    "permission_denied",
    "rateLimitExceeded",
    "resource_exhausted",
    "serviceDisabled",
    "temporarily_unavailable",
    "unauthorized_client",
    "unavailable",
    "userRateLimitExceeded"
]);
const SECRET_NAMES = Object.freeze({
    clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
    refreshToken: "GOOGLE_OAUTH_REFRESH_TOKEN",
    rateLimit: "RATE_LIMIT_HMAC_SECRET"
});
const MINIMUM_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;
// A private organizer folder and one-off preflight marker should never need
// more than 500 permission/artifact entries. Keep the aggregate request time
// bounded even if Drive is degraded and every page reaches its timeout.
const MAX_LIST_PAGES = 5;
const CLEANUP_VERIFICATION_ATTEMPTS = 5;
const ROOT = path.resolve(import.meta.dirname, "..");
const FIREBASE_SCRIPT = path.join(
    ROOT,
    "node_modules",
    "firebase-tools",
    "lib",
    "bin",
    "firebase.js"
);

// Generated Google clients must never multiply the explicit request bound with
// hidden transport retries. OAuth token exchange below uses native fetch with
// the same one-attempt ceiling.
google.options(GOOGLE_REQUEST_OPTIONS);

// Provider debug output can include request bodies containing OAuth material.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;

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

export class OAuthBootstrapError extends Error {
    constructor(stage, status = null, providerCode = "unclassified") {
        const details = [
            `stage=${stage}`,
            `provider_code=${providerCode}`
        ];
        if (status !== null) details.push(`http_status=${status}`);
        super(`Google OAuth bootstrap failed [${details.join(" ")}].`);
        this.name = "OAuthBootstrapError";
        this.stage = stage;
        this.status = status;
        this.providerCode = providerCode;
    }
}

function normalizeProviderCode(candidate) {
    if (typeof candidate !== "string") return "unclassified";
    const normalized = candidate.trim();
    if (SAFE_PROVIDER_CODES.has(normalized)) return normalized;
    const lower = normalized.toLowerCase();
    return SAFE_PROVIDER_CODES.has(lower) ? lower : "unclassified";
}

function providerCodeFromError(error) {
    const responseData = error?.response?.data;
    const bodyError = responseData?.error;
    const candidates = [
        typeof bodyError === "string" ? bodyError : null,
        bodyError?.status,
        responseData?.status,
        error?.reason,
        typeof error?.code === "string" ? error.code : null
    ];
    const items = Array.isArray(bodyError?.errors)
        ? bodyError.errors
        : Array.isArray(responseData?.errors)
            ? responseData.errors
            : [];
    for (const item of items) candidates.push(item?.reason);
    for (const candidate of candidates) {
        const normalized = normalizeProviderCode(candidate);
        if (normalized !== "unclassified") return normalized;
    }
    return "unclassified";
}

function safeHttpStatus(error) {
    for (const candidate of [
        error?.response?.status,
        error?.status,
        error?.code
    ]) {
        const status = Number(candidate);
        if (Number.isInteger(status) && status >= 100 && status <= 599) {
            return status;
        }
    }
    return null;
}

export async function requestOAuthJson(
    fetchImplementation,
    stage,
    url,
    options
) {
    let response;
    try {
        response = await fetchImplementation(url, {
            ...options,
            redirect: "error",
            signal: AbortSignal.timeout(GOOGLE_REQUEST_TIMEOUT_MS)
        });
    } catch {
        throw new OAuthBootstrapError(stage);
    }

    let data = {};
    try {
        data = await response.json();
    } catch {
        // Provider bodies are never forwarded; they may contain credential
        // diagnostics even when the HTTP status itself is safe to report.
    }
    if (!response.ok) {
        throw new OAuthBootstrapError(
            stage,
            Number.isInteger(response.status) ? response.status : null,
            normalizeProviderCode(data?.error)
        );
    }
    return data;
}

function exactScopes(value) {
    const scopes = typeof value === "string"
        ? value.split(/\s+/u).filter(Boolean)
        : [];
    const granted = new Set(scopes);
    if (
        granted.size !== SCOPES.length
        || SCOPES.some((scope) => !granted.has(scope))
    ) {
        throw new OAuthBootstrapError(
            "oauth_scopes",
            null,
            "invalid_scope"
        );
    }
    return scopes;
}

function hasUnsafeControlCharacter(value) {
    return [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
    });
}

export async function exchangeAuthorizationCode(
    fetchImplementation,
    { clientSecret, code, codeVerifier, redirectUri }
) {
    const credentialInputs = [clientSecret, code, codeVerifier, redirectUri];
    if (
        credentialInputs.some((value) =>
            typeof value !== "string"
            || value.length === 0
            || value.length > 16_384
            || /[\r\n\u0000-\u001f\u007f]/u.test(value))
        || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(redirectUri)
    ) {
        throw new OAuthBootstrapError("authorization_code_input");
    }
    const token = await requestOAuthJson(
        fetchImplementation,
        "authorization_code_exchange",
        GOOGLE_OAUTH_TOKEN_URL,
        {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: OAUTH_CLIENT_ID,
                client_secret: clientSecret,
                code,
                code_verifier: codeVerifier,
                grant_type: "authorization_code",
                redirect_uri: redirectUri
            })
        }
    );
    const accessToken = typeof token?.access_token === "string"
        ? token.access_token
        : "";
    const refreshToken = typeof token?.refresh_token === "string"
        ? token.refresh_token
        : "";
    const expiresIn = Number(token?.expires_in);
    if (
        !accessToken
        || !refreshToken
        || hasUnsafeControlCharacter(accessToken)
        || hasUnsafeControlCharacter(refreshToken)
        || !Number.isFinite(expiresIn)
        || expiresIn < MINIMUM_ACCESS_TOKEN_LIFETIME_SECONDS
    ) {
        throw new OAuthBootstrapError("authorization_code_exchange");
    }
    exactScopes(token?.scope);

    // The generated API client receives only the short-lived access token. It
    // cannot silently refresh because no client secret or refresh token is set.
    const oauthClient = new google.auth.OAuth2();
    oauthClient.setCredentials({
        access_token: accessToken,
        expiry_date: Date.now() + expiresIn * 1_000
    });
    return { oauthClient, refreshToken };
}

function runFirebase(args, { capture = false } = {}) {
    const result = spawnSync(process.execPath, [FIREBASE_SCRIPT, ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: sanitizedEnvironment(),
        timeout: FIREBASE_COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
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

function firebaseSecretExists(name) {
    const result = spawnSync(process.execPath, [FIREBASE_SCRIPT,
        "functions:secrets:get",
        name,
        "--project",
        PROJECT_ID,
        "--json"
    ], {
        cwd: ROOT,
        encoding: "utf8",
        env: sanitizedEnvironment(),
        timeout: FIREBASE_COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
    });
    if (result.error) {
        fail(`Firebase CLI could not inspect ${name}: ${result.error.message}`);
    }
    if (result.status === 0) return true;
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/not found|does not exist|404/iu.test(detail)) return false;
    fail(`Firebase CLI could not safely inspect ${name}; no secret was changed.`);
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
                callbackReject(new OAuthBootstrapError(
                    "authorization",
                    null,
                    oauthError
                        ? normalizeProviderCode(oauthError)
                        : "invalid_request"
                ));
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
        const authorizationClient = new google.auth.OAuth2(
            OAUTH_CLIENT_ID,
            undefined,
            redirectUri
        );
        const { codeVerifier, codeChallenge } =
            await authorizationClient.generateCodeVerifierAsync();
        if (!codeChallenge) {
            fail("Could not generate the OAuth PKCE S256 challenge.");
        }
        const authorizationUrl = authorizationClient.generateAuthUrl({
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
        return exchangeAuthorizationCode(globalThis.fetch, {
            clientSecret,
            code,
            codeVerifier,
            redirectUri
        });
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
    if (error instanceof OAuthBootstrapError) {
        return `status=${error.status ?? "unknown"} reason=${error.providerCode}`;
    }
    return `status=${safeHttpStatus(error) ?? "unknown"} reason=${providerCodeFromError(error)}`;
}

export async function findPreflightFileIds(drive, marker) {
    const ids = [];
    let pageToken;
    const seenPageTokens = new Set();

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const response = await drive.files.list(
            {
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
            },
            GOOGLE_REQUEST_OPTIONS
        );
        ids.push(...(response.data.files ?? []).map((file) => file.id).filter(Boolean));
        pageToken = response.data.nextPageToken ?? undefined;
        if (!pageToken) return ids;
        if (seenPageTokens.has(pageToken)) {
            throw new PreflightInvariantError("repeated_page", "Drive repeated a preflight inventory page.");
        }
        seenPageTokens.add(pageToken);
    }

    throw new PreflightInvariantError("page_limit", "Drive preflight inventory exceeded its page bound.");
}

async function deleteAndConfirmPreflightFile(drive, fileId) {
    try {
        await drive.files.delete(
            { fileId, supportsAllDrives: true },
            GOOGLE_REQUEST_OPTIONS
        );
    } catch (error) {
        if (safeHttpStatus(error) !== 404) throw error;
    }

    try {
        await drive.files.get(
            { fileId, fields: "id", supportsAllDrives: true },
            GOOGLE_REQUEST_OPTIONS
        );
        throw new PreflightInvariantError(
            "deletion_not_confirmed",
            "Deleted preflight spreadsheet is still retrievable."
        );
    } catch (error) {
        if (safeHttpStatus(error) !== 404) throw error;
    }
}

export async function cleanupPreflightArtifacts(
    drive,
    marker,
    knownFileIds = [],
    waitImplementation = (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))
) {
    const normalizedKnownIds = typeof knownFileIds === "string"
        ? [knownFileIds]
        : knownFileIds;
    const pendingIds = new Set(normalizedKnownIds.filter(Boolean));
    let observedArtifact = pendingIds.size > 0;
    let consecutiveEmptyInventories = 0;

    for (
        let attempt = 0;
        attempt < CLEANUP_VERIFICATION_ATTEMPTS;
        attempt += 1
    ) {
        let discovered;
        try {
            discovered = await findPreflightFileIds(drive, marker);
        } catch {
            consecutiveEmptyInventories = 0;
            discovered = null;
        }
        if (discovered) {
            if (discovered.length > 0) observedArtifact = true;
            for (const id of discovered) pendingIds.add(id);
            consecutiveEmptyInventories = discovered.length === 0
                ? consecutiveEmptyInventories + 1
                : 0;
        }

        for (const id of [...pendingIds]) {
            try {
                await deleteAndConfirmPreflightFile(drive, id);
                pendingIds.delete(id);
            } catch {
                // Keep the ID for the next bounded cleanup attempt.
            }
        }
        if (
            pendingIds.size === 0
            && observedArtifact
            && consecutiveEmptyInventories >= 2
        ) return true;
        if (attempt < CLEANUP_VERIFICATION_ATTEMPTS - 1) {
            await waitImplementation(250 * 2 ** attempt);
        }
    }
    // When create returned an ambiguous error and no ID was ever observed,
    // require every bounded inventory poll to be empty. Two fast empty reads
    // are not enough evidence against a file that is still becoming visible.
    return pendingIds.size === 0
        && !observedArtifact
        && consecutiveEmptyInventories === CLEANUP_VERIFICATION_ATTEMPTS;
}

export async function verifyOrganizerIdentity(drive) {
    const response = await drive.about.get(
        { fields: "user(emailAddress)" },
        GOOGLE_REQUEST_OPTIONS
    );
    if (response.data.user?.emailAddress !== REGISTRATION_SENDER) {
        throw new PreflightInvariantError(
            "organizer_account_mismatch",
            "OAuth was approved by an unexpected Google account."
        );
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
        operation = "verify the OAuth organizer account";
        await verifyOrganizerIdentity(drive);

        operation = "create spreadsheet in target folder";
        const created = await drive.files.create(
            {
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
            },
            GOOGLE_REQUEST_OPTIONS
        );
        fileId = created.data.id ?? undefined;
        if (!fileId) {
            throw new PreflightInvariantError("missing_file_id", "Drive did not return a file ID for the preflight spreadsheet.");
        }
        if (!created.data.parents?.includes(DRIVE_FOLDER_ID)) {
            throw new PreflightInvariantError("parent_mismatch", "Preflight spreadsheet parent did not match the required Drive folder.");
        }

        operation = "write preflight values with Sheets API";
        await sheets.spreadsheets.values.update(
            {
                spreadsheetId: fileId,
                range: "A1:A2",
                valueInputOption: "RAW",
                requestBody: {
                    values: [["RoCo-Spring OAuth preflight successful"], [timestamp]]
                }
            },
            GOOGLE_REQUEST_OPTIONS
        );

        operation = "read back preflight values with Sheets API";
        const readBack = await sheets.spreadsheets.values.get(
            {
                spreadsheetId: fileId,
                range: "A1:A2"
            },
            GOOGLE_REQUEST_OPTIONS
        );
        const values = readBack.data.values ?? [];
        if (values[0]?.[0] !== "RoCo-Spring OAuth preflight successful" || values[1]?.[0] !== timestamp) {
            throw new PreflightInvariantError("readback_mismatch", "Sheets preflight read-back did not match the values written.");
        }

        operation = "verify private Drive permissions";
        const allPermissions = [];
        let pageToken;
        const seenPermissionPageTokens = new Set();
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            const permissions = await drive.permissions.list(
                {
                    fileId,
                    fields: "nextPageToken,permissions(id,type,role,allowFileDiscovery)",
                    pageSize: 100,
                    pageToken,
                    supportsAllDrives: true
                },
                GOOGLE_REQUEST_OPTIONS
            );
            allPermissions.push(...(permissions.data.permissions ?? []));
            const nextPageToken = permissions.data.nextPageToken ?? undefined;
            if (!nextPageToken) {
                pageToken = undefined;
                break;
            }
            if (seenPermissionPageTokens.has(nextPageToken)) {
                throw new PreflightInvariantError(
                    "repeated_permission_page",
                    "Drive repeated a preflight permission page."
                );
            }
            seenPermissionPageTokens.add(nextPageToken);
            pageToken = nextPageToken;
        }
        if (pageToken) {
            throw new PreflightInvariantError(
                "permission_page_limit",
                "Drive preflight permissions exceeded the page bound."
            );
        }
        const publicPermission = allPermissions.find((permission) => (
            permission.type === "anyone" || permission.type === "domain"
        ));
        if (publicPermission) {
            throw new PreflightInvariantError("public_permission", `Preflight spreadsheet unexpectedly has an unsafe ${publicPermission.type ?? "public"} permission (${publicPermission.role ?? "unknown role"}).`);
        }

        operation = "delete and inventory-confirm preflight spreadsheets";
        const cleanupConfirmed = await cleanupPreflightArtifacts(
            drive,
            preflightMarker,
            fileId
        );
        if (!cleanupConfirmed) {
            throw new PreflightInvariantError(
                "cleanup_not_confirmed",
                "Preflight artifact cleanup could not be confirmed."
            );
        }
        fileId = undefined;
        console.log("Live Drive/Sheets preflight passed: exact parent, RAW write/read, private permissions, marker-wide deletion, and empty-inventory confirmation verified.");
    } catch (error) {
        const cleanupConfirmed = await cleanupPreflightArtifacts(
            drive,
            preflightMarker,
            fileId
        );
        if (!cleanupConfirmed) {
            console.error(`Preflight cleanup could not be confirmed. Inspect the exact target folder for '${preflightTitle}' and delete it before retrying.`);
        }
        fail(`Live Google preflight failed during '${operation}' (${googleErrorSummary(error)}). Scopes were not broadened.`);
    }
}

async function setFirebaseSecrets(clientSecret, refreshToken) {
    const temporaryDirectory = path.join(ROOT, ".secrets-tmp");
    const values = new Map([
        [SECRET_NAMES.clientSecret, clientSecret],
        [SECRET_NAMES.refreshToken, refreshToken]
    ]);
    const hasRateLimitSecret = firebaseSecretExists(SECRET_NAMES.rateLimit);
    if (!hasRateLimitSecret) {
        values.set(SECRET_NAMES.rateLimit, randomBytes(48).toString("base64url"));
    } else {
        console.log("Preserving the independent rate-limit HMAC secret.");
    }

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
    if (hasRateLimitSecret) {
        console.log(`Verified existing Secret Manager metadata: ${SECRET_NAMES.rateLimit}`);
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
    if (
        clientSecret.trim().length < 12
        || hasUnsafeControlCharacter(clientSecret)
    ) {
        fail("The entered client secret is invalid.");
    }

    const { oauthClient, refreshToken } = await receiveAuthorizationCode(clientSecret);
    await runDriveSheetsPreflight(oauthClient);
    await setFirebaseSecrets(clientSecret, refreshToken);
    oauthClient.setCredentials({});
    console.log("OAuth bootstrap complete. Redeploy every function that binds the updated secrets.");
}

const isDirectExecution = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
    main().catch((error) => {
        console.error(
            error instanceof Error
                ? error.message
                : "OAuth bootstrap failed."
        );
        process.exitCode = 1;
    });
}
