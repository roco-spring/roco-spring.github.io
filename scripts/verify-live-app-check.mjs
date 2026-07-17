#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const LIVE_REGISTRATION_URL = "https://roco-spring.github.io/team-registration.html";
const PROJECT_ID = "roco-spring-registration-2026";
const FIREBASE_VERSION = "12.16.0";
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

function verifyProductionProjectId(projectId) {
    if (projectId !== PROJECT_ID) {
        throw new Error("The live registration page targets an unexpected Firebase project.");
    }
}

async function runLiveAppCheckProbe({
    url = LIVE_REGISTRATION_URL,
    launch = (options) => chromium.launch(options),
    debugToken
} = {}) {
    if (debugToken !== undefined && !isUuidV4(debugToken)) {
        throw new Error("The injected App Check debug token must be a UUID4 value.");
    }

    const browser = await launch({ headless: true });

    try {
        const page = await browser.newPage();
        if (debugToken !== undefined) {
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

        const liveProjectId = await page.evaluate(async (firebaseVersion) => {
            const { getApp } = await import(
                `https://www.gstatic.com/firebasejs/${firebaseVersion}/firebase-app.js`
            );
            return getApp().options.projectId;
        }, FIREBASE_VERSION);
        verifyProductionProjectId(liveProjectId);

        const results = await page.evaluate(async ({ firebaseVersion, probes, projectId }) => {
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
        }, {
            firebaseVersion: FIREBASE_VERSION,
            projectId: PROJECT_ID,
            probes: EXPECTED_PROBES.map(({ name, payload }) => ({ name, payload }))
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
    EXPECTED_PROBES,
    LIVE_REGISTRATION_URL,
    PROJECT_ID,
    isUuidV4,
    runLiveAppCheckGate,
    runLiveAppCheckProbe,
    verifyProductionProjectId,
    verifyProbeResults
};
