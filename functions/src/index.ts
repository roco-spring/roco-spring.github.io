import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {
  assertLiveAccountMatchesTeam,
  completeInitialPasswordChangeOperation,
} from "./auth.js";
import { REGION } from "./config.js";
import { AppError, safeErrorCategory, toHttpsError } from "./errors.js";
import { createGoogleApiClientFactory } from "./google-auth.js";
import { parseInitialPasswordChangeInput } from "./password.js";
import { reconcileRegistrationsOperation } from "./reconciliation.js";
import { registerTeamOperation } from "./registration.js";
import {
  requireInitialPasswordChange,
  requireProtectedAuthentication,
} from "./security.js";
import {
  googleOAuthClientSecret,
  googleOAuthRefreshToken,
  rateLimitHmacSecret,
} from "./secrets.js";
import { getMyTeamOperation, updateMyTeamOperation } from "./teams.js";
import {
  getOwnedTeam,
  makeRegistrationEmailRetryIneligible,
} from "./team-repository.js";
import {
  parseRegistrationInput,
  parseUpdateTeamInput,
} from "./validation.js";

if (getApps().length === 0) initializeApp();

const db = getFirestore();
const adminAuth = getAuth();
const callableCors = [
  /^https:\/\/roco-spring\.github\.io$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];

export const registerTeam = onCall(
  {
    region: REGION,
    enforceAppCheck: true,
    cors: callableCors,
    timeoutSeconds: 60,
    memory: "512MiB",
    maxInstances: 10,
    secrets: [rateLimitHmacSecret],
  },
  async (request) => {
    try {
      const input = parseRegistrationInput(request.data);
      return await registerTeamOperation(
        {
          db,
          adminAuth,
          rateLimitHmacSecret: rateLimitHmacSecret.value(),
        },
        input,
        request.rawRequest.ip,
      );
    } catch (error: unknown) {
      logger.warn("registerTeam request rejected", {
        operation: "registerTeam",
        errorCategory: safeErrorCategory(error),
      });
      throw toHttpsError(error);
    }
  },
);

export const getMyTeam = onCall(
  {
    region: REGION,
    enforceAppCheck: true,
    cors: callableCors,
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      if (
        typeof request.data !== "object" ||
        request.data === null ||
        Object.keys(request.data as object).length !== 0
      ) {
        throw new AppError(
          "invalid-argument",
          "getMyTeam does not accept team identifiers or other data.",
          "validation",
        );
      }
      const context = requireProtectedAuthentication(request.auth);
      return await getMyTeamOperation(db, adminAuth, context.uid);
    } catch (error: unknown) {
      logger.warn("getMyTeam request rejected", {
        operation: "getMyTeam",
        errorCategory: safeErrorCategory(error),
      });
      throw toHttpsError(error);
    }
  },
);

export const updateMyTeam = onCall(
  {
    region: REGION,
    enforceAppCheck: true,
    cors: callableCors,
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (request) => {
    try {
      const context = requireProtectedAuthentication(request.auth);
      const input = parseUpdateTeamInput(request.data);
      return await updateMyTeamOperation(
        db,
        adminAuth,
        context.uid,
        input,
      );
    } catch (error: unknown) {
      logger.warn("updateMyTeam request rejected", {
        operation: "updateMyTeam",
        errorCategory: safeErrorCategory(error),
      });
      throw toHttpsError(error);
    }
  },
);

export const completeInitialPasswordChange = onCall(
  {
    region: REGION,
    enforceAppCheck: true,
    cors: callableCors,
    timeoutSeconds: 30,
  },
  async (request) => {
    try {
      const context = requireInitialPasswordChange(request.auth);
      const newPassword = parseInitialPasswordChangeInput(request.data);
      const team = await getOwnedTeam(db, context.uid);
      await assertLiveAccountMatchesTeam(adminAuth, context.uid, team);
      await makeRegistrationEmailRetryIneligible(db, context.uid);
      return await completeInitialPasswordChangeOperation(
        adminAuth,
        context,
        newPassword,
        team.primaryContactEmail,
      );
    } catch (error: unknown) {
      logger.warn("Initial password change rejected", {
        operation: "completeInitialPasswordChange",
        errorCategory: safeErrorCategory(error),
      });
      throw toHttpsError(error);
    }
  },
);

export const reconcileRegistrations = onSchedule(
  {
    region: REGION,
    schedule: "every 5 minutes",
    timeZone: "Europe/Berlin",
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 1,
    secrets: [googleOAuthClientSecret, googleOAuthRefreshToken],
  },
  async () => {
    const google = createGoogleApiClientFactory(
      googleOAuthClientSecret.value(),
      googleOAuthRefreshToken.value(),
    );
    await reconcileRegistrationsOperation(db, adminAuth, google);
  },
);
