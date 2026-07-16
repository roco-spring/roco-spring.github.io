import {
  EMAIL_REPLY_TO,
  EMAIL_SENDER,
  SIGN_IN_URL,
  TRACK_LABELS,
} from "./config.js";
import type { TeamDocument } from "./models.js";

export interface RegistrationEmailContent {
  subject: string;
  text: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function registrationEmailContent(
  team: TeamDocument,
  temporaryPassword: string,
): RegistrationEmailContent {
  const trackLabels = team.tracks.map((track) => TRACK_LABELS[track]);
  const textMembers = team.members
    .map(
      (member, index) =>
        `${index + 1}. ${member.fullName} — ${member.email} — ${member.affiliation}`,
    )
    .join("\n");
  const text = [
    "Your RoCo-Spring team registration has been completed successfully.",
    "",
    `Team ID: ${team.teamId}`,
    `Team name: ${team.teamName}`,
    `Tracks: ${trackLabels.join(", ")}`,
    "",
    "Registered members:",
    textMembers,
    "",
    `Login email: ${team.primaryContactEmail}`,
    `Temporary password: ${temporaryPassword}`,
    "",
    "For security, you will be required to choose a new password immediately after your first sign-in.",
    `Sign in: ${SIGN_IN_URL}`,
    "",
    `Questions? Contact ${EMAIL_REPLY_TO}`,
  ].join("\n");

  const memberItems = team.members
    .map(
      (member) =>
        `<li><strong>${escapeHtml(member.fullName)}</strong><br>${escapeHtml(member.email)}<br>${escapeHtml(member.affiliation)}</li>`,
    )
    .join("");
  const html = [
    "<!doctype html><html><body>",
    "<p>Your RoCo-Spring team registration has been completed successfully.</p>",
    `<p><strong>Team ID:</strong> ${escapeHtml(team.teamId)}<br>`,
    `<strong>Team name:</strong> ${escapeHtml(team.teamName)}<br>`,
    `<strong>Tracks:</strong> ${trackLabels.map(escapeHtml).join(", ")}</p>`,
    `<p><strong>Registered members:</strong></p><ol>${memberItems}</ol>`,
    `<p><strong>Login email:</strong> ${escapeHtml(team.primaryContactEmail)}<br>`,
    `<strong>Temporary password:</strong> <code>${escapeHtml(temporaryPassword)}</code></p>`,
    "<p>For security, you will be required to choose a new password immediately after your first sign-in.</p>",
    `<p><a href="${escapeHtml(SIGN_IN_URL)}">Sign in to your team account</a></p>`,
    `<p>Questions? Contact <a href="mailto:${EMAIL_REPLY_TO}">${EMAIL_REPLY_TO}</a>.</p>`,
    "</body></html>",
  ].join("");

  return {
    subject: `RoCo-Spring team registration confirmed - ${team.teamId}`,
    text,
    html,
  };
}

export const REGISTRATION_EMAIL_FROM = EMAIL_SENDER;
