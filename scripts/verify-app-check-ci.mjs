#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

import {
    EXPECTED_PROBES,
    LIVE_REGISTRATION_URL,
    PROJECT_ID,
    runLiveAppCheckGate,
    verifyProductionProjectId,
    verifyProbeResults
} from "./verify-live-app-check.mjs";

const PROJECT_NUMBER = "149052181991";
const APP_ID = "1:149052181991:web:291a3915eb3b5bbd6fc142";
const FIREBASE_API_KEY = "AIzaSyA4Qrg-9o6jA8chu-s3PDks4yfnH_A3mcE";
const FIREBASE_VERSION = "12.16.0";
const FUNCTIONS_REGION = "europe-west3";
const APP_PARENT = `projects/${PROJECT_NUMBER}/apps/${APP_ID}`;
const DEBUG_TOKEN_COLLECTION = `${APP_PARENT}/debugTokens`;
const APP_CHECK_API_ROOT = "https://firebaseappcheck.googleapis.com/v1";
const DISPLAY_NAME_PREFIX = "Ephemeral CI ";
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REGISTRATION_DELAY_MS = 5_000;
const CI_PROOF_MARKER = "TEMPORARY_DEBUG_APP_CHECK_TO_VALIDATION_BOUNDARY";
const CLEANUP_PROOF_MARKER = "CI_DEBUG_TOKEN_REVOKED_AND_DELETION_VERIFIED";

// Provider diagnostics may include HTTP bodies. Keep them disabled because the
// one-use UUID4 is an ephemeral credential. It is exchanged only server-side.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;

function isUuidV4(value) {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function encodeResourcePath(resourceName) {
    return resourceName.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function isExpectedResourceName(name) {
    if (typeof name !== "string" || !name.startsWith(`${DEBUG_TOKEN_COLLECTION}/`)) {
        return false;
    }
    return /^[A-Za-z0-9._~-]+$/u.test(name.slice(DEBUG_TOKEN_COLLECTION.length + 1));
}

function validateDisplayName(displayName) {
    if (
        typeof displayName !== "string"
        || !displayName.startsWith(DISPLAY_NAME_PREFIX)
        || displayName.length > 50
        || /[\r\n]/u.test(displayName)
    ) {
        throw new Error("The temporary App Check debug-token display label is invalid.");
    }
}

function validateAppCheckToken(token) {
    if (
        typeof token !== "string"
        || token.length < 32
        || token.length > 16_384
        || token.split(".").length !== 3
    ) {
        throw new Error("Firebase App Check did not return a valid short-lived token.");
    }
}

function safeApiError(operation, status) {
    const suffix = Number.isInteger(status) ? ` (HTTP ${status})` : "";
    return new Error(`Firebase App Check ${operation} failed${suffix}.`);
}

function createAppCheckRestApi({
    fetchImplementation = globalThis.fetch,
    accessTokenProvider
} = {}) {
    if (typeof fetchImplementation !== "function" || typeof accessTokenProvider !== "function") {
        throw new Error("Firebase App Check API requires fetch and operator authentication.");
    }

    async function request(operation, url, {
        method = "GET",
        body,
        authenticated = true,
        notFoundIsNull = false
    } = {}) {
        const headers = { accept: "application/json" };
        if (body !== undefined) headers["content-type"] = "application/json";

        if (authenticated) {
            let accessToken;
            try {
                accessToken = await accessTokenProvider();
            } catch {
                throw safeApiError("operator authentication");
            }
            if (typeof accessToken !== "string" || accessToken.length < 16) {
                throw safeApiError("operator authentication");
            }
            headers.authorization = `Bearer ${accessToken}`;
            headers["x-goog-user-project"] = PROJECT_ID;
        }

        let response;
        try {
            response = await fetchImplementation(url, {
                method,
                headers,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch {
            throw safeApiError(operation);
        }

        if (notFoundIsNull && response.status === 404) return null;
        if (!response.ok) throw safeApiError(operation, response.status);
        if (response.status === 204) return undefined;

        try {
            return await response.json();
        } catch {
            throw safeApiError(`${operation} response parsing`, response.status);
        }
    }

    const collectionUrl = `${APP_CHECK_API_ROOT}/${encodeResourcePath(DEBUG_TOKEN_COLLECTION)}`;

    return Object.freeze({
        createDebugToken: ({ displayName, token }) => request(
            "debug-token creation",
            collectionUrl,
            { method: "POST", body: { displayName, token } }
        ),
        deleteDebugToken: (name) => request(
            "debug-token revocation",
            `${APP_CHECK_API_ROOT}/${encodeResourcePath(name)}`,
            { method: "DELETE" }
        ),
        getDebugToken: (name) => request(
            "debug-token read-back",
            `${APP_CHECK_API_ROOT}/${encodeResourcePath(name)}`,
            { notFoundIsNull: true }
        ),
        listDebugTokens: (pageToken) => {
            const query = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
            if (pageToken) query.set("pageToken", pageToken);
            return request("debug-token listing", `${collectionUrl}?${query}`);
        },
        exchangeDebugToken: async (debugToken) => {
            const url = new URL(
                `${APP_CHECK_API_ROOT}/${encodeResourcePath(APP_PARENT)}:exchangeDebugToken`
            );
            url.searchParams.set("key", FIREBASE_API_KEY);
            const response = await request("debug-token exchange", url.href, {
                method: "POST",
                authenticated: false,
                body: { debugToken }
            });
            validateAppCheckToken(response?.token);
            return response.token;
        }
    });
}

async function createFirebaseCliAppCheckApi() {
    try {
        const require = createRequire(import.meta.url);
        const firebaseAuth = require("firebase-tools/lib/auth.js");
        const { getAccessToken } = require("firebase-tools/lib/apiv2.js");
        const { requireAuth } = require("firebase-tools/lib/requireAuth.js");
        const projectRoot = path.resolve(process.cwd());
        const options = { project: PROJECT_ID, projectId: PROJECT_ID };
        const account = firebaseAuth.getProjectDefaultAccount(projectRoot)
            ?? firebaseAuth.getGlobalDefaultAccount();
        if (account) firebaseAuth.setActiveAccount(options, account);
        await requireAuth(options);

        return createAppCheckRestApi({
            accessTokenProvider: async () => {
                const accessToken = await getAccessToken();
                if (typeof accessToken !== "string" || accessToken.length < 16) {
                    throw new Error("missing operator access token");
                }
                return accessToken;
            }
        });
    } catch {
        throw new Error(
            "Firebase CLI login or Application Default Credentials with App Check administration access are required."
        );
    }
}

async function listAllDebugTokens(api) {
    const resources = [];
    const seenPageTokens = new Set();
    let pageToken;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const response = await api.listDebugTokens(pageToken);
        if (response?.debugTokens !== undefined && !Array.isArray(response.debugTokens)) {
            throw new Error("Firebase App Check returned an invalid debug-token inventory.");
        }

        for (const resource of response?.debugTokens ?? []) {
            if (!isExpectedResourceName(resource?.name)) {
                throw new Error("Firebase App Check returned an unexpected debug-token resource.");
            }
            resources.push({ name: resource.name, displayName: resource.displayName });
        }

        const nextPageToken = response?.nextPageToken;
        if (typeof nextPageToken !== "string" || nextPageToken.length === 0) return resources;
        if (seenPageTokens.has(nextPageToken)) {
            throw new Error("Firebase App Check returned a repeated inventory page token.");
        }
        seenPageTokens.add(nextPageToken);
        pageToken = nextPageToken;
    }

    throw new Error("Firebase App Check debug-token inventory exceeded its safety bound.");
}

function cleanupFailure(resourceName, displayName) {
    const safeResourceName = isExpectedResourceName(resourceName)
        ? resourceName
        : "resource name unavailable";
    return new Error(
        `Temporary App Check CI debug-token cleanup could not be verified for ${safeResourceName} (display label: ${displayName}).`
    );
}

async function revokeAndVerifyDebugToken({ api, resourceName, displayName }) {
    const candidates = new Set();
    if (isExpectedResourceName(resourceName)) candidates.add(resourceName);

    try {
        const inventory = await listAllDebugTokens(api);
        for (const resource of inventory) {
            if (resource.displayName === displayName) candidates.add(resource.name);
        }
    } catch {
        if (candidates.size === 0) throw cleanupFailure(resourceName, displayName);
    }

    for (const candidate of candidates) {
        try {
            await api.deleteDebugToken(candidate);
        } catch {
            // Exact GET and final inventory read-back are authoritative.
        }
    }

    try {
        for (const candidate of candidates) {
            if (await api.getDebugToken(candidate) !== null) {
                throw cleanupFailure(resourceName, displayName);
            }
        }
        const finalInventory = await listAllDebugTokens(api);
        if (finalInventory.some((resource) => (
            candidates.has(resource.name) || resource.displayName === displayName
        ))) {
            throw cleanupFailure(resourceName, displayName);
        }
    } catch (error) {
        if (error?.message?.startsWith("Temporary App Check CI")) throw error;
        throw cleanupFailure(resourceName, displayName);
    }
}

async function runDirectAppCheckProbe({
    appCheckToken,
    url = LIVE_REGISTRATION_URL,
    launch = (options) => chromium.launch(options)
} = {}) {
    validateAppCheckToken(appCheckToken);
    const browser = await launch({ headless: true });

    try {
        const page = await browser.newPage();
        const target = new URL(url);
        target.searchParams.set("production-smoke", Date.now().toString(36));
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(
            () => window.rocoTeamRegistrationReady === true,
            undefined,
            { timeout: 60_000 }
        );

        const liveProjectId = await page.evaluate(async (firebaseVersion) => {
            const { getApp } = await import(
                `https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`
            );
            return getApp().options.projectId;
        }, FIREBASE_VERSION);
        verifyProductionProjectId(liveProjectId);

        const results = await page.evaluate(async ({ probes, projectId, region, token }) => {
            const normalizeCode = (status) => {
                if (typeof status !== "string" || !/^[A-Z_]+$/u.test(status)) {
                    return "functions/unknown";
                }
                return `functions/${status.toLowerCase().replaceAll("_", "-")}`;
            };

            return Promise.all(probes.map(async ({ name, payload }) => {
                try {
                    const response = await fetch(
                        `https://${region}-${projectId}.cloudfunctions.net/${encodeURIComponent(name)}`,
                        {
                            method: "POST",
                            headers: {
                                "content-type": "application/json",
                                "x-firebase-appcheck": token
                            },
                            body: JSON.stringify({ data: payload })
                        }
                    );
                    let responseStatus;
                    try {
                        const responseBody = await response.json();
                        responseStatus = responseBody?.error?.status;
                    } catch {
                        responseStatus = undefined;
                    }
                    return { name, code: normalizeCode(responseStatus) };
                } catch {
                    return { name, code: "functions/network-error" };
                }
            }));
        }, {
            probes: EXPECTED_PROBES.map(({ name, payload }) => ({ name, payload })),
            projectId: PROJECT_ID,
            region: FUNCTIONS_REGION,
            token: appCheckToken
        });

        verifyProbeResults(results);
        return results;
    } finally {
        await browser.close();
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runAppCheckCiGate({
    api,
    tokenFactory = randomUUID,
    displayNameFactory = () => `${DISPLAY_NAME_PREFIX}${randomUUID()}`,
    registrationDelayMs = DEFAULT_REGISTRATION_DELAY_MS,
    sleepImplementation = sleep,
    probeImplementation = (appCheckToken) => runLiveAppCheckGate({
        probeImplementation: () => runDirectAppCheckProbe({ appCheckToken })
    })
} = {}) {
    if (
        typeof api?.createDebugToken !== "function"
        || typeof api?.exchangeDebugToken !== "function"
        || typeof api?.deleteDebugToken !== "function"
        || typeof api?.getDebugToken !== "function"
        || typeof api?.listDebugTokens !== "function"
    ) {
        throw new Error("The App Check CI gate requires create, exchange, read, list, and delete operations.");
    }
    if (
        !Number.isFinite(registrationDelayMs)
        || registrationDelayMs < 0
        || registrationDelayMs > 30_000
    ) {
        throw new Error("The App Check CI registration delay must be between 0 and 30000.");
    }

    let debugToken = tokenFactory();
    if (!isUuidV4(debugToken)) {
        debugToken = undefined;
        throw new Error("The App Check CI token factory must return a UUID4 value.");
    }
    const displayName = displayNameFactory();
    validateDisplayName(displayName);

    let resourceName;
    let appCheckToken;
    let gateResult;
    let primaryFailure;
    let cleanupError;

    try {
        const created = await api.createDebugToken({ displayName, token: debugToken });
        if (isExpectedResourceName(created?.name)) resourceName = created.name;
        if (!resourceName || created?.displayName !== displayName) {
            throw new Error("Firebase App Check did not confirm the temporary debug-token resource.");
        }

        if (registrationDelayMs > 0) await sleepImplementation(registrationDelayMs);
        appCheckToken = await api.exchangeDebugToken(debugToken);
        validateAppCheckToken(appCheckToken);
        gateResult = await probeImplementation(appCheckToken);
        verifyProbeResults(gateResult?.results);
    } catch (error) {
        primaryFailure = error;
    } finally {
        appCheckToken = undefined;
        debugToken = undefined;
        try {
            await revokeAndVerifyDebugToken({ api, resourceName, displayName });
        } catch (error) {
            cleanupError = error;
        }
    }

    if (cleanupError) throw cleanupError;
    if (primaryFailure) throw primaryFailure;
    return { ...gateResult, cleanupVerified: true };
}

async function main() {
    try {
        const api = await createFirebaseCliAppCheckApi();
        const { results, attempts } = await runAppCheckCiGate({ api });
        for (const result of results) {
            process.stdout.write(`PASS ${result.name} [${CI_PROOF_MARKER}]\n`);
        }
        process.stdout.write(`PASS appCheckDebugToken [${CLEANUP_PROOF_MARKER}]\n`);
        process.stdout.write(
            `CI App Check plumbing probe passed in ${attempts} attempt(s); neither temporary credential was logged or persisted.\n`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "CI App Check probe failed.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();

export {
    APP_ID,
    APP_PARENT,
    CI_PROOF_MARKER,
    CLEANUP_PROOF_MARKER,
    DEBUG_TOKEN_COLLECTION,
    DEFAULT_REGISTRATION_DELAY_MS,
    DISPLAY_NAME_PREFIX,
    PROJECT_NUMBER,
    createAppCheckRestApi,
    createFirebaseCliAppCheckApi,
    isExpectedResourceName,
    isUuidV4,
    listAllDebugTokens,
    revokeAndVerifyDebugToken,
    runAppCheckCiGate,
    runDirectAppCheckProbe
};
