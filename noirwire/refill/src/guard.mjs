import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { Refusal } from "./errors.mjs";
import { SOL_MINT, USDC_MINT } from "./jupiter.mjs";
import { ceilDiv } from "./units.mjs";

/**
 * Everything that stands between Jupiter's answer and a signature.
 *
 * Jupiter hands back a transaction it built. The whole risk is trusting that it does what
 * the quote said. Three things are therefore required, and any doubt is a refusal:
 *
 * 1. The order's own numbers match the request, sit within the allowed slippage of an
 *    independent price, and are inside the operator's own price bound.
 * 2. The transaction is a market-maker fill and nothing else, and the amounts written in
 *    that fill instruction are the quoted ones. This is what makes the price binding: the
 *    program fills at exactly those amounts or fails. A quote in JSON binds nobody.
 * 3. Run in simulation, the transaction does to this wallet what the quote said and
 *    nothing more.
 */

export const USDC = new PublicKey(USDC_MINT);
const LAMPORTS_PER_SOL = 1_000_000_000n;

/** The least lamports `usdcUnits` must buy at `microUsdcPerSol` (rounded against the venue). */
export const lamportsAtPrice = (usdcUnits, microUsdcPerSol) => ceilDiv(usdcUnits * LAMPORTS_PER_SOL, microUsdcPerSol);

const digits = (value, label) => {
  if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Refusal("bad_quote", `the order has no usable ${label}`);
  }
  return BigInt(value);
};

/**
 * Holds the order's own fields to the request, to the reference price and to the operator's
 * bound, and decodes its transaction. Returns the quote every later check is made against.
 */
export function checkOrder(order, { usdcAmount, taker }, microUsdcPerSol, cfg, nowSeconds) {
  if (order.inputMint !== USDC_MINT || order.outputMint !== SOL_MINT) {
    throw new Refusal("wrong_mint", "the order is not USDC to SOL");
  }
  if (order.swapType !== "rfq" || order.router !== "jupiterz") {
    throw new Refusal("not_market_maker", "the order is not a market-maker order; aggregator routes are not accepted");
  }
  if (order.swapMode !== undefined && order.swapMode !== "ExactIn") {
    throw new Refusal("bad_quote", "the order is not exact-in");
  }
  if (order.taker !== undefined && order.taker !== null && order.taker !== taker.toBase58()) {
    throw new Refusal("wrong_taker", "the order was built for another wallet");
  }
  const inAmount = digits(order.inAmount, "input amount");
  if (inAmount !== usdcAmount) {
    throw new Refusal("wrong_amount", `the order spends ${inAmount}, ${usdcAmount} was asked for`);
  }
  digits(order.outAmount, "output amount");
  const minLamports = digits(order.otherAmountThreshold, "guaranteed minimum");

  // The operator's bound first: it depends on nothing but configuration.
  if (microUsdcPerSol > cfg.maxMicroUsdcPerSol) {
    throw new Refusal("price_above_bound", "the reference SOL price is above MAX_USDC_PER_SOL; raise the bound if that price is real");
  }
  if (minLamports < lamportsAtPrice(inAmount, cfg.maxMicroUsdcPerSol)) {
    throw new Refusal("above_price_bound", "the order pays more per SOL than MAX_USDC_PER_SOL allows");
  }
  const fair = (inAmount * LAMPORTS_PER_SOL) / microUsdcPerSol;
  const lowest = (fair * BigInt(10_000 - cfg.maxSlippageBps)) / 10_000n;
  if (minLamports < lowest) {
    throw new Refusal(
      "below_reference_price",
      `the guaranteed ${minLamports} lamports is more than ${cfg.maxSlippageBps} bps under the reference price (${fair} lamports)`,
    );
  }
  if (order.expireAt && Number(order.expireAt) <= nowSeconds) {
    throw new Refusal("expired_quote", "the order has already expired");
  }
  if (!order.transaction) {
    // Jupiter's own message is free text from a third party and is never logged; only its
    // numeric code is, and only if it is a number. 1: insufficient balance, 2: missing
    // token account, 3: the quote could not be built.
    const code = Number.isInteger(order.errorCode) ? order.errorCode : "unknown";
    throw new Refusal("not_built", `Jupiter priced the order but built no transaction (error code ${code})`);
  }
  if (typeof order.requestId !== "string" || !order.requestId) {
    throw new Refusal("bad_quote", "the order has no request id");
  }
  let transaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  } catch {
    throw new Refusal("bad_quote", "the order's transaction could not be decoded");
  }
  return { inAmount, minLamports, transaction, requestId: order.requestId };
}

/** Jupiter's RFQ order engine, and the first eight bytes of its `fill` instruction. */
export const RFQ_PROGRAM = new PublicKey("61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH");
export const FILL_DISCRIMINATOR = Buffer.from("a860b7a35c0a28a0", "hex");
// fill(input_amount u64, output_amount u64, expire_at i64, ...), accounts: taker, maker,
// taker's input token account, ..., input mint (6), ..., output mint (8). Read off genuine
// orders, and re-checked against live ones by the read-only probe described in the README.
const FILL_MIN_LENGTH = 32;
const FILL_TAKER = 0;
const FILL_TAKER_INPUT_ACCOUNT = 2;
const FILL_INPUT_MINT = 6;
const FILL_OUTPUT_MINT = 8;

/**
 * The static half: the transaction is compute-budget instructions plus exactly one fill, no
 * address lookup tables, and the fill's own amounts are the quoted ones.
 *
 * Nothing else is allowed at the top level, which refuses every stray transfer, approval,
 * account closure and durable nonce in one stroke. An instruction this code cannot decode is
 * not signed.
 */
export function checkInstructions(message, quote, wallet, nowSeconds) {
  if (message.addressTableLookups.length > 0) {
    throw new Refusal("program_not_allowed", "the transaction uses address lookup tables, which a market-maker fill does not");
  }
  const keys = message.staticAccountKeys;
  const signers = keys.slice(0, message.header.numRequiredSignatures);
  if (!signers.some((key) => key.equals(wallet))) {
    throw new Refusal("not_ours", "the transaction does not ask for this wallet's signature");
  }
  // The maker pays the network fee on a fill. A transaction this wallet would pay for is
  // not the shape that was asked for.
  if (keys[0].equals(wallet)) {
    throw new Refusal("not_market_maker", "the transaction would be paid for by this wallet");
  }
  const fills = [];
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    if (program?.equals(ComputeBudgetProgram.programId)) continue;
    if (!program?.equals(RFQ_PROGRAM)) {
      throw new Refusal("program_not_allowed", `the transaction calls ${program?.toBase58() ?? "an unknown program"}, which a market-maker fill has no reason to`);
    }
    fills.push(instruction);
  }
  if (fills.length !== 1) throw new Refusal("bad_fill", "the transaction does not carry exactly one fill");

  const [fill] = fills;
  const data = Buffer.from(fill.data);
  const account = (index) => keys[fill.accountKeyIndexes[index]];
  if (data.length < FILL_MIN_LENGTH || !data.subarray(0, 8).equals(FILL_DISCRIMINATOR)) {
    throw new Refusal("bad_fill", "the fill instruction is not one this job can decode");
  }
  if (
    !account(FILL_TAKER)?.equals(wallet) ||
    !account(FILL_TAKER_INPUT_ACCOUNT)?.equals(getAssociatedTokenAddressSync(USDC, wallet, true)) ||
    !account(FILL_INPUT_MINT)?.equals(USDC) ||
    !account(FILL_OUTPUT_MINT)?.equals(NATIVE_MINT)
  ) {
    throw new Refusal("bad_fill", "the fill is not this wallet's USDC for SOL");
  }
  const input = data.readBigUInt64LE(8);
  const output = data.readBigUInt64LE(16);
  const expireAt = data.readBigInt64LE(24);
  if (input !== quote.inAmount) {
    throw new Refusal("fill_mismatch", `the fill takes ${input} USDC units, the quote said ${quote.inAmount}`);
  }
  if (output < quote.minLamports) {
    throw new Refusal("fill_mismatch", `the fill pays ${output} lamports, the quote guaranteed ${quote.minLamports}`);
  }
  if (expireAt <= BigInt(nowSeconds)) throw new Refusal("expired_quote", "the fill has already expired");
  return { output, expireAt: Number(expireAt) };
}

const TOKEN_ACCOUNT_LEN = 165;
const AMOUNT_OFFSET = 64;
// Who controls a token account: owner, delegate, delegated amount, close authority. None of
// them moves a unit, so a balance check alone passes an Approve or a SetAuthority.
const CONTROL_FIELDS = [[32, 64], [72, 108], [121, 129], [129, 165]];

const isTokenAccount = (data) => Boolean(data) && data.length >= TOKEN_ACCOUNT_LEN;
const tokenAmount = (data) => (isTokenAccount(data) ? data.readBigUInt64LE(AMOUNT_OFFSET) : 0n);
const controlChanged = (before, after) =>
  CONTROL_FIELDS.some(([start, end]) => !before.subarray(start, end).equals(after.subarray(start, end)));

/** Token accounts the wallet owns, under both token programs. */
async function ownedTokenAccounts(conn, wallet) {
  const lists = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) => conn.getTokenAccountsByOwner(wallet, { programId })),
  );
  return lists.flatMap((list) => list.value.map((entry) => entry.pubkey));
}

/**
 * The static check, then the transaction run in simulation and its effect on the wallet held
 * to the quote: USDC falls by no more than quoted, native SOL rises by at least the
 * guaranteed minimum and by at least what the operator's price bound requires, no other
 * token account of the wallet loses anything or changes hands, and the wallet itself stays
 * an ordinary System account. Returns what the simulation delivered.
 *
 * The balances before are what everything is measured against, so when they cannot be read
 * nothing is signed.
 */
export async function checkTransaction(conn, quote, wallet, cfg, nowSeconds) {
  const { transaction } = quote;
  const message = transaction.message;
  const fill = checkInstructions(message, quote, wallet, nowSeconds);

  const usdcAccount = getAssociatedTokenAddressSync(USDC, wallet, true);
  const wrappedSol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet, true);
  const inTransaction = new Set(message.staticAccountKeys.map((key) => key.toBase58()));
  const others = (await ownedTokenAccounts(conn, wallet)).filter(
    (account) => inTransaction.has(account.toBase58()) && !account.equals(usdcAccount) && !account.equals(wrappedSol),
  );
  const watched = [wallet, usdcAccount, wrappedSol, ...others];

  const before = await conn.getMultipleAccountsInfo(watched, "confirmed");
  if (!isTokenAccount(before[1]?.data) || others.some((_, i) => !before[i + 3])) {
    throw new Refusal("unchecked", "the balances before the swap could not be read");
  }

  const simulation = await conn.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: watched.map((key) => key.toBase58()) },
  });
  if (simulation.value.err) {
    throw new Refusal("would_fail", `the swap would fail on chain (${JSON.stringify(simulation.value.err)})`);
  }
  const after = simulation.value.accounts;
  if (!after || after.length !== watched.length) {
    throw new Refusal("unchecked", "the simulation did not return the watched accounts");
  }
  const dataOf = (account) => (account ? Buffer.from(account.data[0], "base64") : null);

  const walletAfter = after[0];
  if (!walletAfter || walletAfter.owner !== SystemProgram.programId.toBase58()) {
    throw new Refusal("owner_changed", "the swap would hand the wallet to a program");
  }

  // Index 2 is the wrapped-SOL account, which usually does not exist: only an account that
  // existed before is held to anything.
  watched.forEach((account, index) => {
    if (index === 0) return;
    const pre = before[index]?.data;
    const post = dataOf(after[index]);
    if (!isTokenAccount(pre)) return;
    const name = index === 1 ? "the USDC account" : "another token account";
    if (!isTokenAccount(post)) throw new Refusal("account_closed", `the swap would close ${name}`);
    if (controlChanged(pre, post)) {
      throw new Refusal("control_changed", `the swap would give someone else control of ${name}`);
    }
    if (index > 1 && tokenAmount(post) < tokenAmount(pre)) {
      throw new Refusal("other_asset_debited", "the swap would also move another asset");
    }
  });

  const spent = tokenAmount(before[1].data) - tokenAmount(dataOf(after[1]));
  if (spent > quote.inAmount) {
    throw new Refusal("overspend", `the swap would spend ${spent} USDC units, ${quote.inAmount} was quoted`);
  }
  const gained = BigInt(walletAfter.lamports) - BigInt(before[0]?.lamports ?? 0);
  if (gained < quote.minLamports) {
    throw new Refusal("under_delivery", `the swap would deliver ${gained} lamports, the guaranteed minimum is ${quote.minLamports}`);
  }
  // The operator's bound once more, on what actually arrives for what is actually spent.
  if (gained < lamportsAtPrice(quote.inAmount, cfg.maxMicroUsdcPerSol)) {
    throw new Refusal("above_price_bound", "the swap would pay more per SOL than MAX_USDC_PER_SOL allows");
  }
  return { lamports: gained, usdcSpent: spent, expireAt: fill.expireAt };
}
