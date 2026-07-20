import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
    EXPECTED_FUNCTIONS,
    ORGANIZER_NOTIFICATION_ADDRESS,
    PROJECT_ID,
    PROJECT_NUMBER,
    ProductionMonitoringError,
    REGION,
    SCHEDULER_JOB_ID,
    boundedJsonFetch,
    buildDesiredPolicies,
    createCloudApiClient,
    formatSafeFailure,
    loadAdcCredentials,
    obtainAdcAccessToken,
    parseMode,
    planPolicyChanges,
    runProductionMonitoringWorkflow,
    selectAndValidateSchedulerJob,
    selectVerifiedOrganizerChannel,
    verifyRemoteFunctionInventory,
    verifyRunIamConfiguration,
} from "../scripts/configure-production-monitoring.mjs";

const CHANNEL_NAME = `projects/${PROJECT_ID}/notificationChannels/123456`;
const ROOT = path.resolve(import.meta.dirname, "..");
const adcClientSecretField = ["client", "secret"].join("_");
const adcRefreshTokenField = ["refresh", "token"].join("_");
const accessTokenField = ["access", "token"].join("_");

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function schedulerJob(overrides = {}) {
    const base = {
        name: `projects/${PROJECT_ID}/locations/${REGION}/jobs/${SCHEDULER_JOB_ID}`,
        state: "ENABLED",
        schedule: "every 5 minutes",
        timeZone: "Europe/Berlin",
        attemptDeadline: "300s",
        lastAttemptTime: new Date(Date.now() - 2 * 60_000).toISOString(),
        status: {},
        httpTarget: {
            uri: "https://reconcileregistrations-example-ew.a.run.app/",
            httpMethod: "POST",
            oidcToken: {
                serviceAccountEmail:
                    `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`,
            },
        },
    };
    return {
        ...base,
        ...overrides,
        httpTarget: overrides.httpTarget === undefined
            ? base.httpTarget
            : overrides.httpTarget,
    };
}

function remoteFunction(id, overrides = {}) {
    const serviceName = id.toLowerCase();
    return {
        name: `projects/${PROJECT_ID}/locations/${REGION}/functions/${id}`,
        state: "ACTIVE",
        environment: "GEN_2",
        buildConfig: { runtime: "nodejs22" },
        serviceConfig: {
            service:
                `projects/${PROJECT_ID}/locations/${REGION}/services/${serviceName}`,
            uri: id === "reconcileRegistrations"
                ? "https://reconcileregistrations-example-ew.a.run.app/"
                : `https://${serviceName}-example-ew.a.run.app/`,
        },
        ...overrides,
    };
}

function remoteFunctions() {
    return EXPECTED_FUNCTIONS.map((id) => remoteFunction(id));
}

function verifiedFunctions() {
    return verifyRemoteFunctionInventory(remoteFunctions());
}

function runService(id, overrides = {}) {
    return {
        name:
            `projects/${PROJECT_ID}/locations/${REGION}/services/${id.toLowerCase()}`,
        invokerIamDisabled: false,
        ...overrides,
    };
}

function runIamPolicy(id, overrides = {}) {
    const schedulerMember =
        `serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`;
    return {
        version: 1,
        bindings: [{
            role: "roles/run.invoker",
            members: id === "reconcileRegistrations"
                ? [schedulerMember]
                : ["allUsers"],
        }],
        ...overrides,
    };
}

function runServiceMaps() {
    return {
        services: new Map(EXPECTED_FUNCTIONS.map((id) => [id, runService(id)])),
        policies: new Map(EXPECTED_FUNCTIONS.map((id) => [id, runIamPolicy(id)])),
    };
}

function organizerChannel(overrides = {}) {
    return {
        name: CHANNEL_NAME,
        type: "email",
        enabled: true,
        verificationStatus: "VERIFIED",
        labels: { email_address: ORGANIZER_NOTIFICATION_ADDRESS },
        ...overrides,
    };
}

function expectStage(stage) {
    return (error) => {
        assert.ok(error instanceof ProductionMonitoringError);
        assert.equal(error.stage, stage);
        return true;
    };
}

test("monitoring CLI mode is explicit and safe by default", () => {
    assert.equal(parseMode([]), "verify");
    assert.equal(parseMode(["--verify"]), "verify");
    assert.equal(parseMode(["--apply"]), "apply");
    assert.throws(() => parseMode(["--apply", "--verify"]), expectStage("arguments"));
    assert.throws(() => parseMode(["--project=another-project"]), expectStage("arguments"));
});

test("bounded JSON transport rejects foreign origins before making a request", async () => {
    let calls = 0;
    await assert.rejects(
        boundedJsonFetch(
            async () => {
                calls += 1;
                return jsonResponse({});
            },
            "api",
            "https://example.invalid/v1/projects/other",
        ),
        expectStage("api"),
    );
    assert.equal(calls, 0);
});

test("bounded JSON transport is one-shot, timeout-bound, and refuses redirects", async () => {
    let calls = 0;
    const result = await boundedJsonFetch(
        async (url, options) => {
            calls += 1;
            assert.equal(url.origin, "https://monitoring.googleapis.com");
            assert.equal(options.redirect, "error");
            assert.equal(options.cache, "no-store");
            assert.ok(options.signal instanceof AbortSignal);
            return jsonResponse({ ok: true });
        },
        "api",
        "https://monitoring.googleapis.com/v3/projects/test",
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
});

test("provider failures are sanitized and never include response details", async () => {
    const secretText = "sensitive-provider-debug-text";
    let captured;
    try {
        await boundedJsonFetch(
            async () => jsonResponse({
                error: {
                    status: "PERMISSION_DENIED",
                    message: secretText,
                },
            }, 403),
            "api",
            "https://monitoring.googleapis.com/v3/projects/test",
        );
    } catch (error) {
        captured = error;
    }
    assert.ok(captured instanceof ProductionMonitoringError);
    assert.equal(captured.status, 403);
    assert.equal(captured.providerCode, "PERMISSION_DENIED");
    assert.doesNotMatch(formatSafeFailure(captured), new RegExp(secretText, "u"));
});

test("authorized-user ADC refresh uses one bounded native token request", async () => {
    const calls = [];
    const token = await obtainAdcAccessToken({
        type: "authorized_user",
        client_id: "adc-client-id",
        [adcClientSecretField]: "adc-client-secret",
        [adcRefreshTokenField]: "adc-refresh-token",
    }, async (url, options) => {
        calls.push({ url, options });
        return jsonResponse({
            [accessTokenField]: "test-access-token-with-safe-length",
            token_type: "Bearer",
            expires_in: 3600,
        });
    });
    assert.equal(token, "test-access-token-with-safe-length");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, "https://oauth2.googleapis.com");
    assert.equal(calls[0].options.redirect, "error");
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.body.get("grant_type"), "refresh_token");

    await assert.rejects(
        obtainAdcAccessToken({
            type: "authorized_user",
            client_id: "adc-client-id",
            [adcClientSecretField]: "adc-client-secret",
            [adcRefreshTokenField]: "adc-refresh-token",
        }, async () => jsonResponse({
            [accessTokenField]: "unsafe-access-token-with-newline\nvalue",
            token_type: "Bearer",
        })),
        expectStage("adc_token"),
    );
});

test("credential-broker ADC types fail closed instead of hiding network retries", async () => {
    await assert.rejects(
        obtainAdcAccessToken({ type: "external_account" }),
        (error) => {
            assert.ok(expectStage("adc_type")(error));
            assert.match(error.guidance, /single-attempt/u);
            return true;
        },
    );
});

test("ADC loader honors CLOUDSDK_CONFIG and never falls back silently", async () => {
    let readPath;
    const credentials = await loadAdcCredentials({
        environment: { CLOUDSDK_CONFIG: "/tmp/operator-config" },
        homedir: "/home/ignored",
        statImplementation: async (adcPath) => {
            assert.equal(
                adcPath,
                "/tmp/operator-config/application_default_credentials.json",
            );
            return { isFile: () => true, size: 128 };
        },
        readFileImplementation: async (adcPath) => {
            readPath = adcPath;
            return JSON.stringify({ type: "authorized_user" });
        },
    });
    assert.equal(
        readPath,
        "/tmp/operator-config/application_default_credentials.json",
    );
    assert.equal(credentials.type, "authorized_user");
});

test("missing ADC gives exact remote-safe operator guidance", async () => {
    await assert.rejects(
        loadAdcCredentials({
            environment: { CLOUDSDK_CONFIG: "/tmp/no-adc" },
            statImplementation: async () => {
                throw new Error("missing");
            },
        }),
        (error) => {
            assert.ok(expectStage("adc")(error));
            assert.match(error.guidance, /application-default login/u);
            assert.match(error.guidance, /production never depends on this machine/u);
            return true;
        },
    );
});

test("Cloud API pagination is complete, exact-project, and authenticated", async () => {
    const calls = [];
    const api = createCloudApiClient(
        "test-access-token-with-safe-length",
        async (url, options) => {
            const parsed = new URL(url);
            calls.push({ url: parsed, options });
            if (parsed.pathname.endsWith(`/projects/${PROJECT_ID}/locations`)) {
                return jsonResponse({
                    locations: [
                        { name: `projects/${PROJECT_ID}/locations/${REGION}` },
                        { name: `projects/${PROJECT_ID}/locations/us-central1` },
                    ],
                });
            }
            if (parsed.pathname.includes(`/locations/${REGION}/jobs`)) {
                return jsonResponse({ jobs: [{ name: "first" }] });
            }
            if (!parsed.searchParams.has("pageToken")) {
                return jsonResponse({
                    jobs: [{ name: "second" }],
                    nextPageToken: "opaque-next-page",
                });
            }
            return jsonResponse({ jobs: [{ name: "third" }] });
        },
    );
    const jobs = await api.listSchedulerJobs();
    assert.deepEqual(jobs.map(({ name }) => name), ["first", "second", "third"]);
    assert.equal(calls.length, 4);
    for (const { url, options } of calls) {
        assert.equal(url.origin, "https://cloudscheduler.googleapis.com");
        assert.match(url.pathname, new RegExp(`^/v1/projects/${PROJECT_ID}/locations`, "u"));
        assert.equal(options.headers["x-goog-user-project"], PROJECT_ID);
        assert.equal(
            options.headers.authorization,
            "Bearer test-access-token-with-safe-length",
        );
        assert.equal(options.redirect, "error");
    }
    assert.equal(calls[3].url.searchParams.get("pageToken"), "opaque-next-page");
});

test("Scheduler discovery fails closed on malformed or empty project location inventories", async () => {
    for (const locations of [[], [{ name: "projects/another-project/locations/us-central1" }]]) {
        const api = createCloudApiClient(
            "test-access-token-with-safe-length",
            async () => jsonResponse({ locations }),
        );
        await assert.rejects(
            api.listSchedulerJobs(),
            expectStage("scheduler_locations_list"),
        );
    }
});

test("repeated Cloud API page tokens fail closed", async () => {
    const api = createCloudApiClient(
        "test-access-token-with-safe-length",
        async () => jsonResponse({ nextPageToken: "cycle" }),
    );
    await assert.rejects(api.listAlertPolicies(), expectStage("alert_policies_list"));
});

test("Function inventory reads every region and rejects unreachable regions", async () => {
    const calls = [];
    const api = createCloudApiClient(
        "test-access-token-with-safe-length",
        async (url) => {
            calls.push(new URL(url));
            return jsonResponse({ functions: remoteFunctions(), unreachable: [] });
        },
    );
    assert.equal((await api.listFunctions()).length, EXPECTED_FUNCTIONS.length);
    assert.equal(
        calls[0].pathname,
        `/v2/projects/${PROJECT_ID}/locations/-/functions`,
    );

    const unreachableApi = createCloudApiClient(
        "test-access-token-with-safe-length",
        async () => jsonResponse({
            functions: remoteFunctions(),
            unreachable: ["europe-west1"],
        }),
    );
    await assert.rejects(
        unreachableApi.listFunctions(),
        expectStage("functions_list"),
    );
});

test("remote Function inventory is exact, active Node.js 22, and managed HTTPS", () => {
    const byId = verifyRemoteFunctionInventory(remoteFunctions());
    assert.equal(byId.size, 5);
    assert.equal(byId.get("registerTeam").state, "ACTIVE");

    assert.throws(
        () => verifyRemoteFunctionInventory(remoteFunctions().slice(0, 4)),
        expectStage("function_inventory"),
    );
    assert.throws(
        () => verifyRemoteFunctionInventory([
            ...remoteFunctions(),
            remoteFunction("unexpectedFunction"),
        ]),
        expectStage("function_inventory"),
    );
    assert.throws(
        () => verifyRemoteFunctionInventory(remoteFunctions().map((item) =>
            item.name.endsWith("/registerTeam")
                ? { ...item, state: "FAILED" }
                : item)),
        expectStage("function_runtime"),
    );
    assert.throws(
        () => verifyRemoteFunctionInventory(remoteFunctions().map((item) =>
            item.name.endsWith("/registerTeam")
                ? {
                    ...item,
                    serviceConfig: {
                        ...item.serviceConfig,
                        uri: "http://localhost:5001/registerTeam",
                    },
                }
                : item)),
        expectStage("function_target"),
    );
});

test("Scheduler verifier accepts only the exact enabled remote five-minute job", () => {
    const selected = selectAndValidateSchedulerJob([
        schedulerJob(),
        { name: `projects/${PROJECT_ID}/locations/${REGION}/jobs/unrelated` },
    ], verifiedFunctions());
    assert.equal(selected.state, "ENABLED");

    const appspotTarget = structuredClone(schedulerJob());
    appspotTarget.httpTarget.oidcToken.serviceAccountEmail =
        `${PROJECT_ID}@appspot.gserviceaccount.com`;
    assert.equal(
        selectAndValidateSchedulerJob([appspotTarget], verifiedFunctions()).state,
        "ENABLED",
    );

    for (const changed of [
        { state: "PAUSED" },
        { schedule: "every 10 minutes" },
        { timeZone: "UTC" },
        { attemptDeadline: "180s" },
    ]) {
        assert.throws(
            () => selectAndValidateSchedulerJob(
                [schedulerJob(changed)],
                verifiedFunctions(),
            ),
            expectStage("scheduler_configuration"),
        );
    }

    for (const changed of [
        { lastAttemptTime: new Date(Date.now() - 16 * 60_000).toISOString() },
        { status: { code: 13 } },
        { status: null },
    ]) {
        assert.throws(
            () => selectAndValidateSchedulerJob(
                [schedulerJob(changed)],
                verifiedFunctions(),
            ),
            expectStage("scheduler_execution"),
        );
    }
});

test("Scheduler verifier rejects any extra active or paused reconciler target", () => {
    for (const duplicateTarget of [
        "https://reconcileregistrations-example-ew.a.run.app/?retry=1",
        "https://reconcileregistrations-example-ew.a.run.app//#retry",
        `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/reconcileRegistrations/?retry=1#again`,
    ]) {
        for (const state of ["ENABLED", "PAUSED"]) {
            const duplicate = schedulerJob({
                name: `projects/${PROJECT_ID}/locations/us-central1/jobs/stale-reconciler`,
                state,
                httpTarget: {
                    ...schedulerJob().httpTarget,
                    uri: duplicateTarget,
                },
            });
            assert.throws(
                () => selectAndValidateSchedulerJob(
                    [schedulerJob(), duplicate],
                    verifiedFunctions(),
                ),
                expectStage("scheduler_duplicate_target"),
            );
        }
    }

    const unrelated = schedulerJob({
        name: `projects/${PROJECT_ID}/locations/${REGION}/jobs/unrelated`,
        httpTarget: {
            ...schedulerJob().httpTarget,
            uri: "https://unrelated-example-ew.a.run.app/",
        },
    });
    assert.equal(
        selectAndValidateSchedulerJob(
            [schedulerJob(), unrelated],
            verifiedFunctions(),
        ).state,
        "ENABLED",
    );
});

test("Scheduler verifier rejects local, foreign, unauthenticated, or redirected targets", () => {
    const unsafeTargets = [
        {
            uri: "http://localhost:5001/reconcileRegistrations",
            httpMethod: "POST",
            oidcToken: {
                serviceAccountEmail:
                    `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`,
            },
        },
        {
            uri: "https://reconcileregistrations.attacker.example/",
            httpMethod: "POST",
            oidcToken: {
                serviceAccountEmail:
                    `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`,
            },
        },
        {
            uri: "https://reconcileregistrations-example-ew.a.run.app/",
            httpMethod: "POST",
        },
        {
            uri: "https://reconcileregistrations-example-ew.a.run.app/",
            httpMethod: "POST",
            oidcToken: {
                serviceAccountEmail: "caller@another-project.iam.gserviceaccount.com",
            },
        },
        {
            uri: "https://reconcileregistrations-example-ew.a.run.app/",
            httpMethod: "POST",
            oidcToken: {
                serviceAccountEmail:
                    `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`,
                audience: "https://different.example/",
            },
        },
    ];
    for (const httpTarget of unsafeTargets) {
        assert.throws(
            () => selectAndValidateSchedulerJob([
                schedulerJob({ httpTarget }),
            ], verifiedFunctions()),
            expectStage("scheduler_target"),
        );
    }
});

test("Scheduler verifier requires exactly one exact project/region resource", () => {
    assert.throws(
        () => selectAndValidateSchedulerJob([], verifiedFunctions()),
        (error) => {
            assert.ok(expectStage("scheduler_job")(error));
            assert.equal(error.providerCode, "NOT_FOUND");
            return true;
        },
    );
    assert.throws(
        () => selectAndValidateSchedulerJob(
            [schedulerJob(), schedulerJob()],
            verifiedFunctions(),
        ),
        expectStage("scheduler_job"),
    );
});

test("Scheduler target must equal the exact deployed reconciler URI", () => {
    const functionsById = verifiedFunctions();
    const changed = structuredClone(functionsById.get("reconcileRegistrations"));
    changed.serviceConfig.uri =
        "https://reconcileregistrations-other-ew.a.run.app/";
    functionsById.set("reconcileRegistrations", changed);
    assert.throws(
        () => selectAndValidateSchedulerJob([schedulerJob()], functionsById),
        expectStage("scheduler_target"),
    );
});

test("Cloud Run IAM exposes only callables and authenticates the Scheduler", () => {
    const functionsById = verifiedFunctions();
    const { services, policies } = runServiceMaps();
    assert.deepEqual(
        verifyRunIamConfiguration(
            functionsById,
            services,
            policies,
            schedulerJob(),
        ),
        { publicCallables: 4, privateSchedulers: 1 },
    );

    const privateCallable = new Map(policies);
    privateCallable.set("getMyTeam", { bindings: [] });
    assert.throws(
        () => verifyRunIamConfiguration(
            functionsById,
            services,
            privateCallable,
            schedulerJob(),
        ),
        expectStage("run_iam_callable"),
    );

    const publicScheduler = new Map(policies);
    publicScheduler.set("reconcileRegistrations", {
        bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }],
    });
    assert.throws(
        () => verifyRunIamConfiguration(
            functionsById,
            services,
            publicScheduler,
            schedulerJob(),
        ),
        expectStage("run_iam_scheduler"),
    );

    const disabledInvokerCheck = new Map(services);
    disabledInvokerCheck.set(
        "reconcileRegistrations",
        runService("reconcileRegistrations", { invokerIamDisabled: true }),
    );
    assert.throws(
        () => verifyRunIamConfiguration(
            functionsById,
            disabledInvokerCheck,
            policies,
            schedulerJob(),
        ),
        expectStage("run_iam_service"),
    );
});

test("conditional or foreign Scheduler invoker grants fail closed", () => {
    const functionsById = verifiedFunctions();
    const { services, policies } = runServiceMaps();
    const conditional = new Map(policies);
    conditional.set("reconcileRegistrations", {
        bindings: [{
            role: "roles/run.invoker",
            members: [
                `serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`,
            ],
            condition: { title: "not-unconditionally-invokable", expression: "false" },
        }],
    });
    assert.throws(
        () => verifyRunIamConfiguration(
            functionsById,
            services,
            conditional,
            schedulerJob(),
        ),
        expectStage("run_iam_scheduler"),
    );

    const extraInvoker = new Map(policies);
    extraInvoker.set("reconcileRegistrations", {
        bindings: [{
            role: "roles/run.invoker",
            members: [
                `serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com`,
                `serviceAccount:foreign@${PROJECT_ID}.iam.gserviceaccount.com`,
            ],
        }],
    });
    assert.throws(
        () => verifyRunIamConfiguration(
            functionsById,
            services,
            extraInvoker,
            schedulerJob(),
        ),
        expectStage("run_iam_scheduler"),
    );
});

test("notification selection requires the exact enabled and verified email channel", () => {
    const selected = selectVerifiedOrganizerChannel([
        organizerChannel({
            name: `projects/${PROJECT_ID}/notificationChannels/999999`,
        }),
        organizerChannel(),
    ]);
    assert.equal(selected.name, CHANNEL_NAME);

    for (const channel of [
        organizerChannel({ enabled: false }),
        organizerChannel({ verificationStatus: "UNVERIFIED" }),
        organizerChannel({ labels: { email_address: "other@example.com" } }),
        organizerChannel({ type: "sms" }),
        organizerChannel({ name: "projects/other/notificationChannels/123456" }),
    ]) {
        assert.throws(
            () => selectVerifiedOrganizerChannel([channel]),
            expectStage("notification_channel"),
        );
    }
});

test("missing organizer channel fails with exact setup guidance", () => {
    assert.throws(
        () => selectVerifiedOrganizerChannel([]),
        (error) => {
            assert.ok(expectStage("notification_channel")(error));
            assert.match(error.guidance, new RegExp(ORGANIZER_NOTIFICATION_ADDRESS, "u"));
            assert.match(error.guidance, new RegExp(PROJECT_ID, "u"));
            assert.match(error.guidance, /complete the verification/u);
            assert.match(error.guidance, /No channel or alert policy was created/u);
            return true;
        },
    );
});

test("desired policies exactly scope dependency, callable, Scheduler, and terminal-resource failures", () => {
    const policies = buildDesiredPolicies(CHANNEL_NAME, SCHEDULER_JOB_ID);
    assert.equal(policies.length, 4);
    assert.deepEqual(
        policies.map((policy) => policy.userLabels.policy_key),
        [
            "dependency_health",
            "callables_5xx",
            "scheduler_failure",
            "reconciliation_failed",
        ],
    );
    for (const policy of policies) {
        assert.equal(policy.enabled, true);
        assert.equal(policy.severity, "ERROR");
        assert.deepEqual(policy.notificationChannels, [CHANNEL_NAME]);
    }

    const dependencyFilter =
        policies[0].conditions[0].conditionMatchedLog.filter;
    assert.match(dependencyFilter, /service_name="reconcileregistrations"/u);
    assert.match(dependencyFilter, /registrationDependencyHealth/u);
    assert.match(dependencyFilter, /status="unhealthy"/u);
    assert.deepEqual(
        policies[0].alertStrategy.notificationRateLimit,
        { period: "300s" },
    );

    assert.equal(policies[1].conditions.length, 4);
    const callableServices = [
        "registerteam",
        "getmyteam",
        "updatemyteam",
        "completeinitialpasswordchange",
    ];
    policies[1].conditions.forEach((condition, index) => {
        const threshold = condition.conditionThreshold;
        assert.match(threshold.filter, /run\.googleapis\.com\/request_count/u);
        assert.match(
            threshold.filter,
            new RegExp(`service_name"="${callableServices[index]}"`, "u"),
        );
        assert.match(threshold.filter, /response_code_class"="5xx"/u);
        assert.equal(threshold.duration, "180s");
        assert.equal(threshold.aggregations[0].alignmentPeriod, "60s");
        assert.ok(
            threshold.thresholdValue > 0 &&
            threshold.thresholdValue < 1 / 60,
        );
    });

    const schedulerFilter =
        policies[2].conditions[0].conditionMatchedLog.filter;
    assert.match(schedulerFilter, new RegExp(SCHEDULER_JOB_ID, "u"));
    assert.match(schedulerFilter, /AttemptFinished/u);
    assert.match(schedulerFilter, /jsonPayload\."@type"=/u);
    assert.match(schedulerFilter, /severity>=ERROR/u);

    const reconciliationFilter =
        policies[3].conditions[0].conditionMatchedLog.filter;
    assert.match(reconciliationFilter, /operation="reconcileRegistrations"/u);
    assert.match(reconciliationFilter, /status="failed"/u);
    assert.match(reconciliationFilter, /severity>=ERROR/u);
    assert.deepEqual(
        policies[3].alertStrategy.notificationRateLimit,
        { period: "300s" },
    );
});

test("policy builder rejects cross-project channels and wrong jobs", () => {
    assert.throws(
        () => buildDesiredPolicies(
            "projects/other/notificationChannels/123",
            SCHEDULER_JOB_ID,
        ),
        expectStage("policy_input"),
    );
    assert.throws(
        () => buildDesiredPolicies(CHANNEL_NAME, "other-job"),
        expectStage("policy_input"),
    );
});

test("policy planning is order-insensitive, deterministic, and idempotent", () => {
    const desired = buildDesiredPolicies(CHANNEL_NAME, SCHEDULER_JOB_ID);
    const serverPolicies = desired.map((policy, index) => ({
        name: `projects/${PROJECT_ID}/alertPolicies/${index + 1}`,
        severity: policy.severity,
        alertStrategy: policy.alertStrategy,
        notificationChannels: policy.notificationChannels,
        enabled: policy.enabled,
        combiner: policy.combiner,
        conditions: policy.conditions.map((condition) => ({
            name: `projects/${PROJECT_ID}/alertPolicies/${index + 1}/conditions/1`,
            ...condition,
        })),
        userLabels: {
            policy_key: policy.userLabels.policy_key,
            component: policy.userLabels.component,
            managed_by: policy.userLabels.managed_by,
        },
        documentation: policy.documentation,
        displayName: policy.displayName,
    }));
    const plan = planPolicyChanges(serverPolicies, desired, "verify");
    assert.deepEqual(
        plan.map(({ action }) => action),
        ["noop", "noop", "noop", "noop"],
    );
});

test("apply plans create missing and update only explicitly managed drift", () => {
    const desired = buildDesiredPolicies(CHANNEL_NAME, SCHEDULER_JOB_ID);
    const managedDrift = {
        ...structuredClone(desired[0]),
        name: `projects/${PROJECT_ID}/alertPolicies/1`,
        enabled: false,
    };
    const plan = planPolicyChanges([managedDrift], desired, "apply");
    assert.deepEqual(
        plan.map(({ action }) => action),
        ["update", "create", "create", "create"],
    );
    assert.throws(
        () => planPolicyChanges([managedDrift], desired, "verify"),
        expectStage("alert_policy_drift"),
    );
});

test("unmanaged display-name drift and managed collisions fail closed", () => {
    const desired = buildDesiredPolicies(CHANNEL_NAME, SCHEDULER_JOB_ID);
    const unmanagedDrift = {
        ...structuredClone(desired[0]),
        name: `projects/${PROJECT_ID}/alertPolicies/1`,
        enabled: false,
        userLabels: {},
    };
    assert.throws(
        () => planPolicyChanges([unmanagedDrift], desired, "apply"),
        expectStage("alert_policy_unmanaged_drift"),
    );
    assert.throws(
        () => planPolicyChanges([
            { ...structuredClone(desired[0]), name: `projects/${PROJECT_ID}/alertPolicies/1` },
            { ...structuredClone(desired[0]), name: `projects/${PROJECT_ID}/alertPolicies/2` },
        ], desired, "apply"),
        expectStage("alert_policy_collision"),
    );
});

test("stale or keyless RoCo-managed policies fail closed in both modes", () => {
    const desired = buildDesiredPolicies(CHANNEL_NAME, SCHEDULER_JOB_ID);
    for (const staleKey of ["registerteam_5xx", undefined]) {
        const stale = {
            ...structuredClone(desired[1]),
            name: `projects/${PROJECT_ID}/alertPolicies/stale`,
            displayName: "RoCo registration: obsolete managed policy",
            userLabels: {
                ...desired[1].userLabels,
                ...(staleKey === undefined
                    ? { policy_key: undefined }
                    : { policy_key: staleKey }),
            },
        };
        for (const mode of ["apply", "verify"]) {
            assert.throws(
                () => planPolicyChanges([stale], desired, mode),
                expectStage("alert_policy_stale_managed"),
            );
        }
    }
});

test("desired policy inventory rejects empty or duplicate managed keys", () => {
    const desired = buildDesiredPolicies(CHANNEL_NAME, SCHEDULER_JOB_ID);
    const missingKey = structuredClone(desired);
    missingKey[0].userLabels.policy_key = "";
    assert.throws(
        () => planPolicyChanges([], missingKey, "apply"),
        expectStage("alert_policy_plan"),
    );

    const duplicateKey = structuredClone(desired);
    duplicateKey[1].userLabels.policy_key = duplicateKey[0].userLabels.policy_key;
    assert.throws(
        () => planPolicyChanges([], duplicateKey, "verify"),
        expectStage("alert_policy_plan"),
    );
});

test("apply workflow reads every prerequisite, mutates idempotently, then reads back", async () => {
    const calls = [];
    const policies = [];
    const api = {
        async listFunctions() {
            calls.push("functions:list");
            return remoteFunctions();
        },
        async listSchedulerJobs() {
            calls.push("jobs:list");
            return [schedulerJob()];
        },
        async getRunService(name) {
            const id = EXPECTED_FUNCTIONS.find((candidate) =>
                name.endsWith(`/${candidate.toLowerCase()}`));
            assert.ok(id);
            calls.push(`run:get:${id}`);
            return runService(id);
        },
        async getRunServiceIamPolicy(name) {
            const id = EXPECTED_FUNCTIONS.find((candidate) =>
                name.endsWith(`/${candidate.toLowerCase()}`));
            assert.ok(id);
            calls.push(`iam:get:${id}`);
            return runIamPolicy(id);
        },
        async listNotificationChannels() {
            calls.push("channels:list");
            return [organizerChannel()];
        },
        async listAlertPolicies() {
            calls.push("policies:list");
            return structuredClone(policies);
        },
        async createAlertPolicy(policy) {
            calls.push(`policy:create:${policy.userLabels.policy_key}`);
            policies.push({
                ...structuredClone(policy),
                name: `projects/${PROJECT_ID}/alertPolicies/${policies.length + 1}`,
            });
        },
        async updateAlertPolicy() {
            assert.fail("no update expected");
        },
    };
    const result = await runProductionMonitoringWorkflow({ mode: "apply", api });
    assert.deepEqual(result, {
        mode: "apply",
        functions: 5,
        iam: { publicCallables: 4, privateSchedulers: 1 },
        alerts: 4,
        changed: 4,
    });
    assert.deepEqual(calls, [
        "functions:list",
        "jobs:list",
        "run:get:registerTeam",
        "iam:get:registerTeam",
        "run:get:getMyTeam",
        "iam:get:getMyTeam",
        "run:get:updateMyTeam",
        "iam:get:updateMyTeam",
        "run:get:completeInitialPasswordChange",
        "iam:get:completeInitialPasswordChange",
        "run:get:reconcileRegistrations",
        "iam:get:reconcileRegistrations",
        "channels:list",
        "policies:list",
        "policy:create:dependency_health",
        "policy:create:callables_5xx",
        "policy:create:scheduler_failure",
        "policy:create:reconciliation_failed",
        "policies:list",
    ]);

    calls.length = 0;
    const second = await runProductionMonitoringWorkflow({ mode: "apply", api });
    assert.deepEqual(second, {
        mode: "apply",
        functions: 5,
        iam: { publicCallables: 4, privateSchedulers: 1 },
        alerts: 4,
        changed: 0,
    });
    assert.deepEqual(calls, [
        "functions:list",
        "jobs:list",
        "run:get:registerTeam",
        "iam:get:registerTeam",
        "run:get:getMyTeam",
        "iam:get:getMyTeam",
        "run:get:updateMyTeam",
        "iam:get:updateMyTeam",
        "run:get:completeInitialPasswordChange",
        "iam:get:completeInitialPasswordChange",
        "run:get:reconcileRegistrations",
        "iam:get:reconcileRegistrations",
        "channels:list",
        "policies:list",
        "policies:list",
    ]);
});

test("apply workflow performs no mutation when verified channel is absent", async () => {
    let mutationCalls = 0;
    const api = {
        async listFunctions() { return remoteFunctions(); },
        async listSchedulerJobs() { return [schedulerJob()]; },
        async getRunService(name) {
            const id = EXPECTED_FUNCTIONS.find((candidate) =>
                name.endsWith(`/${candidate.toLowerCase()}`));
            return runService(id);
        },
        async getRunServiceIamPolicy(name) {
            const id = EXPECTED_FUNCTIONS.find((candidate) =>
                name.endsWith(`/${candidate.toLowerCase()}`));
            return runIamPolicy(id);
        },
        async listNotificationChannels() { return []; },
        async listAlertPolicies() {
            assert.fail("policy inventory should wait for a valid channel");
        },
        async createAlertPolicy() { mutationCalls += 1; },
        async updateAlertPolicy() { mutationCalls += 1; },
    };
    await assert.rejects(
        runProductionMonitoringWorkflow({ mode: "apply", api }),
        expectStage("notification_channel"),
    );
    assert.equal(mutationCalls, 0);
});

test("verify workflow is read-only and rejects policy drift", async () => {
    let mutationCalls = 0;
    const api = {
        async listFunctions() { return remoteFunctions(); },
        async listSchedulerJobs() { return [schedulerJob()]; },
        async getRunService(name) {
            const id = EXPECTED_FUNCTIONS.find((candidate) =>
                name.endsWith(`/${candidate.toLowerCase()}`));
            return runService(id);
        },
        async getRunServiceIamPolicy(name) {
            const id = EXPECTED_FUNCTIONS.find((candidate) =>
                name.endsWith(`/${candidate.toLowerCase()}`));
            return runIamPolicy(id);
        },
        async listNotificationChannels() { return [organizerChannel()]; },
        async listAlertPolicies() { return []; },
        async createAlertPolicy() { mutationCalls += 1; },
        async updateAlertPolicy() { mutationCalls += 1; },
    };
    await assert.rejects(
        runProductionMonitoringWorkflow({ mode: "verify", api }),
        expectStage("alert_policy_drift"),
    );
    assert.equal(mutationCalls, 0);
});

test("release wiring configures monitoring before the canonical read-only gate", async () => {
    const packageConfig = JSON.parse(await readFile(
        path.join(ROOT, "package.json"),
        "utf8",
    ));
    assert.equal(
        packageConfig.scripts["monitoring:configure"],
        "node scripts/configure-production-monitoring.mjs --apply",
    );
    assert.equal(
        packageConfig.scripts["monitoring:verify"],
        "node scripts/configure-production-monitoring.mjs --verify",
    );
    assert.equal(
        packageConfig.scripts["production:runtime:verify"],
        "npm run monitoring:verify",
    );
    const chain = packageConfig.scripts["deploy:production"];
    const deployment = chain.indexOf("deploy:firebase");
    const configure = chain.indexOf("monitoring:configure");
    const verify = chain.indexOf("production:runtime:verify");
    assert.ok(deployment >= 0 && configure > deployment && verify > configure);
});

test("runbook keeps monitoring remote, canonical, and free of Sheet canaries", async () => {
    const [readme, runbook, script] = await Promise.all([
        readFile(path.join(ROOT, "README.md"), "utf8"),
        readFile(path.join(ROOT, "SETUP_TEAM_REGISTRATION.md"), "utf8"),
        readFile(
            path.join(ROOT, "scripts/configure-production-monitoring.mjs"),
            "utf8",
        ),
    ]);
    assert.match(readme, /entirely remote/u);
    assert.match(runbook, new RegExp(ORGANIZER_NOTIFICATION_ADDRESS, "u"));
    assert.match(runbook, /All four deliver/u);
    assert.match(runbook, /extra enabled or paused Scheduler job targets the reconciler/u);
    assert.match(runbook, /stale\/keyless RoCo-managed alert policy/u);
    assert.match(readme, /exact four-key remote Cloud Monitoring policy inventory/u);
    assert.doesNotMatch(
        `${readme}\n${runbook}`,
        /(?:reads|available) (?:an? )?managed[- ]Sheet/u,
    );
    assert.doesNotMatch(script, /\bGoogleAuth\b|from\s+["']googleapis["']/u);
});
