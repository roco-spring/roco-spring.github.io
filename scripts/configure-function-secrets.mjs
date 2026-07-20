#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "roco-spring-registration-2026";
const PROJECT_NUMBER = "149052181991";
const REGION = "europe-west3";
const REQUEST_TIMEOUT_MS = 8_000;
const OPERATION_POLL_MS = 5_000;
const MAX_OPERATION_POLLS = 120;
const REQUEST_OPTIONS = Object.freeze({ timeout: REQUEST_TIMEOUT_MS, retry: false });

const SECRET_REQUIREMENTS = Object.freeze({
    registerTeam: Object.freeze(["RATE_LIMIT_HMAC_SECRET"]),
    getMyTeam: Object.freeze([]),
    updateMyTeam: Object.freeze([]),
    completeInitialPasswordChange: Object.freeze([]),
    reconcileRegistrations: Object.freeze([
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN"
    ])
});

delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
delete process.env.RATE_LIMIT_HMAC_SECRET;

export class FunctionSecretConfigurationError extends Error {
    constructor(stage) {
        super("Function secret configuration failed.");
        this.name = "FunctionSecretConfigurationError";
        this.stage = stage;
    }
}

export function parseMode(argumentsList) {
    if (argumentsList.length !== 1 || !["--apply", "--verify"].includes(argumentsList[0])) {
        throw new FunctionSecretConfigurationError("arguments");
    }
    return argumentsList[0].slice(2);
}

function exactFunctionName(functionId) {
    return `projects/${PROJECT_ID}/locations/${REGION}/functions/${functionId}`;
}

function isExactBinding(binding, expectedKey) {
    const projectId = binding?.projectId || PROJECT_ID;
    const secret = typeof binding?.secret === "string" ? binding.secret : "";
    const secretMatch = /^(?:projects\/([^/]+)\/secrets\/)?([^/]+)$/u.exec(secret);
    return binding?.key === expectedKey
        && [PROJECT_ID, PROJECT_NUMBER].includes(projectId)
        && secretMatch !== null
        && (secretMatch[1] === undefined
            || [PROJECT_ID, PROJECT_NUMBER].includes(secretMatch[1]))
        && secretMatch[2] === expectedKey
        && /^[1-9]\d*$/u.test(String(binding?.version ?? ""));
}

export function buildSecretCleanupPlan(functionResources) {
    if (!Array.isArray(functionResources)
        || functionResources.length !== Object.keys(SECRET_REQUIREMENTS).length) {
        throw new FunctionSecretConfigurationError("function_inventory");
    }

    const resourcesById = new Map();
    for (const resource of functionResources) {
        const name = typeof resource?.name === "string" ? resource.name : "";
        const functionId = name.split("/").at(-1);
        if (!Object.hasOwn(SECRET_REQUIREMENTS, functionId)
            || name !== exactFunctionName(functionId)
            || resourcesById.has(functionId)) {
            throw new FunctionSecretConfigurationError("function_inventory");
        }
        resourcesById.set(functionId, resource);
    }

    const clearFunctionIds = [];
    for (const [functionId, requiredKeys] of Object.entries(SECRET_REQUIREMENTS)) {
        const configuredVariables = resourcesById.get(functionId)?.serviceConfig
            ?.secretEnvironmentVariables;
        if (configuredVariables !== undefined && !Array.isArray(configuredVariables)) {
            throw new FunctionSecretConfigurationError("secret_inventory");
        }
        const variables = configuredVariables ?? [];
        if (requiredKeys.length === 0) {
            if (variables.length > 0) clearFunctionIds.push(functionId);
            continue;
        }
        if (variables.length !== requiredKeys.length
            || requiredKeys.some((key) =>
                variables.filter((binding) => isExactBinding(binding, key)).length !== 1)) {
            throw new FunctionSecretConfigurationError("required_secret_binding");
        }
    }
    return clearFunctionIds;
}

async function readInventory(registry) {
    try {
        return await Promise.all(Object.keys(SECRET_REQUIREMENTS).map((functionId) =>
            registry.getFunction(functionId)));
    } catch {
        throw new FunctionSecretConfigurationError("function_read");
    }
}

export async function configureFunctionSecrets(registry, mode) {
    if (!["apply", "verify"].includes(mode)) {
        throw new FunctionSecretConfigurationError("arguments");
    }
    const cleanupPlan = buildSecretCleanupPlan(await readInventory(registry));
    if (mode === "verify" && cleanupPlan.length > 0) {
        throw new FunctionSecretConfigurationError("stale_secret_binding");
    }

    if (mode === "apply") {
        for (const functionId of cleanupPlan) {
            try {
                const operationName = await registry.clearSecrets(functionId);
                await registry.waitOperation(operationName);
            } catch (error) {
                if (error instanceof FunctionSecretConfigurationError) throw error;
                throw new FunctionSecretConfigurationError("secret_cleanup");
            }
        }
    }

    const remaining = buildSecretCleanupPlan(await readInventory(registry));
    if (remaining.length > 0) {
        throw new FunctionSecretConfigurationError("secret_cleanup_readback");
    }
    return Object.freeze({ cleared: cleanupPlan.length });
}

async function createRegistry() {
    const { google } = await import("googleapis");
    const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    let authClient;
    try {
        authClient = await auth.getClient();
    } catch {
        throw new FunctionSecretConfigurationError("adc");
    }
    const functionsApi = google.cloudfunctions({ version: "v2", auth: authClient });

    return Object.freeze({
        async getFunction(functionId) {
            const response = await functionsApi.projects.locations.functions.get({
                name: exactFunctionName(functionId)
            }, REQUEST_OPTIONS);
            return response.data;
        },
        async clearSecrets(functionId) {
            const name = exactFunctionName(functionId);
            const response = await functionsApi.projects.locations.functions.patch({
                name,
                updateMask: "serviceConfig.secretEnvironmentVariables",
                requestBody: {
                    name,
                    serviceConfig: { secretEnvironmentVariables: [] }
                }
            }, REQUEST_OPTIONS);
            if (typeof response.data?.name !== "string" || response.data.name.length === 0) {
                throw new FunctionSecretConfigurationError("secret_cleanup_operation");
            }
            return response.data.name;
        },
        async waitOperation(operationName) {
            if (!/^projects\/(?:roco-spring-registration-2026|149052181991)\/locations\/europe-west3\/operations\/[^/]+$/u.test(
                operationName
            )) {
                throw new FunctionSecretConfigurationError("secret_cleanup_operation");
            }
            for (let poll = 0; poll < MAX_OPERATION_POLLS; poll += 1) {
                const response = await functionsApi.projects.locations.operations.get({
                    name: operationName
                }, REQUEST_OPTIONS);
                if (response.data?.done === true) {
                    if (response.data.error) {
                        throw new FunctionSecretConfigurationError("secret_cleanup_operation");
                    }
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS));
            }
            throw new FunctionSecretConfigurationError("secret_cleanup_timeout");
        }
    });
}

async function main() {
    const mode = parseMode(process.argv.slice(2));
    const result = await configureFunctionSecrets(await createRegistry(), mode);
    process.stdout.write(
        `Function secret bindings verified: OAuth is reconciler-only, rate limiting is registerTeam-only, stale bindings cleared=${result.cleared}.\n`
    );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
    main().catch((error) => {
        const stage = error instanceof FunctionSecretConfigurationError
            ? error.stage
            : "unexpected";
        process.stderr.write(`Function secret configuration failed [stage=${stage}].\n`);
        process.exitCode = 1;
    });
}
