import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import { Refusal, UnknownOutcome } from "../src/errors.mjs";
import { createService } from "../src/service.mjs";
import { LAST_VALID_BLOCK_HEIGHT, makeWorld, tokenAccount, USDC } from "./helpers.mjs";

// What the relayer can lose to transactions that are signed and then do not pay: one
// unsettled transaction per source account, the balance checks, the pause after failures
// on chain, and the record that lets a quote answer from the chain instead of signing again.

const refuses = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `threw ${error?.stack ?? error}`);
    assert.equal(error.code, code);
    return true;
  });
const stateOf = async (world, prepared) => (await world.store.getQuote(prepared.quoteId)).state;
/** A world whose chain shows nothing of a broadcast until the test says so. */
function slowWorld(overrides) {
  const world = makeWorld(overrides);
  world.conn.options.autoLand = false;
  return world;
}
/** Another USDC account of the same user, funded. */
function anotherSource(world) {
  const source = Keypair.generate().publicKey;
  world.accounts.set(source.toBase58(), tokenAccount(USDC, world.user.publicKey));
  return source.toBase58();
}
const failOnChain = (world, signature) => world.land(signature, { err: { InstructionError: [1, { Custom: 1 }] } });
const expireBlockhash = (world) => void (world.conn.options.blockHeight = LAST_VALID_BLOCK_HEIGHT + 1);

// ── One unsettled transaction per source account ────────────────────────────────────────

test("many quotes that spend one balance: one is signed, the rest are refused before Kora", async () => {
  const world = slowWorld();
  const quotes = [];
  for (let i = 0; i < 6; i += 1) quotes.push(await world.prepare({ amountMicroUsdc: String(999_000_000 + i) }));
  const results = await Promise.allSettled(quotes.map((prepared) => world.sign(prepared)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "source_busy").length, 5);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  // One after the other is refused the same way, and consumes no budget.
  await refuses(world.sign(quotes.find((_, index) => results[index].status === "rejected")), "source_busy");
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
});

test("prepare and sign refuse a source while its transaction is unsettled, and accept it once it landed", async () => {
  const world = slowWorld();
  const [first, second] = [await world.prepare(), await world.prepare()];
  const { signature } = await world.sign(first);
  await refuses(world.prepare(), "source_busy");
  await refuses(world.sign(second), "source_busy");
  // Seen by one node but not confirmed: still unsettled.
  world.land(signature, { confirmationStatus: "processed" });
  await refuses(world.prepare(), "source_busy");
  // Another source account of the same user is not held.
  assert.ok(await world.prepare({ source: anotherSource(world) }));

  world.land(signature);
  assert.ok((await world.sign(second)).signature);
  assert.equal(await stateOf(world, first), "landed");
  assert.equal(await world.store.failures("acme"), 0);
});

test("every unsettled state holds the source: signing, signed, sent and unknown", async () => {
  const hold = async (arrange) => {
    const world = slowWorld();
    const [first, second] = [await world.prepare(), await world.prepare()];
    await arrange(world, first);
    await refuses(world.sign(second), "source_busy");
    await refuses(world.prepare(), "source_busy");
    return stateOf(world, first);
  };
  assert.equal(await hold((world, first) => world.store.beginSign({ quoteId: first.quoteId, customerId: "acme", nowMs: world.clock.now(), day: "2027-01-15", cost: 1_600n, limits: world.customer.budgets })), "signing");
  assert.equal(await hold(async (world, first) => {
    world.store.finishSign = async () => {
      throw new Error("database gone");
    };
    await world.sign(first);
  }), "signed");
  assert.equal(await hold((world, first) => world.sign(first)), "sent");
  assert.equal(await hold(async (world, first) => {
    world.conn.options.onSend = () => {
      throw new Error("socket hang up");
    };
    await world.sign(first).catch(() => {});
  }), "unknown");
});

test("a transaction that never landed frees its source once its blockhash has expired", async () => {
  const world = slowWorld();
  const first = await world.prepare();
  await world.sign(first);
  // The last valid height itself is not past it.
  world.conn.options.blockHeight = LAST_VALID_BLOCK_HEIGHT;
  await refuses(world.prepare(), "source_busy");
  assert.deepEqual(world.conn.calls.filter((call) => call.name === "getBlockHeight").at(-1).args, ["finalized"]);
  expireBlockhash(world);
  assert.ok(await world.prepare());
  assert.equal(await stateOf(world, first), "expired");
  // Nothing landed, so the relayer paid nothing: not a failure on chain.
  assert.equal(await world.store.failures("acme"), 0);
  await refuses(world.sign(first), "transaction_expired");
});

test("an outcome unknown without a signature frees its source only when the blockhash expired", async () => {
  const world = slowWorld();
  const first = await world.prepare();
  world.koraState.signNetworkError = true;
  await assert.rejects(world.sign(first), UnknownOutcome);
  world.koraState.signNetworkError = false;
  await refuses(world.prepare(), "source_busy");
  expireBlockhash(world);
  assert.ok(await world.prepare());
  assert.equal(await stateOf(world, first), "expired");
});

test("a claim abandoned before Kora answered holds the source until it is stale and expired", async () => {
  const world = slowWorld();
  const first = await world.prepare();
  await world.store.beginSign({ quoteId: first.quoteId, customerId: "acme", nowMs: world.clock.now(), day: "2027-01-15", cost: 1_600n, limits: world.customer.budgets });
  expireBlockhash(world);
  // Still inside the time a sign may take: it may be running in another process.
  await refuses(world.prepare(), "source_busy");
  assert.equal(world.conn.count("getBlockHeight"), 0);
  world.clock.advance(120_001);
  assert.ok(await world.prepare());
  assert.equal(await stateOf(world, first), "expired");
});

test("the height is read before the statuses, so a late landing is never called expired", async () => {
  const world = slowWorld();
  const first = await world.prepare();
  const { signature } = await world.sign(first);
  expireBlockhash(world);
  world.land(signature);
  assert.ok(await world.prepare());
  assert.equal(await stateOf(world, first), "landed");
  const order = world.conn.calls.map((call) => call.name).filter((name) => ["getBlockHeight", "getSignatureStatuses"].includes(name));
  assert.deepEqual(order, ["getBlockHeight", "getSignatureStatuses"]);
  assert.deepEqual(world.conn.calls.find((call) => call.name === "getSignatureStatuses").args, [[signature], { searchTransactionHistory: true }]);
});

test("when the chain cannot say what became of a transaction, its source stays refused", async () => {
  const world = slowWorld();
  const first = await world.prepare();
  const second = await world.prepare();
  await world.sign(first);
  world.conn.options.failSettlement = true;
  await refuses(world.prepare(), "chain_unavailable");
  await refuses(world.sign(second), "chain_unavailable");
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(await stateOf(world, first), "sent");
});

test("a source is held across customers: the store, not the service, refuses the claim", async () => {
  const world = slowWorld();
  const first = await world.prepare();
  const second = await world.prepare();
  // The check before the claim is skipped: the claim itself must still refuse.
  world.store.unsettledForSource = async () => [];
  await world.sign(first);
  const error = await world.sign(second).catch((thrown) => thrown);
  assert.equal(error.code, "source_busy");
  assert.equal(error.detail, "at_claim");
  assert.equal(world.fetchFn.count("signTransaction"), 1);
});

// ── The balance ─────────────────────────────────────────────────────────────────────────

test("the source must hold the transfer plus both payments, at prepare and again at sign", async () => {
  const world = makeWorld();
  const fund = (amount) => world.accounts.set(world.userUsdc.toBase58(), tokenAccount(USDC, world.user.publicKey, { amount }));
  // 5,000,000 and the payments of 1,760 and 640.
  fund(4_999_999n);
  await refuses(world.prepare(), "insufficient_balance");
  assert.equal(world.fetchFn.requests.length, 0);
  // Enough for the transfer, one unit short of the payments, which are known only once priced.
  fund(5_002_399n);
  await refuses(world.prepare(), "insufficient_balance");
  fund(5_002_400n);
  const prepared = await world.prepare();
  // The user moves one unit away after the quote.
  fund(5_002_399n);
  await refuses(world.sign(prepared), "insufficient_balance");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  assert.equal(await stateOf(world, prepared), "prepared");
  fund(5_002_400n);
  assert.ok((await world.sign(prepared)).signature);
});

// ── Failures on chain pause the customer ────────────────────────────────────────────────

test("a customer is paused at the configured number of failures on chain, until an operator resets it", async () => {
  const world = slowWorld({ env: { MAX_FAILED_ON_CHAIN: "2" } });
  const failOne = async () => {
    const prepared = await world.prepare();
    const { signature } = await world.sign(prepared);
    failOnChain(world, signature);
    return prepared;
  };
  const open = await world.prepare({ source: anotherSource(world) });
  const first = await failOne();
  // The next prepare settles the first, counts it, and is still allowed.
  const second = await failOne();
  assert.equal(await stateOf(world, first), "failed_on_chain");
  assert.equal(await world.store.failures("acme"), 1);

  // This one settles the second, which reaches the threshold.
  const requests = world.fetchFn.requests.length;
  const error = await world.prepare().catch((thrown) => thrown);
  assert.equal(error.code, "customer_paused");
  assert.equal(error.status, 403);
  assert.equal(await world.store.failures("acme"), 2);
  await refuses(world.sign(open), "customer_paused");
  assert.equal(world.fetchFn.requests.length, requests);
  // What already happened is still answered, from the record.
  await refuses(world.sign(second), "failed_on_chain");

  await world.store.resetFailures("acme");
  assert.ok(await world.prepare());
});

test("a failure on a source that is never used again is still found and counted", async () => {
  const world = slowWorld({ env: { MAX_FAILED_ON_CHAIN: "1" } });
  const prepared = await world.prepare({ source: anotherSource(world) });
  const { signature } = await world.sign(prepared);
  failOnChain(world, signature);
  // A prepare from a different source: the sweep settles the old one first.
  await refuses(world.prepare(), "customer_paused");
  assert.equal(await stateOf(world, prepared), "failed_on_chain");
});

test("the sweep decides nothing: when it cannot run, prepare goes on", async () => {
  const world = slowWorld();
  await world.sign(await world.prepare({ source: anotherSource(world) }));
  world.conn.options.failSettlement = true;
  assert.ok(await world.prepare());
  world.conn.options.failSettlement = false;
  world.store.unsettledForCustomer = async () => {
    throw new Error("database gone");
  };
  assert.ok(await world.prepare({ source: anotherSource(world) }));
});

test("a transaction that landed, expired or was never broadcast is not a failure on chain", async () => {
  const world = slowWorld({ env: { MAX_FAILED_ON_CHAIN: "1" } });
  const { signature } = await world.sign(await world.prepare());
  world.land(signature);
  world.koraState.signError = true;
  await refuses(world.sign(await world.prepare()), "kora_refused");
  world.koraState.signError = false;
  await world.sign(await world.prepare());
  expireBlockhash(world);
  assert.ok(await world.prepare());
  assert.equal(await world.store.failures("acme"), 0);
});

// ── The signature is on record before the broadcast ─────────────────────────────────────

test("the signature is stored before the transaction is broadcast", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  let atBroadcast;
  world.conn.options.onSend = () => {
    // A synchronous peek at the in-memory store's record, at the moment of the broadcast.
    atBroadcast = world.store.getQuote(prepared.quoteId);
    return "accepted";
  };
  const { signature } = await world.sign(prepared);
  const stored = await atBroadcast;
  assert.deepEqual([stored.state, stored.signature], ["signed", signature]);
  assert.equal(await stateOf(world, prepared), "sent");
});

test("a signature that cannot be recorded is not broadcast", async () => {
  for (const markSigned of [async () => false, async () => { throw new Error("database gone"); }]) {
    const world = makeWorld();
    const prepared = await world.prepare();
    world.store.markSigned = markSigned;
    const error = await world.sign(prepared).catch((thrown) => thrown);
    assert.equal(error.code, "not_recorded");
    assert.equal(error.status, 503);
    assert.equal(world.conn.count("sendRawTransaction"), 0);
    // The claim stands, so the quote is never signed a second time.
    await refuses(world.sign(prepared), "sign_in_progress");
    assert.equal(world.fetchFn.count("signTransaction"), 1);
  }
});

test("after a crash between broadcast and record, a restarted gateway answers from the signature and the chain", async () => {
  const world = slowWorld();
  const prepared = await world.prepare();
  world.store.finishSign = async () => {
    throw new Error("process died here");
  };
  const { signature } = await world.sign(prepared);
  assert.equal(await stateOf(world, prepared), "signed");

  // A new process over the same store.
  delete world.store.finishSign;
  const restarted = createService(world.deps, world.cfg);
  const again = () => restarted.sign(world.customer, world.signedBody(prepared), {});
  await refuses(again(), "sign_in_progress");
  world.clock.advance(120_001);
  const pending = await again().catch((thrown) => thrown);
  assert.ok(pending instanceof UnknownOutcome);
  assert.equal(pending.signature, signature);
  assert.equal(pending.detail, "abandoned_broadcast");

  world.land(signature);
  assert.deepEqual(await again(), { signature });
  assert.equal(await stateOf(world, prepared), "landed");
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
});

test("a repeated sign answers from the chain: landed, failed on chain, expired, or still unknown", async () => {
  const lost = async () => {
    const world = slowWorld();
    const prepared = await world.prepare();
    world.conn.options.onSend = () => {
      throw new Error("socket hang up");
    };
    const { signature } = await world.sign(prepared).catch((thrown) => thrown);
    return { world, prepared, signature };
  };
  let { world, prepared, signature } = await lost();
  world.land(signature);
  assert.deepEqual(await world.sign(prepared), { signature });

  ({ world, prepared, signature } = await lost());
  failOnChain(world, signature);
  await refuses(world.sign(prepared), "failed_on_chain");
  assert.equal(await world.store.failures("acme"), 1);
  await refuses(world.sign(prepared), "failed_on_chain");
  assert.equal(await world.store.failures("acme"), 1);

  ({ world, prepared, signature } = await lost());
  expireBlockhash(world);
  await refuses(world.sign(prepared), "transaction_expired");

  ({ world, prepared, signature } = await lost());
  world.conn.options.failSettlement = true;
  const still = await world.sign(prepared).catch((thrown) => thrown);
  assert.ok(still instanceof UnknownOutcome);
  assert.equal(still.signature, signature);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
});

// ── Open quotes and the default buffer ──────────────────────────────────────────────────

test("a customer's open quotes are capped; signing one or letting one expire makes room", async () => {
  const world = makeWorld({ env: { MAX_OPEN_QUOTES: "2" } });
  const first = await world.prepare();
  await world.prepare();
  const error = await world.prepare().catch((thrown) => thrown);
  assert.equal(error.code, "too_many_open_quotes");
  assert.equal(error.status, 429);
  await world.sign(first);
  assert.ok(await world.prepare());
  await refuses(world.prepare(), "too_many_open_quotes");
  world.clock.advance(45_000);
  assert.ok(await world.prepare());
});

test("the default buffer lets the cost tick up inside a quote's lifetime", async () => {
  const world = makeWorld({ env: { COST_BUFFER_BPS: "" } });
  assert.equal(world.cfg.costBufferBps, 100);
  const prepared = await world.prepare();
  assert.equal(prepared.networkCostMicroUsdc, "1616");
  world.koraState.fee = 1_616n;
  assert.ok((await world.sign(prepared)).signature);
  const next = await world.prepare();
  world.koraState.fee = 1_634n;
  await refuses(world.sign(next), "cost_rose");
});
