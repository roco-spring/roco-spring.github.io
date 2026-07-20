import { isTransientExternalError } from "./errors.js";

export const GOOGLE_API_REQUEST_TIMEOUT_MS = 8_000;
export const GOOGLE_API_MAX_ATTEMPTS = 2;
export const GOOGLE_API_REQUEST_OPTIONS = Object.freeze({
  timeout: GOOGLE_API_REQUEST_TIMEOUT_MS,
  retry: false,
});

const wait = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function withBoundedGoogleRetry<T>(
  operation: (
    requestOptions: typeof GOOGLE_API_REQUEST_OPTIONS,
  ) => Promise<T>,
  options: { attempts?: 1 | 2; baseDelayMs?: number } = {},
): Promise<T> {
  // A retry must be an explicit call-site decision. Keep the hard ceiling even
  // for untyped JavaScript callers so a malformed policy cannot multiply the
  // eight-second request timeout across a reconciliation batch.
  const attempts = options.attempts === 2 ? GOOGLE_API_MAX_ATTEMPTS : 1;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let latestError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation(GOOGLE_API_REQUEST_OPTIONS);
    } catch (error: unknown) {
      latestError = error;
      if (!isTransientExternalError(error) || attempt === attempts - 1) throw error;
      const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
      await wait(baseDelayMs * 2 ** attempt + jitter);
    }
  }
  throw latestError;
}
