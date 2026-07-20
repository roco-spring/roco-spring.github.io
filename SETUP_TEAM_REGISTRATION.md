# Team registration operations runbook

This runbook is the production source of truth for the RoCo-Spring registration backend. Firestore is authoritative. Firebase Authentication owns credentials. Private Google Sheets and registration email are durable, reconciled side effects; an outage in Google Drive, Sheets, or Gmail must not roll back a valid team account.

## Production boundary

| Setting | Production value |
| --- | --- |
| Firebase project | `roco-spring-registration-2026` |
| Project number | `149052181991` |
| Functions / Firestore region | `europe-west3` |
| Website | `https://roco-spring.github.io/` |
| Registration page | `https://roco-spring.github.io/team-registration.html` |
| Private Drive folder | `1gZwIgAcwrtHZN2vW4XttTq5fFA-kU4Y4` |
| OAuth client ID | `149052181991-dn69v7pid5o7fi89dtnusbklnbnncnho.apps.googleusercontent.com` |
| Sender | `shashanksagnihotri@gmail.com` |
| Reply-To | `roco-spring-org@googlegroups.com` |

The Firebase browser configuration, App Check site key, project identifiers, OAuth client ID, and folder ID are public identifiers. OAuth client secrets, refresh/access tokens, Admin credentials, App Check debug tokens, the rate-limit HMAC secret, and all passwords are secrets and must never be committed, pasted into chat, or printed.

## Zero local runtime dependency

Production has zero local runtime dependency. GitHub Pages serves the website. Firebase/Google Cloud runs Auth, App Check, Firestore, the five Cloud Functions, the five-minute Cloud Scheduler job, Secret Manager, and Cloud Monitoring. Google Drive/Sheets stores private organizer records and Gmail sends the registration email. These managed services continue to operate when this repository checkout, the editing node, and the entire local cluster are offline.

`localhost`, Playwright, and Firebase emulators are development/test boundaries only. `npm run oauth:bootstrap`, ADC login, health checks, and deployment commands are one-time administrator operations; they may be run from any trusted workstation and exit after updating or reading cloud state. They are not daemons and production never calls back into that workstation. No local file, cron job, port, shell, credential cache, or long-running process is part of the production data path.

After deployment, this read-only gate verifies the exact active second-generation Node.js 22 Function inventory in `europe-west3`, managed HTTPS endpoints, the four public callable IAM bindings, the private Scheduler-only reconciler binding, the enabled OIDC-authenticated five-minute Scheduler target, a successful Scheduler invocation within the preceding 15 minutes, the exact organizer notification channel, and all four alert-policy definitions through Google Cloud control-plane APIs. The recent successful invocation proves that Scheduler could mint its OIDC token and invoke the deployed reconciler; the dependency-health alert separately covers failures that the reconciler handles after invocation.

```bash
npm run production:runtime:verify
```

The gate uses Application Default Credentials only for the duration of the administrative read. Its native token exchange and every control-plane request are single-attempt, redirect-rejecting, and deadline-bounded. It never prints access tokens, channel resource names, endpoint URLs, or provider response bodies. The operator needs read access equivalent to Cloud Functions Viewer, Cloud Run Viewer, Cloud Scheduler Viewer, Monitoring Viewer, and Monitoring Notification Channel Viewer for `roco-spring-registration-2026`.

## Runtime ownership: no workstation or cluster dependency

Production continues to operate when every organizer workstation and this editing cluster are shut down. GitHub Pages serves the HTML, CSS, and JavaScript. The browser connects directly to the named Firebase project in `europe-west3`; Firebase Authentication, App Check, callable Cloud Functions, Firestore, and Secret Manager provide the application backend and durable state. Drive, Sheets, and Gmail are called from Cloud Functions, never through an organizer machine.

`reconcileRegistrations` is a Firebase `onSchedule` function with an `every 5 minutes` schedule. Deployment creates and runs its Google Cloud Scheduler job remotely; no local cron, terminal, tunnel, web server, or continuously running Node process participates in recovery. The local HTTP server, Firebase emulators, Playwright server, and loopback OAuth callback documented here exist only for one-time development, verification, credential bootstrap, and deployment. Emulator connections in the public client are enabled only when the page hostname is exactly `localhost` or `127.0.0.1`.

Treat this as a release invariant. A production change must not add local filesystem paths, local service URLs, a reverse tunnel, a cluster cron job, or a workstation process to the request, persistence, email, Sheet, or reconciliation paths. Run `node --test test/remote-runtime.test.mjs` to enforce the source-level boundary, and verify the deployed Scheduler job is enabled after every backend deployment.

## Reliability model

The public callable validates App Check and the complete payload, acquires one idempotency lease, allocates a monotonic team ID, creates the deterministic Firebase Auth user, and atomically commits the team, owner, email-ownership, and registration-request records. It does not call Drive, Sheets, Gmail, or OAuth. The browser stores only a SHA-256 fingerprint derived from the normalized payload and a UUID in `sessionStorage`, so a reload can resume the same server operation. It stores no plaintext participant fields or passwords.

New teams start with Sheet synchronization and registration email `pending`. The scheduled reconciler is the only runtime that binds the OAuth credentials; every five minutes it checks the exact OAuth principal, exact scopes, and exact private folder before claiming Google work. It never selects an arbitrary participant Sheet as a global queue canary. An unhealthy check logs `operation=registrationDependencyHealth`, `status=unhealthy` at error severity and does not consume Google job retry attempts. Auth/Firestore cleanup can continue independently, and pending Google work resumes when health returns.

OAuth exchange is a single native request with redirects rejected and an eight-second deadline. The documented scopes returned with that response must exactly match the two approved scopes, and generated API clients receive only the resulting short-lived access token. Google API library retries are disabled. Only the repository's explicit, operation-aware bounded retry layer may retry a request. Non-idempotent Drive create, Sheets append, and Gmail send operations are never blindly replayed.

## Required Google Auth Platform state

Before minting a production refresh token, open Google Cloud Console for the production project and verify:

1. Google Auth Platform **Audience** is either organization **Internal** (only when that is valid for the sender account) or **External / In production**.
2. Do not use **External / Testing**. Google expires Testing refresh tokens after seven days when non-basic scopes are present.
3. Data Access declares exactly:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/gmail.send`
4. Complete any applicable brand and sensitive-scope verification. `gmail.send` is a sensitive scope.
5. The sender account remains authorized and the target folder remains private and writable.

An `invalid_grant` can also follow user revocation, a Google password change for a token containing Gmail scopes, time-limited consent, or excessive live refresh tokens. An `invalid_client` means the deployed client secret does not match the enabled OAuth client.

## OAuth bootstrap or recovery

The previous client secret is considered exposed. Rotate/reissue the Desktop OAuth client secret in Google Cloud Console before every credential recovery. Keep the client ID if Google permits; if a replacement client changes it, update all public and backend constants in one reviewed release.

Run the bootstrap only from a trusted interactive terminal:

```bash
npm run oauth:bootstrap
```

The script confirms project access, requires an explicit fresh-secret confirmation, accepts the new client secret with terminal echo disabled, requests only the two approved scopes, requires an offline refresh token, verifies the exact organizer account, and performs a real create/write/read/privacy/delete Drive/Sheets preflight. Cleanup inventories the unique preflight marker, deletes every matching artifact (including an ambiguous duplicate), and requires repeated empty inventories. Only after that succeeds does it create new OAuth secret versions. It preserves an existing `RATE_LIMIT_HMAC_SECRET`; OAuth repair must not silently reset rate-limit buckets.

After bootstrap, validate the latest secret versions in memory without printing them:

```bash
npm run secrets:verify
npm run google:health:latest
```

Then deploy `reconcileRegistrations`, the only function that binds the OAuth secrets. A Secret Manager update alone does not prove that the deployed revision is using the intended versions.

## Local and release verification

Install the two locked dependency trees and Chromium:

```bash
npm ci
npm --prefix functions ci
npx playwright install chromium
```

Run the complete local gate:

```bash
npm test
npm run build
npm run lint
npm run security:scan
git diff --check
```

The production release command requires a clean committed source tree. It validates the latest OAuth secret pair before deployment, then verifies the intended least-privilege secret split afterward: numeric OAuth bindings only on `reconcileRegistrations`, a numeric rate-limit HMAC binding only on `registerTeam`, and no secret binding on `updateMyTeam`:

```bash
npm run deploy:production
```

The chain also verifies Identity Platform controls, secret metadata, Firestore rules/indexes, callable CORS/auth/App Check guards, an ephemeral App Check debug-token lifecycle, and the remote Function/Scheduler/Monitoring control plane. It does not claim inbox delivery or notification delivery without controlled real tests.

## Controlled production end-to-end test

For a release that changes registration semantics or OAuth credentials, use an organizer-approved disposable team identity and record the evidence without recording its password or tokens:

1. Submit through the production page with normal reCAPTCHA Enterprise App Check.
2. Verify one Auth user, one team, one owner mapping, one durable email mapping, and one completed registration request.
3. Verify exactly one private marked Sheet inside the configured folder and the expected literal rows.
4. Verify the registration email arrives, including sender, Reply-To, team ID, and first-login instructions. Check spam/junk.
5. Sign in, complete the mandatory password change, reload the dashboard, edit the team, and verify the same Sheet ID receives the next revision once.
6. Clean up only the explicitly disposable Auth, Firestore, Drive, and rate-limit resources. Never delete a participant's real registration as test cleanup.

## Incident diagnosis and recovery

Do not rotate secrets, delete Auth users, or clear Firestore broadly before collecting evidence.

1. Run credential-free callable health and the bound integration check:

   ```bash
   npm run backend:smoke
   npm run google:health:bound
   ```

2. Inspect sanitized Cloud logs for `registerTeam` and `registrationDependencyHealth`. Record only stage, safe category, revision, status, and duration.
3. Inspect recent `registrationRequests` using only state/category/timestamps and resource-presence booleans. Do not export participant payloads.
4. Determine whether the authoritative team transaction committed before repairing or cleaning a partial saga.
5. If OAuth is invalid, first put the consent app into the required production state, then rotate/bootstrap OAuth, run the live preflight, deploy, and verify the bound versions.
6. Requeue only affected pending/failed Sheet or email records after dependency health passes. Reset rate-limit documents only for requests demonstrably consumed by the incident.
7. Run a controlled E2E test and monitor logs through at least two reconciler intervals.

## Monitoring

Cloud Monitoring is itself a managed remote service; no local watcher is used. An enabled email notification channel for `roco-spring-org@googlegroups.com` must already exist and Google Cloud must report it as `VERIFIED`. The release workflow deliberately does not create an unverified channel blindly. If it is absent, select project `roco-spring-registration-2026` in Google Cloud Console, open **Monitoring > Alerting > Edit notification channels**, add that exact address under Email, complete the verification received by the group, and confirm the channel is enabled.

After the channel is verified, run the idempotent configuration command:

```bash
npm run monitoring:configure
```

The command finishes all read-only Function, IAM, Scheduler, and channel checks before its first possible write. It creates missing managed policies, updates only policies bearing the exact RoCo management labels, refuses to take over a conflicting unmanaged policy, reads all four policies back, and is a no-op on a second healthy run. Its canonical enabled policies are:

1. `RoCo registration: Google dependency unhealthy`, a log match for `cloud_run_revision`, `europe-west3`, service `reconcileregistrations`, `operation="registrationDependencyHealth"`, `status="unhealthy"`, and `severity>=ERROR`.
2. `RoCo registration: callable sustained 5xx`, four metric conditions over `run.googleapis.com/request_count`, one for each public callable service, scoped to response class `5xx`. Each uses `ALIGN_RATE` over 60 seconds and must remain above `0.001` requests/second for 180 seconds. Cloud Run request deadlines are HTTP 504, so they are included.
3. `RoCo registration: reconciler Scheduler failure`, a log match scoped to the exact project, region, job ID `firebase-schedule-reconcileRegistrations-europe-west3`, `AttemptFinished`, and `severity>=ERROR`.
4. `RoCo registration: reconciliation resource requires recovery`, a log match for `operation="reconcileRegistrations"`, `status="failed"`, and `severity>=ERROR` on the reconciler service. This covers terminal email, Sheet, and failed-registration cleanup resources without putting participant data into the filter.

All three log-match policies use a 300-second notification rate limit and 1800-second auto-close. All four deliver only to the selected enabled/verified organizer channel. Run `npm run production:runtime:verify` after creating or changing any channel, alert, Function, IAM binding, or Scheduler job. A configuration read-back does not prove email delivery; trigger a controlled test incident and verify the organizer group receives it before checking notification delivery off the release checklist.

A healthy endpoint-only probe is insufficient: it proves routing and guards, not OAuth, Drive, Sheets, Gmail, Scheduler, IAM, reconciliation alerts, or notification delivery.
