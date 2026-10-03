import { PublicKey } from "@solana/web3.js";
import { Refusal } from "./errors.mjs";

/**
 * The independent SOL price behind the cost floor.
 *
 * A price source is any object with `microUsdPerSol(nowSeconds)`, answering micro-dollars
 * per whole SOL as a bigint or throwing. This one reads Pyth's SOL/USD price account through
 * the RPC. The account is written by Pyth's receiver program, which only accepts a price
 * carrying the Wormhole guardians' signatures, so it does not depend on the relayer or on
 * the oracle the relayer uses. It is a USD price and the payment is USDC; the two are
 * treated as equal.
 */

// The sponsored SOL/USD feed account (shard 0) and the feed it must carry.
export const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** The feed's own confidence interval must be within 1 percent of the price. */
const MAX_CONFIDENCE_BPS = 100n;

// PriceUpdateV2: 8 discriminator, 32 write authority, 1 verification level (1 = fully
// verified), then feed id 32, price i64, confidence u64, exponent i32, publish time i64.
const VERIFICATION = 40;
const FEED_ID = 41;
const PRICE = 73;
const CONFIDENCE = 81;
const EXPONENT = 89;
const PUBLISH_TIME = 93;
const MIN_LENGTH = 101;

const refuse = (why) => new Refusal("price_unavailable", why);

export function createPythPriceSource(conn, { maxAgeSeconds }) {
  return {
    async microUsdPerSol(nowSeconds) {
      let account;
      try {
        account = await conn.getAccountInfo(PYTH_SOL_USD, "confirmed");
      } catch {
        throw refuse("read_failed");
      }
      if (!account || account.owner.toBase58() !== PYTH_RECEIVER || account.data.length < MIN_LENGTH) {
        throw refuse("not_the_pyth_account");
      }
      const data = Buffer.from(account.data);
      if (data[VERIFICATION] !== 1) throw refuse("not_fully_verified");
      if (data.subarray(FEED_ID, FEED_ID + 32).toString("hex") !== SOL_USD_FEED_ID) throw refuse("wrong_feed");
      const price = data.readBigInt64LE(PRICE);
      const confidence = data.readBigUInt64LE(CONFIDENCE);
      const exponent = data.readInt32LE(EXPONENT);
      const age = nowSeconds - Number(data.readBigInt64LE(PUBLISH_TIME));
      if (age > maxAgeSeconds || age < -maxAgeSeconds) throw refuse("stale");
      if (price <= 0n || confidence * 10_000n > price * MAX_CONFIDENCE_BPS) throw refuse("confidence_too_wide");
      const shift = 6 + exponent; // to micro-dollars
      if (shift < -18 || shift > 18) throw refuse("unexpected_exponent");
      const microUsd = shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
      if (microUsd <= 0n) throw refuse("zero_price");
      return microUsd;
    },
  };
}
