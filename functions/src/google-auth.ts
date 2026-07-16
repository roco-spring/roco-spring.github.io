import { google } from "googleapis";
import { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_REDIRECT_URI } from "./config.js";

export function createGoogleOAuthClient(
  clientSecret: string,
  refreshToken: string,
) {
  if (!clientSecret || !refreshToken) {
    throw new Error("Google OAuth secrets are unavailable.");
  }
  const auth = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    clientSecret,
    GOOGLE_OAUTH_REDIRECT_URI,
  );
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export function createGoogleApiClients(
  clientSecret: string,
  refreshToken: string,
) {
  // Bound every individual Google request so one team cannot consume a whole
  // function invocation. Retries remain separately bounded and idempotency-aware.
  google.options({ timeout: 20_000 });
  const auth = createGoogleOAuthClient(clientSecret, refreshToken);
  return {
    auth,
    drive: google.drive({ version: "v3", auth }),
    sheets: google.sheets({ version: "v4", auth }),
    gmail: google.gmail({ version: "v1", auth }),
  };
}

export type GoogleApiClients = ReturnType<typeof createGoogleApiClients>;
