import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SystemInstruction, SystemProgram, Transaction } from "@solana/web3.js";
import { Failed, Refusal, UnknownOutcome } from "./errors.mjs";
import { USDC } from "./guard.mjs";
import { base58Encode } from "./units.mjs";

// What the job reads from and writes to the chain itself (the swap goes through Jupiter).
// History is read at "confirmed" throughout, so every counter sees the same ledger.

export const usdcAccountOf = (wallet) => getAssociatedTokenAddressSync(USDC, wallet, true);

export async function readBalances(conn, cfg) {
  const wallet = cfg.wallet.publicKey;
  const [feePayer, payment, usdc] = await conn.getMultipleAccountsInfo(
    [cfg.feePayer, wallet, usdcAccountOf(wallet)],
    "confirmed",
  );
  return {
    feePayerLamports: BigInt(feePayer?.lamports ?? 0),
    // A funded, ordinary wallet: exists, and belongs to the System program.
    feePayerIsSystemAccount: Boolean(feePayer) && feePayer.owner.equals(SystemProgram.programId),
    walletLamports: BigInt(payment?.lamports ?? 0),
    usdc: usdc && usdc.data.length >= 165 ? usdc.data.readBigUInt64LE(64) : 0n,
  };
}

const PAGE = 1000;
const FETCH_CONCURRENCY = 16;

/**
 * Every signature naming `address` since `sinceSeconds`, newest first, paging back until the
 * boundary is passed. `complete` is false when `maxPages` ran out first: the history then
 * does not reach the boundary and nothing may be concluded from it.
 */
async function signaturesSince(conn, address, sinceSeconds, maxPages) {
  const entries = [];
  let before;
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await conn.getSignaturesForAddress(address, { limit: PAGE, before }, "confirmed");
    for (const entry of batch) {
      // A missing block time cannot be placed, so it is kept: counted, never skipped.
      if (entry.blockTime !== null && entry.blockTime !== undefined && entry.blockTime < sinceSeconds) {
        return { entries, complete: true };
      }
      entries.push(entry);
    }
    if (batch.length < PAGE) return { entries, complete: true };
    before = batch[batch.length - 1].signature;
  }
  return { entries, complete: false };
}

/** The landed transactions for `entries`, a bounded number at a time. Unreadable ones are null. */
async function readTransactions(conn, entries) {
  const results = new Array(entries.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const index = next;
      next += 1;
      results[index] = await conn
        .getTransaction(entries[index].signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
        .catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, entries.length) }, worker));
  return results;
}

const allKeys = (landed) => {
  const loaded = landed.meta?.loadedAddresses;
  return [...landed.transaction.message.staticAccountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
};
const signedBy = (landed, key) => {
  const { message } = landed.transaction;
  return message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).some((signer) => signer.equals(key));
};
/** How many lamports `key` gained (negative: lost) in a landed transaction. */
const lamportsDelta = (landed, key) => {
  const index = allKeys(landed).findIndex((candidate) => candidate.equals(key));
  if (index < 0 || !landed.meta?.postBalances) return 0n;
  return BigInt(landed.meta.postBalances[index]) - BigInt(landed.meta.preBalances[index]);
};
/** How much USDC `owner` gained (negative: lost) in a landed transaction. */
const usdcDelta = (landed, owner) => {
  const held = (list) =>
    (list ?? [])
      .filter((balance) => balance.owner === owner.toBase58() && balance.mint === USDC.toBase58())
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n);
  return held(landed.meta?.postTokenBalances) - held(landed.meta?.preTokenBalances);
};

const DAY_SECONDS = 86_400;
/** At most this many pages (5,000 transactions naming the wallet) are read for one day. */
const DAY_MAX_PAGES = 5;

/**
 * What the payment wallet did in the last 24 hours, read from the chain: how many swaps it
 * attempted, how much SOL it moved into the fee payer, and the slot of its newest
 * transaction. Both daily limits are enforced from this.
 *
 * There is no database, so a restart, a redeploy or a second copy of the job cannot reset
 * either number: they are whatever the ledger says. Only transactions the wallet itself
 * signed are counted, so dust sent to the wallet by anyone else changes nothing. A swap
 * attempt is one of those that touches the wallet's USDC account, landed or failed.
 *
 * A transaction the RPC cannot return is unknown history: it is neither counted as the
 * wallet's nor ignored. The run refuses (`history_unreadable`) and the next scheduled run
 * reads again. Counting it as a swap would let dust plus a flaky RPC use up the daily cap;
 * skipping it would let a real swap go uncounted. If the day's history does not fit in the
 * page budget the job refuses too: that takes more than 5,000 transactions naming the wallet
 * in one day, and stalling is the safe side of that.
 *
 * `ownSignatures` are transactions this very run sent and saw confirmed; they are left out
 * of `newestSlot`, which exists to notice activity this run does not know about.
 */
export async function walletLast24h(conn, cfg, nowSeconds, ownSignatures = new Set()) {
  const wallet = cfg.wallet.publicKey;
  const usdcAccount = usdcAccountOf(wallet);
  const { entries, complete } = await signaturesSince(conn, wallet, nowSeconds - DAY_SECONDS, DAY_MAX_PAGES);
  if (!complete) {
    throw new Refusal("cannot_count", "too many transactions name the payment wallet to count a day of them");
  }
  const transactions = await readTransactions(conn, entries);
  const unreadable = transactions.filter((landed) => !landed).length;
  if (unreadable > 0) {
    throw new Refusal("history_unreadable", `the RPC could not return ${unreadable} of the payment wallet's recent transactions; nothing is counted on a partial history`);
  }
  let swapAttempts = 0;
  let lamportsToFeePayer = 0n;
  let newestSlot = 0;
  transactions.forEach((landed, index) => {
    const { signature, slot } = entries[index];
    if (!signedBy(landed, wallet)) return;
    if (allKeys(landed).some((key) => key.equals(usdcAccount))) swapAttempts += 1;
    const gained = lamportsDelta(landed, cfg.feePayer);
    if (gained > 0n) lamportsToFeePayer += gained;
    if (!ownSignatures.has(signature) && slot > newestSlot) newestSlot = slot;
  });
  return { swapAttempts, lamportsToFeePayer, newestSlot };
}

/** How far back the fee payer's own transactions are reconciled: one cron interval and a half. */
export const WATCH_WINDOW_SECONDS = 15 * 60;
/** At most this many pages (3,000 transactions naming the fee payer) are read for the window. */
const WATCH_MAX_PAGES = 3;
/**
 * SOL the fee payer may lose in the window on transactions that did not pay for themselves
 * before the job stops refilling: five failed plain transactions. One account creation that
 * was not paid for (2,039,280 lamports) is far above it.
 */
export const UNCOVERED_TOLERANCE_LAMPORTS = 50_000n;

/**
 * Reconciles what the fee payer spent against what the payment wallet received, transaction
 * by transaction, over the fee payer's own recent history, from the chain.
 *
 * Every relayed transaction is paid for by the fee payer and pays USDC to the payment
 * wallet in the same transaction. Kora requires that payment to be worth the SOL spent plus
 * its margin, so a transaction whose USDC is worth less than the SOL the fee payer lost in
 * it, at the reference price, did not pay for itself: it failed after the relayer signed
 * it, or it took rent it did not pay for. A few failures are normal. More is someone
 * draining the float, and the answer to that is to stop refilling it.
 *
 * `drainSuspected` is true when:
 *   - the SOL lost on underpaid transactions reaches UNCOVERED_TOLERANCE_LAMPORTS, or
 *   - the fee payer spent SOL in the window and no USDC arrived at all, or
 *   - the window cannot be proven: the history did not fit the page budget, a transaction
 *     could not be read, or there were relayed transactions and no reference price.
 * It fails closed: what cannot be shown to be fine is treated as not fine.
 *
 * `sawPaidRelay` says the fee payer paid for at least one transaction that paid this wallet:
 * chain evidence that it really is the relayer serving this payment wallet.
 */
export async function reconcileFeePayer(conn, cfg, nowSeconds, microUsdcPerSol) {
  const wallet = cfg.wallet.publicKey;
  const { entries, complete } = await signaturesSince(conn, cfg.feePayer, nowSeconds - WATCH_WINDOW_SECONDS, WATCH_MAX_PAGES);
  const transactions = await readTransactions(conn, entries);
  const totals = {
    windowMinutes: WATCH_WINDOW_SECONDS / 60,
    relayed: 0,
    failed: 0,
    underpaid: 0,
    unread: 0,
    lamportsSpent: 0n,
    lamportsUncovered: 0n,
    usdcReceived: 0n,
    complete,
    sawPaidRelay: false,
  };
  for (const landed of transactions) {
    if (!landed) {
      totals.unread += 1;
      continue;
    }
    // A refill arriving, or anything else the fee payer did not sign, is not a relayed transaction.
    if (!signedBy(landed, cfg.feePayer)) continue;
    const spent = -lamportsDelta(landed, cfg.feePayer);
    const received = usdcDelta(landed, wallet);
    totals.relayed += 1;
    if (landed.meta?.err) totals.failed += 1;
    if (received > 0n) {
      totals.usdcReceived += received;
      if (landed.transaction.message.staticAccountKeys[0].equals(cfg.feePayer)) totals.sawPaidRelay = true;
    }
    if (spent <= 0n) continue;
    totals.lamportsSpent += spent;
    // What the SOL spent is worth in USDC. Without a price, anything short of "no SOL
    // spent" cannot be judged, which is handled below.
    const worth = microUsdcPerSol ? (spent * microUsdcPerSol) / 1_000_000_000n : null;
    if (received <= 0n || (worth !== null && received < worth)) {
      totals.underpaid += 1;
      totals.lamportsUncovered += spent;
    }
  }
  const unprovable = !complete || totals.unread > 0 || (totals.relayed > 0 && !microUsdcPerSol);
  totals.drainSuspected =
    unprovable ||
    totals.lamportsUncovered >= UNCOVERED_TOLERANCE_LAMPORTS ||
    (totals.lamportsSpent > 0n && totals.usdcReceived === 0n);
  return totals;
}

/** How many of the newest payments into the wallet's USDC account are searched for the fee payer. */
const EVIDENCE_TRANSACTIONS = 100;

/**
 * Whether the chain shows FEE_PAYER acting as this wallet's relayer: among the newest
 * transactions touching the wallet's USDC account, one that FEE_PAYER paid the fee for and
 * that paid USDC into this wallet. A mistyped but valid address has no such history.
 */
export async function feePayerHasRelayed(conn, cfg) {
  const wallet = cfg.wallet.publicKey;
  const entries = await conn.getSignaturesForAddress(usdcAccountOf(wallet), { limit: EVIDENCE_TRANSACTIONS }, "confirmed");
  const transactions = await readTransactions(conn, entries.filter((entry) => !entry.err));
  return transactions.some(
    (landed) => landed && landed.transaction.message.staticAccountKeys[0].equals(cfg.feePayer) && usdcDelta(landed, wallet) > 0n,
  );
}

const POLL_MS = 1_500;

/**
 * What the chain says became of a transaction: "confirmed", "failed" or "unknown".
 *
 * "failed" is only ever a fact: an error recorded on chain, or a blockhash that expired with
 * no trace of the transaction. The finalized block height is read before the status on
 * purpose. Read the other way round, a transaction landing between the two calls would be
 * seen as absent and then as expired. The wait is bounded; running out of time is "unknown".
 */
export async function outcomeWithin(conn, signature, lastValidBlockHeight, waitMs, { sleep, now }) {
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const height = lastValidBlockHeight ? await conn.getBlockHeight("finalized") : 0;
      const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = value[0];
      if (status?.err) return "failed";
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return "confirmed";
      }
      if (!status && lastValidBlockHeight && height > lastValidBlockHeight) return "failed";
    } catch {
      // An RPC hiccup or timeout is not an answer; ask again until the deadline.
    }
    if (now() >= deadline) return "unknown";
    await sleep(POLL_MS);
  }
}

/** A blockhash lives about a minute; the finalized height that proves it expired, a little more. */
export const TRANSFER_WAIT_MS = 120_000;

/**
 * The refill transfer. It takes an amount and nothing else: the destination is the pinned
 * FEE_PAYER from configuration and there is no parameter through which any other address
 * could arrive.
 */
export function buildRefillTransfer(cfg, lamports, { blockhash, lastValidBlockHeight }) {
  return new Transaction({ feePayer: cfg.wallet.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: cfg.wallet.publicKey, toPubkey: cfg.feePayer, lamports }),
  );
}

/**
 * Read back what is about to be signed, from the instruction itself: one plain System
 * transfer, from the payment wallet, to the pinned fee payer, for no more than the target.
 */
export function assertRefillTransfer(transaction, cfg) {
  const [instruction] = transaction.instructions;
  const ok =
    transaction.instructions.length === 1 &&
    instruction.programId.equals(SystemProgram.programId) &&
    SystemInstruction.decodeInstructionType(instruction) === "Transfer";
  const decoded = ok ? SystemInstruction.decodeTransfer(instruction) : null;
  if (
    !decoded ||
    !decoded.fromPubkey.equals(cfg.wallet.publicKey) ||
    !decoded.toPubkey.equals(cfg.feePayer) ||
    decoded.lamports <= 0n ||
    decoded.lamports > cfg.targetLamports
  ) {
    throw new Refusal("bad_transfer", "the refill transfer is not a bounded transfer to the pinned fee payer");
  }
}

/** Sends `lamports` to the fee payer and waits for the chain to confirm it. Returns the signature. */
export async function sendRefillTransfer(conn, cfg, lamports, clock) {
  const latest = await conn.getLatestBlockhash("confirmed");
  const transaction = buildRefillTransfer(cfg, lamports, latest);
  assertRefillTransfer(transaction, cfg);
  transaction.sign(cfg.wallet);
  const signature = base58Encode(transaction.signature);
  // A send that errors or never answers may still have reached a validator, so from here on
  // only the chain decides: confirmed, expired (failed), or unknown. Never "failed" by guess.
  await conn
    .sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 })
    .catch(() => null);
  const outcome = await outcomeWithin(conn, signature, latest.lastValidBlockHeight, TRANSFER_WAIT_MS, clock);
  if (outcome === "failed") throw new Failed("the transfer to the fee payer did not land", signature);
  if (outcome === "unknown") throw new UnknownOutcome("The transfer to the fee payer", signature);
  return signature;
}
