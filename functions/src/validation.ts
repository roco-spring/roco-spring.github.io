import { createHash } from "node:crypto";
import { z } from "zod";
import { TRACKS } from "./config.js";
import { AppError } from "./errors.js";
import type {
  EditableTeamData,
  RegistrationInput,
  TeamMember,
  UpdateTeamInput,
} from "./models.js";

const CONTROL_CHARACTERS = /\p{Cc}/u;

// Conservative ASCII mailbox syntax for identical client/server validation.
// It excludes empty dot-atoms and domain labels with leading/trailing hyphens.
export const EMAIL_PATTERN = /^(?=.{1,254}$)(?=.{1,64}@)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function cleanBoundedString(max: number, fieldName: string) {
  return z
    .string()
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: `${fieldName} contains a control character.`,
    })
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, `${fieldName} is required.`)
        .max(max, `${fieldName} is too long.`),
    );
}

const emailSchema = z
  .string()
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: "Email address contains a control character.",
  })
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .max(254, "Email address is too long.")
      .refine((value) => EMAIL_PATTERN.test(value), {
        message: "Enter a valid email address.",
      }),
  );

function optionalMemberString(max: number) {
  return z
    .string()
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: "Team-member details contain a control character.",
    })
    .transform((value) => value.trim())
    .pipe(z.string().max(max));
}

const memberInputSchema = z
  .object({
    fullName: optionalMemberString(120),
    email: optionalMemberString(254),
    affiliation: optionalMemberString(300),
  })
  .strict()
  .superRefine((member, context) => {
    const populated = [member.fullName, member.email, member.affiliation].filter(
      (value) => value.length > 0,
    ).length;
    if (populated !== 0 && populated !== 3) {
      context.addIssue({
        code: "custom",
        message: "Each team member must have a name, email, and affiliation.",
      });
    }
  });

const completeMemberSchema = z
  .object({
    fullName: cleanBoundedString(120, "Full name"),
    email: emailSchema,
    affiliation: cleanBoundedString(300, "Affiliation"),
  })
  .strict();

const tracksSchema = z
  .array(z.enum(TRACKS))
  .min(1, "Select at least one competition track.")
  .max(4)
  .refine((tracks) => new Set(tracks).size === tracks.length, {
    message: "Competition tracks must be unique.",
  })
  .transform((tracks) => TRACKS.filter((track) => tracks.includes(track)));

const membersSchema = z
  .array(memberInputSchema)
  .transform((members) =>
    members.filter(
      (member) =>
        member.fullName.length > 0 ||
        member.email.length > 0 ||
        member.affiliation.length > 0,
    ),
  )
  .pipe(z.array(completeMemberSchema).min(1, "Add at least one team member."))
  .superRefine((members, context) => {
    const seen = new Set<string>();
    members.forEach((member, index) => {
      if (seen.has(member.email)) {
        context.addIssue({
          code: "custom",
          path: [index, "email"],
          message: "Team-member email addresses must be unique.",
        });
      }
      seen.add(member.email);
    });
  });

const editableFields = {
  teamName: cleanBoundedString(120, "Team name"),
  tracks: tracksSchema,
  members: membersSchema,
} as const;

export const registrationSchema = z
  .object({
    idempotencyKey: z.uuid("A valid idempotency key is required."),
    primaryContactEmail: emailSchema,
    registrantConfirmed: z.literal(true, {
      error: "The team-member confirmation is required.",
    }),
    ...editableFields,
  })
  .strict()
  .superRefine((registration, context) => {
    if (
      !registration.members.some(
        (member) => member.email === registration.primaryContactEmail,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["primaryContactEmail"],
        message: "The primary contact must be one of the team members.",
      });
    }
  });

export const updateTeamSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    ...editableFields,
  })
  .strict();

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "invalid-argument",
      "The submitted team details are invalid.",
      "validation",
    );
  }
  return parsed.data;
}

export function parseRegistrationInput(value: unknown): RegistrationInput {
  return parseOrThrow(registrationSchema, value);
}

export function parseUpdateTeamInput(value: unknown): UpdateTeamInput {
  return parseOrThrow(updateTeamSchema, value);
}

export function assertPrimaryMember(
  primaryContactEmail: string,
  members: TeamMember[],
): void {
  if (!members.some((member) => member.email === primaryContactEmail)) {
    throw new AppError(
      "invalid-argument",
      "The primary contact must remain one of the team members.",
      "validation",
    );
  }
}

export function canonicalRegistrationHash(input: RegistrationInput): string {
  const canonical = {
    teamName: input.teamName,
    primaryContactEmail: input.primaryContactEmail,
    tracks: input.tracks,
    members: input.members,
    registrantConfirmed: input.registrantConfirmed,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function editableData(input: UpdateTeamInput): EditableTeamData {
  return {
    teamName: input.teamName,
    tracks: input.tracks,
    members: input.members,
  };
}
