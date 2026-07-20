#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";

const PROJECT_ID = "roco-spring-registration-2026";
const UPDATE_MASK = [
    "client.permissions.disabledUserSignup",
    "client.permissions.disabledUserDeletion",
    "emailPrivacyConfig.enableImprovedEmailPrivacy",
    "signIn.email.enabled",
    "signIn.email.passwordRequired"
].join(",");

// Firebase CLI diagnostics can echo the process environment. Keep this command quiet
// even when a parent shell has broad debug flags enabled.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
delete process.env.RATE_LIMIT_HMAC_SECRET;

const require = createRequire(import.meta.url);
const {
    getGlobalDefaultAccount,
    getProjectDefaultAccount,
    setActiveAccount
} = require("firebase-tools/lib/auth.js");
const { requireAuth } = require("firebase-tools/lib/requireAuth.js");
const { Client } = require("firebase-tools/lib/apiv2.js");

function quotaRequestOptions() {
    // Firebase's low-level API client reads ADC for authentication, but it does
    // not propagate ADC's quota_project_id. Identity Toolkit requires the
    // consumer project explicitly when user ADC is used.
    return { headers: { "x-goog-user-project": PROJECT_ID } };
}

function isProductionSafe(config) {
    return config?.client?.permissions?.disabledUserSignup === true
        && config?.client?.permissions?.disabledUserDeletion === true
        && config?.emailPrivacyConfig?.enableImprovedEmailPrivacy === true
        && config?.signIn?.email?.enabled === true
        && config?.signIn?.email?.passwordRequired === true;
}

async function main() {
    const options = {
        project: PROJECT_ID,
        projectRoot: process.cwd()
    };
    const account = getProjectDefaultAccount(process.cwd()) ?? getGlobalDefaultAccount();

    if (account) {
        setActiveAccount(options, account);
    }

    try {
        await requireAuth(options);
    } catch {
        throw new Error("Firebase authentication is required. Run `node scripts/firebase-safe.mjs login` in this trusted terminal, then retry.");
    }

    const client = new Client({
        urlPrefix: "https://identitytoolkit.googleapis.com",
        apiVersion: "admin/v2"
    });
    const projectPath = `/projects/${PROJECT_ID}/config`;
    const before = (await client.get(projectPath, quotaRequestOptions())).body;

    if (!isProductionSafe(before)) {
        await client.patch(
            `${projectPath}?updateMask=${encodeURIComponent(UPDATE_MASK)}`,
            {
                client: {
                    permissions: {
                        disabledUserSignup: true,
                        disabledUserDeletion: true
                    }
                },
                emailPrivacyConfig: {
                    enableImprovedEmailPrivacy: true
                },
                signIn: {
                    email: {
                        enabled: true,
                        passwordRequired: true
                    }
                }
            },
            quotaRequestOptions()
        );
    }

    const verified = (await client.get(projectPath, quotaRequestOptions())).body;

    if (!isProductionSafe(verified)) {
        throw new Error("Identity Platform configuration read-back did not match the required production policy.");
    }

    process.stdout.write(
        "Identity Platform verified: email/password login and improved email privacy are enabled; public end-user signup/deletion are disabled.\n"
    );
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : "Identity Platform configuration failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
});
