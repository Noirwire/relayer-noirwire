import { createRateLimiter } from "../ratelimit.mjs";

// The store, in memory: for tests and single-process development. It forgets everything on
// restart, including which quotes were already signed, so it is not for production.
//
// The store interface, which store/postgres.mjs implements too:
//
//   putQuote(quote, { maxOpen })    a new quote, state "prepared", unless the customer already
//                                   has `maxOpen` open (prepared, unexpired) quotes. Count and
//                                   insert are one step. Answers "stored" or "too_many". Each
//                                   call also deletes a small batch of dead rows (see CLEANUP).
//   getQuote(id)                    the quote or null
//   beginSign({ quoteId, customerId, nowMs, day, cost, limits })
//                                   atomically: claim the quote (prepared and unexpired ->
//                                   signing) and consume one transaction and `cost` from the
//                                   customer's budget for `day`, unless another quote of the
//                                   same source account is unsettled. All happen or none.
//                                   Answers "claimed", "budget", "source_busy" or "gone".
//   failUnsigned(id, { code, day }) signing, no signature -> failed, and the budget consumed
//                                   by the claim is given back, as one step
//   markSigned(id, signature)       signing -> signed: the transaction id, before any broadcast
//   finishSign(id, { state, code }) signed -> sent | failed | unknown, signing -> failed | unknown
//   settle(id, { state, signature }, to)
//                                   an unsettled quote, still exactly as it was read, ->
//                                   landed | failed_on_chain | expired. failed_on_chain also
//                                   adds one to the customer's failure count, as one step.
//   unsettledForSource(sourceHash)  the unsettled quotes of one source account, any customer
//   unsettledForCustomer(customerId, limit)
//                                   the customer's oldest unsettled quotes
//   failures(customerId)            how many of its transactions failed on chain since the
//                                   last reset; resetFailures(customerId) is the operator's reset
//   allowRequest(customerId, requestsPerMinute, nowMs)
//                                   counts one request; false when over the limit this minute
//   close()
//
// Idempotency is the quote itself: only one caller ever gets "claimed" for a quote, and its
// state is what every later request for that quote is answered from.
//
// States. Unsettled ones hold the source account: no other quote of that source can be
// claimed while one exists.
//
//   prepared         handed out, not signed
//   signing          claimed; the relayer is being asked            (unsettled)
//   signed           the relayer signed; signature stored           (unsettled)
//   sent             a node accepted the broadcast                  (unsettled)
//   unknown          handed on, outcome not known                   (unsettled)
//   failed           nothing was broadcast; `code` says why
//   landed           confirmed on chain
//   failed_on_chain  confirmed on chain with an error: the relayer paid the fee for nothing
//   expired          never landed and its blockhash is no longer valid

export const UNSETTLED_STATES = Object.freeze(["signing", "signed", "sent", "unknown"]);

/** What each write deletes at most, and how long an expired, never signed quote is kept. */
export const CLEANUP = Object.freeze({ batch: 200, keepExpiredMs: 5 * 60_000 });

const isUnsettled = (quote) => UNSETTLED_STATES.includes(quote.state);

export function createMemoryStore({ retentionMs }) {
  const quotes = new Map();
  const budgets = new Map();
  const failures = new Map();
  const rateLimiter = createRateLimiter();

  function cleanUp(nowMs) {
    let deleted = 0;
    for (const [id, old] of quotes) {
      if (deleted >= CLEANUP.batch) return;
      const dead = old.state === "prepared" ? old.expiresAtMs + CLEANUP.keepExpiredMs < nowMs : old.createdAtMs + retentionMs < nowMs;
      if (dead) {
        quotes.delete(id);
        deleted += 1;
      }
    }
  }

  return {
    // No await between a check and its write, here and below: on one thread that is what
    // makes each of these atomic.
    async putQuote(quote, { maxOpen }) {
      const nowMs = quote.createdAtMs;
      cleanUp(nowMs);
      let open = 0;
      for (const old of quotes.values()) {
        if (old.customerId === quote.customerId && old.state === "prepared" && old.expiresAtMs > nowMs) open += 1;
      }
      if (open >= maxOpen) return { kind: "too_many" };
      quotes.set(quote.id, { ...quote, state: "prepared", signature: null, code: null, claimedAtMs: null });
      return { kind: "stored" };
    },

    async getQuote(id) {
      const quote = quotes.get(id);
      return quote ? { ...quote } : null;
    },

    async beginSign({ quoteId, customerId, nowMs, day, cost, limits }) {
      const quote = quotes.get(quoteId);
      if (!quote || quote.customerId !== customerId || quote.state !== "prepared" || nowMs >= quote.expiresAtMs) {
        return { kind: "gone" };
      }
      for (const other of quotes.values()) {
        if (other.sourceHash === quote.sourceHash && isUnsettled(other)) return { kind: "source_busy" };
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

    async failUnsigned(id, { code, day }) {
      const quote = quotes.get(id);
      if (!quote || quote.state !== "signing" || quote.signature !== null) return false;
      Object.assign(quote, { state: "failed", code });
      const key = `${quote.customerId} ${day}`;
      const used = budgets.get(key);
      if (used) {
        budgets.set(key, {
          transactions: Math.max(used.transactions - 1, 0),
          cost: used.cost > quote.networkCost ? used.cost - quote.networkCost : 0n,
        });
      }
      return true;
    },

    async markSigned(id, signature) {
      const quote = quotes.get(id);
      if (!quote || quote.state !== "signing") return false;
      Object.assign(quote, { state: "signed", signature });
      return true;
    },

    async finishSign(id, { state, code = null }) {
      const quote = quotes.get(id);
      if (!quote) return false;
      if (quote.state !== "signed" && !(quote.state === "signing" && state !== "sent")) return false;
      Object.assign(quote, { state, code });
      return true;
    },

    async settle(id, seen, to) {
      const quote = quotes.get(id);
      if (!quote || !isUnsettled(quote) || quote.state !== seen.state || quote.signature !== seen.signature) return false;
      quote.state = to;
      if (to === "failed_on_chain") failures.set(quote.customerId, (failures.get(quote.customerId) ?? 0) + 1);
      return true;
    },

    async unsettledForSource(sourceHash) {
      return [...quotes.values()].filter((quote) => quote.sourceHash === sourceHash && isUnsettled(quote)).map((quote) => ({ ...quote }));
    },

    async unsettledForCustomer(customerId, limit) {
      return [...quotes.values()]
        .filter((quote) => quote.customerId === customerId && isUnsettled(quote))
        .sort((a, b) => a.claimedAtMs - b.claimedAtMs)
        .slice(0, limit)
        .map((quote) => ({ ...quote }));
    },

    async failures(customerId) {
      return failures.get(customerId) ?? 0;
    },

    async resetFailures(customerId) {
      failures.delete(customerId);
    },

    async allowRequest(customerId, requestsPerMinute, nowMs) {
      return rateLimiter.allow(customerId, requestsPerMinute, nowMs);
    },

    async budgetUsed(customerId, day) {
      return { ...(budgets.get(`${customerId} ${day}`) ?? { transactions: 0, cost: 0n }) };
    },

    async close() {},
  };
}
