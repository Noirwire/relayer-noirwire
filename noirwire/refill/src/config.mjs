import { Keypair, PublicKey } from "@solana/web3.js";
import { MAX_LAMPORTS_TO_FEE_PAYER_PER_DAY } from "./plan.mjs";
import { base58Decode, parseUnits, SOL_DECIMALS, USDC_DECIMALS } from "./units.mjs";

// Everything comes from the environment, is checked once here, and is refused as a whole if
// any part of it makes no sense. A job that moves money should not start on a typo.

const DEFAULTS = {
  TARGET_SOL: "0.1",
  REFILL_BELOW_SOL: "0.03",
  MAX_USDC_PER_RUN: "15",
  MAX_RUNS_PER_DAY: "6",
  USDC_FLOOR: "1",
  PAYMENT_WALLET_SOL_RESERVE: "0.01",
  MAX_SLIPPAGE_BPS: "100",
  DRY_RUN: "0",
};

// Ceilings no setting may exceed, so a misplaced decimal point cannot turn a 0.1 SOL float
// into the whole treasury.
const HARD_MAX_TARGET_LAMPORTS = MAX_LAMPORTS_TO_FEE_PAYER_PER_DAY; // one refill can never exceed a day's ceiling
const HARD_MAX_USDC_PER_RUN = 500_000_000n; // 500 USDC
const HARD_MAX_SLIPPAGE_BPS = 500;
const HARD_MAX_USDC_PER_SOL = 1_000_000_000n; // 1,000 USDC
const HARD_MAX_RUNS_PER_DAY = 48;
// A System account holding SOL must keep at least the rent-exempt minimum (890,880 lamports),
// and the reserve also has to pay this job's own fees.
const MIN_RESERVE_LAMPORTS = 2_000_000n;

export class ConfigError extends Error {}

/** The payment wallet's key as base58 or as the JSON byte array `solana-keygen` writes. */
function parseSecretKey(text) {
  const trimmed = text.trim();
  const bytes = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed))
    : base58Decode(trimmed);
  return Keypair.fromSecretKey(bytes);
}

export function loadConfig(env) {
  const problems = [];
  const read = (name) => {
    const value = env[name]?.trim();
    return value ? value : DEFAULTS[name];
  };
  const amount = (name, decimals) => {
    try {
      return parseUnits(read(name), decimals);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      return 0n;
    }
  };
  const integer = (name) => {
    const value = read(name);
    if (!/^\d+$/.test(value)) problems.push(`${name}: not a whole number`);
    return Number(value);
  };

  const rpcUrl = read("RPC_URL");
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) problems.push("RPC_URL: must be an http(s) URL");

  let wallet = null;
  try {
    if (!read("PAYMENT_WALLET_PRIVATE_KEY")) throw new Error("missing");
    wallet = parseSecretKey(read("PAYMENT_WALLET_PRIVATE_KEY"));
  } catch {
    // The value is never echoed, not even in part.
    problems.push("PAYMENT_WALLET_PRIVATE_KEY: missing or not a valid secret key");
  }

  let feePayer = null;
  try {
    feePayer = new PublicKey(read("FEE_PAYER"));
    // A wallet is a point on the curve. A token account or any other derived address is
    // not, and SOL sent to one of those by mistake does not come back.
    if (!PublicKey.isOnCurve(feePayer.toBytes())) {
      problems.push("FEE_PAYER: not a wallet address (off curve)");
    }
  } catch {
    problems.push("FEE_PAYER: missing or not a public key");
  }
  if (wallet && feePayer && wallet.publicKey.equals(feePayer)) {
    problems.push("FEE_PAYER: is the payment wallet itself; the two keys must be different");
  }

  // Set only for the very first refill, before the fee payer has relayed anything: the
  // operator repeats the address to say "I checked this one myself".
  const unseenOk = env.FEE_PAYER_UNSEEN_OK?.trim() || null;
  if (unseenOk && feePayer && unseenOk !== feePayer.toBase58()) {
    problems.push("FEE_PAYER_UNSEEN_OK: is set but is not the same address as FEE_PAYER");
  }

  // No default on purpose. The job cannot know what SOL should cost; the operator states the
  // most they are ever willing to pay, and nothing Jupiter or a price feed says overrides it.
  let maxMicroUsdcPerSol = 0n;
  if (!env.MAX_USDC_PER_SOL?.trim()) {
    problems.push("MAX_USDC_PER_SOL: required, no default (set it to about twice the current SOL price)");
  } else {
    maxMicroUsdcPerSol = amount("MAX_USDC_PER_SOL", USDC_DECIMALS);
    if (maxMicroUsdcPerSol <= 0n || maxMicroUsdcPerSol > HARD_MAX_USDC_PER_SOL) {
      problems.push("MAX_USDC_PER_SOL: must be above zero and at most 1000");
    }
  }

  const targetLamports = amount("TARGET_SOL", SOL_DECIMALS);
  const refillBelowLamports = amount("REFILL_BELOW_SOL", SOL_DECIMALS);
  const reserveLamports = amount("PAYMENT_WALLET_SOL_RESERVE", SOL_DECIMALS);
  const maxUsdcPerRun = amount("MAX_USDC_PER_RUN", USDC_DECIMALS);
  const usdcFloor = amount("USDC_FLOOR", USDC_DECIMALS);
  const maxRunsPerDay = integer("MAX_RUNS_PER_DAY");
  const maxSlippageBps = integer("MAX_SLIPPAGE_BPS");

  if (targetLamports <= 0n) problems.push("TARGET_SOL: must be above zero");
  if (targetLamports > HARD_MAX_TARGET_LAMPORTS) problems.push("TARGET_SOL: above the 0.5 SOL ceiling");
  if (refillBelowLamports <= 0n) problems.push("REFILL_BELOW_SOL: must be above zero");
  if (refillBelowLamports >= targetLamports) {
    problems.push("REFILL_BELOW_SOL: must be below TARGET_SOL");
  }
  if (reserveLamports < MIN_RESERVE_LAMPORTS) {
    problems.push("PAYMENT_WALLET_SOL_RESERVE: must be at least 0.002 SOL (rent minimum plus fees)");
  }
  if (reserveLamports > targetLamports) {
    problems.push("PAYMENT_WALLET_SOL_RESERVE: must not exceed TARGET_SOL");
  }
  if (maxUsdcPerRun <= 0n) problems.push("MAX_USDC_PER_RUN: must be above zero");
  if (maxUsdcPerRun > HARD_MAX_USDC_PER_RUN) problems.push("MAX_USDC_PER_RUN: above the 500 USDC ceiling");
  if (!(maxRunsPerDay >= 1 && maxRunsPerDay <= HARD_MAX_RUNS_PER_DAY)) {
    problems.push(`MAX_RUNS_PER_DAY: must be between 1 and ${HARD_MAX_RUNS_PER_DAY}`);
  }
  if (!(maxSlippageBps >= 1 && maxSlippageBps <= HARD_MAX_SLIPPAGE_BPS)) {
    problems.push(`MAX_SLIPPAGE_BPS: must be between 1 and ${HARD_MAX_SLIPPAGE_BPS}`);
  }

  const dryRunText = read("DRY_RUN").toLowerCase();
  if (!["0", "1", "true", "false"].includes(dryRunText)) {
    problems.push('DRY_RUN: must be "1" or "0"');
  }

  if (problems.length > 0) throw new ConfigError(problems.join("; "));

  return {
    rpcUrl,
    wallet,
    feePayer,
    // Optional: Jupiter answers without a key at a lower rate limit.
    jupiterApiKey: env.JUPITER_API_KEY?.trim() || null,
    targetLamports,
    refillBelowLamports,
    reserveLamports,
    maxUsdcPerRun,
    usdcFloor,
    maxRunsPerDay,
    maxSlippageBps,
    maxMicroUsdcPerSol,
    feePayerUnseenOk: Boolean(unseenOk),
    dryRun: dryRunText === "1" || dryRunText === "true",
  };
}
