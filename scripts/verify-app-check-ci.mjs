#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
    isUuidV4,
    runLiveAppCheckGate,
    runLiveAppCheckProbe,
    verifyProbeResults
} from "./verify-live-app-check.mjs";

const PROJECT_NUMBER = "149052181991";
const APP_ID = "1:149052181991:web:291a3915eb3b5bbd6fc142";
const APP_PARENT = `projects/${PROJECT_NUMBER}/apps/${APP_ID}`;
const DEBUG_TOKEN_COLLECTION = `${APP_PARENT}/debugTokens`;
const APP_CHECK_API_ROOT = "https://firebaseappcheck.googleapis.com/v1";
const DISPLAY_NAME_PREFIX = "Ephemeral CI ";
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const CI_PROOF_MARKER = "VALID_CI_DEBUG_APP_CHECK_TO_VALIDATION_BOUNDARY";
const CLEANUP_PROOF_MARKER = "CI_DEBUG_TOKEN_REVOKED_AND_DELETION_VERIFIED";

// HTTP diagnostics can expose request bodies. The UUID4 debug token is an
// ephemeral credential and must remain only in memory and the browser init script.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;

function encodeResourcePath(resourceName) {
    return resourceName.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function statusFromError(error) {
    for (const candidate of [error?.response?.status, error?.status, error?.code]) {
        const status = Number(candidate);
        if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    }
    return null;
}

function safeApiError(operation, error) {
    const status = statusFromError(error);
    const suffix = status === null ? "" : ` (HTTP ${status})`;
    return new Error(`Firebase App Check debug-token ${operation} failed${suffix}.`);
}

function createAppCheckRestApi(requestImplementation) {
    if (typeof requestImplementation !== "function") {
        throw new Error("Firebase App Check API requires an authenticated request implementation.");
    }

    async function request(operation, options) {
        try {
            const response = await requestImplementation({
                timeout: REQUEST_TIMEOUT_MS,
                ...options
            });
            return response?.data ?? response;
        } catch (error) {
            throw safeApiError(operation, error);
        }
    }

    return Object.freeze({
        createDebugToken: ({ parent, displayName, token }) => request("creation", {
            method: "POST",
            url: `${APP_CHECK_API_ROOT}/${encodeResourcePath(parent)}/debugTokens`,
            data: { displayName, token }
        }),
        deleteDebugToken: (name) => request("revocation", {
            method: "DELETE",
            url: `${APP_CHECK_API_ROOT}/${encodeResourcePath(name)}`
        }),
        listDebugTokens: (parent, pageToken) => request("listing", {
            method: "GET",
            url: `${APP_CHECK_API_ROOT}/${encodeResourcePath(parent)}/debugTokens`,
            params: {
                pageSize: LIST_PAGE_SIZE,
                ...(pageToken ? { pageToken } : {})
            }
        })
    });
}

async function createAdcAppCheckApi() {
    try {
        const { google } = await import("googleapis");
        const auth = new google.auth.GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"]
        });
        const client = await auth.getClient();
        return createAppCheckRestApi((options) => client.request(options));
    } catch {
        throw new Error(
            "Application Default Credentials with Firebase App Check administration access are required."
        );
    }
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

async function listAllDebugTokens(api, parent = APP_PARENT) {
    const resources = [];
    const seenPageTokens = new Set();
    let pageToken;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const response = await api.listDebugTokens(parent, pageToken);
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

async function revokeAndVerifyDebugToken({
    api,
    resourceName,
    displayName,
    parent = APP_PARENT
}) {
    const candidates = new Set();
    if (isExpectedResourceName(resourceName)) candidates.add(resourceName);

    try {
        const inventory = await listAllDebugTokens(api, parent);
        for (const resource of inventory) {
            if (resource.displayName === displayName) candidates.add(resource.name);
        }
    } catch {
        // A known create response is sufficient to attempt revocation even when
        // the preliminary inventory request is temporarily unavailable.
        if (candidates.size === 0) throw cleanupFailure(resourceName, displayName);
    }

    for (const candidate of candidates) {
        try {
            await api.deleteDebugToken(candidate);
        } catch {
            // The final inventory is authoritative: a timed-out DELETE may have
            // succeeded, while a retained resource must fail the release.
        }
    }

    let verifiedInventory;
    try {
        verifiedInventory = await listAllDebugTokens(api, parent);
    } catch {
        throw cleanupFailure(resourceName, displayName);
    }

    if (verifiedInventory.some((resource) => (
        candidates.has(resource.name) || resource.displayName === displayName
    ))) {
        throw cleanupFailure(resourceName, displayName);
    }
}

async function runAppCheckCiGate({
    api,
    tokenFactory = randomUUID,
    displayNameFactory = () => `${DISPLAY_NAME_PREFIX}${randomUUID()}`,
    probeImplementation = (debugToken) => runLiveAppCheckGate({
        probeImplementation: () => runLiveAppCheckProbe({ debugToken })
    })
} = {}) {
    if (
        typeof api?.createDebugToken !== "function"
        || typeof api?.deleteDebugToken !== "function"
        || typeof api?.listDebugTokens !== "function"
    ) {
        throw new Error("The App Check CI gate requires create, list, and delete API operations.");
    }

    let debugToken = tokenFactory();
    if (!isUuidV4(debugToken)) {
        debugToken = undefined;
        throw new Error("The App Check CI token factory must return a UUID4 value.");
    }
    const displayName = displayNameFactory();
    validateDisplayName(displayName);

    let resourceName;
    let gateResult;
    let primaryFailure;
    let cleanupError;

    try {
        const created = await api.createDebugToken({
            parent: APP_PARENT,
            displayName,
            token: debugToken
        });
        if (isExpectedResourceName(created?.name)) resourceName = created.name;
        if (!resourceName || created?.displayName !== displayName) {
            throw new Error("Firebase App Check did not confirm the temporary debug-token resource.");
        }

        gateResult = await probeImplementation(debugToken);
        verifyProbeResults(gateResult?.results);
    } catch (error) {
        primaryFailure = error;
    } finally {
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
        const api = await createAdcAppCheckApi();
        const { results, attempts } = await runAppCheckCiGate({ api });
        for (const result of results) {
            process.stdout.write(`PASS ${result.name} [${CI_PROOF_MARKER}]\n`);
        }
        process.stdout.write(`PASS appCheckDebugToken [${CLEANUP_PROOF_MARKER}]\n`);
        process.stdout.write(
            `CI App Check probe passed in ${attempts} attempt(s); the temporary debug token was never logged or persisted.\n`
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
    DISPLAY_NAME_PREFIX,
    PROJECT_NUMBER,
    createAdcAppCheckApi,
    createAppCheckRestApi,
    isExpectedResourceName,
    listAllDebugTokens,
    revokeAndVerifyDebugToken,
    runAppCheckCiGate
};
