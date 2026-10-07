import { ceilDiv, min } from "./units.mjs";

// The decisions, with no network in them: given balances, what should move.

/**
 * A transfer smaller than this is not worth its 5,000 lamport fee. Without it, a payment
 * wallet holding spare SOL would pay a fee on every run to replace the 10,000 lamports
 * the fee payer spent on one relayed transaction.
 */
export const MIN_TRANSFER_LAMPORTS = 1_000_000n;

/**
 * The most SOL this job will ever move into the fee payer in any 24 hours, whatever the
 * settings say: 0.5 SOL, five full refills of the default float. It is a constant on purpose.
 * If someone finds a way to make the fee payer burn SOL, the refills must not turn that into
 * a way to burn the collected revenue too; past this the job stops and a human looks.
 */
export const MAX_LAMPORTS_TO_FEE_PAYER_PER_DAY = 500_000_000n;

/**
 * Cuts a planned transfer down to what the daily ceiling still allows, given what the chain
 * shows was already moved in the last 24 hours. 0n means the ceiling is reached.
 */
export function withinDailyCeiling(lamports, movedLast24h) {
  const room = MAX_LAMPORTS_TO_FEE_PAYER_PER_DAY - movedLast24h;
  const allowed = min(lamports, room);
  return allowed >= MIN_TRANSFER_LAMPORTS ? allowed : 0n;
}

/** The smallest swap worth asking for. Market makers quoted USDC to SOL from 0.5 USDC in testing. */
export const MIN_SWAP_USDC = 500_000n;

const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Lamports to move from the payment wallet to the fee payer right now, or 0n.
 *
 * It runs at the start of every run and again after a swap, and it is the only thing that
 * ever decides a transfer. It never asks whether a swap happened: whatever the payment
 * wallet holds above its reserve goes to the fee payer, so a run that swapped and then died
 * is finished by the next one. The amount can never take the fee payer above the target,
 * which is what stops a bug or a wrong balance from moving everything.
 */
export function planTransfer({ feePayerLamports, walletLamports }, cfg) {
  const spare = walletLamports - cfg.reserveLamports;
  const missing = cfg.targetLamports - feePayerLamports;
  if (spare <= 0n || missing <= 0n) return 0n;
  const amount = min(spare, missing);
  return amount >= MIN_TRANSFER_LAMPORTS ? amount : 0n;
}

/** The refusal for a wallet that has already swapped as often as it may in 24 hours, or null. */
export function dailyCapRefusal(swapsLast24h, cfg) {
  if (swapsLast24h < cfg.maxRunsPerDay) return null;
  return {
    action: "refuse",
    code: "daily_cap",
    reason: `${swapsLast24h} swap attempts in the last 24 hours, the cap is ${cfg.maxRunsPerDay}`,
  };
}

/**
 * Whether to swap, and how much USDC.
 *
 * `microUsdcPerSol` is the reference price (raw USDC units per whole SOL). The amount asked
 * for is what the missing SOL costs at that price plus the allowed slippage, so the swap
 * still reaches the target when the quote is at the edge of what the guard accepts. It is
 * then cut down to the per-run cap and to what the wallet holds above its floor.
 */
export function planSwap({ feePayerLamports, walletLamports, usdc, swapsLast24h, microUsdcPerSol }, cfg) {
  if (feePayerLamports > cfg.refillBelowLamports) return { action: "none" };
  const cap = dailyCapRefusal(swapsLast24h, cfg);
  if (cap) return cap;

  const reserveTopUp = cfg.reserveLamports > walletLamports ? cfg.reserveLamports - walletLamports : 0n;
  const needLamports = cfg.targetLamports - feePayerLamports + reserveTopUp;
  const atPrice = ceilDiv(needLamports * microUsdcPerSol, LAMPORTS_PER_SOL);
  const wanted = ceilDiv(atPrice * BigInt(10_000 + cfg.maxSlippageBps), 10_000n);

  const spendable = usdc - cfg.usdcFloor;
  const usdcAmount = min(wanted, cfg.maxUsdcPerRun, spendable);
  if (usdcAmount < MIN_SWAP_USDC) {
    return {
      action: "refuse",
      code: "no_usdc",
      reason: "the fee payer is below the refill threshold but there is no USDC to spend above the floor",
    };
  }
  return { action: "swap", needLamports, usdcAmount, capped: usdcAmount < wanted };
}
