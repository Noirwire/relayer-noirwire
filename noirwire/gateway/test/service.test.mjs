import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import { Refusal, UnknownOutcome } from "../src/errors.mjs";
import { base58Encode } from "../src/units.mjs";
import { encode, KORA_FEE, makeWorld, tokenAccount, usdcTransfer, USDC } from "./helpers.mjs";

const other = () => Keypair.generate().publicKey;
const refuses = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof Refusal, `threw ${error?.stack ?? error}`);
    assert.equal(error.code, code);
    return true;
  });
const unknown = (promise) => assert.rejects(promise, (error) => error instanceof UnknownOutcome);
const decode = (base64) => VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
const validSignature = (publicKey, message, signature) =>
  verify(null, message, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.toBuffer()]), format: "der", type: "spki" }), signature);
const transfersOf = (transaction) =>
  transaction.message.compiledInstructions
    .filter((instruction) => instruction.data[0] === 12)
    .map((instruction) => ({
      destination: transaction.message.staticAccountKeys[instruction.accountKeyIndexes[2]].toBase58(),
      amount: Buffer.from(instruction.data).readBigUInt64LE(1),
    }));

// ── /v1/prepare ─────────────────────────────────────────────────────────────────────────

test("prepare builds the whole transaction and quotes the split", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  assert.equal(prepared.networkCostMicroUsdc, "1600");
  assert.equal(prepared.platformMicroUsdc, "1760"); // B + S
  assert.equal(prepared.customerMicroUsdc, "640"); // C
  assert.equal(prepared.feePayer, world.feePayer.publicKey.toBase58());
  assert.equal(prepared.paymentAccount, world.paymentAccount.toBase58());
  assert.equal(prepared.payoutAccount, world.payoutAccount.toBase58());
  assert.equal(prepared.expiresAt, new Date(world.clock.now() + 45_000).toISOString());

  const transaction = decode(prepared.transaction);
  assert.ok(transaction.message.staticAccountKeys[0].equals(world.feePayer.publicKey));
  assert.equal(transaction.message.header.numRequiredSignatures, 2);
  assert.deepEqual(transfersOf(transaction), [
    { destination: world.recipientUsdc.toBase58(), amount: 5_000_000n },
    { destination: world.paymentAccount.toBase58(), amount: 1_760n },
    { destination: world.payoutAccount.toBase58(), amount: 640n },
  ]);
  // Nothing is signed and nothing is sent by preparing.
  assert.ok(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)));
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  assert.equal(world.conn.count("sendRawTransaction"), 0);
});

test("the quoted cost is the floor when it is above Kora's estimate", async () => {
  const world = makeWorld();
  world.koraState.fee = 1_000n;
  const prepared = await world.prepare();
  assert.equal(prepared.networkCostMicroUsdc, "1500");
  assert.equal(prepared.platformMicroUsdc, "1650");
  assert.equal(prepared.customerMicroUsdc, "600");
});

test("with a markup of zero the payout transfer is omitted", async () => {
  const world = makeWorld({ customer: { markupBps: 0 } });
  const prepared = await world.prepare();
  assert.equal(prepared.platformMicroUsdc, "1600");
  assert.equal(prepared.customerMicroUsdc, "0");
  assert.equal(transfersOf(decode(prepared.transaction)).length, 2);
  assert.ok((await world.sign(prepared)).signature);
});

test("a markup too small to leave the customer a unit also omits the payout transfer", async () => {
  // 1,600 * 1 / 10000 rounds up to 1; our fifth of 1 rounds up to 1; the customer gets 0.
  const world = makeWorld({ customer: { markupBps: 1 } });
  const prepared = await world.prepare();
  assert.equal(prepared.platformMicroUsdc, "1601");
  assert.equal(prepared.customerMicroUsdc, "0");
  assert.equal(transfersOf(decode(prepared.transaction)).length, 2);
  assert.ok((await world.sign(prepared)).signature);
});

test("at the markup cap the user pays four times the network cost in total", async () => {
  const world = makeWorld({ customer: { markupBps: 30_000 } });
  const prepared = await world.prepare();
  assert.equal(prepared.platformMicroUsdc, "2560");
  assert.equal(prepared.customerMicroUsdc, "3840");
  assert.ok((await world.sign(prepared)).signature);
});

test("a priority fee adds the ComputeBudget instructions and raises the floor", async () => {
  const world = makeWorld();
  const prepared = await world.prepare({ priorityMicroLamports: 500_000 });
  // 10,000 + 30,000 * 0.5 lamports at 150 dollars per SOL.
  assert.equal(prepared.networkCostMicroUsdc, "3750");
  const transaction = decode(prepared.transaction);
  const budget = transaction.message.compiledInstructions.filter(
    (instruction) => transaction.message.staticAccountKeys[instruction.programIdIndex].equals(ComputeBudgetProgram.programId),
  );
  assert.equal(budget.length, 2);
  assert.ok((await world.sign(prepared)).signature);
  await refuses(world.prepare({ priorityMicroLamports: 500_001 }), "priority_fee_above_cap");
});

test("the cost buffer, when configured, is quoted on top of the cost", async () => {
  const world = makeWorld({ env: { COST_BUFFER_BPS: "200" } });
  const prepared = await world.prepare();
  assert.equal(prepared.networkCostMicroUsdc, "1632");
  // The estimate may now rise by up to the buffer and the quote still signs.
  world.koraState.fee = 1_632n;
  assert.ok((await world.sign(prepared)).signature);
});

test("prepare refuses input that is not exactly what it expects", async () => {
  const world = makeWorld();
  const bad = (fields) => refuses(world.service.prepare(world.customer, typeof fields === "function" ? fields(world.prepareBody()) : world.prepareBody(fields), {}), "bad_request");
  await bad({ user: "not-a-key" });
  await bad({ user: undefined });
  await bad({ source: 42 });
  await bad({ recipient: null });
  await bad({ amountMicroUsdc: "0" });
  await bad({ amountMicroUsdc: 0 });
  await bad({ amountMicroUsdc: "1.5" });
  await bad({ amountMicroUsdc: 1.5 });
  await bad({ amountMicroUsdc: "-5" });
  await bad({ amountMicroUsdc: "1e6" });
  await bad({ amountMicroUsdc: 2 ** 60 });
  await bad({ amountMicroUsdc: "18446744073709551616" });
  await bad({ priorityMicroLamports: "fast" });
  await bad({ priorityMicroLamports: -1 });
  await bad({ transaction: "AAAA" });
  await bad(() => []);
  await bad(() => null);
  await bad(() => "user");
  // A token account can never sign; neither may the fee payer be the user.
  await bad({ user: world.userUsdc.toBase58() });
  await bad({ user: world.feePayer.publicKey.toBase58() });
  assert.equal(world.fetchFn.requests.length, 0);
});

test("prepare accepts the largest and the smallest amounts exactly", async () => {
  const world = makeWorld();
  // The most an account can hold, less the two payments (1,760 and 640).
  const most = 2n ** 64n - 1n - 2_400n;
  world.accounts.set(world.userUsdc.toBase58(), tokenAccount(USDC, world.user.publicKey, { amount: 2n ** 64n - 1n }));
  assert.equal(transfersOf(decode((await world.prepare({ amountMicroUsdc: most.toString() })).transaction))[0].amount, most);
  assert.equal(transfersOf(decode((await world.prepare({ amountMicroUsdc: 1 })).transaction))[0].amount, 1n);
  await refuses(world.prepare({ amountMicroUsdc: "18446744073709551615" }), "insufficient_balance");
});

test("prepare refuses a recipient that is the source, the payment account or the payout account", async () => {
  const world = makeWorld();
  await refuses(world.prepare({ recipient: world.userUsdc.toBase58() }), "recipient_not_allowed");
  await refuses(world.prepare({ recipient: world.paymentAccount.toBase58() }), "recipient_not_allowed");
  await refuses(world.prepare({ recipient: world.payoutAccount.toBase58() }), "recipient_not_allowed");
});

test("prepare refuses accounts the chain does not vouch for", async () => {
  const world = makeWorld();
  const stranger = getAssociatedTokenAddressSync(USDC, other());
  world.accounts.set(stranger.toBase58(), tokenAccount(USDC, other()));
  await refuses(world.prepare({ source: stranger.toBase58() }), "source_not_owned_by_user");
  await refuses(world.prepare({ source: other().toBase58() }), "source_invalid");
  await refuses(world.prepare({ recipient: other().toBase58() }), "recipient_invalid");
  // A recipient wallet with no USDC account yet: creating one is not this template.
  await refuses(world.prepare({ recipient: world.recipientWallet.publicKey.toBase58() }), "recipient_invalid");
});

test("a customer set up with its own payment account and a Kora that agrees with it is refused, at prepare and at sign", async () => {
  // The customer controls the record and its Kora: both name the customer's own wallet.
  const own = Keypair.generate().publicKey;
  const world = makeWorld();
  const prepared = await world.prepare();
  world.koraState.paymentAddress = own;
  world.accounts.set(world.paymentAccount.toBase58(), tokenAccount(USDC, own));
  await refuses(world.prepare(), "payment_account_not_platform");
  await refuses(world.sign(prepared), "payment_account_not_platform");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  // The refusal comes from the chain and the operator's setting, before Kora is asked.
  const fresh = makeWorld();
  fresh.koraState.paymentAddress = own;
  fresh.accounts.set(fresh.paymentAccount.toBase58(), tokenAccount(USDC, own));
  await refuses(fresh.prepare(), "payment_account_not_platform");
  assert.equal(fresh.fetchFn.requests.length, 0);
});

test("prepare refuses when Kora, the price or the chain is unavailable, and stores no quote", async () => {
  for (const [break_, code] of [
    [(world) => (world.koraState.estimateError = true), "kora_unavailable"],
    [(world) => (world.koraState.hang = "estimate"), "kora_unavailable"],
    [(world) => (world.priceState.priceFails = true), "price_unavailable"],
    [(world) => (world.conn.options.failReads = true), "chain_unavailable"],
    [(world) => (world.conn.options.failBlockhash = true), "chain_unavailable"],
    [(world) => (world.koraState.fee = 100_001n), "cost_above_cap"],
  ]) {
    const world = makeWorld();
    let stored = 0;
    world.store.putQuote = async () => void (stored += 1);
    break_(world);
    await refuses(world.prepare(), code);
    assert.equal(stored, 0);
  }
});

test("prepare refuses when the cost rises between its draft and the final transaction", async () => {
  const world = makeWorld();
  world.koraState.fee = (call) => (call === 1 ? 1_600n : 1_601n);
  await refuses(world.prepare(), "cost_rose");
});

test("prepare refuses a customer without the template", async () => {
  const world = makeWorld();
  await refuses(world.service.prepare({ ...world.customer, templates: [] }, world.prepareBody(), {}), "template_not_enabled");
});

// ── /v1/sign: the happy path ────────────────────────────────────────────────────────────

test("sign forwards the prepared transaction once and returns the fee payer's signature", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const report = {};
  const { signature } = await world.sign(prepared, report);

  const [sent] = world.conn.sent();
  const broadcast = VersionedTransaction.deserialize(sent);
  const message = Buffer.from(broadcast.message.serialize());
  assert.ok(message.equals(Buffer.from(decode(prepared.transaction).message.serialize())));
  assert.ok(validSignature(world.feePayer.publicKey, message, broadcast.signatures[0]));
  assert.ok(validSignature(world.user.publicKey, message, broadcast.signatures[1]));
  assert.equal(signature, base58Encode(broadcast.signatures[0]));
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  // What the log line may carry: the quote id, and neither the amounts nor the signature.
  assert.deepEqual(report, { quoteId: prepared.quoteId });
  assert.equal((await world.store.getQuote(prepared.quoteId)).signature, signature);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
});

test("Kora is sent the user's signature and an empty fee payer slot, whatever the client put there", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const transaction = decode(prepared.transaction);
  transaction.sign([world.user]);
  transaction.signatures[0] = new Uint8Array(64).fill(9);
  await world.service.sign(world.customer, { quoteId: prepared.quoteId, transaction: encode(transaction) }, {});
  const request = world.fetchFn.requests.find((entry) => entry.method === "signTransaction");
  const forwarded = decode(request.params.transaction);
  assert.ok(forwarded.signatures[0].every((byte) => byte === 0));
  assert.ok(Buffer.from(forwarded.signatures[1]).equals(Buffer.from(transaction.signatures[1])));
  assert.equal(request.params.signer_key, world.feePayer.publicKey.toBase58());
});

// ── /v1/sign: the message must be the prepared one, signed by the user ──────────────────

test("sign refuses a transaction that is not byte for byte the prepared one", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const submit = (transaction) => {
    transaction.sign([world.user]);
    return world.service.sign(world.customer, { quoteId: prepared.quoteId, transaction: encode(transaction) }, {});
  };
  // One micro-USDC less to us; a different recipient; the same instructions in another
  // order; a legacy encoding of the same instructions. All valid templates, none the quote's.
  await refuses(submit(usdcTransfer(world, { platform: 1_759n })), "message_mismatch");
  await refuses(submit(usdcTransfer(world, { amount: 5_000_001n })), "message_mismatch");
  await refuses(submit(usdcTransfer(world, { legacy: true })), "message_mismatch");
  const elsewhere = makeWorld();
  await refuses(submit(usdcTransfer({ ...world, recipientUsdc: elsewhere.recipientUsdc })), "message_mismatch");
  // A changed blockhash is a different message too.
  const reblocked = decode(prepared.transaction);
  reblocked.message.recentBlockhash = other().toBase58();
  await refuses(submit(reblocked), "message_mismatch");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  // The quote is untouched and still signs.
  assert.ok((await world.sign(prepared)).signature);
});

test("sign refuses a missing or wrong user signature", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  // Not signed at all.
  await refuses(world.service.sign(world.customer, { quoteId: prepared.quoteId, transaction: prepared.transaction }, {}), "bad_user_signature");
  // Signed by someone else's key, placed in the user's slot.
  const forged = decode(prepared.transaction);
  const impostor = Keypair.generate();
  const elsewhere = usdcTransfer(world, { payer: impostor.publicKey });
  elsewhere.sign([world.user]);
  forged.signatures[1] = elsewhere.signatures[1]; // a real signature of the user, over another message
  await refuses(world.service.sign(world.customer, { quoteId: prepared.quoteId, transaction: encode(forged) }, {}), "bad_user_signature");
  // One flipped bit.
  const flipped = decode(world.signedBody(prepared).transaction);
  flipped.signatures[1][5] ^= 1;
  await refuses(world.service.sign(world.customer, { quoteId: prepared.quoteId, transaction: encode(flipped) }, {}), "bad_user_signature");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  assert.equal(world.conn.count("sendRawTransaction"), 0);
});

test("sign refuses a body that is not a quote id and a transaction", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const body = world.signedBody(prepared);
  await refuses(world.service.sign(world.customer, { ...body, quoteId: 7 }, {}), "bad_request");
  await refuses(world.service.sign(world.customer, { ...body, extra: true }, {}), "bad_request");
  await refuses(world.service.sign(world.customer, { quoteId: body.quoteId }, {}), "bad_request");
  await refuses(world.service.sign(world.customer, { ...body, transaction: "not base64 !!" }, {}), "malformed_transaction");
  await refuses(world.service.sign(world.customer, { ...body, transaction: "A".repeat(1648) }, {}), "oversize_transaction");
  await refuses(world.service.sign(world.customer, { ...body, transaction: `${body.transaction.slice(0, -8)}AAAAAAAA` }, {}), "malformed_transaction");
});

// ── /v1/sign: quotes ────────────────────────────────────────────────────────────────────

test("sign refuses an unknown quote and another customer's quote alike", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  await refuses(world.service.sign(world.customer, { ...world.signedBody(prepared), quoteId: "no-such-quote" }, {}), "quote_not_found");
  const stranger = { ...world.customer, id: "globex" };
  await refuses(world.service.sign(stranger, world.signedBody(prepared), {}), "quote_not_found");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
});

test("a quote expires", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.clock.advance(44_999);
  const second = await world.prepare();
  world.clock.advance(1);
  await refuses(world.sign(prepared), "quote_expired");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  // The other quote, one millisecond inside its own window, still signs.
  world.clock.advance(44_998);
  assert.ok((await world.sign(second)).signature);
});

test("a quote that expires while its checks run is not claimed", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  // Time passes during the estimate: the claim itself re-checks the expiry.
  const estimate = world.kora.estimate;
  world.kora.estimate = async (...args) => {
    world.clock.advance(60_000);
    return estimate(...args);
  };
  await refuses(world.sign(prepared), "quote_expired");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 0, cost: 0n });
});

test("a repeated sign returns the same result and never signs twice", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const first = await world.sign(prepared);
  const again = await world.sign(prepared);
  assert.deepEqual(again, first);
  // Still the same answer after the quote's expiry, and whatever transaction comes with it.
  world.clock.advance(3_600_000);
  assert.deepEqual(await world.service.sign(world.customer, { quoteId: prepared.quoteId, transaction: "AAAA" }, {}), first);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
});

test("concurrent signs of one quote: one is forwarded, the others are told to ask again", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => world.sign(prepared)));
  const signed = results.filter((result) => result.status === "fulfilled");
  const waiting = results.filter((result) => result.status === "rejected" && result.reason.code === "sign_in_progress");
  assert.equal(signed.length, 1);
  assert.equal(waiting.length, 7);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
  // Asking again gives everyone the one signature.
  assert.deepEqual(await world.sign(prepared), signed[0].value);
});

// ── /v1/sign: everything is checked again ───────────────────────────────────────────────

test("sign re-reads the accounts: what changed since the quote is refused", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  const original = world.accounts.get(world.userUsdc.toBase58());

  world.accounts.set(world.userUsdc.toBase58(), tokenAccount(USDC, other()));
  await refuses(world.sign(prepared), "source_not_owned_by_user");
  world.accounts.set(world.userUsdc.toBase58(), original);

  const recipient = world.accounts.get(world.recipientUsdc.toBase58());
  world.accounts.delete(world.recipientUsdc.toBase58());
  await refuses(world.sign(prepared), "recipient_invalid");
  world.accounts.set(world.recipientUsdc.toBase58(), recipient);

  world.conn.options.failReads = true;
  await refuses(world.sign(prepared), "chain_unavailable");
  world.conn.options.failReads = false;

  assert.equal(world.fetchFn.count("signTransaction"), 0);
  // None of that used the quote up.
  assert.ok((await world.sign(prepared)).signature);
});

test("sign refuses when the cost rose above the quote, from either side", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.koraState.fee = KORA_FEE + 1n;
  await refuses(world.sign(prepared), "cost_rose");
  world.koraState.fee = KORA_FEE;
  world.priceState.price = 161_000_000n; // the floor is now 1,610
  await refuses(world.sign(prepared), "cost_rose");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 0, cost: 0n });
});

test("sign accepts a cost that fell: the user pays what was quoted", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.koraState.fee = 1_000n;
  world.priceState.price = 100_000_000n;
  assert.ok((await world.sign(prepared)).signature);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
});

test("sign refuses when Kora or the price is unavailable at that moment", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.priceState.priceFails = true;
  await refuses(world.sign(prepared), "price_unavailable");
  world.priceState.priceFails = false;
  world.koraState.estimateError = true;
  await refuses(world.sign(prepared), "kora_unavailable");
  world.koraState.estimateError = false;
  world.koraState.signer = other();
  await refuses(world.sign(prepared), "kora_mismatch");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
});

test("sign refuses when the customer's markup or templates changed after the quote", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  await refuses(world.service.sign({ ...world.customer, markupBps: 6_000 }, world.signedBody(prepared), {}), "payment_mismatch");
  await refuses(world.service.sign({ ...world.customer, templates: [] }, world.signedBody(prepared), {}), "template_not_enabled");
  // The payment accounts are part of the template too.
  await refuses(world.service.sign({ ...world.customer, paymentAccount: world.payoutAccount, payoutAccount: world.paymentAccount }, world.signedBody(prepared), {}), "payment_mismatch");
  await refuses(world.service.sign({ ...world.customer, feePayer: other() }, world.signedBody(prepared), {}), "wrong_fee_payer");
  assert.equal(world.fetchFn.count("signTransaction"), 0);
});

// ── /v1/sign: budgets ───────────────────────────────────────────────────────────────────

test("the daily transaction budget is enforced and resets with the UTC day", async () => {
  const world = makeWorld({ customer: { budgets: { requestsPerMinute: 600, transactionsPerDay: 2, networkCostMicroUsdcPerDay: "1000000" } } });
  for (let i = 0; i < 2; i += 1) assert.ok((await world.sign(await world.prepare())).signature);
  const third = await world.prepare();
  await refuses(world.sign(third), "budget_exhausted");
  assert.equal(world.fetchFn.count("signTransaction"), 2);
  // The refusal neither consumed anything nor used the quote up.
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 2, cost: 3_200n });
  assert.equal((await world.store.getQuote(third.quoteId)).state, "prepared");
  world.clock.advance(24 * 3_600_000);
  assert.ok((await world.sign(await world.prepare())).signature);
});

test("the daily network cost budget is enforced to the micro-USDC", async () => {
  // Room for exactly two quotes of 1,600.
  const world = makeWorld({ customer: { budgets: { requestsPerMinute: 600, transactionsPerDay: 100, networkCostMicroUsdcPerDay: "3200" } } });
  assert.ok((await world.sign(await world.prepare())).signature);
  assert.ok((await world.sign(await world.prepare())).signature);
  await refuses(world.sign(await world.prepare()), "budget_exhausted");
  const tight = makeWorld({ customer: { budgets: { requestsPerMinute: 600, transactionsPerDay: 100, networkCostMicroUsdcPerDay: "1599" } } });
  await refuses(tight.sign(await tight.prepare()), "budget_exhausted");
  assert.equal(tight.fetchFn.count("signTransaction"), 0);
});

test("budgets hold under concurrent signs of different quotes", async () => {
  const world = makeWorld({ customer: { budgets: { requestsPerMinute: 600, transactionsPerDay: 3, networkCostMicroUsdcPerDay: "1000000" } } });
  // Twelve source accounts of the one user: a source carries one unsettled transaction at a time.
  const quotes = [];
  for (let i = 0; i < 12; i += 1) {
    const source = other();
    world.accounts.set(source.toBase58(), tokenAccount(USDC, world.user.publicKey));
    quotes.push(await world.prepare({ source: source.toBase58(), amountMicroUsdc: String(1_000 + i) }));
  }
  const results = await Promise.allSettled(quotes.map((prepared) => world.sign(prepared)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "budget_exhausted").length, 9);
  assert.equal(world.fetchFn.count("signTransaction"), 3);
  assert.equal(world.conn.count("sendRawTransaction"), 3);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 3, cost: 4_800n });
});

// ── /v1/sign: Kora and the broadcast ────────────────────────────────────────────────────

test("a Kora refusal closes the quote as failed: nothing is sent, a repeat gets the same answer", async () => {
  for (const state of [{ signError: true }, { signHttpStatus: 500 }, { signHttpStatus: 401 }, { signHttpStatus: 405 }]) {
    const world = makeWorld();
    const prepared = await world.prepare();
    Object.assign(world.koraState, state);
    await refuses(world.sign(prepared), "kora_refused");
    // Kora recovers; the quote does not come back to life.
    world.koraState.signError = false;
    world.koraState.signHttpStatus = 0;
    await refuses(world.sign(prepared), "kora_refused");
    assert.equal(world.fetchFn.count("signTransaction"), 1);
    assert.equal(world.conn.count("sendRawTransaction"), 0);
    assert.equal((await world.store.getQuote(prepared.quoteId)).state, "failed");
  }
});

test("a Kora that does not answer the sign leaves an unknown outcome, never retried", async () => {
  for (const state of [{ hang: "sign" }, { signNetworkError: true }]) {
    const world = makeWorld();
    const prepared = await world.prepare();
    Object.assign(world.koraState, state);
    await unknown(world.sign(prepared));
    world.koraState.hang = null;
    world.koraState.signNetworkError = false;
    await unknown(world.sign(prepared));
    await unknown(world.sign(prepared));
    assert.equal(world.fetchFn.count("signTransaction"), 1);
    assert.equal(world.conn.count("sendRawTransaction"), 0);
    assert.equal((await world.store.getQuote(prepared.quoteId)).state, "unknown");
  }
});

test("a Kora answer that is not the user's transaction, properly signed, is not broadcast", async () => {
  for (const tamper of ["message", "user_signature", "fee_payer_signature", "garbage"]) {
    const world = makeWorld();
    const prepared = await world.prepare();
    world.koraState.tamper = tamper;
    await refuses(world.sign(prepared), "kora_bad_response");
    assert.equal(world.conn.count("sendRawTransaction"), 0, tamper);
    await refuses(world.sign(prepared), "kora_bad_response");
    assert.equal(world.fetchFn.count("signTransaction"), 1);
  }
});

test("a broadcast the node rejects closes the quote as failed", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.conn.options.onSend = () => {
    throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed: custom program error: 0x1" });
  };
  await refuses(world.sign(prepared), "broadcast_rejected");
  world.conn.options.onSend = null;
  await refuses(world.sign(prepared), "broadcast_rejected");
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
});

test("a broadcast with no answer is an unknown outcome that carries the signature", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.conn.options.onSend = () => {
    throw new Error("socket hang up");
  };
  const report = {};
  const error = await world.sign(prepared, report).catch((thrown) => thrown);
  assert.ok(error instanceof UnknownOutcome);
  assert.match(error.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.deepEqual(report, { quoteId: prepared.quoteId });
  assert.equal((await world.store.getQuote(prepared.quoteId)).signature, error.signature);
  // The RPC works again; the transaction is still never sent a second time.
  world.conn.options.onSend = null;
  const again = await world.sign(prepared).catch((thrown) => thrown);
  assert.ok(again instanceof UnknownOutcome);
  assert.equal(again.signature, error.signature);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
});

test("a sign Kora refused gives its budget back: nothing was signed", async () => {
  const world = makeWorld();
  world.koraState.signError = true;
  await refuses(world.sign(await world.prepare()), "kora_refused");
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 0, cost: 0n });
  // The refund happens once: repeating the refused quote changes nothing.
  world.koraState.signError = false;
  assert.ok((await world.sign(await world.prepare())).signature);
  assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
});

test("no refund once a signature may exist: Kora silent, a bad answer, a rejected or lost broadcast", async () => {
  const cases = [
    (world) => void (world.koraState.signNetworkError = true),
    (world) => void (world.koraState.hang = "sign"),
    (world) => void (world.koraState.tamper = "message"),
    (world) => void (world.conn.options.onSend = () => {
      throw new SendTransactionError({ action: "send", signature: "", transactionMessage: "Transaction simulation failed" });
    }),
    (world) => void (world.conn.options.onSend = () => {
      throw new Error("socket hang up");
    }),
  ];
  for (const arrange of cases) {
    const world = makeWorld();
    const prepared = await world.prepare();
    arrange(world);
    await assert.rejects(world.sign(prepared));
    assert.deepEqual(await world.store.budgetUsed("acme", "2027-01-15"), { transactions: 1, cost: 1_600n });
  }
});

test("a claim abandoned mid-flight is in progress at first and unknown once stale", async () => {
  const world = makeWorld();
  world.conn.options.autoLand = false;
  const prepared = await world.prepare();
  // The outcome cannot be recorded: the store fails after the broadcast.
  world.store.finishSign = async () => {
    throw new Error("database gone");
  };
  const report = {};
  const { signature } = await world.sign(prepared, report);
  assert.ok(signature);
  assert.equal(report.storeError, "finish_sign");
  await refuses(world.sign(prepared), "sign_in_progress");
  world.clock.advance(120_001);
  await unknown(world.sign(prepared));
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
});

test("a store failure before the claim signs nothing", async () => {
  const world = makeWorld();
  const prepared = await world.prepare();
  world.store.beginSign = async () => {
    throw new Error("database gone");
  };
  await assert.rejects(world.sign(prepared), /database gone/);
  assert.equal(world.fetchFn.count("signTransaction"), 0);
});
