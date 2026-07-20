import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    DIAGNOSTIC_ENVIRONMENT_KEYS,
    EXPECTED_AUTHENTICATED_PROBES,
    EXPECTED_PROBES,
    RECAPTCHA_ENTERPRISE_SITE_KEY,
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
} from "../scripts/verify-live-app-check.mjs";

const TEST_DEBUG_TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const TEST_MARKER = "123e4567e89b42d3a456426614174000";
const TEST_PASSWORD = "Correct-Horse-Battery-Staple-42!";
const TEST_ACCOUNTS = Object.freeze({
    updateMyTeam: Object.freeze({
        uid: `roco-appcheck-ci-${TEST_MARKER}-update`,
        email: `update-${TEST_MARKER}@example.invalid`,
        password: TEST_PASSWORD,
        expectedMarker: TEST_DEBUG_TOKEN,
        expectedMustChangePassword: false
    }),
    completeInitialPasswordChange: Object.freeze({
        uid: `roco-appcheck-ci-${TEST_MARKER}-complete`,
        email: `complete-${TEST_MARKER}@example.invalid`,
        password: TEST_PASSWORD,
        expectedMarker: TEST_DEBUG_TOKEN,
        expectedMustChangePassword: true
    })
});
const AUTHENTICATED_RESULTS = Object.freeze(EXPECTED_AUTHENTICATED_PROBES.map(({ name }) => ({
    name,
    validBeforeCode: "functions/invalid-argument",
    missingAppCheckHttpStatus: 401,
    missingAppCheckContentType: "application/json",
    missingAppCheckErrorStatus: "UNAUTHENTICATED",
    validAfterCode: "functions/invalid-argument"
})));

test("live App Check probe uses only non-mutating validation payloads", () => {
    assert.deepEqual(EXPECTED_PROBES, [
        {
            name: "registerTeam",
            payload: {},
            expectedCode: "functions/invalid-argument"
        },
        {
            name: "getMyTeam",
            payload: { productionSmokeProbe: true },
            expectedCode: "functions/invalid-argument"
        }
    ]);
});

test("live App Check probe accepts only the expected handler validation boundary", () => {
    assert.doesNotThrow(() => verifyProbeResults([
        { name: "registerTeam", code: "functions/invalid-argument" },
        { name: "getMyTeam", code: "functions/invalid-argument" }
    ]));
    assert.throws(() => verifyProbeResults([
        { name: "registerTeam", code: "functions/unauthenticated" },
        { name: "getMyTeam", code: "functions/invalid-argument" }
    ]), /did not reach its safe validation boundary/u);
    assert.throws(() => verifyProbeResults([]), /incomplete result set/u);
});

test("live App Check probe rejects a live page configured for another project", () => {
    assert.doesNotThrow(() => verifyProductionProjectId("roco-spring-registration-2026"));
    assert.throws(
        () => verifyProductionProjectId("stale-or-unexpected-project"),
        /unexpected Firebase project/u
    );
});

test("authenticated App Check inventory covers both protected mutating callables", () => {
    assert.deepEqual(EXPECTED_AUTHENTICATED_PROBES, [
        { name: "updateMyTeam", expectedMustChangePassword: false },
        { name: "completeInitialPasswordChange", expectedMustChangePassword: true }
    ]);
    assert.doesNotThrow(() => validateAuthenticatedProbeAccounts(TEST_ACCOUNTS));
});

test("authenticated App Check results require valid-before, omitted, and valid-after proof", () => {
    assert.doesNotThrow(() => verifyAuthenticatedProbeResults(AUTHENTICATED_RESULTS));

    for (const unsafePatch of [
        { validBeforeCode: "functions/unauthenticated" },
        { missingAppCheckHttpStatus: 403 },
        { missingAppCheckContentType: "text/html" },
        { missingAppCheckErrorStatus: "INVALID_ARGUMENT" },
        { validAfterCode: "functions/internal" }
    ]) {
        const unsafe = AUTHENTICATED_RESULTS.map((result, index) => (
            index === 0 ? { ...result, ...unsafePatch } : result
        ));
        assert.throws(
            () => verifyAuthenticatedProbeResults(unsafe),
            /did not enforce the authenticated App Check boundary/u
        );
    }
    assert.throws(
        () => verifyAuthenticatedProbeResults([AUTHENTICATED_RESULTS[0]]),
        /incomplete result set/u
    );
    assert.throws(
        () => verifyAuthenticatedProbeResults([
            AUTHENTICATED_RESULTS[0],
            AUTHENTICATED_RESULTS[0]
        ]),
        /did not enforce/u
    );
});

test("authenticated App Check accounts are marker-bound and role-bound", () => {
    assert.throws(
        () => validateAuthenticatedProbeAccounts({
            ...TEST_ACCOUNTS,
            updateMyTeam: { ...TEST_ACCOUNTS.updateMyTeam, email: "person@gmail.com" }
        }),
        /probe account is invalid/u
    );
    assert.throws(
        () => validateAuthenticatedProbeAccounts({
            ...TEST_ACCOUNTS,
            completeInitialPasswordChange: {
                ...TEST_ACCOUNTS.completeInitialPasswordChange,
                expectedMustChangePassword: false
            }
        }),
        /probe account is invalid/u
    );
});

test("authenticated browser probe isolates Auth and deliberately omits App Check once", async () => {
    const events = [];
    let closed = false;
    let evaluatedSource = "";
    const results = await runLiveAuthenticatedAppCheckProbe({
        debugToken: TEST_DEBUG_TOKEN,
        accounts: TEST_ACCOUNTS,
        launch: async (options) => {
            assert.deepEqual(options, { headless: true });
            return {
                async newPage() {
                    return {
                        async addInitScript(script, value) {
                            if (String(script).includes("FIREBASE_APPCHECK_DEBUG_TOKEN")) {
                                events.push("token-init");
                                assert.equal(value, TEST_DEBUG_TOKEN);
                            } else {
                                events.push("console-filter");
                                assert.match(String(script), /App Check debug token:/u);
                            }
                        },
                        async goto(url) {
                            events.push("goto");
                            assert.equal(new URL(url).origin, "https://roco-spring.github.io");
                        },
                        async waitForFunction() {
                            events.push("ready");
                        },
                        async evaluate(implementation, argument) {
                            evaluatedSource = String(implementation);
                            assert.deepEqual(argument.probeAccounts, [
                                { name: "updateMyTeam", ...TEST_ACCOUNTS.updateMyTeam },
                                {
                                    name: "completeInitialPasswordChange",
                                    ...TEST_ACCOUNTS.completeInitialPasswordChange
                                }
                            ]);
                            assert.equal(
                                argument.recaptchaEnterpriseSiteKey,
                                RECAPTCHA_ENTERPRISE_SITE_KEY
                            );
                            return AUTHENTICATED_RESULTS;
                        }
                    };
                },
                async close() {
                    closed = true;
                }
            };
        }
    });

    assert.deepEqual(results, AUTHENTICATED_RESULTS);
    assert.deepEqual(events, ["console-filter", "token-init", "goto", "ready"]);
    assert.equal(closed, true);
    assert.match(evaluatedSource, /initializeAppCheck/u);
    assert.match(evaluatedSource, /inMemoryPersistence/u);
    assert.match(evaluatedSource, /getIdTokenResult/u);
    assert.match(evaluatedSource, /rocoAppCheckCiMarker/u);
    assert.match(evaluatedSource, /deleteApp/u);
    assert.match(evaluatedSource, /Authorization/u);
    assert.match(evaluatedSource, /AbortSignal\.timeout/u);
    assert.doesNotMatch(evaluatedSource, /X-Firebase-AppCheck/u);
});

test("authenticated probe configuration stays aligned with the production page", async () => {
    const source = await readFile(new URL("../assets/firebase-config.js", import.meta.url), "utf8");
    assert.match(source, new RegExp(RECAPTCHA_ENTERPRISE_SITE_KEY, "u"));
});

test("diagnostic settings are removed before Playwright can be lazy-loaded", async () => {
    const sourceUrl = new URL("../scripts/verify-live-app-check.mjs", import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    assert.doesNotMatch(source, /^import .*@playwright\/test/mu);
    assert.match(source, /await import\("@playwright\/test"\)/u);

    const environment = Object.fromEntries(
        DIAGNOSTIC_ENVIRONMENT_KEYS.map((key) => [key, "unsafe-diagnostic-setting"])
    );
    sanitizeDiagnosticEnvironment(environment);
    assert.deepEqual(environment, {});
});

test("browser evaluation deadline rejects a stalled page", async () => {
    await assert.rejects(
        evaluateWithDeadline(
            { evaluate: async () => new Promise(() => {}) },
            () => undefined,
            {},
            5
        ),
        /exceeded its deadline/u
    );
});

test("live App Check probe injects an optional UUID4 before navigation", async () => {
    const debugToken = TEST_DEBUG_TOKEN;
    const events = [];
    let evaluations = 0;
    let closed = false;
    const expected = [
        { name: "registerTeam", code: "functions/invalid-argument" },
        { name: "getMyTeam", code: "functions/invalid-argument" }
    ];

    const results = await runLiveAppCheckProbe({
        debugToken,
        launch: async (options) => {
            assert.deepEqual(options, { headless: true });
            return {
                async newPage() {
                    return {
                        async addInitScript(script, value) {
                            if (String(script).includes("FIREBASE_APPCHECK_DEBUG_TOKEN")) {
                                events.push("token-init");
                                assert.equal(value, debugToken);
                            } else {
                                events.push("console-filter");
                                assert.match(String(script), /App Check debug token:/u);
                            }
                        },
                        async goto(url) {
                            events.push("goto");
                            assert.equal(new URL(url).origin, "https://roco-spring.github.io");
                        },
                        async waitForFunction() {
                            events.push("ready");
                        },
                        async evaluate(_implementation, argument) {
                            evaluations += 1;
                            if (evaluations === 1) return "roco-spring-registration-2026";
                            assert.deepEqual(
                                argument.probes,
                                EXPECTED_PROBES.map(({ name, payload }) => ({ name, payload }))
                            );
                            return expected;
                        }
                    };
                },
                async close() {
                    closed = true;
                }
            };
        }
    });

    assert.deepEqual(results, expected);
    assert.deepEqual(events.slice(0, 3), ["console-filter", "token-init", "goto"]);
    assert.equal(closed, true);
    assert.equal(isUuidV4(debugToken), true);
});

test("live App Check probe rejects malformed injected credentials before browser launch", async () => {
    let launches = 0;
    await assert.rejects(
        runLiveAppCheckProbe({
            debugToken: "not-a-debug-token",
            launch: async () => {
                launches += 1;
            }
        }),
        /must be a UUID4/u
    );
    assert.equal(launches, 0);
});

test("live App Check gate retries transient probe failures with a strict bound", async () => {
    let calls = 0;
    const delays = [];
    const expected = [
        { name: "registerTeam", code: "functions/invalid-argument" },
        { name: "getMyTeam", code: "functions/invalid-argument" }
    ];
    const recovered = await runLiveAppCheckGate({
        maxAttempts: 3,
        retryDelayMs: 25,
        probeImplementation: async () => {
            calls += 1;
            if (calls < 3) throw new Error("transient browser failure");
            return expected;
        },
        sleepImplementation: async (milliseconds) => delays.push(milliseconds)
    });

    assert.deepEqual(recovered, { results: expected, attempts: 3 });
    assert.deepEqual(delays, [25, 50]);

    calls = 0;
    await assert.rejects(
        runLiveAppCheckGate({
            maxAttempts: 2,
            retryDelayMs: 0,
            probeImplementation: async () => {
                calls += 1;
                throw new Error("persistent browser failure");
            },
            sleepImplementation: async () => {}
        }),
        /after 2 attempts/u
    );
    assert.equal(calls, 2);
});
