// The money arithmetic. Everything is a bigint of micro-USDC or lamports: a float cannot
// hold these numbers exactly and they decide what a user pays.

export const BPS = 10_000n;
/** No customer may mark the network cost up by more than three times. */
export const MAX_MARKUP_BPS = 30_000;
/** Our share of the markup is one fifth, rounded up. */
const PLATFORM_SHARE_DIVISOR = 5n;

export const LAMPORTS_PER_SIGNATURE = 5_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
export const U64_MAX = (1n << 64n) - 1n;

export const ceilDiv = (a, b) => (a + b - 1n) / b;
export const max = (a, b) => (a > b ? a : b);

function requireAmount(value, name) {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError(`${name} must be a non-negative bigint`);
}

/**
 * What the user pays on top of the action, for a network cost of `networkCost` micro-USDC:
 *
 *   markup    M = ceil(B * markupBps / 10000)
 *   ours      S = ceil(M / 5)
 *   customer  C = M - S
 *
 * The user sends B + S to our payment account and C to the customer's payout account.
 */
export function splitFor(networkCost, markupBps) {
  requireAmount(networkCost, "networkCost");
  if (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > MAX_MARKUP_BPS) {
    throw new RangeError("markupBps must be a whole number between 0 and 30000");
  }
  const markup = ceilDiv(networkCost * BigInt(markupBps), BPS);
  const platformShare = ceilDiv(markup, PLATFORM_SHARE_DIVISOR);
  const customer = markup - platformShare;
  return { networkCost, markup, platformShare, platform: networkCost + platformShare, customer };
}

/** `cost` raised by `bufferBps`, rounded up. */
export function withBuffer(cost, bufferBps) {
  requireAmount(cost, "cost");
  return ceilDiv(cost * (BPS + BigInt(bufferBps)), BPS);
}

/**
 * The least the network itself charges, in lamports: one signature fee per required
 * signature plus the priority fee the ComputeBudget instructions ask for, which the runtime
 * rounds up to a whole lamport.
 */
export function floorLamports({ signatures, computeUnitLimit, computeUnitPrice }) {
  requireAmount(computeUnitLimit, "computeUnitLimit");
  requireAmount(computeUnitPrice, "computeUnitPrice");
  const priority = ceilDiv(computeUnitLimit * computeUnitPrice, MICRO_LAMPORTS_PER_LAMPORT);
  return LAMPORTS_PER_SIGNATURE * BigInt(signatures) + priority;
}

/** Lamports at `microUsdPerSol`, in micro-USDC, rounded up. One USD is taken as one USDC. */
export function lamportsToMicroUsdc(lamports, microUsdPerSol) {
  requireAmount(lamports, "lamports");
  requireAmount(microUsdPerSol, "microUsdPerSol");
  return ceilDiv(lamports * microUsdPerSol, LAMPORTS_PER_SOL);
}
