import type { Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type { CallableRequest } from "firebase-functions/v2/https";
import { describe, expect, it, vi } from "vitest";
import { completeInitialPasswordChangeOperation } from "../src/auth.js";
import {
  generateTemporaryPassword,
  parseInitialPasswordChangeInput,
} from "../src/password.js";
import {
  hmacIdentifier,
  normalizeRequestIp,
  requireInitialPasswordChange,
  requireProtectedAuthentication,
} from "../src/security.js";
import { getOwnedTeam } from "../src/team-repository.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

type CallableAuth = CallableRequest<unknown>["auth"];

function callableAuth(uid: string, mustChangePassword: boolean): CallableAuth {
  return {
    uid,
    token: { uid, mustChangePassword, aud: "test", auth_time: 1, exp: 2, iat: 1, iss: "test", sub: uid, firebase: { identities: {}, sign_in_provider: "password" } },
  } as unknown as CallableAuth;
}

describe("protected authentication", () => {
  it("rejects unauthenticated users", () => {
    expect(() => requireProtectedAuthentication(undefined)).toThrowError(
      expect.objectContaining({ code: "unauthenticated" }),
    );
  });

  it("blocks get/update authorization while the temporary password claim is true", () => {
    expect(() => requireProtectedAuthentication(callableAuth("uid-a", true))).toThrowError(
      expect.objectContaining({ code: "failed-precondition" }),
    );
  });

  it("allows only a mustChangePassword user into initial completion", () => {
    expect(requireInitialPasswordChange(callableAuth("uid-a", true)).uid).toBe("uid-a");
    expect(() => requireInitialPasswordChange(callableAuth("uid-a", false))).toThrow();
  });

  it("resolves ownership from UID and refuses a mismatched team owner", async () => {
    const fake = new FakeFirestore();
    fake.seed("teamOwners/uid-a", { teamId: "RoCo-2" });
    fake.seed("teams/RoCo-2", { teamId: "RoCo-2", ownerUid: "uid-b" });
    await expect(getOwnedTeam(fake as unknown as Firestore, "uid-a")).rejects.toMatchObject({
      code: "permission-denied",
    });
  });
});

describe("initial password completion", () => {
  it("updates only the UID, revokes sessions, then clears the claim last", async () => {
    const updateUser = vi.fn().mockResolvedValue({});
    const setCustomUserClaims = vi.fn().mockResolvedValue(undefined);
    const revokeRefreshTokens = vi.fn().mockResolvedValue(undefined);
    const adminAuth = {
      getUser: vi.fn().mockResolvedValue({
        uid: "uid-a",
        customClaims: { mustChangePassword: true, unrelatedClaim: "preserved" },
      }),
      updateUser,
      setCustomUserClaims,
      revokeRefreshTokens,
    } as unknown as Auth;

    const result = await completeInitialPasswordChangeOperation(
      adminAuth,
      { uid: "uid-a", token: { mustChangePassword: true } },
      "a-new-password-of-sufficient-length",
    );

    expect(result).toEqual({ success: true });
    expect(updateUser).toHaveBeenCalledWith("uid-a", {
      password: "a-new-password-of-sufficient-length",
    });
    expect(setCustomUserClaims).toHaveBeenCalledWith("uid-a", {
      mustChangePassword: false,
      unrelatedClaim: "preserved",
    });
    expect(revokeRefreshTokens).toHaveBeenCalledWith("uid-a");
    expect(updateUser.mock.invocationCallOrder[0]).toBeLessThan(
      revokeRefreshTokens.mock.invocationCallOrder[0] ?? 0,
    );
    expect(revokeRefreshTokens.mock.invocationCallOrder[0]).toBeLessThan(
      setCustomUserClaims.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not clear the claim if the password update fails", async () => {
    const setCustomUserClaims = vi.fn();
    const revokeRefreshTokens = vi.fn();
    const adminAuth = {
      getUser: vi.fn().mockResolvedValue({ customClaims: { mustChangePassword: true } }),
      updateUser: vi.fn().mockRejectedValue(new Error("update failed")),
      setCustomUserClaims,
      revokeRefreshTokens,
    } as unknown as Auth;
    await expect(
      completeInitialPasswordChangeOperation(
        adminAuth,
        { uid: "uid-a", token: { mustChangePassword: true } },
        "a-new-password-of-sufficient-length",
      ),
    ).rejects.toThrow("update failed");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("does not clear the claim if refresh-token revocation fails", async () => {
    const setCustomUserClaims = vi.fn();
    const adminAuth = {
      getUser: vi.fn().mockResolvedValue({ customClaims: { mustChangePassword: true } }),
      updateUser: vi.fn().mockResolvedValue({}),
      revokeRefreshTokens: vi.fn().mockRejectedValue(new Error("revoke failed")),
      setCustomUserClaims,
    } as unknown as Auth;
    await expect(
      completeInitialPasswordChangeOperation(
        adminAuth,
        { uid: "uid-a", token: { mustChangePassword: true } },
        "a-new-password-of-sufficient-length",
      ),
    ).rejects.toThrow("revoke failed");
    expect(setCustomUserClaims).not.toHaveBeenCalled();
  });

  it("enforces the 12-to-128 character password range and accepts only newPassword", () => {
    expect(() => parseInitialPasswordChangeInput({ newPassword: "short" })).toThrow();
    expect(() =>
      parseInitialPasswordChangeInput({ newPassword: "x".repeat(129) }),
    ).toThrow();
    expect(() =>
      parseInitialPasswordChangeInput({ newPassword: "x".repeat(12), uid: "uid-b" }),
    ).toThrow();
    expect(parseInitialPasswordChangeInput({ newPassword: "x".repeat(12) })).toBe(
      "x".repeat(12),
    );
  });
});

describe("credential and identifier primitives", () => {
  it("generates strong copy-friendly temporary passwords without Math.random", () => {
    const passwords = new Set(
      Array.from({ length: 50 }, () => generateTemporaryPassword()),
    );
    expect(passwords.size).toBe(50);
    for (const password of passwords) {
      expect(password).toHaveLength(24);
      expect(password).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*?]+$/);
    }
  });

  it("normalizes IPs and produces a non-reversible keyed digest", () => {
    expect(normalizeRequestIp("::ffff:192.0.2.4")).toBe("192.0.2.4");
    const digest = hmacIdentifier("s".repeat(32), "registration-ip", "192.0.2.4");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain("192.0.2.4");
  });
});
