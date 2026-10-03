// The store, in memory: for tests and single-process development. It forgets everything on
// restart, including which quotes were already signed, so it is not for production.
//
// The store interface, which store/postgres.mjs implements too:
//
//   putQuote(quote)                 a new quote, state "prepared"
//   getQuote(id)                    the quote or null
//   beginSign({ quoteId, customerId, nowMs, day, cost, limits })
//                                   atomically: claim the quote (prepared and unexpired ->
//                                   signing) and consume one transaction and `cost` from the
//                                   customer's budget for `day`. Both happen or neither.
//                                   Answers "claimed", "budget" or "gone".
//   finishSign(id, { state, signature, code })
//                                   signing -> sent | failed | unknown, once
//   close()
//
// Idempotency is the quote itself: only one caller ever gets "claimed" for a quote, and its
// final state is what every later request for that quote is answered with.

/** Prepared quotes that expired this long ago are dropped. Signed ones are kept. */
const KEEP_EXPIRED_MS = 60 * 60_000;

export function createMemoryStore() {
  const quotes = new Map();
  const budgets = new Map();

  return {
    async putQuote(quote) {
      for (const [id, old] of quotes) {
        if (old.state === "prepared" && old.expiresAtMs + KEEP_EXPIRED_MS < quote.createdAtMs) quotes.delete(id);
      }
      quotes.set(quote.id, { ...quote, state: "prepared", signature: null, code: null, claimedAtMs: null });
    },

    async getQuote(id) {
      const quote = quotes.get(id);
      return quote ? { ...quote } : null;
    },

    // No await between the checks and the writes: on one thread that is what makes it atomic.
    async beginSign({ quoteId, customerId, nowMs, day, cost, limits }) {
      const quote = quotes.get(quoteId);
      if (!quote || quote.customerId !== customerId || quote.state !== "prepared" || nowMs >= quote.expiresAtMs) {
        return { kind: "gone" };
      }
      const key = `${customerId} ${day}`;
      const used = budgets.get(key) ?? { transactions: 0, cost: 0n };
      if (used.transactions + 1 > limits.transactionsPerDay || used.cost + cost > limits.networkCostMicroUsdcPerDay) {
        return { kind: "budget" };
      }
      budgets.set(key, { transactions: used.transactions + 1, cost: used.cost + cost });
      quote.state = "signing";
      quote.claimedAtMs = nowMs;
      return { kind: "claimed" };
    },

    async finishSign(id, { state, signature = null, code = null }) {
      const quote = quotes.get(id);
      if (!quote || quote.state !== "signing") return false;
      Object.assign(quote, { state, signature, code });
      return true;
    },

    async budgetUsed(customerId, day) {
      return { ...(budgets.get(`${customerId} ${day}`) ?? { transactions: 0, cost: 0n }) };
    },

    async close() {},
  };
}
