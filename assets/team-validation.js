const TRACKS = Object.freeze([
    Object.freeze({ id: "optical-flow", label: "Optical Flow" }),
    Object.freeze({ id: "stereo-matching", label: "Stereo Matching" }),
    Object.freeze({ id: "scene-flow", label: "Scene Flow" }),
    Object.freeze({ id: "exploration", label: "Exploration Track" })
]);

const ALLOWED_TRACK_IDS = new Set(TRACKS.map((track) => track.id));
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
// Keep this byte-for-byte equivalent to functions/src/validation.ts. It accepts
// practical ASCII dot-atom addresses and rejects ambiguous dots/domain labels.
const EMAIL_PATTERN = /^(?=.{1,254}$)(?=.{1,64}@)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function normalizeEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(value) {
    const normalized = normalizeEmail(value);
    return normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
}

function isBlank(value) {
    return typeof value !== "string" || value.trim() === "";
}

function validateText(value, field, label, maximum, errors) {
    if (typeof value !== "string" || value.trim() === "") {
        errors.push({ field, message: `${label} is required.` });
        return "";
    }

    const normalized = value.trim();

    if (normalized.length > maximum) {
        errors.push({ field, message: `${label} must be ${maximum} characters or fewer.` });
    }

    // Inspect the raw value so trim cannot hide CR/LF or other control characters.
    if (CONTROL_CHARACTERS.test(value)) {
        errors.push({ field, message: `${label} contains an unsupported control character.` });
    }

    return normalized;
}

function validateEmail(value, field, label, errors) {
    const normalized = validateText(value, field, label, 254, errors).toLowerCase();

    if (normalized && !isValidEmail(normalized)) {
        errors.push({ field, message: `Enter a valid ${label.toLowerCase()}.` });
    }

    return normalized;
}

/**
 * Validate and normalize a complete registration or edit payload.
 * Blank optional member rows are ignored; a partially completed row is rejected.
 */
function validateTeamInput(input, { requireSubmitterConfirmation = false } = {}) {
    const errors = [];
    const teamName = validateText(input?.teamName, "teamName", "Team name", 120, errors);
    const primaryContactEmail = validateEmail(
        input?.primaryContactEmail,
        "primaryContactEmail",
        "Primary contact email",
        errors
    );
    const tracks = Array.isArray(input?.tracks) ? input.tracks : [];
    const uniqueTracks = [...new Set(tracks)];

    if (tracks.length < 1) {
        errors.push({ field: "tracks", message: "Select at least one competition track." });
    } else if (tracks.length > TRACKS.length) {
        errors.push({ field: "tracks", message: "Select no more than four competition tracks." });
    }

    if (uniqueTracks.length !== tracks.length) {
        errors.push({ field: "tracks", message: "Each competition track may be selected only once." });
    }

    if (uniqueTracks.some((track) => !ALLOWED_TRACK_IDS.has(track))) {
        errors.push({ field: "tracks", message: "A selected competition track is not recognized." });
    }

    const rawMembers = Array.isArray(input?.members) ? input.members : [];

    const members = [];
    const seenEmails = new Map();

    rawMembers.forEach((member, index) => {
        const fullNameValue = typeof member?.fullName === "string" ? member.fullName : "";
        const emailValue = typeof member?.email === "string" ? member.email : "";
        const affiliationValue = typeof member?.affiliation === "string" ? member.affiliation : "";
        const values = [fullNameValue, emailValue, affiliationValue];
        const filledCount = values.filter((value) => !isBlank(value)).length;
        const rowPrefix = `members.${index}`;

        if (filledCount === 0 && index > 0) {
            return;
        }

        if (filledCount !== 3) {
            if (isBlank(fullNameValue)) {
                errors.push({ field: `${rowPrefix}.fullName`, message: "Full name is required for this member." });
            }
            if (isBlank(emailValue)) {
                errors.push({ field: `${rowPrefix}.email`, message: "Email address is required for this member." });
            }
            if (isBlank(affiliationValue)) {
                errors.push({ field: `${rowPrefix}.affiliation`, message: "Affiliation is required for this member." });
            }
        }

        const fullName = !isBlank(fullNameValue)
            ? validateText(fullNameValue, `${rowPrefix}.fullName`, "Full name", 120, errors)
            : "";
        const email = !isBlank(emailValue)
            ? validateEmail(emailValue, `${rowPrefix}.email`, "Email address", errors)
            : "";
        const affiliation = !isBlank(affiliationValue)
            ? validateText(affiliationValue, `${rowPrefix}.affiliation`, "Affiliation", 300, errors)
            : "";

        if (email) {
            if (seenEmails.has(email)) {
                errors.push({
                    field: `${rowPrefix}.email`,
                    message: `This email duplicates team member ${seenEmails.get(email) + 1}.`
                });
            } else {
                seenEmails.set(email, index);
            }
        }

        if (filledCount === 3) {
            members.push({ fullName, email, affiliation });
        }
    });

    if (members.length < 1) {
        errors.push({ field: "members", message: "Add at least one complete team member." });
    }

    if (primaryContactEmail && !members.some((member) => member.email === primaryContactEmail)) {
        errors.push({
            field: "primaryContactEmail",
            message: "The primary contact email must match one listed team-member email."
        });
    }

    if (requireSubmitterConfirmation && input?.submitterIsMember !== true) {
        errors.push({
            field: "submitterIsMember",
            message: "Confirm that the person submitting is a listed team member."
        });
    }

    return {
        success: errors.length === 0,
        errors,
        data: {
            teamName,
            primaryContactEmail,
            tracks: uniqueTracks.filter((track) => ALLOWED_TRACK_IDS.has(track)),
            members
        }
    };
}

export { EMAIL_PATTERN, TRACKS, isValidEmail, normalizeEmail, validateTeamInput };
