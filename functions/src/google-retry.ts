import { isTransientExternalError } from "./errors.js";

const wait = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function withBoundedGoogleRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let latestError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      latestError = error;
      if (!isTransientExternalError(error) || attempt === attempts - 1) throw error;
      const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
      await wait(baseDelayMs * 2 ** attempt + jitter);
    }
  }
  throw latestError;
}
