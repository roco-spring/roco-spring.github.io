import assert from "node:assert/strict";
import test from "node:test";

import {
    EXPECTED_PROBES,
    runLiveAppCheckGate,
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
