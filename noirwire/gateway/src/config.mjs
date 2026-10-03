import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { loadCustomers } from "./customers.mjs";

// Everything comes from the environment and one customers file, is checked once here, and is
// refused as a whole if any part of it makes no sense. A service that signs for money should
// not start on a typo. Messages name variables and rules, never values.

const DEFAULTS = {
  PORT: "8787",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  COMPUTE_UNIT_LIMIT: "30000",
  MAX_PRIORITY_MICRO_LAMPORTS: "500000",
  MAX_NETWORK_COST_MICRO_USDC: "100000",
  // Not 0: the relayer prices its fee with a live oracle, so the cost moves inside a quote's
  // lifetime, and a quote of the exact cost is refused at /v1/sign whenever it moved up.
  COST_BUFFER_BPS: "100",
  QUOTE_TTL_SECONDS: "45",
  MAX_OPEN_QUOTES: "500",
  QUOTE_RETENTION_DAYS: "30",
  MAX_FAILED_ON_CHAIN: "5",
  MAX_PRICE_AGE_SECONDS: "60",
  UPSTREAM_TIMEOUT_MS: "15000",
};

// [lowest, highest] a setting may take, so a misplaced digit cannot remove a cap.
const RANGES = {
  PORT: [1, 65_535],
  // Three token transfers need about 19,000 units; a lower limit would only make them fail.
  COMPUTE_UNIT_LIMIT: [20_000, 200_000],
  MAX_PRIORITY_MICRO_LAMPORTS: [0, 10_000_000],
  MAX_NETWORK_COST_MICRO_USDC: [1, 5_000_000],
  // The buffer is paid by the user, so it has a hard cap of five percent.
  COST_BUFFER_BPS: [0, 500],
  // A blockhash lives about a minute; a quote must not outlive the transaction it prices.
  QUOTE_TTL_SECONDS: [5, 60],
  MAX_OPEN_QUOTES: [1, 10_000],
  QUOTE_RETENTION_DAYS: [1, 365],
  MAX_FAILED_ON_CHAIN: [1, 1_000],
  MAX_PRICE_AGE_SECONDS: [1, 120],
  UPSTREAM_TIMEOUT_MS: [1_000, 30_000],
};

const MAX_PLATFORM_PAYMENT_OWNERS = 5;

export class ConfigError extends Error {}

export function loadConfig(env, readFile = (path) => readFileSync(path, "utf8")) {
  const problems = [];
  const read = (name) => {
    const value = env[name]?.trim();
    return value ? value : DEFAULTS[name];
  };
  const integer = (name) => {
    const value = read(name);
    const [lowest, highest] = RANGES[name];
    if (!/^\d{1,9}$/.test(value) || Number(value) < lowest || Number(value) > highest) {
      problems.push(`${name}: must be a whole number between ${lowest} and ${highest}`);
      return 0;
    }
    return Number(value);
  };

  const rpcUrl = read("RPC_URL");
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) problems.push("RPC_URL: must be an http(s) URL");

  // No default on purpose: the in-memory store forgets every quote and budget on restart, so
  // it has to be asked for by name.
  const store = read("STORE");
  if (!["memory", "postgres"].includes(store)) problems.push('STORE: required, must be "memory" or "postgres"');
  const databaseUrl = read("DATABASE_URL") ?? null;
  if (store === "postgres" && !/^postgres(ql)?:\/\//.test(databaseUrl ?? "")) {
    problems.push("DATABASE_URL: required with STORE=postgres, must be a postgres:// URL");
  }

  let usdcMint = null;
  try {
    usdcMint = new PublicKey(read("USDC_MINT"));
  } catch {
    problems.push("USDC_MINT: not a public key");
  }

  // The wallets that may own a payment account, where our share lands. They are the
  // operator's setting and deliberately not a field of the customers file: whoever can edit
  // a customer record must not be able to say which wallets are ours.
  const platformPaymentOwners = [];
  const ownerList = (read("PLATFORM_PAYMENT_OWNERS") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (ownerList.length < 1 || ownerList.length > MAX_PLATFORM_PAYMENT_OWNERS || new Set(ownerList).size !== ownerList.length) {
    problems.push(`PLATFORM_PAYMENT_OWNERS: required, 1 to ${MAX_PLATFORM_PAYMENT_OWNERS} distinct wallet public keys separated by commas`);
  } else {
    for (const entry of ownerList) {
      try {
        platformPaymentOwners.push(new PublicKey(entry));
      } catch {
        problems.push("PLATFORM_PAYMENT_OWNERS: an entry is not a public key");
        break;
      }
    }
  }

  let customers = null;
  const customersFile = read("CUSTOMERS_FILE");
  if (!customersFile) {
    problems.push("CUSTOMERS_FILE: required, the path of the customers JSON file");
  } else {
    let text = null;
    try {
      text = readFile(customersFile);
    } catch {
      problems.push("CUSTOMERS_FILE: could not be read");
    }
    if (text !== null) customers = loadCustomers(text, env, problems);
  }

  const cfg = {
    port: integer("PORT"),
    rpcUrl,
    store,
    databaseUrl,
    usdcMint,
    platformPaymentOwners,
    customers,
    computeUnitLimit: integer("COMPUTE_UNIT_LIMIT"),
    maxPriorityMicroLamports: BigInt(integer("MAX_PRIORITY_MICRO_LAMPORTS")),
    maxNetworkCostMicroUsdc: BigInt(integer("MAX_NETWORK_COST_MICRO_USDC")),
    costBufferBps: integer("COST_BUFFER_BPS"),
    quoteTtlMs: integer("QUOTE_TTL_SECONDS") * 1000,
    maxOpenQuotes: integer("MAX_OPEN_QUOTES"),
    retentionMs: integer("QUOTE_RETENTION_DAYS") * 86_400_000,
    maxFailedOnChain: integer("MAX_FAILED_ON_CHAIN"),
    maxPriceAgeSeconds: integer("MAX_PRICE_AGE_SECONDS"),
    upstreamTimeoutMs: integer("UPSTREAM_TIMEOUT_MS"),
  };

  if (usdcMint && customers) {
    for (const customer of customers.list) {
      if ([customer.feePayer, customer.paymentAccount, customer.payoutAccount].some((key) => key.equals(usdcMint))) {
        problems.push("customers: an account of a customer is the USDC mint itself");
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  return cfg;
}
