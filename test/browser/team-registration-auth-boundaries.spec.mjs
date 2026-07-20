import { expect, test } from "@playwright/test";

const FIREBASE_VERSION = "12.16.0";

const FIREBASE_MODULES = {
  "firebase-app.js": `
    const harness = globalThis.__rocoFirebaseHarness;
    export function initializeApp(config) {
      harness.firebaseConfig = config;
      return { config };
    }
  `,
  "firebase-app-check.js": `
    export class ReCaptchaEnterpriseProvider {
      constructor(siteKey) {
        this.siteKey = siteKey;
      }
    }
    export function initializeAppCheck(app, options) {
      return { app, options };
    }
  `,
  "firebase-auth.js": `
    const harness = globalThis.__rocoFirebaseHarness;
    export const browserSessionPersistence = { type: "SESSION" };
    export const EmailAuthProvider = {
      credential(email, password) {
        return { email, password };
      }
    };
    export function getAuth() {
      return harness.auth;
    }
    export function connectAuthEmulator() {}
    export function setPersistence() {
      return Promise.resolve();
    }
    export function onAuthStateChanged(_auth, observer) {
      return harness.observeAuth(observer);
    }
    export function getIdTokenResult(user, forceRefresh) {
      return harness.getIdTokenResult(user, forceRefresh);
    }
    export function signOut() {
      return harness.signOut();
    }
    export function signInWithEmailAndPassword(_auth, email, password) {
      return harness.signIn(email, password);
    }
    export function sendPasswordResetEmail(_auth, email) {
      return harness.recordPasswordReset(email);
    }
    export function reauthenticateWithCredential(user, credential) {
      return harness.reauthenticate(user, credential);
    }
    export function updatePassword(user, password) {
      return harness.updatePassword(user, password);
    }
  `,
  "firebase-functions.js": `
    const harness = globalThis.__rocoFirebaseHarness;
    export function getFunctions() {
      return { region: "stub" };
    }
    export function connectFunctionsEmulator() {}
    export function httpsCallable(_functions, name) {
      return (payload) => harness.invokeCallable(name, payload);
    }
  `
};

function teamFixture(label, revision = 1) {
  const slug = label.toLowerCase();

  return {
    teamId: `RoCo-${revision}`,
    teamName: `${label} Private Team`,
    primaryContactEmail: `${slug}@private.example`,
    tracks: ["optical-flow"],
    members: [{
      fullName: `${label} Private Member`,
      email: `${slug}@private.example`,
      affiliation: `${label} Private Laboratory`
    }],
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    revision,
    sheetSyncStatus: "synced",
    sheetLastSyncedRevision: revision
  };
}

async function installFirebaseHarness(page) {
  await page.addInitScript(() => {
    const auth = { currentUser: null };
    const observers = new Set();
    const tokenPolicies = new Map();
    const callableRequests = [];
    const passwordResets = [];
    const passwordOperations = [];
    let reauthenticationFailureCode = null;
    let nextCallableId = 1;

    function emitAuth(user) {
      auth.currentUser = user;
      for (const observer of observers) observer(user);
    }

    globalThis.__rocoFirebaseHarness = {
      auth,
      firebaseConfig: null,

      observeAuth(observer) {
        observers.add(observer);
        // Firebase invokes a newly registered observer with the current state;
        // mirror that initial asynchronous notification in the browser harness.
        queueMicrotask(() => {
          if (observers.has(observer)) observer(auth.currentUser);
        });
        return () => observers.delete(observer);
      },

      emitAuth,

      setTokenSuccess(uid, claims = {}) {
        tokenPolicies.set(uid, { kind: "success", claims });
      },

      setTokenFailure(uid, code = "auth/user-token-expired") {
        tokenPolicies.set(uid, { kind: "failure", code });
      },

      getIdTokenResult(user, forceRefresh) {
        if (forceRefresh !== true) {
          return Promise.reject(new Error("Expected a forced ID-token refresh."));
        }

        const policy = tokenPolicies.get(user.uid) ?? { kind: "success", claims: {} };

        if (policy.kind === "failure") {
          const error = new Error("Stubbed ID-token refresh failure.");
          error.code = policy.code;
          return Promise.reject(error);
        }

        return Promise.resolve({ claims: policy.claims });
      },

      signOut() {
        emitAuth(null);
        return Promise.resolve();
      },

      signIn(email) {
        const user = { uid: `signed-in:${email}`, email };
        emitAuth(user);
        return Promise.resolve({ user });
      },

      recordPasswordReset(email) {
        passwordResets.push(email);
        return Promise.resolve();
      },

      readPasswordResets() {
        return [...passwordResets];
      },

      reauthenticate() {
        passwordOperations.push("reauthenticate");
        if (reauthenticationFailureCode) {
          const error = new Error("Stubbed reauthentication failure.");
          error.code = reauthenticationFailureCode;
          return Promise.reject(error);
        }
        return Promise.resolve();
      },

      updatePassword() {
        passwordOperations.push("updatePassword");
        return Promise.resolve();
      },

      setReauthenticationFailure(code) {
        reauthenticationFailureCode = code;
      },

      clearPasswordOperations() {
        passwordOperations.length = 0;
      },

      readPasswordOperations() {
        return [...passwordOperations];
      },

      invokeCallable(name, payload) {
        const id = nextCallableId;
        nextCallableId += 1;

        return new Promise((resolve, reject) => {
          callableRequests.push({
            id,
            name,
            payload,
            uid: auth.currentUser?.uid ?? null,
            settled: false,
            resolve,
            reject
          });
        });
      },

      pendingCallCount(name, uid) {
        return callableRequests.filter((request) => (
          request.name === name
          && request.uid === uid
          && request.settled === false
        )).length;
      },

      pendingCallPayload(name, uid) {
        return callableRequests.find((request) => (
          request.name === name
          && request.uid === uid
          && request.settled === false
        ))?.payload ?? null;
      },

      resolveCall(name, uid, data) {
        const request = callableRequests.find((candidate) => (
          candidate.name === name
          && candidate.uid === uid
          && candidate.settled === false
        ));

        if (!request) throw new Error(`No pending ${name} request for ${uid}.`);
        request.settled = true;
        request.resolve({ data });
      },

      rejectCall(name, uid, code = "functions/internal") {
        const request = callableRequests.find((candidate) => (
          candidate.name === name
          && candidate.uid === uid
          && candidate.settled === false
        ));

        if (!request) throw new Error(`No pending ${name} request for ${uid}.`);
        const error = new Error(`Stubbed ${name} failure.`);
        error.code = code;
        request.settled = true;
        request.reject(error);
      }
    };
  });

  await page.route(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/**`, async (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").at(-1);
    const body = FIREBASE_MODULES[filename];

    if (!body) {
      await route.abort("failed");
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body
    });
  });
}

async function openPortal(page) {
  await installFirebaseHarness(page);
  await page.goto("/team-registration.html");
  await waitForPortal(page);
}

async function waitForPortal(page) {
  await expect.poll(() => page.evaluate(() => window.rocoTeamRegistrationReady)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.rocoTeamRegistrationSettled)).toBe(true);
}

async function fillRegistrationForm(page, teamName = "Idempotent Browser Team") {
  await page.locator("#register-team-name").fill(teamName);
  await page.locator("#register-primary-email").fill("OWNER@EXAMPLE.ORG");
  await page.locator('#registration-form input[name="tracks"][value="optical-flow"]').check();
  await page.locator("#register-member-1-fullName").fill("Owner Person");
  await page.locator("#register-member-1-email").fill("owner@example.org");
  await page.locator("#register-member-1-affiliation").fill("Example Institute");
  await page.locator("#submitter-is-member").check();
}

async function configureToken(page, uid, claims = {}) {
  await page.evaluate(({ targetUid, targetClaims }) => {
    window.__rocoFirebaseHarness.setTokenSuccess(targetUid, targetClaims);
  }, { targetUid: uid, targetClaims: claims });
}

async function emitUser(page, uid, email = `${uid.toLowerCase()}@login.example`) {
  await page.evaluate(({ targetUid, targetEmail }) => {
    window.__rocoFirebaseHarness.emitAuth({ uid: targetUid, email: targetEmail });
  }, { targetUid: uid, targetEmail: email });
}

async function emitSignedOut(page) {
  await page.evaluate(() => window.__rocoFirebaseHarness.emitAuth(null));
}

async function waitForCall(page, name, uid) {
  await expect.poll(() => page.evaluate(({ callableName, targetUid }) => (
    window.__rocoFirebaseHarness.pendingCallCount(callableName, targetUid)
  ), { callableName: name, targetUid: uid })).toBe(1);
}

async function resolveCall(page, name, uid, data) {
  await page.evaluate(({ callableName, targetUid, responseData }) => {
    window.__rocoFirebaseHarness.resolveCall(callableName, targetUid, responseData);
  }, { callableName: name, targetUid: uid, responseData: data });
}

async function loadUserTeam(page, uid, fixture) {
  await configureToken(page, uid);
  await emitUser(page, uid);
  await waitForCall(page, "getMyTeam", uid);
  await resolveCall(page, "getMyTeam", uid, { team: fixture });
  await expect(page.locator("#dashboard-team-name")).toHaveText(fixture.teamName);
  await expect(page.locator("#dashboard-view")).toBeVisible();
}

test("a delayed team load from user A cannot overwrite user B after an auth handoff", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const teamA = teamFixture("Alpha", 11);
  const teamB = teamFixture("Bravo", 22);

  await openPortal(page);
  await configureToken(page, "uid-a");
  await configureToken(page, "uid-b");

  await emitUser(page, "uid-a", "alpha@login.example");
  await waitForCall(page, "getMyTeam", "uid-a");

  await emitSignedOut(page);
  await emitUser(page, "uid-b", "bravo@login.example");
  await waitForCall(page, "getMyTeam", "uid-b");
  await resolveCall(page, "getMyTeam", "uid-b", { team: teamB });

  await expect(page.locator("#dashboard-team-name")).toHaveText(teamB.teamName);
  await expect(page.locator("#dashboard-primary-email")).toHaveText(teamB.primaryContactEmail);

  await resolveCall(page, "getMyTeam", "uid-a", { team: teamA });

  await expect(page.locator("#dashboard-team-name")).toHaveText(teamB.teamName);
  await expect(page.locator("#dashboard-primary-email")).toHaveText(teamB.primaryContactEmail);
  await expect(page.locator("#dashboard-members")).toContainText("Bravo Private Member");
  await expect(page.locator("body")).not.toContainText("Alpha Private Team");
  await expect(page.locator("body")).not.toContainText("alpha@private.example");
  expect(errors).toEqual([]);
});

test("a rejected token refresh removes all rendered private data and password candidates", async ({ page }) => {
  const teamA = teamFixture("TokenFailure", 31);
  await openPortal(page);
  await loadUserTeam(page, "uid-a", teamA);

  await page.getByRole("button", { name: "Edit team details" }).click();
  await page.evaluate(() => {
    document.getElementById("initial-new-password").value = "InitialSecret-123";
    document.getElementById("initial-confirm-password").value = "InitialSecret-123";
    document.getElementById("current-password").value = "CurrentSecret-123";
    document.getElementById("new-password").value = "NormalSecret-123";
    document.getElementById("confirm-new-password").value = "NormalSecret-123";
  });

  await page.evaluate(() => {
    window.__rocoFirebaseHarness.setTokenFailure("uid-a");
    window.__rocoFirebaseHarness.emitAuth({ uid: "uid-a", email: "alpha@login.example" });
  });

  await expect(page.locator("#public-auth")).toBeVisible();
  await expect(page.locator("#login-status")).toContainText("secure session could not be verified");
  await expect(page.locator("#dashboard-panel")).toBeHidden();
  await expect(page.locator("#dashboard-view")).toBeHidden();
  await expect(page.locator("#edit-team-form")).toBeHidden();

  for (const selector of [
    "#initial-new-password",
    "#initial-confirm-password",
    "#current-password",
    "#new-password",
    "#confirm-new-password"
  ]) {
    await expect(page.locator(selector)).toHaveValue("");
  }

  for (const selector of [
    "#dashboard-team-id",
    "#dashboard-team-name",
    "#dashboard-primary-email",
    "#dashboard-created-at",
    "#dashboard-updated-at",
    "#dashboard-revision",
    "#dashboard-sync-status"
  ]) {
    await expect(page.locator(selector)).toHaveText("");
  }

  await expect(page.locator("#edit-team-name")).toHaveValue("");
  await expect(page.locator("#edit-primary-email")).toHaveValue("");

  await expect(page.locator("#dashboard-tracks")).toBeEmpty();
  await expect(page.locator("#dashboard-members")).toBeEmpty();
  await expect(page.locator("#edit-members .member-slot")).toHaveCount(3);
  const editMemberValues = await page.locator("#edit-members input").evaluateAll((inputs) => (
    inputs.map((input) => input.value)
  ));
  expect(editMemberValues).toEqual(new Array(9).fill(""));
  await expect(page.locator("body")).not.toContainText(teamA.teamName);
  await expect(page.locator("body")).not.toContainText(teamA.primaryContactEmail);
});

test("the edit form preserves every loaded member beyond the initial three rows", async ({ page }) => {
  const team = teamFixture("Expanded", 36);
  team.members = Array.from({ length: 12 }, (_, index) => ({
    fullName: `Expanded Member ${index + 1}`,
    email: `expanded-${index + 1}@private.example`,
    affiliation: `Expanded Laboratory ${index + 1}`
  }));
  team.primaryContactEmail = team.members[0].email;

  await openPortal(page);
  await loadUserTeam(page, "uid-expanded", team);
  await page.getByRole("button", { name: "Edit team details" }).click();

  await expect(page.locator("#edit-members .member-slot")).toHaveCount(12);
  for (let memberIndex = 1; memberIndex <= team.members.length; memberIndex += 1) {
    const member = team.members[memberIndex - 1];
    await expect(page.locator(`#edit-member-${memberIndex}-fullName`)).toHaveValue(
      member.fullName
    );
    await expect(page.locator(`#edit-member-${memberIndex}-email`)).toHaveValue(member.email);
    await expect(page.locator(`#edit-member-${memberIndex}-affiliation`)).toHaveValue(
      member.affiliation
    );
  }

  await page.getByRole("button", { name: "Save team details" }).click();
  await waitForCall(page, "updateMyTeam", "uid-expanded");
  const updatePayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("updateMyTeam", "uid-expanded")
  ));
  expect(updatePayload.members).toHaveLength(12);
  expect(updatePayload.members[11]).toEqual(team.members[11]);
  await resolveCall(page, "updateMyTeam", "uid-expanded", {
    team,
    synchronizationStatus: "synced"
  });
  await expect(page.locator("#dashboard-view")).toBeVisible();
});

test("a delayed update from user A is ignored after user B signs in", async ({ page }) => {
  const teamA = teamFixture("UpdateAlpha", 41);
  const teamB = teamFixture("UpdateBravo", 52);
  const staleUpdate = {
    ...teamFixture("StaleAlphaUpdate", 42),
    teamId: teamA.teamId
  };

  await openPortal(page);
  await loadUserTeam(page, "uid-a", teamA);
  await configureToken(page, "uid-b");

  await page.getByRole("button", { name: "Edit team details" }).click();
  await page.locator("#edit-team-name").fill("StaleAlphaUpdate Private Team");
  await page.getByRole("button", { name: "Save team details" }).click();
  await waitForCall(page, "updateMyTeam", "uid-a");

  const updatePayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("updateMyTeam", "uid-a")
  ));
  expect(updatePayload.expectedRevision).toBe(teamA.revision);
  expect(updatePayload.teamName).toBe("StaleAlphaUpdate Private Team");

  await emitSignedOut(page);
  await emitUser(page, "uid-b", "bravo@login.example");
  await waitForCall(page, "getMyTeam", "uid-b");
  await resolveCall(page, "getMyTeam", "uid-b", { team: teamB });
  await expect(page.locator("#dashboard-team-name")).toHaveText(teamB.teamName);

  await resolveCall(page, "updateMyTeam", "uid-a", {
    team: staleUpdate,
    synchronizationStatus: "synced"
  });

  await expect(page.locator("#dashboard-team-name")).toHaveText(teamB.teamName);
  await expect(page.locator("#dashboard-primary-email")).toHaveText(teamB.primaryContactEmail);
  await expect(page.locator("#dashboard-members")).toContainText("UpdateBravo Private Member");
  await expect(page.locator("body")).not.toContainText(staleUpdate.teamName);
  await expect(page.locator("body")).not.toContainText(staleUpdate.primaryContactEmail);
});

test("every password field is cleared at each authentication transition", async ({ page }) => {
  const teamB = teamFixture("PasswordBravo", 62);
  await openPortal(page);

  await emitSignedOut(page);
  await expect(page.locator("#public-auth")).toBeVisible();
  await page.getByRole("tab", { name: "Sign in to an existing team" }).click();
  await page.locator("#login-password").fill("TemporaryLoginSecret-123");

  await configureToken(page, "uid-a", { mustChangePassword: true });
  await emitUser(page, "uid-a", "alpha@login.example");
  await expect(page.locator("#initial-password-panel")).toBeVisible();
  await expect(page.locator("#login-password")).toHaveValue("");

  await page.locator("#initial-new-password").fill("InitialCandidate-123");
  await page.locator("#initial-confirm-password").fill("InitialCandidate-123");

  await configureToken(page, "uid-b");
  await emitUser(page, "uid-b", "bravo@login.example");
  await waitForCall(page, "getMyTeam", "uid-b");
  await expect(page.locator("#initial-new-password")).toHaveValue("");
  await expect(page.locator("#initial-confirm-password")).toHaveValue("");
  await resolveCall(page, "getMyTeam", "uid-b", { team: teamB });

  await page.locator("#current-password").fill("CurrentCandidate-123");
  await page.locator("#new-password").fill("NormalCandidate-123");
  await page.locator("#confirm-new-password").fill("NormalCandidate-123");

  await configureToken(page, "uid-c", { mustChangePassword: true });
  await emitUser(page, "uid-c", "charlie@login.example");
  await expect(page.locator("#initial-password-panel")).toBeVisible();

  for (const selector of [
    "#login-password",
    "#initial-new-password",
    "#initial-confirm-password",
    "#current-password",
    "#new-password",
    "#confirm-new-password"
  ]) {
    await expect(page.locator(selector)).toHaveValue("");
  }
});

test("an ordinary password change reauthenticates first and never updates after failed reauthentication", async ({ page }) => {
  const team = teamFixture("PasswordOrder", 71);
  await openPortal(page);
  await loadUserTeam(page, "uid-password", team);

  await page.locator("#current-password").fill("CurrentCandidate-123");
  await page.locator("#new-password").fill("ReplacementCandidate-123");
  await page.locator("#confirm-new-password").fill("ReplacementCandidate-123");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.locator("#change-password-status")).toContainText("Password changed successfully");
  expect(await page.evaluate(() => (
    window.__rocoFirebaseHarness.readPasswordOperations()
  ))).toEqual(["reauthenticate", "updatePassword"]);

  await page.evaluate(() => {
    window.__rocoFirebaseHarness.clearPasswordOperations();
    window.__rocoFirebaseHarness.setReauthenticationFailure("auth/wrong-password");
  });
  await page.locator("#current-password").fill("IncorrectCandidate-123");
  await page.locator("#new-password").fill("AnotherCandidate-123");
  await page.locator("#confirm-new-password").fill("AnotherCandidate-123");
  await page.getByRole("button", { name: "Change password" }).click();

  await expect(page.locator("#change-password-status")).toContainText("current password");
  expect(await page.evaluate(() => (
    window.__rocoFirebaseHarness.readPasswordOperations()
  ))).toEqual(["reauthenticate"]);
});

test("sign-in, successful edit, and dashboard sign-out complete without browser or network errors", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(new URL(request.url()).pathname);
  });

  const email = "owner@example.org";
  const uid = `signed-in:${email}`;
  const original = teamFixture("HappyLogin", 81);
  const updated = {
    ...original,
    teamName: "Happy Login Updated Team",
    updatedAt: "2026-07-03T10:00:00.000Z",
    revision: 82,
    sheetLastSyncedRevision: 82
  };

  await openPortal(page);
  await configureToken(page, uid);
  await page.getByRole("tab", { name: "Sign in to an existing team" }).click();
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill("TemporaryLoginSecret-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await waitForCall(page, "getMyTeam", uid);
  await resolveCall(page, "getMyTeam", uid, { team: original });

  await expect(page.locator("#dashboard-view")).toBeVisible();
  await expect(page.locator("#dashboard-team-name")).toHaveText(original.teamName);
  await expect(page.locator("#login-password")).toHaveValue("");

  await page.getByRole("button", { name: "Edit team details" }).click();
  await page.locator("#edit-team-name").fill(updated.teamName);
  await page.getByRole("button", { name: "Save team details" }).click();
  await waitForCall(page, "updateMyTeam", uid);
  expect(await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("updateMyTeam", "signed-in:owner@example.org")
  ))).toMatchObject({
    expectedRevision: 81,
    teamName: updated.teamName
  });
  await resolveCall(page, "updateMyTeam", uid, {
    team: updated,
    synchronizationStatus: "synced"
  });

  await expect(page.locator("#dashboard-team-name")).toHaveText(updated.teamName);
  await expect(page.locator("#dashboard-status")).toContainText("saved");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.locator("#public-auth")).toBeVisible();
  await expect(page.locator("#login-status")).toContainText("Signed out successfully");
  await expect(page.locator("body")).not.toContainText(updated.teamName);
  await expect(page.locator("body")).not.toContainText(updated.primaryContactEmail);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("a registration retry survives reload, stores no plaintext participant data, and rotates for changed data", async ({ page }) => {
  await openPortal(page);
  await page.locator("#add-registration-member").click();
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(4);
  await fillRegistrationForm(page);
  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);

  const firstPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));
  expect(firstPayload).toMatchObject({
    teamName: "Idempotent Browser Team",
    primaryContactEmail: "owner@example.org",
    tracks: ["optical-flow"],
    registrantConfirmed: true,
    members: [{
      fullName: "Owner Person",
      email: "owner@example.org",
      affiliation: "Example Institute"
    }]
  });
  expect(firstPayload.members).toEqual([{
    fullName: "Owner Person",
    email: "owner@example.org",
    affiliation: "Example Institute"
  }]);
  expect(firstPayload.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );

  await page.evaluate(() => {
    window.__rocoFirebaseHarness.rejectCall("registerTeam", null, "functions/unavailable");
  });
  await expect(page.locator("#registration-status")).not.toHaveAttribute("data-state", "loading");

  const storedEntries = await page.evaluate(() => Object.fromEntries(
    Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter(Boolean)
      .map((key) => [key, sessionStorage.getItem(key)])
  ));
  expect(Object.keys(storedEntries)).toEqual(["roco.registrationAttempt.v1"]);
  const storedAttempt = JSON.parse(storedEntries["roco.registrationAttempt.v1"]);
  expect(Object.keys(storedAttempt).sort()).toEqual(["fingerprint", "idempotencyKey"]);
  expect(storedAttempt.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  expect(storedAttempt.idempotencyKey).toBe(firstPayload.idempotencyKey);
  for (const privateValue of [
    "Idempotent Browser Team",
    "owner@example.org",
    "Owner Person",
    "Example Institute"
  ]) {
    expect(JSON.stringify(storedEntries)).not.toContain(privateValue);
  }

  await page.reload();
  await waitForPortal(page);
  await fillRegistrationForm(page);
  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);
  const replayPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));
  expect(replayPayload.idempotencyKey).toBe(firstPayload.idempotencyKey);

  await page.evaluate(() => {
    window.__rocoFirebaseHarness.rejectCall("registerTeam", null, "functions/internal");
  });
  await expect(page.locator("#registration-status")).not.toHaveAttribute("data-state", "loading");
  expect(await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("roco.registrationAttempt.v1")
  ).idempotencyKey)).toBe(firstPayload.idempotencyKey);

  await page.locator("#register-team-name").fill("Changed Browser Team");
  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);
  const changedPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));
  expect(changedPayload.idempotencyKey).not.toBe(firstPayload.idempotencyKey);
  const changedStoredAttempt = await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("roco.registrationAttempt.v1")
  ));
  expect(changedStoredAttempt.idempotencyKey).toBe(changedPayload.idempotencyKey);
  expect(changedStoredAttempt.fingerprint).not.toBe(storedAttempt.fingerprint);

  await resolveCall(page, "registerTeam", null, {
    teamId: "RoCo-81",
    emailStatus: "sent"
  });
  await expect(page.locator("#login-tab-panel")).toBeVisible();
  await expect(page.locator("#login-email")).toHaveValue("owner@example.org");
  await expect(page.locator("#login-status")).toContainText("Registration completed for RoCo-81");
  await expect(page.locator("#registration-spam-notice")).toBeVisible();
  await expect(page.locator("#registration-spam-notice")).toContainText("Check your spam or junk folder");
  await expect(page.locator("#login-email")).toHaveAttribute(
    "aria-describedby",
    "login-status registration-spam-notice"
  );
  await expect(page.locator("#registration-spam-notice")).toHaveCSS("color", "rgb(141, 30, 30)");
  expect(await page.evaluate(() => sessionStorage.getItem(
    "roco.registrationAttempt.v1"
  ))).toBeNull();

  await page.getByRole("tab", { name: "Register a new team" }).click();
  await expect(page.locator("#registration-spam-notice")).toBeHidden();
  await expect(page.locator("#login-email")).not.toHaveAttribute("aria-describedby", /.+/u);
  await expect(page.locator("#registration-members .member-slot")).toHaveCount(3);
  await expect(page.locator("#register-team-name")).toHaveValue("");
  for (let memberIndex = 1; memberIndex <= 3; memberIndex += 1) {
    for (const field of ["fullName", "email", "affiliation"]) {
      await expect(page.locator(`#register-member-${memberIndex}-${field}`)).toHaveValue("");
    }
  }
});

test("a terminal registration failure clears the replay UUID before a deliberate retry", async ({ page }) => {
  await openPortal(page);
  await fillRegistrationForm(page, "Terminal Browser Team");
  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);
  const firstPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));

  await page.evaluate(() => {
    window.__rocoFirebaseHarness.rejectCall(
      "registerTeam",
      null,
      "functions/failed-precondition"
    );
  });
  await expect(page.locator("#registration-status")).not.toHaveAttribute("data-state", "loading");
  expect(await page.evaluate(() => sessionStorage.getItem(
    "roco.registrationAttempt.v1"
  ))).toBeNull();

  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);
  const retryPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));
  expect(retryPayload.idempotencyKey).not.toBe(firstPayload.idempotencyKey);

  await resolveCall(page, "registerTeam", null, {
    teamId: "RoCo-82",
    emailStatus: "sent"
  });
  await expect(page.locator("#login-status")).toContainText("Registration completed for RoCo-82");
});

test("an active registration lease keeps and reuses its replay UUID", async ({ page }) => {
  await openPortal(page);
  await fillRegistrationForm(page, "Active Lease Browser Team");
  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);
  const firstPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));

  await page.evaluate(() => {
    window.__rocoFirebaseHarness.rejectCall("registerTeam", null, "functions/aborted");
  });
  await expect(page.locator("#registration-status")).toContainText(
    "already being processed"
  );
  await expect(page.locator("#registration-status")).toContainText(
    "saved request identifier will prevent a duplicate team"
  );
  expect(await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("roco.registrationAttempt.v1")
  ).idempotencyKey)).toBe(firstPayload.idempotencyKey);

  await page.getByRole("button", { name: "Register team" }).click();
  await waitForCall(page, "registerTeam", null);
  const retryPayload = await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
  ));
  expect(retryPayload.idempotencyKey).toBe(firstPayload.idempotencyKey);

  await resolveCall(page, "registerTeam", null, {
    teamId: "RoCo-83",
    emailStatus: "sent"
  });
  await expect(page.locator("#login-status")).toContainText("Registration completed for RoCo-83");
});

for (const scenario of [
  {
    emailStatus: "sent",
    teamId: "RoCo-91",
    expectedMessage: "Registration completed for RoCo-91",
    expectedState: "success",
    spamVisible: true
  },
  {
    emailStatus: "pending",
    teamId: "RoCo-92",
    expectedMessage: "RoCo-92 was created. Confirmation-email delivery is still pending",
    expectedState: "warning",
    spamVisible: true
  },
  {
    emailStatus: "failed",
    teamId: "RoCo-93",
    expectedMessage: "RoCo-93 was created, but confirmation-email delivery needs organizer attention",
    expectedState: "warning",
    spamVisible: false
  }
]) {
  test(`a ${scenario.emailStatus} registration result renders the matching email guidance`, async ({ page }) => {
    await openPortal(page);
    await fillRegistrationForm(page, `${scenario.emailStatus} Email Browser Team`);
    await page.getByRole("button", { name: "Register team" }).click();
    await waitForCall(page, "registerTeam", null);

    await resolveCall(page, "registerTeam", null, {
      teamId: scenario.teamId,
      emailStatus: scenario.emailStatus
    });

    await expect(page.locator("#login-tab-panel")).toBeVisible();
    await expect(page.locator("#login-status")).toContainText(scenario.expectedMessage);
    await expect(page.locator("#login-status")).toHaveAttribute(
      "data-state",
      scenario.expectedState
    );
    if (scenario.spamVisible) {
      await expect(page.locator("#registration-spam-notice")).toBeVisible();
      await expect(page.locator("#login-email")).toHaveAttribute(
        "aria-describedby",
        "login-status registration-spam-notice"
      );
    } else {
      await expect(page.locator("#registration-spam-notice")).toBeHidden();
      await expect(page.locator("#login-email")).not.toHaveAttribute("aria-describedby", /.+/u);
    }
    expect(await page.evaluate(() => sessionStorage.getItem(
      "roco.registrationAttempt.v1"
    ))).toBeNull();
  });
}

test("malformed registration results keep the form and replay UUID", async ({ page }) => {
  await openPortal(page);
  await fillRegistrationForm(page, "Malformed Response Browser Team");

  const malformedResponses = [
    { emailStatus: "sent" },
    { teamId: "RoCo-94", emailStatus: "queued" }
  ];
  let replayUuid = "";

  for (const response of malformedResponses) {
    await page.getByRole("button", { name: "Register team" }).click();
    await waitForCall(page, "registerTeam", null);
    const payload = await page.evaluate(() => (
      window.__rocoFirebaseHarness.pendingCallPayload("registerTeam", null)
    ));
    replayUuid ||= payload.idempotencyKey;
    expect(payload.idempotencyKey).toBe(replayUuid);

    await resolveCall(page, "registerTeam", null, response);
    await expect(page.locator("#registration-status")).toContainText(
      "returned an incomplete response"
    );
    await expect(page.locator("#registration-status")).toContainText(
      "saved request identifier have been kept"
    );
    await expect(page.locator("#register-tab-panel")).toBeVisible();
    await expect(page.locator("#register-team-name")).toHaveValue(
      "Malformed Response Browser Team"
    );
    await expect(page.locator("#registration-spam-notice")).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(
      sessionStorage.getItem("roco.registrationAttempt.v1")
    ).idempotencyKey)).toBe(replayUuid);
  }
});

test("password reset stays neutral and initial password completion signs out", async ({ page }) => {
  await openPortal(page);
  await page.getByRole("tab", { name: "Sign in to an existing team" }).click();
  await page.locator("#login-email").fill("owner@example.org");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.locator("#login-status")).toContainText("If an account exists");
  expect(await page.evaluate(() => (
    window.__rocoFirebaseHarness.readPasswordResets()
  ))).toEqual(["owner@example.org"]);

  await configureToken(page, "uid-first-login", { mustChangePassword: true });
  await emitUser(page, "uid-first-login", "owner@example.org");
  await expect(page.locator("#initial-password-panel")).toBeVisible();
  await page.locator("#initial-new-password").fill("ReplacementCandidate-123");
  await page.locator("#initial-confirm-password").fill("ReplacementCandidate-123");
  await page.getByRole("button", { name: "Change password and sign out" }).click();
  await waitForCall(page, "completeInitialPasswordChange", "uid-first-login");
  expect(await page.evaluate(() => (
    window.__rocoFirebaseHarness.pendingCallPayload(
      "completeInitialPasswordChange",
      "uid-first-login"
    )
  ))).toEqual({ newPassword: "ReplacementCandidate-123" });

  await resolveCall(page, "completeInitialPasswordChange", "uid-first-login", {
    success: true
  });
  await expect(page.locator("#public-auth")).toBeVisible();
  await expect(page.locator("#login-status")).toContainText(
    "Password changed successfully. Sign in again"
  );
  await expect(page.locator("#initial-new-password")).toHaveValue("");
});

test("a revision conflict reloads the latest team without overwriting it", async ({ page }) => {
  const original = teamFixture("ConflictOriginal", 91);
  const latest = teamFixture("ConflictLatest", 92);
  await openPortal(page);
  await loadUserTeam(page, "uid-conflict", original);
  await page.getByRole("button", { name: "Edit team details" }).click();
  await page.locator("#edit-team-name").fill("Losing Local Edit");
  await page.getByRole("button", { name: "Save team details" }).click();
  await waitForCall(page, "updateMyTeam", "uid-conflict");
  await page.evaluate(() => {
    window.__rocoFirebaseHarness.rejectCall(
      "updateMyTeam",
      "uid-conflict",
      "functions/aborted"
    );
  });
  await waitForCall(page, "getMyTeam", "uid-conflict");
  await resolveCall(page, "getMyTeam", "uid-conflict", { team: latest });

  await expect(page.locator("#edit-team-form")).toBeVisible();
  await expect(page.locator("#edit-team-name")).toHaveValue(latest.teamName);
  await expect(page.locator("#edit-team-status")).toContainText(
    "latest revision is now loaded"
  );
  await expect(page.locator("body")).not.toContainText("Losing Local Edit");
});
