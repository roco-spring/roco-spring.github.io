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
  hasResponse: boolean;
  status: number | undefined;
  code: string;
  reasons: string[];
  nestedCodes: string[];
  nestedNames: string[];
  requestTimedOut: boolean;
} {
  if (typeof error !== "object" || error === null) {
    return {
      looksExternal: false,
      hasResponse: false,
      status: undefined,
      code: "",
      reasons: [],
      nestedCodes: [],
      nestedNames: [],
      requestTimedOut: false,
    };
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
  const oauthError = responseData?.error;
  if (typeof oauthError === "string") reasons.push(oauthError);
  const nestedErrors = [record.error, record.cause].filter(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null,
  );
  const nestedCodes = nestedErrors.flatMap((candidate) =>
    typeof candidate.code === "string" || typeof candidate.code === "number"
      ? [String(candidate.code)]
      : [],
  );
  const nestedNames = nestedErrors.flatMap((candidate) =>
    typeof candidate.name === "string" ? [candidate.name] : [],
  );
  const config =
    typeof record.config === "object" && record.config !== null
      ? (record.config as Record<string, unknown>)
      : undefined;
  const signal =
    typeof config?.signal === "object" && config.signal !== null
      ? (config.signal as Record<string, unknown>)
      : undefined;
  const timeout = config?.timeout;
  // Gaxios 7 reports a timeout as an aborted nested AbortError. Older Gaxios
  // reports a FetchError with the exact request-timeout type. Detect only
  // those structural shapes without inspecting messages, URLs, or payloads.
  const requestTimedOut =
    response === undefined &&
    typeof timeout === "number" &&
    Number.isFinite(timeout) &&
    timeout > 0 &&
    ((signal?.aborted === true &&
      nestedNames.some((name) =>
        ["AbortError", "TimeoutError"].includes(name),
      )) ||
      nestedErrors.some(
        (candidate) =>
          candidate.name === "FetchError" &&
          candidate.type === "request-timeout",
      ));
  return {
    looksExternal:
      status !== undefined ||
      code.length > 0 ||
      record.name === "GaxiosError" ||
      "config" in record,
    hasResponse: response !== undefined,
    status,
    code,
    reasons,
    nestedCodes,
    nestedNames,
    requestTimedOut,
  };
}

export function toHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  if (error instanceof AppError) return new HttpsError(error.code, error.message);
  if (isRetryableSafeCategory(safeErrorCategory(error))) {
    return new HttpsError(
      "unavailable",
      "A required service is temporarily unavailable. Please retry safely.",
    );
  }
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
  const { looksExternal, status, code, reasons } = externalErrorDetails(error);
  if (looksExternal) {
    if (isTransientExternalError(error)) {
      return "google_transient";
    }
    if (
      status === 401 ||
      status === 403 ||
      [code, ...reasons].some((value) =>
        [
          "admin_policy_enforced",
          "invalid_grant",
          "invalid_client",
          "invalid_request",
          "invalid_scope",
          "invalid_token",
          "unauthorized_client",
          "unsupported_grant_type",
          "access_denied",
          "deleted_client",
          "insufficient_scope",
          "insufficientPermissions",
          "org_internal",
        ].includes(value),
      )
    ) {
      return "google_configuration";
    }
    return "external_permanent";
  }
  return "internal";
}

export function isRetryableSafeCategory(category: string): boolean {
  return category === "google_transient" || category === "transient";
}

export function isTransientExternalError(error: unknown): boolean {
  const {
    looksExternal,
    hasResponse,
    status,
    code,
    reasons,
    nestedCodes,
    requestTimedOut,
  } = externalErrorDetails(error);
  const transportCodes = new Set([
    "ABORT_ERR",
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNRESET",
    "ERR_CANCELED",
    "ETIMEDOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
  ]);
  return (
    looksExternal &&
    (status === 408 ||
      status === 429 ||
      (status === 403 &&
        reasons.some((reason) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason),
        )) ||
      (status !== undefined && status >= 500) ||
      reasons.some((reason) =>
        ["server_error", "temporarily_unavailable"].includes(reason),
      ) ||
      requestTimedOut ||
      (!hasResponse &&
        [code, ...nestedCodes].some((candidate) =>
          transportCodes.has(candidate),
        )))
  );
}
