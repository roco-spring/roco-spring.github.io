import { google } from "googleapis";
import { describe, expect, it, vi } from "vitest";
import {
  createGoogleApiClientFactory,
  createGoogleApiClients,
} from "../src/google-auth.js";

const scopes = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
];
const accessTokenField = ["access", "token"].join("_");
const refreshTokenField = ["refresh", "token"].join("_");

function jsonResponse(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse({
      [accessTokenField]: "short-lived-access",
      expires_in: 3600,
      scope: scopes.join(" "),
    }));
}

describe("Google OAuth and API transport policy", () => {
  it("uses bounded one-attempt HTTPS exchanges and an access-token-only client", async () => {
    const request = successfulFetch();
    const clients = await createGoogleApiClients(
      "client-secret",
      "refresh-token",
      request,
    );

    expect(request).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenOptions] = request.mock.calls[0] ?? [];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(tokenOptions).toMatchObject({ method: "POST", redirect: "error" });
    expect(tokenOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(tokenOptions?.body).toBeInstanceOf(URLSearchParams);
    expect((tokenOptions?.body as URLSearchParams).get("grant_type")).toBe(
      "refresh_token",
    );

    expect(clients.oauthScopes).toEqual(scopes);
    expect(Reflect.get(clients.auth.credentials, accessTokenField)).toBe(
      "short-lived-access",
    );
    expect(
      Reflect.get(clients.auth.credentials, refreshTokenField),
    ).toBeUndefined();
    expect(google._options).toMatchObject({ timeout: 8_000, retry: false });
  });

  it("never exposes provider details or OAuth material on a failed refresh", async () => {
    const sensitive = "refresh-token-never-log";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: "invalid_grant", error_description: `expired ${sensitive}` },
          400,
        ),
      );

    try {
      await createGoogleApiClients(
        "client-secret-never-log",
        sensitive,
        request,
      );
      throw new Error("Expected the OAuth exchange to fail.");
    } catch (error: unknown) {
      expect(error).toMatchObject({ category: "google_configuration" });
      expect(String(error)).not.toContain(sensitive);
      expect(String(error)).not.toContain("client-secret-never-log");
      expect(String(error)).not.toContain("expired");
    }
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("caches one bounded credential exchange per Function invocation", async () => {
    const request = successfulFetch();
    const getGoogle = createGoogleApiClientFactory(
      "client-secret",
      "refresh-token",
      request,
    );

    // Constructing the per-invocation factory is side-effect free. registerTeam
    // can persist its authoritative Auth/Firestore core before requesting OAuth.
    expect(request).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([getGoogle(), getGoogle()]);
    expect(first).toBe(second);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, broadened, or short-lived credentials", async () => {
    for (const tokenInfo of [
      { scope: scopes[0] },
      { scope: `${scopes.join(" ")} https://www.googleapis.com/auth/drive` },
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            [accessTokenField]: "short-lived-access",
            expires_in: 3600,
            ...tokenInfo,
          }),
        );
      await expect(
        createGoogleApiClients("client-secret", "refresh-token", request),
      ).rejects.toMatchObject({ category: "google_configuration" });
    }

    const shortLifetime = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({
          [accessTokenField]: "short-lived-access",
          expires_in: 60,
          scope: scopes.join(" "),
        }),
      );
    await expect(
      createGoogleApiClients(
        "client-secret",
        "refresh-token",
        shortLifetime,
      ),
    ).rejects.toMatchObject({ category: "google_configuration" });
    expect(shortLifetime).toHaveBeenCalledTimes(1);
  });
});
