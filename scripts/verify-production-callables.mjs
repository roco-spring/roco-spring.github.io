#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "roco-spring-registration-2026";
const REGION = "europe-west3";
const LIVE_ORIGIN = "https://roco-spring.github.io";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 8_000;
const PREFLIGHT_REQUEST_HEADERS = Object.freeze([
    "authorization",
    "content-type",
    "x-firebase-appcheck"
]);
const EXPECTED_CALLABLES = Object.freeze([
    "registerTeam",
    "getMyTeam",
    "updateMyTeam",
    "completeInitialPasswordChange"
]);
const DEFAULT_BASE_URL = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;
const RETRYABLE_CATEGORIES = new Set([
    "MISSING",
    "BACKEND_ERROR",
    "NETWORK_ERROR",
    "TIMEOUT"
]);

function normalizeBaseUrl(value) {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";

    if (url.username || url.password || url.search || url.hash) {
        throw new Error("The smoke-test base URL must not contain credentials, a query, or a fragment.");
    }
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
        throw new Error("The smoke-test base URL must use HTTPS (HTTP is allowed only for loopback tests).");
    }

    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
}

function commaSeparatedHeaderValues(value, transform = (entry) => entry.toLowerCase()) {
    return new Set((value ?? "")
        .split(",")
        .map((entry) => transform(entry.trim()))
        .filter(Boolean));
}

function classifyPreflightResponse(response) {
    if (response.status === 404) {
        return {
            ok: false,
            category: "MISSING",
            detail: "HTTP 404 during CORS preflight: the callable endpoint is not available at the configured project and region."
        };
    }
    if (response.status >= 300 && response.status < 400) {
        return {
            ok: false,
            category: "PREFLIGHT_REDIRECTED",
            detail: `Unexpected HTTP ${response.status} redirect during CORS preflight.`
        };
    }
    if (response.status === 401 || response.status === 403) {
        return {
            ok: false,
            category: "PREFLIGHT_BLOCKED",
            detail: `HTTP ${response.status}: browser CORS preflight is blocked before the callable can be invoked.`
        };
    }
    if (response.status >= 500) {
        return {
            ok: false,
            category: "BACKEND_ERROR",
            detail: `HTTP ${response.status} during CORS preflight: the deployed endpoint is not healthy.`
        };
    }
    if (response.status < 200 || response.status >= 300) {
        return {
            ok: false,
            category: "UNEXPECTED_PREFLIGHT_RESPONSE",
            detail: `Unexpected HTTP ${response.status} during CORS preflight.`
        };
    }

    const allowedOrigin = response.headers.get("access-control-allow-origin");
    if (allowedOrigin !== LIVE_ORIGIN) {
        return {
            ok: false,
            category: "CORS_PREFLIGHT_MISCONFIGURED",
            detail: "CORS preflight did not allow the production site origin."
        };
    }

    const allowedMethods = commaSeparatedHeaderValues(
        response.headers.get("access-control-allow-methods"),
        (entry) => entry.toUpperCase()
    );
    if (!allowedMethods.has("POST")) {
        return {
            ok: false,
            category: "CORS_PREFLIGHT_MISCONFIGURED",
            detail: "CORS preflight did not allow the callable POST method."
        };
    }

    const allowedHeaders = commaSeparatedHeaderValues(
        response.headers.get("access-control-allow-headers")
    );
    const missingHeaders = PREFLIGHT_REQUEST_HEADERS.filter((header) => !allowedHeaders.has(header));
    if (missingHeaders.length > 0) {
        return {
            ok: false,
            category: "CORS_PREFLIGHT_MISCONFIGURED",
            detail: "CORS preflight did not allow every header required by authenticated Firebase callable requests."
        };
    }

    return {
        ok: true,
        category: "PREFLIGHT_READY",
        detail: "Production-origin browser preflight allows POST and the required callable headers."
    };
}

function classifyResponse(response, payload, callableName = "") {
    if (response.status === 404) {
        return {
            ok: false,
            category: "MISSING",
            detail: "HTTP 404: the callable endpoint is not available at the configured project and region."
        };
    }

    const callableStatus = payload?.error?.status;
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (response.status === 401 && callableStatus === "UNAUTHENTICATED") {
        if (allowedOrigin !== LIVE_ORIGIN) {
            return {
                ok: false,
                category: "CORS_MISCONFIGURED",
                detail: "The callable rejected the probe, but its POST response did not allow the production site origin."
            };
        }
        if (contentType !== "application/json") {
            return {
                ok: false,
                category: "PROTOCOL_MISCONFIGURED",
                detail: "HTTP 401 used the callable error shape without the required JSON response content type."
            };
        }
        if (callableName === "registerTeam") {
            return {
                ok: true,
                category: "DEPLOYED_GUARD",
                detail: "deployed; browser preflight passed; public registration returned HTTP 401 UNAUTHENTICATED, providing runtime evidence that a missing App Check token is rejected."
            };
        }
        return {
            ok: true,
            category: "DEPLOYED_GUARD",
            detail: "deployed; browser preflight passed; the credential-free request returned HTTP 401 UNAUTHENTICATED. This confirms a deployed guard, but does not distinguish Auth from App Check for this authenticated callable."
        };
    }

    if (response.status >= 200 && response.status < 300) {
        return {
            ok: false,
            category: "UNGUARDED",
            detail: "The credential-free callable request succeeded; the required request guard is not behaving as expected."
        };
    }
    if (response.status >= 300 && response.status < 400) {
        return {
            ok: false,
            category: "REDIRECTED",
            detail: `Unexpected HTTP ${response.status} redirect; the Firebase callable URL must respond directly.`
        };
    }
    if (response.status === 401) {
        return {
            ok: false,
            category: "PROTOCOL_MISCONFIGURED",
            detail: "HTTP 401 did not use the Firebase callable UNAUTHENTICATED JSON response shape."
        };
    }
    if (response.status === 403) {
        return {
            ok: false,
            category: "INVOCATION_BLOCKED",
            detail: "HTTP 403: the public frontend may not be allowed to invoke this callable."
        };
    }
    if (response.status >= 500) {
        return {
            ok: false,
            category: "BACKEND_ERROR",
            detail: `HTTP ${response.status}: the deployed endpoint is not healthy.`
        };
    }
    return {
        ok: false,
        category: "UNEXPECTED_RESPONSE",
        detail: `Unexpected HTTP ${response.status}; expected a credential-free callable rejection.`
    };
}

function isTimeoutError(error) {
    return error?.name === "TimeoutError" || error?.name === "AbortError";
}

function requestFailure(error, phase) {
    const timedOut = isTimeoutError(error);
    return {
        ok: false,
        category: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        detail: timedOut
            ? `The ${phase} request did not complete within ${REQUEST_TIMEOUT_MS / 1000} seconds.`
            : `The ${phase} request could not reach the endpoint.`
    };
}

function preflightRequestOptions() {
    return {
        method: "OPTIONS",
        headers: {
            origin: LIVE_ORIGIN,
            "access-control-request-method": "POST",
            "access-control-request-headers": PREFLIGHT_REQUEST_HEADERS.join(", ")
        },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
}

function postRequestOptions() {
    return {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            origin: LIVE_ORIGIN
        },
        body: JSON.stringify({ data: {} }),
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
}

async function probeCallableOnce(name, baseUrl, fetchImplementation) {
    const endpoint = `${baseUrl}/${encodeURIComponent(name)}`;
    let preflightResponse;

    try {
        preflightResponse = await fetchImplementation(endpoint, preflightRequestOptions());
    } catch (error) {
        return { name, ...requestFailure(error, "CORS preflight") };
    }

    const preflightResult = classifyPreflightResponse(preflightResponse);
    if (!preflightResult.ok) {
        return { name, ...preflightResult };
    }

    let response;
    try {
        response = await fetchImplementation(endpoint, postRequestOptions());
    } catch (error) {
        return { name, ...requestFailure(error, "callable POST") };
    }

    let payload = null;
    try {
        payload = await response.json();
    } catch (error) {
        if (isTimeoutError(error)) {
            return { name, ...requestFailure(error, "callable response") };
        }
        if (!(error instanceof SyntaxError)) {
            return { name, ...requestFailure(error, "callable response") };
        }
        // Missing endpoints and some infrastructure failures return non-JSON.
        // Classification uses only the status and headers; bodies remain private.
    }

    return { name, ...classifyResponse(response, payload, name) };
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateRetryOptions(maxAttempts, retryBaseDelayMs) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new Error("Smoke-test maxAttempts must be an integer from 1 through 10.");
    }
    if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > 30_000) {
        throw new Error("Smoke-test retryBaseDelayMs must be between 0 and 30000.");
    }
}

async function probeCallable(
    name,
    baseUrl,
    fetchImplementation = fetch,
    {
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
        sleepImplementation = sleep
    } = {}
) {
    validateRetryOptions(maxAttempts, retryBaseDelayMs);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await probeCallableOnce(name, baseUrl, fetchImplementation);
        if (result.ok || !RETRYABLE_CATEGORIES.has(result.category) || attempt === maxAttempts) {
            return { ...result, attempts: attempt };
        }

        const delay = Math.min(
            retryBaseDelayMs * 2 ** (attempt - 1),
            MAX_RETRY_DELAY_MS
        );
        await sleepImplementation(delay);
    }

    throw new Error("Callable probe exhausted without a result.");
}

async function runSmokeGate({
    baseUrl = DEFAULT_BASE_URL,
    fetchImplementation = fetch,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    sleepImplementation = sleep
} = {}) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    validateRetryOptions(maxAttempts, retryBaseDelayMs);
    const results = await Promise.all(EXPECTED_CALLABLES.map((name) => (
        probeCallable(name, normalizedBaseUrl, fetchImplementation, {
            maxAttempts,
            retryBaseDelayMs,
            sleepImplementation
        })
    )));
    return {
        ok: results.every((result) => result.ok),
        results
    };
}

function parseArguments(argumentsList) {
    if (argumentsList.length === 0) {
        return { baseUrl: DEFAULT_BASE_URL, help: false };
    }
    if (argumentsList.length === 1 && argumentsList[0] === "--help") {
        return { baseUrl: DEFAULT_BASE_URL, help: true };
    }
    if (argumentsList.length === 2 && argumentsList[0] === "--base-url") {
        return { baseUrl: argumentsList[1], help: false };
    }
    throw new Error("Usage: node scripts/verify-production-callables.mjs [--base-url <URL>]");
}

async function main() {
    try {
        const options = parseArguments(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(
                "Checks production browser preflight and credential-free rejection for all four callable URLs.\n"
                + "Usage: node scripts/verify-production-callables.mjs [--base-url <URL>]\n"
            );
            return;
        }

        const gate = await runSmokeGate({ baseUrl: options.baseUrl });
        for (const result of gate.results) {
            const prefix = result.ok ? "PASS" : "FAIL";
            const line = `${prefix} ${result.name} [${result.category}] attempts=${result.attempts}: ${result.detail}\n`;
            (result.ok ? process.stdout : process.stderr).write(line);
        }

        if (!gate.ok) {
            process.stderr.write(
                "Production callable smoke gate failed. No credentials, Auth/App Check tokens, or response bodies were logged.\n"
            );
            process.exitCode = 1;
            return;
        }

        process.stdout.write(
            "Production callable smoke gate passed: 4/4 endpoints support the required browser preflight and reject credential-free calls. registerTeam additionally provides missing-App-Check runtime evidence; authenticated callables provide deployed-guard evidence only. No credentials or tokens were sent or logged.\n"
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : "Production callable smoke gate failed.";
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
    await main();
}

export {
    DEFAULT_BASE_URL,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_RETRY_BASE_DELAY_MS,
    EXPECTED_CALLABLES,
    LIVE_ORIGIN,
    PREFLIGHT_REQUEST_HEADERS,
    classifyPreflightResponse,
    classifyResponse,
    normalizeBaseUrl,
    probeCallable,
    runSmokeGate
};
