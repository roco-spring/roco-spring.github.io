import { randomInt } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";

const COPY_FRIENDLY_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*?";

export function generateTemporaryPassword(length = 24): string {
  if (!Number.isSafeInteger(length) || length < 20 || length > 128) {
    throw new RangeError("Temporary-password length must be between 20 and 128.");
  }
  let password = "";
  for (let index = 0; index < length; index += 1) {
    password += COPY_FRIENDLY_ALPHABET[randomInt(COPY_FRIENDLY_ALPHABET.length)];
  }
  return password;
}

const newPasswordSchema = z
  .string()
  .min(12, "The new password must contain at least 12 characters.")
  .max(128, "The new password may contain at most 128 characters.");

export function parseNewPassword(value: unknown): string {
  const parsed = newPasswordSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "invalid-argument",
      "The new password must contain between 12 and 128 characters.",
      "validation",
    );
  }
  return parsed.data;
}

const initialPasswordChangeSchema = z
  .object({ newPassword: newPasswordSchema })
  .strict();

export function parseInitialPasswordChangeInput(value: unknown): string {
  const parsed = initialPasswordChangeSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      "invalid-argument",
      "The new password must contain between 12 and 128 characters.",
      "validation",
    );
  }
  return parsed.data.newPassword;
}
