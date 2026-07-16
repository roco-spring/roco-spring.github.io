import { randomBytes } from "node:crypto";
import type { gmail_v1 } from "googleapis";
import { EMAIL_REPLY_TO, EMAIL_SENDER } from "./config.js";
import { AppError } from "./errors.js";
import { registrationEmailContent } from "./email-templates.js";
import type { TeamDocument } from "./models.js";

function assertSafeHeader(value: string): void {
  if (/\r|\n|\p{Cc}/u.test(value)) {
    throw new AppError("invalid-argument", "An email header is invalid.", "validation");
  }
}

function base64MimePart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export function buildRegistrationMimeMessage(
  team: TeamDocument,
  temporaryPassword: string,
  boundary = `roco_${randomBytes(18).toString("hex")}`,
): string {
  const content = registrationEmailContent(team, temporaryPassword);
  for (const header of [
    EMAIL_SENDER,
    EMAIL_REPLY_TO,
    team.primaryContactEmail,
    content.subject,
    boundary,
  ]) {
    assertSafeHeader(header);
  }
  return [
    `From: RoCo-Spring <${EMAIL_SENDER}>`,
    `To: ${team.primaryContactEmail}`,
    `Reply-To: ${EMAIL_REPLY_TO}`,
    `Subject: ${content.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64MimePart(content.text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64MimePart(content.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export async function sendRegistrationEmail(
  gmail: gmail_v1.Gmail,
  team: TeamDocument,
  temporaryPassword: string,
): Promise<void> {
  const mime = buildRegistrationMimeMessage(team, temporaryPassword);
  const raw = Buffer.from(mime, "utf8").toString("base64url");
  // Gmail send is non-idempotent. An ambiguous response is recorded as pending;
  // the controlled reconciler rotates the temporary password before one retry.
  await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
}
