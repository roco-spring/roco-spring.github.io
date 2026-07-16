import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CallableRequest } from "firebase-functions/v2/https";
import { AppError } from "./errors.js";

export interface AuthContext {
  uid: string;
  token: Record<string, unknown>;
}

export function requireAuthentication(
  auth: CallableRequest<unknown>["auth"],
): AuthContext {
  if (!auth) {
    throw new AppError(
      "unauthenticated",
      "Sign in to continue.",
      "authentication",
    );
  }
  return { uid: auth.uid, token: auth.token };
}

export function requireProtectedAuthentication(
  auth: CallableRequest<unknown>["auth"],
): AuthContext {
  const context = requireAuthentication(auth);
  if (context.token.mustChangePassword === true) {
    throw new AppError(
      "failed-precondition",
      "Change the temporary password before continuing.",
      "authorization",
    );
  }
  return context;
}

export function requireInitialPasswordChange(
  auth: CallableRequest<unknown>["auth"],
): AuthContext {
  const context = requireAuthentication(auth);
  if (context.token.mustChangePassword !== true) {
    throw new AppError(
      "failed-precondition",
      "The account does not require an initial password change.",
      "authorization",
    );
  }
  return context;
}

export function normalizeRequestIp(ip: string | undefined): string {
  const normalized = (ip ?? "unknown").trim().toLowerCase();
  if (normalized.startsWith("::ffff:")) return normalized.slice(7);
  return normalized || "unknown";
}

export function hmacIdentifier(secret: string, namespace: string, value: string): string {
  if (secret.length < 32) {
    throw new AppError(
      "internal",
      "Registration is temporarily unavailable.",
      "internal",
    );
  }
  return createHmac("sha256", secret)
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex");
}

export function stableEmailOwnershipId(normalizedEmail: string): string {
  return createHash("sha256").update(normalizedEmail, "utf8").digest("hex");
}

export function safeDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
