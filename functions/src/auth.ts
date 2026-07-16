import type { Auth } from "firebase-admin/auth";
import { AppError } from "./errors.js";
import type { TeamDocument } from "./models.js";
import type { AuthContext } from "./security.js";

export async function completeInitialPasswordChangeOperation(
  adminAuth: Auth,
  context: AuthContext,
  newPassword: string,
  expectedPrimaryEmail?: string,
): Promise<{ success: true }> {
  const user = await adminAuth.getUser(context.uid);
  if (
    expectedPrimaryEmail !== undefined &&
    (user.disabled || user.email?.toLowerCase() !== expectedPrimaryEmail)
  ) {
    throw new AppError(
      "permission-denied",
      "The account email no longer matches the registered team.",
      "authorization",
    );
  }
  if (user.customClaims?.mustChangePassword !== true) {
    throw new AppError(
      "failed-precondition",
      "The account does not require an initial password change.",
      "authorization",
    );
  }

  await adminAuth.updateUser(context.uid, { password: newPassword });
  await adminAuth.revokeRefreshTokens(context.uid);
  await adminAuth.setCustomUserClaims(context.uid, {
    ...(user.customClaims ?? {}),
    mustChangePassword: false,
  });
  return { success: true };
}

export async function assertLiveAccountMatchesTeam(
  adminAuth: Auth,
  uid: string,
  team: TeamDocument,
): Promise<void> {
  const user = await adminAuth.getUser(uid);
  if (
    user.disabled ||
    user.email?.trim().toLowerCase() !== team.primaryContactEmail
  ) {
    throw new AppError(
      "permission-denied",
      "The account email no longer matches the registered team.",
      "authorization",
    );
  }
}

export async function ensureEmailIsAvailable(
  adminAuth: Auth,
  email: string,
): Promise<void> {
  try {
    await adminAuth.getUserByEmail(email);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "auth/user-not-found"
    ) {
      return;
    }
    throw error;
  }
  throw new AppError(
    "already-exists",
    "An account already exists for this email address.",
    "conflict",
  );
}
