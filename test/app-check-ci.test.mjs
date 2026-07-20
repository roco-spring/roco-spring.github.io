import assert from "node:assert/strict";
import test from "node:test";

import {
    APP_PARENT,
    AUTH_CLEANUP_PROOF_MARKER,
    AUTH_PROOF_MARKER,
    CI_PROOF_MARKER,
    CLEANUP_PROOF_MARKER,
    DEBUG_TOKEN_COLLECTION,
    createEphemeralAuthAccountSpecs,
    createAppCheckRestApi,
    runAuthenticatedAppCheckCiGate,
    runAppCheckCiGate
} from "../scripts/verify-app-check-ci.mjs";

const TEST_UUID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_DISPLAY_NAME = "Ephemeral CI unit-test-label";
const TEST_RESOURCE_NAME = `${DEBUG_TOKEN_COLLECTION}/unit-test-resource`;
const EXPECTED_RESULTS = Object.freeze([
    Object.freeze({ name: "registerTeam", code: "functions/invalid-argument" }),
    Object.freeze({ name: "getMyTeam", code: "functions/invalid-argument" })
]);
const AUTHENTICATED_RESULTS = Object.freeze([
    Object.freeze({
        name: "updateMyTeam",
        validBeforeCode: "functions/invalid-argument",
        missingAppCheckHttpStatus: 401,
        missingAppCheckContentType: "application/json",
        missingAppCheckErrorStatus: "UNAUTHENTICATED",
        validAfterCode: "functions/invalid-argument"
    }),
    Object.freeze({
        name: "completeInitialPasswordChange",
        validBeforeCode: "functions/invalid-argument",
        missingAppCheckHttpStatus: 401,
        missingAppCheckContentType: "application/json",
        missingAppCheckErrorStatus: "UNAUTHENTICATED",
        validAfterCode: "functions/invalid-argument"
    })
]);
const TEST_PASSWORD = "Correct-Horse-Battery-Staple-42!";

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

function userNotFound() {
    return Object.assign(new Error("provider user not found"), { code: "auth/user-not-found" });
}

function createFakeAuth({
    ambiguousCreateAt = 0,
    failCreateAt = 0,
    retainOnDelete = false,
    throwAfterDelete = false
} = {}) {
    const users = new Map();
    const operations = [];
    let createCount = 0;

    function recordFromInput(input) {
        return {
            uid: input.uid,
            email: input.email,
            displayName: input.displayName,
            customClaims: undefined
        };
    }

    return {
        operations,
        users,
        async createUser(input) {
            createCount += 1;
            operations.push({ operation: "createUser", uid: input.uid });
            if (createCount === failCreateAt) {
                throw new Error(`provider failure contained ${input.password}`);
            }
            const record = recordFromInput(input);
            users.set(input.uid, record);
            if (createCount === ambiguousCreateAt) {
                throw new Error(`ambiguous response contained ${input.password}`);
            }
            return { ...record };
        },
        async setCustomUserClaims(uid, claims) {
            operations.push({ operation: "setCustomUserClaims", uid });
            const record = users.get(uid);
            if (!record) throw userNotFound();
            record.customClaims = { ...claims };
        },
        async getUser(uid) {
            operations.push({ operation: "getUser", uid });
            const record = users.get(uid);
            if (!record) throw userNotFound();
            return { ...record, customClaims: { ...record.customClaims } };
        },
        async getUserByEmail(email) {
            operations.push({ operation: "getUserByEmail", email });
            const record = [...users.values()].find((candidate) => candidate.email === email);
            if (!record) throw userNotFound();
            return { ...record, customClaims: { ...record.customClaims } };
        },
        async listUsers(maxResults, pageToken) {
            operations.push({ operation: "listUsers", maxResults, pageToken });
            return {
                users: [...users.values()].map((record) => ({
                    ...record,
                    customClaims: { ...record.customClaims }
                }))
            };
        },
        async deleteUser(uid) {
            operations.push({ operation: "deleteUser", uid });
            if (!retainOnDelete) users.delete(uid);
            if (throwAfterDelete) throw new Error("ambiguous delete response");
        }
    };
}

function deterministicAccountSpecs() {
    return createEphemeralAuthAccountSpecs({
        markerFactory: () => TEST_UUID,
        passwordFactory: () => TEST_PASSWORD
    });
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
        "list",
        "create",
        "probe",
        "list",
        "delete",
        "list"
    ]);
    assert.equal(api.operations[1].parent, APP_PARENT);
    assert.equal(api.operations[1].token, TEST_UUID);
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
        "list",
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

test("CI gate fails closed when a stale managed debug token exists", async () => {
    const api = createFakeApi();
    api.resources.set(TEST_RESOURCE_NAME, {
        name: TEST_RESOURCE_NAME,
        displayName: "Ephemeral CI interrupted-run"
    });
    await assert.rejects(
        runAppCheckCiGate({
            api,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            probeImplementation: async () => {
                throw new Error("probe must not run");
            }
        }),
        /cleanup could not be verified/u
    );
    assert.equal(api.operations.some(({ operation }) => operation === "create"), false);
    assert.equal(api.resources.size, 1);
});

test("authenticated CI gate provisions two role-bound users and verifies both cleanup lifecycles", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth();
    const gate = await runAuthenticatedAppCheckCiGate({
        api,
        auth,
        tokenFactory: () => TEST_UUID,
        displayNameFactory: () => TEST_DISPLAY_NAME,
        accountSpecFactory: deterministicAccountSpecs,
        probeImplementation: async ({ debugToken, accounts }) => {
            assert.equal(debugToken, TEST_UUID);
            assert.equal(accounts.updateMyTeam.expectedMustChangePassword, false);
            assert.equal(accounts.completeInitialPasswordChange.expectedMustChangePassword, true);
            assert.equal(accounts.updateMyTeam.password, TEST_PASSWORD);
            return {
                results: EXPECTED_RESULTS,
                authenticatedResults: AUTHENTICATED_RESULTS,
                attempts: 1
            };
        }
    });

    assert.deepEqual(gate, {
        results: EXPECTED_RESULTS,
        authenticatedResults: AUTHENTICATED_RESULTS,
        attempts: 1,
        cleanupVerified: true,
        authCleanupVerified: true
    });
    assert.equal(auth.users.size, 0);
    assert.equal(api.resources.size, 0);
    assert.equal(
        auth.operations.filter(({ operation }) => operation === "createUser").length,
        2
    );
    assert.equal(
        auth.operations.filter(({ operation }) => operation === "deleteUser").length,
        2
    );
    assert.equal(AUTH_PROOF_MARKER, "VALID_AUTH_AND_APP_CHECK_ENFORCEMENT");
    assert.equal(
        AUTH_CLEANUP_PROOF_MARKER,
        "CI_AUTH_USERS_DELETED_AND_ABSENCE_VERIFIED"
    );
});

test("authenticated CI gate independently cleans the debug token and users after probe failure", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth();
    await assert.rejects(
        runAuthenticatedAppCheckCiGate({
            api,
            auth,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            accountSpecFactory: deterministicAccountSpecs,
            probeImplementation: async () => {
                throw new Error("simulated authenticated probe failure");
            }
        }),
        /simulated authenticated probe failure/u
    );
    assert.equal(auth.users.size, 0);
    assert.equal(api.resources.size, 0);
});

test("authenticated cleanup treats a delete error followed by absence as success", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth({ throwAfterDelete: true });
    const gate = await runAuthenticatedAppCheckCiGate({
        api,
        auth,
        tokenFactory: () => TEST_UUID,
        displayNameFactory: () => TEST_DISPLAY_NAME,
        accountSpecFactory: deterministicAccountSpecs,
        probeImplementation: async () => ({
            results: EXPECTED_RESULTS,
            authenticatedResults: AUTHENTICATED_RESULTS,
            attempts: 1
        })
    });
    assert.equal(gate.authCleanupVerified, true);
    assert.equal(auth.users.size, 0);
});

test("authenticated CI gate recovers every planned user after an ambiguous partial create", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth({ ambiguousCreateAt: 2 });
    await assert.rejects(
        runAuthenticatedAppCheckCiGate({
            api,
            auth,
            accountSpecFactory: deterministicAccountSpecs,
            probeImplementation: async () => {
                throw new Error("probe must not run");
            }
        }),
        /provisioning failed/u
    );
    assert.equal(auth.users.size, 0);
    assert.equal(api.operations.length, 0);
    assert.equal(
        auth.operations.filter(({ operation }) => operation === "deleteUser").length,
        2
    );
});

test("authenticated CI gate sanitizes provider failures containing a password", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth({ failCreateAt: 1 });
    await assert.rejects(
        runAuthenticatedAppCheckCiGate({
            api,
            auth,
            accountSpecFactory: deterministicAccountSpecs
        }),
        (error) => {
            assert.match(error.message, /provisioning failed/u);
            assert.doesNotMatch(error.message, new RegExp(TEST_PASSWORD, "u"));
            return true;
        }
    );
    assert.equal(auth.users.size, 0);
});

test("authenticated CI gate fails closed when a temporary user is retained", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth({ retainOnDelete: true });
    await assert.rejects(
        runAuthenticatedAppCheckCiGate({
            api,
            auth,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            accountSpecFactory: deterministicAccountSpecs,
            probeImplementation: async () => ({
                results: EXPECTED_RESULTS,
                authenticatedResults: AUTHENTICATED_RESULTS,
                attempts: 1
            })
        }),
        /cleanup could not be verified/u
    );
    assert.equal(auth.users.size, 2);
    assert.equal(api.resources.size, 0);
});

test("authenticated CI cleanup never deletes a user whose unique marker no longer matches", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth();
    const specs = deterministicAccountSpecs();
    const changedUid = specs[0].uid;
    await assert.rejects(
        runAuthenticatedAppCheckCiGate({
            api,
            auth,
            tokenFactory: () => TEST_UUID,
            displayNameFactory: () => TEST_DISPLAY_NAME,
            accountSpecFactory: () => specs,
            probeImplementation: async () => {
                auth.users.get(changedUid).displayName = "Unrelated user";
                return {
                    results: EXPECTED_RESULTS,
                    authenticatedResults: AUTHENTICATED_RESULTS,
                    attempts: 1
                };
            }
        }),
        /cleanup could not be verified/u
    );
    assert.equal(auth.users.has(changedUid), true);
    assert.equal(
        auth.operations.some(({ operation, uid }) => (
            operation === "deleteUser" && uid === changedUid
        )),
        false
    );
    assert.equal(api.resources.size, 0);
});

test("authenticated CI gate fails closed on stale marker-owned users from an interrupted run", async () => {
    const api = createFakeApi();
    const auth = createFakeAuth();
    auth.users.set("roco-appcheck-ci-stale-update", {
        uid: "roco-appcheck-ci-stale-update",
        email: "stale@example.invalid",
        displayName: "Ephemeral App Check CI interrupted update",
        customClaims: { rocoAppCheckCiMarker: "stale" }
    });
    await assert.rejects(
        runAuthenticatedAppCheckCiGate({
            api,
            auth,
            accountSpecFactory: deterministicAccountSpecs
        }),
        /stale temporary Firebase Auth CI user/u
    );
    assert.equal(auth.users.has("roco-appcheck-ci-stale-update"), true);
    assert.equal(
        auth.operations.some(({ operation }) => operation === "deleteUser"),
        false
    );
    assert.equal(api.operations.length, 0);
});
