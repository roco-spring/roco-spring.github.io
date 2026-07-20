#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
    isUuidV4,
    PROJECT_ID,
    runLiveAuthenticatedAppCheckProbe,
    runLiveAppCheckGate,
    runLiveAppCheckProbe,
    verifyAuthenticatedProbeResults,
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
const AUTH_LIST_PAGE_SIZE = 1_000;
const MAX_AUTH_LIST_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const ADMIN_OPERATION_TIMEOUT_MS = 30_000;
const CI_PROOF_MARKER = "VALID_CI_DEBUG_APP_CHECK_TO_VALIDATION_BOUNDARY";
const CLEANUP_PROOF_MARKER = "CI_DEBUG_TOKEN_REVOKED_AND_DELETION_VERIFIED";
const AUTH_PROOF_MARKER = "VALID_AUTH_AND_APP_CHECK_ENFORCEMENT";
const AUTH_CLEANUP_PROOF_MARKER = "CI_AUTH_USERS_DELETED_AND_ABSENCE_VERIFIED";
const AUTH_DISPLAY_NAME_PREFIX = "Ephemeral App Check CI ";
const AUTH_CLAIM_MARKER = "rocoAppCheckCiMarker";
const AUTH_ACCOUNT_DEFINITIONS = Object.freeze([
    Object.freeze({
        name: "updateMyTeam",
        suffix: "update",
        expectedMustChangePassword: false
    }),
    Object.freeze({
        name: "completeInitialPasswordChange",
        suffix: "complete",
        expectedMustChangePassword: true
    })
]);

// HTTP diagnostics can expose request bodies. The UUID4 debug token is an
// ephemeral credential and must remain only in memory and the browser init script.
delete process.env.DEBUG;
delete process.env.DEBUG_FILE;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.PWDEBUG;

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

async function createAdcAdminAuth() {
    try {
        const [{ applicationDefault, deleteApp, initializeApp }, { getAuth }] = await Promise.all([
            import("firebase-admin/app"),
            import("firebase-admin/auth")
        ]);
        const app = initializeApp(
            { credential: applicationDefault(), projectId: PROJECT_ID },
            `roco-appcheck-ci-admin-${randomUUID()}`
        );
        return Object.freeze({
            auth: getAuth(app),
            close: () => deleteApp(app)
        });
    } catch {
        throw new Error(
            "Application Default Credentials with Firebase Authentication administration access are required."
        );
    }
}

function createEphemeralAuthAccountSpecs({
    markerFactory = randomUUID,
    passwordFactory = () => `${randomBytes(36).toString("base64url")}Aa1!`
} = {}) {
    const marker = markerFactory();
    if (!isUuidV4(marker)) {
        throw new Error("The Firebase Auth CI marker factory must return a UUID4 value.");
    }
    const compactMarker = marker.replaceAll("-", "").toLowerCase();

    return AUTH_ACCOUNT_DEFINITIONS.map((definition) => {
        const password = passwordFactory(definition.name);
        if (
            typeof password !== "string"
            || password.length < 20
            || password.length > 128
            || /[\r\n]/u.test(password)
        ) {
            throw new Error("The Firebase Auth CI password factory returned an invalid value.");
        }
        return {
            ...definition,
            marker,
            uid: `roco-appcheck-ci-${compactMarker}-${definition.suffix}`,
            email: `${definition.suffix}-${compactMarker}@example.invalid`,
            displayName: `${AUTH_DISPLAY_NAME_PREFIX}${marker} ${definition.suffix}`,
            password
        };
    });
}

function verifyAdminAuthApi(auth) {
    for (const operation of [
        "createUser",
        "deleteUser",
        "getUser",
        "getUserByEmail",
        "listUsers",
        "setCustomUserClaims"
    ]) {
        if (typeof auth?.[operation] !== "function") {
            throw new Error("The Auth CI gate requires the complete Firebase Admin user API.");
        }
    }
}

async function adminAuthCall(operation) {
    let timeout;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("Firebase Admin operation deadline exceeded.")),
                    ADMIN_OPERATION_TIMEOUT_MS
                );
            })
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

function isAuthUserNotFound(error) {
    return error?.code === "auth/user-not-found";
}

function assertExactAuthUser(record, spec, { requireClaims = false } = {}) {
    if (
        record?.uid !== spec.uid
        || record?.email !== spec.email
        || record?.displayName !== spec.displayName
    ) {
        throw new Error("A temporary Firebase Auth resource did not match its unique CI marker.");
    }
    if (
        requireClaims
        && (
            record?.customClaims?.[AUTH_CLAIM_MARKER] !== spec.marker
            || record?.customClaims?.mustChangePassword !== spec.expectedMustChangePassword
        )
    ) {
        throw new Error("A temporary Firebase Auth resource did not confirm its expected CI claims.");
    }
}

async function getAuthUserOrNull(lookup) {
    try {
        return await adminAuthCall(lookup);
    } catch (error) {
        if (isAuthUserNotFound(error)) return null;
        throw new Error("A temporary Firebase Auth resource lookup failed.");
    }
}

function isManagedCiAuthUser(record) {
    return (
        typeof record?.uid === "string" && record.uid.startsWith("roco-appcheck-ci-")
    ) || (
        typeof record?.displayName === "string"
        && record.displayName.startsWith(AUTH_DISPLAY_NAME_PREFIX)
    ) || (
        typeof record?.email === "string"
        && /^(?:update|complete)-[0-9a-f]{32}@example\.invalid$/u.test(record.email)
    );
}

async function listManagedCiAuthUsers(auth) {
    const managed = [];
    const pageTokens = new Set();
    let pageToken;
    for (let page = 0; page < MAX_AUTH_LIST_PAGES; page += 1) {
        let response;
        try {
            response = await adminAuthCall(() => auth.listUsers(AUTH_LIST_PAGE_SIZE, pageToken));
        } catch {
            throw new Error("Temporary Firebase Auth CI inventory lookup failed.");
        }
        if (!Array.isArray(response?.users)) {
            throw new Error("Temporary Firebase Auth CI inventory was invalid.");
        }
        managed.push(...response.users.filter(isManagedCiAuthUser));
        const nextPageToken = response.pageToken;
        if (nextPageToken === undefined) return managed;
        if (typeof nextPageToken !== "string" || nextPageToken.length === 0 ||
            pageTokens.has(nextPageToken)) {
            throw new Error("Temporary Firebase Auth CI inventory pagination was invalid.");
        }
        pageTokens.add(nextPageToken);
        pageToken = nextPageToken;
    }
    throw new Error("Temporary Firebase Auth CI inventory exceeded its safety bound.");
}

async function assertNoManagedCiAuthUsers(auth) {
    if ((await listManagedCiAuthUsers(auth)).length > 0) {
        throw new Error("A stale temporary Firebase Auth CI user requires operator review.");
    }
}

async function createEphemeralAuthUsers(auth, specs) {
    verifyAdminAuthApi(auth);
    if (!Array.isArray(specs) || specs.length !== AUTH_ACCOUNT_DEFINITIONS.length) {
        throw new Error("The Auth CI gate requires exactly two temporary user specifications.");
    }

    try {
        for (const spec of specs) {
            const created = await adminAuthCall(() => auth.createUser({
                uid: spec.uid,
                email: spec.email,
                emailVerified: true,
                disabled: false,
                displayName: spec.displayName,
                password: spec.password
            }));
            assertExactAuthUser(created, spec);
            await adminAuthCall(() => auth.setCustomUserClaims(spec.uid, {
                [AUTH_CLAIM_MARKER]: spec.marker,
                mustChangePassword: spec.expectedMustChangePassword
            }));
            const confirmed = await adminAuthCall(() => auth.getUser(spec.uid));
            assertExactAuthUser(confirmed, spec, { requireClaims: true });
        }
    } catch {
        throw new Error("Temporary Firebase Auth CI user provisioning failed.");
    }
}

async function revokeAndVerifyAuthUsers(auth, specs) {
    verifyAdminAuthApi(auth);
    let cleanupFailed = false;

    for (const spec of specs) {
        try {
            const byUid = await getAuthUserOrNull(() => auth.getUser(spec.uid));
            const byEmail = await getAuthUserOrNull(() => auth.getUserByEmail(spec.email));
            if (byUid !== null) assertExactAuthUser(byUid, spec);
            if (byEmail !== null) assertExactAuthUser(byEmail, spec);
            if ((byUid === null) !== (byEmail === null)) {
                throw new Error("Temporary Firebase Auth CI user inventory was inconsistent.");
            }

            if (byUid !== null) {
                try {
                    await adminAuthCall(() => auth.deleteUser(spec.uid));
                } catch {
                    // Final UID and email lookups decide whether a timed-out delete succeeded.
                }
            }

            const retainedByUid = await getAuthUserOrNull(() => auth.getUser(spec.uid));
            const retainedByEmail = await getAuthUserOrNull(() => auth.getUserByEmail(spec.email));
            if (retainedByUid !== null || retainedByEmail !== null) cleanupFailed = true;
        } catch {
            cleanupFailed = true;
        }
    }

    if (cleanupFailed) {
        throw new Error("Temporary Firebase Auth CI user cleanup could not be verified.");
    }
    await assertNoManagedCiAuthUsers(auth);
}

function authProbeAccounts(specs) {
    return Object.fromEntries(specs.map((spec) => [spec.name, {
        uid: spec.uid,
        email: spec.email,
        password: spec.password,
        expectedMarker: spec.marker,
        expectedMustChangePassword: spec.expectedMustChangePassword
    }]));
}

async function runCombinedLiveProbe({ debugToken, accounts }) {
    const combined = await runLiveAppCheckGate({
        probeImplementation: async () => ({
            publicResults: await runLiveAppCheckProbe({ debugToken }),
            authenticatedResults: await runLiveAuthenticatedAppCheckProbe({
                debugToken,
                accounts
            })
        })
    });
    return {
        results: combined.results.publicResults,
        authenticatedResults: combined.results.authenticatedResults,
        attempts: combined.attempts
    };
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

async function assertNoManagedCiDebugTokens(api, parent = APP_PARENT) {
    const inventory = await listAllDebugTokens(api, parent);
    if (inventory.some((resource) => resource.displayName?.startsWith(DISPLAY_NAME_PREFIX))) {
        throw new Error("A stale temporary App Check CI debug token requires operator review.");
    }
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
    if (verifiedInventory.some((resource) => (
        resource.displayName?.startsWith(DISPLAY_NAME_PREFIX)
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
        await assertNoManagedCiDebugTokens(api);
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

async function runAuthenticatedAppCheckCiGate({
    api,
    auth,
    tokenFactory = randomUUID,
    displayNameFactory = () => `${DISPLAY_NAME_PREFIX}${randomUUID()}`,
    accountSpecFactory = createEphemeralAuthAccountSpecs,
    probeImplementation = runCombinedLiveProbe
} = {}) {
    verifyAdminAuthApi(auth);
    const specs = accountSpecFactory();
    let gateResult;
    let primaryFailure;
    let cleanupError;

    try {
        await assertNoManagedCiAuthUsers(auth);
        await createEphemeralAuthUsers(auth, specs);
        gateResult = await runAppCheckCiGate({
            api,
            tokenFactory,
            displayNameFactory,
            probeImplementation: (debugToken) => probeImplementation({
                debugToken,
                accounts: authProbeAccounts(specs)
            })
        });
        verifyAuthenticatedProbeResults(gateResult?.authenticatedResults);
    } catch (error) {
        primaryFailure = error;
    } finally {
        try {
            await revokeAndVerifyAuthUsers(auth, specs);
        } catch (error) {
            cleanupError = error;
        }
        for (const spec of specs) spec.password = undefined;
    }

    if (cleanupError) throw cleanupError;
    if (primaryFailure) throw primaryFailure;
    return { ...gateResult, authCleanupVerified: true };
}

async function main() {
    let closeAdminAuth;
    try {
        const api = await createAdcAppCheckApi();
        const admin = await createAdcAdminAuth();
        closeAdminAuth = admin.close;
        const {
            results,
            authenticatedResults,
            attempts
        } = await runAuthenticatedAppCheckCiGate({ api, auth: admin.auth });
        for (const result of results) {
            process.stdout.write(`PASS ${result.name} [${CI_PROOF_MARKER}]\n`);
        }
        for (const result of authenticatedResults) {
            process.stdout.write(`PASS ${result.name} [${AUTH_PROOF_MARKER}]\n`);
        }
        process.stdout.write(`PASS appCheckDebugToken [${CLEANUP_PROOF_MARKER}]\n`);
        process.stdout.write(`PASS firebaseAuthUsers [${AUTH_CLEANUP_PROOF_MARKER}]\n`);
        process.stdout.write(
            `CI App Check probe passed in ${attempts} attempt(s); temporary credentials were never logged or persisted.\n`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "CI App Check probe failed.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    } finally {
        if (closeAdminAuth) {
            try {
                await closeAdminAuth();
            } catch {
                process.stderr.write("The temporary Firebase Admin client could not be closed.\n");
                process.exitCode = 1;
            }
        }
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();

export {
    AUTH_ACCOUNT_DEFINITIONS,
    AUTH_CLAIM_MARKER,
    AUTH_CLEANUP_PROOF_MARKER,
    AUTH_DISPLAY_NAME_PREFIX,
    AUTH_PROOF_MARKER,
    APP_ID,
    APP_PARENT,
    CI_PROOF_MARKER,
    CLEANUP_PROOF_MARKER,
    DEBUG_TOKEN_COLLECTION,
    DISPLAY_NAME_PREFIX,
    PROJECT_NUMBER,
    createAdcAppCheckApi,
    createAppCheckRestApi,
    createEphemeralAuthAccountSpecs,
    createEphemeralAuthUsers,
    isExpectedResourceName,
    listAllDebugTokens,
    revokeAndVerifyAuthUsers,
    revokeAndVerifyDebugToken,
    runAuthenticatedAppCheckCiGate,
    runAppCheckCiGate
};
