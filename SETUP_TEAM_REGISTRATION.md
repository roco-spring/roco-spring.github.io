# RoCo-Spring team registration setup

This guide covers the production configuration, local development, verification, OAuth bootstrap, deployment, and recovery procedures for the RoCo-Spring team-registration system. Firestore is the authoritative data store. The private Google Sheet created for each team is an organizer-facing synchronized view.

## Public production configuration

These identifiers are intentionally public and may be committed:

| Setting | Value |
| --- | --- |
| Firebase project | `roco-spring-registration-2026` |
| Google Cloud project number | `149052181991` |
| Firestore location | `europe-west3` |
| Cloud Functions region | `europe-west3` |
| Website | `https://roco-spring.github.io/` |
| Registration page | `https://roco-spring.github.io/team-registration.html` |
| Drive folder | `17UXoH2ldTuSFyhaxOknu6IvGxFbr7QYU` (`RoCo-Spring_Challenge_NeurIPS2026`) |
| Registration sender | `shashanksagnihotri@gmail.com` |
| Reply-To | `roco-spring-org@googlegroups.com` |
| Desktop OAuth client ID | `149052181991-dn69v7pid5o7fi89dtnusbklnbnncnho.apps.googleusercontent.com` |
| reCAPTCHA Enterprise site key | `6LfSN1UtAAAAAOCXmwtsu_brRvLWPnwlHixppEZz` |

The Firebase web app configuration is in `assets/firebase-config.js`. It is a public application identifier, not an Admin credential.

Never place an OAuth client secret, OAuth refresh token, Firebase Admin private key, service-account file, App Check debug token, rate-limit HMAC secret, or password in this repository.

## Architecture and security boundary

- GitHub Pages serves the existing vanilla HTML, CSS, and JavaScript site.
- Firebase Authentication owns email/password credentials. Identity Platform has end-user signup and deletion disabled, while the Admin SDK remains able to create and manage validated registration accounts without orphaning team ownership records.
- Firebase App Check uses the public reCAPTCHA Enterprise key and is initialized before callable requests.
- Second-generation callable Cloud Functions validate requests and enforce ownership in `europe-west3`.
- Firestore stores private authoritative team records, owner mappings, idempotency state, counters, and HMAC-derived rate-limit buckets.
- Firestore client rules deny every direct read and write; only the Admin SDK in Cloud Functions accesses team data.
- The backend creates and updates one private Google Spreadsheet per team, always by its stored file ID.
- The backend sends registration mail through Gmail API as `shashanksagnihotri@gmail.com` with the organizer address as Reply-To.
- Google access uses an offline OAuth refresh token stored only in Google Secret Manager.

The callables are `registerTeam`, `getMyTeam`, `updateMyTeam`, and `completeInitialPasswordChange`. A bounded scheduled reconciler retries pending Sheet synchronization and registration-email delivery, audits previously synchronized Sheets, and completes ownership-checked cleanup of failed partial registrations. Users with the `mustChangePassword` claim cannot access or edit team data until the backend changes their password, clears the claim, and revokes existing refresh tokens.

Public registration uses transactional, HMAC-keyed fixed-window limits of **5 attempts per normalized IP address per hour** and **3 attempts per normalized primary email per 24 hours**. Only HMAC digests are stored in Firestore; the raw IP is never persisted, and the HMAC secret is stored only in Secret Manager.

`rateLimits.expiresAt` is configured as a Firestore TTL field in `firestore.indexes.json`. TTL deletion is asynchronous and is a storage-hygiene control, not part of rate-limit correctness. Completed `registrationRequests` are retained so replaying a completed idempotency key always returns its prior safe result and can never allocate duplicate resources. Durable `teamEmails` records use a stable SHA-256 digest of the normalized address as their client-inaccessible document ID and are also intentionally not expired: they preserve one-team-per-login-email ownership even if an Auth account is externally changed or deleted, and remain valid when the rate-limit HMAC secret rotates.

## Prerequisites and console configuration

Use Node.js 22, npm, and Python 3. The Firebase emulators also require a supported Java runtime. The browser regression suite uses the pinned Playwright package and its Chromium binary.

The production Functions runtime depends on `firebase-admin`, `firebase-functions`, `googleapis`, and `zod`. The root deployment/OAuth tooling depends on `googleapis`; its verification stack pins the Firebase web SDK, Firebase CLI, Firestore Rules test library, and Playwright. Functions development pins TypeScript, ESLint, Firebase type packages, and Vitest. CI supplies Node.js 22, Java 21 for the Firestore emulator, and Chromium; Python 3 is used only to serve the static site during manual local checks. Exact versions are locked in the two committed npm lockfiles.

In project `roco-spring-registration-2026`:

1. Confirm the project is on a billing plan that supports second-generation Cloud Functions and external Google APIs.
2. Create Firestore in `europe-west3`; do not recreate it in another location.
3. Enable Firebase Authentication's Email/Password provider, then run `npm run identity:configure`. The script uses the authenticated Firebase CLI account to set and read back `client.permissions.disabledUserSignup=true`, `client.permissions.disabledUserDeletion=true`, and `emailPrivacyConfig.enableImprovedEmailPrivacy=true` while keeping email/password login enabled. Omitting these controls from the browser is not sufficient because Firebase exposes end-user APIs independently. The equivalent console controls are under **Authentication → Settings → User actions**: disable both user sign-up and user deletion, and enable email-enumeration protection. See the [Identity Platform user-management guidance](https://cloud.google.com/identity-platform/docs/concepts-manage-users), [email-enumeration protection guidance](https://cloud.google.com/identity-platform/docs/admin/email-enumeration-protection), and [Admin v2 project-config reference](https://cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig).
4. Register the web app and ensure `roco-spring.github.io` is an authorized Auth domain.
5. Register the reCAPTCHA Enterprise site key with Firebase App Check for the web app. Review App Check metrics, then enforce it for Cloud Functions after the production frontend is available.
6. Confirm that Cloud Functions, Cloud Build, Artifact Registry, Cloud Run, Firestore, Secret Manager, Drive, Sheets, Gmail, Cloud Scheduler, and reCAPTCHA Enterprise APIs are enabled.
7. Confirm the functions runtime service account can use Firebase Authentication and Firestore and access only the secrets bound to each function. Deployment and scheduler-creation permissions belong to the authenticated deployer and Google-managed service agents, not the runtime service account. Bind no broader roles than required.
8. Keep the Drive folder private. Do not add an `anyone` permission.
9. Confirm the Google OAuth consent configuration is production-ready before bootstrap: use an applicable organization-internal app, or publish the external app to Production and complete any required verification for the two declared scopes. Do not rely on External/Testing credentials, whose refresh tokens for these non-basic scopes can expire after seven days. Keep the organizer sender account authorized without adding broader scopes.

Install the committed dependencies:

```bash
npm ci
npm --prefix functions ci
npx playwright install chromium
```

Authenticate the Firebase CLI if required, then verify the selected project:

```bash
node scripts/firebase-safe.mjs login
node scripts/firebase-safe.mjs use
node scripts/firebase-safe.mjs projects:list
```

The selected project must be `roco-spring-registration-2026` before any secret or deployment command.

## Local development

Start the Auth, Firestore, and Functions emulators:

```bash
npm run emulators
```

Serve the static site from a separate terminal; do not open pages through `file://`:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080/team-registration.html`. The frontend supports Firebase's official App Check debug flow only on loopback hosts. The generated debug token must be registered in the Firebase console for local calls and must never be copied into source, documentation, screenshots, logs, or Git. Production has no debug bypass.

For local Functions emulation only, secret values can be supplied in an ignored `functions/.secret.local` file. Use test-only values and mock Google API boundaries for ordinary automated tests. Never copy production OAuth credentials into a test fixture.

## Tests and checks

Run all repository tests and the strict Functions build:

```bash
npm test
npm run build
npm run lint
```

Run emulator-backed tests when present:

```bash
npm run test:rules
```

That test starts only the Firestore emulator through the debug-sanitizing CLI wrapper and proves that unauthenticated users, owners, and other authenticated users are all denied direct reads and writes.

Run the credential/password scan and list files containing symbolic security terms before committing:

```bash
npm run security:scan
rg -l --hidden -g '!node_modules/**' -g '!.git/**' \
  'client_secret|refresh_token|access_token|temporaryPassword|private_key|BEGIN PRIVATE KEY|GOCSPX|ya29'
```

The file-only search avoids echoing a discovered credential into terminal logs. Inspect each reported file locally after the scanner passes; do not copy a credential value into a terminal, issue, screenshot, or review message. Names such as `temporaryPassword` and the three Secret Manager identifiers are expected in implementation code. A match is acceptable only when no value is logged, persisted, returned to the browser, or committed.

## Initial Google OAuth provisioning and deliberate credential rotation

Run the OAuth bootstrap only for initial secret provisioning or a deliberate credential rotation/recovery. A routine release must use `npm run secrets:verify` and the production health gates; it must not mint a new refresh token or rotate the rate-limit HMAC secret on every deployment.

When bootstrap is actually required, the production OAuth client secret must be freshly rotated/reissued before authorization. Never reuse a secret from a prompt, previous conversation, shell history, source file, README, log, or committed/downloaded credential file. If Google creates a replacement Desktop client with a different client ID, update every public/backend client-ID constant and this document before continuing.

Run the interactive bootstrap from a trusted local terminal:

```bash
npm run oauth:bootstrap
```

The script:

1. Confirms access to `roco-spring-registration-2026` and the expected Desktop client ID.
2. Requires explicit confirmation that the client secret is freshly rotated.
3. Reads the secret with terminal echo disabled and never puts it in an argument or log.
4. Starts a temporary callback server bound to `127.0.0.1` on an available port.
5. Requests exactly `drive.file` and `gmail.send`, with offline access and explicit consent.
6. Requires a refresh token.
7. Creates a temporary Sheet directly in Drive folder `17UXoH2ldTuSFyhaxOknu6IvGxFbr7QYU`, confirms the parent, writes with Sheets API, reads the values back, confirms no `anyone` permission, deletes the file, and confirms deletion.
8. Only after that live preflight passes, writes short-lived mode-`0600` files inside ignored `.secrets-tmp/`, sets the three Secret Manager entries, deletes the temporary directory in a `finally` block, and verifies metadata without reading plaintext back.

The scopes must not be broadened silently. If `drive.file` cannot create the Sheet in the exact folder, record the failing Google operation and safe API status/reason, leave production undeployed, and review the OAuth/folder configuration with the organizers.

The exact Secret Manager names are:

- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REFRESH_TOKEN`
- `RATE_LIMIT_HMAC_SECRET`

Do not run `functions:secrets:access` as a routine verification step. Verify only secret-version metadata. After an intentional rotation, redeploy every function that binds the changed secret and complete the live health checks.

## Firebase deployment

Fetch the target branch, review every tracked and untracked change, and commit the exact release source before any production mutation. The deployment command refuses a dirty tree and records the full source SHA. Confirm the active project, then deploy only rules, indexes, and Functions:

```bash
git fetch origin --prune
npm test
npm run build
npm run lint
npm run security:scan
git status --short
# Review and commit the intended release; the tree must now be clean.
npm run release:source
node scripts/firebase-safe.mjs use
npm run deploy:production
```

`deploy:production` verifies the clean committed source both before and after the local test/build/lint/security gate; re-verifies that public end-user signup and deletion are disabled, improved email privacy is enabled, and email/password login remains enabled; checks that the latest version of each required Secret Manager secret is enabled without accessing plaintext; deploys only Firestore rules, indexes, and Functions; then runs both production health gates described below. Any failed pre-deployment gate stops before deployment. A failed post-deployment smoke gate does not roll back resources that Firebase already updated: keep the release blocked, inspect safe logs and resource inventory, and roll forward with a reviewed fix.

The safe Firebase wrapper gives backend source discovery a bounded 30-second window for deploy commands, following Firebase's documented `FUNCTIONS_DISCOVERY_TIMEOUT` fallback. This covers cold dependency loading on shared filesystems without changing any deployed Function runtime timeout. If discovery still exceeds 30 seconds, stop the release and remove or defer slow module-scope initialization rather than increasing the bound again.

The credential-free endpoint gate can be rerun independently at any time:

```bash
npm run backend:smoke
```

For each callable, it first sends a browser-equivalent `OPTIONS` preflight from `https://roco-spring.github.io` and requires the exact origin, `POST`, and the `authorization`, `content-type`, and `x-firebase-appcheck` headers. It then sends a token-free `{data:{}}` callable request. It never sends credentials, Auth/App Check tokens, or prints a response body. A pass requires the Firebase callable protocol's HTTP `401 UNAUTHENTICATED` JSON rejection with production-origin CORS and reports `PASS ... [DEPLOYED_GUARD]`. Because `registerTeam` is otherwise public, that result is runtime evidence that its missing App Check token was rejected. For the other three authenticated callables, the result proves a deployed guard but cannot distinguish Auth rejection from App Check rejection. HTTP 404, unguarded HTTP 2xx, blocked invocation, bad CORS/protocol, redirects, and persistent timeouts/5xx/network failures all fail. Missing, transient-backend, network, and timeout failures receive at most five bounded attempts with 1/2/4/8-second delays.

The live valid-App-Check gate is also safe to rerun:

```bash
npm run backend:appcheck-smoke
```

It opens the deployed registration page in Chromium, reuses that page's initialized Firebase App Check instance, and sends two non-mutating, credential-free validation probes. `registerTeam({})` and `getMyTeam({productionSmokeProbe:true})` must both reach their handlers and return `functions/invalid-argument`. This establishes that the live origin obtained an accepted App Check token and crossed CORS/infrastructure to the intended validation boundary without creating a team or reading private data. The browser probe retries at most three times to tolerate transient reCAPTCHA or propagation failures.

These two gates do not prove an authenticated dashboard session, Google OAuth refresh-token health, private Drive/Sheets creation, or Gmail delivery. Those end-to-end paths require organizer-approved test data and controlled cleanup; record them as `NOT RUN (optional)` when that authorization is unavailable rather than overclaiming coverage.

The public website remains on GitHub Pages. There is intentionally no Firebase Hosting configuration.

After deployment, verify:

- Firestore rules reject authenticated and unauthenticated browser reads/writes.
- Identity Platform read-back shows `disabledUserSignup=true`, `disabledUserDeletion=true`, `enableImprovedEmailPrivacy=true`, `signIn.email.enabled=true`, and `signIn.email.passwordRequired=true`.
- `npm run backend:smoke` reports `PASS ... [DEPLOYED_GUARD]` for all four callables; do not treat a bare non-404 response as sufficient.
- `npm run backend:appcheck-smoke` reports `PASS ... [VALID_APP_CHECK_TO_VALIDATION_BOUNDARY]` for both safe probes.
- All four callables and `reconcileRegistrations` exist in `europe-west3`; record their revision/update time and confirm they correspond to the committed release source.
- The scheduled reconciliation job exists, is enabled, targets only its associated function, and has a recent safe execution status.
- Functions that do not require Google credentials have no Google secrets bound.
- App Check metrics show legitimate requests before console-level enforcement is enabled.

## Registration and synchronization recovery

Firestore is authoritative. Never repair data by editing a team Sheet and copying it back.

For a Sheet update in `pending` state:

1. Inspect safe structured function logs by team ID and revision; never print the team document or tokens.
2. Correct credentials, permissions, API enablement, or quota configuration.
3. Allow the bounded reconciler to update the same stored spreadsheet ID.
4. Confirm `sheetSyncStatus` becomes `synced` and `sheetLastSyncedRevision` matches the Firestore revision.
5. Never create a replacement Sheet merely because synchronization failed.

For `registrationEmailStatus` of `pending`:

1. Correct the safe Gmail error category or OAuth/API configuration.
2. Allow reconciliation to generate a new cryptographic temporary password in memory, update the Firebase Auth user while preserving `mustChangePassword: true`, and send that newest password.
3. Never recover, store, or reuse an earlier plaintext temporary password. A resent credential invalidates the previous one.
4. Confirm the email status becomes `sent`. The team itself becomes active once the required Auth, Firestore, and private-Sheet core resources exist; email delivery status is tracked independently.

A `failed` synchronization or email status means the bounded automatic retry budget was exhausted or the error was classified as permanent. It is intentionally not retried indefinitely. After correcting the underlying cause, an authorized operator may explicitly requeue the record using trusted Admin tooling by resetting the relevant status to `pending`, its retry count to `0`, and its last-attempt/lease fields to `null`. Never do this from a browser client, and never requeue an email after the user has completed the mandatory password change.

For a partial registration saga, inspect the safe state in `registrationRequests/{sha256(idempotencyKey)}` plus only the referenced team/Auth/Sheet resource identifiers. Before the single non-idempotent Drive create, the backend durably writes `sheetCreateAttemptedAt` under the active saga lease. A replay first searches the exact `registrationRequestId` app-property marker or verifies the stored file ID, MIME type, parent, and marker; once the attempt marker exists it is forbidden from issuing a second create. A marker committed before a process crash may therefore become a safe terminal failure even when no Drive request was sent. This availability tradeoff prevents duplicate team Sheets; after cleanup the participant starts a deliberate new registration with a new key and team number.

An incomplete `allocating`, `auth_created`, or `sheet_created` saga receives a 30-minute recovery grace period. The scheduled reconciler then transactionally rechecks that the state and `updatedAt` are still stale and the lease is expired before fencing the saga to `failed` and `cleanupState=pending`. A client that acquired a fresh lease wins and cleanup backs off; once cleanup wins, later client retries receive the terminal failed-state response. This handles a closed browser, function termination, or lost response without depending on the participant to retry.

The scheduled reconciler makes at most five isolated retries for actual cleanup errors. Firestore team deletion is conditional on both the recorded `registrationRequestId` and owner UID, and owner-mapping deletion is conditional on its team ID. Durable `teamEmails` ownership records are never deleted by cleanup. The reconciler deletes only the failed saga's deterministic Auth user and marker-bound Sheets, searches all Drive locations in case a marked file was moved, deletes every duplicate marker match defensively, treats already-missing resources as complete, and records only a safe error category. For an ambiguous Sheet attempt, absence is accepted only after the one-hour visibility horizon and three no-file observations on separate scheduler runs; observation runs do not consume the five-error retry budget.

When `cleanupState=failed`, stop automatic retries and correct the underlying permission/API problem. After independently verifying every recorded identifier and confirming that none belongs to a live team, an authorized operator may reset only `cleanupState` to `pending`, `cleanupRetryCount` to `0`, and `cleanupLastAttemptAt` to the epoch with trusted Admin tooling. Never requeue cleanup from the browser, never reuse an allocated team number, and never delete a live team, durable email-ownership record, Auth user, or Sheet without organizer confirmation.

## Troubleshooting

- **`unauthenticated` after login:** force-refresh the ID token and confirm the Auth project/domain. A first-login user may only complete the required initial password change.
- **`failed-precondition` on edit:** reload the team; the submitted revision is stale or the Sheet sync is incomplete.
- **App Check rejected:** confirm the Enterprise key is attached to the correct Firebase web app and domain. For localhost, use only the official registered debug token.
- **OAuth returns no refresh token:** retain the narrow scopes, revoke the prior app grant if appropriate, and rerun with explicit consent. Never print token responses.
- **Drive parent or permission check fails:** stop. Do not fall back to My Drive root and do not make a Sheet public.
- **Gmail sender rejected:** authenticate the organizer mailbox shown above. Do not switch to SMTP, an app password, third-party mail, or the Google Group as sender.
- **Index error during reconciliation:** deploy `firestore.indexes.json` and wait until index construction completes.
- **Secret update not visible:** redeploy the functions that bind the new secret version.

## GitHub Pages release

The repository is a user/organization Pages site served from the root of the pushed branch. After the tested commit is pushed without force:

1. Inspect the repository's Pages deployment/check status.
2. Confirm `https://roco-spring.github.io/` returns the updated homepage.
3. Confirm `https://roco-spring.github.io/team-registration.html` loads shared chrome, styling, flow background, and Firebase modules without path errors.
4. Exercise desktop and mobile navigation and check browser console/network errors.

Do not report the Pages or Firebase deployment as successful without observing the corresponding real deployment and production responses.

Use `DEPLOYMENT_CHECKLIST.md` as the release record. Every required row must contain current evidence; a skipped or blocked production check remains a failed release gate rather than being treated as success.
