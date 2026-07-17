import assert from "node:assert/strict";
import test from "node:test";

import {
    APP_PARENT,
    CI_PROOF_MARKER,
    CLEANUP_PROOF_MARKER,
    DEBUG_TOKEN_COLLECTION,
    createAppCheckRestApi,
    runAppCheckCiGate
} from "../scripts/verify-app-check-ci.mjs";

const TEST_UUID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_DISPLAY_NAME = "Ephemeral CI unit-test-label";
const TEST_RESOURCE_NAME = `${DEBUG_TOKEN_COLLECTION}/unit-test-resource`;
const EXPECTED_RESULTS = Object.freeze([
    Object.freeze({ name: "registerTeam", code: "functions/invalid-argument" }),
    Object.freeze({ name: "getMyTeam", code: "functions/invalid-argument" })
]);

function createFakeApi({ retainOnDelete = false, malformedCreate = false } = {}) {
    const resources = new Map();
    const operations = [];
    return {
        operations,
        resources,
        async createDebugToken({ parent, displayName, token }) {
            operations.push({ operation: "create", parent, displayName, token });
            resources.set(TEST_RESOURCE_NAME, { name: TEST_RESOURCE_NAME, displayName });
            return malformedCreate ? {} : { name: TEST_RESOURCE_NAME, displayName };
        },
        async listDebugTokens(parent, pageToken) {
            operations.push({ operation: "list", parent, pageToken });
            return { debugTokens: [...resources.values()] };
        },
        async deleteDebugToken(name) {
            operations.push({ operation: "delete", name });
            if (!retainOnDelete) resources.delete(name);
        }
    };
}

test("App Check REST client uses stable v1 paths and keeps the UUID4 only in the create body", async () => {
    const requests = [];
    const api = createAppCheckRestApi(async (request) => {
        requests.push(request);
        if (request.method === "POST") {
            return { data: { name: TEST_RESOURCE_NAME, displayName: TEST_DISPLAY_NAME } };
        }
        if (request.method === "GET") return { data: { debugTokens: [] } };
        return { data: {} };
    });

    await api.createDebugToken({
        parent: APP_PARENT,
        displayName: TEST_DISPLAY_NAME,
        token: TEST_UUID
    });
    await api.listDebugTokens(APP_PARENT);
    await api.deleteDebugToken(TEST_RESOURCE_NAME);

    assert.equal(requests.length, 3);
    assert.match(requests[0].url, /^https:\/\/firebaseappcheck\.googleapis\.com\/v1\//u);
    assert.match(
        requests[0].url,
        /apps\/1%3A149052181991%3Aweb%3A291a3915eb3b5bbd6fc142\/debugTokens$/u
    );
    assert.deepEqual(requests[0].data, {
        displayName: TEST_DISPLAY_NAME,
        token: TEST_UUID
    });
    assert.equal(requests[0].timeout, 30_000);
    assert.deepEqual(requests[1].params, { pageSize: 100 });
    assert.equal("data" in requests[1], false);
    assert.equal("data" in requests[2], false);
});

test("App Check REST errors discard provider details that could contain a credential", async () => {
    const api = createAppCheckRestApi(async () => {
        throw Object.assign(new Error(`request contained ${TEST_UUID}`), {
            response: { status: 403 }
        });
    });

    await assert.rejects(
        api.createDebugToken({
            parent: APP_PARENT,
            displayName: TEST_DISPLAY_NAME,
            token: TEST_UUID
        }),
        (error) => {
            assert.match(error.message, /creation failed \(HTTP 403\)/u);
            assert.doesNotMatch(error.message, new RegExp(TEST_UUID, "u"));
            return true;
        }
    );
});

test("CI gate creates, probes, revokes, and verifies an ephemeral UUID4 lifecycle", async () => {
    const api = createFakeApi();
    const gate = await runAppCheckCiGate({
        api,
        tokenFactory: () => TEST_UUID,
        displayNameFactory: () => TEST_DISPLAY_NAME,
        probeImplementation: async (debugToken) => {
            assert.equal(debugToken, TEST_UUID);
            api.operations.push({ operation: "probe" });
            return { results: EXPECTED_RESULTS, attempts: 1 };
        }
    });

    assert.deepEqual(gate, {
        results: EXPECTED_RESULTS,
        attempts: 1,
        cleanupVerified: true
    });
    assert.deepEqual(api.operations.map(({ operation }) => operation), [
        "create",
        "probe",
        "list",
        "delete",
        "list"
    ]);
    assert.equal(api.operations[0].parent, APP_PARENT);
    assert.equal(api.operations[0].token, TEST_UUID);
    assert.equal(api.resources.size, 0);
    assert.equal(CI_PROOF_MARKER, "VALID_CI_DEBUG_APP_CHECK_TO_VALIDATION_BOUNDARY");
    assert.equal(CLEANUP_PROOF_MARKER, "CI_DEBUG_TOKEN_REVOKED_AND_DELETION_VERIFIED");
});

test("CI gate revokes and verifies cleanup after a probe failure", async () => {
    const api = createFakeApi();
    await assert.rejects(
        runAppCheckCiGate({
            api,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            probeImplementation: async () => {
                throw new Error("simulated probe failure");
            }
        }),
        /simulated probe failure/u
    );

    assert.equal(api.resources.size, 0);
    assert.deepEqual(api.operations.map(({ operation }) => operation), [
        "create",
        "list",
        "delete",
        "list"
    ]);
});

test("CI gate recovers a created resource by its unique display label", async () => {
    const api = createFakeApi({ malformedCreate: true });
    await assert.rejects(
        runAppCheckCiGate({
            api,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            probeImplementation: async () => {
                throw new Error("probe must not run");
            }
        }),
        /did not confirm/u
    );

    assert.equal(api.resources.size, 0);
    assert.equal(api.operations.some(({ operation }) => operation === "probe"), false);
    assert.equal(api.operations.some(({ operation }) => operation === "delete"), true);
});

test("CI gate fails closed with only safe resource identity when revocation is retained", async () => {
    const api = createFakeApi({ retainOnDelete: true });
    await assert.rejects(
        runAppCheckCiGate({
            api,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            probeImplementation: async () => ({ results: EXPECTED_RESULTS, attempts: 1 })
        }),
        (error) => {
            assert.match(error.message, new RegExp(TEST_RESOURCE_NAME, "u"));
            assert.match(error.message, new RegExp(TEST_DISPLAY_NAME, "u"));
            assert.doesNotMatch(error.message, new RegExp(TEST_UUID, "u"));
            return true;
        }
    );
});

test("CI gate rejects a non-UUID4 token before making an App Check API call", async () => {
    const api = createFakeApi();
    await assert.rejects(
        runAppCheckCiGate({
            api,
            tokenFactory: () => "not-a-uuid",
            displayNameFactory: () => TEST_DISPLAY_NAME,
            probeImplementation: async () => ({ results: EXPECTED_RESULTS, attempts: 1 })
        }),
        /must return a UUID4/u
    );
    assert.equal(api.operations.length, 0);
});
