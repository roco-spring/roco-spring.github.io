import assert from "node:assert/strict";
import test from "node:test";

import {
    FunctionSecretConfigurationError,
    buildSecretCleanupPlan,
    configureFunctionSecrets,
    parseMode
} from "../scripts/configure-function-secrets.mjs";

const PROJECT_ID = "roco-spring-registration-2026";
const REGION = "europe-west3";

function resource(functionId, secrets = []) {
    return {
        name: `projects/${PROJECT_ID}/locations/${REGION}/functions/${functionId}`,
        serviceConfig: { secretEnvironmentVariables: secrets }
    };
}

function binding(key) {
    return { key, secret: key, version: "1", projectId: PROJECT_ID };
}

function healthyInventory(secretFreeBindings = {}) {
    return [
        resource("registerTeam", [binding("RATE_LIMIT_HMAC_SECRET")]),
        resource("getMyTeam", secretFreeBindings.getMyTeam),
        resource("updateMyTeam", secretFreeBindings.updateMyTeam),
        resource(
            "completeInitialPasswordChange",
            secretFreeBindings.completeInitialPasswordChange
        ),
        resource("reconcileRegistrations", [
            binding("GOOGLE_OAUTH_CLIENT_SECRET"),
            binding("GOOGLE_OAUTH_REFRESH_TOKEN")
        ])
    ];
}

test("mode is explicit", () => {
    assert.equal(parseMode(["--apply"]), "apply");
    assert.equal(parseMode(["--verify"]), "verify");
    assert.throws(() => parseMode([]), FunctionSecretConfigurationError);
});

test("cleanup plan identifies only stale bindings on secret-free callables", () => {
    for (const functionId of [
        "getMyTeam",
        "updateMyTeam",
        "completeInitialPasswordChange"
    ]) {
        assert.deepEqual(
            buildSecretCleanupPlan(healthyInventory({
                [functionId]: [
                    binding("GOOGLE_OAUTH_CLIENT_SECRET"),
                    binding("GOOGLE_OAUTH_REFRESH_TOKEN")
                ]
            })),
            [functionId]
        );
    }
});

test("apply preflights, clears stale bindings, waits, and verifies read-back", async () => {
    let inventory = healthyInventory({
        getMyTeam: [binding("GOOGLE_OAUTH_CLIENT_SECRET")],
        updateMyTeam: [binding("GOOGLE_OAUTH_CLIENT_SECRET")],
        completeInitialPasswordChange: [binding("GOOGLE_OAUTH_CLIENT_SECRET")]
    });
    const events = [];
    const registry = {
        async getFunction(functionId) {
            events.push(`get:${functionId}`);
            return inventory.find((entry) => entry.name.endsWith(`/${functionId}`));
        },
        async clearSecrets(functionId) {
            events.push(`clear:${functionId}`);
            inventory = healthyInventory();
            return `projects/${PROJECT_ID}/locations/${REGION}/operations/test`;
        },
        async waitOperation(operationName) {
            events.push(`wait:${operationName.split("/").at(-1)}`);
        }
    };
    assert.deepEqual(await configureFunctionSecrets(registry, "apply"), { cleared: 3 });
    for (const functionId of [
        "getMyTeam",
        "updateMyTeam",
        "completeInitialPasswordChange"
    ]) {
        assert.equal(events.filter((event) => event === `clear:${functionId}`).length, 1);
    }
    assert.equal(events.filter((event) => event.startsWith("get:")).length, 10);
});

test("verify rejects stale bindings without mutation", async () => {
    for (const functionId of [
        "getMyTeam",
        "updateMyTeam",
        "completeInitialPasswordChange"
    ]) {
        const inventory = healthyInventory({
            [functionId]: [binding("GOOGLE_OAUTH_CLIENT_SECRET")]
        });
        let mutations = 0;
        await assert.rejects(
            configureFunctionSecrets({
                async getFunction(candidateId) {
                    return inventory.find((entry) => entry.name.endsWith(`/${candidateId}`));
                },
                async clearSecrets() { mutations += 1; },
                async waitOperation() {}
            }, "verify"),
            (error) => error instanceof FunctionSecretConfigurationError
                && error.stage === "stale_secret_binding"
        );
        assert.equal(mutations, 0);
    }
});

test("required secret drift fails before any cleanup mutation", async () => {
    const inventory = healthyInventory({ updateMyTeam: [binding("STALE")] });
    inventory[0] = resource("registerTeam");
    let mutations = 0;
    await assert.rejects(
        configureFunctionSecrets({
            async getFunction(functionId) {
                return inventory.find((entry) => entry.name.endsWith(`/${functionId}`));
            },
            async clearSecrets() { mutations += 1; },
            async waitOperation() {}
        }, "apply"),
        (error) => error instanceof FunctionSecretConfigurationError
            && error.stage === "required_secret_binding"
    );
    assert.equal(mutations, 0);
});
