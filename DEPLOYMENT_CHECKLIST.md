# Reliable production deployment checklist

Record command output, timestamps, deployed revision names, and test team IDs in a private release record. Never put participant data, passwords, OAuth material, App Check debug tokens, or Admin credentials in that record.

## 1. Source and scope

- [ ] `git status --short --branch` shows only reviewed release changes.
- [ ] `git diff` and `git diff --check` pass review; unrelated user changes are preserved.
- [ ] `node --test test/remote-runtime.test.mjs` proves production Firebase routing is remote, emulator wiring is loopback-only, and reconciliation is a Firebase `onSchedule` job.
- [ ] Production has no dependency on a local server, reverse tunnel, mounted file, cluster cron, terminal session, or continuously running workstation/cluster process.
- [ ] Public resource links mention the intended starter kit only.
- [ ] No member-count maximum was reintroduced in frontend or backend validation.
- [ ] A release commit exists and `npm run release:source` reports its exact SHA from a clean tree.

## 2. One-time release gates

These commands may run on this editing node, but none remains running or participates in production after the release.

- [ ] Root site/tooling tests pass.
- [ ] Functions unit/concurrency/reconciliation tests pass.
- [ ] Firestore emulator rules tests prove every direct client read/write is denied.
- [ ] Browser tests pass on loopback, including reload-safe idempotency, no PII in session storage, dynamic team members, first-login flow, editing, and sign-out.
- [ ] TypeScript build passes.
- [ ] ESLint passes.
- [ ] Credential/password security scan passes.
- [ ] Locked dependency files contain no unexpected production dependency change.

## 3. Firebase and Identity Platform

- [ ] Active project is exactly `roco-spring-registration-2026`.
- [ ] Billing and required APIs are enabled for Functions v2, Run, Build, Artifact Registry, Firestore, Auth/Identity Platform, Secret Manager, Scheduler, Eventarc if used, reCAPTCHA Enterprise, Drive, Sheets, and Gmail.
- [ ] Firestore location and Functions region are `europe-west3`.
- [ ] Email/password login is enabled.
- [ ] End-user account creation and deletion are disabled; Admin SDK account management remains enabled.
- [ ] Email-enumeration protection is enabled.
- [ ] `roco-spring.github.io` is an authorized Auth domain.
- [ ] Firestore rules deny all browser reads/writes and required composite indexes/TTL are deployed.
- [ ] Runtime service accounts have only required Firestore/Auth/secret access.
- [ ] Public Cloud Run invocation is limited to callable transport; Auth and App Check guards remain enforced in handlers.

## 4. App Check

- [ ] Production web app uses the expected reCAPTCHA Enterprise site key and authorized domain.
- [ ] App Check enforcement is enabled for all callable Functions.
- [ ] Credential-free production probes return callable `401 UNAUTHENTICATED`, never 2xx/404/redirect/HTML.
- [ ] Ephemeral CI debug token crosses the validation boundary, is deleted in `finally`, deletion reads back as 404, and inventory contains no leftover token.
- [ ] Normal-provider browser metrics show legitimate production traffic is accepted; no production debug bypass exists.

## 5. Google OAuth and private resources

- [ ] OAuth Audience is Internal where applicable or External / In production—not Testing.
- [ ] Brand/sensitive-scope verification is complete where applicable.
- [ ] Requested and granted scopes are exactly `drive.file` and `gmail.send`.
- [ ] The Desktop OAuth client ID is the reviewed production ID.
- [ ] Any prior/exposed client secret was rotated; the fresh secret was entered only in a hidden local terminal prompt.
- [ ] Bootstrap returned a refresh token without printing it.
- [ ] Bootstrap and health gates verify the OAuth principal is exactly the configured organizer account without printing it.
- [ ] Live preflight created a temporary Sheet in the exact folder, wrote/read literal data, verified private permissions, deleted every marker-matched artifact, and confirmed repeated empty inventories.
- [ ] Existing rate-limit HMAC secret was preserved during OAuth-only recovery.
- [ ] Latest versions of all three required secrets are enabled.
- [ ] `npm run google:health:latest` passes one-attempt bounded OAuth refresh, exact scopes, exact organizer principal, and exact private-folder access without using an arbitrary participant Sheet as a global canary.

## 6. Firebase deployment

- [ ] Predeployment latest-secret health passed before mutation.
- [ ] Rules, indexes, and all intended Functions deployed without hidden retry/deadline warnings.
- [ ] Function inventory and regions match source; obsolete revisions receive no traffic.
- [ ] Deployed Node runtime is 22 and timeout/memory/max-instance values match source.
- [ ] Reconciler schedule is every five minutes and its Scheduler job is enabled.
- [ ] Exactly four callable Cloud Run services grant `allUsers` `roles/run.invoker`; `reconcileRegistrations` does not, retains its IAM invoker check, and grants invocation to the exact Scheduler OIDC service account.
- [ ] The Scheduler job and Functions continue to run with the release machine disconnected; no local cron or process is registered as an operational dependency.
- [ ] `npm run monitoring:configure` idempotently creates or repairs the four managed alert policies only after finding the existing enabled, `VERIFIED` organizer email channel.
- [ ] `npm run production:runtime:verify` proves the exact active second-generation Node.js 22 Function inventory, Cloud Run IAM boundary, exact remote OIDC Scheduler target, a successful invocation within the preceding 15 minutes, organizer channel, and alert definitions; the read-only command may exit afterward.
- [ ] `npm run google:health:bound` proves numeric OAuth bindings exist only on `reconcileRegistrations`, validates the numeric HMAC-only `registerTeam` binding and secret-free `updateMyTeam`, and refreshes the exact reconciler OAuth versions successfully.
- [ ] Backend CORS/guard smoke passes for all callables.
- [ ] Deterministic App Check CI smoke passes and cleanup is verified.

## 7. Controlled production E2E

- [ ] Production form accepts a normal App Check session and returns one team ID.
- [ ] Reload/retry uses the same idempotency key and does not allocate a second team/user/Sheet/email send.
- [ ] Auth contains exactly one expected account with `mustChangePassword=true` before first login.
- [ ] Firestore contains one internally consistent team/owner/email/request set.
- [ ] Registration remains committed if Drive/Sheets is deliberately unavailable in a controlled non-production test; synchronization remains pending.
- [ ] Exactly one private marked Sheet appears in the required folder and contains literal values only.
- [ ] Registration email is received from the exact sender with the exact Reply-To; spam/junk is checked.
- [ ] Temporary password works once, mandatory password change completes, sessions are revoked, and the old password no longer works.
- [ ] Dashboard reload shows only the authenticated owner's team.
- [ ] Team edit commits one new Firestore revision and synchronizes the same Sheet ID exactly once.
- [ ] Approved disposable test resources are cleaned up and cleanup is verified.

## 8. Monitoring and recovery readiness

- [ ] Scheduled dependency health logs `healthy`; no arbitrary participant Sheet is used as a global queue canary.
- [ ] Cloud Monitoring alert for `registrationDependencyHealth/status=unhealthy` is enabled and its organizer notification channel is verified.
- [ ] Alerts cover sustained 5xx/deadline rates on all four public callables, Scheduler attempt failures, and durable reconciliation resources logged with `status=failed`.
- [ ] The exact `roco-spring-org@googlegroups.com` enabled/verified channel and all four required policies pass `npm run production:runtime:verify`; no local watcher or cron job is counted as monitoring.
- [ ] A controlled test incident reaches the organizer's inbox; configuration read-back alone is not reported as proof of notification delivery.
- [ ] No pending/failed email, Sheet, cleanup, or incomplete saga remains unexplained after two reconciler intervals.
- [ ] Targeted incident-consumed rate-limit buckets are reset only when justified.
- [ ] OAuth recovery procedure has been exercised without rotating the rate-limit HMAC secret.

## 9. GitHub Pages and publication

- [ ] Reviewed release commit is pushed non-force to the intended branch.
- [ ] GitHub Actions verification succeeds for the pushed SHA.
- [ ] GitHub Pages deployment succeeds for the same SHA.
- [ ] Production pages return 200 over HTTPS and show the new release, not a cached placeholder.
- [ ] Registration assets load without console errors, failed requests, mixed content, or stale hashes.
- [ ] Navigation, responsive layout, shared chrome, flow background, starter-kit links, citations, and registration UI are visually checked on desktop and mobile.

## 10. Release closeout

- [ ] Production logs remain clean through at least two five-minute reconciliation intervals.
- [ ] Controlled E2E evidence is recorded privately; no untested item is described as passed.
- [ ] Any intentionally skipped item is explicitly marked `NOT RUN` with owner and follow-up date.
- [ ] Final status names the Git SHA, Function revisions, Pages deployment, health checks, E2E outcome, and any required operator action.
