import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { google } from "googleapis";

import {
    OAuthBootstrapError,
    cleanupPreflightArtifacts,
    exchangeAuthorizationCode,
    verifyOrganizerIdentity
} from "../scripts/bootstrap-google-oauth.mjs";

const scopes = [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.send"
];
const accessTokenField = ["access", "token"].join("_");
const refreshTokenField = ["refresh", "token"].join("_");

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" }
    });
}

test("bootstrap exchanges a single-use code once with a bounded no-redirect request", async () => {
    const calls = [];
    const fetchImplementation = async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
            [accessTokenField]: "short-lived-access-token",
            [refreshTokenField]: "long-lived-refresh-token",
            expires_in: 3600,
            scope: scopes.join(" ")
        });
    };

    const result = await exchangeAuthorizationCode(fetchImplementation, {
        clientSecret: "client-secret-kept-in-memory",
        code: "single-use-code",
        codeVerifier: "pkce-verifier",
        redirectUri: "http://127.0.0.1:43123"
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.redirect, "error");
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.body.get("grant_type"), "authorization_code");
    assert.equal(calls[0].options.body.get("code_verifier"), "pkce-verifier");
    assert.equal(result.refreshToken, "long-lived-refresh-token");
    assert.equal(
        Reflect.get(result.oauthClient.credentials, accessTokenField),
        "short-lived-access-token"
    );
    assert.equal(
        Reflect.get(result.oauthClient.credentials, refreshTokenField),
        undefined
    );
    assert.deepEqual(google._options, { timeout: 8_000, retry: false });
});

test("bootstrap fails closed on missing scopes without exposing provider details", async () => {
    const sensitive = "provider-secret-description";
    await assert.rejects(
        exchangeAuthorizationCode(
            async () => jsonResponse({
                error: "invalid_grant",
                error_description: sensitive
            }, 400),
            {
                clientSecret: "client-secret-never-log",
                code: "single-use-code",
                codeVerifier: "pkce-verifier",
                redirectUri: "http://127.0.0.1:43123"
            }
        ),
        (error) => {
            assert.ok(error instanceof OAuthBootstrapError);
            assert.equal(error.stage, "authorization_code_exchange");
            assert.equal(error.providerCode, "invalid_grant");
            assert.doesNotMatch(String(error), new RegExp(sensitive, "u"));
            assert.doesNotMatch(String(error), /client-secret-never-log/u);
            return true;
        }
    );
});

test("bootstrap rejects a broadened grant from the token response", async () => {
    await assert.rejects(
        exchangeAuthorizationCode(
            async () => jsonResponse({
                [accessTokenField]: "short-lived-access-token",
                [refreshTokenField]: "long-lived-refresh-token",
                expires_in: 3600,
                scope: `${scopes.join(" ")} https://www.googleapis.com/auth/drive`
            }),
            {
                clientSecret: "client-secret-kept-in-memory",
                code: "single-use-code",
                codeVerifier: "pkce-verifier",
                redirectUri: "http://127.0.0.1:43123"
            }
        ),
        (error) => error instanceof OAuthBootstrapError
            && error.stage === "oauth_scopes"
    );
});

test("bootstrap cleanup unions every marker match and confirms an empty inventory", async () => {
    const deleted = [];
    const requestOptions = [];
    let inventoryCall = 0;
    const drive = {
        files: {
            async list(_parameters, options) {
                requestOptions.push(options);
                inventoryCall += 1;
                return inventoryCall === 1
                    ? { data: { files: [{ id: "first-create" }, { id: "retried-create" }] } }
                    : { data: { files: [] } };
            },
            async delete(parameters, options) {
                requestOptions.push(options);
                deleted.push(parameters.fileId);
                return { data: {} };
            },
            async get(_parameters, options) {
                requestOptions.push(options);
                throw { response: { status: 404 } };
            }
        }
    };

    const confirmed = await cleanupPreflightArtifacts(
        drive,
        "unique-marker",
        ["retried-create"],
        async () => undefined
    );

    assert.equal(confirmed, true);
    assert.deepEqual(new Set(deleted), new Set(["first-create", "retried-create"]));
    assert.ok(inventoryCall >= 3);
    for (const options of requestOptions) {
        assert.deepEqual(options, { timeout: 8_000, retry: false });
    }
});

test("bootstrap verifies the exact organizer principal with bounded Drive transport", async () => {
    let observedOptions;
    await assert.doesNotReject(verifyOrganizerIdentity({
        about: {
            async get(_parameters, options) {
                observedOptions = options;
                return {
                    data: {
                        user: { emailAddress: "shashanksagnihotri@gmail.com" }
                    }
                };
            }
        }
    }));
    assert.deepEqual(observedOptions, { timeout: 8_000, retry: false });

    await assert.rejects(
        verifyOrganizerIdentity({
            about: {
                async get() {
                    return {
                        data: { user: { emailAddress: "unexpected@example.org" } }
                    };
                }
            }
        }),
        (error) => error?.category === "organizer_account_mismatch"
            && !String(error).includes("unexpected@example.org")
    );
});

test("ambiguous bootstrap cleanup observes the full empty-inventory horizon", async () => {
    let inventoryCalls = 0;
    const waits = [];
    const drive = {
        files: {
            async list() {
                inventoryCalls += 1;
                return { data: { files: [] } };
            },
            async delete() {
                throw new Error("No artifact should be deleted.");
            },
            async get() {
                throw new Error("No artifact should be read.");
            }
        }
    };

    const confirmed = await cleanupPreflightArtifacts(
        drive,
        "ambiguous-marker",
        [],
        async (milliseconds) => waits.push(milliseconds)
    );

    assert.equal(confirmed, true);
    assert.equal(inventoryCalls, 5);
    assert.deepEqual(waits, [250, 500, 1000, 2000]);
});

test("cleanup never claims success while marker inventory is unavailable", async () => {
    let inventoryCalls = 0;
    const drive = {
        files: {
            async list() {
                inventoryCalls += 1;
                throw new Error("inventory unavailable");
            },
            async delete() {
                return { data: {} };
            },
            async get() {
                throw { response: { status: 404 } };
            }
        }
    };
    assert.equal(await cleanupPreflightArtifacts(
        drive,
        "ambiguous-marker",
        ["known-returned-id"],
        async () => undefined
    ), false);
    assert.equal(inventoryCalls, 5);
});

test("bootstrap has no generated or tokeninfo OAuth exchange fallback", async () => {
    const source = await readFile(
        new URL("../scripts/bootstrap-google-oauth.mjs", import.meta.url),
        "utf8"
    );
    assert.match(source, /google\.options\(GOOGLE_REQUEST_OPTIONS\)/u);
    assert.doesNotMatch(source, /oauth2\.googleapis\.com\/tokeninfo/u);
    assert.doesNotMatch(source, /\.getToken\(|\.getTokenInfo\(/u);
});
