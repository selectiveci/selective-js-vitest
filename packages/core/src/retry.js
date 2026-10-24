const RETRY_CAP_SECONDS = 4;
const FAILURES_BEFORE_EXIT = 10;

export function retryDelay(failures) {
  return Math.min(failures, RETRY_CAP_SECONDS) * 1000;
}

export function retriesExhausted(failures) {
  return failures > FAILURES_BEFORE_EXIT;
}

export const TERMINATION_GRACE_MS = 250;
export const CONNECTED_TIMEOUT_MS = 30_000;
