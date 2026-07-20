import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    GoogleIntegrationHealthError,
    extractBoundSecretReferences,
    findExistingAppSpreadsheet,
    formatSafeHealthFailure,
    hardenGoogleAuthTransport,
    parseSecretSource,
    requestOAuthJson,
    resolveSecretVersionNames,
    runGoogleIntegrationHealthGate,
    sanitizeHealthError,
    selectLatestEnabledVersion,
    verifyExactScopes,
    verifyOrganizerIdentity,
    verifyPrivateDriveFolder
} from "../scripts/verify-google-integration-health.mjs";

const PROJECT_ID = "roco-spring-registration-2026";
const FOLDER_ID = "17UXoH2ldTuSFyhaxOknu6IvGxFbr7QYU";
const CLIENT_SECRET_KEY = "GOOGLE_OAUTH_CLIENT_SECRET";
const REFRESH_TOKEN_KEY = "GOOGLE_OAUTH_REFRESH_TOKEN";
const RATE_LIMIT_SECRET_KEY = "RATE_LIMIT_HMAC_SECRET";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function resource(secret, version) {
    return `projects/${PROJECT_ID}/secrets/${secret}/versions/${version}`;
}

function encoded(value) {
    return Buffer.from(value, "utf8").toString("base64");
}

function functionResource(clientVersion = "2", refreshVersion = "3") {
    return {
        serviceConfig: {
            secretEnvironmentVariables: [
                {
                    key: CLIENT_SECRET_KEY,
                    projectId: PROJECT_ID,
                    secret: CLIENT_SECRET_KEY,
                    version: clientVersion
                },
                {
                    key: REFRESH_TOKEN_KEY,
                    projectId: PROJECT_ID,
                    secret: REFRESH_TOKEN_KEY,
                    version: refreshVersion
                },
                {
                    key: "RATE_LIMIT_HMAC_SECRET",
                    projectId: PROJECT_ID,
                    secret: "RATE_LIMIT_HMAC_SECRET",
                    version: "1"
                }
            ]
        }
    };
}

function deployedFunctionResource(
    functionName,
    clientVersion = "2",
    refreshVersion = "3",
    rateLimitVersion = "1"
) {
    if (functionName === "registerTeam") {
        return {
            serviceConfig: {
                secretEnvironmentVariables: [{
                    key: RATE_LIMIT_SECRET_KEY,
                    projectId: PROJECT_ID,
                    secret: RATE_LIMIT_SECRET_KEY,
                    version: rateLimitVersion
                }]
            }
        };
    }
    if (functionName === "updateMyTeam") {
        return { serviceConfig: { secretEnvironmentVariables: [] } };
    }
    const configured = functionResource(clientVersion, refreshVersion);
    configured.serviceConfig.secretEnvironmentVariables.pop();
    return configured;
}

function healthyOrganizer({ spreadsheets = true } = {}) {
    let disposed = false;
    return {
        async refreshAccessToken() {
            return {
                accessToken: "access-token-kept-in-memory",
                expiresIn: 3_600,
                scopes: [DRIVE_SCOPE, GMAIL_SCOPE]
            };
        },
        async getDriveFolder() {
            return {
                id: FOLDER_ID,
                mimeType: "application/vnd.google-apps.folder",
                trashed: false,
                capabilities: { canAddChildren: true }
            };
        },
        async getOrganizerEmail() {
            return "shashanksagnihotri@gmail.com";
        },
        async listDriveFolderPermissions() {
            return { permissions: [{ type: "user", role: "owner" }] };
        },
        async listDriveSpreadsheets() {
            return {
                files: spreadsheets
                    ? [{
                        id: "private-sheet-id",
                        mimeType: "application/vnd.google-apps.spreadsheet",
                        trashed: false,
                        parents: [FOLDER_ID],
                        appProperties: { registrationRequestId: "opaque-marker" }
                    }]
                    : []
            };
        },
        async readSpreadsheet(id) {
            assert.equal(id, "private-sheet-id");
            return id;
        },
        dispose() {
            disposed = true;
        },
        wasDisposed() {
            return disposed;
        }
    };
}

function latestDependencies(organizer = healthyOrganizer()) {
    return {
        secretManager: {
            async listVersions(secretResource) {
                return {
                    versions: [
                        { name: `${secretResource}/versions/1`, state: "DISABLED" },
                        { name: `${secretResource}/versions/2`, state: "ENABLED" }
                    ]
                };
            },
            async accessVersion(versionName) {
                if (versionName.includes(CLIENT_SECRET_KEY)) {
                    return encoded("client-secret-kept-in-memory");
                }
                return encoded("refresh-token-kept-in-memory");
            }
        },
        functionRegistry: {
            async getFunction() {
                throw new Error("latest mode must not inspect the deployed function");
            }
        },
        createOrganizerClient(clientSecret, refreshToken) {
            assert.equal(clientSecret, "client-secret-kept-in-memory");
            assert.equal(refreshToken, "refresh-token-kept-in-memory");
            return organizer;
        }
    };
}

test("secret-source argument is mandatory and limited to explicit release modes", () => {
    assert.equal(parseSecretSource(["--secret-source=latest"]), "latest");
    assert.equal(parseSecretSource(["--secret-source=bound"]), "bound");
    for (const argumentsList of [
        [],
        ["--secret-source=other"],
        ["--secret-source=latest", "--verbose"],
        ["latest"]
    ]) {
        assert.throws(
            () => parseSecretSource(argumentsList),
            (error) => error instanceof GoogleIntegrationHealthError
                && error.stage === "arguments"
        );
    }
});

test("latest selection ignores disabled and malformed versions", () => {
    const parent = `projects/${PROJECT_ID}/secrets/${CLIENT_SECRET_KEY}`;
    assert.equal(selectLatestEnabledVersion(parent, [
        { name: `${parent}/versions/99`, state: "DISABLED" },
        { name: `${parent}/versions/not-a-number`, state: "ENABLED" },
        { name: `${parent}/versions/7`, state: "ENABLED" },
        { name: `${parent}/versions/12`, state: "ENABLED" }
    ]), `${parent}/versions/12`);
});

test("bound mode requires the exact split numeric secret architecture", async () => {
    let versionLists = 0;
    const inspectedFunctions = [];
    const resolved = await resolveSecretVersionNames("bound", {
        secretManager: {
            async listVersions() {
                versionLists += 1;
                return { versions: [] };
            }
        },
        functionRegistry: {
            async getFunction(functionName) {
                inspectedFunctions.push(functionName);
                return deployedFunctionResource(functionName, "5", "8");
            }
        }
    });
    assert.equal(resolved.get(CLIENT_SECRET_KEY), resource(CLIENT_SECRET_KEY, 5));
    assert.equal(resolved.get(REFRESH_TOKEN_KEY), resource(REFRESH_TOKEN_KEY, 8));
    assert.equal(
        resolved.get(RATE_LIMIT_SECRET_KEY),
        resource(RATE_LIMIT_SECRET_KEY, 1)
    );
    assert.equal(versionLists, 0);
    assert.deepEqual(inspectedFunctions, [
        "registerTeam",
        "updateMyTeam",
        "reconcileRegistrations"
    ]);
});

test("bound mode rejects latest aliases and a nonnumeric rate-limit binding", async () => {
    for (const versions of [
        { client: "latest", refresh: "8", rate: "1" },
        { client: "5", refresh: "8", rate: "latest" }
    ]) {
        await assert.rejects(
            resolveSecretVersionNames("bound", {
                secretManager: {},
                functionRegistry: {
                    async getFunction(functionName) {
                        return deployedFunctionResource(
                            functionName,
                            versions.client,
                            versions.refresh,
                            versions.rate
                        );
                    }
                }
            }),
            (error) => error instanceof GoogleIntegrationHealthError
                && error.stage === "bound_secret_config"
        );
    }
});

test("bound mode rejects OAuth secret bindings on public callables", async () => {
    for (const publicFunction of ["registerTeam", "updateMyTeam"]) {
        await assert.rejects(
            resolveSecretVersionNames("bound", {
                secretManager: {},
                functionRegistry: {
                    async getFunction(functionName) {
                        return functionName === publicFunction
                            ? functionResource("5", "8")
                            : deployedFunctionResource(functionName, "5", "8");
                    }
                }
            }),
            (error) => error instanceof GoogleIntegrationHealthError
                && error.stage === "bound_secret_config"
        );
    }
});

test("bound mode requires registerTeam's numeric rate-limit binding", async () => {
    const missingRate = { serviceConfig: { secretEnvironmentVariables: [] } };
    await assert.rejects(
        resolveSecretVersionNames("bound", {
            secretManager: {},
            functionRegistry: {
                async getFunction(functionName) {
                    return functionName === "registerTeam"
                        ? missingRate
                        : deployedFunctionResource(functionName, "5", "8");
                }
            }
        }),
        (error) => error instanceof GoogleIntegrationHealthError
            && error.stage === "bound_secret_config"
    );
});

test("bound configuration rejects missing, duplicate, or cross-project secrets", () => {
    const missing = functionResource();
    missing.serviceConfig.secretEnvironmentVariables.pop();
    missing.serviceConfig.secretEnvironmentVariables.pop();
    assert.throws(() => extractBoundSecretReferences(missing));

    const duplicate = functionResource();
    duplicate.serviceConfig.secretEnvironmentVariables.push({
        ...duplicate.serviceConfig.secretEnvironmentVariables[0]
    });
    assert.throws(() => extractBoundSecretReferences(duplicate));

    const crossProject = functionResource();
    crossProject.serviceConfig.secretEnvironmentVariables[0].projectId = "another-project";
    assert.throws(() => extractBoundSecretReferences(crossProject));
});

test("bound configuration accepts the expected project number and full resource", () => {
    const configured = functionResource();
    configured.serviceConfig.secretEnvironmentVariables[0].projectId = "149052181991";
    configured.serviceConfig.secretEnvironmentVariables[0].secret =
        `projects/149052181991/secrets/${CLIENT_SECRET_KEY}`;
    assert.equal(
        extractBoundSecretReferences(configured).get(CLIENT_SECRET_KEY).version,
        "2"
    );
});

test("complete latest health gate refreshes OAuth and reads a marked Sheet", async () => {
    const organizer = healthyOrganizer();
    const result = await runGoogleIntegrationHealthGate(
        latestDependencies(organizer),
        "latest"
    );
    assert.deepEqual(result, {
        source: "latest",
        senderAccount: "exact",
        sheetsRead: "verified"
    });
    assert.equal(organizer.wasDisposed(), true);
});

test("complete bound health gate accesses and validates the exact HMAC binding", async () => {
    const accessed = [];
    const dependencies = latestDependencies();
    dependencies.functionRegistry.getFunction = async (functionName) =>
        deployedFunctionResource(functionName, "2", "2");
    dependencies.secretManager.accessVersion = async (versionName) => {
        accessed.push(versionName);
        if (versionName.includes(RATE_LIMIT_SECRET_KEY)) {
            return encoded("h".repeat(32));
        }
        if (versionName.includes(CLIENT_SECRET_KEY)) {
            return encoded("client-secret-kept-in-memory");
        }
        return encoded("refresh-token-kept-in-memory");
    };

    await assert.doesNotReject(
        runGoogleIntegrationHealthGate(dependencies, "bound")
    );
    assert.ok(accessed.includes(resource(RATE_LIMIT_SECRET_KEY, 1)));
    assert.ok(accessed.includes(resource(CLIENT_SECRET_KEY, 2)));
    assert.ok(accessed.includes(resource(REFRESH_TOKEN_KEY, 2)));

    dependencies.secretManager.accessVersion = async (versionName) =>
        encoded(versionName.includes(RATE_LIMIT_SECRET_KEY) ? "too-short" : "unused");
    await assert.rejects(
        runGoogleIntegrationHealthGate(dependencies, "bound"),
        (error) => error instanceof GoogleIntegrationHealthError
            && error.stage === "rate_limit_secret"
    );
});

test("health gate passes with an explicit not-available Sheet result", async () => {
    const organizer = healthyOrganizer({ spreadsheets: false });
    const result = await runGoogleIntegrationHealthGate(
        latestDependencies(organizer),
        "latest"
    );
    assert.deepEqual(result, {
        source: "latest",
        senderAccount: "exact",
        sheetsRead: "not_available"
    });
    assert.equal(organizer.wasDisposed(), true);
});

test("health gate rejects an unusably short OAuth access-token lifetime", async () => {
    const organizer = healthyOrganizer();
    organizer.refreshAccessToken = async () => ({
        accessToken: "access-token-kept-in-memory",
        expiresIn: 60,
        scopes: [DRIVE_SCOPE, GMAIL_SCOPE]
    });
    await assert.rejects(
        runGoogleIntegrationHealthGate(
            latestDependencies(organizer),
            "latest"
        ),
        (error) => error instanceof GoogleIntegrationHealthError
            && error.stage === "oauth_refresh"
    );
    assert.equal(organizer.wasDisposed(), true);
});

test("scope verification rejects missing and broadened grants", () => {
    assert.doesNotThrow(() => verifyExactScopes([DRIVE_SCOPE, GMAIL_SCOPE]));
    assert.throws(() => verifyExactScopes([DRIVE_SCOPE]));
    assert.throws(() => verifyExactScopes([
        DRIVE_SCOPE,
        GMAIL_SCOPE,
        "https://www.googleapis.com/auth/drive"
    ]));
});

test("organizer verification rejects a different account without exposing it", async () => {
    const unexpected = "unexpected-account@example.org";
    await assert.rejects(
        verifyOrganizerIdentity({
            async getOrganizerEmail() {
                return unexpected;
            }
        }),
        (error) => error instanceof GoogleIntegrationHealthError
            && error.stage === "organizer_identity"
            && !String(error).includes(unexpected)
    );
});

test("Drive privacy check rejects public or domain-wide access", async () => {
    for (const type of ["anyone", "domain"]) {
        const organizer = healthyOrganizer();
        organizer.listDriveFolderPermissions = async () => ({
            permissions: [{ type, role: "reader" }]
        });
        await assert.rejects(
            verifyPrivateDriveFolder(organizer),
            (error) => error instanceof GoogleIntegrationHealthError
                && error.stage === "drive_privacy"
        );
    }
});

test("only marker-bound Sheets in the configured folder are selected", async () => {
    const organizer = healthyOrganizer();
    organizer.listDriveSpreadsheets = async () => ({
        files: [
            {
                id: "unmarked",
                mimeType: "application/vnd.google-apps.spreadsheet",
                parents: [FOLDER_ID],
                appProperties: {}
            },
            {
                id: "wrong-parent",
                mimeType: "application/vnd.google-apps.spreadsheet",
                parents: ["elsewhere"],
                appProperties: { registrationRequestId: "marker" }
            }
        ]
    });
    assert.equal(await findExistingAppSpreadsheet(organizer), null);
});

test("provider failures are reduced to allowlisted code and status only", () => {
    const sensitive = "refresh-token-should-never-appear";
    const rawError = {
        message: `request contained ${sensitive}`,
        code: "unknown-provider-secret",
        response: {
            status: 400,
            data: {
                error: "invalid_grant",
                error_description: `expired ${sensitive}`
            },
            config: { data: { client_secret: sensitive } }
        }
    };
    const safe = sanitizeHealthError("oauth_refresh", rawError);
    const output = formatSafeHealthFailure(safe);
    assert.match(output, /stage=oauth_refresh/u);
    assert.match(output, /provider_code=invalid_grant/u);
    assert.match(output, /http_status=400/u);
    assert.doesNotMatch(output, new RegExp(sensitive, "u"));
    assert.doesNotMatch(output, /expired|client_secret|error_description/u);
});

test("OAuth HTTP probe is single-attempt, bounded, and sanitizes provider data", async () => {
    let calls = 0;
    const sensitive = "secret-provider-description";
    await assert.rejects(
        requestOAuthJson(
            async (_url, options) => {
                calls += 1;
                assert.ok(options.signal instanceof AbortSignal);
                assert.equal(options.redirect, "error");
                return {
                    ok: false,
                    status: 503,
                    async json() {
                        return {
                            error: "temporarily_unavailable",
                            error_description: sensitive
                        };
                    }
                };
            },
            "oauth_refresh",
            "https://oauth2.googleapis.com/token",
            { method: "POST" }
        ),
        (error) => {
            assert.equal(calls, 1);
            const output = formatSafeHealthFailure(error);
            assert.match(output, /provider_code=temporarily_unavailable/u);
            assert.match(output, /http_status=503/u);
            assert.doesNotMatch(output, new RegExp(sensitive, "u"));
            return true;
        }
    );
});

test("ADC transport strips auth-library retries and applies the hard timeout", async () => {
    let observed;
    const authClient = {
        transporter: {
            async request(options) {
                observed = options;
                return { data: {} };
            }
        }
    };
    hardenGoogleAuthTransport(authClient);
    await authClient.transporter.request({
        method: "POST",
        retry: true,
        timeout: 999_999
    });
    assert.equal(observed.retry, false);
    assert.equal(observed.timeout, 8_000);
    assert.equal(observed.method, "POST");
});

test("malformed secret payloads fail without reaching the OAuth factory", async () => {
    let factoryCalled = false;
    const dependencies = latestDependencies();
    dependencies.secretManager.accessVersion = async () => "not base64 !!";
    dependencies.createOrganizerClient = () => {
        factoryCalled = true;
        return healthyOrganizer();
    };
    await assert.rejects(
        runGoogleIntegrationHealthGate(dependencies, "latest"),
        (error) => error instanceof GoogleIntegrationHealthError
            && error.stage === "secret_access"
    );
    assert.equal(factoryCalled, false);
});

test("production deploy chain runs latest before deploy and bound after deploy", async () => {
    const packageConfig = JSON.parse(await readFile(
        new URL("../package.json", import.meta.url),
        "utf8"
    ));
    assert.equal(
        packageConfig.scripts["google:health:latest"],
        "node scripts/verify-google-integration-health.mjs --secret-source=latest"
    );
    assert.equal(
        packageConfig.scripts["google:health:bound"],
        "node scripts/verify-google-integration-health.mjs --secret-source=bound"
    );
    const chain = packageConfig.scripts["deploy:production"];
    const latest = chain.indexOf("google:health:latest");
    const deploy = chain.indexOf("deploy:firebase");
    const bound = chain.indexOf("google:health:bound");
    const smoke = chain.indexOf("backend:smoke");
    assert.ok(latest >= 0 && latest < deploy);
    assert.ok(deploy < bound && bound < smoke);
});

test("live Google adapters globally disable hidden retries", async () => {
    const source = await readFile(
        new URL("../scripts/verify-google-integration-health.mjs", import.meta.url),
        "utf8"
    );
    assert.match(
        source,
        /google\.options\(GOOGLE_REQUEST_OPTIONS\)/u
    );
    assert.match(source, /const REQUEST_TIMEOUT_MS = 8_000/u);
    assert.match(source, /redirect: "error"/u);
    assert.doesNotMatch(source, /\.getAccessToken\(|\.getTokenInfo\(/u);
    assert.doesNotMatch(source, /oauth2\.googleapis\.com\/tokeninfo/u);
    assert.match(source, /gmail_send=not_exercised/u);
    assert.match(source, /sender_account=\$\{result\.senderAccount\}/u);
    assert.doesNotMatch(
        source,
        /drive\.(?:files|permissions)\.(?:create|update|delete)|sheets\.spreadsheets\.(?:batchUpdate|values)|google\.gmail/u
    );
});
