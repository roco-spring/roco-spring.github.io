#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "roco-spring-registration-2026";
const PROJECT_NUMBER = "149052181991";
const REGION = "europe-west3";
const FUNCTION_SECRET_REQUIREMENTS = Object.freeze({
    registerTeam: Object.freeze(["RATE_LIMIT_HMAC_SECRET"]),
    updateMyTeam: Object.freeze([]),
    reconcileRegistrations: Object.freeze([
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN"
    ])
});
const DRIVE_FOLDER_ID = "1gZwIgAcwrtHZN2vW4XttTq5fFA-kU4Y4";
const GOOGLE_OAUTH_CLIENT_ID =
    "149052181991-dn69v7pid5o7fi89dtnusbklnbnncnho.apps.googleusercontent.com";
const REGISTRATION_SENDER = "shashanksagnihotri@gmail.com";
const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const REQUIRED_SCOPES = Object.freeze([
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/gmail.send"
]);
const REQUIRED_SECRET_KEYS = Object.freeze([
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN"
]);
const RATE_LIMIT_SECRET_KEY = "RATE_LIMIT_HMAC_SECRET";
const SAFE_PROVIDER_CODES = new Set([
    "access_denied",
    "accessNotConfigured",
    "deadline_exceeded",
    "invalid_client",
    "invalid_grant",
    "insufficient_scope",
    "invalid_request",
    "invalid_scope",
    "invalid_token",
    "not_found",
    "permission_denied",
    "rateLimitExceeded",
    "resource_exhausted",
    "serviceDisabled",
    "temporarily_unavailable",
    "unauthorized_client",
    "unavailable",
    "userRateLimitExceeded"
]);
const MAX_LIST_PAGES = 20;
const REQUEST_TIMEOUT_MS = 8_000;
const MINIMUM_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;
const GOOGLE_REQUEST_OPTIONS = Object.freeze({
    timeout: REQUEST_TIMEOUT_MS,
    retry: false
});

// Provider debug output can include request bodies containing OAuth material.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;

export class GoogleIntegrationHealthError extends Error {
    constructor(stage, status = null, providerCode = "unclassified") {
        super("Google integration health verification failed.");
        this.name = "GoogleIntegrationHealthError";
        this.stage = stage;
        this.status = status;
        this.providerCode = providerCode;
    }
}

export function parseSecretSource(argumentsList) {
    const options = argumentsList.filter((argument) =>
        argument.startsWith("--secret-source="));
    if (options.length !== 1 || argumentsList.length !== 1) {
        throw new GoogleIntegrationHealthError("arguments");
    }
    const source = options[0].slice("--secret-source=".length);
    if (source !== "latest" && source !== "bound") {
        throw new GoogleIntegrationHealthError("arguments");
    }
    return source;
}

function safeHttpStatus(error) {
    for (const candidate of [
        error?.response?.status,
        error?.status,
        error?.code
    ]) {
        const status = Number(candidate);
        if (Number.isInteger(status) && status >= 100 && status <= 599) {
            return status;
        }
    }
    return null;
}

function normalizeProviderCode(candidate) {
    if (typeof candidate !== "string") return null;
    const normalized = candidate.trim();
    if (SAFE_PROVIDER_CODES.has(normalized)) return normalized;
    const lower = normalized.toLowerCase();
    return SAFE_PROVIDER_CODES.has(lower) ? lower : null;
}

function safeProviderCode(error) {
    const responseData = error?.response?.data;
    const bodyError = responseData?.error;
    const candidates = [
        typeof bodyError === "string" ? bodyError : null,
        bodyError?.status,
        responseData?.status,
        error?.reason,
        typeof error?.code === "string" ? error.code : null
    ];
    const errorItems = Array.isArray(bodyError?.errors)
        ? bodyError.errors
        : Array.isArray(responseData?.errors)
            ? responseData.errors
            : [];
    for (const item of errorItems) candidates.push(item?.reason);
    for (const candidate of candidates) {
        const safe = normalizeProviderCode(candidate);
        if (safe) return safe;
    }
    return "unclassified";
}

export function sanitizeHealthError(stage, error) {
    if (error instanceof GoogleIntegrationHealthError) return error;
    return new GoogleIntegrationHealthError(
        stage,
        safeHttpStatus(error),
        safeProviderCode(error)
    );
}

export function formatSafeHealthFailure(error) {
    const safe = sanitizeHealthError("initialization", error);
    const details = [
        `stage=${safe.stage}`,
        `provider_code=${safe.providerCode}`
    ];
    if (safe.status !== null) details.push(`http_status=${safe.status}`);
    return `Google integration health gate failed [${details.join(" ")}].`;
}

export async function requestOAuthJson(
    fetchImplementation,
    stage,
    url,
    options
) {
    let response;
    try {
        response = await fetchImplementation(url, {
            ...options,
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        throw sanitizeHealthError(stage, error);
    }
    let data = {};
    try {
        data = await response.json();
    } catch {
        // A non-JSON provider response remains an intentionally generic failure.
    }
    if (!response.ok) {
        throw new GoogleIntegrationHealthError(
            stage,
            Number.isInteger(response.status) ? response.status : null,
            normalizeProviderCode(data?.error) ?? "unclassified"
        );
    }
    return data;
}

export function selectLatestEnabledVersion(secretResource, versions) {
    const expected = new RegExp(
        `^projects/(?:${PROJECT_ID}|${PROJECT_NUMBER})/secrets/([A-Za-z0-9_-]+)$`,
        "u",
    ).exec(secretResource ?? "");
    if (!expected) {
        throw new GoogleIntegrationHealthError("secret_version", null, "not_found");
    }
    const expectedSecret = expected[1];
    let selected = null;
    let selectedNumber = null;
    for (const version of versions) {
        if (version?.state !== "ENABLED") continue;
        const match = new RegExp(
            `^projects/(?:${PROJECT_ID}|${PROJECT_NUMBER})/secrets/${expectedSecret}/versions/([1-9]\\d*)$`,
            "u",
        ).exec(version?.name ?? "");
        if (!match) continue;
        const number = BigInt(match[1]);
        if (selectedNumber === null || number > selectedNumber) {
            selected = version.name;
            selectedNumber = number;
        }
    }
    if (!selected) {
        throw new GoogleIntegrationHealthError("secret_version", null, "not_found");
    }
    return selected;
}

async function listAllVersions(secretManager, secretResource) {
    const versions = [];
    let pageToken;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        let response;
        try {
            response = await secretManager.listVersions(secretResource, pageToken);
        } catch (error) {
            throw sanitizeHealthError("secret_metadata", error);
        }
        versions.push(...(Array.isArray(response?.versions) ? response.versions : []));
        pageToken = typeof response?.nextPageToken === "string"
            && response.nextPageToken.length > 0
            ? response.nextPageToken
            : undefined;
        if (!pageToken) return versions;
    }
    throw new GoogleIntegrationHealthError("secret_metadata");
}

async function resolveLatestVersion(secretManager, secretKey) {
    const secretResource = `projects/${PROJECT_ID}/secrets/${secretKey}`;
    const versions = await listAllVersions(secretManager, secretResource);
    return selectLatestEnabledVersion(secretResource, versions);
}

function parseBoundSecretReference(variable, requiredKeys, numericOnly) {
    const key = variable?.key;
    if (!requiredKeys.includes(key)) return null;
    const projectId = variable.projectId || PROJECT_ID;
    if (![PROJECT_ID, PROJECT_NUMBER].includes(projectId)) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    const expectedShortName = key;
    const configuredSecret = typeof variable.secret === "string"
        ? variable.secret
        : "";
    if (configuredSecret.includes("/")) {
        const match = /^projects\/([^/]+)\/secrets\/([^/]+)$/u.exec(configuredSecret);
        if (
            !match
            || ![PROJECT_ID, PROJECT_NUMBER].includes(match[1])
            || match[2] !== expectedShortName
        ) {
            throw new GoogleIntegrationHealthError("bound_secret_config");
        }
    }
    const shortName = configuredSecret.split("/").at(-1);
    if (shortName !== expectedShortName) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    const secretResource = `projects/${PROJECT_ID}/secrets/${shortName}`;
    const version = String(variable.version ?? "");
    if (
        !/^[1-9]\d*$/u.test(version)
        && (numericOnly || version !== "latest")
    ) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    return { key, secretResource, version };
}

export function extractBoundSecretReferences(
    functionResource,
    requiredKeys = REQUIRED_SECRET_KEYS,
    { numericOnly = false } = {}
) {
    if (
        !Array.isArray(requiredKeys)
        || requiredKeys.length === 0
        || requiredKeys.some((key) =>
            ![...REQUIRED_SECRET_KEYS, RATE_LIMIT_SECRET_KEY].includes(key))
        || new Set(requiredKeys).size !== requiredKeys.length
    ) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    const variables = functionResource?.serviceConfig?.secretEnvironmentVariables;
    if (!Array.isArray(variables)) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    const references = new Map();
    for (const variable of variables) {
        const reference = parseBoundSecretReference(
            variable,
            requiredKeys,
            numericOnly
        );
        if (!reference) continue;
        if (references.has(reference.key)) {
            throw new GoogleIntegrationHealthError("bound_secret_config");
        }
        references.set(reference.key, reference);
    }
    if (references.size !== requiredKeys.length) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    return references;
}

async function getBoundFunction(functionRegistry, functionName) {
    try {
        return await functionRegistry.getFunction(functionName);
    } catch (error) {
        throw sanitizeHealthError("bound_function", error);
    }
}

async function resolveConsistentBoundVersions(functionRegistry) {
    const referencesByFunction = new Map();
    for (const [functionName, requiredKeys] of Object.entries(
        FUNCTION_SECRET_REQUIREMENTS
    )) {
        const functionResource = await getBoundFunction(
            functionRegistry,
            functionName
        );
        const variables = functionResource?.serviceConfig
            ?.secretEnvironmentVariables ?? [];
        if (
            !Array.isArray(variables)
            || variables.length !== requiredKeys.length
        ) {
            throw new GoogleIntegrationHealthError("bound_secret_config");
        }
        referencesByFunction.set(functionName, requiredKeys.length === 0
            ? new Map()
            : extractBoundSecretReferences(functionResource, requiredKeys, {
                numericOnly: true
            }));
    }

    const registerReferences = referencesByFunction.get("registerTeam");
    const reconcilerReferences = referencesByFunction.get(
        "reconcileRegistrations"
    );
    const resolved = new Map();
    for (const key of REQUIRED_SECRET_KEYS) {
        const expected = reconcilerReferences.get(key);
        if (!expected) {
            throw new GoogleIntegrationHealthError("bound_secret_config");
        }
        resolved.set(
            key,
            `${expected.secretResource}/versions/${expected.version}`
        );
    }

    // Public callables deliberately do not bind OAuth. RegisterTeam's only
    // secret is its independent rate-limit key, pinned to a concrete version.
    if (!registerReferences.has(RATE_LIMIT_SECRET_KEY)) {
        throw new GoogleIntegrationHealthError("bound_secret_config");
    }
    const rateLimitReference = registerReferences.get(RATE_LIMIT_SECRET_KEY);
    resolved.set(
        RATE_LIMIT_SECRET_KEY,
        `${rateLimitReference.secretResource}/versions/${rateLimitReference.version}`
    );
    return resolved;
}

export async function resolveSecretVersionNames(
    source,
    { secretManager, functionRegistry }
) {
    if (source === "latest") {
        return new Map(await Promise.all(REQUIRED_SECRET_KEYS.map(async (key) => [
            key,
            await resolveLatestVersion(secretManager, key)
        ])));
    }
    if (source !== "bound") {
        throw new GoogleIntegrationHealthError("arguments");
    }
    return resolveConsistentBoundVersions(functionRegistry);
}

function decodeSecretPayload(payload) {
    if (
        typeof payload !== "string"
        || payload.length === 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)
    ) {
        throw new GoogleIntegrationHealthError("secret_access");
    }
    let value;
    try {
        value = Buffer.from(payload, "base64").toString("utf8");
    } catch {
        throw new GoogleIntegrationHealthError("secret_access");
    }
    value = value.replace(/\r?\n$/u, "");
    if (value.length === 0 || /[\r\n\u0000-\u001f\u007f]/u.test(value)) {
        throw new GoogleIntegrationHealthError("secret_access");
    }
    return value;
}

async function accessSecret(secretManager, versionName) {
    try {
        return decodeSecretPayload(await secretManager.accessVersion(versionName));
    } catch (error) {
        throw sanitizeHealthError("secret_access", error);
    }
}

export function verifyExactScopes(scopes) {
    const granted = new Set(Array.isArray(scopes) ? scopes : []);
    if (
        granted.size !== REQUIRED_SCOPES.length
        || REQUIRED_SCOPES.some((scope) => !granted.has(scope))
    ) {
        throw new GoogleIntegrationHealthError("oauth_scopes", null, "insufficient_scope");
    }
}

export async function verifyOrganizerIdentity(organizer) {
    let emailAddress;
    try {
        emailAddress = await organizer.getOrganizerEmail();
    } catch (error) {
        throw sanitizeHealthError("organizer_identity", error);
    }
    if (emailAddress !== REGISTRATION_SENDER) {
        throw new GoogleIntegrationHealthError("organizer_identity");
    }
}

export async function verifyPrivateDriveFolder(organizer) {
    let folder;
    try {
        folder = await organizer.getDriveFolder();
    } catch (error) {
        throw sanitizeHealthError("drive_folder", error);
    }
    if (
        folder?.id !== DRIVE_FOLDER_ID
        || folder?.mimeType !== FOLDER_MIME_TYPE
        || folder?.trashed === true
        || folder?.capabilities?.canAddChildren !== true
    ) {
        throw new GoogleIntegrationHealthError("drive_folder");
    }
    let pageToken;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        let response;
        try {
            response = await organizer.listDriveFolderPermissions(pageToken);
        } catch (error) {
            throw sanitizeHealthError("drive_privacy", error);
        }
        const permissions = Array.isArray(response?.permissions)
            ? response.permissions
            : [];
        if (permissions.some((permission) =>
            permission?.type === "anyone" || permission?.type === "domain")) {
            throw new GoogleIntegrationHealthError("drive_privacy", null, "permission_denied");
        }
        pageToken = typeof response?.nextPageToken === "string"
            && response.nextPageToken.length > 0
            ? response.nextPageToken
            : undefined;
        if (!pageToken) return;
    }
    throw new GoogleIntegrationHealthError("drive_privacy");
}

export async function findExistingAppSpreadsheet(organizer) {
    let pageToken;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        let response;
        try {
            response = await organizer.listDriveSpreadsheets(pageToken);
        } catch (error) {
            throw sanitizeHealthError("drive_spreadsheet_list", error);
        }
        const files = Array.isArray(response?.files) ? response.files : [];
        const candidate = files.find((file) =>
            file?.mimeType === SPREADSHEET_MIME_TYPE
            && file?.trashed !== true
            && Array.isArray(file?.parents)
            && file.parents.includes(DRIVE_FOLDER_ID)
            && typeof file?.appProperties?.registrationRequestId === "string"
            && file.appProperties.registrationRequestId.length > 0
            && typeof file?.id === "string"
            && file.id.length > 0);
        if (candidate) return candidate.id;
        pageToken = typeof response?.nextPageToken === "string"
            && response.nextPageToken.length > 0
            ? response.nextPageToken
            : undefined;
        if (!pageToken) return null;
    }
    throw new GoogleIntegrationHealthError("drive_spreadsheet_list");
}

export async function runGoogleIntegrationHealthGate(dependencies, source) {
    const versionNames = await resolveSecretVersionNames(source, dependencies);
    let rateLimitSecret = "";
    try {
        if (source === "bound") {
            rateLimitSecret = await accessSecret(
                dependencies.secretManager,
                versionNames.get(RATE_LIMIT_SECRET_KEY)
            );
            if (Buffer.byteLength(rateLimitSecret, "utf8") < 32) {
                throw new GoogleIntegrationHealthError("rate_limit_secret");
            }
        }
    } finally {
        rateLimitSecret = "";
    }
    let clientSecret = await accessSecret(
        dependencies.secretManager,
        versionNames.get("GOOGLE_OAUTH_CLIENT_SECRET")
    );
    let refreshToken = await accessSecret(
        dependencies.secretManager,
        versionNames.get("GOOGLE_OAUTH_REFRESH_TOKEN")
    );
    let organizer;
    try {
        organizer = dependencies.createOrganizerClient(clientSecret, refreshToken);
    } catch (error) {
        throw sanitizeHealthError("oauth_client", error);
    } finally {
        clientSecret = "";
        refreshToken = "";
    }
    try {
        let refreshed;
        try {
            refreshed = await organizer.refreshAccessToken();
        } catch (error) {
            throw sanitizeHealthError("oauth_refresh", error);
        }
        if (
            typeof refreshed?.accessToken !== "string"
            || refreshed.accessToken.length === 0
            || /[\r\n\u0000-\u001f\u007f]/u.test(refreshed.accessToken)
            || !Number.isFinite(refreshed.expiresIn)
            || refreshed.expiresIn < MINIMUM_ACCESS_TOKEN_LIFETIME_SECONDS
        ) {
            throw new GoogleIntegrationHealthError("oauth_refresh");
        }
        verifyExactScopes(refreshed.scopes);
        await verifyOrganizerIdentity(organizer);
        await verifyPrivateDriveFolder(organizer);
        const spreadsheetId = await findExistingAppSpreadsheet(organizer);
        if (spreadsheetId) {
            let verifiedId;
            try {
                verifiedId = await organizer.readSpreadsheet(spreadsheetId);
            } catch (error) {
                throw sanitizeHealthError("sheets_read", error);
            }
            if (verifiedId !== spreadsheetId) {
                throw new GoogleIntegrationHealthError("sheets_read");
            }
        }
        // This gate is deliberately read-only. An absent marked spreadsheet is
        // reported, never upgraded into a write probe. OAuth bootstrap must
        // still prove live Drive create and Sheets write/read/delete, while an
        // approved end-to-end registration is the only proof of Gmail delivery.
        return Object.freeze({
            source,
            senderAccount: "exact",
            sheetsRead: spreadsheetId ? "verified" : "not_available"
        });
    } finally {
        organizer?.dispose?.();
    }
}

export function hardenGoogleAuthTransport(authClient) {
    const transporter = authClient?.transporter;
    if (!transporter || typeof transporter.request !== "function") {
        throw new GoogleIntegrationHealthError("adc_transport");
    }
    const request = transporter.request.bind(transporter);
    transporter.request = (options) => request({
        ...options,
        ...GOOGLE_REQUEST_OPTIONS
    });
    return authClient;
}

export async function createAdcDependencies() {
    let google;
    try {
        ({ google } = await import("googleapis"));
    } catch (error) {
        throw sanitizeHealthError("initialization", error);
    }
    // Disable library-level retries. Every request has one explicit 8-second
    // bound, so a credential incident cannot expand into a hidden retry storm.
    google.options(GOOGLE_REQUEST_OPTIONS);
    const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    let authClient;
    try {
        authClient = hardenGoogleAuthTransport(await auth.getClient());
    } catch (error) {
        throw sanitizeHealthError("adc_transport", error);
    }
    const secretApi = google.secretmanager({ version: "v1", auth: authClient });
    const functionApi = google.cloudfunctions({ version: "v2", auth: authClient });
    return {
        secretManager: {
            async listVersions(secretResource, pageToken) {
                const response = await secretApi.projects.secrets.versions.list({
                    parent: secretResource,
                    pageSize: 100,
                    ...(pageToken ? { pageToken } : {})
                }, GOOGLE_REQUEST_OPTIONS);
                return {
                    versions: response.data.versions ?? [],
                    nextPageToken: response.data.nextPageToken ?? undefined
                };
            },
            async accessVersion(versionName) {
                const response = await secretApi.projects.secrets.versions.access({
                    name: versionName
                }, GOOGLE_REQUEST_OPTIONS);
                return response.data.payload?.data;
            }
        },
        functionRegistry: {
            async getFunction(functionName) {
                const response = await functionApi.projects.locations.functions.get({
                    name: `projects/${PROJECT_ID}/locations/${REGION}/functions/${functionName}`
                }, GOOGLE_REQUEST_OPTIONS);
                return response.data;
            }
        },
        createOrganizerClient(clientSecret, refreshToken) {
            let oauth = null;
            let drive = null;
            let sheets = null;
            let liveAccessToken = null;
            return {
                async refreshAccessToken() {
                    let data;
                    try {
                        data = await requestOAuthJson(
                            globalThis.fetch,
                            "oauth_refresh",
                            "https://oauth2.googleapis.com/token",
                            {
                                method: "POST",
                                headers: {
                                    "content-type": "application/x-www-form-urlencoded"
                                },
                                body: new URLSearchParams({
                                    client_id: GOOGLE_OAUTH_CLIENT_ID,
                                    client_secret: clientSecret,
                                    refresh_token: refreshToken,
                                    grant_type: "refresh_token"
                                })
                            }
                        );
                    } finally {
                        // The one-shot gate never retries with organizer secrets.
                        clientSecret = "";
                        refreshToken = "";
                    }
                    liveAccessToken = typeof data?.access_token === "string"
                        ? data.access_token
                        : null;
                    if (!liveAccessToken) return null;
                    oauth = new google.auth.OAuth2();
                    oauth.setCredentials({
                        access_token: liveAccessToken,
                        ...(Number.isFinite(data?.expires_in)
                            ? { expiry_date: Date.now() + Number(data.expires_in) * 1_000 }
                            : {})
                    });
                    drive = google.drive({ version: "v3", auth: oauth });
                    sheets = google.sheets({ version: "v4", auth: oauth });
                    return {
                        accessToken: liveAccessToken,
                        expiresIn: Number(data?.expires_in),
                        scopes: typeof data?.scope === "string"
                            ? data.scope.split(/\s+/u).filter(Boolean)
                            : []
                    };
                },
                async getDriveFolder() {
                    return (await drive.files.get({
                        fileId: DRIVE_FOLDER_ID,
                        fields: "id,mimeType,trashed,capabilities(canAddChildren)",
                        supportsAllDrives: true
                    }, GOOGLE_REQUEST_OPTIONS)).data;
                },
                async getOrganizerEmail() {
                    const response = await drive.about.get({
                        fields: "user(emailAddress)"
                    }, GOOGLE_REQUEST_OPTIONS);
                    return response.data.user?.emailAddress;
                },
                async listDriveFolderPermissions(pageToken) {
                    const response = await drive.permissions.list({
                        fileId: DRIVE_FOLDER_ID,
                        fields: "nextPageToken,permissions(type,role,allowFileDiscovery)",
                        pageSize: 100,
                        supportsAllDrives: true,
                        ...(pageToken ? { pageToken } : {})
                    }, GOOGLE_REQUEST_OPTIONS);
                    return {
                        permissions: response.data.permissions ?? [],
                        nextPageToken: response.data.nextPageToken ?? undefined
                    };
                },
                async listDriveSpreadsheets(pageToken) {
                    const response = await drive.files.list({
                        q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='${SPREADSHEET_MIME_TYPE}' and trashed=false`,
                        spaces: "drive",
                        fields: "nextPageToken,files(id,mimeType,trashed,parents,appProperties)",
                        pageSize: 100,
                        includeItemsFromAllDrives: true,
                        supportsAllDrives: true,
                        ...(pageToken ? { pageToken } : {})
                    }, GOOGLE_REQUEST_OPTIONS);
                    return {
                        files: response.data.files ?? [],
                        nextPageToken: response.data.nextPageToken ?? undefined
                    };
                },
                async readSpreadsheet(spreadsheetId) {
                    const response = await sheets.spreadsheets.get({
                        spreadsheetId,
                        includeGridData: false,
                        fields: "spreadsheetId"
                    }, GOOGLE_REQUEST_OPTIONS);
                    return response.data.spreadsheetId;
                },
                dispose() {
                    oauth?.setCredentials({});
                    liveAccessToken = null;
                    drive = null;
                    sheets = null;
                }
            };
        }
    };
}

async function main() {
    const source = parseSecretSource(process.argv.slice(2));
    const result = await runGoogleIntegrationHealthGate(
        await createAdcDependencies(),
        source
    );
    process.stdout.write(
        `PASS Google integration health [secret_source=${result.source} oauth_refresh=valid scopes=exact sender_account=${result.senderAccount} drive_folder=private_can_add sheets_read=${result.sheetsRead} rate_limit_secret=${result.source === "bound" ? "bound_valid" : "not_checked"} gmail_send=not_exercised].\n`
    );
}

const isDirectExecution = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
    main().catch((error) => {
        process.stderr.write(`${formatSafeHealthFailure(error)}\n`);
        process.exitCode = 1;
    });
}
