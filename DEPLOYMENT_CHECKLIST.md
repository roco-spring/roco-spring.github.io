# RoCo-Spring reliable production deployment checklist

Use this checklist for every registration-system release. Record the commit SHA, UTC timestamp, operator, exact safe result, and evidence link or command output. Never record credentials, tokens, passwords, private team data, request/response bodies, or participant IP addresses.

## Current release record — 2026-07-17

Status: **BACKEND DEPLOYED AND VERIFIED; GITHUB PUBLICATION IN PROGRESS.** Firebase is live from the clean backend source commit `91c0999e2f2043279d56f3aaf79b061afc5c7bca`. The redesigned site is tested locally but the public GitHub Pages site still serves historical commit `7397283e8b130447e717759a4513026dcf4aee2f` until the pending non-force push and Pages deployment complete. Do not call the website release complete until the final public-site section is checked.

Evidence cutoff for this pre-push record: `2026-07-17T15:11:00Z`.

| Area | Status | Safe evidence |
| --- | --- | --- |
| Release chain of custody | PASS | Historical remote base: `7397283`; registration redesign: `61f59b0f526110b4b20576f697b01d2759e79494`; deployed backend source: clean `91c0999e2f2043279d56f3aaf79b061afc5c7bca`; final evidence/Pages commit: pending. Cloud metadata does not cryptographically attest a Git SHA, so the backend SHA claim is based on the clean-tree source gates observed immediately before deployment. |
| Original incident | RESOLVED | The old GitHub push updated only static Pages; CI had no Firebase deployment job, so every callable was initially missing. Firebase is now deployed. The one failed-first-create of `getMyTeam` left its Cloud Run invoker policy absent; the explicitly approved targeted `roles/run.invoker → allUsers` repair now reads back correctly while handler App Check/Auth validation remains enforced. |
| Public site before push | BLOCKED | GitHub `main`, Verify, Pages, and the live registration HTML still identify `7397283`; the live page still renders ten member rows. This is the remaining release gate, not a backend failure. |
| Local automated release gate | PASS | 71/71 site/tooling assertions, 96/96 Functions tests, 3/3 Firestore Rules tests, and 22/22 Playwright tests passed after the final App Check tooling change. Strict TypeScript build, ESLint, security scan, JavaScript syntax checks, and `git diff --check` passed. |
| Production callable guard gate | PASS | `registerTeam`, `getMyTeam`, `updateMyTeam`, and `completeInitialPasswordChange` each report `PASS ... [DEPLOYED_GUARD]`: exact production-origin preflight plus guarded HTTP 401 callable rejection. |
| App Check configuration | PASS | Exact Firebase web app and reCAPTCHA Enterprise site key match; TTL is `3600s`; key type is score-based, test mode is off, `allowAllDomains=false`, and only `roco-spring.github.io` is allowed. All four callable sources declare `enforceAppCheck: true`. |
| Deterministic App Check plumbing gate | PASS | Server-side temporary-debug exchange produced a short-lived App Check token; `registerTeam` and `getMyTeam` both reached `INVALID_ARGUMENT` from the live browser origin; the debug registration then passed exact 404 plus inventory deletion verification. Final inventory count was zero. Neither temporary credential was logged or persisted. |
| Real-provider automation boundary | EXPECTED REJECTION / MONITOR | The ordinary headless reCAPTCHA exchange returned `403 PERMISSION_DENIED: App attestation failed`. Matching app/key/domain metadata rules out the observed configuration mismatch; automated environments can be risk-rejected. The production threshold was not weakened. Real-browser attestation remains a production-metrics/normal-browser observation, not something the deterministic debug gate claims to prove. |
| Secret Manager and OAuth bootstrap | PASS with stated boundary | Latest version of all three required secrets is enabled. Initial bootstrap proved exact private Drive/Sheets create, parent, RAW write/read, permission pagination/no public sharing, delete, and confirmed absence. Gmail delivery and runtime refresh-token use were not exercised. |
| Identity Platform | PASS | Email/password enabled and password required; improved email privacy enabled; public user signup and deletion disabled; authorized domains include `roco-spring.github.io`. |
| Firestore | PASS | Rules release updated `2026-07-17T13:33:29.734590Z`; five composite indexes are `READY`; TTL for `rateLimits/expiresAt` is `ACTIVE`; emulator rules deny signed-out, owner, and other signed-in direct client access (3/3). A controlled signed-in production data probe was not run. |
| Functions and Scheduler | PASS | Five Gen 2 Node 22 Functions are `ACTIVE` in `europe-west3`; four callables are publicly invokable and guarded; the reconciler is private. The sole Scheduler job is enabled every 15 minutes in `Europe/Berlin` and targets only `reconcileRegistrations`. |
| Artifact cleanup and logs | PASS | `gcf-artifacts` deletes images older than `604800s` (7 days). Safe aggregate query found zero error-severity Cloud Run/Scheduler entries since deployment; no log payloads were read or recorded. |
| APIs and billing | PASS | Artifact Registry, Cloud Build, Cloud Functions, Scheduler, Drive, Eventarc, App Check, Firestore, Gmail, Identity Toolkit, Pub/Sub, reCAPTCHA Enterprise, Cloud Run, Secret Manager, and Sheets APIs are enabled; billing is enabled. |
| Least-privilege deployer | EXCEPTION | Operator `shashanksagnihotri@gmail.com` currently has `roles/owner`. Deployment succeeded, but least-privilege deployer IAM is not satisfied and is not claimed as a pass. Runtime secret binding remains scoped by Function. |
| OAuth consent publication status | UNVERIFIED | OAuth credential bootstrap and API access passed, but consent-screen publishing/production status was not available in the verified metadata and is not claimed. |
| Optional live registration E2E | NOT RUN (optional) | No organizer-approved disposable team data was supplied. Real Auth creation, Gmail delivery, private Sheet lifecycle, forced initial-password change, authenticated dashboard/edit, and cleanup were not exercised. |

## Deployed Function inventory

| Function | State / runtime | Update time (UTC) | Public invoker | Secret bindings by name only |
| --- | --- | --- | --- | --- |
| `registerTeam` | `ACTIVE`, Gen 2, Node 22 | `2026-07-17T13:35:10.020832664Z` | yes | `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `RATE_LIMIT_HMAC_SECRET` |
| `getMyTeam` | `ACTIVE`, Gen 2, Node 22 | `2026-07-17T14:00:14.175798042Z` | yes | none |
| `updateMyTeam` | `ACTIVE`, Gen 2, Node 22 | `2026-07-17T13:35:11.447119668Z` | yes | `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` |
| `completeInitialPasswordChange` | `ACTIVE`, Gen 2, Node 22 | `2026-07-17T13:35:18.557640319Z` | yes | none |
| `reconcileRegistrations` | `ACTIVE`, Gen 2, Node 22 | `2026-07-17T13:35:12.455415674Z` | no | `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` |

The first `getMyTeam` Cloud Build ended with transient code 13 while the same source built four sibling Functions successfully. A targeted retry made it `ACTIVE`; the later targeted IAM repair changed only its Cloud Run invoker policy.

## Release identity and change control

- [x] Confirm target repository `roco-spring/roco-spring.github.io`, branch `main`, Firebase project `roco-spring-registration-2026`, and region `europe-west3`.
- [x] Record historical remote base `7397283`, redesign commit `61f59b0`, and backend deployment source `91c0999` separately.
- [x] Review tracked/untracked changes and preserve unrelated work; no unrelated user changes are present.
- [x] Verify public identifiers against `SETUP_TEAM_REGISTRATION.md`; public Firebase configuration contains no private credential.
- [x] Inventory every active `Coming soon`, placeholder, `TODO`, and `FIXME`. Only challenge leaderboards remain intentionally unavailable; GitHub Discussions are disabled and the live Question Issue Form is the documented alternative.
- [x] Require a clean `release:source` gate at `91c0999` before Firebase mutation.
- [ ] Commit the final release evidence/tooling change and record its SHA separately from backend source `91c0999`.
- [ ] Re-fetch `origin/main` immediately before push and require the base still equals `7397283`; if it moved, integrate, retest, and redeploy affected backend source before pushing.

## Reproducible local verification

- [x] Install root and Functions dependencies from committed lockfiles.
- [x] Pass all 71 site/tooling assertions, including dynamic 3-to-10 member behavior, App Check cleanup failure paths, release-source controls, link/placeholder checks, and credential-scanner self-test.
- [x] Pass all 96 Functions tests.
- [x] Pass all 3 Firestore Rules emulator tests.
- [x] Pass all 22 Playwright tests at desktop/mobile sizes, including accessible member addition/removal, authentication-transition privacy, edit/revision handling, retry idempotency, and no viewport overflow.
- [x] Pass strict TypeScript compilation and ESLint with zero errors.
- [x] Pass the credential/password scanner and manual diff hygiene; repository-local `.secrets-tmp` is absent.
- [x] Pass `git diff --check` and syntax checks for both App Check scripts.
- [x] Treat browser Auth/Function tests as controlled mocks unless a row explicitly says production; do not imply that local coverage sent Gmail or created a production team.

## Production prerequisites and secret boundary

- [x] Verify metadata only: latest enabled versions exist for `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, and `RATE_LIMIT_HMAC_SECRET`.
- [x] Record initial OAuth bootstrap as deliberate provisioning, not routine rotation.
- [x] Pass exact private Drive/Sheets preflight with only `drive.file` and `gmail.send`; never expose token values.
- [x] Record routine-secret-rotation row as `N/A — deliberate initial bootstrap`.
- [x] Verify Identity Platform policy and authorized production domain by API read-back.
- [x] Verify Firebase App Check app/site-key binding, `3600s` TTL, production domain allowlist, score integration, and non-test mode by API read-back.
- [x] Verify required APIs and billing.
- [x] Resolve the ADC quota warning by setting `quota_project_id=roco-spring-registration-2026`; credential file mode was `600`.
- [x] Record deployer `roles/owner` as a least-privilege exception rather than a pass.
- [ ] Verify OAuth consent-screen publishing/production status when an authoritative supported read-back is available.

## Firebase deployment and backend verification

- [x] Deploy from clean committed backend source `91c0999`; retain the source-chain caveat above.
- [x] Bound deploy-only Function discovery to 30 seconds; this affects source discovery only, not Function runtime timeout.
- [x] Deploy and read back Firestore Rules, five `READY` composite indexes, and active TTL.
- [x] Inventory all five `ACTIVE` Gen 2 Node 22 Functions with update times.
- [x] Verify secret names only and confirm Google secrets are absent from Functions that do not use Google APIs.
- [x] Verify all four callable sources declare App Check enforcement.
- [x] Verify all four callable Cloud Run services have `allUsers` invoker; verify the Scheduler-only reconciler does not.
- [x] Verify the sole Scheduler job is `ENABLED`, runs every 15 minutes in `Europe/Berlin`, and targets only the reconciler.
- [x] Pass `backend:smoke` 4/4 with exact production-origin CORS/preflight and guarded HTTP 401 callable protocol.
- [x] Pass `backend:appcheck-ci-smoke` for `registerTeam` and `getMyTeam` with `[TEMPORARY_DEBUG_APP_CHECK_TO_VALIDATION_BOUNDARY]` plus `[CI_DEBUG_TOKEN_REVOKED_AND_DELETION_VERIFIED]`.
- [x] Verify App Check debug-token inventory count is zero after the gate.
- [x] Record the debug-gate proof boundary: accepted token plumbing and handler validation only; it does not prove real reCAPTCHA classification.
- [x] Record ordinary headless reCAPTCHA rejection and do not lower the production threshold to satisfy automation.
- [x] Verify credential-free direct Firestore denial with deployed rules plus 3/3 emulator identities.
- [ ] Run a controlled signed-in production direct-Firestore probe only when safe disposable Auth identities are authorized; emulator evidence is not equivalent.
- [x] Query safe aggregate Function/Scheduler error categories since deployment; result zero, without reading payloads.
- [x] Verify Artifact Registry seven-day cleanup policy.
- [x] Record optional live E2E as `NOT RUN (optional)` and list every unproven path explicitly.

## GitHub release and public monitoring

- [ ] Fetch `origin/main`; confirm it still matches release base `7397283`.
- [ ] Commit intended files explicitly; no force push and no unrelated staging.
- [ ] Push `main` and verify remote SHA equals local SHA.
- [ ] Monitor the GitHub Verify workflow to successful completion for the pushed SHA.
- [ ] Monitor GitHub Pages deployment to successful completion for the pushed SHA.
- [ ] Fetch homepage, Participate, Registration, CSS, Firebase config, registration modules, and shared chrome with cache bypass; require HTTP 200 and current content.
- [ ] Confirm public markers `registration-member-count`, `3 shown · 10 max`, and `+ Add Team Member` are present; first member required and next two optional; no ten-row initial loop remains.
- [ ] Confirm homepage and Participate actions open registration; repository, DevKit, Issues, and Question Issue Form destinations are valid.
- [ ] Run public desktop/mobile Playwright smoke with console, failed-network, accessibility, keyboard, and overflow checks.
- [ ] Re-run 4/4 callable guard smoke after Pages propagation.
- [ ] Re-run deterministic App Check plumbing gate after Pages propagation and verify temporary-registration deletion again.
- [ ] Observe safe aggregate backend/Scheduler errors after propagation; roll forward with a tested fix if needed.

## Final release record

- [ ] Record final commit SHA, push result, GitHub workflow URL, Pages deployment URL/SHA, public live URLs, cache-bypass smoke result, and final test counts.
- [ ] Revoke and remove temporary ADC/SDK material after the final cloud read-back; verify no credential directory exists in the repository.
- [ ] List every skipped/unverified check and its impact: optional registration/Gmail/Auth/Sheet E2E, normal-browser reCAPTCHA observation, signed-in production Firestore probe, OAuth publication status, and least-privilege deployer exception.
- [ ] Confirm the online site—not localhost—shows the redesigned registration flow before declaring completion.
