// Requests per customer per minute, counted in this process in fixed one-minute windows.
// It protects the upstreams from a customer's runaway loop; the limits that protect money
// are the daily budgets in the store, which are shared by every process.

const WINDOW_MS = 60_000;

export function createRateLimiter(clock) {
  const windows = new Map();
  return {
    /** Counts one request. False when the customer is over its limit for this minute. */
    allow(customerId, requestsPerMinute) {
      const window = Math.floor(clock.now() / WINDOW_MS);
      const current = windows.get(customerId);
      if (!current || current.window !== window) {
        windows.set(customerId, { window, count: 1 });
        return true;
      }
      if (current.count >= requestsPerMinute) return false;
      current.count += 1;
      return true;
    },
  };
}
