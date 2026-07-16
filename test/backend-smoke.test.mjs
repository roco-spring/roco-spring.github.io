import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
    DEFAULT_BASE_URL,
    EXPECTED_CALLABLES,
    LIVE_ORIGIN,
    PREFLIGHT_REQUEST_HEADERS,
    normalizeBaseUrl,
    runSmokeGate
} from "../scripts/verify-production-callables.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function preflightResponse({
    status = 204,
    origin = LIVE_ORIGIN,
    methods = "POST",
    headers = PREFLIGHT_REQUEST_HEADERS.join(", ")
} = {}) {
    const responseHeaders = {};
    if (origin !== null) responseHeaders["access-control-allow-origin"] = origin;
    if (methods !== null) responseHeaders["access-control-allow-methods"] = methods;
    if (headers !== null) responseHeaders["access-control-allow-headers"] = headers;
    return new Response(null, { status, headers: responseHeaders });
}

function callableRejection({
    cors = true,
    contentType = "application/json",
    payload = { error: { status: "UNAUTHENTICATED", message: "Unauthenticated" } }
} = {}) {
    const headers = {};
    if (contentType !== null) headers["content-type"] = contentType;
    if (cors) headers["access-control-allow-origin"] = LIVE_ORIGIN;
    return new Response(JSON.stringify(payload), { status: 401, headers });
}

function callableName(url) {
    return new URL(url).pathname.split("/").pop();
}

function hasHeader(headers, expectedName) {
    return Object.keys(headers).some((name) => name.toLowerCase() === expectedName);
}

test("backend smoke gate sends safe browser preflight and credential-free POST probes", async () => {
    const calls = [];
    const gate = await runSmokeGate({
        baseUrl: "https://example.test",
        maxAttempts: 1,
        fetchImplementation: async (url, options) => {
            calls.push({ url, options });
            return options.method === "OPTIONS"
                ? preflightResponse()
                : callableRejection();
        }
    });

    assert.equal(gate.ok, true);
    assert.deepEqual(gate.results.map(({ name, category, attempts }) => ({ name, category, attempts })), [
        { name: "registerTeam", category: "DEPLOYED_GUARD", attempts: 1 },
        { name: "getMyTeam", category: "DEPLOYED_GUARD", attempts: 1 },
        { name: "updateMyTeam", category: "DEPLOYED_GUARD", attempts: 1 },
        { name: "completeInitialPasswordChange", category: "DEPLOYED_GUARD", attempts: 1 }
    ]);

    assert.match(gate.results[0].detail, /missing App Check token is rejected/u);
    for (const result of gate.results.slice(1)) {
        assert.match(result.detail, /does not distinguish Auth from App Check/u);
        assert.doesNotMatch(result.detail, /missing App Check token is rejected/u);
    }

    assert.equal(calls.length, EXPECTED_CALLABLES.length * 2);
    for (const name of EXPECTED_CALLABLES) {
        const namedCalls = calls.filter((call) => callableName(call.url) === name);
        assert.equal(namedCalls.length, 2);
        assert.equal(namedCalls[0].url, `https://example.test/${name}`);

        const preflight = namedCalls.find((call) => call.options.method === "OPTIONS");
        assert.ok(preflight);
        assert.equal(preflight.options.body, undefined);
        assert.equal(preflight.options.headers.origin, LIVE_ORIGIN);
        assert.equal(preflight.options.headers["access-control-request-method"], "POST");
        assert.deepEqual(
            new Set(preflight.options.headers["access-control-request-headers"].split(/,\s*/u)),
            new Set(PREFLIGHT_REQUEST_HEADERS)
        );
        assert.equal(hasHeader(preflight.options.headers, "authorization"), false);
        assert.equal(hasHeader(preflight.options.headers, "x-firebase-appcheck"), false);
        assert.equal(preflight.options.cache, "no-store");
        assert.equal(preflight.options.redirect, "manual");
        assert.ok(preflight.options.signal instanceof AbortSignal);

        const post = namedCalls.find((call) => call.options.method === "POST");
        assert.ok(post);
        assert.equal(post.options.headers.origin, LIVE_ORIGIN);
        assert.equal(post.options.headers.accept, "application/json");
        assert.equal(post.options.headers["content-type"], "application/json");
        assert.equal(hasHeader(post.options.headers, "authorization"), false);
        assert.equal(hasHeader(post.options.headers, "x-firebase-appcheck"), false);
        assert.equal(post.options.body, JSON.stringify({ data: {} }));
        assert.equal(post.options.cache, "no-store");
        assert.equal(post.options.redirect, "manual");
        assert.ok(post.options.signal instanceof AbortSignal);
    }
});

test("backend smoke gate rejects incomplete or blocked browser preflight", async () => {
    let postCalls = 0;
    const gate = await runSmokeGate({
        baseUrl: "https://example.test",
        maxAttempts: 1,
        fetchImplementation: async (url, options) => {
            if (options.method === "POST") {
                postCalls += 1;
                return callableRejection();
            }

            switch (callableName(url)) {
                case "registerTeam":
                    return preflightResponse({ origin: null });
                case "getMyTeam":
                    return preflightResponse({ methods: "GET" });
                case "updateMyTeam":
                    return preflightResponse({
                        headers: "content-type, x-firebase-appcheck"
                    });
                default:
                    return preflightResponse({ status: 403 });
            }
        }
    });

    assert.equal(gate.ok, false);
    assert.equal(postCalls, 0);
    assert.deepEqual(gate.results.map(({ name, category, attempts }) => ({ name, category, attempts })), [
        { name: "registerTeam", category: "CORS_PREFLIGHT_MISCONFIGURED", attempts: 1 },
        { name: "getMyTeam", category: "CORS_PREFLIGHT_MISCONFIGURED", attempts: 1 },
        { name: "updateMyTeam", category: "CORS_PREFLIGHT_MISCONFIGURED", attempts: 1 },
        { name: "completeInitialPasswordChange", category: "PREFLIGHT_BLOCKED", attempts: 1 }
    ]);
});

test("backend smoke gate rejects malformed 401, blocked invocation, redirects, and unguarded success", async () => {
    const gate = await runSmokeGate({
        baseUrl: "https://example.test",
        maxAttempts: 1,
        fetchImplementation: async (url, options) => {
            if (options.method === "OPTIONS") return preflightResponse();

            switch (callableName(url)) {
                case "registerTeam":
                    return callableRejection({
                        payload: { error: { status: "PERMISSION_DENIED" } }
                    });
                case "getMyTeam":
                    return new Response("forbidden", { status: 403 });
                case "updateMyTeam":
                    return new Response(null, {
                        status: 302,
                        headers: { location: "https://other.example.test" }
                    });
                default:
                    return Response.json({ result: {} });
            }
        }
    });

    assert.equal(gate.ok, false);
    assert.deepEqual(gate.results.map(({ name, category }) => ({ name, category })), [
        { name: "registerTeam", category: "PROTOCOL_MISCONFIGURED" },
        { name: "getMyTeam", category: "INVOCATION_BLOCKED" },
        { name: "updateMyTeam", category: "REDIRECTED" },
        { name: "completeInitialPasswordChange", category: "UNGUARDED" }
    ]);
    assert.equal(gate.results.some((result) => "payload" in result), false);
});

test("backend smoke gate rejects a callable-shaped 401 without JSON content type", async () => {
    const gate = await runSmokeGate({
        baseUrl: "https://example.test",
        maxAttempts: 1,
        fetchImplementation: async (_url, options) => options.method === "OPTIONS"
            ? preflightResponse()
            : callableRejection({ contentType: "text/plain" })
    });

    assert.equal(gate.ok, false);
    assert.ok(gate.results.every((result) => result.category === "PROTOCOL_MISCONFIGURED"));
});

test("backend smoke gate retries transient network, timeout, 404, and 5xx failures", async () => {
    const preflightAttempts = new Map();
    const delays = [];
    const gate = await runSmokeGate({
        baseUrl: "https://example.test",
        maxAttempts: 3,
        retryBaseDelayMs: 7,
        sleepImplementation: async (milliseconds) => {
            delays.push(milliseconds);
        },
        fetchImplementation: async (url, options) => {
            if (options.method === "POST") return callableRejection();

            const name = callableName(url);
            const attempt = (preflightAttempts.get(name) ?? 0) + 1;
            preflightAttempts.set(name, attempt);
            if (attempt > 1) return preflightResponse();

            if (name === "registerTeam") throw new Error("simulated network failure");
            if (name === "getMyTeam") {
                const timeout = new Error("simulated timeout");
                timeout.name = "TimeoutError";
                throw timeout;
            }
            if (name === "updateMyTeam") return new Response("missing", { status: 404 });
            return new Response("unavailable", { status: 503 });
        }
    });

    assert.equal(gate.ok, true);
    assert.ok(gate.results.every((result) => (
        result.category === "DEPLOYED_GUARD" && result.attempts === 2
    )));
    assert.deepEqual([...delays].sort((left, right) => left - right), [7, 7, 7, 7]);
});

test("backend smoke gate bounds persistent transient retries with exponential backoff", async () => {
    const delays = [];
    let calls = 0;
    const gate = await runSmokeGate({
        baseUrl: "https://example.test",
        maxAttempts: 3,
        retryBaseDelayMs: 2,
        sleepImplementation: async (milliseconds) => {
            delays.push(milliseconds);
        },
        fetchImplementation: async () => {
            calls += 1;
            throw new Error("simulated persistent network failure");
        }
    });

    assert.equal(gate.ok, false);
    assert.equal(calls, EXPECTED_CALLABLES.length * 3);
    assert.ok(gate.results.every((result) => (
        result.category === "NETWORK_ERROR" && result.attempts === 3
    )));
    assert.deepEqual([...delays].sort((left, right) => left - right), [
        2, 2, 2, 2,
        4, 4, 4, 4
    ]);
});

test("backend smoke gate has an exact deployment inventory and safe URL boundary", async () => {
    assert.deepEqual(EXPECTED_CALLABLES, [
        "registerTeam",
        "getMyTeam",
        "updateMyTeam",
        "completeInitialPasswordChange"
    ]);
    assert.deepEqual(PREFLIGHT_REQUEST_HEADERS, [
        "authorization",
        "content-type",
        "x-firebase-appcheck"
    ]);
    assert.equal(
        DEFAULT_BASE_URL,
        "https://europe-west3-roco-spring-registration-2026.cloudfunctions.net"
    );

    const functionsIndex = await readFile(path.join(ROOT, "functions/src/index.ts"), "utf8");
    for (const callable of EXPECTED_CALLABLES) {
        assert.match(functionsIndex, new RegExp(`export const ${callable} = onCall\\(`, "u"));
    }
    assert.equal(functionsIndex.match(/enforceAppCheck: true/gu)?.length, EXPECTED_CALLABLES.length);
    assert.equal(functionsIndex.match(/cors: callableCors/gu)?.length, EXPECTED_CALLABLES.length);

    const packageConfig = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(
        packageConfig.scripts["backend:smoke"],
        "node scripts/verify-production-callables.mjs"
    );
    assert.match(
        packageConfig.scripts["deploy:production"],
        /deploy:firebase && npm run backend:smoke(?: &&|$)/u
    );

    assert.equal(normalizeBaseUrl("https://example.test///"), "https://example.test");
    assert.equal(normalizeBaseUrl("http://127.0.0.1:5001/"), "http://127.0.0.1:5001");
    assert.throws(() => normalizeBaseUrl("http://example.test"), /must use HTTPS/u);
    assert.throws(() => normalizeBaseUrl("https://user@example.test"), /must not contain credentials/u);
    assert.throws(() => normalizeBaseUrl("https://example.test?token=example"), /must not contain credentials/u);
});
