import assert from "node:assert/strict";
import { test } from "node:test";
import { planSwap, planTransfer } from "../src/plan.mjs";
import { PRICE, testConfig } from "./helpers.mjs";

const cfg = testConfig();
const sol = (text) => BigInt(Math.round(Number(text) * 1e9));
const usdc = (text) => BigInt(Math.round(Number(text) * 1e6));
const swap = (state) => planSwap({ swapsLast24h: 0, microUsdcPerSol: PRICE, usdc: usdc(100), ...state }, cfg);

test("above the threshold: no transfer when the wallet holds only its reserve, and no swap", () => {
  const state = { feePayerLamports: sol(0.05), walletLamports: sol(0.01) };
  assert.equal(planTransfer(state, cfg), 0n);
  assert.deepEqual(swap(state), { action: "none" });
});

test("a full fee payer takes nothing, however much the wallet holds", () => {
  assert.equal(planTransfer({ feePayerLamports: sol(0.1), walletLamports: sol(5) }, cfg), 0n);
  assert.equal(planTransfer({ feePayerLamports: sol(0.3), walletLamports: sol(5) }, cfg), 0n);
});

test("half-finished run: the transfer tops the fee payer up to its target and no further, however much the wallet holds", () => {
  // A swap landed (0.09 SOL arrived) and the run died before the transfer.
  const state = { feePayerLamports: sol(0.02), walletLamports: sol(0.1) };
  assert.equal(planTransfer(state, cfg), sol(0.08));
  // The wallet holding far more than is needed does not raise the transfer past the target.
  assert.equal(planTransfer({ ...state, walletLamports: sol(3) }, cfg), sol(0.08));
  const after = { feePayerLamports: sol(0.1), walletLamports: sol(0.02) };
  assert.deepEqual(swap(after), { action: "none" });
});

test("the transfer never takes the wallet below its reserve", () => {
  assert.equal(planTransfer({ feePayerLamports: 0n, walletLamports: sol(0.04) }, cfg), sol(0.03));
  assert.equal(planTransfer({ feePayerLamports: 0n, walletLamports: sol(0.005) }, cfg), 0n);
});

test("dust is not worth a fee", () => {
  assert.equal(planTransfer({ feePayerLamports: sol(0.0999), walletLamports: sol(1) }, cfg), 0n);
  assert.equal(planTransfer({ feePayerLamports: sol(0.05), walletLamports: sol(0.0105) }, cfg), 0n);
});

test("below the threshold: the swap is sized to reach the target", () => {
  // 0.07 SOL missing, at 150 USDC per SOL, plus the 1% slippage allowance.
  const plan = swap({ feePayerLamports: sol(0.03), walletLamports: sol(0.01) });
  assert.equal(plan.action, "swap");
  assert.equal(plan.needLamports, sol(0.07));
  assert.equal(plan.usdcAmount, usdc(10.605));
  assert.equal(plan.capped, false);
});

test("the wallet's own reserve is topped up from the same swap", () => {
  const plan = swap({ feePayerLamports: sol(0.03), walletLamports: 0n });
  assert.equal(plan.needLamports, sol(0.08));
  assert.equal(plan.usdcAmount, usdc(12.12));
});

test("the per-run cap bounds the swap", () => {
  const small = testConfig({ MAX_USDC_PER_RUN: "5" });
  const plan = planSwap(
    { feePayerLamports: 0n, walletLamports: 0n, usdc: usdc(100), swapsLast24h: 0, microUsdcPerSol: PRICE },
    small,
  );
  assert.equal(plan.usdcAmount, usdc(5));
  assert.equal(plan.capped, true);
});

test("the USDC floor is never spent", () => {
  // 4 USDC held, 1 USDC floor: only 3 may go.
  const plan = swap({ feePayerLamports: 0n, walletLamports: sol(0.01), usdc: usdc(4) });
  assert.equal(plan.usdcAmount, usdc(3));
  assert.equal(plan.capped, true);
});

test("with nothing above the floor the swap is refused, not shrunk to nothing", () => {
  for (const held of [0, 1, 1.4]) {
    const plan = swap({ feePayerLamports: 0n, walletLamports: sol(0.01), usdc: usdc(held) });
    assert.equal(plan.action, "refuse");
    assert.equal(plan.code, "no_usdc");
  }
});

test("the daily cap refuses the swap", () => {
  const state = { feePayerLamports: 0n, walletLamports: sol(0.01) };
  assert.equal(swap({ ...state, swapsLast24h: 5 }).action, "swap");
  const capped = swap({ ...state, swapsLast24h: 6 });
  assert.equal(capped.action, "refuse");
  assert.equal(capped.code, "daily_cap");
});

test("exactly at the threshold counts as below", () => {
  assert.equal(swap({ feePayerLamports: sol(0.03), walletLamports: sol(0.01) }).action, "swap");
  assert.equal(swap({ feePayerLamports: sol(0.03) + 1n, walletLamports: sol(0.01) }).action, "none");
});
