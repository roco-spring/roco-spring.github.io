import { randomUUID } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import type { TeamDocument } from "../src/models.js";
import { teamDetailsLiteralRows } from "../src/google-sheets.js";
import {
  parseRegistrationInput,
  parseUpdateTeamInput,
} from "../src/validation.js";

function member(index = 1) {
  return {
    fullName: `Member ${index}`,
    email: `member${index}@example.org`,
    affiliation: `Institute ${index}`,
  };
}

function registration(overrides: Record<string, unknown> = {}): unknown {
  return {
    idempotencyKey: randomUUID(),
    teamName: "Flow Masters",
    primaryContactEmail: "member1@example.org",
    tracks: ["optical-flow"],
    members: [member()],
    registrantConfirmed: true,
    ...overrides,
  };
}

describe("authoritative registration validation", () => {
  it.each(["", "   "])("rejects an empty team name %#", (teamName) => {
    expect(() => parseRegistrationInput(registration({ teamName }))).toThrow();
  });

  it("rejects no selected track", () => {
    expect(() => parseRegistrationInput(registration({ tracks: [] }))).toThrow();
  });

  it("accepts one selected track", () => {
    expect(parseRegistrationInput(registration()).tracks).toEqual(["optical-flow"]);
  });

  it("accepts and canonically orders all four tracks", () => {
    const parsed = parseRegistrationInput(
      registration({
        tracks: ["exploration", "scene-flow", "stereo-matching", "optical-flow"],
      }),
    );
    expect(parsed.tracks).toEqual([
      "optical-flow",
      "stereo-matching",
      "scene-flow",
      "exploration",
    ]);
  });

  it("rejects unknown and duplicate tracks", () => {
    expect(() => parseRegistrationInput(registration({ tracks: ["unknown"] }))).toThrow();
    expect(() =>
      parseRegistrationInput(registration({ tracks: ["optical-flow", "optical-flow"] })),
    ).toThrow();
  });

  it("rejects zero members", () => {
    expect(() => parseRegistrationInput(registration({ members: [] }))).toThrow();
  });

  it("accepts one complete member", () => {
    expect(parseRegistrationInput(registration()).members).toHaveLength(1);
  });

  it("accepts ten complete members", () => {
    const members = Array.from({ length: 10 }, (_, index) => member(index + 1));
    expect(parseRegistrationInput(registration({ members })).members).toHaveLength(10);
  });

  it("rejects eleven members", () => {
    const members = Array.from({ length: 11 }, (_, index) => member(index + 1));
    expect(() => parseRegistrationInput(registration({ members }))).toThrow();
  });

  it("ignores a completely blank optional member row", () => {
    const parsed = parseRegistrationInput(
      registration({ members: [member(), { fullName: "", email: "", affiliation: "" }] }),
    );
    expect(parsed.members).toEqual([member()]);
  });

  it("rejects a partially filled optional member row", () => {
    expect(() =>
      parseRegistrationInput(
        registration({
          members: [member(), { fullName: "Someone", email: "", affiliation: "" }],
        }),
      ),
    ).toThrow();
  });

  it("rejects duplicate member email addresses case-insensitively", () => {
    expect(() =>
      parseRegistrationInput(
        registration({
          members: [member(), { ...member(2), email: "MEMBER1@EXAMPLE.ORG" }],
        }),
      ),
    ).toThrow();
  });

  it("rejects invalid email syntax", () => {
    expect(() =>
      parseRegistrationInput(
        registration({
          primaryContactEmail: "not-an-email",
          members: [{ ...member(), email: "not-an-email" }],
        }),
      ),
    ).toThrow();
  });

  it.each([
    ".owner@example.org",
    "owner.@example.org",
    "owner..person@example.org",
    "owner@-example.org",
    "owner@example-.org",
    "owner@example..org",
    "owner@example",
    "ownér@example.org",
  ])("rejects unsafe or non-conservative email syntax: %s", (email) => {
    expect(() =>
      parseRegistrationInput(
        registration({
          primaryContactEmail: email,
          members: [{ ...member(), email }],
        }),
      ),
    ).toThrow();
  });

  it("rejects a primary contact absent from members", () => {
    expect(() =>
      parseRegistrationInput(registration({ primaryContactEmail: "other@example.org" })),
    ).toThrow();
  });

  it("matches and normalizes primary email case-insensitively", () => {
    const parsed = parseRegistrationInput(
      registration({
        primaryContactEmail: " MEMBER1@EXAMPLE.ORG ",
        members: [{ ...member(), email: "Member1@Example.org" }],
      }),
    );
    expect(parsed.primaryContactEmail).toBe("member1@example.org");
    expect(parsed.members[0]?.email).toBe("member1@example.org");
  });

  it.each([
    { teamName: "Bad\u0000Name" },
    { primaryContactEmail: "member1@example.org\r\nBcc:a@example.org" },
    { primaryContactEmail: "member1@example.org\r\n" },
    { members: [{ ...member(), affiliation: "Bad\u0007Affiliation" }] },
  ])("rejects control characters", (overrides) => {
    expect(() => parseRegistrationInput(registration(overrides))).toThrow();
  });

  it("rejects overlong values", () => {
    expect(() =>
      parseRegistrationInput(registration({ teamName: "x".repeat(121) })),
    ).toThrow();
    expect(() =>
      parseRegistrationInput(
        registration({ members: [{ ...member(), affiliation: "x".repeat(301) }] }),
      ),
    ).toThrow();
  });

  it("requires the registrant confirmation", () => {
    expect(() =>
      parseRegistrationInput(registration({ registrantConfirmed: false })),
    ).toThrow();
  });

  it("rejects client-supplied ownership and immutable fields", () => {
    expect(() => parseRegistrationInput({ ...registration(), ownerUid: "attacker" })).toThrow();
    expect(() =>
      parseUpdateTeamInput({
        expectedRevision: 1,
        teamName: "Updated",
        tracks: ["optical-flow"],
        members: [member()],
        teamId: "RoCo-999",
      }),
    ).toThrow();
  });
});

describe("literal spreadsheet cells", () => {
  it("preserves formula-like user strings as literal values", () => {
    const parsed = parseRegistrationInput(
      registration({
        teamName: "=IMPORTDATA(\"https://example.org\")",
        members: [
          {
            fullName: "+SUM(A1:A2)",
            email: "member1@example.org",
            affiliation: "@unsafe-looking-literal",
          },
        ],
      }),
    );
    const now = Timestamp.now();
    const team: TeamDocument = {
      ...parsed,
      teamId: "RoCo-1",
      teamNumber: 1,
      ownerUid: "uid-1",
      createdAt: now,
      updatedAt: now,
      revision: 1,
      status: "active",
      sheetId: "sheet-1",
      sheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      sheetSyncStatus: "synced",
      sheetLastSyncedRevision: 1,
      sheetSyncLastAttemptAt: now,
      sheetSyncRetryCount: 0,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
      sheetAuditAt: now,
      registrationEmailStatus: "sent",
      registrationEmailLastAttemptAt: null,
      registrationEmailRetryCount: 0,
      registrationEmailLeaseId: null,
      registrationEmailLeaseExpiresAt: null,
      registrationEmailRetryIneligible: false,
      registrationRequestId: "request-1",
    };
    const serialized = JSON.stringify(teamDetailsLiteralRows(team));
    expect(serialized).toContain("=IMPORTDATA");
    expect(serialized).toContain("+SUM");
    expect(serialized).toContain("@unsafe-looking-literal");
  });
});
