import {
  HttpsError,
  type FunctionsErrorCode,
} from "firebase-functions/v2/https";

export type SafeErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "conflict"
  | "rate_limit"
  | "google_transient"
  | "transient"
  | "google_configuration"
  | "external_permanent"
  | "internal";

export class AppError extends Error {
  public constructor(
    public readonly code: FunctionsErrorCode,
    message: string,
    public readonly category: SafeErrorCategory,
  ) {
    super(message);
    this.name = "AppError";
  }
}

function externalErrorDetails(error: unknown): {
  looksExternal: boolean;
  status: number | undefined;
  code: string;
  reasons: string[];
} {
  if (typeof error !== "object" || error === null) {
    return { looksExternal: false, status: undefined, code: "", reasons: [] };
  }
  const record = error as Record<string, unknown>;
  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : undefined;
  const status = typeof response?.status === "number" ? response.status : undefined;
  const code =
    typeof record.code === "string" || typeof record.code === "number"
      ? String(record.code)
      : "";
  const responseData =
    typeof response?.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : undefined;
  const errorBody =
    typeof responseData?.error === "object" && responseData.error !== null
      ? (responseData.error as Record<string, unknown>)
      : responseData;
  const errorItems = Array.isArray(errorBody?.errors) ? errorBody.errors : [];
  const reasons = errorItems.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const reason = (item as Record<string, unknown>).reason;
    return typeof reason === "string" ? [reason] : [];
  });
  return {
    looksExternal:
      status !== undefined ||
      code.length > 0 ||
      record.name === "GaxiosError" ||
      "config" in record,
    status,
    code,
    reasons,
  };
}

export function toHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  if (error instanceof AppError) return new HttpsError(error.code, error.message);
  return new HttpsError("internal", "The operation could not be completed.");
}

export function safeErrorCategory(error: unknown): SafeErrorCategory {
  if (error instanceof AppError) return error.category;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (
      [
        "auth/internal-error",
        "auth/network-request-failed",
        "auth/too-many-requests",
        "app/network-error",
        "app/network-timeout",
        "app/internal-error",
        "1",
        "2",
        "4",
        "8",
        "10",
        "13",
        "14",
        "cancelled",
        "unknown",
        "deadline-exceeded",
        "resource-exhausted",
        "aborted",
        "internal",
        "unavailable",
      ].includes(code)
    ) {
      return "transient";
    }
  }
  const { looksExternal, status } = externalErrorDetails(error);
  if (looksExternal) {
    if (isTransientExternalError(error)) {
      return "google_transient";
    }
    if (status === 401 || status === 403) return "google_configuration";
    return "external_permanent";
  }
  return "internal";
}

export function isRetryableSafeCategory(category: string): boolean {
  return category === "google_transient" || category === "transient";
}

export function isTransientExternalError(error: unknown): boolean {
  const { looksExternal, status, code, reasons } = externalErrorDetails(error);
  return (
    looksExternal &&
    (status === 408 ||
      status === 429 ||
      (status === 403 &&
        reasons.some((reason) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason),
        )) ||
      (status !== undefined && status >= 500) ||
      ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code))
  );
}
