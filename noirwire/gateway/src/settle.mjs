import { Refusal } from "./errors.mjs";

// Settling: finding out what became of a transaction that was handed on. Until a quote is
// settled it holds its source account, so the same balance cannot be spent by several
// relayer-paid transactions at once (one lands, the others fail on chain, and the relayer
// pays every fee).
//
// A quote is settled from the chain alone:
//   - its signature is confirmed without an error            -> landed
//   - its signature is confirmed with an error               -> failed_on_chain
//   - no trace of it, and the finalized block height is past
//     the last height its blockhash is valid at              -> expired (it can never land)
// Anything else stays unsettled and is asked about again later. A blockhash is valid for
// about 150 blocks, so no quote stays unsettled much longer than a minute or two.

/** A claim this old was abandoned mid-flight: the process died, or could not record. */
export const SIGNING_STALE_MS = 120_000;

const SETTLED_COMMITMENTS = ["confirmed", "finalized"];

export function createSettler({ conn, store, clock }) {
  /**
   * Settles what can be settled among these unsettled quotes and returns the ones that
   * remain unsettled. A chain that cannot be read is a refusal: nothing is assumed settled.
   */
  return async function settle(quotes) {
    const nowMs = clock.now();
    // A claim that is still being worked on has nothing to look up yet.
    const inFlight = (quote) => quote.state === "signing" && nowMs - quote.claimedAtMs <= SIGNING_STALE_MS;
    const remaining = quotes.filter(inFlight);
    const candidates = quotes.filter((quote) => !inFlight(quote));
    if (candidates.length === 0) return remaining;

    // The height is read before the statuses. A transaction can only land at or below its
    // last valid height, so once the finalized height is past it, a status read afterwards
    // shows the transaction if it ever landed.
    let finalizedHeight;
    let statuses = [];
    const signed = candidates.filter((quote) => quote.signature);
    try {
      finalizedHeight = await conn.getBlockHeight("finalized");
      if (signed.length > 0) {
        ({ value: statuses } = await conn.getSignatureStatuses(signed.map((quote) => quote.signature), { searchTransactionHistory: true }));
      }
    } catch {
      throw new Refusal("chain_unavailable", "settlement");
    }
    if (!Number.isSafeInteger(finalizedHeight) || !Array.isArray(statuses) || statuses.length !== signed.length) {
      throw new Refusal("chain_unavailable", "settlement");
    }
    const statusOf = new Map(signed.map((quote, index) => [quote.id, statuses[index]]));

    for (const quote of candidates) {
      const status = statusOf.get(quote.id) ?? null;
      let to = null;
      if (status) {
        if (SETTLED_COMMITMENTS.includes(status.confirmationStatus)) to = status.err ? "failed_on_chain" : "landed";
      } else if (finalizedHeight > quote.lastValidBlockHeight) {
        to = "expired";
      }
      // A quote that changed since it was read is not settled on what was read.
      if (!to || !(await store.settle(quote.id, { state: quote.state, signature: quote.signature }, to))) remaining.push(quote);
    }
    return remaining;
  };
}
