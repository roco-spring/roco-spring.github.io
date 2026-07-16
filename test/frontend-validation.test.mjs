import assert from "node:assert/strict";
import test from "node:test";
import { TRACKS, validateTeamInput } from "../assets/team-validation.js";

const baseMember = Object.freeze({
    fullName: "Ada Lovelace",
    email: "ada@example.org",
    affiliation: "Analytical Engine Institute"
});

function validInput(overrides = {}) {
    return {
        teamName: "Flow Masters",
        primaryContactEmail: "ada@example.org",
        tracks: ["optical-flow"],
        members: [{ ...baseMember }],
        submitterIsMember: true,
        ...overrides
    };
}

function validate(input) {
    return validateTeamInput(input, { requireSubmitterConfirmation: true });
}

test("empty team name is rejected", () => {
    assert.equal(validate(validInput({ teamName: "" })).success, false);
});

test("whitespace-only team name is rejected", () => {
    assert.equal(validate(validInput({ teamName: "   " })).success, false);
});

test("no selected track is rejected", () => {
    assert.equal(validate(validInput({ tracks: [] })).success, false);
});

test("one selected track is accepted", () => {
    assert.equal(validate(validInput({ tracks: ["optical-flow"] })).success, true);
});

test("all four tracks are accepted", () => {
    assert.equal(validate(validInput({ tracks: TRACKS.map(({ id }) => id) })).success, true);
});

test("unknown track is rejected", () => {
    assert.equal(validate(validInput({ tracks: ["unknown-track"] })).success, false);
});

test("zero members is rejected", () => {
    assert.equal(validate(validInput({ members: [] })).success, false);
});

test("one complete member is accepted", () => {
    assert.equal(validate(validInput()).success, true);
});

test("ten complete members are accepted", () => {
    const members = Array.from({ length: 10 }, (_, index) => ({
        fullName: `Member ${index + 1}`,
        email: index === 0 ? "ada@example.org" : `member${index + 1}@example.org`,
        affiliation: `Institute ${index + 1}`
    }));
    assert.equal(validate(validInput({ members })).success, true);
});

test("eleven members are rejected", () => {
    const members = Array.from({ length: 11 }, (_, index) => ({
        fullName: `Member ${index + 1}`,
        email: index === 0 ? "ada@example.org" : `member${index + 1}@example.org`,
        affiliation: `Institute ${index + 1}`
    }));
    assert.equal(validate(validInput({ members })).success, false);
});

test("a completely blank optional row is ignored", () => {
    const result = validate(validInput({
        members: [{ ...baseMember }, { fullName: "", email: "", affiliation: "" }]
    }));
    assert.equal(result.success, true);
    assert.equal(result.data.members.length, 1);
});

test("a partially filled optional row is rejected", () => {
    const result = validate(validInput({
        members: [{ ...baseMember }, { fullName: "Grace Hopper", email: "", affiliation: "Navy" }]
    }));
    assert.equal(result.success, false);
});

test("duplicate member emails are rejected", () => {
    const result = validate(validInput({
        members: [
            { ...baseMember },
            { fullName: "Another Ada", email: "ada@example.org", affiliation: "Institute" }
        ]
    }));
    assert.equal(result.success, false);
});

test("case-different duplicate member emails are rejected", () => {
    const result = validate(validInput({
        members: [
            { ...baseMember },
            { fullName: "Another Ada", email: "ADA@EXAMPLE.ORG", affiliation: "Institute" }
        ]
    }));
    assert.equal(result.success, false);
});

test("invalid email syntax is rejected", () => {
    const result = validate(validInput({
        primaryContactEmail: "not-an-email",
        members: [{ ...baseMember, email: "not-an-email" }]
    }));
    assert.equal(result.success, false);
});

for (const email of [
    ".owner@example.org",
    "owner.@example.org",
    "owner..person@example.org",
    "owner@-example.org",
    "owner@example-.org",
    "owner@example..org",
    "owner@example",
    "ownér@example.org"
]) {
    test(`conservative email syntax rejects ${email}`, () => {
        const result = validate(validInput({
            primaryContactEmail: email,
            members: [{ ...baseMember, email }]
        }));
        assert.equal(result.success, false);
    });
}

test("primary contact absent from members is rejected", () => {
    assert.equal(validate(validInput({ primaryContactEmail: "other@example.org" })).success, false);
});

test("primary contact matching is case-insensitive", () => {
    const result = validate(validInput({ primaryContactEmail: " ADA@EXAMPLE.ORG " }));
    assert.equal(result.success, true);
    assert.equal(result.data.primaryContactEmail, "ada@example.org");
});

test("control characters are rejected", () => {
    assert.equal(validate(validInput({ teamName: "Flow\nMasters" })).success, false);
    assert.equal(validate(validInput({
        primaryContactEmail: "ada@example.org\r\nBcc:other@example.org",
        members: [{ ...baseMember, email: "ada@example.org\r\nBcc:other@example.org" }]
    })).success, false);
});

test("overlong values are rejected", () => {
    assert.equal(validate(validInput({ teamName: "x".repeat(121) })).success, false);
});

test("formula-like member values remain literal strings", () => {
    const result = validate(validInput({
        members: [{ ...baseMember, fullName: "=HYPERLINK(\"https://invalid.example\")" }]
    }));
    assert.equal(result.success, true);
    assert.equal(result.data.members[0].fullName, "=HYPERLINK(\"https://invalid.example\")");
});

test("registrant confirmation is mandatory", () => {
    assert.equal(validate(validInput({ submitterIsMember: false })).success, false);
});
