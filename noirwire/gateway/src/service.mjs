import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { PublicKey, SendTransactionError, VersionedTransaction } from "@solana/web3.js";
import { checkAccounts } from "./accounts.mjs";
import { networkCost } from "./cost.mjs";
import { Refusal, UnknownOutcome } from "./errors.mjs";
import { KoraError } from "./kora.mjs";
import { splitFor, U64_MAX, withBuffer } from "./split.mjs";
import { buildTransaction, checkPayments, decodeTransaction, inspect, TEMPLATE } from "./template.mjs";
import { base58Encode } from "./units.mjs";

// The two operations. `prepare` builds the transaction and prices it; `sign` takes it back
// signed by the user, checks everything again from the bytes, and only then lets the
// customer's relayer pay for it.
//
// How Kora is called, and why: `signTransaction`, then this gateway broadcasts through its
// own RPC. Not `signAndSendTransaction`, because
//   - Kora may change the message before it signs (it can append an assertion instruction).
//     With signTransaction the answer comes back here first, so it is only broadcast if it
//     is byte for byte the message the user signed, with a fee payer signature that verifies;
//   - the transaction's id is the fee payer's signature. Getting the signed bytes back means
//     the id is known before anything is broadcast, so an unknown outcome is recorded with
//     the signature needed to settle it against the chain;
//   - one fewer method enabled on every customer's Kora.

/** A quote still "signing" this long after its claim was abandoned mid-flight: outcome unknown. */
const SIGNING_STALE_MS = 120_000;
/** DER prefix of an Ed25519 SubjectPublicKeyInfo, followed by the 32 key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const EMPTY_SIGNATURE = new Uint8Array(64);

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const utcDay = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

function ed25519Verifies(publicKey, message, signature) {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.toBuffer()]), format: "der", type: "spki" });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

function readPublicKey(value) {
  if (typeof value !== "string" || value.length > 64) throw new Refusal("bad_request");
  try {
    return new PublicKey(value);
  } catch {
    throw new Refusal("bad_request");
  }
}

/** A whole number given as digits or as a JSON integer, never a float. */
function readUnits(value, lowest, highest) {
  let units;
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) units = BigInt(value);
  else if (Number.isSafeInteger(value) && value >= 0) units = BigInt(value);
  else throw new Refusal("bad_request");
  if (units < lowest || units > highest) throw new Refusal("bad_request");
  return units;
}

function readBase64(value) {
  // 1232 bytes are 1644 base64 characters; anything longer cannot be a transaction.
  if (typeof value !== "string" || value.length === 0) throw new Refusal("bad_request");
  if (value.length > 1644) throw new Refusal("oversize_transaction");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Refusal("malformed_transaction");
  return Buffer.from(value, "base64");
}

const onlyFields = (body, fields) =>
  typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).every((field) => fields.includes(field));

export function createService(deps, cfg) {
  const { conn, kora, store, clock } = deps;
  const newQuoteId = deps.newQuoteId ?? randomUUID;
  const encode = (transaction) => Buffer.from(transaction.serialize()).toString("base64");

  /**
   * The template rules, the exact payments (when `split` says what they must be), the
   * accounts on chain and the network cost, all from scratch. What needs no upstream is
   * checked first.
   */
  async function assess(customer, transaction, split = null) {
    const parsed = inspect(transaction, customer, cfg);
    if (split) checkPayments(parsed, split);
    const { paymentOwner } = await checkAccounts(conn, parsed, customer, cfg);
    const cost = await networkCost(deps, cfg, customer, parsed, encode(transaction), paymentOwner);
    return { parsed, cost };
  }

  /**
   * POST /v1/prepare. Builds the complete unsigned transaction for one USDC transfer and
   * prices it. `report` collects what the request's log line may carry.
   */
  async function prepare(customer, body, report) {
    if (!customer.templates.includes(TEMPLATE)) throw new Refusal("template_not_enabled");
    if (!onlyFields(body, ["user", "source", "recipient", "amountMicroUsdc", "priorityMicroLamports"])) throw new Refusal("bad_request");
    const user = readPublicKey(body.user);
    const source = readPublicKey(body.source);
    const recipient = readPublicKey(body.recipient);
    const amount = readUnits(body.amountMicroUsdc, 1n, U64_MAX);
    const priorityMicroLamports = body.priorityMicroLamports === undefined ? 0n : readUnits(body.priorityMicroLamports, 0n, U64_MAX);
    // A signer is a point on the curve; a derived address can never sign.
    if (!PublicKey.isOnCurve(user.toBytes()) || user.equals(customer.feePayer)) throw new Refusal("bad_request");
    if (priorityMicroLamports > cfg.maxPriorityMicroLamports) throw new Refusal("priority_fee_above_cap");
    if ([source, customer.paymentAccount, customer.payoutAccount].some((account) => account.equals(recipient))) {
      throw new Refusal("recipient_not_allowed");
    }

    let blockhash;
    try {
      ({ blockhash } = await conn.getLatestBlockhash("confirmed"));
    } catch {
      throw new Refusal("chain_unavailable", "blockhash");
    }
    const build = (platform, customerAmount) =>
      buildTransaction({ customer, cfg, user, source, recipient, amount, priorityMicroLamports, platform, customerAmount, blockhash });

    // The amounts depend on the cost and the cost on the transaction, so price a draft of
    // the same shape first (one unit in each payment), then build the real one.
    const draft = await assess(customer, build(1n, customer.markupBps > 0 ? 1n : 0n));
    const split = splitFor(withBuffer(draft.cost, cfg.costBufferBps), customer.markupBps);
    if (split.networkCost > cfg.maxNetworkCostMicroUsdc) throw new Refusal("cost_above_cap");

    // The final transaction goes through exactly what /v1/sign will run on it. A quote that
    // could not be signed right now is not handed out.
    const transaction = build(split.platform, split.customer);
    const final = await assess(customer, transaction, split);
    if (final.cost > split.networkCost) throw new Refusal("cost_rose", "at_prepare");

    const nowMs = clock.now();
    const quote = {
      id: newQuoteId(),
      customerId: customer.id,
      messageHash: sha256Hex(transaction.message.serialize()),
      networkCost: split.networkCost,
      platform: split.platform,
      customer: split.customer,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + cfg.quoteTtlMs,
    };
    await store.putQuote(quote);
    Object.assign(report, amountsOf(quote));
    return {
      quoteId: quote.id,
      transaction: encode(transaction),
      feePayer: customer.feePayer.toBase58(),
      paymentAccount: customer.paymentAccount.toBase58(),
      payoutAccount: customer.payoutAccount.toBase58(),
      networkCostMicroUsdc: quote.networkCost.toString(),
      platformMicroUsdc: quote.platform.toString(),
      customerMicroUsdc: quote.customer.toString(),
      expiresAt: new Date(quote.expiresAtMs).toISOString(),
    };
  }

  const amountsOf = (quote) => ({
    quoteId: quote.id,
    networkCostMicroUsdc: quote.networkCost.toString(),
    platformMicroUsdc: quote.platform.toString(),
    customerMicroUsdc: quote.customer.toString(),
  });

  /** The answer a quote that already left "prepared" gives, every time it is asked. */
  function answerOfClosed(quote, nowMs) {
    if (quote.state === "sent") return { signature: quote.signature };
    if (quote.state === "failed") throw new Refusal(quote.code, "repeat");
    if (quote.state === "unknown") throw new UnknownOutcome("repeat", quote.signature);
    if (nowMs - quote.claimedAtMs > SIGNING_STALE_MS) throw new UnknownOutcome("abandoned_claim", null);
    throw new Refusal("sign_in_progress");
  }

  /** After the claim: ask Kora for the fee payer's signature, check the answer, broadcast once. */
  async function signAndBroadcast(customer, transaction, userSignature) {
    const messageBytes = Buffer.from(transaction.message.serialize());
    let signedBase64;
    try {
      signedBase64 = await kora.sign(customer, encode(transaction));
    } catch (error) {
      if (error instanceof KoraError && error.kind === "refused") return { state: "failed", code: "kora_refused" };
      // No usable answer. Kora's signTransaction does not broadcast, but what happened on
      // its side is not known here, so this is not called a failure.
      return { state: "unknown", signature: null, detail: "kora_no_answer" };
    }

    let signed;
    try {
      signed = VersionedTransaction.deserialize(Buffer.from(signedBase64, "base64"));
    } catch {
      return { state: "failed", code: "kora_bad_response" };
    }
    const sameMessage = Buffer.from(signed.message.serialize()).equals(messageBytes);
    const userUntouched = signed.signatures.length === 2 && Buffer.from(signed.signatures[1]).equals(Buffer.from(userSignature));
    if (!sameMessage || !userUntouched || !ed25519Verifies(customer.feePayer, messageBytes, signed.signatures[0])) {
      return { state: "failed", code: "kora_bad_response" };
    }

    const signature = base58Encode(signed.signatures[0]);
    try {
      await conn.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
    } catch (error) {
      // The node answered and said no: with preflight on, it was not broadcast.
      if (error instanceof SendTransactionError) return { state: "failed", code: "broadcast_rejected", signature };
      return { state: "unknown", signature, detail: "broadcast_no_answer" };
    }
    return { state: "sent", signature };
  }

  /** POST /v1/sign. */
  async function sign(customer, body, report) {
    if (!onlyFields(body, ["quoteId", "transaction"]) || typeof body.quoteId !== "string" || body.quoteId.length > 64) {
      throw new Refusal("bad_request");
    }
    const quote = await store.getQuote(body.quoteId);
    // Another customer's quote is not distinguishable from one that does not exist.
    if (!quote || quote.customerId !== customer.id) throw new Refusal("quote_not_found");
    Object.assign(report, amountsOf(quote));

    if (quote.state !== "prepared") {
      if (quote.signature) report.signature = quote.signature;
      return answerOfClosed(quote, clock.now());
    }
    if (clock.now() >= quote.expiresAtMs) throw new Refusal("quote_expired");

    // 1. It is the prepared transaction, exactly, and the user signed it.
    const transaction = decodeTransaction(readBase64(body.transaction));
    const messageBytes = Buffer.from(transaction.message.serialize());
    if (sha256Hex(messageBytes) !== quote.messageHash) throw new Refusal("message_mismatch");
    const user = transaction.message.staticAccountKeys[1];
    const userSignature = transaction.signatures[1];
    if (!user || !userSignature || !ed25519Verifies(user, messageBytes, userSignature)) throw new Refusal("bad_user_signature");

    // 2. Every check again, from the bytes and from the chain as it is now. Nothing is
    //    taken on trust from the time of the quote except the quoted amounts.
    if (!customer.templates.includes(TEMPLATE)) throw new Refusal("template_not_enabled");
    // Only the user's signature travels on: whatever was in the fee payer's slot is dropped.
    transaction.signatures[0] = EMPTY_SIGNATURE;
    const split = splitFor(quote.networkCost, customer.markupBps);
    // The split is computed again from the quoted cost and the customer's markup as it is
    // now, and must also be what was quoted.
    if (split.platform !== quote.platform || split.customer !== quote.customer) throw new Refusal("payment_mismatch", "quote_amounts");
    const { cost } = await assess(customer, transaction, split);
    if (cost > quote.networkCost) throw new Refusal("cost_rose");

    // 3. Claim the quote and consume the budget, as one step. Exactly one request per quote
    //    gets past this line.
    const nowMs = clock.now();
    const begun = await store.beginSign({ quoteId: quote.id, customerId: customer.id, nowMs, day: utcDay(nowMs), cost: quote.networkCost, limits: customer.budgets });
    if (begun.kind === "budget") throw new Refusal("budget_exhausted");
    if (begun.kind !== "claimed") {
      const current = await store.getQuote(quote.id);
      if (!current || current.state === "prepared") throw new Refusal("quote_expired");
      return answerOfClosed(current, clock.now());
    }

    // 4. Forward, once. From here on every path ends in finishSign, and nothing is retried.
    let outcome;
    try {
      outcome = await signAndBroadcast(customer, transaction, userSignature);
    } catch {
      outcome = { state: "unknown", signature: null, detail: "unexpected_error" };
    }
    try {
      await store.finishSign(quote.id, { state: outcome.state, signature: outcome.signature ?? null, code: outcome.code ?? null });
    } catch {
      // The outcome could not be recorded. The quote stays "signing", which no request can
      // claim again, and is answered as unknown once the claim is stale.
      report.storeError = "finish_sign";
    }
    if (outcome.signature) report.signature = outcome.signature;
    if (outcome.state === "sent") return { signature: outcome.signature };
    if (outcome.state === "failed") throw new Refusal(outcome.code);
    throw new UnknownOutcome(outcome.detail, outcome.signature);
  }

  return { prepare, sign };
}
