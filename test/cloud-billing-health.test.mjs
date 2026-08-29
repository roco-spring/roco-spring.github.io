import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    CloudBillingHealthError,
    createGoogleCloudBillingClient,
    loadBillingAdcCredentials,
    verifyCloudBillingHealth,
} from "../scripts/verify-cloud-billing.mjs";

const PROJECT_ID = "roco-spring-registration-2026";
const ACCOUNT_NAME = "billingAccounts/0A1B2C-D3E4F5-G6H7I8";

function client(overrides = {}) {
    return {
        async getProjectBillingInfo(projectId) {
            assert.equal(projectId, PROJECT_ID);
            return {
                projectId,
                billingEnabled: true,
                billingAccountName: ACCOUNT_NAME,
            };
        },
        async getBillingAccount(accountName) {
            assert.equal(accountName, ACCOUNT_NAME);
            return { name: accountName, open: true };
        },
        ...overrides,
    };
}

test("billing health requires a linked project and an open account", async () => {
    await assert.doesNotReject(verifyCloudBillingHealth(client()));
});

test("a surviving project link does not hide a closed billing account", async () => {
    await assert.rejects(
        verifyCloudBillingHealth(client({
            async getBillingAccount() {
                return { name: ACCOUNT_NAME, open: false };
            },
        })),
        (error) => error instanceof CloudBillingHealthError
            && error.stage === "billing_account_closed",
    );
});

test("billing health rejects a missing or malformed project association", async () => {
    for (const projectBilling of [
        { projectId: PROJECT_ID, billingEnabled: false, billingAccountName: ACCOUNT_NAME },
        { projectId: PROJECT_ID, billingEnabled: true, billingAccountName: "" },
        {
            projectId: PROJECT_ID,
            billingEnabled: true,
            billingAccountName: "billingAccounts/lowerc-ase000-id0000",
        },
        { projectId: "another-project", billingEnabled: true, billingAccountName: ACCOUNT_NAME },
    ]) {
        await assert.rejects(
            verifyCloudBillingHealth(client({
                async getProjectBillingInfo() {
                    return projectBilling;
                },
            })),
            (error) => error instanceof CloudBillingHealthError
                && error.stage === "project_billing_link",
        );
    }
});

test("provider failures are reduced to safe stage-only errors", async () => {
    const sensitive = "provider response that must not escape";
    await assert.rejects(
        verifyCloudBillingHealth(client({
            async getProjectBillingInfo() {
                throw new Error(sensitive);
            },
        })),
        (error) => error instanceof CloudBillingHealthError
            && error.stage === "project_billing_read"
            && !error.message.includes(sensitive),
    );
    await assert.rejects(
        verifyCloudBillingHealth(client({
            async getBillingAccount() {
                throw new Error(sensitive);
            },
        })),
        (error) => error instanceof CloudBillingHealthError
            && error.stage === "billing_account_read"
            && !error.message.includes(sensitive),
    );
});

test("billing verifier disables provider logging that can expose auth headers", async () => {
    const source = await readFile(
        new URL("../scripts/verify-cloud-billing.mjs", import.meta.url),
        "utf8",
    );
    assert.match(source, /delete process\.env\.GOOGLE_SDK_NODE_LOGGING;/u);
});

test("live client requests the narrow billing scope and uses bounded one-shot transport", async () => {
    const fakeCredentials = {
        type: "authorized_user",
        client_id: "id",
        client_secret: "secret",
        refresh_token: "refresh",
    };
    const calls = {
        globalOptions: null,
        scope: null,
        credentials: null,
        authOptions: null,
        apiOptions: [],
    };
    const authClient = {
        transporter: {
            async request(options) {
                calls.authOptions = options;
                return { data: {} };
            },
        },
    };
    class FakeGoogleAuth {
        constructor(options) {
            calls.scope = options.scopes;
            calls.credentials = options.credentials;
        }

        async getClient() {
            return authClient;
        }
    }
    const google = {
        options(options) {
            calls.globalOptions = options;
        },
        auth: { GoogleAuth: FakeGoogleAuth },
        cloudbilling({ version, auth }) {
            assert.equal(version, "v1");
            assert.equal(auth, authClient);
            return {
                projects: {
                    async getBillingInfo(parameters, options) {
                        assert.deepEqual(parameters, { name: `projects/${PROJECT_ID}` });
                        calls.apiOptions.push(options);
                        return { data: { projectId: PROJECT_ID } };
                    },
                },
                billingAccounts: {
                    async get(parameters, options) {
                        assert.deepEqual(parameters, { name: ACCOUNT_NAME });
                        calls.apiOptions.push(options);
                        return { data: { name: ACCOUNT_NAME } };
                    },
                },
            };
        },
    };

    const billing = await createGoogleCloudBillingClient(
        google,
        async () => fakeCredentials,
    );
    await billing.getProjectBillingInfo(PROJECT_ID);
    await billing.getBillingAccount(ACCOUNT_NAME);
    await authClient.transporter.request({
        method: "POST",
        timeout: 999_999,
        retry: true,
        maxRedirects: 20,
    });

    const expectedOptions = { timeout: 8_000, retry: false, maxRedirects: 0 };
    assert.deepEqual(calls.scope, [
        "https://www.googleapis.com/auth/cloud-billing.readonly",
    ]);
    assert.equal(calls.credentials, fakeCredentials);
    assert.deepEqual(calls.globalOptions, expectedOptions);
    assert.deepEqual(calls.apiOptions, [expectedOptions, expectedOptions]);
    assert.deepEqual(calls.authOptions, {
        method: "POST",
        ...expectedOptions,
    });
});

test("malformed ADC transports fail at a safe stage", async () => {
    const google = {
        options() {},
        auth: {
            GoogleAuth: class {
                async getClient() {
                    return {};
                }
            },
        },
        cloudbilling() {
            throw new Error("must not be reached");
        },
    };
    await assert.rejects(
        createGoogleCloudBillingClient(google, async () => ({
            type: "authorized_user",
            client_id: "id",
            client_secret: "secret",
            refresh_token: "refresh",
        })),
        (error) => error instanceof CloudBillingHealthError
            && error.stage === "adc_transport",
    );
});

test("ADC discovery is limited to one bounded local direct-credential file", async () => {
    const environment = { CLOUDSDK_CONFIG: "/operator/config" };
    const credentials = {
        type: "authorized_user",
        client_id: "id",
        client_secret: "secret",
        refresh_token: "refresh",
        token_uri: "https://oauth2.googleapis.com/token",
    };
    let readPath = null;
    const loaded = await loadBillingAdcCredentials({
        environment,
        homedir: "/unused",
        async statImplementation(filePath) {
            assert.equal(filePath, "/operator/config/application_default_credentials.json");
            return { isFile: () => true, size: 512 };
        },
        async readFileImplementation(filePath, encoding) {
            readPath = filePath;
            assert.equal(encoding, "utf8");
            return JSON.stringify(credentials);
        },
    });
    assert.equal(readPath, "/operator/config/application_default_credentials.json");
    assert.deepEqual(loaded, credentials);

    for (const rejected of [
        { type: "external_account" },
        { ...credentials, universe_domain: "example.invalid" },
        { ...credentials, token_uri: "https://example.invalid/token" },
    ]) {
        await assert.rejects(
            loadBillingAdcCredentials({
                environment,
                async statImplementation() {
                    return { isFile: () => true, size: 512 };
                },
                async readFileImplementation() {
                    return JSON.stringify(rejected);
                },
            }),
            (error) => error instanceof CloudBillingHealthError
                && error.stage === "adc_type",
        );
    }
});

test("production release checks billing before publication, before cloud mutation, and after deploy", async () => {
    const packageConfig = JSON.parse(await readFile(
        new URL("../package.json", import.meta.url),
        "utf8",
    ));
    const commands = packageConfig.scripts["deploy:production"].split(" && ");
    const billingIndexes = commands.flatMap((command, index) => (
        command === "npm run billing:verify" ? [index] : []
    ));
    assert.equal(billingIndexes.length, 3);
    assert.ok(billingIndexes[0] < commands.indexOf("npm run release:push"));
    assert.equal(commands[billingIndexes[1] - 1], "npm run release:source");
    assert.equal(commands[billingIndexes[1] + 1], "npm run identity:configure");
    assert.equal(commands[billingIndexes[2] - 1], "npm run deploy:firebase");
    assert.equal(commands[billingIndexes[2] + 1], "npm run function-secrets:configure");
    assert.equal(
        packageConfig.scripts["production:runtime:verify"],
        "npm run billing:verify && npm run monitoring:verify",
    );
});
