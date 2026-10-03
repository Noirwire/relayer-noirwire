// Requests per customer per minute, in fixed one-minute windows, counted in this process.
// This is the in-memory store's rate limit. The Postgres store counts the same windows in
// the database, so there the limit is shared by every gateway process.

export const RATE_WINDOW_MS = 60_000;

export function createRateLimiter() {
  const windows = new Map();
  return {
    /** Counts one request. False when the customer is over its limit for this minute. */
    allow(customerId, requestsPerMinute, nowMs) {
      const window = Math.floor(nowMs / RATE_WINDOW_MS);
      const current = windows.get(customerId);
      if (!current || current.window < window) {
        windows.set(customerId, { window, count: 1 });
        return true;
      }
      if (current.count >= requestsPerMinute) return false;
      current.count += 1;
      return true;
    },
  };
}
