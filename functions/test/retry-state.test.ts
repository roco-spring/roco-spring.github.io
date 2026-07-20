import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  isTransientExternalError,
  safeErrorCategory,
  toHttpsError,
} from "../src/errors.js";
import {
  GOOGLE_API_MAX_ATTEMPTS,
  GOOGLE_API_REQUEST_TIMEOUT_MS,
  withBoundedGoogleRetry,
} from "../src/google-retry.js";
import {
  claimRegistrationEmailAttempt,
  claimSheetSynchronization,
  failClaimedSheetSynchronization,
  finishRegistrationEmailAttempt,
  reviveFailedCleanup,
  reviveFailedRegistrationEmail,
  reviveFailedSheetSynchronization,
} from "../src/team-repository.js";
import { FakeFirestore } from "./helpers/fake-firestore.js";

describe("bounded reconciliation state", () => {
  it("keeps transient sheet failures pending, then stops after the retry cap", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 2,
      sheetId: "sheet-1",
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
      sheetId: "sheet-1",
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
        "external_permanent",
      ),
    ).toBe("failed");
  });

  it("bounds resource-specific OAuth retries for an unprovisioned team", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 1,
      sheetId: null,
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
          "google_configuration",
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
        "google_configuration",
      ),
    ).toBe("failed");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetSyncStatus: "failed",
      sheetSyncRetryCount: 5,
      sheetSyncLeaseId: null,
    });
  });

  it("bounds retryable definitive create rejections while clearing each fence", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 1,
      sheetId: null,
      sheetCreateAttemptedAt: Timestamp.fromMillis(1),
      sheetCreateNoFileObservationCount: 0,
      sheetSyncStatus: "pending",
      sheetSyncRetryCount: 0,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
    });
    const db = fake as unknown as Firestore;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await claimSheetSynchronization(db, "RoCo-1", attempt);
      expect(claim).not.toBeNull();
      const status = await failClaimedSheetSynchronization(
        db,
        "RoCo-1",
        claim?.leaseId ?? "missing",
        "google_transient",
        { definitiveCreateRejected: true },
      );
      expect(status).toBe(attempt < 5 ? "pending" : "failed");
      expect(fake.read("teams/RoCo-1")).toMatchObject({
        sheetCreateAttemptedAt: null,
        sheetSyncRetryCount: attempt,
      });
      if (attempt < 5) {
        // Simulate the next safely fenced create attempt.
        fake.update("teams/RoCo-1", {
          sheetCreateAttemptedAt: Timestamp.fromMillis(attempt + 1),
        });
      }
    }
  });

  it("clears an old ambiguous-create fence after three no-file observations", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 1,
      sheetId: null,
      sheetCreateAttemptedAt: Timestamp.fromMillis(0),
      sheetCreateNoFileObservationCount: 2,
      sheetSyncStatus: "pending",
      sheetSyncRetryCount: 2,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
    });
    const db = fake as unknown as Firestore;
    const claim = await claimSheetSynchronization(db, "RoCo-1", 4_000_000);
    expect(claim).not.toBeNull();
    await expect(
      failClaimedSheetSynchronization(
        db,
        "RoCo-1",
        claim?.leaseId ?? "missing",
        "transient",
        {
          ambiguousCreateNoFileObserved: true,
          now: 4_000_000,
        },
      ),
    ).resolves.toBe("pending");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetCreateAttemptedAt: null,
      sheetCreateNoFileObservationCount: 0,
      sheetSyncRetryCount: 0,
      sheetSyncStatus: "pending",
    });
  });

  it("keeps OAuth email failures pending but rejects permanent message failures", async () => {
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
    const configurationClaim = await claimRegistrationEmailAttempt(db, "RoCo-1", 2);
    expect(
      await finishRegistrationEmailAttempt(
        db,
        "RoCo-1",
        configurationClaim?.leaseId ?? "missing",
        "failed",
        "google_configuration",
      ),
    ).toBe("pending");
    const permanentClaim = await claimRegistrationEmailAttempt(db, "RoCo-1", 3);
    expect(
      await finishRegistrationEmailAttempt(
        db,
        "RoCo-1",
        permanentClaim?.leaseId ?? "missing",
        "failed",
        "external_permanent",
      ),
    ).toBe("failed");
  });

  it("stops a resource-specific OAuth email failure at the retry cap", async () => {
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
    for (let attempt = 1; attempt < 5; attempt += 1) {
      const claim = await claimRegistrationEmailAttempt(db, "RoCo-1", attempt);
      expect(claim).not.toBeNull();
      expect(
        await finishRegistrationEmailAttempt(
          db,
          "RoCo-1",
          claim?.leaseId ?? "missing",
          "failed",
          "google_configuration",
        ),
      ).toBe("pending");
    }
    const finalClaim = await claimRegistrationEmailAttempt(db, "RoCo-1", 5);
    expect(finalClaim).not.toBeNull();
    expect(
      await finishRegistrationEmailAttempt(
        db,
        "RoCo-1",
        finalClaim?.leaseId ?? "missing",
        "failed",
        "google_configuration",
      ),
    ).toBe("failed");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      registrationEmailStatus: "failed",
      registrationEmailRetryCount: 5,
      registrationEmailLeaseId: null,
    });
  });

  it("revives day-old transient failures for exactly one final recovery probe", async () => {
    const fake = new FakeFirestore();
    const lastAttemptAt = Timestamp.fromMillis(1_000);
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      revision: 2,
      sheetId: "sheet-1",
      sheetSyncStatus: "failed",
      sheetSyncLastAttemptAt: lastAttemptAt,
      sheetSyncRetryCount: 5,
      sheetSyncSafeErrorCategory: "transient",
      sheetSyncLeaseId: "expired-sheet-lease",
      sheetSyncLeaseExpiresAt: Timestamp.fromMillis(0),
      registrationRequestId: "request-1",
      registrationEmailStatus: "failed",
      registrationEmailLastAttemptAt: lastAttemptAt,
      registrationEmailRetryCount: 5,
      registrationEmailSafeErrorCategory: "google_transient",
      registrationEmailRetryIneligible: false,
      registrationEmailLeaseId: "expired-email-lease",
      registrationEmailLeaseExpiresAt: Timestamp.fromMillis(0),
    });
    fake.seed("registrationRequests/request-1", {
      state: "email_pending",
      emailStatus: "failed",
      cleanupState: "failed",
      cleanupLastAttemptAt: lastAttemptAt,
      cleanupRetryCount: 5,
      cleanupSafeErrorCategory: "transient",
    });
    const db = fake as unknown as Firestore;
    const cutoffMs = 2_000;

    await expect(
      reviveFailedSheetSynchronization(db, "RoCo-1", cutoffMs),
    ).resolves.toBe(true);
    await expect(
      reviveFailedRegistrationEmail(db, "RoCo-1", cutoffMs),
    ).resolves.toBe(true);
    await expect(
      reviveFailedCleanup(db, "request-1", cutoffMs),
    ).resolves.toBe(true);
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetSyncStatus: "pending",
      sheetSyncRetryCount: 4,
      sheetSyncLeaseId: null,
      sheetSyncLeaseExpiresAt: null,
      registrationEmailStatus: "pending",
      registrationEmailRetryCount: 4,
      registrationEmailLeaseId: null,
      registrationEmailLeaseExpiresAt: null,
    });
    expect(fake.read("registrationRequests/request-1")).toMatchObject({
      state: "email_pending",
      emailStatus: "pending",
      cleanupState: "pending",
      cleanupRetryCount: 4,
    });

    const sheetClaim = await claimSheetSynchronization(db, "RoCo-1", 3_000);
    await expect(
      failClaimedSheetSynchronization(
        db,
        "RoCo-1",
        sheetClaim?.leaseId ?? "missing",
        "google_transient",
      ),
    ).resolves.toBe("failed");
    const emailClaim = await claimRegistrationEmailAttempt(db, "RoCo-1", 3_000);
    await expect(
      finishRegistrationEmailAttempt(
        db,
        "RoCo-1",
        emailClaim?.leaseId ?? "missing",
        "failed",
        "google_transient",
      ),
    ).resolves.toBe("failed");
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetSyncStatus: "failed",
      sheetSyncRetryCount: 5,
      registrationEmailStatus: "failed",
      registrationEmailRetryCount: 5,
    });
  });

  it.each([
    "google_configuration",
    "authorization",
    "external_permanent",
    "internal",
  ])("never remotely revives a terminal %s failure", async (category) => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-1", {
      teamId: "RoCo-1",
      sheetSyncStatus: "failed",
      sheetSyncLastAttemptAt: Timestamp.fromMillis(1_000),
      sheetSyncRetryCount: 5,
      sheetSyncSafeErrorCategory: category,
    });

    await expect(
      reviveFailedSheetSynchronization(
        fake as unknown as Firestore,
        "RoCo-1",
        2_000,
      ),
    ).resolves.toBe(false);
    expect(fake.read("teams/RoCo-1")).toMatchObject({
      sheetSyncStatus: "failed",
      sheetSyncRetryCount: 5,
      sheetSyncSafeErrorCategory: category,
    });
  });

  it("sets the final probe count when legacy retry state is missing and rejects null age", async () => {
    const fake = new FakeFirestore();
    fake.seed("teams/RoCo-legacy", {
      teamId: "RoCo-legacy",
      sheetSyncStatus: "failed",
      sheetSyncLastAttemptAt: Timestamp.fromMillis(1_000),
      sheetSyncSafeErrorCategory: "transient",
    });
    fake.seed("teams/RoCo-null-age", {
      teamId: "RoCo-null-age",
      sheetSyncStatus: "failed",
      sheetSyncLastAttemptAt: null,
      sheetSyncSafeErrorCategory: "transient",
    });
    const db = fake as unknown as Firestore;

    await expect(
      reviveFailedSheetSynchronization(db, "RoCo-legacy", 2_000),
    ).resolves.toBe(true);
    expect(fake.read("teams/RoCo-legacy")).toMatchObject({
      sheetSyncStatus: "pending",
      sheetSyncRetryCount: 4,
    });
    await expect(
      reviveFailedSheetSynchronization(db, "RoCo-null-age", 2_000),
    ).resolves.toBe(false);
    expect(fake.read("teams/RoCo-null-age")).not.toHaveProperty(
      "sheetSyncRetryCount",
    );
  });
});

describe("Google error classification", () => {
  it("does not retry a transient Google call by default", async () => {
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
      .mockResolvedValue("ok");
    await expect(
      withBoundedGoogleRetry(operation, { baseDelayMs: 0 }),
    ).rejects.toBe(error);
    expect(GOOGLE_API_MAX_ATTEMPTS).toBe(2);
    expect(GOOGLE_API_REQUEST_TIMEOUT_MS).toBe(8_000);
    expect(operation).toHaveBeenCalledTimes(1);
    for (const call of operation.mock.calls) {
      expect(call[0]).toEqual({ timeout: 8_000, retry: false });
    }
  });

  it("permits exactly one explicit retry and ignores an oversized policy", async () => {
    const error = {
      name: "GaxiosError",
      response: { status: 503 },
      config: {},
    };
    const retriedOperation = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");
    await expect(
      withBoundedGoogleRetry(retriedOperation, {
        attempts: 2,
        baseDelayMs: 0,
      }),
    ).resolves.toBe("ok");
    expect(retriedOperation).toHaveBeenCalledTimes(2);

    const oversizedOperation = vi.fn().mockRejectedValue(error);
    await expect(
      withBoundedGoogleRetry(oversizedOperation, {
        // Exercise the runtime ceiling against an untyped caller.
        attempts: 99 as 2,
        baseDelayMs: 0,
      }),
    ).rejects.toBe(error);
    expect(oversizedOperation).toHaveBeenCalledTimes(1);
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
      withBoundedGoogleRetry(operation, { baseDelayMs: 0 }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(safeErrorCategory(error)).toBe("external_permanent");
  });

  it("classifies OAuth credential rejection without exposing its details", () => {
    const error = {
      name: "GaxiosError",
      response: {
        status: 400,
        data: { error: "invalid_grant", error_description: "sensitive detail" },
      },
      config: {},
    };
    expect(safeErrorCategory(error)).toBe("google_configuration");
    const callable = toHttpsError(error);
    expect(callable.code).toBe("internal");
    expect(callable.message).not.toContain("invalid_grant");
    expect(callable.message).not.toContain("sensitive detail");
  });

  it.each([
    "admin_policy_enforced",
    "deleted_client",
    "insufficient_scope",
    "invalid_client",
    "invalid_request",
    "invalid_scope",
    "invalid_token",
    "org_internal",
    "unauthorized_client",
    "unsupported_grant_type",
  ])("classifies OAuth configuration code %s for repair", (providerCode) => {
    expect(
      safeErrorCategory({
        name: "GaxiosError",
        response: { status: 400, data: { error: providerCode } },
        config: {},
      }),
    ).toBe("google_configuration");
  });

  it.each(["server_error", "temporarily_unavailable"])(
    "classifies OAuth transient code %s for bounded retry",
    (providerCode) => {
      const error = {
        name: "GaxiosError",
        response: { status: 400, data: { error: providerCode } },
        config: {},
      };
      expect(isTransientExternalError(error)).toBe(true);
      expect(safeErrorCategory(error)).toBe("google_transient");
    },
  );

  it("maps retryable infrastructure errors to a callable retry signal", () => {
    const callable = toHttpsError({
      name: "GaxiosError",
      response: { status: 503 },
      config: {},
    });
    expect(callable.code).toBe("unavailable");
    expect(callable.message).not.toContain("503");
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
