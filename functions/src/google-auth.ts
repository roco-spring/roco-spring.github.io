import { google } from "googleapis";
import { GOOGLE_OAUTH_CLIENT_ID } from "./config.js";
import { AppError } from "./errors.js";
import {
  GOOGLE_API_REQUEST_OPTIONS,
  GOOGLE_API_REQUEST_TIMEOUT_MS,
} from "./google-retry.js";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MINIMUM_ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;
const REQUIRED_OAUTH_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
]);

type FetchImplementation = typeof globalThis.fetch;

interface OAuthJsonResponse {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

function oauthFailure(status?: number): AppError {
  const transient =
    status === undefined || status === 408 || status === 429 || status >= 500;
  return new AppError(
    transient ? "unavailable" : "internal",
    transient
      ? "Google OAuth is temporarily unavailable."
      : "Google OAuth credentials are not valid for registration.",
    transient ? "google_transient" : "google_configuration",
  );
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

async function requestOAuthJson(
  url: string,
  options: RequestInit,
  fetchImplementation: FetchImplementation,
): Promise<OAuthJsonResponse> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(GOOGLE_API_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw oauthFailure();
  }

  let data: OAuthJsonResponse = {};
  try {
    data = (await response.json()) as OAuthJsonResponse;
  } catch {
    // Provider response bodies are deliberately never copied into application
    // errors because they may contain credential diagnostics.
  }
  if (!response.ok) throw oauthFailure(response.status);
  return data;
}

function exactScopes(value: unknown): readonly string[] {
  const scopes =
    typeof value === "string" ? value.split(/\s+/u).filter(Boolean) : [];
  const granted = new Set(scopes);
  if (
    granted.size !== REQUIRED_OAUTH_SCOPES.length ||
    REQUIRED_OAUTH_SCOPES.some((scope) => !granted.has(scope))
  ) {
    throw new AppError(
      "internal",
      "Google OAuth scopes do not match the approved registration scopes.",
      "google_configuration",
    );
  }
  return Object.freeze([...granted]);
}

async function obtainBoundedAccessToken(
  clientSecret: string,
  refreshToken: string,
  fetchImplementation: FetchImplementation,
): Promise<{
  accessToken: string;
  expiryDate: number;
  scopes: readonly string[];
}> {
  if (!clientSecret || !refreshToken) {
    throw new AppError(
      "internal",
      "Google OAuth secrets are unavailable.",
      "google_configuration",
    );
  }

  const token = await requestOAuthJson(
    GOOGLE_OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    },
    fetchImplementation,
  );
  const accessToken =
    typeof token.access_token === "string" ? token.access_token : "";
  const expiresIn = Number(token.expires_in);
  if (
    accessToken.length === 0 ||
    hasUnsafeControlCharacter(accessToken) ||
    !Number.isFinite(expiresIn) ||
    expiresIn < MINIMUM_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new AppError(
      "internal",
      "Google OAuth returned an unusable access token.",
      "google_configuration",
    );
  }

  return {
    accessToken,
    expiryDate: Date.now() + expiresIn * 1_000,
    scopes: exactScopes(token.scope),
  };
}

export async function createGoogleApiClients(
  clientSecret: string,
  refreshToken: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
) {
  // Generated API requests are each bounded and never receive a refresh token.
  // OAuth exchange and scope inspection above are also single-attempt and
  // independently bounded, so google-auth-library cannot introduce hidden
  // credential retries before an API request.
  google.options(GOOGLE_API_REQUEST_OPTIONS);
  const credentials = await obtainBoundedAccessToken(
    clientSecret,
    refreshToken,
    fetchImplementation,
  );
  const auth = new google.auth.OAuth2();
  auth.setCredentials({
    access_token: credentials.accessToken,
    expiry_date: credentials.expiryDate,
  });
  return {
    auth,
    oauthScopes: credentials.scopes,
    drive: google.drive({ version: "v3", auth }),
    sheets: google.sheets({ version: "v4", auth }),
    gmail: google.gmail({ version: "v1", auth }),
  };
}

export type GoogleApiClients = Awaited<
  ReturnType<typeof createGoogleApiClients>
>;
export type GoogleApiClientFactory = () => Promise<GoogleApiClients>;

export function createGoogleApiClientFactory(
  clientSecret: string,
  refreshToken: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): GoogleApiClientFactory {
  let clients: Promise<GoogleApiClients> | undefined;
  return () => {
    clients ??= createGoogleApiClients(
      clientSecret,
      refreshToken,
      fetchImplementation,
    );
    return clients;
  };
}
