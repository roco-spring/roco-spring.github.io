#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "roco-spring-registration-2026";
const BILLING_ACCOUNT_PATTERN = /^billingAccounts\/[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/u;
const BILLING_READONLY_SCOPE =
    "https://www.googleapis.com/auth/cloud-billing.readonly";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_ADC_BYTES = 256 * 1024;
const GOOGLE_REQUEST_OPTIONS = Object.freeze({
    timeout: 8_000,
    retry: false,
    maxRedirects: 0,
});

// Provider debug modes can print headers or OAuth exchange details.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
delete process.env.GOOGLE_SDK_NODE_LOGGING;

/**
 * Keep command-line failures explicit without printing provider response bodies,
 * OAuth material, payment details, or billing-account metadata.
 */
export class CloudBillingHealthError extends Error {
    constructor(stage) {
        super("Cloud Billing health verification failed.");
        this.name = "CloudBillingHealthError";
        this.stage = stage;
    }
}

/**
 * A project can remain linked to a closed account while `billingEnabled` is
 * still true. Production is healthy only when both checks succeed.
 */
export async function verifyCloudBillingHealth(client, projectId = PROJECT_ID) {
    let projectBilling;
    try {
        projectBilling = await client.getProjectBillingInfo(projectId);
    } catch {
        throw new CloudBillingHealthError("project_billing_read");
    }

    const accountName = projectBilling?.billingAccountName;
    if (
        projectBilling?.projectId !== projectId
        || projectBilling?.billingEnabled !== true
        || typeof accountName !== "string"
        || !BILLING_ACCOUNT_PATTERN.test(accountName)
    ) {
        throw new CloudBillingHealthError("project_billing_link");
    }

    let account;
    try {
        account = await client.getBillingAccount(accountName);
    } catch {
        throw new CloudBillingHealthError("billing_account_read");
    }

    if (account?.name !== accountName || account?.open !== true) {
        throw new CloudBillingHealthError("billing_account_closed");
    }

    return { projectId, billingEnabled: true, accountOpen: true };
}

function billingAdcPath(environment, homedir) {
    if (environment.GOOGLE_APPLICATION_CREDENTIALS) {
        return path.resolve(environment.GOOGLE_APPLICATION_CREDENTIALS);
    }
    if (environment.CLOUDSDK_CONFIG) {
        return path.resolve(
            environment.CLOUDSDK_CONFIG,
            "application_default_credentials.json",
        );
    }
    const configRoot = environment.XDG_CONFIG_HOME
        ? path.resolve(environment.XDG_CONFIG_HOME)
        : path.join(homedir, ".config");
    return path.join(configRoot, "gcloud", "application_default_credentials.json");
}

/**
 * Read only a direct local ADC file. Reject metadata and credential-broker
 * discovery so authentication cannot introduce an unbounded hidden network
 * exchange before the hardened Google transport exists.
 */
export async function loadBillingAdcCredentials({
    environment = process.env,
    homedir = os.homedir(),
    readFileImplementation = readFile,
    statImplementation = stat,
} = {}) {
    const adcPath = billingAdcPath(environment, homedir);
    let metadata;
    try {
        metadata = await statImplementation(adcPath);
    } catch {
        throw new CloudBillingHealthError("adc");
    }
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ADC_BYTES) {
        throw new CloudBillingHealthError("adc");
    }

    let credentials;
    try {
        credentials = JSON.parse(await readFileImplementation(adcPath, "utf8"));
    } catch {
        throw new CloudBillingHealthError("adc");
    }
    if (!credentials || typeof credentials !== "object") {
        throw new CloudBillingHealthError("adc");
    }
    if (credentials.universe_domain !== undefined
        && credentials.universe_domain !== "googleapis.com") {
        throw new CloudBillingHealthError("adc_type");
    }
    if (credentials.token_uri !== undefined
        && credentials.token_uri !== GOOGLE_TOKEN_URL) {
        throw new CloudBillingHealthError("adc_type");
    }

    const authorizedUser = credentials.type === "authorized_user"
        && typeof credentials.client_id === "string"
        && credentials.client_id.length > 0
        && typeof credentials.client_secret === "string"
        && credentials.client_secret.length > 0
        && typeof credentials.refresh_token === "string"
        && credentials.refresh_token.length > 0;
    const serviceAccount = credentials.type === "service_account"
        && typeof credentials.client_email === "string"
        && credentials.client_email.endsWith(".gserviceaccount.com")
        && typeof credentials.private_key === "string"
        && credentials.private_key.length > 0;
    if (!authorizedUser && !serviceAccount) {
        throw new CloudBillingHealthError("adc_type");
    }
    return credentials;
}

/**
 * Remove googleapis' hidden retry and redirect defaults from each OAuth token
 * and Cloud Billing API request. Every network request is single-attempt,
 * bounded to eight seconds, and prohibited from following redirects.
 */
export function hardenGoogleAuthTransport(authClient) {
    const transporter = authClient?.transporter;
    if (!transporter || typeof transporter.request !== "function") {
        throw new CloudBillingHealthError("adc_transport");
    }
    const request = transporter.request.bind(transporter);
    transporter.request = (options) => request({
        ...options,
        ...GOOGLE_REQUEST_OPTIONS,
    });
    return authClient;
}

/**
 * Application Default Credentials are used only for two Cloud Billing GETs.
 * Service-account ADC honors the requested scope; authorized-user ADC can
 * retain its original grant, so least privilege is enforced by IAM and the
 * deliberately tiny client surface rather than by assuming scope narrowing.
 * Access tokens and provider responses are never logged. An injectable Google
 * namespace keeps the transport policy unit-testable.
 */
export async function createGoogleCloudBillingClient(
    googleNamespace = null,
    credentialsLoader = loadBillingAdcCredentials,
) {
    let google = googleNamespace;
    if (!google) ({ google } = await import("googleapis"));

    const credentials = await credentialsLoader();
    google.options(GOOGLE_REQUEST_OPTIONS);
    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: [BILLING_READONLY_SCOPE],
    });
    let authClient;
    try {
        authClient = hardenGoogleAuthTransport(await auth.getClient());
    } catch (error) {
        if (error instanceof CloudBillingHealthError) throw error;
        throw new CloudBillingHealthError("adc_transport");
    }
    const billing = google.cloudbilling({ version: "v1", auth: authClient });

    return {
        async getProjectBillingInfo(projectId) {
            const response = await billing.projects.getBillingInfo({
                name: `projects/${projectId}`,
            }, GOOGLE_REQUEST_OPTIONS);
            return response.data;
        },
        async getBillingAccount(accountName) {
            const response = await billing.billingAccounts.get(
                { name: accountName },
                GOOGLE_REQUEST_OPTIONS,
            );
            return response.data;
        },
    };
}

async function main() {
    try {
        const client = await createGoogleCloudBillingClient();
        await verifyCloudBillingHealth(client);
        console.log("Cloud Billing health gate passed: project linked; account open.");
    } catch (error) {
        const stage = error instanceof CloudBillingHealthError
            ? error.stage
            : "initialization";
        console.error(`Cloud Billing health gate failed [stage=${stage}].`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
