# RoCo-Spring reliable production deployment checklist

Use this checklist for every registration-system release. Record the commit SHA, UTC timestamp, operator, exact safe result, and evidence link or command output for each row. Never paste credentials, tokens, passwords, private team data, or raw function request/response bodies into this file, GitHub, or logs.

## Current release record — 2026-07-16

Status: **IN PROGRESS — the prior static site was pushed, but its production Firebase backend was never deployed.** The redesigned release and hardened deployment gates are local while Firebase authentication is completed. Do not call this release deployed until every mandatory production and public-site row below is complete.

| Area | Status | Safe evidence recorded through 2026-07-16T13:55:00Z |
| --- | --- | --- |
| Repository identity | PASS | Local `main`, `HEAD`, `origin/main`, and `origin/HEAD` are `7397283e8b130447e717759a4513026dcf4aee2f`; target remote is `roco-spring/roco-spring.github.io`. |
| Interrupted-work diagnosis | PASS | Commit `7397283` was pushed and GitHub Pages published its static registration frontend, but the repository CI workflow has no Firebase deployment job. A GitHub push therefore could not deploy the backend. |
| Public-site diagnosis | FAIL | The registration page and its static assets are online from `7397283`, but all four configured `europe-west3` callable endpoints return HTTP 404. The browser SDK maps that missing backend to a safe internal error, which caused the reported message. |
| Requested active placeholders | PASS locally | Registration actions target `team-registration.html`; site repository, Issues, question Issue Form, and `hmorimitsu/roco-spring-devkit` links are real and return HTTP 200 (the issue chooser redirects signed-out visitors to GitHub login). |
| GitHub Discussions | ALTERNATIVE | Repository Discussions are disabled. The site uses a working public “Question or discussion” GitHub Issue Form instead; no Discussions deployment is claimed. |
| Remaining “Coming soon” inventory | ACCEPTED / external | Only the five challenge leaderboards remain active “Coming soon” items. No verified RoCo-Spring leaderboard destinations exist yet. Tutorial placeholders are inside HTML comments and are not published. |
| External starting-kit limitation | EXTERNAL | The linked DevKit repository is live, but its own README still contains organization/competition placeholders outside this repository's scope. |
| Reproducible installs | PASS | Clean `npm ci` and `npm --prefix functions ci` completed from the committed lockfiles. |
| Prior complete automated gate | PASS | For `7397283`, `npm test` passed 46/46 site assertions, 96/96 Functions tests, 3/3 Firestore Rules tests, and 20/20 Playwright tests. |
| Registration redesign gate | PASS locally | Final unrestricted `npm test` passed 61/61 site/tooling assertions, 96/96 Functions tests, 3/3 Firestore Rules tests, and 22/22 Playwright tests. Coverage includes three initial member rows; optional-row clearing; add/focus/remove/reindex through ten; form reset; edit-mode teams larger than three; stale ARIA/error clearing; cross-account PII cleanup; auth boundaries; and mobile no-overflow. Desktop and 390px visual QA also passed. |
| Build and lint | PASS | Clean strict TypeScript build and ESLint completed with zero errors after the final source changes. |
| Security and diff hygiene | PASS | Credential/password scanner, JavaScript syntax checks, independent final security/privacy review, and `git diff --check` passed; no secret or PII was found; `.secrets-tmp` is absent. |
| Firebase CLI production access | WAITING | Interactive Firebase login is open in a hidden terminal session and awaiting its one-time authorization code; no credential has been placed in source or logs. |
| Production callable smoke gate | FAIL | At 2026-07-16T12:44:25Z, `npm run backend:smoke` classified all four configured `europe-west3` callables as `MISSING` (HTTP 404). No token, credential, or response body was logged. |
| Production secret health | BLOCKED | Routine Secret Manager metadata verification is awaiting Firebase login. OAuth bootstrap is required only if the three secrets are missing/disabled or a deliberate credential rotation is needed. |
| Firebase rules/indexes/functions/identity deployment | PENDING | Must follow a clean committed source gate plus successful identity and secret-metadata read-backs; OAuth bootstrap is conditional as documented below. |
| Optional live E2E registration | NOT RUN | Optional per the implementation brief and requires organizer-approved test data plus ownership-safe cleanup. |
| Git commit and push | PENDING | The exact reviewed source must be committed before Firebase deployment; push follows successful backend verification. |
| CI, Pages propagation, and public smoke test | PENDING | Must be observed for the redesign commit after the backend is deployed; no release success is claimed yet. |

## Release identity and change control

- [x] Record the intended branch and current local `HEAD`.
- [x] Fetch `origin` and confirm whether the branch is ahead, behind, or diverged.
- [x] Review `git status`, all tracked diffs, and every untracked file; preserve unrelated work.
- [x] Confirm the target is `roco-spring/roco-spring.github.io` and the Firebase target is `roco-spring-registration-2026`.
- [x] Confirm public URLs and identifiers match `SETUP_TEAM_REGISTRATION.md`; confirm no secret is present in public configuration.
- [x] Review every remaining `Coming soon`, placeholder, `TODO`, and `FIXME`; either link a verified live resource or explicitly document why it remains unavailable.
- [ ] Immediately before deployment, fetch `origin/main`, review every diff/untracked file, commit the exact intended release, and require `npm run release:source` to report a clean tree and full SHA.

## Reproducible local verification

- [x] Install root and Functions dependencies from both lockfiles with `npm ci` and `npm --prefix functions ci`.
- [x] Run `npm test` and require all static, Functions, Firestore-emulator, and browser tests to pass.
- [x] Run `npm run build` and require strict TypeScript compilation to pass.
- [x] Run `npm run lint` and require zero errors.
- [x] Run `npm run security:scan`; separately review the file-only symbolic-term search documented in the setup guide.
- [x] Run `git diff --check`; inspect generated archives/ignore rules and confirm `.secrets-tmp` is absent or empty.
- [x] Serve the site over HTTP and exercise desktop/mobile navigation, registration validation, login, password reset, initial password change, dashboard, edit/revision-conflict handling, normal password change, and sign-out.
- [x] Inspect browser console and failed network requests on all primary pages.

## Production prerequisites and secret boundary

- [ ] Run `npm run secrets:verify` and confirm only metadata: the latest enabled versions of `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, and `RATE_LIMIT_HMAC_SECRET` exist. Never read plaintext as a routine health check.
- [ ] If this is initial provisioning or an intentional credential recovery/rotation, use a freshly rotated/reissued Desktop OAuth client secret entered only through the hidden prompt in `npm run oauth:bootstrap`; otherwise explicitly record `NOT NEEDED — existing enabled secrets retained`.
- [ ] When bootstrap is required, complete OAuth consent with exactly `drive.file` and `gmail.send`, require a refresh token, and pass the live Drive/Sheets preflight in the exact private folder: create, parent check, RAW write/read, full permission pagination/no public or domain permission, delete, and confirmed 404.
- [ ] Confirm a routine release did not mint a refresh token or rotate the rate-limit HMAC secret.
- [ ] Verify Identity Platform read-back: email/password enabled, public end-user signup/deletion disabled, and improved email privacy enabled.
- [ ] Verify the authorized Auth domain and reCAPTCHA Enterprise App Check registration for `roco-spring.github.io`.
- [ ] Confirm required APIs, billing, least-privilege runtime/deployer permissions, and production-ready OAuth consent status.

## Firebase deployment and backend verification

- [ ] Record the clean committed source SHA immediately before production mutation; require both `release:source` checks inside `npm run deploy:production` to report that same SHA.
- [ ] Run `npm run deploy:production`; any failed test, read-back, secret check, index/rules deploy, Functions deploy, or automatic post-deployment smoke gate blocks the release.
- [ ] If a post-deployment smoke gate fails, record which resources already changed. Firebase does not automatically roll them back; keep the release blocked and roll forward with a reviewed fix.
- [ ] Confirm Firestore rules and indexes are deployed and indexes reach ready state.
- [ ] Inspect the deployed inventory and confirm all four callables plus `reconcileRegistrations` exist in `europe-west3`; record each revision/update time and match it to the committed release.
- [ ] Confirm only Functions that use Google APIs have Google secrets bound; confirm App Check enforcement on callables.
- [ ] Verify direct Firestore reads/writes fail for signed-out users, owners, and other signed-in users.
- [ ] Run `npm run backend:smoke` independently after propagation and require `PASS ... [DEPLOYED_GUARD]` for `registerTeam`, `getMyTeam`, `updateMyTeam`, and `completeInitialPasswordChange`.
- [ ] Confirm each browser preflight permits the exact production origin, `POST`, `authorization`, `content-type`, and `x-firebase-appcheck`; then confirm each token-free POST returns HTTP `401` with callable status `UNAUTHENTICATED`, JSON content type, and production-origin CORS.
- [ ] Treat HTTP `404` as missing deployment and HTTP 2xx as an unguarded callable. Treat bad/missing CORS, malformed protocol errors, redirects, blocked invocation, and persistent network/timeout/5xx responses after the bounded five-attempt retry as release failures.
- [ ] Run `npm run backend:appcheck-smoke` against the public page and require both `registerTeam` and `getMyTeam` to report `PASS ... [VALID_APP_CHECK_TO_VALIDATION_BOUNDARY]` after no more than three attempts.
- [ ] Record the proof boundary accurately: the public `registerTeam` token-free rejection is missing-App-Check evidence; authenticated callable rejections prove a deployed guard but do not distinguish Auth from App Check; the live safe probes prove valid App Check reached handler validation.
- [ ] Do not claim the safe probes prove authenticated dashboard access, OAuth refresh-token health, private Sheet creation/update, or Gmail delivery.
- [ ] Record only callable name, classification, HTTP status category, UTC timestamp, and commit/deployment revision. Never copy request/response bodies, tokens, credentials, or participant data into release evidence.
- [ ] When the environment and organizer-approved test data permit, optionally run one end-to-end test registration using non-production personal data: verify unique ID, Auth claim, private Sheet structure/location/permissions, Gmail sender/Reply-To, forced password change, dashboard, edit synchronization, password change, and sign-out. Record `NOT RUN (optional)` otherwise.
- [ ] If the optional live E2E is run, remove or clearly label its account/team/Sheet only after organizer confirmation and independent ownership checks; never reuse its team number. Otherwise record that the optional test was not run.
- [ ] Check structured Functions and Scheduler logs for safe categories only, without credentials, passwords, tokens, IP addresses, or full team records.

## GitHub release and public monitoring

- [ ] Re-fetch `origin/main` after backend verification and require it to match the release base. If it moved, integrate safely, rerun all affected gates, commit, and redeploy the merged SHA before pushing.
- [ ] Push without force and verify the remote `main` SHA equals the intended local SHA.
- [ ] Monitor the GitHub Actions verification workflow to completion.
- [ ] Monitor GitHub Pages until its deployment identifies the pushed SHA.
- [ ] Fetch the public homepage, Participate page, Registration page, CSS, local modules, and shared chrome with cache bypass; require successful responses and the expected release markers.
- [ ] Verify the homepage and Participate registration actions open the live registration page; verify repository and support links return valid destinations.
- [ ] Re-run browser smoke checks against the public origin at desktop and mobile sizes; inspect console, CSP/CORS/App Check/Auth/function network behavior, accessibility labels, and keyboard flow.
- [ ] Observe the site and safe backend logs after propagation; roll forward with a tested fix if a defect appears. Do not force-push or claim success while any mandatory check is blocked.

## Final release record

- [ ] Report repository, initial/final branch and SHA, files changed, tests and exact counts, Firebase resources deployed, OAuth preflight result, GitHub push result, CI/Pages evidence, and live URLs.
- [ ] Explicitly list every skipped, unavailable, or blocked check and its impact.
- [ ] Confirm the online site—not only localhost—shows the intended release before declaring completion.
