import {
    EmailAuthProvider,
    getIdTokenResult,
    onAuthStateChanged,
    reauthenticateWithCredential,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut,
    updatePassword
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js";
import { auth, authPersistenceReady, functions } from "./firebase-config.js";
import { TRACKS, isValidEmail, normalizeEmail, validateTeamInput } from "./team-validation.js";

// The callable performs only Firebase Auth and Firestore work. Google side
// effects run asynchronously, so a multi-minute browser wait is never useful.
const REGISTER_TEAM_TIMEOUT_MS = 75000;
const REGISTRATION_ATTEMPT_STORAGE_KEY = "roco.registrationAttempt.v1";
const REGISTRATION_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REGISTRATION_TEAM_ID_PATTERN = /^RoCo-[1-9]\d*$/u;
const REGISTRATION_EMAIL_STATUSES = new Set(["sent", "pending", "failed"]);

const callRegisterTeam = httpsCallable(functions, "registerTeam", {
    timeout: REGISTER_TEAM_TIMEOUT_MS
});
const callGetMyTeam = httpsCallable(functions, "getMyTeam", { timeout: 60000 });
const callUpdateMyTeam = httpsCallable(functions, "updateMyTeam", { timeout: 75000 });
const callCompleteInitialPasswordChange = httpsCallable(
    functions,
    "completeInitialPasswordChange",
    { timeout: 60000 }
);

const elements = {
    portal: document.getElementById("registration-portal"),
    portalLoading: document.getElementById("portal-loading"),
    publicAuth: document.getElementById("public-auth"),
    registerTab: document.getElementById("register-tab"),
    loginTab: document.getElementById("login-tab"),
    registerPanel: document.getElementById("register-tab-panel"),
    loginPanel: document.getElementById("login-tab-panel"),
    registrationForm: document.getElementById("registration-form"),
    registrationStatus: document.getElementById("registration-status"),
    registrationMembers: document.getElementById("registration-members"),
    registrationMemberCount: document.getElementById("registration-member-count"),
    addRegistrationMember: document.getElementById("add-registration-member"),
    registrationMembersAnnouncement: document.getElementById("registration-members-announcement"),
    loginForm: document.getElementById("login-form"),
    loginEmail: document.getElementById("login-email"),
    loginPassword: document.getElementById("login-password"),
    loginStatus: document.getElementById("login-status"),
    registrationSpamNotice: document.getElementById("registration-spam-notice"),
    forgotPasswordButton: document.getElementById("forgot-password-button"),
    initialPasswordPanel: document.getElementById("initial-password-panel"),
    initialPasswordForm: document.getElementById("initial-password-form"),
    initialPasswordStatus: document.getElementById("initial-password-status"),
    forcedSignoutButton: document.getElementById("forced-signout-button"),
    dashboardPanel: document.getElementById("dashboard-panel"),
    dashboardStatus: document.getElementById("dashboard-status"),
    dashboardView: document.getElementById("dashboard-view"),
    dashboardTeamId: document.getElementById("dashboard-team-id"),
    dashboardTeamName: document.getElementById("dashboard-team-name"),
    dashboardPrimaryEmail: document.getElementById("dashboard-primary-email"),
    dashboardCreatedAt: document.getElementById("dashboard-created-at"),
    dashboardUpdatedAt: document.getElementById("dashboard-updated-at"),
    dashboardRevision: document.getElementById("dashboard-revision"),
    dashboardTracks: document.getElementById("dashboard-tracks"),
    dashboardMembers: document.getElementById("dashboard-members"),
    dashboardSyncStatus: document.getElementById("dashboard-sync-status"),
    signoutButton: document.getElementById("signout-button"),
    editTeamButton: document.getElementById("edit-team-button"),
    editTeamForm: document.getElementById("edit-team-form"),
    editTeamStatus: document.getElementById("edit-team-status"),
    editMembers: document.getElementById("edit-members"),
    editMemberCount: document.getElementById("edit-member-count"),
    addEditMember: document.getElementById("add-edit-member"),
    editMembersAnnouncement: document.getElementById("edit-members-announcement"),
    editTeamName: document.getElementById("edit-team-name"),
    editPrimaryEmail: document.getElementById("edit-primary-email"),
    cancelEditButton: document.getElementById("cancel-edit-button"),
    changePasswordForm: document.getElementById("change-password-form"),
    changePasswordStatus: document.getElementById("change-password-status")
};

const INITIAL_MEMBER_SLOTS = 3;
const MEMBER_FIELDS = Object.freeze([
    Object.freeze({ key: "fullName", label: "Full name", type: "text", maximum: 120, autocomplete: "name" }),
    Object.freeze({ key: "email", label: "Contact email address", type: "email", maximum: 254, autocomplete: "email" }),
    Object.freeze({
        key: "affiliation",
        label: "Affiliation",
        type: "text",
        maximum: 300,
        autocomplete: "organization"
    })
]);

let currentTeam = null;
let registrationAttempt = readStoredRegistrationAttempt();
let authenticationSequence = 0;
let signedOutMessage = "";
let signedOutMessageState = "success";

const registrationMemberEditor = {
    container: elements.registrationMembers,
    prefix: "register",
    form: elements.registrationForm,
    addButton: elements.addRegistrationMember,
    count: elements.registrationMemberCount,
    announcement: elements.registrationMembersAnnouncement
};
const editMemberEditor = {
    container: elements.editMembers,
    prefix: "edit",
    form: elements.editTeamForm,
    addButton: elements.addEditMember,
    count: elements.editMemberCount,
    announcement: elements.editMembersAnnouncement
};
const memberEditors = [registrationMemberEditor, editMemberEditor];

initializeMemberEditor(registrationMemberEditor);
initializeMemberEditor(editMemberEditor);
initializeTabs();
initializeEventHandlers();

onAuthStateChanged(auth, handleAuthenticationState);
window.rocoTeamRegistrationReady = true;

function initializeMemberEditor(editor) {
    resetMemberEditor(editor);
    editor.addButton?.addEventListener("click", () => addMemberSlot(editor));
    editor.container.addEventListener("input", () => updateMemberEditorState(editor));
}

function resetMemberEditor(editor, members = []) {
    const safeMembers = Array.isArray(members) ? members : [];
    const slotCount = Math.max(INITIAL_MEMBER_SLOTS, safeMembers.length);
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < slotCount; index += 1) {
        fragment.append(createMemberSlot(editor, index, safeMembers[index]));
    }

    editor.container.replaceChildren(fragment);
    renumberMemberSlots(editor);
    updateMemberEditorState(editor);
}

function createMemberSlot(editor, index, member = {}) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    const number = document.createElement("span");
    const label = document.createElement("span");
    const requirement = document.createElement("span");
    const fields = document.createElement("div");

    fieldset.className = "member-slot";
    number.className = "member-number";
    label.className = "member-slot-label";
    requirement.className = "member-requirement";
    legend.append(number, label, requirement);

    fields.className = "form-grid member-fields";
    MEMBER_FIELDS.forEach(({ key, label: fieldLabel, type, maximum, autocomplete }) => {
        fields.append(createMemberField(editor.prefix, index, key, fieldLabel, type, maximum, autocomplete));
    });

    fieldset.append(legend, fields);

    if (index > 0) {
        const removeButton = document.createElement("button");
        removeButton.className = "text-button member-remove-button";
        removeButton.type = "button";
        removeButton.addEventListener("click", () => removeMemberSlot(editor, fieldset));
        fieldset.append(removeButton);
    }

    setMemberSlotValues(fieldset, member);
    return fieldset;
}

function addMemberSlot(editor) {
    const slotCount = editor.container.querySelectorAll(".member-slot").length;

    const slot = createMemberSlot(editor, slotCount);
    editor.container.append(slot);
    renumberMemberSlots(editor);
    updateMemberEditorState(editor);
    clearFieldErrors(editor.form);
    registrationAttempt = null;
    announceMemberEditor(editor, `Team member ${slotCount + 1} added.`);
    slot.querySelector('[data-member-field="fullName"]')?.focus();
}

function removeMemberSlot(editor, slot) {
    const slots = [...editor.container.querySelectorAll(".member-slot")];
    const removedIndex = slots.indexOf(slot);

    if (removedIndex < 1) return;

    if (removedIndex < INITIAL_MEMBER_SLOTS) {
        slot.querySelectorAll("input").forEach((input) => {
            input.value = "";
        });
        clearFieldErrors(editor.form);
        updateMemberEditorState(editor);
        registrationAttempt = null;
        announceMemberEditor(editor, `Team member ${removedIndex + 1} cleared.`);
        slot.querySelector('[data-member-field="fullName"]')?.focus();
        return;
    }

    if (slots.length <= INITIAL_MEMBER_SLOTS) return;

    slot.remove();
    renumberMemberSlots(editor);
    updateMemberEditorState(editor);
    clearFieldErrors(editor.form);
    registrationAttempt = null;
    announceMemberEditor(editor, `Team member ${removedIndex + 1} removed.`);

    const remainingSlots = [...editor.container.querySelectorAll(".member-slot")];
    const focusTarget = remainingSlots[Math.min(removedIndex, remainingSlots.length - 1)]
        ?.querySelector('[data-member-field="fullName"]') ?? editor.addButton;
    focusTarget?.focus();
}

function renumberMemberSlots(editor) {
    const slots = [...editor.container.querySelectorAll(".member-slot")];

    slots.forEach((slot, index) => {
        const memberNumber = index + 1;
        const isRequired = index === 0;
        slot.dataset.memberIndex = String(index);
        slot.querySelector(".member-number").textContent = String(memberNumber).padStart(2, "0");
        slot.querySelector(".member-slot-label").textContent = `Team member ${memberNumber}`;

        const requirement = slot.querySelector(".member-requirement");
        requirement.className = isRequired
            ? "member-requirement required-member"
            : "member-requirement optional-marker";
        requirement.textContent = isRequired ? "Required" : "Optional";

        MEMBER_FIELDS.forEach(({ key, autocomplete }) => {
            const input = slot.querySelector(`[data-member-field="${key}"]`);
            const wrapper = input.closest(".form-field");
            const label = wrapper.querySelector("label");
            const error = wrapper.querySelector("[data-field-error]");
            const inputId = `${editor.prefix}-member-${memberNumber}-${key}`;
            const errorId = `${inputId}-error`;
            const fieldPath = `members.${index}.${key}`;

            label.htmlFor = inputId;
            input.id = inputId;
            input.required = isRequired;
            input.autocomplete = `section-${editor.prefix}-member-${memberNumber} ${autocomplete}`;
            input.dataset.field = fieldPath;
            input.setAttribute("aria-describedby", errorId);
            error.id = errorId;
            error.dataset.fieldError = fieldPath;
        });

        const removeButton = slot.querySelector(".member-remove-button");
        if (removeButton) {
            const action = index < INITIAL_MEMBER_SLOTS ? "Clear" : "Remove";
            removeButton.textContent = `${action} member ${memberNumber}`;
            removeButton.setAttribute("aria-label", `${action} team member ${memberNumber}`);
        }
    });
}

function updateMemberEditorState(editor) {
    const slots = [...editor.container.querySelectorAll(".member-slot")];
    const slotCount = slots.length;
    const formIsBusy = editor.form.getAttribute("aria-busy") === "true";

    if (editor.count) {
        editor.count.textContent = `${slotCount} shown · add as needed`;
    }

    if (editor.addButton) {
        editor.addButton.disabled = formIsBusy;
        editor.addButton.textContent = "+ Add Team Member";
        editor.addButton.setAttribute("aria-label", `Add team member ${slotCount + 1}`);
    }

    slots.forEach((slot, index) => {
        const removeButton = slot.querySelector(".member-remove-button");
        if (!removeButton) return;
        const starterSlotIsBlank = index < INITIAL_MEMBER_SLOTS
            && [...slot.querySelectorAll("input")].every((input) => input.value.trim() === "");
        removeButton.hidden = starterSlotIsBlank;
        removeButton.disabled = formIsBusy;
    });
}

function announceMemberEditor(editor, message) {
    if (editor.announcement) editor.announcement.textContent = message;
}

function setMemberSlotValues(slot, member = {}) {
    MEMBER_FIELDS.forEach(({ key }) => {
        const input = slot.querySelector(`[data-member-field="${key}"]`);
        input.value = typeof member?.[key] === "string" ? member[key] : "";
    });
}

function createMemberField(prefix, index, key, labelText, type, maximum, autocomplete) {
    const wrapper = document.createElement("div");
    const label = document.createElement("label");
    const input = document.createElement("input");
    const error = document.createElement("span");
    const memberNumber = index + 1;
    const inputId = `${prefix}-member-${memberNumber}-${key}`;
    const errorId = `${inputId}-error`;
    const fieldPath = `members.${index}.${key}`;

    wrapper.className = "form-field";
    label.htmlFor = inputId;
    label.textContent = labelText;
    input.id = inputId;
    input.type = type;
    input.maxLength = maximum;
    input.required = index === 0;
    input.autocomplete = `section-${prefix}-member-${memberNumber} ${autocomplete}`;
    input.dataset.memberField = key;
    input.dataset.field = fieldPath;
    input.setAttribute("aria-describedby", errorId);
    error.className = "field-error";
    error.id = errorId;
    error.dataset.fieldError = fieldPath;

    wrapper.append(label, input, error);
    return wrapper;
}

function initializeTabs() {
    const tabs = [elements.registerTab, elements.loginTab];
    const requestedMode = new URLSearchParams(window.location.search).get("mode");

    activateTab(requestedMode === "login" ? "login" : "register");

    elements.registerTab.addEventListener("click", () => activateTab("register"));
    elements.loginTab.addEventListener("click", () => activateTab("login"));

    tabs.forEach((tab, index) => {
        tab.addEventListener("keydown", (event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                return;
            }

            event.preventDefault();
            let nextIndex = index;

            if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = tabs.length - 1;

            const nextMode = nextIndex === 0 ? "register" : "login";
            activateTab(nextMode);
            tabs[nextIndex].focus();
        });
    });
}

function activateTab(mode) {
    const showLogin = mode === "login";

    if (!showLogin) setRegistrationSpamNotice(false);

    elements.registerTab.setAttribute("aria-selected", String(!showLogin));
    elements.registerTab.tabIndex = showLogin ? -1 : 0;
    elements.loginTab.setAttribute("aria-selected", String(showLogin));
    elements.loginTab.tabIndex = showLogin ? 0 : -1;
    elements.registerPanel.hidden = showLogin;
    elements.loginPanel.hidden = !showLogin;
}

function setRegistrationSpamNotice(visible) {
    elements.registrationSpamNotice.hidden = !visible;

    if (visible) {
        elements.loginEmail.setAttribute(
            "aria-describedby",
            "login-status registration-spam-notice"
        );
    } else {
        elements.loginEmail.removeAttribute("aria-describedby");
    }
}

function initializeEventHandlers() {
    elements.registrationForm.addEventListener("input", () => {
        registrationAttempt = null;
    });
    elements.registrationForm.addEventListener("submit", handleRegistration);
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.loginEmail.addEventListener("input", () => setRegistrationSpamNotice(false));
    elements.forgotPasswordButton.addEventListener("click", handleForgotPassword);
    elements.initialPasswordForm.addEventListener("submit", handleInitialPasswordChange);
    elements.editTeamForm.addEventListener("submit", handleTeamUpdate);
    elements.changePasswordForm.addEventListener("submit", handleNormalPasswordChange);
    elements.editTeamButton.addEventListener("click", openEditForm);
    elements.cancelEditButton.addEventListener("click", closeEditForm);
    elements.signoutButton.addEventListener("click", handleSignOut);
    elements.forcedSignoutButton.addEventListener("click", handleSignOut);
}

async function handleAuthenticationState(user) {
    const sequence = ++authenticationSequence;
    const context = user ? { sequence, uid: user.uid } : null;
    clearPrivateState();
    setPortalState("loading");

    try {
        await authPersistenceReady;

        if (sequence !== authenticationSequence) return;
        if (context && !isCurrentAuthContext(context)) return;

        if (!user) {
            elements.loginPassword.value = "";
            setPortalState("public");

            if (signedOutMessage) {
                activateTab("login");
                setStatus(elements.loginStatus, signedOutMessage, signedOutMessageState);
                signedOutMessage = "";
                signedOutMessageState = "success";
            }
            return;
        }

        // The forced refresh ensures the latest mustChangePassword custom claim is used.
        const tokenResult = await getIdTokenResult(user, true);

        if (!isCurrentAuthContext(context)) return;

        if (tokenResult.claims.mustChangePassword === true) {
            setPortalState("initial-password");
            elements.initialPasswordForm.querySelector("input")?.focus();
            return;
        }

        setPortalState("dashboard");
        await loadMyTeam(context);
    } catch (error) {
        if (context ? !isCurrentAuthContext(context) : sequence !== authenticationSequence) return;

        clearPrivateState();
        signedOutMessage = "The secure session could not be verified. Sign in again.";
        signedOutMessageState = "error";

        if (user) {
            try {
                await signOut(auth);
            } catch {
                // Keep all private UI and data hidden even if Firebase sign-out fails.
            }
        }

        if (sequence === authenticationSequence) {
            elements.loginPassword.value = "";
            activateTab("login");
            setPortalState("public");
            setStatus(elements.loginStatus, signedOutMessage, signedOutMessageState);
            signedOutMessage = "";
            signedOutMessageState = "success";
        }
    }
}

function clearPrivateState() {
    currentTeam = null;
    elements.loginPassword.value = "";
    setRegistrationSpamNotice(false);
    elements.dashboardView.hidden = true;
    elements.editTeamForm.hidden = true;
    elements.initialPasswordForm.reset();
    elements.changePasswordForm.reset();
    elements.editTeamForm.reset();
    resetMemberEditor(editMemberEditor);

    [
        elements.dashboardTeamId,
        elements.dashboardTeamName,
        elements.dashboardPrimaryEmail,
        elements.dashboardCreatedAt,
        elements.dashboardUpdatedAt,
        elements.dashboardRevision,
        elements.dashboardSyncStatus
    ].forEach((element) => {
        element.textContent = "";
        delete element.dataset.state;
    });

    elements.dashboardTracks.replaceChildren();
    elements.dashboardMembers.replaceChildren();
    clearFieldErrors(elements.editTeamForm);
    setStatus(elements.initialPasswordStatus, "", "");
    setStatus(elements.dashboardStatus, "", "");
    setStatus(elements.editTeamStatus, "", "");
    setStatus(elements.changePasswordStatus, "", "");
    setFormBusy(elements.initialPasswordForm, false);
    setFormBusy(elements.editTeamForm, false);
    setFormBusy(elements.changePasswordForm, false);
}

function captureAuthContext() {
    const user = auth.currentUser;
    return user ? { sequence: authenticationSequence, uid: user.uid } : null;
}

function isCurrentAuthContext(context) {
    return Boolean(
        context
        && context.sequence === authenticationSequence
        && auth.currentUser?.uid === context.uid
    );
}

function setPortalState(state) {
    const isLoading = state === "loading";

    if (!isLoading) {
        window.rocoTeamRegistrationSettled = true;
    }

    elements.portal.setAttribute("aria-busy", String(isLoading));
    elements.portalLoading.hidden = !isLoading;
    elements.publicAuth.hidden = state !== "public";
    elements.initialPasswordPanel.hidden = state !== "initial-password";
    elements.dashboardPanel.hidden = state !== "dashboard";
}

async function handleRegistration(event) {
    event.preventDefault();
    clearFieldErrors(elements.registrationForm);

    const input = readTeamForm(elements.registrationForm, true);
    const validation = validateTeamInput(input, { requireSubmitterConfirmation: true });

    if (!validation.success) {
        showFieldErrors(elements.registrationForm, validation.errors);
        setStatus(
            elements.registrationStatus,
            "Please correct the highlighted registration fields and try again.",
            "error"
        );
        return;
    }

    if (
        typeof crypto.randomUUID !== "function"
        || typeof crypto.subtle?.digest !== "function"
    ) {
        setStatus(
            elements.registrationStatus,
            "This browser cannot create a secure registration request. Please use an up-to-date browser.",
            "error"
        );
        return;
    }

    const requestPayload = {
        ...validation.data,
        registrantConfirmed: input.submitterIsMember === true
    };

    setFormBusy(elements.registrationForm, true);
    setStatus(
        elements.registrationStatus,
        "Creating the secure team account and organizer record…",
        "loading"
    );

    try {
        const attempt = await getOrCreateRegistrationAttempt(requestPayload);
        const result = await callRegisterTeam({
            ...requestPayload,
            idempotencyKey: attempt.idempotencyKey
        });
        const { teamId, emailStatus } = parseRegistrationResult(result.data);
        const successfulMessage = `Registration completed for ${teamId}. Check the primary contact email for the temporary password and sign-in instructions.`;
        const pendingMessage = `${teamId} was created. Confirmation-email delivery is still pending and will be retried securely.`;
        const failedMessage = `${teamId} was created, but confirmation-email delivery needs organizer attention. Contact roco-spring-org@googlegroups.com.`;

        clearRegistrationAttempt();
        elements.registrationForm.reset();
        resetMemberEditor(registrationMemberEditor);
        clearFieldErrors(elements.registrationForm);
        setStatus(elements.registrationStatus, "", "");
        elements.loginEmail.value = validation.data.primaryContactEmail;
        activateTab("login");
        setStatus(
            elements.loginStatus,
            emailStatus === "failed" ? failedMessage : emailStatus === "pending" ? pendingMessage : successfulMessage,
            ["pending", "failed"].includes(emailStatus) ? "warning" : "success"
        );
        // A pending email will be delivered asynchronously by the managed
        // reconciler, so the recipient still needs the spam-folder reminder.
        setRegistrationSpamNotice(emailStatus !== "failed");
        elements.loginEmail.focus();
    } catch (error) {
        if (errorCode(error) === "functions/failed-precondition") {
            // A failed saga/idempotency record is terminal; a deliberate retry needs a fresh key.
            clearRegistrationAttempt();
        }
        setStatus(elements.registrationStatus, safeErrorMessage(error, "registration"), "error");
    } finally {
        setFormBusy(elements.registrationForm, false);
    }
}

function parseRegistrationResult(value) {
    const response = isPlainObject(value) ? value : null;
    const teamId = typeof response?.teamId === "string" ? response.teamId : "";
    const rawEmailStatus = response?.registrationEmailStatus ?? response?.emailStatus;
    const emailStatus = typeof rawEmailStatus === "string" ? rawEmailStatus : "";

    if (
        !REGISTRATION_TEAM_ID_PATTERN.test(teamId)
        || !REGISTRATION_EMAIL_STATUSES.has(emailStatus)
    ) {
        const error = new Error("The registration service returned an invalid response.");
        error.code = "registration/invalid-response";
        throw error;
    }

    return { teamId, emailStatus };
}

async function getOrCreateRegistrationAttempt(requestPayload) {
    const fingerprint = await sha256Fingerprint(JSON.stringify(requestPayload));
    const storedAttempt = registrationAttempt ?? readStoredRegistrationAttempt();

    if (storedAttempt?.fingerprint === fingerprint) {
        registrationAttempt = storedAttempt;
        return storedAttempt;
    }

    const idempotencyKey = crypto.randomUUID();
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new Error("The browser generated an invalid registration request identifier.");
    }

    registrationAttempt = { fingerprint, idempotencyKey };
    persistRegistrationAttempt(registrationAttempt);
    return registrationAttempt;
}

async function sha256Fingerprint(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

function readStoredRegistrationAttempt() {
    try {
        const serializedAttempt = sessionStorage.getItem(REGISTRATION_ATTEMPT_STORAGE_KEY);
        if (!serializedAttempt) return null;

        const attempt = JSON.parse(serializedAttempt);
        const hasExactShape = isPlainObject(attempt)
            && Object.keys(attempt).length === 2
            && typeof attempt.fingerprint === "string"
            && REGISTRATION_FINGERPRINT_PATTERN.test(attempt.fingerprint)
            && typeof attempt.idempotencyKey === "string"
            && IDEMPOTENCY_KEY_PATTERN.test(attempt.idempotencyKey);

        if (!hasExactShape) {
            removeStoredRegistrationAttempt();
            return null;
        }

        return {
            fingerprint: attempt.fingerprint,
            idempotencyKey: attempt.idempotencyKey
        };
    } catch {
        removeStoredRegistrationAttempt();
        return null;
    }
}

function persistRegistrationAttempt(attempt) {
    try {
        sessionStorage.setItem(
            REGISTRATION_ATTEMPT_STORAGE_KEY,
            JSON.stringify({
                fingerprint: attempt.fingerprint,
                idempotencyKey: attempt.idempotencyKey
            })
        );
    } catch {
        // The in-memory attempt still protects retries made before a page reload.
    }
}

function removeStoredRegistrationAttempt() {
    try {
        sessionStorage.removeItem(REGISTRATION_ATTEMPT_STORAGE_KEY);
    } catch {
        // Storage can be unavailable in restrictive browser contexts.
    }
}

function clearRegistrationAttempt() {
    registrationAttempt = null;
    removeStoredRegistrationAttempt();
}

async function handleLogin(event) {
    event.preventDefault();
    setRegistrationSpamNotice(false);
    const email = normalizeEmail(elements.loginEmail.value);
    const password = elements.loginPassword.value;

    if (!isValidEmail(email) || password === "") {
        setStatus(elements.loginStatus, "Enter a valid login email and password.", "error");
        return;
    }

    setFormBusy(elements.loginForm, true);
    setStatus(elements.loginStatus, "Signing in securely…", "loading");

    try {
        await authPersistenceReady;
        await signInWithEmailAndPassword(auth, email, password);
        setStatus(elements.loginStatus, "Signed in. Checking account security…", "loading");
    } catch (error) {
        elements.loginPassword.value = "";
        setStatus(elements.loginStatus, safeErrorMessage(error, "login"), "error");
    } finally {
        setFormBusy(elements.loginForm, false);
    }
}

async function handleForgotPassword() {
    setRegistrationSpamNotice(false);
    const email = normalizeEmail(elements.loginEmail.value);

    if (!isValidEmail(email)) {
        setStatus(elements.loginStatus, "Enter a valid email address before requesting a reset.", "error");
        elements.loginEmail.focus();
        return;
    }

    elements.forgotPasswordButton.disabled = true;
    setStatus(elements.loginStatus, "Requesting password-reset instructions…", "loading");

    try {
        await authPersistenceReady;
        await sendPasswordResetEmail(auth, email);
        setStatus(
            elements.loginStatus,
            "If an account exists for that email address, password-reset instructions have been sent.",
            "success"
        );
    } catch (error) {
        const code = errorCode(error);

        if (["auth/network-request-failed", "auth/too-many-requests"].includes(code)) {
            setStatus(
                elements.loginStatus,
                code === "auth/network-request-failed"
                    ? "The reset request could not reach the service. Check the connection and try again."
                    : "If an account exists for that email address, password-reset instructions have been sent.",
                code === "auth/network-request-failed" ? "error" : "success"
            );
        } else {
            // Keep reset responses neutral so the UI does not reveal whether an account exists.
            setStatus(
                elements.loginStatus,
                "If an account exists for that email address, password-reset instructions have been sent.",
                "success"
            );
        }
    } finally {
        elements.forgotPasswordButton.disabled = false;
    }
}

async function handleInitialPasswordChange(event) {
    event.preventDefault();
    const newPasswordInput = elements.initialPasswordForm.elements.newPassword;
    const confirmPasswordInput = elements.initialPasswordForm.elements.confirmPassword;
    const newPassword = newPasswordInput.value;
    const confirmation = confirmPasswordInput.value;

    if (newPassword.length < 12 || newPassword.length > 128) {
        setStatus(elements.initialPasswordStatus, "Use a password containing 12–128 characters.", "error");
        newPasswordInput.focus();
        return;
    }

    if (newPassword !== confirmation) {
        setStatus(elements.initialPasswordStatus, "The new-password entries do not match.", "error");
        confirmPasswordInput.focus();
        return;
    }

    const context = captureAuthContext();

    if (!context) {
        setStatus(elements.initialPasswordStatus, "Sign in again before changing the password.", "error");
        return;
    }

    setFormBusy(elements.initialPasswordForm, true);
    setStatus(elements.initialPasswordStatus, "Changing the password securely…", "loading");

    try {
        await callCompleteInitialPasswordChange({ newPassword });

        if (!isCurrentAuthContext(context)) return;

        elements.initialPasswordForm.reset();
        signedOutMessage = "Password changed successfully. Sign in again using your new password.";
        signedOutMessageState = "success";
        await signOut(auth);
    } catch (error) {
        if (!isCurrentAuthContext(context)) return;
        setStatus(elements.initialPasswordStatus, safeErrorMessage(error, "initial-password"), "error");
    } finally {
        if (isCurrentAuthContext(context)) {
            setFormBusy(elements.initialPasswordForm, false);
        }
    }
}

async function loadMyTeam(context = captureAuthContext()) {
    if (!context || !isCurrentAuthContext(context)) return;

    elements.dashboardView.hidden = true;
    setStatus(elements.dashboardStatus, "Loading your team registration…", "loading");

    try {
        const result = await callGetMyTeam({});

        if (!isCurrentAuthContext(context)) return;

        const team = extractTeam(result.data);

        if (!team) {
            throw new Error("invalid-team-response");
        }

        currentTeam = team;
        renderTeam(team);
        elements.dashboardView.hidden = false;
        setStatus(elements.dashboardStatus, "Team registration loaded.", "success");
    } catch (error) {
        if (!isCurrentAuthContext(context)) return;
        setStatus(elements.dashboardStatus, safeErrorMessage(error, "load-team"), "error");
    }
}

function renderTeam(team) {
    elements.dashboardTeamId.textContent = safeText(team.teamId);
    elements.dashboardTeamName.textContent = safeText(team.teamName);
    elements.dashboardPrimaryEmail.textContent = safeText(team.primaryContactEmail);
    elements.dashboardCreatedAt.textContent = formatDate(team.createdAt);
    elements.dashboardUpdatedAt.textContent = formatDate(team.updatedAt);
    elements.dashboardRevision.textContent = Number.isInteger(team.revision) ? String(team.revision) : "Not available";

    const trackItems = document.createDocumentFragment();
    const selectedTracks = Array.isArray(team.tracks) ? team.tracks : [];

    selectedTracks.forEach((trackId) => {
        const track = TRACKS.find((candidate) => candidate.id === trackId);

        if (track) {
            const item = document.createElement("li");
            item.textContent = track.label;
            trackItems.append(item);
        }
    });

    if (!trackItems.childNodes.length) {
        const item = document.createElement("li");
        item.textContent = "No tracks available";
        trackItems.append(item);
    }

    elements.dashboardTracks.replaceChildren(trackItems);

    const memberRows = document.createDocumentFragment();
    const members = Array.isArray(team.members) ? team.members : [];

    members.forEach((member) => {
        const row = document.createElement("tr");

        [member?.fullName, member?.email, member?.affiliation].forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = safeText(value);
            row.append(cell);
        });

        memberRows.append(row);
    });

    elements.dashboardMembers.replaceChildren(memberRows);
    renderSyncStatus(team.sheetSyncStatus, team.sheetLastSyncedRevision, team.revision);
}

function renderSyncStatus(statusValue, lastSyncedRevision, currentRevision) {
    const status = safeStatusValue(statusValue);
    let message = "Synchronization status is not currently available.";
    let state = "warning";

    if (status === "synced") {
        const revisionText = Number.isInteger(lastSyncedRevision)
            ? ` at revision ${lastSyncedRevision}`
            : Number.isInteger(currentRevision)
                ? ` at revision ${currentRevision}`
                : "";
        message = `Organizer spreadsheet synchronized${revisionText}.`;
        state = "success";
    } else if (status === "pending") {
        message = "Team data is saved; organizer spreadsheet synchronization is pending.";
    } else if (status === "failed") {
        message = "Team data is saved; organizer spreadsheet synchronization needs organizer attention.";
    }

    elements.dashboardSyncStatus.textContent = message;
    elements.dashboardSyncStatus.dataset.state = state;
}

function openEditForm() {
    if (!currentTeam) return;

    populateEditForm(currentTeam);
    elements.dashboardView.hidden = true;
    elements.editTeamForm.hidden = false;
    setStatus(elements.editTeamStatus, "", "");
    elements.editTeamName.focus();
}

function closeEditForm() {
    clearFieldErrors(elements.editTeamForm);
    elements.editTeamForm.hidden = true;
    elements.dashboardView.hidden = false;
    setStatus(elements.editTeamStatus, "", "");
    elements.editTeamButton.focus();
}

function populateEditForm(team) {
    elements.editTeamName.value = typeof team.teamName === "string" ? team.teamName : "";
    elements.editPrimaryEmail.value = typeof team.primaryContactEmail === "string"
        ? team.primaryContactEmail
        : "";
    const selectedTracks = new Set(Array.isArray(team.tracks) ? team.tracks : []);

    elements.editTeamForm.querySelectorAll('input[name="tracks"]').forEach((checkbox) => {
        checkbox.checked = selectedTracks.has(checkbox.value);
    });

    resetMemberEditor(editMemberEditor, Array.isArray(team.members) ? team.members : []);
    clearFieldErrors(elements.editTeamForm);
}

async function handleTeamUpdate(event) {
    event.preventDefault();

    if (!currentTeam || !Number.isInteger(currentTeam.revision)) {
        setStatus(elements.editTeamStatus, "Reload the team before attempting an update.", "error");
        return;
    }

    const context = captureAuthContext();

    if (!context) {
        setStatus(elements.editTeamStatus, "Sign in again before updating the team.", "error");
        return;
    }

    clearFieldErrors(elements.editTeamForm);
    const input = readTeamForm(elements.editTeamForm, false);
    const validation = validateTeamInput(input);

    if (!validation.success) {
        showFieldErrors(elements.editTeamForm, validation.errors);
        setStatus(elements.editTeamStatus, "Please correct the highlighted team fields.", "error");
        return;
    }

    const expectedRevision = currentTeam.revision;
    setFormBusy(elements.editTeamForm, true);
    setStatus(elements.editTeamStatus, "Saving team details and synchronizing the organizer record…", "loading");

    try {
        const result = await callUpdateMyTeam({
            expectedRevision,
            teamName: validation.data.teamName,
            tracks: validation.data.tracks,
            members: validation.data.members
        });

        if (!isCurrentAuthContext(context)) return;

        const response = isPlainObject(result.data) ? result.data : {};
        let team = extractTeam(response);

        if (!team) {
            const refreshed = await callGetMyTeam({});

            if (!isCurrentAuthContext(context)) return;

            team = extractTeam(refreshed.data);
        }

        if (!team) {
            throw new Error("invalid-team-response");
        }

        currentTeam = team;
        renderTeam(team);
        elements.editTeamForm.hidden = true;
        elements.dashboardView.hidden = false;

        const syncStatus = safeStatusValue(
            response.synchronizationStatus
            ?? response.sheetSyncStatus
            ?? response.syncStatus
            ?? response.sheetSync?.status
            ?? team.sheetSyncStatus
        );

        if (syncStatus === "synced") {
            setStatus(elements.dashboardStatus, "Team details saved and organizer record synchronized.", "success");
        } else if (syncStatus === "failed") {
            setStatus(
                elements.dashboardStatus,
                "Team details were saved, but organizer-record synchronization needs organizer attention.",
                "warning"
            );
        } else {
            setStatus(
                elements.dashboardStatus,
                "Team details were saved, but organizer-record synchronization is pending and will be retried.",
                "warning"
            );
        }

        elements.editTeamButton.focus();
    } catch (error) {
        if (!isCurrentAuthContext(context)) return;

        if (isRevisionConflict(error)) {
            await reloadAfterConflict(context);
        } else {
            setStatus(elements.editTeamStatus, safeErrorMessage(error, "update-team"), "error");
        }
    } finally {
        if (isCurrentAuthContext(context)) {
            setFormBusy(elements.editTeamForm, false);
        }
    }
}

async function reloadAfterConflict(context) {
    if (!isCurrentAuthContext(context)) return;

    setStatus(
        elements.editTeamStatus,
        "Another update changed this team. Loading the latest revision without overwriting it…",
        "warning"
    );

    try {
        const refreshed = await callGetMyTeam({});

        if (!isCurrentAuthContext(context)) return;

        const team = extractTeam(refreshed.data);

        if (!team) throw new Error("invalid-team-response");

        currentTeam = team;
        renderTeam(team);
        populateEditForm(team);
        setStatus(
            elements.editTeamStatus,
            "The latest revision is now loaded. Review your changes and submit again.",
            "warning"
        );
    } catch (error) {
        if (!isCurrentAuthContext(context)) return;
        setStatus(elements.editTeamStatus, safeErrorMessage(error, "load-team"), "error");
    }
}

async function handleNormalPasswordChange(event) {
    event.preventDefault();
    const user = auth.currentUser;
    const currentPasswordInput = elements.changePasswordForm.elements.currentPassword;
    const newPasswordInput = elements.changePasswordForm.elements.newPassword;
    const confirmPasswordInput = elements.changePasswordForm.elements.confirmPassword;
    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmation = confirmPasswordInput.value;

    if (!user?.email) {
        setStatus(elements.changePasswordStatus, "Sign in again before changing the password.", "error");
        return;
    }

    const context = captureAuthContext();

    if (!context || context.uid !== user.uid) {
        setStatus(elements.changePasswordStatus, "Sign in again before changing the password.", "error");
        return;
    }

    if (currentPassword === "") {
        setStatus(elements.changePasswordStatus, "Enter the current password.", "error");
        currentPasswordInput.focus();
        return;
    }

    if (newPassword.length < 12 || newPassword.length > 128) {
        setStatus(elements.changePasswordStatus, "Use a new password containing 12–128 characters.", "error");
        newPasswordInput.focus();
        return;
    }

    if (newPassword !== confirmation) {
        setStatus(elements.changePasswordStatus, "The new-password entries do not match.", "error");
        confirmPasswordInput.focus();
        return;
    }

    setFormBusy(elements.changePasswordForm, true);
    setStatus(elements.changePasswordStatus, "Confirming the current password and applying the change…", "loading");

    try {
        const credential = EmailAuthProvider.credential(user.email, currentPassword);
        await reauthenticateWithCredential(user, credential);

        if (!isCurrentAuthContext(context)) return;

        await updatePassword(user, newPassword);

        if (!isCurrentAuthContext(context)) return;

        elements.changePasswordForm.reset();
        setStatus(elements.changePasswordStatus, "Password changed successfully.", "success");
    } catch (error) {
        if (!isCurrentAuthContext(context)) return;
        setStatus(elements.changePasswordStatus, safeErrorMessage(error, "normal-password"), "error");
    } finally {
        if (isCurrentAuthContext(context)) {
            setFormBusy(elements.changePasswordForm, false);
        }
    }
}

async function handleSignOut() {
    elements.signoutButton.disabled = true;
    elements.forcedSignoutButton.disabled = true;

    try {
        signedOutMessage = "Signed out successfully.";
        signedOutMessageState = "success";
        await signOut(auth);
    } catch (error) {
        signedOutMessage = "";
        signedOutMessageState = "success";
        const target = elements.initialPasswordPanel.hidden
            ? elements.dashboardStatus
            : elements.initialPasswordStatus;
        setStatus(target, safeErrorMessage(error, "signout"), "error");
    } finally {
        elements.signoutButton.disabled = false;
        elements.forcedSignoutButton.disabled = false;
    }
}

function readTeamForm(form, includeConfirmation) {
    const members = [...form.querySelectorAll(".member-slot")].map((slot) => ({
        fullName: slot.querySelector('[data-member-field="fullName"]').value,
        email: slot.querySelector('[data-member-field="email"]').value,
        affiliation: slot.querySelector('[data-member-field="affiliation"]').value
    }));
    const primaryContactEmail = includeConfirmation
        ? form.elements.primaryContactEmail.value
        : elements.editPrimaryEmail.value;

    return {
        teamName: form.elements.teamName.value,
        primaryContactEmail,
        tracks: [...form.querySelectorAll('input[name="tracks"]:checked')].map((input) => input.value),
        members,
        submitterIsMember: includeConfirmation ? form.elements.submitterIsMember.checked : true
    };
}

function clearFieldErrors(form) {
    form.querySelectorAll("[data-field-error]").forEach((error) => {
        error.textContent = "";
    });
    form.querySelectorAll('[aria-invalid="true"]').forEach((field) => {
        field.removeAttribute("aria-invalid");
    });
    form.querySelectorAll(".field-container-invalid").forEach((container) => {
        container.classList.remove("field-container-invalid");
    });
}

function showFieldErrors(form, errors) {
    const grouped = new Map();

    errors.forEach(({ field, message }) => {
        if (!grouped.has(field)) grouped.set(field, []);
        if (!grouped.get(field).includes(message)) grouped.get(field).push(message);
    });

    let firstFocusable = null;

    grouped.forEach((messages, field) => {
        const errorElement = [...form.querySelectorAll("[data-field-error]")]
            .find((candidate) => candidate.dataset.fieldError === field);
        const input = [...form.querySelectorAll("[data-field]")]
            .find((candidate) => candidate.dataset.field === field);
        const container = [...form.querySelectorAll("[data-field-container]")]
            .find((candidate) => candidate.dataset.fieldContainer === field);

        if (errorElement) errorElement.textContent = messages.join(" ");
        if (input) input.setAttribute("aria-invalid", "true");
        if (container) {
            container.classList.add("field-container-invalid");
            container.setAttribute("aria-invalid", "true");
        }

        if (!firstFocusable) {
            firstFocusable = input ?? container?.querySelector("input, button") ?? null;
        }
    });

    firstFocusable?.focus();
}

function setFormBusy(form, busy) {
    form.setAttribute("aria-busy", String(busy));
    form.querySelectorAll("button, input").forEach((control) => {
        control.disabled = busy;
    });
    memberEditors
        .filter((editor) => editor.form === form)
        .forEach((editor) => updateMemberEditorState(editor));
}

function setStatus(element, message, state) {
    element.textContent = message;

    if (state) {
        element.dataset.state = state;
    } else {
        delete element.dataset.state;
    }

    element.setAttribute("role", state === "error" ? "alert" : "status");
    element.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
}

function extractTeam(response) {
    if (!isPlainObject(response)) return null;

    const candidate = isPlainObject(response.team) ? response.team : response;
    const teamId = typeof candidate.teamId === "string" ? candidate.teamId : "";
    const teamName = typeof candidate.teamName === "string" ? candidate.teamName : "";
    const primaryContactEmail = typeof candidate.primaryContactEmail === "string"
        ? candidate.primaryContactEmail
        : "";

    if (!teamId || !teamName || !primaryContactEmail || !Array.isArray(candidate.members)) {
        return null;
    }

    return candidate;
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value) {
    return typeof value === "string" && value.trim() ? value : "Not available";
}

function safeStatusValue(value) {
    if (typeof value === "string") return value.trim().toLowerCase();
    if (isPlainObject(value) && typeof value.status === "string") return value.status.trim().toLowerCase();
    return "";
}

function formatDate(value) {
    let date = null;

    if (typeof value === "string" || typeof value === "number") {
        date = new Date(value);
    } else if (isPlainObject(value)) {
        const seconds = value.seconds ?? value._seconds;
        if (typeof seconds === "number") date = new Date(seconds * 1000);
    }

    if (!date || Number.isNaN(date.getTime())) return "Not available";

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
    }).format(date);
}

function errorCode(error) {
    return typeof error?.code === "string" ? error.code : "";
}

function errorDetail(error, key) {
    return isPlainObject(error?.details) && typeof error.details[key] === "string"
        ? error.details[key].toLowerCase()
        : "";
}

function isRevisionConflict(error) {
    const code = errorCode(error);
    const category = errorDetail(error, "category") || errorDetail(error, "reason");
    return code === "functions/aborted" || category.includes("revision");
}

function safeErrorMessage(error, context) {
    const code = errorCode(error);

    if (context === "login") {
        if ([
            "auth/invalid-credential",
            "auth/invalid-login-credentials",
            "auth/user-not-found",
            "auth/wrong-password",
            "auth/invalid-email"
        ].includes(code)) {
            return "The email or password is incorrect.";
        }
        if (code === "auth/too-many-requests") {
            return "Sign-in is temporarily limited after repeated attempts. Wait and try again or reset the password.";
        }
    }

    if (context === "normal-password") {
        if (["auth/invalid-credential", "auth/wrong-password"].includes(code)) {
            return "The current password is incorrect.";
        }
        if (code === "auth/weak-password") {
            return "The new password does not meet the account security requirements.";
        }
        if (code === "auth/requires-recent-login") {
            return "The account must be signed in again before changing the password.";
        }
    }

    if (context === "registration") {
        if (code === "registration/invalid-response") {
            return "The registration service returned an incomplete response. Your form and saved request identifier have been kept; retry with the same details to check the result without creating a duplicate team. If this continues, contact roco-spring-org@googlegroups.com.";
        }
        if (["functions/unauthenticated", "functions/permission-denied"].includes(code)) {
            return "Security verification could not be completed. Refresh the page and try again.";
        }
        if (["functions/already-exists", "functions/failed-precondition"].includes(code)) {
            return "Registration could not be completed. If an account may already exist, use sign in or password reset; otherwise contact the organizers.";
        }
        if (code === "functions/resource-exhausted") {
            return "Registration is temporarily limited. Please wait before trying again.";
        }
        if (code === "functions/invalid-argument") {
            return "The registration was rejected because one or more fields are invalid. Review the form and try again.";
        }
        if (code === "functions/aborted") {
            return "This registration is already being processed. Wait a moment, then retry with the same details; the saved request identifier will prevent a duplicate team.";
        }
        if (["functions/internal", "functions/not-found"].includes(code)) {
            return "The registration service is temporarily unavailable. Try again shortly; repeating the same request will not create a duplicate team. If this continues, contact roco-spring-org@googlegroups.com.";
        }
    }

    if (context === "initial-password") {
        if (code === "functions/invalid-argument") {
            return "The new password must contain 12–128 characters.";
        }
        if (["functions/failed-precondition", "functions/permission-denied"].includes(code)) {
            return "This password-change session is no longer valid. Sign out and sign in again.";
        }
    }

    if (context === "update-team" && code === "functions/invalid-argument") {
        return "The update contains invalid team information. Review every field and try again.";
    }

    if (["functions/unauthenticated", "auth/user-token-expired", "auth/user-disabled"].includes(code)) {
        return "The secure session has ended. Sign in again.";
    }

    if (["functions/permission-denied", "functions/failed-precondition"].includes(code)) {
        return "The account is not permitted to perform this action in its current state.";
    }

    if (["functions/unavailable", "functions/deadline-exceeded", "auth/network-request-failed"].includes(code)) {
        return context === "registration"
            ? "The service could not be reached. Check the connection and try again; a repeated registration request will not create a duplicate team."
            : "The service could not be reached. Check the connection and try again.";
    }

    if (context === "signout") {
        return "Sign-out could not be completed. Refresh the page and try again.";
    }

    return "The request could not be completed safely. Please try again or contact roco-spring-org@googlegroups.com.";
}
