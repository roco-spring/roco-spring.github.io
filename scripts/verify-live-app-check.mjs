#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const DIAGNOSTIC_ENVIRONMENT_KEYS = Object.freeze([
    "DEBUG",
    "DEBUG_FILE",
    "FIREBASE_DEBUG",
    "NODE_DEBUG",
    "PWDEBUG"
]);
function sanitizeDiagnosticEnvironment(environment = process.env) {
    for (const key of DIAGNOSTIC_ENVIRONMENT_KEYS) delete environment[key];
}
sanitizeDiagnosticEnvironment();

const LIVE_REGISTRATION_URL = "https://roco-spring.github.io/team-registration.html";
const PROJECT_ID = "roco-spring-registration-2026";
const FIREBASE_VERSION = "12.16.0";
const FUNCTIONS_REGION = "europe-west3";
const RECAPTCHA_ENTERPRISE_SITE_KEY = "6LfSN1UtAAAAAOCXmwtsu_brRvLWPnwlHixppEZz";
const PUBLIC_PROBE_TIMEOUT_MS = 150_000;
const AUTHENTICATED_PROBE_TIMEOUT_MS = 240_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 3_000;
const EXPECTED_PROBES = Object.freeze([
    Object.freeze({
        name: "registerTeam",
        payload: Object.freeze({}),
        expectedCode: "functions/invalid-argument"
    }),
    Object.freeze({
        name: "getMyTeam",
        payload: Object.freeze({ productionSmokeProbe: true }),
        expectedCode: "functions/invalid-argument"
    })
]);
const EXPECTED_AUTHENTICATED_PROBES = Object.freeze([
    Object.freeze({
        name: "updateMyTeam",
        expectedMustChangePassword: false
    }),
    Object.freeze({
        name: "completeInitialPasswordChange",
        expectedMustChangePassword: true
    })
]);

function verifyProbeResults(results) {
    if (!Array.isArray(results) || results.length !== EXPECTED_PROBES.length) {
        throw new Error("Live App Check probe returned an incomplete result set.");
    }

    for (const expected of EXPECTED_PROBES) {
        const result = results.find((candidate) => candidate?.name === expected.name);
        if (result?.code !== expected.expectedCode) {
            const safeCode = typeof result?.code === "string" ? result.code : "no-safe-code";
            throw new Error(
                `${expected.name} did not reach its safe validation boundary (received ${safeCode}).`
            );
        }
    }
}

function verifyAuthenticatedProbeResults(results) {
    if (!Array.isArray(results) || results.length !== EXPECTED_AUTHENTICATED_PROBES.length) {
        throw new Error("Live authenticated App Check probe returned an incomplete result set.");
    }

    for (const expected of EXPECTED_AUTHENTICATED_PROBES) {
        const result = results.find((candidate) => candidate?.name === expected.name);
        if (
            result?.validBeforeCode !== "functions/invalid-argument"
            || result?.missingAppCheckHttpStatus !== 401
            || result?.missingAppCheckContentType !== "application/json"
            || result?.missingAppCheckErrorStatus !== "UNAUTHENTICATED"
            || result?.validAfterCode !== "functions/invalid-argument"
        ) {
            throw new Error(`${expected.name} did not enforce the authenticated App Check boundary.`);
        }
    }
}

function validateAuthenticatedProbeAccounts(accounts) {
    if (typeof accounts !== "object" || accounts === null) {
        throw new Error("Authenticated App Check probe accounts are required.");
    }

    for (const expected of EXPECTED_AUTHENTICATED_PROBES) {
        const account = accounts[expected.name];
        const suffix = expected.name === "updateMyTeam" ? "update" : "complete";
        const compactMarker = typeof account?.expectedMarker === "string"
            ? account.expectedMarker.replaceAll("-", "").toLowerCase()
            : "";
        if (
            typeof account !== "object"
            || account === null
            || !isUuidV4(account.expectedMarker)
            || account.uid !== `roco-appcheck-ci-${compactMarker}-${suffix}`
            || account.email !== `${suffix}-${compactMarker}@example.invalid`
            || typeof account.password !== "string"
            || account.password.length < 20
            || account.password.length > 128
            || /[\r\n]/u.test(account.password)
            || account.expectedMustChangePassword !== expected.expectedMustChangePassword
        ) {
            throw new Error(`The ${expected.name} App Check probe account is invalid.`);
        }
    }
}

function verifyProductionProjectId(projectId) {
    if (projectId !== PROJECT_ID) {
        throw new Error("The live registration page targets an unexpected Firebase project.");
    }
}

async function launchChromium(options) {
    const { chromium } = await import("@playwright/test");
    return chromium.launch(options);
}

async function evaluateWithDeadline(page, implementation, argument, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            page.evaluate(implementation, argument),
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("The live browser probe exceeded its deadline.")),
                    timeoutMs
                );
            })
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function installAppCheckConsoleFilter(page) {
    await page.addInitScript(() => {
        const methods = ["debug", "info", "log", "warn"];
        for (const method of methods) {
            const original = console[method]?.bind(console);
            if (!original) continue;
            console[method] = (...values) => {
                if (values.some((value) => (
                    typeof value === "string" && value.includes("App Check debug token:")
                ))) return;
                original(...values);
            };
        }
    });
}

async function runLiveAppCheckProbe({
    url = LIVE_REGISTRATION_URL,
    launch = launchChromium,
    debugToken
} = {}) {
    if (debugToken !== undefined && !isUuidV4(debugToken)) {
        throw new Error("The injected App Check debug token must be a UUID4 value.");
    }

    const browser = await launch({ headless: true });

    try {
        const page = await browser.newPage();
        if (debugToken !== undefined) {
            await installAppCheckConsoleFilter(page);
            await page.addInitScript((token) => {
                self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
            }, debugToken);
        }
        const target = new URL(url);
        target.searchParams.set("production-smoke", Date.now().toString(36));
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(
            () => window.rocoTeamRegistrationReady === true,
            undefined,
            { timeout: 60_000 }
        );

        const liveProjectId = await evaluateWithDeadline(page, async (firebaseVersion) => {
            const { getApp } = await import(
                `https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`
            );
            return getApp().options.projectId;
        }, FIREBASE_VERSION, PUBLIC_PROBE_TIMEOUT_MS);
        verifyProductionProjectId(liveProjectId);

        const results = await evaluateWithDeadline(
            page,
            async ({ firebaseVersion, probes, projectId }) => {
            const [{ getApp }, { getFunctions, httpsCallable }] = await Promise.all([
                import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`),
                import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-functions.js`)
            ]);
            const productionApp = getApp();
            if (productionApp.options.projectId !== projectId) {
                throw new Error("Live Firebase project identity changed during the probe.");
            }
            const productionFunctions = getFunctions(productionApp, "europe-west3");

            return Promise.all(probes.map(async ({ name, payload }) => {
                try {
                    await httpsCallable(productionFunctions, name, { timeout: 60_000 })(payload);
                    return { name, code: "unexpected-success" };
                } catch (error) {
                    return {
                        name,
                        code: typeof error?.code === "string" ? error.code : "unknown-error"
                    };
                }
            }));
            },
            {
                firebaseVersion: FIREBASE_VERSION,
                projectId: PROJECT_ID,
                probes: EXPECTED_PROBES.map(({ name, payload }) => ({ name, payload }))
            },
            PUBLIC_PROBE_TIMEOUT_MS
        );

        verifyProbeResults(results);
        return results;
    } finally {
        await browser.close();
    }
}

async function runLiveAuthenticatedAppCheckProbe({
    url = LIVE_REGISTRATION_URL,
    launch = launchChromium,
    debugToken,
    accounts
} = {}) {
    if (!isUuidV4(debugToken)) {
        throw new Error("The authenticated App Check debug token must be a UUID4 value.");
    }
    validateAuthenticatedProbeAccounts(accounts);

    const browser = await launch({ headless: true });

    try {
        const page = await browser.newPage();
        await installAppCheckConsoleFilter(page);
        await page.addInitScript((token) => {
            self.FIREBASE_APPCHECK_DEBUG_TOKEN = token;
        }, debugToken);
        const target = new URL(url);
        target.searchParams.set("production-auth-smoke", Date.now().toString(36));
        await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(
            () => window.rocoTeamRegistrationReady === true,
            undefined,
            { timeout: 60_000 }
        );

        const results = await evaluateWithDeadline(
            page,
            async ({
                firebaseVersion,
                projectId,
                region,
                recaptchaEnterpriseSiteKey,
                probeAccounts
            }) => {
            const [
                { deleteApp, getApp, initializeApp },
                {
                    getAuth,
                    getIdTokenResult,
                    inMemoryPersistence,
                    setPersistence,
                    signInWithEmailAndPassword,
                    signOut
                },
                { initializeAppCheck, ReCaptchaEnterpriseProvider },
                { getFunctions, httpsCallable }
            ] = await Promise.all([
                import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`),
                import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-auth.js`),
                import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app-check.js`),
                import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-functions.js`)
            ]);
            const productionOptions = getApp().options;
            if (productionOptions.projectId !== projectId) {
                throw new Error("Live Firebase project identity changed during the authenticated probe.");
            }

            const invokeCallable = async (callable) => {
                try {
                    await callable({});
                    return "unexpected-success";
                } catch (error) {
                    return typeof error?.code === "string" ? error.code : "unknown-error";
                }
            };
            const invokeWithoutAppCheck = async (name, idToken) => {
                const response = await fetch(
                    `https://${region}-${projectId}.cloudfunctions.net/${name}`,
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${idToken}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({ data: {} }),
                        signal: AbortSignal.timeout(60_000)
                    }
                );
                let errorStatus = "invalid-json-response";
                try {
                    const body = await response.json();
                    if (typeof body?.error?.status === "string") {
                        errorStatus = body.error.status;
                    }
                } catch {
                    // The safe status marker below is enough to fail the gate.
                }
                const contentType = response.headers.get("content-type")
                    ?.split(";", 1)[0]
                    ?.trim()
                    ?.toLowerCase() ?? "missing-content-type";
                return { httpStatus: response.status, contentType, errorStatus };
            };

            const probeResults = [];
            for (const probe of probeAccounts) {
                const app = initializeApp(
                    productionOptions,
                    `roco-appcheck-ci-${crypto.randomUUID()}`
                );
                initializeAppCheck(app, {
                    provider: new ReCaptchaEnterpriseProvider(recaptchaEnterpriseSiteKey),
                    isTokenAutoRefreshEnabled: false
                });
                const auth = getAuth(app);
                const functions = getFunctions(app, region);
                let signedIn = false;

                try {
                    await setPersistence(auth, inMemoryPersistence);
                    const credential = await signInWithEmailAndPassword(
                        auth,
                        probe.email,
                        probe.password
                    );
                    signedIn = true;
                    if (credential.user.uid !== probe.uid) {
                        throw new Error("The temporary App Check user identity did not match.");
                    }
                    const tokenResult = await getIdTokenResult(credential.user, true);
                    const observedMustChangePassword = tokenResult.claims.mustChangePassword === true;
                    if (observedMustChangePassword !== probe.expectedMustChangePassword) {
                        throw new Error("The temporary App Check user received unexpected claims.");
                    }
                    if (tokenResult.claims.rocoAppCheckCiMarker !== probe.expectedMarker) {
                        throw new Error("The temporary App Check user marker did not match.");
                    }

                    const callable = httpsCallable(functions, probe.name, { timeout: 60_000 });
                    const validBeforeCode = await invokeCallable(callable);
                    const missing = await invokeWithoutAppCheck(probe.name, tokenResult.token);
                    const validAfterCode = await invokeCallable(callable);
                    probeResults.push({
                        name: probe.name,
                        validBeforeCode,
                        missingAppCheckHttpStatus: missing.httpStatus,
                        missingAppCheckContentType: missing.contentType,
                        missingAppCheckErrorStatus: missing.errorStatus,
                        validAfterCode
                    });
                } finally {
                    if (signedIn) {
                        try {
                            await signOut(auth);
                        } catch {
                            // Closing and deleting the isolated app still discards its in-memory session.
                        }
                    }
                    await deleteApp(app);
                }
            }
            return probeResults;
            },
            {
                firebaseVersion: FIREBASE_VERSION,
                projectId: PROJECT_ID,
                region: FUNCTIONS_REGION,
                recaptchaEnterpriseSiteKey: RECAPTCHA_ENTERPRISE_SITE_KEY,
                probeAccounts: EXPECTED_AUTHENTICATED_PROBES.map(({ name }) => ({
                    name,
                    ...accounts[name]
                }))
            },
            AUTHENTICATED_PROBE_TIMEOUT_MS
        );

        verifyAuthenticatedProbeResults(results);
        return results;
    } finally {
        await browser.close();
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isUuidV4(value) {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function runLiveAppCheckGate({
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    probeImplementation = runLiveAppCheckProbe,
    sleepImplementation = sleep
} = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
        throw new Error("Live App Check maxAttempts must be an integer from 1 through 5.");
    }
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
        throw new Error("Live App Check retryDelayMs must be between 0 and 30000.");
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const results = await probeImplementation();
            return { results, attempts: attempt };
        } catch {
            if (attempt === maxAttempts) {
                throw new Error(
                    `Live App Check probe did not reach the safe validation boundary after ${attempt} attempts.`
                );
            }
            await sleepImplementation(retryDelayMs * attempt);
        }
    }

    throw new Error("Live App Check probe exhausted without a result.");
}

async function main() {
    try {
        const { results, attempts } = await runLiveAppCheckGate();
        for (const result of results) {
            process.stdout.write(`PASS ${result.name} [VALID_APP_CHECK_TO_VALIDATION_BOUNDARY]\n`);
        }
        process.stdout.write(
            `Live App Check probe passed in ${attempts} attempt(s) without credentials, team creation, or private response logging.\n`
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Live App Check probe failed.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main();

export {
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_RETRY_DELAY_MS,
    DIAGNOSTIC_ENVIRONMENT_KEYS,
    EXPECTED_PROBES,
    EXPECTED_AUTHENTICATED_PROBES,
    FUNCTIONS_REGION,
    LIVE_REGISTRATION_URL,
    PROJECT_ID,
    PUBLIC_PROBE_TIMEOUT_MS,
    RECAPTCHA_ENTERPRISE_SITE_KEY,
    AUTHENTICATED_PROBE_TIMEOUT_MS,
    evaluateWithDeadline,
    isUuidV4,
    runLiveAuthenticatedAppCheckProbe,
    runLiveAppCheckGate,
    runLiveAppCheckProbe,
    sanitizeDiagnosticEnvironment,
    validateAuthenticatedProbeAccounts,
    verifyAuthenticatedProbeResults,
    verifyProductionProjectId,
    verifyProbeResults
};
