import { PublicKey } from "@solana/web3.js";
import { Refusal } from "./errors.mjs";

/**
 * The reference SOL price, read from MagicBlock's SOL/USD price account (oracle feed 6).
 *
 * It is independent of Jupiter: the account belongs to MagicBlock's oracle program and is
 * served by MagicBlock's rollup endpoint (ROLLUP_RPC_URL), not by the Solana RPC the rest of
 * the job uses. So a quote that is wrong, or a Jupiter that is wrong as a whole, shows up
 * against it. What it is not: proof of the price. The account carries no confidence interval,
 * so there is no width to check, and whoever runs the rollup endpoint can lie about it, which
 * makes that endpoint a second trust point beside RPC_URL. That is why the operator's own
 * MAX_USDC_PER_SOL bound exists and is checked separately.
 *
 * It is a USD price and the swap pays USDC; the two are treated as equal.
 */

const ORACLE_PROGRAM = "PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd";
// The oracle's account for feed 6, the address the program derives for it.
export const MAGICBLOCK_SOL_USD = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");

/** Older than this and the price is not used. */
const MAX_PRICE_AGE_SECONDS = 120;

/** The order book refuses any publish time in the future; this much allowance is for this machine's clock only. */
const MAX_CLOCK_SKEW_SECONDS = 5;

// PriceUpdateV3, 134 bytes: 8 discriminator, 32 write authority, 1 verification level
// (1 = full), feed id 32 (the account's own address), price i64, confidence u64 (always
// zero, not read), exponent i32 (decimals, positive: 8 means 10^-8), publish time i64.
const DISCRIMINATOR = Buffer.from([234, 161, 14, 36, 172, 239, 15, 232]);
const ACCOUNT_LENGTH = 134;
const VERIFICATION = 40;
const FEED_ID = 41;
const PRICE = 73;
const EXPONENT = 89;
const PUBLISH_TIME = 93;
const STORED_DECIMALS = 8;

const refuse = (why) => new Refusal("no_price", `no usable reference SOL price: ${why}`);

/** Raw USDC units per whole SOL, or a Refusal when the price cannot be trusted. */
export async function readReferencePrice(conn, nowSeconds) {
  const account = await conn.getAccountInfo(MAGICBLOCK_SOL_USD, "confirmed");
  if (!account || account.owner.toBase58() !== ORACLE_PROGRAM || account.data.length !== ACCOUNT_LENGTH) {
    throw refuse("the MagicBlock account is missing or not the oracle's");
  }
  const data = Buffer.from(account.data);
  if (!data.subarray(0, 8).equals(DISCRIMINATOR)) throw refuse("the account is not a price update");
  if (data[VERIFICATION] !== 1) throw refuse("the price is not fully verified");
  if (!data.subarray(FEED_ID, FEED_ID + 32).equals(MAGICBLOCK_SOL_USD.toBuffer())) {
    throw refuse("the account does not carry the SOL/USD feed");
  }
  if (data.readInt32LE(EXPONENT) !== STORED_DECIMALS) throw refuse("unexpected exponent");
  const price = data.readBigInt64LE(PRICE);
  const age = nowSeconds - Number(data.readBigInt64LE(PUBLISH_TIME));
  if (age > MAX_PRICE_AGE_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) throw refuse(`it is ${age} seconds old`);
  if (price <= 0n) throw refuse("the price is not above zero");
  return price / 100n; // 8 decimals to micro-dollars
}
