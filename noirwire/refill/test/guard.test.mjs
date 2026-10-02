import assert from "node:assert/strict";
import { test } from "node:test";
import { createTransferCheckedInstruction } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Refusal } from "../src/errors.mjs";
import { checkOrder, checkTransaction, USDC } from "../src/guard.mjs";
import { readReferencePrice } from "../src/price.mjs";
import { fakeConn, fillInstruction, fillTransaction, MAKER, NOW, order, PRICE, pythAccount, SOL, testConfig, tokenAccountData, usdcAccount } from "./helpers.mjs";

const cfg = testConfig();
const wallet = cfg.wallet.publicKey;
const AMOUNT = 10_605_000n; // 10.605 USDC
const FAIR = (AMOUNT * SOL) / PRICE; // 0.0707 SOL
const request = { usdcAmount: AMOUNT, taker: wallet };
const stranger = Keypair.generate().publicKey;

const refusedWith = (code) => (error) => error instanceof Refusal && error.code === code;
const quoteFor = (fields, config = cfg, price = PRICE) => checkOrder(order(cfg, AMOUNT, fields), request, price, config, NOW);

/** Simulation of an honest fill: USDC out and SOL in exactly as quoted, no fee for the taker. */
const honest = (state) => ({ walletLamports: state.walletLamports + FAIR, usdc: state.usdc - AMOUNT });
const start = () => ({ feePayerLamports: 0n, walletLamports: 10_000_000n, usdc: 50_000_000n });
const check = (transaction, simulate = honest, options = {}, config = cfg) =>
  checkTransaction(fakeConn(cfg, start(), { simulate, ...options }), quoteFor({ transaction }), wallet, config, NOW);
const fill = (fields = {}) => fillTransaction(cfg, { input: AMOUNT, output: FAIR, ...fields });

test("an honest market-maker order passes and reports what the simulation delivered", async () => {
  assert.deepEqual(await check(fill()), { lamports: FAIR, usdcSpent: AMOUNT, expireAt: NOW + 55 });
});

test("hostile quote: wrong mint", () => {
  assert.throws(() => quoteFor({ outputMint: USDC.toBase58() }), refusedWith("wrong_mint"));
  assert.throws(() => quoteFor({ inputMint: stranger.toBase58() }), refusedWith("wrong_mint"));
});

test("an aggregator route is refused, whatever it promises", () => {
  assert.throws(() => quoteFor({ swapType: "aggregator", router: "metis" }), refusedWith("not_market_maker"));
  assert.throws(() => quoteFor({ router: "dflow" }), refusedWith("not_market_maker"));
  assert.throws(() => quoteFor({ swapType: undefined }), refusedWith("not_market_maker"));
});

test("hostile quote: a different amount, taker or mode than requested", () => {
  assert.throws(() => quoteFor({ inAmount: (AMOUNT + 1n).toString() }), refusedWith("wrong_amount"));
  assert.throws(() => quoteFor({ inAmount: (AMOUNT - 1n).toString() }), refusedWith("wrong_amount"));
  assert.throws(() => quoteFor({ taker: stranger.toBase58() }), refusedWith("wrong_taker"));
  assert.throws(() => quoteFor({ swapMode: "ExactOut" }), refusedWith("bad_quote"));
});

test("hostile quote: output below the reference price by more than the slippage", () => {
  const floor = (FAIR * 9_900n) / 10_000n;
  assert.equal(quoteFor({ otherAmountThreshold: floor.toString() }).minLamports, floor);
  assert.throws(() => quoteFor({ otherAmountThreshold: (floor - 1n).toString() }), refusedWith("below_reference_price"));
  // A good headline output does not excuse a low guaranteed minimum.
  assert.throws(() => quoteFor({ outAmount: FAIR.toString(), otherAmountThreshold: "1" }), refusedWith("above_price_bound"));
});

test("the operator's MAX_USDC_PER_SOL bounds the quote even when the reference price agrees with it", () => {
  // The reference says SOL costs 400 USDC and the quote matches it exactly: both are refused
  // by a 300 USDC bound, which depends on neither.
  const dear = 400_000_000n;
  const lamports = (AMOUNT * SOL) / dear;
  assert.throws(() => checkOrder(order(cfg, AMOUNT, { lamports }), request, dear, cfg, NOW), refusedWith("price_above_bound"));
  // And with an honest reference, a quote paying more than the bound is refused on its own.
  const loose = testConfig({ MAX_SLIPPAGE_BPS: "500", MAX_USDC_PER_SOL: "151" });
  const atBound = (AMOUNT * SOL) / 151_000_000n + 1n;
  assert.equal(checkOrder(order(cfg, AMOUNT, { lamports: atBound }), request, PRICE, loose, NOW).minLamports, atBound);
  assert.throws(() => checkOrder(order(cfg, AMOUNT, { lamports: atBound - 1n }), request, PRICE, loose, NOW), refusedWith("above_price_bound"));
});

test("hostile quote: missing or malformed numbers, no minimum, expired, no transaction", () => {
  assert.throws(() => quoteFor({ otherAmountThreshold: undefined }), refusedWith("bad_quote"));
  assert.throws(() => quoteFor({ outAmount: "12.5" }), refusedWith("bad_quote"));
  assert.throws(() => quoteFor({ inAmount: 10_605_000 }), refusedWith("bad_quote"));
  assert.throws(() => quoteFor({ requestId: "" }), refusedWith("bad_quote"));
  assert.throws(() => quoteFor({ expireAt: String(NOW - 1) }), refusedWith("expired_quote"));
  assert.throws(() => quoteFor({ transaction: null, errorCode: 2, errorMessage: "Missing associated token account" }), refusedWith("not_built"));
});

// The finding this exists for: the JSON quote binds nobody. The fill instruction does.

test("a transaction whose fill pays less than the quote is refused, even if a simulation would pass", async () => {
  const short = fill({ output: FAIR / 2n });
  let simulated = false;
  const conn = fakeConn(cfg, start(), { simulate: (s) => ((simulated = true), honest(s)) });
  await assert.rejects(checkTransaction(conn, quoteFor({ transaction: short }), wallet, cfg, NOW), refusedWith("fill_mismatch"));
  assert.equal(simulated, false);
});

test("a transaction whose fill takes more USDC than the quote is refused", async () => {
  await assert.rejects(check(fill({ input: AMOUNT + 1n })), refusedWith("fill_mismatch"));
  await assert.rejects(check(fill({ input: AMOUNT * 100n })), refusedWith("fill_mismatch"));
});

test("a fill that is not this wallet's USDC for SOL, or cannot be decoded, is refused", async () => {
  await assert.rejects(check(fill({ inputMint: stranger })), refusedWith("bad_fill"));
  await assert.rejects(check(fill({ outputMint: USDC })), refusedWith("bad_fill"));
  await assert.rejects(check(fill({ inputAccount: stranger })), refusedWith("bad_fill"));
  await assert.rejects(check(fill({ discriminator: Buffer.from("0102030405060708", "hex") })), refusedWith("bad_fill"));
  await assert.rejects(check(fill({ expireAt: NOW - 1 })), refusedWith("expired_quote"));
  const two = [fillInstruction(cfg, { input: AMOUNT, output: FAIR }), fillInstruction(cfg, { input: AMOUNT, output: FAIR })];
  await assert.rejects(check(fillTransaction(cfg, { fills: two })), refusedWith("bad_fill"));
  // With no fill at all the wallet is not even a signer.
  await assert.rejects(check(fillTransaction(cfg, { fills: [] })), refusedWith("not_ours"));
});

test("hostile transaction: an extra program", async () => {
  const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("hi") });
  await assert.rejects(check(fill({ extra: [memo] })), refusedWith("program_not_allowed"));
});

test("hostile transaction: an aggregator's router program", async () => {
  const router = new TransactionInstruction({ programId: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"), keys: [], data: Buffer.from([1]) });
  await assert.rejects(check(fill({ extra: [router] })), refusedWith("program_not_allowed"));
});

test("hostile transaction: a top-level SOL transfer, token transfer or durable nonce", async () => {
  const drain = SystemProgram.transfer({ fromPubkey: wallet, toPubkey: stranger, lamports: 1 });
  await assert.rejects(check(fill({ extra: [drain] })), refusedWith("program_not_allowed"));
  const transfer = createTransferCheckedInstruction(usdcAccount(cfg), USDC, stranger, wallet, 1n, 6);
  await assert.rejects(check(fill({ extra: [transfer] })), refusedWith("program_not_allowed"));
  const nonce = SystemProgram.nonceAdvance({ noncePubkey: stranger, authorizedPubkey: wallet });
  await assert.rejects(check(fill({ extra: [nonce] })), refusedWith("program_not_allowed"));
});

test("hostile transaction: not ours, or one this wallet would pay the fee for", async () => {
  const other = testConfig();
  const foreign = fillTransaction(other, { input: AMOUNT, output: FAIR });
  await assert.rejects(check(foreign), refusedWith("not_ours"));
  await assert.rejects(check(fill({ payer: wallet })), refusedWith("not_market_maker"));
});

test("simulation: debit above the quote", async () => {
  const greedy = (s) => ({ walletLamports: s.walletLamports + FAIR, usdc: s.usdc - AMOUNT - 1n });
  await assert.rejects(check(fill(), greedy), refusedWith("overspend"));
});

test("simulation: less SOL than the guaranteed minimum, or SOL left wrapped", async () => {
  const stingy = (s) => ({ walletLamports: s.walletLamports + FAIR - 1n, usdc: s.usdc - AMOUNT });
  await assert.rejects(check(fill(), stingy), refusedWith("under_delivery"));
  const wrapped = (s) => ({ walletLamports: s.walletLamports, usdc: s.usdc - AMOUNT });
  await assert.rejects(check(fill(), wrapped), refusedWith("under_delivery"));
});

test("simulation: the operator's price bound holds on what actually arrives", async () => {
  // Quote and fill are consistent with each other at 280 USDC per SOL, and a 500 bps slippage
  // against a (wrong) 290 reference would let it through. The 250 bound does not.
  const lamports = (AMOUNT * SOL) / 280_000_000n;
  const tight = testConfig({ MAX_USDC_PER_SOL: "250", MAX_SLIPPAGE_BPS: "500" });
  const transaction = fillTransaction(cfg, { input: AMOUNT, output: lamports });
  const quote = { inAmount: AMOUNT, minLamports: lamports, transaction };
  const conn = fakeConn(cfg, start(), { simulate: (s) => ({ walletLamports: s.walletLamports + lamports, usdc: s.usdc - AMOUNT }) });
  await assert.rejects(checkTransaction(conn, quote, wallet, tight, NOW), refusedWith("above_price_bound"));
});

test("simulation: another token account of the wallet is debited or closed", async () => {
  const mint = Keypair.generate().publicKey;
  const other = { pubkey: Keypair.generate().publicKey, data: tokenAccountData(mint, wallet, 500n) };
  const tx = fill({ extraKeys: [other.pubkey] });
  const options = { otherTokenAccounts: [other] };
  assert.equal((await check(tx, (s) => ({ ...honest(s), others: [other] }), options)).usdcSpent, AMOUNT);
  const debited = (s) => ({ ...honest(s), others: [{ ...other, data: tokenAccountData(mint, wallet, 499n) }] });
  await assert.rejects(check(tx, debited, options), refusedWith("other_asset_debited"));
  await assert.rejects(check(tx, (s) => ({ ...honest(s), others: [] }), options), refusedWith("account_closed"));
});

test("simulation: the wallet's owner changes", async () => {
  await assert.rejects(check(fill(), (s) => ({ ...honest(s), walletOwner: stranger.toBase58() })), refusedWith("owner_changed"));
});

test("simulation: the USDC account gains a delegate, changes owner or is closed", async () => {
  const delegated = (s) => ({ ...honest(s), usdcData: tokenAccountData(USDC, wallet, s.usdc - AMOUNT, { delegate: stranger }) });
  await assert.rejects(check(fill(), delegated), refusedWith("control_changed"));
  const reowned = (s) => ({ ...honest(s), usdcData: tokenAccountData(USDC, stranger, s.usdc - AMOUNT) });
  await assert.rejects(check(fill(), reowned), refusedWith("control_changed"));
  await assert.rejects(check(fill(), (s) => ({ ...honest(s), usdcData: null })), refusedWith("account_closed"));
});

test("simulation: the swap would fail on chain", async () => {
  await assert.rejects(check(fill(), (s) => ({ ...honest(s), err: { InstructionError: [2, "Custom"] } })), refusedWith("would_fail"));
});

// The reference price.

const priceFrom = (pyth) => readReferencePrice(fakeConn(cfg, start(), { pyth }), NOW);

test("the Pyth price is decoded to raw USDC units per SOL", async () => {
  assert.equal(await priceFrom(pythAccount()), PRICE);
  assert.equal(await priceFrom(pythAccount({ price: 117_976_067n })), 117_976_067n);
});

test("a stale, unverified, foreign, wrong-feed or wide price is refused", async () => {
  const noPrice = refusedWith("no_price");
  assert.equal(await priceFrom(pythAccount({ age: 120 })), PRICE);
  await assert.rejects(priceFrom(pythAccount({ age: 121 })), noPrice);
  await assert.rejects(priceFrom(pythAccount({ age: -600 })), noPrice);
  await assert.rejects(priceFrom(pythAccount({ verified: 0 })), noPrice);
  await assert.rejects(priceFrom(pythAccount({ owner: stranger.toBase58() })), noPrice);
  await assert.rejects(priceFrom(pythAccount({ feed: "aa".repeat(32) })), noPrice);
  await assert.rejects(priceFrom(pythAccount({ confidence: 400_000_000n })), noPrice);
  await assert.rejects(priceFrom(pythAccount({ price: 0n })), noPrice);
  await assert.rejects(priceFrom(null), noPrice);
  assert.ok(MAKER);
});
