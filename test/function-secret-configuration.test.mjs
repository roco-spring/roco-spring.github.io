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

function healthyInventory(updateSecrets = []) {
    return [
        resource("registerTeam", [binding("RATE_LIMIT_HMAC_SECRET")]),
        resource("getMyTeam"),
        resource("updateMyTeam", updateSecrets),
        resource("completeInitialPasswordChange"),
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
    assert.deepEqual(
        buildSecretCleanupPlan(healthyInventory([
            binding("GOOGLE_OAUTH_CLIENT_SECRET"),
            binding("GOOGLE_OAUTH_REFRESH_TOKEN")
        ])),
        ["updateMyTeam"]
    );
});

test("apply preflights, clears stale bindings, waits, and verifies read-back", async () => {
    let inventory = healthyInventory([binding("GOOGLE_OAUTH_CLIENT_SECRET")]);
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
    assert.deepEqual(await configureFunctionSecrets(registry, "apply"), { cleared: 1 });
    assert.equal(events.filter((event) => event === "clear:updateMyTeam").length, 1);
    assert.equal(events.filter((event) => event.startsWith("get:")).length, 10);
});

test("verify rejects stale bindings without mutation", async () => {
    const inventory = healthyInventory([binding("GOOGLE_OAUTH_CLIENT_SECRET")]);
    let mutations = 0;
    await assert.rejects(
        configureFunctionSecrets({
            async getFunction(functionId) {
                return inventory.find((entry) => entry.name.endsWith(`/${functionId}`));
            },
            async clearSecrets() { mutations += 1; },
            async waitOperation() {}
        }, "verify"),
        (error) => error instanceof FunctionSecretConfigurationError
            && error.stage === "stale_secret_binding"
    );
    assert.equal(mutations, 0);
});

test("required secret drift fails before any cleanup mutation", async () => {
    const inventory = healthyInventory([binding("STALE")]);
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
