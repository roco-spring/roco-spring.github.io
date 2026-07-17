import assert from "node:assert/strict";
import test from "node:test";

import {
    EXPECTED_PROBES,
    isUuidV4,
    runLiveAppCheckGate,
    runLiveAppCheckProbe,
    verifyProductionProjectId,
    verifyProbeResults
} from "../scripts/verify-live-app-check.mjs";

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

test("live App Check probe injects an optional UUID4 before navigation", async () => {
    const debugToken = "123e4567-e89b-42d3-a456-426614174000";
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
                            events.push("init");
                            assert.match(String(script), /FIREBASE_APPCHECK_DEBUG_TOKEN/u);
                            assert.equal(value, debugToken);
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
    assert.deepEqual(events.slice(0, 2), ["init", "goto"]);
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
