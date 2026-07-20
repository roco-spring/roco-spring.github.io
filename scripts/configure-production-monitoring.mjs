#!/usr/bin/env node

import { createSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PROJECT_ID = "roco-spring-registration-2026";
export const PROJECT_NUMBER = "149052181991";
export const REGION = "europe-west3";
export const ORGANIZER_NOTIFICATION_ADDRESS =
    "roco-spring-org@googlegroups.com";
export const SCHEDULER_JOB_ID =
    "firebase-schedule-reconcileRegistrations-europe-west3";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_LIST_PAGES = 50;
const MAX_ADC_BYTES = 256 * 1024;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUD_PLATFORM_SCOPE =
    "https://www.googleapis.com/auth/cloud-platform";
const SCHEDULER_ORIGIN = "https://cloudscheduler.googleapis.com";
const MONITORING_ORIGIN = "https://monitoring.googleapis.com";
const FUNCTIONS_ORIGIN = "https://cloudfunctions.googleapis.com";
const RUN_ORIGIN = "https://run.googleapis.com";
const ALLOWED_API_ORIGINS = new Set([
    SCHEDULER_ORIGIN,
    MONITORING_ORIGIN,
    FUNCTIONS_ORIGIN,
    RUN_ORIGIN,
]);
const POLICY_PARENT = `projects/${PROJECT_ID}`;
const SCHEDULER_PARENT = `projects/${PROJECT_ID}/locations/${REGION}`;
const POLICY_LABELS = Object.freeze({
    managed_by: "roco_spring_release",
    component: "registration",
});
const POLICY_UPDATE_MASK = [
    "displayName",
    "documentation",
    "userLabels",
    "conditions",
    "combiner",
    "enabled",
    "notificationChannels",
    "alertStrategy",
    "severity",
].join(",");
const SAFE_PROVIDER_CODES = new Set([
    "ABORTED",
    "ALREADY_EXISTS",
    "DEADLINE_EXCEEDED",
    "FAILED_PRECONDITION",
    "INTERNAL",
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "PERMISSION_DENIED",
    "RESOURCE_EXHAUSTED",
    "SERVICE_DISABLED",
    "UNAUTHENTICATED",
    "UNAVAILABLE",
    "invalid_client",
    "invalid_grant",
]);
export const EXPECTED_FUNCTIONS = Object.freeze([
    "registerTeam",
    "getMyTeam",
    "updateMyTeam",
    "completeInitialPasswordChange",
    "reconcileRegistrations",
]);
const PUBLIC_CALLABLE_FUNCTIONS = Object.freeze(
    EXPECTED_FUNCTIONS.filter((name) => name !== "reconcileRegistrations"),
);

// Debug modes in surrounding tooling can print HTTP headers or request bodies.
delete process.env.DEBUG;
delete process.env.FIREBASE_DEBUG;
delete process.env.NODE_DEBUG;
delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
delete process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
delete process.env.RATE_LIMIT_HMAC_SECRET;

export class ProductionMonitoringError extends Error {
    constructor(stage, status = null, providerCode = "unclassified", guidance = null) {
        super("Production monitoring verification failed.");
        this.name = "ProductionMonitoringError";
        this.stage = stage;
        this.status = status;
        this.providerCode = providerCode;
        this.guidance = guidance;
    }
}

export function parseMode(argumentsList) {
    if (argumentsList.length === 0 ||
        (argumentsList.length === 1 && argumentsList[0] === "--verify")) {
        return "verify";
    }
    if (argumentsList.length === 1 && argumentsList[0] === "--apply") {
        return "apply";
    }
    throw new ProductionMonitoringError("arguments");
}

function base64Url(value) {
    return Buffer.from(value).toString("base64url");
}

function safeProviderCode(payload) {
    const candidates = [
        payload?.error?.status,
        payload?.error?.reason,
        typeof payload?.error === "string" ? payload.error : null,
        payload?.status,
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const trimmed = candidate.trim();
        if (SAFE_PROVIDER_CODES.has(trimmed)) return trimmed;
        const upper = trimmed.toUpperCase();
        if (SAFE_PROVIDER_CODES.has(upper)) return upper;
    }
    return "unclassified";
}

async function parseJsonResponse(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}

export async function boundedJsonFetch(
    fetchImplementation,
    stage,
    url,
    options = {},
    allowedOrigins = ALLOWED_API_ORIGINS,
) {
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        throw new ProductionMonitoringError(stage);
    }
    if (!allowedOrigins.has(parsedUrl.origin) ||
        parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
        throw new ProductionMonitoringError(stage);
    }

    let response;
    try {
        response = await fetchImplementation(parsedUrl, {
            ...options,
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        throw new ProductionMonitoringError(stage, null, "UNAVAILABLE");
    }

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
        throw new ProductionMonitoringError(
            stage,
            Number.isInteger(response.status) ? response.status : null,
            safeProviderCode(payload),
        );
    }
    return payload;
}

function candidateAdcPaths(environment = process.env, homedir = os.homedir()) {
    if (environment.GOOGLE_APPLICATION_CREDENTIALS) {
        return [path.resolve(environment.GOOGLE_APPLICATION_CREDENTIALS)];
    }
    if (environment.CLOUDSDK_CONFIG) {
        return [path.resolve(
            environment.CLOUDSDK_CONFIG,
            "application_default_credentials.json",
        )];
    }
    const configRoot = environment.XDG_CONFIG_HOME
        ? path.resolve(environment.XDG_CONFIG_HOME)
        : path.join(homedir, ".config");
    return [path.join(configRoot, "gcloud", "application_default_credentials.json")];
}

export async function loadAdcCredentials({
    environment = process.env,
    homedir = os.homedir(),
    readFileImplementation = readFile,
    statImplementation = stat,
} = {}) {
    const [adcPath] = candidateAdcPaths(environment, homedir);
    let metadata;
    try {
        metadata = await statImplementation(adcPath);
    } catch {
        throw new ProductionMonitoringError(
            "adc",
            null,
            "NOT_FOUND",
            "Application Default Credentials are required. Run `gcloud auth application-default login` in this trusted operator terminal, set its quota project to roco-spring-registration-2026, and retry. This login is only for release administration; production never depends on this machine.",
        );
    }
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_ADC_BYTES) {
        throw new ProductionMonitoringError("adc");
    }

    let credentials;
    try {
        credentials = JSON.parse(await readFileImplementation(adcPath, "utf8"));
    } catch {
        throw new ProductionMonitoringError("adc");
    }
    if (!credentials || typeof credentials !== "object") {
        throw new ProductionMonitoringError("adc");
    }
    return credentials;
}

function validateTokenPayload(payload) {
    if (typeof payload?.access_token !== "string" ||
        payload.access_token.length < 20 ||
        (payload.token_type !== undefined &&
            String(payload.token_type).toLowerCase() !== "bearer")) {
        throw new ProductionMonitoringError("adc_token");
    }
    return payload.access_token;
}

async function exchangeAuthorizedUserAdc(credentials, fetchImplementation) {
    if (typeof credentials.client_id !== "string" ||
        typeof credentials.client_secret !== "string" ||
        typeof credentials.refresh_token !== "string" ||
        (credentials.token_uri !== undefined && credentials.token_uri !== TOKEN_URL)) {
        throw new ProductionMonitoringError("adc");
    }
    const body = new URLSearchParams({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
        grant_type: "refresh_token",
    });
    const payload = await boundedJsonFetch(
        fetchImplementation,
        "adc_token",
        TOKEN_URL,
        {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
        },
        new Set([new URL(TOKEN_URL).origin]),
    );
    return validateTokenPayload(payload);
}

async function exchangeServiceAccountAdc(
    credentials,
    fetchImplementation,
    now = Date.now(),
) {
    if (typeof credentials.client_email !== "string" ||
        !credentials.client_email.endsWith(".gserviceaccount.com") ||
        typeof credentials.private_key !== "string" ||
        (credentials.token_uri !== undefined && credentials.token_uri !== TOKEN_URL)) {
        throw new ProductionMonitoringError("adc");
    }
    const issuedAt = Math.floor(now / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(JSON.stringify({
        iss: credentials.client_email,
        scope: CLOUD_PLATFORM_SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3_600,
    }));
    const unsignedJwt = `${header}.${claims}`;
    let signature;
    try {
        signature = createSign("RSA-SHA256")
            .update(unsignedJwt)
            .end()
            .sign(credentials.private_key, "base64url");
    } catch {
        throw new ProductionMonitoringError("adc");
    }
    const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsignedJwt}.${signature}`,
    });
    const payload = await boundedJsonFetch(
        fetchImplementation,
        "adc_token",
        TOKEN_URL,
        {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
        },
        new Set([new URL(TOKEN_URL).origin]),
    );
    return validateTokenPayload(payload);
}

export async function obtainAdcAccessToken(
    credentials,
    fetchImplementation = fetch,
    now = Date.now(),
) {
    if (credentials?.type === "authorized_user") {
        return exchangeAuthorizedUserAdc(credentials, fetchImplementation);
    }
    if (credentials?.type === "service_account") {
        return exchangeServiceAccountAdc(
            credentials,
            fetchImplementation,
            now,
        );
    }
    throw new ProductionMonitoringError(
        "adc_type",
        null,
        "INVALID_ARGUMENT",
        "Use user Application Default Credentials from `gcloud auth application-default login`, or a directly supplied service-account ADC file. This release gate deliberately rejects credential-broker types whose network exchange cannot be proven single-attempt.",
    );
}

export function createCloudApiClient(accessToken, fetchImplementation = fetch) {
    if (typeof accessToken !== "string" || accessToken.length < 20) {
        throw new ProductionMonitoringError("adc_token");
    }

    async function request(stage, url, { method = "GET", body } = {}) {
        const headers = {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            "x-goog-user-project": PROJECT_ID,
        };
        if (body !== undefined) headers["content-type"] = "application/json";
        return boundedJsonFetch(fetchImplementation, stage, url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    async function listPaginated(stage, initialUrl, collectionKey) {
        const resources = [];
        const tokens = new Set();
        let pageToken = null;
        for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
            const url = new URL(initialUrl);
            url.searchParams.set("pageSize", "100");
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const payload = await request(stage, url);
            if (payload[collectionKey] !== undefined &&
                !Array.isArray(payload[collectionKey])) {
                throw new ProductionMonitoringError(stage);
            }
            resources.push(...(payload[collectionKey] ?? []));
            if (!payload.nextPageToken) return resources;
            if (typeof payload.nextPageToken !== "string" ||
                tokens.has(payload.nextPageToken)) {
                throw new ProductionMonitoringError(stage);
            }
            tokens.add(payload.nextPageToken);
            pageToken = payload.nextPageToken;
        }
        throw new ProductionMonitoringError(stage, null, "RESOURCE_EXHAUSTED");
    }

    return Object.freeze({
        listFunctions: () => listPaginated(
            "functions_list",
            `${FUNCTIONS_ORIGIN}/v2/projects/${PROJECT_ID}/locations/${REGION}/functions`,
            "functions",
        ),
        listSchedulerJobs: () => listPaginated(
            "scheduler_list",
            `${SCHEDULER_ORIGIN}/v1/${SCHEDULER_PARENT}/jobs`,
            "jobs",
        ),
        getRunService: (name) => {
            assertRunServiceName(name);
            return request(
                "run_service_get",
                `${RUN_ORIGIN}/v2/${name}`,
            );
        },
        getRunServiceIamPolicy: (name) => {
            assertRunServiceName(name);
            return request(
                "run_service_iam",
                `${RUN_ORIGIN}/v2/${name}:getIamPolicy`,
            );
        },
        listNotificationChannels: () => listPaginated(
            "notification_channels_list",
            `${MONITORING_ORIGIN}/v3/${POLICY_PARENT}/notificationChannels`,
            "notificationChannels",
        ),
        listAlertPolicies: () => listPaginated(
            "alert_policies_list",
            `${MONITORING_ORIGIN}/v3/${POLICY_PARENT}/alertPolicies`,
            "alertPolicies",
        ),
        createAlertPolicy: (policy) => request(
            "alert_policy_create",
            `${MONITORING_ORIGIN}/v3/${POLICY_PARENT}/alertPolicies`,
            { method: "POST", body: policy },
        ),
        updateAlertPolicy: (name, policy) => {
            if (!new RegExp(`^projects/${PROJECT_ID}/alertPolicies/[A-Za-z0-9_-]+$`, "u")
                .test(name ?? "")) {
                throw new ProductionMonitoringError("alert_policy_name");
            }
            const url = new URL(`${MONITORING_ORIGIN}/v3/${name}`);
            url.searchParams.set("updateMask", POLICY_UPDATE_MASK);
            return request("alert_policy_update", url, {
                method: "PATCH",
                body: { ...policy, name },
            });
        },
    });
}

function assertRunServiceName(name) {
    if (!new RegExp(
        `^projects/${PROJECT_ID}/locations/${REGION}/services/[a-z0-9-]+$`,
        "u",
    ).test(name ?? "")) {
        throw new ProductionMonitoringError("run_service_name");
    }
}

function isEveryFiveMinutes(schedule) {
    const normalized = String(schedule ?? "").trim().replace(/\s+/gu, " ");
    return normalized === "every 5 minutes" ||
        normalized === "*/5 * * * *" ||
        normalized === "0/5 * * * *";
}

function isSameProjectServiceAccount(email) {
    if (email === `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`) {
        return true;
    }
    if (email === `${PROJECT_ID}@appspot.gserviceaccount.com`) return true;
    return typeof email === "string" &&
        email.endsWith(`@${PROJECT_ID}.iam.gserviceaccount.com`) &&
        /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(email);
}

function parseManagedFunctionUri(value, stage) {
    let uri;
    try {
        uri = new URL(value);
    } catch {
        throw new ProductionMonitoringError(stage);
    }
    const safeHost = uri.hostname.endsWith(".run.app") ||
        uri.hostname.endsWith(".cloudfunctions.net");
    if (uri.protocol !== "https:" || !safeHost || uri.username ||
        uri.password || uri.port || uri.search || uri.hash) {
        throw new ProductionMonitoringError(stage);
    }
    return uri;
}

function normalizedTarget(value) {
    return value.toString().replace(/\/+$/u, "");
}

export function verifyRemoteFunctionInventory(functions) {
    if (!Array.isArray(functions)) {
        throw new ProductionMonitoringError("function_inventory");
    }
    const expectedParent = `projects/${PROJECT_ID}/locations/${REGION}/functions/`;
    const byId = new Map();
    for (const remoteFunction of functions) {
        if (typeof remoteFunction?.name !== "string" ||
            !remoteFunction.name.startsWith(expectedParent)) {
            throw new ProductionMonitoringError("function_inventory");
        }
        const id = remoteFunction.name.slice(expectedParent.length);
        if (!EXPECTED_FUNCTIONS.includes(id) || byId.has(id)) {
            throw new ProductionMonitoringError("function_inventory");
        }
        if (remoteFunction.state !== "ACTIVE" ||
            remoteFunction.environment !== "GEN_2" ||
            remoteFunction.buildConfig?.runtime !== "nodejs22") {
            throw new ProductionMonitoringError("function_runtime");
        }
        const expectedService =
            `projects/${PROJECT_ID}/locations/${REGION}/services/${id.toLowerCase()}`;
        if (remoteFunction.serviceConfig?.service !== expectedService) {
            throw new ProductionMonitoringError("function_service");
        }
        parseManagedFunctionUri(
            remoteFunction.serviceConfig?.uri,
            "function_target",
        );
        byId.set(id, remoteFunction);
    }
    if (byId.size !== EXPECTED_FUNCTIONS.length) {
        throw new ProductionMonitoringError("function_inventory");
    }
    return byId;
}

function bindingMembers(policy, role, { unconditionalOnly = false } = {}) {
    if (policy?.bindings !== undefined && !Array.isArray(policy.bindings)) {
        throw new ProductionMonitoringError("run_iam");
    }
    const members = [];
    for (const binding of policy?.bindings ?? []) {
        if (!binding || typeof binding !== "object" ||
            typeof binding.role !== "string" ||
            !Array.isArray(binding.members) ||
            binding.members.some((member) => typeof member !== "string")) {
            throw new ProductionMonitoringError("run_iam");
        }
        if (binding.role !== role ||
            (unconditionalOnly && binding.condition !== undefined)) continue;
        members.push(...binding.members);
    }
    return members;
}

export function verifyRunIamConfiguration(
    functionsById,
    runServicesById,
    iamPoliciesById,
    schedulerJob,
) {
    if (!(functionsById instanceof Map) ||
        !(runServicesById instanceof Map) ||
        !(iamPoliciesById instanceof Map)) {
        throw new ProductionMonitoringError("run_iam");
    }
    const schedulerEmail =
        schedulerJob?.httpTarget?.oidcToken?.serviceAccountEmail;
    if (!isSameProjectServiceAccount(schedulerEmail)) {
        throw new ProductionMonitoringError("run_iam_scheduler");
    }
    const schedulerMember = `serviceAccount:${schedulerEmail}`;

    for (const id of EXPECTED_FUNCTIONS) {
        const remoteFunction = functionsById.get(id);
        const service = runServicesById.get(id);
        const policy = iamPoliciesById.get(id);
        if (!remoteFunction || !service || !policy ||
            service.name !== remoteFunction.serviceConfig.service ||
            service.invokerIamDisabled === true) {
            throw new ProductionMonitoringError("run_iam_service");
        }
        const allPublicMembers = bindingMembers(policy, "roles/run.invoker")
            .filter((member) => member === "allUsers" ||
                member === "allAuthenticatedUsers");
        const anyBroadPrincipal = (policy.bindings ?? []).some((binding) =>
            (binding.members ?? []).some((member) =>
                member === "allUsers" || member === "allAuthenticatedUsers"));
        const unconditionalInvokers = bindingMembers(
            policy,
            "roles/run.invoker",
            { unconditionalOnly: true },
        );

        if (PUBLIC_CALLABLE_FUNCTIONS.includes(id)) {
            if (!unconditionalInvokers.includes("allUsers") ||
                allPublicMembers.includes("allAuthenticatedUsers")) {
                throw new ProductionMonitoringError("run_iam_callable");
            }
        } else if (anyBroadPrincipal ||
            !unconditionalInvokers.includes(schedulerMember)) {
            throw new ProductionMonitoringError("run_iam_scheduler");
        }
    }
    return Object.freeze({
        publicCallables: PUBLIC_CALLABLE_FUNCTIONS.length,
        privateSchedulers: 1,
    });
}

function validateRemoteSchedulerTarget(job, reconcilerFunction) {
    const target = job?.httpTarget;
    if (!target || target.httpMethod !== "POST" ||
        !isSameProjectServiceAccount(target.oidcToken?.serviceAccountEmail)) {
        throw new ProductionMonitoringError("scheduler_target");
    }
    const uri = parseManagedFunctionUri(target.uri, "scheduler_target");
    const expectedUri = parseManagedFunctionUri(
        reconcilerFunction?.serviceConfig?.uri,
        "scheduler_target",
    );
    if (normalizedTarget(uri) !== normalizedTarget(expectedUri)) {
        throw new ProductionMonitoringError("scheduler_target");
    }
    if (target.oidcToken.audience !== undefined &&
        target.oidcToken.audience !== target.uri) {
        throw new ProductionMonitoringError("scheduler_target");
    }
}

export function selectAndValidateSchedulerJob(
    jobs,
    functionsById,
    now = Date.now(),
) {
    if (!Array.isArray(jobs)) {
        throw new ProductionMonitoringError("scheduler_job");
    }
    if (!(functionsById instanceof Map) ||
        !functionsById.has("reconcileRegistrations")) {
        throw new ProductionMonitoringError("scheduler_target");
    }
    const expectedName = `${SCHEDULER_PARENT}/jobs/${SCHEDULER_JOB_ID}`;
    const matches = jobs.filter((job) => job?.name === expectedName);
    if (matches.length !== 1) {
        throw new ProductionMonitoringError(
            "scheduler_job",
            null,
            matches.length === 0 ? "NOT_FOUND" : "FAILED_PRECONDITION",
        );
    }
    const [job] = matches;
    if (job.state !== "ENABLED" ||
        !isEveryFiveMinutes(job.schedule) ||
        job.timeZone !== "Europe/Berlin" ||
        job.attemptDeadline !== "300s") {
        throw new ProductionMonitoringError("scheduler_configuration");
    }
    const lastAttemptMs = Date.parse(job.lastAttemptTime ?? "");
    const statusCode = Number(job.status?.code ?? 0);
    if (!Number.isFinite(lastAttemptMs) ||
        lastAttemptMs > now + 60_000 ||
        now - lastAttemptMs > 15 * 60_000 ||
        !Number.isInteger(statusCode) || statusCode !== 0) {
        throw new ProductionMonitoringError("scheduler_execution");
    }
    validateRemoteSchedulerTarget(
        job,
        functionsById.get("reconcileRegistrations"),
    );
    return job;
}

export function selectVerifiedOrganizerChannel(channels) {
    const expectedPrefix = `${POLICY_PARENT}/notificationChannels/`;
    const matches = (Array.isArray(channels) ? channels : [])
        .filter((channel) =>
            channel?.name?.startsWith(expectedPrefix) &&
            channel.type === "email" &&
            channel.enabled === true &&
            channel.verificationStatus === "VERIFIED" &&
            String(channel.labels?.email_address ?? "").trim().toLowerCase() ===
                ORGANIZER_NOTIFICATION_ADDRESS)
        .sort((left, right) => left.name.localeCompare(right.name));
    if (matches.length === 0) {
        throw new ProductionMonitoringError(
            "notification_channel",
            null,
            "NOT_FOUND",
            `No enabled, verified email notification channel exists for ${ORGANIZER_NOTIFICATION_ADDRESS}. In Google Cloud Console, select project ${PROJECT_ID}, open Monitoring > Alerting > Edit notification channels, add that exact group address under Email, complete the verification received by the group, confirm the channel is enabled and VERIFIED, then run \`npm run monitoring:configure\` again. No channel or alert policy was created by this failed run.`,
        );
    }
    return matches[0];
}

function logAlertStrategy() {
    return {
        notificationRateLimit: { period: "300s" },
        autoClose: "1800s",
        notificationPrompts: ["OPENED"],
    };
}

function metricAlertStrategy() {
    return {
        autoClose: "1800s",
        notificationPrompts: ["OPENED", "CLOSED"],
    };
}

function basePolicy(key, displayName, documentation, channelName) {
    return {
        displayName,
        documentation: {
            content: documentation,
            mimeType: "text/markdown",
        },
        userLabels: {
            ...POLICY_LABELS,
            policy_key: key,
        },
        combiner: "OR",
        enabled: true,
        notificationChannels: [channelName],
        severity: "ERROR",
    };
}

export function buildDesiredPolicies(channelName, schedulerJob = SCHEDULER_JOB_ID) {
    if (!new RegExp(
        `^projects/${PROJECT_ID}/notificationChannels/[A-Za-z0-9_-]+$`,
        "u",
    ).test(channelName ?? "") || schedulerJob !== SCHEDULER_JOB_ID) {
        throw new ProductionMonitoringError("policy_input");
    }

    const dependency = {
        ...basePolicy(
            "dependency_health",
            "RoCo registration: Google dependency unhealthy",
            "The remote Firebase reconciler reported an unhealthy Google integration. Inspect sanitized `registrationDependencyHealth` logs, run the bound Google health gate from a trusted operator terminal, and follow `SETUP_TEAM_REGISTRATION.md`. Do not delete committed registrations.",
            channelName,
        ),
        conditions: [{
            displayName: "Remote reconciler dependency health is unhealthy",
            conditionMatchedLog: {
                filter: [
                    'resource.type="cloud_run_revision"',
                    `resource.labels.location="${REGION}"`,
                    'resource.labels.service_name="reconcileregistrations"',
                    'jsonPayload.operation="registrationDependencyHealth"',
                    'jsonPayload.status="unhealthy"',
                    "severity>=ERROR",
                ].join("\n"),
            },
        }],
        alertStrategy: logAlertStrategy(),
    };

    const callable = {
        ...basePolicy(
            "registerteam_5xx",
            "RoCo registration: registerTeam sustained 5xx",
            "The remote `registerTeam` Cloud Run service has sustained 5xx responses, including request deadlines. Inspect sanitized Cloud Run and Function logs for the deployed revision; preserve idempotency records and committed teams during recovery.",
            channelName,
        ),
        conditions: [{
            displayName: "registerTeam 5xx rate remains above zero for 5 minutes",
            conditionThreshold: {
                filter: [
                    'metric.type="run.googleapis.com/request_count"',
                    'resource.type="cloud_run_revision"',
                    `resource.label."location"="${REGION}"`,
                    'resource.label."service_name"="registerteam"',
                    'metric.label."response_code_class"="5xx"',
                ].join(" AND "),
                aggregations: [{
                    alignmentPeriod: "300s",
                    perSeriesAligner: "ALIGN_RATE",
                    crossSeriesReducer: "REDUCE_SUM",
                }],
                comparison: "COMPARISON_GT",
                // 0.001 requests/second is below one request per five-minute
                // alignment window, while avoiding proto3's omitted zero value.
                thresholdValue: 0.001,
                duration: "300s",
                trigger: { count: 1 },
                evaluationMissingData: "EVALUATION_MISSING_DATA_INACTIVE",
            },
        }],
        alertStrategy: metricAlertStrategy(),
    };

    const scheduler = {
        ...basePolicy(
            "scheduler_failure",
            "RoCo registration: reconciler Scheduler failure",
            "The remote five-minute Cloud Scheduler invocation failed. Verify that the exact `reconcileRegistrations` Scheduler job remains enabled and that its HTTPS OIDC target can invoke the deployed Firebase Function.",
            channelName,
        ),
        conditions: [{
            displayName: "Remote reconciler Scheduler attempt failed",
            conditionMatchedLog: {
                filter: [
                    'resource.type="cloud_scheduler_job"',
                    `resource.labels.project_id="${PROJECT_ID}"`,
                    `resource.labels.location="${REGION}"`,
                    `resource.labels.job_id="${schedulerJob}"`,
                    'jsonPayload.@type="type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished"',
                    "severity>=ERROR",
                ].join("\n"),
            },
        }],
        alertStrategy: logAlertStrategy(),
    };

    const reconciliationFailure = {
        ...basePolicy(
            "reconciliation_failed",
            "RoCo registration: reconciliation resource requires recovery",
            "The remote reconciler marked a durable email, Sheet, cleanup, or registration resource as failed and requiring operator recovery. Inspect only sanitized reconciliation logs and state/category metadata; do not delete a committed team or broadly reset queues.",
            channelName,
        ),
        conditions: [{
            displayName: "A durable reconciliation resource requires recovery",
            conditionMatchedLog: {
                filter: [
                    'resource.type="cloud_run_revision"',
                    `resource.labels.location="${REGION}"`,
                    'resource.labels.service_name="reconcileregistrations"',
                    'jsonPayload.operation="reconcileRegistrations"',
                    'jsonPayload.status="failed"',
                    "severity>=ERROR",
                ].join("\n"),
            },
        }],
        alertStrategy: logAlertStrategy(),
    };

    return Object.freeze([
        dependency,
        callable,
        scheduler,
        reconciliationFailure,
    ]);
}

function normalizedPolicy(policy) {
    return {
        displayName: policy?.displayName,
        documentation: policy?.documentation,
        userLabels: policy?.userLabels,
        conditions: Array.isArray(policy?.conditions)
            ? policy.conditions.map(({ name: _name, ...condition }) => condition)
            : policy?.conditions,
        combiner: policy?.combiner,
        enabled: policy?.enabled,
        notificationChannels: policy?.notificationChannels,
        alertStrategy: policy?.alertStrategy,
        severity: policy?.severity,
    };
}

function canonicalJson(value) {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalJson(value[key])]),
    );
}

function policiesEqual(left, right) {
    return JSON.stringify(canonicalJson(normalizedPolicy(left))) ===
        JSON.stringify(canonicalJson(normalizedPolicy(right)));
}

export function planPolicyChanges(existingPolicies, desiredPolicies, mode) {
    if (!Array.isArray(existingPolicies) || !Array.isArray(desiredPolicies) ||
        (mode !== "verify" && mode !== "apply")) {
        throw new ProductionMonitoringError("alert_policy_plan");
    }
    const plan = [];
    for (const desired of desiredPolicies) {
        const key = desired.userLabels.policy_key;
        const managed = existingPolicies.filter((policy) =>
            policy?.userLabels?.managed_by === POLICY_LABELS.managed_by &&
            policy?.userLabels?.component === POLICY_LABELS.component &&
            policy?.userLabels?.policy_key === key);
        const displayMatches = existingPolicies.filter((policy) =>
            policy?.displayName === desired.displayName);
        if (managed.length > 1 || displayMatches.length > 1 ||
            (managed.length === 1 && displayMatches.some((policy) =>
                policy !== managed[0]))) {
            throw new ProductionMonitoringError(
                "alert_policy_collision",
                null,
                "FAILED_PRECONDITION",
            );
        }
        const current = managed[0] ?? displayMatches[0] ?? null;
        if (!current) {
            plan.push({ action: "create", desired, current: null });
            continue;
        }
        const validityCode = Number(current.validity?.code ?? 0);
        if (current.validity !== undefined && current.validity !== null &&
            (!Number.isInteger(validityCode) || validityCode !== 0)) {
            throw new ProductionMonitoringError(
                "alert_policy_invalid",
                null,
                "FAILED_PRECONDITION",
            );
        }
        if (policiesEqual(current, desired)) {
            plan.push({ action: "noop", desired, current });
        } else if (managed.length === 1) {
            plan.push({ action: "update", desired, current });
        } else {
            throw new ProductionMonitoringError(
                "alert_policy_unmanaged_drift",
                null,
                "FAILED_PRECONDITION",
                "An unmanaged alert policy already uses a required RoCo display name but does not match the reviewed configuration. Review it in Cloud Monitoring; either make it exactly match this release policy or rename it before rerunning. The workflow will not silently take ownership of an unrelated policy.",
            );
        }
    }
    if (mode === "verify" && plan.some(({ action }) => action !== "noop")) {
        throw new ProductionMonitoringError(
            "alert_policy_drift",
            null,
            "FAILED_PRECONDITION",
            "Required remote alert policies are missing or drifted. After verifying the organizer notification channel, run `npm run monitoring:configure`, then rerun `npm run monitoring:verify`.",
        );
    }
    return plan;
}

async function applyPolicyPlan(api, plan) {
    for (const item of plan) {
        if (item.action === "create") {
            await api.createAlertPolicy(item.desired);
        } else if (item.action === "update") {
            await api.updateAlertPolicy(item.current.name, item.desired);
        }
    }
}

export async function runProductionMonitoringWorkflow({
    mode,
    api,
} = {}) {
    if ((mode !== "verify" && mode !== "apply") || !api) {
        throw new ProductionMonitoringError("workflow_input");
    }

    // Finish every read-only prerequisite before the first possible mutation.
    const functions = await api.listFunctions();
    const functionsById = verifyRemoteFunctionInventory(functions);
    const jobs = await api.listSchedulerJobs();
    const schedulerJob = selectAndValidateSchedulerJob(jobs, functionsById);
    const runServicesById = new Map();
    const iamPoliciesById = new Map();
    for (const id of EXPECTED_FUNCTIONS) {
        const serviceName = functionsById.get(id).serviceConfig.service;
        runServicesById.set(id, await api.getRunService(serviceName));
        iamPoliciesById.set(
            id,
            await api.getRunServiceIamPolicy(serviceName),
        );
    }
    const iam = verifyRunIamConfiguration(
        functionsById,
        runServicesById,
        iamPoliciesById,
        schedulerJob,
    );
    const channels = await api.listNotificationChannels();
    const channel = selectVerifiedOrganizerChannel(channels);
    const existingPolicies = await api.listAlertPolicies();
    const desiredPolicies = buildDesiredPolicies(
        channel.name,
        schedulerJob.name.slice(schedulerJob.name.lastIndexOf("/") + 1),
    );
    const initialPlan = planPolicyChanges(existingPolicies, desiredPolicies, mode);

    if (mode === "apply") {
        await applyPolicyPlan(api, initialPlan);
        const verifiedPolicies = await api.listAlertPolicies();
        const verification = planPolicyChanges(
            verifiedPolicies,
            desiredPolicies,
            "verify",
        );
        if (verification.some(({ action }) => action !== "noop")) {
            throw new ProductionMonitoringError("alert_policy_readback");
        }
    }

    return Object.freeze({
        mode,
        functions: functionsById.size,
        iam,
        alerts: desiredPolicies.length,
        changed: initialPlan.filter(({ action }) => action !== "noop").length,
    });
}

export function formatSafeFailure(error) {
    const safe = error instanceof ProductionMonitoringError
        ? error
        : new ProductionMonitoringError("initialization");
    const fields = [
        `stage=${safe.stage}`,
        `provider_code=${safe.providerCode}`,
    ];
    if (safe.status !== null) fields.push(`http_status=${safe.status}`);
    return `Production monitoring gate failed [${fields.join(" ")}].`;
}

async function main() {
    const mode = parseMode(process.argv.slice(2));
    const credentials = await loadAdcCredentials();
    const accessToken = await obtainAdcAccessToken(credentials);
    const api = createCloudApiClient(accessToken);
    const result = await runProductionMonitoringWorkflow({ mode, api });
    process.stdout.write(
        `PASS remote production operations [project=${PROJECT_ID} region=${REGION} functions=${result.functions}/${result.functions}_active_nodejs22 iam=${result.iam.publicCallables}_callables_public_1_reconciler_oidc_private scheduler=enabled_every_5_minutes target=exact_https_oidc_remote notification=verified alerts=${result.alerts}/${result.alerts} mode=${result.mode} changed=${result.changed}]. This operator process may now exit; production has no dependency on this node.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${formatSafeFailure(error)}\n`);
        if (error instanceof ProductionMonitoringError && error.guidance) {
            process.stderr.write(`${error.guidance}\n`);
        }
        process.exitCode = 1;
    });
}
