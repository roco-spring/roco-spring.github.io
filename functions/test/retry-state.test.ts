import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import { isTransientExternalError, safeErrorCategory } from "../src/errors.js";
import { withBoundedGoogleRetry } from "../src/google-retry.js";
import {
  claimRegistrationEmailAttempt,
  claimSheetSynchronization,
  failClaimedSheetSynchronization,
  finishRegistrationEmailAttempt,
} from "../src/team-repository.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

describe("bounded reconciliation state", () => {
  it("keeps transient sheet failures pending, then stops after the retry cap", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 2,
      sheetSyncStatus: "pending",
      sheetSyncRetryCount: 0,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
    });
    const db = fake as unknown as Firestore;
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const claim = await claimSheetSynchronization(db, "RoCo-1", attempt);
      expect(claim).not.toBeNull();
      expect(
        await failClaimedSheetSynchronization(
          db,
          "RoCo-1",
          claim?.leaseId ?? "missing",
          "google_transient",
        ),
      ).toBe("pending");
    }
    const finalClaim = await claimSheetSynchronization(db, "RoCo-1", 5);
    expect(finalClaim).not.toBeNull();
    expect(
      await failClaimedSheetSynchronization(
        db,
        "RoCo-1",
        finalClaim?.leaseId ?? "missing",
        "google_transient",
      ),
    ).toBe("failed");
    expect(fake.read("teams/RoCo-1")?.sheetSyncRetryCount).toBe(5);
  });

  it("marks permanent sheet errors failed immediately", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 2,
      sheetSyncStatus: "pending",
      sheetSyncRetryCount: 0,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
    });
    const db = fake as unknown as Firestore;
    const claim = await claimSheetSynchronization(db, "RoCo-1", 1);
    expect(
      await failClaimedSheetSynchronization(
        db,
        "RoCo-1",
        claim?.leaseId ?? "missing",
        "google_configuration",
      ),
    ).toBe("failed");
  });

  it("distinguishes pending transient email from terminal email failure", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      registrationRequestId: "request-1",
      registrationEmailStatus: "pending",
      registrationEmailRetryCount: 0,
      registrationEmailRetryIneligible: false,
      registrationEmailLeaseId: null,
      registrationEmailLeaseExpiresAt: null,
    });
    fake.seed("registrationRequests/request-1", {
      state: "email_pending",
      emailStatus: "pending",
    });
    const db = fake as unknown as Firestore;
    const transientClaim = await claimRegistrationEmailAttempt(db, "RoCo-1", 1);
    expect(
      await finishRegistrationEmailAttempt(
        db,
        "RoCo-1",
        transientClaim?.leaseId ?? "missing",
        "failed",
        "google_transient",
      ),
    ).toBe("pending");
    const permanentClaim = await claimRegistrationEmailAttempt(db, "RoCo-1", 2);
    expect(
      await finishRegistrationEmailAttempt(
        db,
        "RoCo-1",
        permanentClaim?.leaseId ?? "missing",
        "failed",
        "google_configuration",
      ),
    ).toBe("failed");
  });
});

describe("Google error classification", () => {
  it("recognizes transient structural Gaxios errors across dependency versions", async () => {
    const error = {
      name: "GaxiosError",
      response: { status: 429 },
      code: 429,
      config: {},
    };
    expect(isTransientExternalError(error)).toBe(true);
    expect(safeErrorCategory(error)).toBe("google_transient");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");
    await expect(
      withBoundedGoogleRetry(operation, { attempts: 3, baseDelayMs: 0 }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it.each([
    { response: { status: 503 }, config: {} },
    { code: "ECONNRESET", config: {} },
    { code: "ETIMEDOUT", name: "GaxiosError" },
  ])("classifies nested-version HTTP/network shapes as transient", (error) => {
    expect(isTransientExternalError(error)).toBe(true);
    expect(safeErrorCategory(error)).toBe("google_transient");
  });

  it("does not retry permanent Google client errors", async () => {
    const error = {
      name: "GaxiosError",
      response: { status: 400 },
      config: {},
    };
    const operation = vi.fn().mockRejectedValue(error);
    await expect(
      withBoundedGoogleRetry(operation, { attempts: 3, baseDelayMs: 0 }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(safeErrorCategory(error)).toBe("external_permanent");
  });

  it("retries only the transient 403 rate-limit reasons", () => {
    const shaped = (reason: string) => ({
      name: "GaxiosError",
      response: {
        status: 403,
        data: { error: { errors: [{ reason }] } },
      },
      config: {},
    });
    expect(isTransientExternalError(shaped("rateLimitExceeded"))).toBe(true);
    expect(isTransientExternalError(shaped("userRateLimitExceeded"))).toBe(true);
    expect(safeErrorCategory(shaped("insufficientPermissions"))).toBe(
      "google_configuration",
    );
    expect(isTransientExternalError(shaped("quotaExceeded"))).toBe(false);
  });
});
