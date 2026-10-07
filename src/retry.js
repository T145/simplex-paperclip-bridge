// Retry helper with exponential backoff and equal jitter.
//
// delay(attempt) = min(maxMs, baseMs * 2^attempt), then jittered into
// [delay / 2, delay]. This keeps retries spread out under load while still
// bounding the worst case delay by maxMs.

export class RetryError extends Error {
  constructor(message, { attempts, cause }) {
    super(message);
    this.name = "RetryError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function backoffDelay(attempt, { baseMs, maxMs, random = Math.random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

export async function withRetry(
  operation,
  {
    retries = 3,
    baseMs = 500,
    maxMs = 30000,
    random = Math.random,
    sleep = defaultSleep,
    isRetryable = () => true,
    onRetry = () => {},
    signal,
  } = {}
) {
  let attempt = 0;
  for (;;) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) {
        if (attempt > 0 && attempt >= retries) {
          throw new RetryError(`operation failed after ${attempt + 1} attempts`, {
            attempts: attempt + 1,
            cause: error,
          });
        }
        throw error;
      }
      const delay = backoffDelay(attempt, { baseMs, maxMs, random });
      onRetry({ attempt, delay, error });
      await sleep(delay, signal);
      attempt += 1;
    }
  }
}

export function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
