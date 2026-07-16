# RoCo-Spring reliable production deployment checklist

Use this checklist for every registration-system release. Record the commit SHA, UTC timestamp, operator, exact safe result, and evidence link or command output for each row. Never paste credentials, tokens, passwords, private team data, or raw function request/response bodies into this file, GitHub, or logs.

## Current release record — 2026-07-16

Status: **BLOCKED — production Firebase authentication and the live OAuth bootstrap are still required.** Do not call this release deployed until every mandatory production and public-site row below is complete.

| Area | Status | Safe evidence recorded at 2026-07-16T11:30:37Z |
| --- | --- | --- |
| Repository identity | PASS | Local `main`, `HEAD` and `origin/main` are all initially `5cebe3e7723539287b80c7cd0c68ebc57f1bd6aa`; target remote is `roco-spring/roco-spring.github.io`. |
| Interrupted-work diagnosis | PASS | The implementation is present only in the working tree; no new commit or push had occurred. |
| Public-site diagnosis | FAIL / expected before release | Homepage returns HTTP 200 but `team-registration.html` returns HTTP 404, proving GitHub Pages still serves the old revision. |
| Requested active placeholders | PASS locally | Registration actions target `team-registration.html`; site repository, Issues, question Issue Form, and `hmorimitsu/roco-spring-devkit` links are real and return HTTP 200 (the issue chooser redirects signed-out visitors to GitHub login). |
| GitHub Discussions | ALTERNATIVE | Repository Discussions are disabled. The site uses a working public “Question or discussion” GitHub Issue Form instead; no Discussions deployment is claimed. |
| Remaining “Coming soon” inventory | ACCEPTED / external | Only the five challenge leaderboards remain active “Coming soon” items. No verified RoCo-Spring leaderboard destinations exist yet. Tutorial placeholders are inside HTML comments and are not published. |
| External starting-kit limitation | EXTERNAL | The linked DevKit repository is live, but its own README still contains organization/competition placeholders outside this repository's scope. |
| Reproducible installs | PASS | Clean `npm ci` and `npm --prefix functions ci` completed from the committed lockfiles. |
| Complete automated gate | PASS | `npm test`: 46/46 site, 96/96 Functions, 3/3 Firestore Rules, and 20/20 Playwright tests passed, including successful sign-in/edit/sign-out, deployment-script portability, console errors, and failed-request monitoring. |
| Build and lint | PASS | Clean TypeScript build and ESLint completed with zero errors. |
| Security and diff hygiene | PASS | Credential/password scanner and `git diff --check` passed; no local credential file was found; `.secrets-tmp` is absent. |
| Firebase CLI production access | BLOCKED | Safe `projects:list` read failed with “Failed to authenticate”; interactive Firebase login is required. |
| Live Google OAuth preflight and secrets | BLOCKED | Not run. Requires a freshly rotated Desktop OAuth secret entered only through the hidden terminal prompt. |
| Firebase rules/indexes/functions/identity deployment | PENDING | Must follow the successful OAuth preflight and production read-backs. |
| Optional live E2E registration | NOT RUN | Optional per the implementation brief and requires organizer-approved test data plus ownership-safe cleanup. |
| Git commit and push | PENDING | Must follow the mandatory backend deployment gate so the public frontend never points at an undeployed backend. |
| CI, Pages propagation, and public smoke test | PENDING | Must be observed after the push; no success is claimed yet. |

## Release identity and change control

- [x] Record the intended branch and current local `HEAD`.
- [x] Fetch `origin` and confirm whether the branch is ahead, behind, or diverged.
- [x] Review `git status`, all tracked diffs, and every untracked file; preserve unrelated work.
- [x] Confirm the target is `roco-spring/roco-spring.github.io` and the Firebase target is `roco-spring-registration-2026`.
- [x] Confirm public URLs and identifiers match `SETUP_TEAM_REGISTRATION.md`; confirm no secret is present in public configuration.
- [x] Review every remaining `Coming soon`, placeholder, `TODO`, and `FIXME`; either link a verified live resource or explicitly document why it remains unavailable.

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

- [ ] Use a freshly rotated/reissued Desktop OAuth client secret entered only through the hidden terminal prompt in `npm run oauth:bootstrap`.
- [ ] Complete the real OAuth consent flow with exactly `drive.file` and `gmail.send`; require a refresh token.
- [ ] Pass the live Drive/Sheets preflight in the exact private folder: create, parent check, RAW write/read, full permission pagination/no public or domain permission, delete, and confirmed 404.
- [ ] Verify only metadata: the latest versions of `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, and `RATE_LIMIT_HMAC_SECRET` are enabled.
- [ ] Verify Identity Platform read-back: email/password enabled, public end-user signup/deletion disabled, and improved email privacy enabled.
- [ ] Verify the authorized Auth domain and reCAPTCHA Enterprise App Check registration for `roco-spring.github.io`.
- [ ] Confirm required APIs, billing, least-privilege runtime/deployer permissions, and production-ready OAuth consent status.

## Firebase deployment and backend verification

- [ ] Run `npm run deploy:production`; any failed test, read-back, secret check, index/rules deploy, or Functions deploy stops the release.
- [ ] Confirm Firestore rules and indexes are deployed and indexes reach ready state.
- [ ] Confirm all four callables and the scheduled reconciler exist in `europe-west3` at the intended revisions.
- [ ] Confirm only Functions that use Google APIs have Google secrets bound; confirm App Check enforcement on callables.
- [ ] Verify direct Firestore reads/writes fail for signed-out users, owners, and other signed-in users.
- [ ] Verify a callable rejects missing/invalid App Check and that the live frontend obtains a valid token.
- [ ] When the environment and organizer-approved test data permit, optionally run one end-to-end test registration using non-production personal data: verify unique ID, Auth claim, private Sheet structure/location/permissions, Gmail sender/Reply-To, forced password change, dashboard, edit synchronization, password change, and sign-out. Record `NOT RUN (optional)` otherwise.
- [ ] If the optional live E2E is run, remove or clearly label its account/team/Sheet only after organizer confirmation and independent ownership checks; never reuse its team number. Otherwise record that the optional test was not run.
- [ ] Check structured Functions and Scheduler logs for safe categories only, without credentials, passwords, tokens, IP addresses, or full team records.

## GitHub release and public monitoring

- [ ] Re-fetch `origin/main`, integrate safely if needed, and rerun affected gates.
- [ ] Commit the reviewed source and test changes with a clear message; confirm the commit contains no ignored build/report/credential artifacts.
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
