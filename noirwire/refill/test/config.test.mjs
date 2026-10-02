import assert from "node:assert/strict";
import { test } from "node:test";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { base58Encode, formatUnits, parseUnits } from "../src/units.mjs";

const wallet = Keypair.generate();
const feePayer = Keypair.generate().publicKey.toBase58();
const base = {
  RPC_URL: "https://rpc.example",
  PAYMENT_WALLET_PRIVATE_KEY: JSON.stringify([...wallet.secretKey]),
  FEE_PAYER: feePayer,
  MAX_USDC_PER_SOL: "300",
};
const refuses = (env, pattern) => assert.throws(() => loadConfig({ ...base, ...env }), (error) => error instanceof ConfigError && pattern.test(error.message));

test("defaults are the documented numbers", () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.targetLamports, 100_000_000n);
  assert.equal(cfg.refillBelowLamports, 30_000_000n);
  assert.equal(cfg.reserveLamports, 10_000_000n);
  assert.equal(cfg.maxUsdcPerRun, 15_000_000n);
  assert.equal(cfg.maxMicroUsdcPerSol, 300_000_000n);
  assert.equal(cfg.feePayerUnseenOk, false);
  assert.equal(cfg.usdcFloor, 1_000_000n);
  assert.equal(cfg.maxRunsPerDay, 6);
  assert.equal(cfg.maxSlippageBps, 100);
  assert.equal(cfg.dryRun, false);
  assert.equal(cfg.jupiterApiKey, null);
  assert.ok(cfg.wallet.publicKey.equals(wallet.publicKey));
});

test("the key is accepted as base58 too", () => {
  const cfg = loadConfig({ ...base, PAYMENT_WALLET_PRIVATE_KEY: base58Encode(wallet.secretKey) });
  assert.ok(cfg.wallet.publicKey.equals(wallet.publicKey));
});

test("an empty variable falls back to its default", () => {
  assert.equal(loadConfig({ ...base, TARGET_SOL: "  " }).targetLamports, 100_000_000n);
});

test("refuses a target at or below the threshold", () => {
  refuses({ TARGET_SOL: "0.03", REFILL_BELOW_SOL: "0.03" }, /REFILL_BELOW_SOL/);
  refuses({ TARGET_SOL: "0.02" }, /REFILL_BELOW_SOL/);
});

test("refuses caps of zero", () => {
  refuses({ MAX_USDC_PER_RUN: "0" }, /MAX_USDC_PER_RUN/);
  refuses({ MAX_RUNS_PER_DAY: "0" }, /MAX_RUNS_PER_DAY/);
  refuses({ MAX_SLIPPAGE_BPS: "0" }, /MAX_SLIPPAGE_BPS/);
  refuses({ TARGET_SOL: "0" }, /TARGET_SOL/);
});

test("refuses a fee payer that is the payment wallet", () => {
  refuses({ FEE_PAYER: wallet.publicKey.toBase58() }, /payment wallet itself/);
});

test("refuses a fee payer that is not a wallet address", () => {
  // A token account address: real, but derived, so off the curve.
  const tokenAccount = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
  refuses({ FEE_PAYER: tokenAccount.toBase58() }, /off curve/);
  refuses({ FEE_PAYER: "not-a-key" }, /FEE_PAYER/);
  refuses({ FEE_PAYER: "" }, /FEE_PAYER/);
});

test("refuses nonsense numbers and oversized settings", () => {
  refuses({ TARGET_SOL: "abc" }, /TARGET_SOL/);
  refuses({ TARGET_SOL: "-1" }, /TARGET_SOL/);
  refuses({ TARGET_SOL: "1e3" }, /TARGET_SOL/);
  refuses({ TARGET_SOL: "50" }, /ceiling/);
  refuses({ TARGET_SOL: "0.6" }, /ceiling/);
  refuses({ MAX_USDC_PER_RUN: "100000" }, /ceiling/);
  refuses({ MAX_SLIPPAGE_BPS: "5000" }, /MAX_SLIPPAGE_BPS/);
  refuses({ MAX_RUNS_PER_DAY: "2.5" }, /MAX_RUNS_PER_DAY/);
  refuses({ PAYMENT_WALLET_SOL_RESERVE: "0" }, /RESERVE/);
  refuses({ DRY_RUN: "maybe" }, /DRY_RUN/);
});

test("refuses a missing RPC or key, and never echoes the key", () => {
  refuses({ RPC_URL: "" }, /RPC_URL/);
  refuses({ PAYMENT_WALLET_PRIVATE_KEY: "" }, /PAYMENT_WALLET_PRIVATE_KEY/);
  const secret = "5JbadKeyMaterialThatMustNotAppear";
  try {
    loadConfig({ ...base, PAYMENT_WALLET_PRIVATE_KEY: secret });
    assert.fail("accepted a bad key");
  } catch (error) {
    assert.ok(!error.message.includes(secret));
  }
});

test("MAX_USDC_PER_SOL has no default: the job refuses to start without it", () => {
  const { MAX_USDC_PER_SOL: _omitted, ...without } = base;
  assert.throws(() => loadConfig(without), (error) => error instanceof ConfigError && /MAX_USDC_PER_SOL: required/.test(error.message));
  refuses({ MAX_USDC_PER_SOL: " " }, /MAX_USDC_PER_SOL: required/);
  refuses({ MAX_USDC_PER_SOL: "0" }, /MAX_USDC_PER_SOL/);
  refuses({ MAX_USDC_PER_SOL: "5000" }, /MAX_USDC_PER_SOL/);
  refuses({ MAX_USDC_PER_SOL: "cheap" }, /MAX_USDC_PER_SOL/);
});

test("FEE_PAYER_UNSEEN_OK counts only when it repeats FEE_PAYER exactly", () => {
  assert.equal(loadConfig({ ...base, FEE_PAYER_UNSEEN_OK: feePayer }).feePayerUnseenOk, true);
  refuses({ FEE_PAYER_UNSEEN_OK: "1" }, /FEE_PAYER_UNSEEN_OK/);
  refuses({ FEE_PAYER_UNSEEN_OK: "true" }, /FEE_PAYER_UNSEEN_OK/);
  refuses({ FEE_PAYER_UNSEEN_OK: wallet.publicKey.toBase58() }, /FEE_PAYER_UNSEEN_OK/);
});

test("no raw environment value ever appears in an error", () => {
  // A secret pasted into the wrong variable must not be printed back.
  const secret = base58Encode(Keypair.generate().secretKey);
  for (const name of ["TARGET_SOL", "REFILL_BELOW_SOL", "MAX_USDC_PER_RUN", "MAX_RUNS_PER_DAY", "USDC_FLOOR", "PAYMENT_WALLET_SOL_RESERVE", "MAX_SLIPPAGE_BPS", "MAX_USDC_PER_SOL", "DRY_RUN", "FEE_PAYER", "FEE_PAYER_UNSEEN_OK", "RPC_URL"]) {
    try {
      loadConfig({ ...base, [name]: secret });
      assert.fail(`${name} accepted a secret key as its value`);
    } catch (error) {
      assert.ok(error instanceof ConfigError, name);
      assert.ok(!error.message.includes(secret) && !error.message.includes(secret.slice(0, 12)), `${name} echoed its value`);
    }
  }
});

test("reports every problem at once", () => {
  refuses({ RPC_URL: "", TARGET_SOL: "x", MAX_RUNS_PER_DAY: "0" }, /RPC_URL.*TARGET_SOL.*MAX_RUNS_PER_DAY/s);
});

test("decimal parsing is exact", () => {
  assert.equal(parseUnits("0.1", 9), 100_000_000n);
  assert.equal(parseUnits("25", 6), 25_000_000n);
  assert.equal(formatUnits(30_000_000n, 9), "0.03");
  assert.equal(formatUnits(-5_000n, 9), "-0.000005");
  assert.throws(() => parseUnits("0.0000001", 6));
});
