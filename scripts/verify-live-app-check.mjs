#!/usr/bin/env node

import process from "node:process";
import { isDeepStrictEqual } from "node:util";
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
    }),
    Object.freeze({
        name: "refreshLeaderboard",
        payload: Object.freeze({ unexpected: true }),
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
const EXPECTED_LEADERBOARD_BASELINES = Object.freeze({
    "optical-flow": {
        spring: 0.9925,
        medianDisagreement: 4.16,
        robustSpringProxy: 6.03,
        methodCount: 8
    },
    "stereo-matching": {
        spring: 3.4545,
        medianDisagreement: 16.18,
        robustSpringProxy: 18.4505,
        methodCount: 4
    },
    "scene-flow": {
        methodCount: 2,
        spring: { disparity1Abs: 7.466, disparity2Abs: 7.5935, flowEpe: 2.527 },
        medianDisagreement: { disparity1Abs: 17.005, disparity2Abs: 0.215, flowEpe: 4.21 },
        robustSpringProxy: { disparity1Abs: 24.471, disparity2Abs: 7.8085, flowEpe: 6.737 }
    }
});
const LEADERBOARD_TRACKS = new Set([
    "optical-flow",
    "stereo-matching",
    "scene-flow",
    "cross-task"
]);
const QUANTITATIVE_TRACKS = new Set([
    "optical-flow",
    "stereo-matching",
    "scene-flow"
]);
const REGISTRATION_TRACKS = new Set([...QUANTITATIVE_TRACKS, "exploration"]);
const KNOWN_PUBLIC_TEAM_IDS = new Set(
    Array.from({ length: 25 }, (_value, index) => `RoCo-${index + 8}`)
);

function isPlainObject(value) {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
    return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function validIsoTimestamp(value) {
    return typeof value === "string"
        && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString() === value;
}

function verifyPublicLeaderboardResult(result, track) {
    const allowed = new Set([
        "rankChange", "score", "springMetric", "robustSpringMetric",
        "springTerm", "robustSpringTerm", "submittedAt", "benchmarkMethod",
        "benchmarkUrl", "matchBasis", "springComponents", "robustSpringComponents"
    ]);
    const required = [
        "rankChange", "score", "springMetric", "robustSpringMetric",
        "springTerm", "robustSpringTerm", "submittedAt", "benchmarkMethod",
        "benchmarkUrl", "matchBasis"
    ];
    if (!hasOnlyKeys(result, allowed) || required.some((key) => !Object.hasOwn(result, key))) {
        throw new Error("The live leaderboard result schema is invalid.");
    }
    const expectedMatchBasis = track === "cross-task"
        ? result.matchBasis === "cross-task"
        : ["team-id", "team-name"].includes(result.matchBasis);
    if (!Number.isSafeInteger(result.rankChange)
        || Math.abs(result.rankChange) > 10_000
        || [result.score, result.springMetric, result.robustSpringMetric,
            result.springTerm, result.robustSpringTerm]
            .some((value) => (
                typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9
            ))
        || !validIsoTimestamp(result.submittedAt)
        || typeof result.benchmarkMethod !== "string"
        || result.benchmarkMethod.length === 0
        || result.benchmarkMethod.length > 240
        || /[\u0000-\u001f\u007f]/u.test(result.benchmarkMethod)
        || !expectedMatchBasis) {
        throw new Error("The live leaderboard result values are invalid.");
    }
    let benchmarkUrl;
    try {
        benchmarkUrl = new URL(result.benchmarkUrl);
    } catch {
        throw new Error("The live leaderboard result URL is invalid.");
    }
    const expectedBenchmarkUrl = track === "cross-task"
        ? benchmarkUrl.href === "https://spring-benchmark.org/"
        : /^https:\/\/spring-benchmark\.org\/\d{1,9}\/$/u.test(benchmarkUrl.href);
    if (!expectedBenchmarkUrl || benchmarkUrl.username || benchmarkUrl.password) {
        throw new Error("The live leaderboard result URL is invalid.");
    }
    const componentKeys = ["springComponents", "robustSpringComponents"];
    if (track === "scene-flow" && componentKeys.some((key) => !Object.hasOwn(result, key))) {
        throw new Error("The live leaderboard Scene Flow components are incomplete.");
    }
    if (track !== "scene-flow" && componentKeys.some((key) => Object.hasOwn(result, key))) {
        throw new Error("The live leaderboard result has unexpected components.");
    }
    for (const key of componentKeys) {
        if (!Object.hasOwn(result, key)) continue;
        const components = result[key];
        if (!hasOnlyKeys(components, new Set(["d1", "d2", "flow"]))
            || ["d1", "d2", "flow"].some((component) => (
                typeof components[component] !== "number"
                || !Number.isFinite(components[component])
                || components[component] < 0
            ))) {
            throw new Error("The live leaderboard component schema is invalid.");
        }
    }
}

function verifyLiveLeaderboardSnapshot(snapshot) {
    const topLevelKeys = new Set([
        "schemaVersion", "updatedAt", "sourceLabel", "scoringConvention",
        "baselines", "teams", "syncStatus"
    ]);
    if (!hasOnlyKeys(snapshot, topLevelKeys)
        || Object.keys(snapshot).length !== topLevelKeys.size
        || snapshot.schemaVersion !== 2
        || !validIsoTimestamp(snapshot.updatedAt)
        || typeof snapshot.sourceLabel !== "string"
        || snapshot.sourceLabel.length === 0
        || snapshot.sourceLabel.length > 200
        || snapshot.scoringConvention !== "organizer-approved-additive-proxy"
        || !["fresh", "cache-hit"].includes(snapshot.syncStatus)
        || !isDeepStrictEqual(snapshot.baselines, EXPECTED_LEADERBOARD_BASELINES)
        || !Array.isArray(snapshot.teams)
        || snapshot.teams.length < 25
        || snapshot.teams.length > 10_000) {
        throw new Error("The live leaderboard snapshot schema is invalid.");
    }

    const teamKeys = new Set([
        "teamId", "teamName", "registeredTracks", "results", "submissionHistory"
    ]);
    const seenTeamIds = new Set();
    for (const team of snapshot.teams) {
        const idMatch = typeof team?.teamId === "string" ? /^RoCo-([1-9]\d*)$/u.exec(team.teamId) : null;
        if (!hasOnlyKeys(team, teamKeys)
            || Object.keys(team).length !== teamKeys.size
            || !idMatch
            || Number(idMatch[1]) < 8
            || seenTeamIds.has(team.teamId)
            || typeof team.teamName !== "string"
            || team.teamName.length === 0
            || team.teamName.length > 120
            || /[\u0000-\u001f\u007f]/u.test(team.teamName)
            || !Array.isArray(team.registeredTracks)
            || team.registeredTracks.length === 0
            || new Set(team.registeredTracks).size !== team.registeredTracks.length
            || team.registeredTracks.some((track) => !REGISTRATION_TRACKS.has(track))
            || !hasOnlyKeys(team.results, LEADERBOARD_TRACKS)
            || !hasOnlyKeys(team.submissionHistory, QUANTITATIVE_TRACKS)) {
            throw new Error("The live leaderboard team projection is invalid.");
        }
        seenTeamIds.add(team.teamId);
        for (const [track, result] of Object.entries(team.results)) {
            const registeredForResult = track === "cross-task"
                ? [...QUANTITATIVE_TRACKS].every((candidate) => team.registeredTracks.includes(candidate))
                : team.registeredTracks.includes(track);
            if (!LEADERBOARD_TRACKS.has(track) || !registeredForResult) {
                throw new Error("The live leaderboard result track is invalid.");
            }
            verifyPublicLeaderboardResult(result, track);
        }
        for (const [track, history] of Object.entries(team.submissionHistory)) {
            if (!QUANTITATIVE_TRACKS.has(track)
                || !Array.isArray(history)
                || history.length > 20) {
                throw new Error("The live leaderboard history is invalid.");
            }
            if (!team.registeredTracks.includes(track)) {
                throw new Error("The live leaderboard history track is invalid.");
            }
            history.forEach((result) => verifyPublicLeaderboardResult(result, track));
        }
    }
    if ([...KNOWN_PUBLIC_TEAM_IDS].some((teamId) => !seenTeamIds.has(teamId))) {
        throw new Error("The live leaderboard omitted a known public team.");
    }
    return Object.freeze({ teamCount: snapshot.teams.length, syncStatus: snapshot.syncStatus });
}

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

        // Prove the real read-only success path with a valid App Check token.
        // The full response is validated in memory and is never printed.
        const leaderboardSnapshot = await evaluateWithDeadline(
            page,
            async ({ firebaseVersion, projectId, region }) => {
                const [{ getApp }, { getFunctions, httpsCallable }] = await Promise.all([
                    import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`),
                    import(`https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-functions.js`)
                ]);
                const productionApp = getApp();
                if (productionApp.options.projectId !== projectId) {
                    throw new Error("Live Firebase project identity changed during the leaderboard probe.");
                }
                const productionFunctions = getFunctions(productionApp, region);
                const response = await httpsCallable(
                    productionFunctions,
                    "refreshLeaderboard",
                    { timeout: 60_000 }
                )({ force: false });
                return response.data;
            },
            {
                firebaseVersion: FIREBASE_VERSION,
                projectId: PROJECT_ID,
                region: FUNCTIONS_REGION
            },
            PUBLIC_PROBE_TIMEOUT_MS
        );
        verifyLiveLeaderboardSnapshot(leaderboardSnapshot);
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
        process.stdout.write("PASS refreshLeaderboard [VALID_APP_CHECK_TO_PUBLIC_SNAPSHOT]\n");
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
    KNOWN_PUBLIC_TEAM_IDS,
    EXPECTED_AUTHENTICATED_PROBES,
    EXPECTED_LEADERBOARD_BASELINES,
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
    verifyLiveLeaderboardSnapshot,
    verifyProductionProjectId,
    verifyProbeResults
};
