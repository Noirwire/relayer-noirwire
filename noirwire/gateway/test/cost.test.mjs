import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { ComputeBudgetProgram, Keypair } from "@solana/web3.js";
import { networkCost } from "../src/cost.mjs";
import { KoraError, koraHeaders } from "../src/kora.mjs";
import { createPythPriceSource, PYTH_SOL_USD } from "../src/price.mjs";
import { inspect } from "../src/template.mjs";
import { encode, fakeConn, KORA_FEE, makeWorld, NOW, PRICE, pythAccount, usdcTransfer } from "./helpers.mjs";

const cost = (world, transaction = usdcTransfer(world)) =>
  networkCost(world.deps, world.cfg, world.customer, inspect(transaction, world.customer, world.cfg), encode(transaction), world.paymentWallet.publicKey);
const refuses = (promise, code, detail) =>
  assert.rejects(promise, (error) => error.code === code && (detail === undefined || error.detail === detail));

// ── The cost: the larger of Kora's estimate and the floor ────────────────────────────────

test("the cost is Kora's estimate when it is above the floor", async () => {
  const world = makeWorld();
  assert.equal(await cost(world), KORA_FEE); // floor is 1,500
});

test("the cost is the floor when Kora estimates less", async () => {
  const world = makeWorld();
  world.koraState.fee = 900n;
  assert.equal(await cost(world), 1_500n);
  world.koraState.fee = 0n;
  assert.equal(await cost(world), 1_500n);
});

test("the floor follows the transaction's own priority fee and the SOL price", async () => {
  const world = makeWorld();
  world.koraState.fee = 0n;
  const withFee = usdcTransfer(world, {
    before: [ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000n })],
  });
  // 10,000 + 15,000 lamports at 150 dollars.
  assert.equal(await cost(world, withFee), 3_750n);
  world.priceState.price = 300_000_000n;
  assert.equal(await cost(world, withFee), 7_500n);
});

test("refuses a cost above the cap, whichever side it comes from", async () => {
  const world = makeWorld();
  world.koraState.fee = world.cfg.maxNetworkCostMicroUsdc;
  assert.equal(await cost(world), world.cfg.maxNetworkCostMicroUsdc);
  world.koraState.fee = world.cfg.maxNetworkCostMicroUsdc + 1n;
  await refuses(cost(world), "cost_above_cap");
  world.koraState.fee = KORA_FEE;
  world.priceState.price = 20_000_000_000n; // SOL at 20,000 dollars: the floor alone is 200,000
  await refuses(cost(world), "cost_above_cap");
});

test("refuses when the price source fails, even though Kora answered", async () => {
  const world = makeWorld();
  world.priceState.priceFails = true;
  await refuses(cost(world), "price_unavailable");
});

test("refuses a price that is not a positive bigint", async () => {
  const world = makeWorld();
  for (const price of [0n, -1n, 150, "150000000", null]) {
    world.priceState.price = price;
    await refuses(cost(world), "price_unavailable", "not_a_price");
  }
});

test("refuses when Kora cannot estimate, even though the price is fine", async () => {
  for (const state of [{ estimateError: true }, { httpStatus: 500 }, { httpStatus: 401 }, { networkError: true }, { hang: "estimate" }, { fee: 1.5 }, { fee: -1 }, { fee: 2 ** 60 }]) {
    const world = makeWorld();
    Object.assign(world.koraState, state);
    await refuses(cost(world), "kora_unavailable");
  }
});

test("refuses a Kora that signs with another fee payer or collects elsewhere", async () => {
  const world = makeWorld();
  world.koraState.signer = Keypair.generate().publicKey;
  await refuses(cost(world), "kora_mismatch", "fee_payer");
  delete world.koraState.signer;
  world.koraState.paymentAddress = Keypair.generate().publicKey;
  await refuses(cost(world), "kora_mismatch", "payment_address");
});

// ── The Kora client ─────────────────────────────────────────────────────────────────────

test("authenticates to Kora exactly as Kora verifies: timestamp + body, hex HMAC-SHA256", async () => {
  const world = makeWorld();
  await cost(world);
  const [request] = world.fetchFn.requests;
  assert.equal(request.url, "http://kora.invalid/");
  assert.equal(request.headers["x-api-key"], world.secrets.koraApiKey);
  assert.equal(request.headers["x-timestamp"], String(NOW));
  // A fixed vector, independent of the helper: the same construction as Kora's middleware.
  const body = '{"jsonrpc":"2.0","id":1,"method":"getPayerSigner","params":[]}';
  const headers = koraHeaders({ koraApiKey: "key", koraHmacSecret: "secret" }, body, 1_700_000_000);
  assert.equal(headers["x-hmac-signature"], createHmac("sha256", "secret").update(`1700000000${body}`).digest("hex"));
  assert.match(headers["x-hmac-signature"], /^[0-9a-f]{64}$/);
});

test("asks Kora in the payment token, pinned to the customer's fee payer, without sig_verify", async () => {
  const world = makeWorld();
  const transaction = usdcTransfer(world);
  await cost(world, transaction);
  const [request] = world.fetchFn.requests;
  assert.equal(request.method, "estimateTransactionFee");
  assert.deepEqual(request.params, {
    transaction: encode(transaction),
    fee_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    signer_key: world.feePayer.publicKey.toBase58(),
    sig_verify: false,
  });
});

test("a Kora that never answers is given up on after the timeout", async () => {
  const world = makeWorld();
  world.koraState.hang = "estimate";
  const started = Date.now();
  await assert.rejects(world.kora.estimate(world.customer, "AAAA", "mint"), (error) => error instanceof KoraError && error.kind === "unreachable");
  assert.ok(Date.now() - started < 2_000);
});

test("Kora's refusal text never reaches the error", async () => {
  const world = makeWorld();
  world.koraState.estimateError = true;
  await assert.rejects(world.kora.estimate(world.customer, "AAAA", "mint"), (error) => {
    assert.equal(error.kind, "refused");
    assert.equal(error.rpcCode, -32000);
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes("must not leak"));
    return true;
  });
});

// ── The Pyth price source ───────────────────────────────────────────────────────────────

const pyth = (account, { maxAgeSeconds = 60, failReads = false } = {}) => {
  const conn = fakeConn(new Map(account ? [[PYTH_SOL_USD.toBase58(), account]] : []), { failReads });
  return createPythPriceSource(conn, { maxAgeSeconds }).microUsdPerSol(NOW);
};
const noPrice = (promise, detail) => refuses(promise, "price_unavailable", detail);

test("reads the SOL price from the Pyth account, in micro-dollars", async () => {
  assert.equal(await pyth(pythAccount()), PRICE);
  assert.equal(await pyth(pythAccount({ price: 87_654_321n })), 87_654_321n);
});

test("refuses a stale price, and one from the future", async () => {
  assert.equal(await pyth(pythAccount({ age: 60 })), PRICE);
  await noPrice(pyth(pythAccount({ age: 61 })), "stale");
  await noPrice(pyth(pythAccount({ age: 3_600 })), "stale");
  await noPrice(pyth(pythAccount({ age: -61 })), "stale");
  // The bound is the configured one.
  await noPrice(pyth(pythAccount({ age: 11 }), { maxAgeSeconds: 10 }), "stale");
});

test("refuses when the price account cannot be read or is not Pyth's", async () => {
  await noPrice(pyth(pythAccount(), { failReads: true }), "read_failed");
  await noPrice(pyth(null), "not_the_pyth_account");
  await noPrice(pyth(pythAccount({ owner: "11111111111111111111111111111111" })), "not_the_pyth_account");
  await noPrice(pyth({ ...pythAccount(), data: Buffer.alloc(50) }), "not_the_pyth_account");
});

test("refuses an unverified price, another feed, a wide confidence interval or a zero price", async () => {
  await noPrice(pyth(pythAccount({ verified: 0 })), "not_fully_verified");
  await noPrice(pyth(pythAccount({ feed: "ff".repeat(32) })), "wrong_feed");
  await noPrice(pyth(pythAccount({ confidence: PRICE * 100n })), "confidence_too_wide");
  await noPrice(pyth(pythAccount({ price: 0n })), "confidence_too_wide");
  await noPrice(pyth(pythAccount({ price: -5n })), "confidence_too_wide");
  await noPrice(pyth(pythAccount({ exponent: -40 })), "unexpected_exponent");
});
