import pg from "pg";
import { RATE_WINDOW_MS } from "../ratelimit.mjs";
import { CLEANUP } from "./memory.mjs";

// The store, in Postgres: quotes, budgets, failure counts and rate windows shared by every
// process. The interface and the states are described in store/memory.mjs; the schema is
// migrations/001_gateway.sql.

const UNSETTLED = "('signing', 'signed', 'sent', 'unknown')";
const UNIQUE_VIOLATION = "23505";

// One customer's prepares run one at a time (the advisory lock, held to the end of the
// transaction), so the count and the insert cannot interleave with another prepare.
const LOCK_CUSTOMER = "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))";

// $9 now, $10 the cap on open quotes.
export const INSERT_QUOTE = `
  INSERT INTO gateway_quotes
    (id, customer_id, message_hash, source_hash, last_valid_block_height,
     network_cost_micro_usdc, platform_micro_usdc, customer_micro_usdc, created_at_ms, expires_at_ms)
  SELECT $1::text, $2::text, $3::text, $4::text, $5::bigint, $6::bigint, $7::bigint, $8::bigint, $9::bigint, $11::bigint
  WHERE (SELECT count(*) FROM gateway_quotes
         WHERE customer_id = $2::text AND state = 'prepared' AND expires_at_ms > $9::bigint) < $10::integer`;

// Bounded cleanup, run after each insert. $1 the cut-off, $2 the batch.
const DELETE_EXPIRED = `
  DELETE FROM gateway_quotes WHERE id IN (
    SELECT id FROM gateway_quotes WHERE state = 'prepared' AND expires_at_ms < $1::bigint
    ORDER BY expires_at_ms LIMIT $2::integer FOR UPDATE SKIP LOCKED)`;
const DELETE_OLD = `
  DELETE FROM gateway_quotes WHERE id IN (
    SELECT id FROM gateway_quotes WHERE state <> 'prepared' AND created_at_ms < $1::bigint
    ORDER BY created_at_ms LIMIT $2::integer FOR UPDATE SKIP LOCKED)`;

const SELECT_QUOTE = "SELECT * FROM gateway_quotes WHERE id = $1";

// Only a prepared, unexpired quote of this customer can be claimed, and only once. The
// unique index on the source of unsettled quotes refuses the claim (a unique violation)
// while another quote of the same source account is unsettled.
const CLAIM_QUOTE = `
  UPDATE gateway_quotes SET state = 'signing', claimed_at_ms = $3::bigint
  WHERE id = $1 AND customer_id = $2 AND state = 'prepared' AND expires_at_ms > $3::bigint`;

// Budget consumption in one statement. The day's row is created or raised only if the
// result stays within both limits; otherwise no row comes back and nothing changed. Two
// concurrent calls serialise on the row, so the limits hold under any interleaving.
// $1 customer, $2 day, $3 cost, $4 transactions per day, $5 cost per day.
export const CONSUME_BUDGET = `
  INSERT INTO gateway_budgets AS b (customer_id, day, transactions, network_cost_micro_usdc)
  SELECT $1, $2::date, 1, $3::bigint
  WHERE 1 <= $4::integer AND $3::bigint <= $5::bigint
  ON CONFLICT (customer_id, day) DO UPDATE
    SET transactions = b.transactions + 1,
        network_cost_micro_usdc = b.network_cost_micro_usdc + EXCLUDED.network_cost_micro_usdc
    WHERE b.transactions + 1 <= $4::integer
      AND b.network_cost_micro_usdc + EXCLUDED.network_cost_micro_usdc <= $5::bigint
  RETURNING b.transactions`;

// The refund exists only together with the move to failed, and only while no signature was
// ever stored for the quote. $1 quote, $2 code, $3 the day the claim was counted on.
export const FAIL_UNSIGNED = `
  WITH failed AS (
    UPDATE gateway_quotes SET state = 'failed', code = $2
    WHERE id = $1 AND state = 'signing' AND signature IS NULL
    RETURNING customer_id, network_cost_micro_usdc),
  refunded AS (
    UPDATE gateway_budgets AS b
    SET transactions = GREATEST(b.transactions - 1, 0),
        network_cost_micro_usdc = GREATEST(b.network_cost_micro_usdc - failed.network_cost_micro_usdc, 0)
    FROM failed WHERE b.customer_id = failed.customer_id AND b.day = $3::date)
  SELECT count(*)::integer AS changed FROM failed`;

const MARK_SIGNED = "UPDATE gateway_quotes SET state = 'signed', signature = $2 WHERE id = $1 AND state = 'signing'";

const FINISH_SIGN = `
  UPDATE gateway_quotes SET state = $2::text, code = $3
  WHERE id = $1 AND (state = 'signed' OR (state = 'signing' AND $2::text <> 'sent'))`;

// The quote must still be exactly what the caller saw. A failure on chain is counted in the
// same statement, so it is counted once. $1 quote, $2 new state, $3 seen state, $4 seen signature.
export const SETTLE = `
  WITH settled AS (
    UPDATE gateway_quotes SET state = $2::text
    WHERE id = $1 AND state = $3::text AND state IN ${UNSETTLED} AND signature IS NOT DISTINCT FROM $4::text
    RETURNING customer_id),
  counted AS (
    INSERT INTO gateway_failures AS f (customer_id, failed_on_chain)
    SELECT customer_id, 1 FROM settled WHERE $2::text = 'failed_on_chain'
    ON CONFLICT (customer_id) DO UPDATE SET failed_on_chain = f.failed_on_chain + 1)
  SELECT count(*)::integer AS changed FROM settled`;

const UNSETTLED_FOR_SOURCE = `SELECT * FROM gateway_quotes WHERE source_hash = $1 AND state IN ${UNSETTLED}`;
const UNSETTLED_FOR_CUSTOMER = `
  SELECT * FROM gateway_quotes WHERE customer_id = $1 AND state IN ${UNSETTLED}
  ORDER BY claimed_at_ms LIMIT $2::integer`;

const SELECT_FAILURES = "SELECT failed_on_chain FROM gateway_failures WHERE customer_id = $1";
const RESET_FAILURES = "DELETE FROM gateway_failures WHERE customer_id = $1";

// One row per customer. A new minute starts the count again; inside the minute the row is
// raised only while it is under the limit, so no row back means over the limit. A process
// whose clock is behind counts into the newest window. $1 customer, $2 window, $3 limit.
export const COUNT_REQUEST = `
  INSERT INTO gateway_rate_windows AS r (customer_id, window_start, requests)
  VALUES ($1, $2::bigint, 1)
  ON CONFLICT (customer_id) DO UPDATE
    SET requests = CASE WHEN r.window_start < EXCLUDED.window_start THEN 1 ELSE r.requests + 1 END,
        window_start = GREATEST(r.window_start, EXCLUDED.window_start)
    WHERE r.window_start < EXCLUDED.window_start OR r.requests < $3::integer
  RETURNING r.requests`;

const SELECT_BUDGET = "SELECT transactions, network_cost_micro_usdc FROM gateway_budgets WHERE customer_id = $1 AND day = $2::date";

const toQuote = (row) => ({
  id: row.id,
  customerId: row.customer_id,
  messageHash: row.message_hash,
  sourceHash: row.source_hash,
  lastValidBlockHeight: Number(row.last_valid_block_height),
  networkCost: BigInt(row.network_cost_micro_usdc),
  platform: BigInt(row.platform_micro_usdc),
  customer: BigInt(row.customer_micro_usdc),
  createdAtMs: Number(row.created_at_ms),
  expiresAtMs: Number(row.expires_at_ms),
  state: row.state,
  claimedAtMs: row.claimed_at_ms === null ? null : Number(row.claimed_at_ms),
  signature: row.signature,
  code: row.code,
});

/** `timeoutMs` bounds connecting and every statement, on both sides of the connection. */
export function createPostgresStore({ databaseUrl, timeoutMs, retentionMs, pool: given }) {
  const pool = given ?? new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  // An idle connection that breaks must not take the process down; the next query reports it.
  pool.on?.("error", () => {});

  /** Runs `body` inside one transaction on one connection. */
  async function transaction(body) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { commit, answer } = await body(client);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return answer;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const changedOne = (result) => result.rows[0]?.changed === 1;

  return {
    /** Fails at start, not on the first customer request, when the schema is missing or old. */
    async check() {
      await pool.query("SELECT id, source_hash, last_valid_block_height FROM gateway_quotes LIMIT 0");
      await pool.query("SELECT customer_id FROM gateway_budgets LIMIT 0");
      await pool.query("SELECT failed_on_chain FROM gateway_failures LIMIT 0");
      await pool.query("SELECT requests FROM gateway_rate_windows LIMIT 0");
    },

    async putQuote(quote, { maxOpen }) {
      const nowMs = quote.createdAtMs;
      const stored = await transaction(async (client) => {
        await client.query(LOCK_CUSTOMER, [quote.customerId]);
        const inserted = await client.query(INSERT_QUOTE, [
          quote.id,
          quote.customerId,
          quote.messageHash,
          quote.sourceHash,
          String(quote.lastValidBlockHeight),
          quote.networkCost.toString(),
          quote.platform.toString(),
          quote.customer.toString(),
          String(nowMs),
          maxOpen,
          String(quote.expiresAtMs),
        ]);
        return { commit: inserted.rowCount === 1, answer: inserted.rowCount === 1 };
      });
      // Cleanup rides on writes and never decides one: a failure here is the next write's work.
      try {
        await pool.query(DELETE_EXPIRED, [String(nowMs - CLEANUP.keepExpiredMs), CLEANUP.batch]);
        await pool.query(DELETE_OLD, [String(nowMs - retentionMs), CLEANUP.batch]);
      } catch {
        // Left for the next write.
      }
      return { kind: stored ? "stored" : "too_many" };
    },

    async getQuote(id) {
      const { rows } = await pool.query(SELECT_QUOTE, [id]);
      return rows.length === 1 ? toQuote(rows[0]) : null;
    },

    // Claim and budget in one transaction: a refused budget rolls the claim back, so the
    // quote stays prepared and nothing was consumed.
    async beginSign({ quoteId, customerId, nowMs, day, cost, limits }) {
      try {
        return await transaction(async (client) => {
          const claimed = await client.query(CLAIM_QUOTE, [quoteId, customerId, String(nowMs)]);
          if (claimed.rowCount !== 1) return { commit: false, answer: { kind: "gone" } };
          const consumed = await client.query(CONSUME_BUDGET, [
            customerId,
            day,
            cost.toString(),
            limits.transactionsPerDay,
            limits.networkCostMicroUsdcPerDay.toString(),
          ]);
          if (consumed.rowCount !== 1) return { commit: false, answer: { kind: "budget" } };
          return { commit: true, answer: { kind: "claimed" } };
        });
      } catch (error) {
        if (error?.code === UNIQUE_VIOLATION) return { kind: "source_busy" };
        throw error;
      }
    },

    async failUnsigned(id, { code, day }) {
      return changedOne(await pool.query(FAIL_UNSIGNED, [id, code, day]));
    },

    async markSigned(id, signature) {
      const result = await pool.query(MARK_SIGNED, [id, signature]);
      return result.rowCount === 1;
    },

    async finishSign(id, { state, code = null }) {
      const result = await pool.query(FINISH_SIGN, [id, state, code]);
      return result.rowCount === 1;
    },

    async settle(id, seen, to) {
      return changedOne(await pool.query(SETTLE, [id, to, seen.state, seen.signature]));
    },

    async unsettledForSource(sourceHash) {
      const { rows } = await pool.query(UNSETTLED_FOR_SOURCE, [sourceHash]);
      return rows.map(toQuote);
    },

    async unsettledForCustomer(customerId, limit) {
      const { rows } = await pool.query(UNSETTLED_FOR_CUSTOMER, [customerId, limit]);
      return rows.map(toQuote);
    },

    async failures(customerId) {
      const { rows } = await pool.query(SELECT_FAILURES, [customerId]);
      return rows.length === 0 ? 0 : rows[0].failed_on_chain;
    },

    async resetFailures(customerId) {
      await pool.query(RESET_FAILURES, [customerId]);
    },

    async allowRequest(customerId, requestsPerMinute, nowMs) {
      const result = await pool.query(COUNT_REQUEST, [customerId, String(Math.floor(nowMs / RATE_WINDOW_MS)), requestsPerMinute]);
      return result.rowCount === 1;
    },

    async budgetUsed(customerId, day) {
      const { rows } = await pool.query(SELECT_BUDGET, [customerId, day]);
      if (rows.length === 0) return { transactions: 0, cost: 0n };
      return { transactions: rows[0].transactions, cost: BigInt(rows[0].network_cost_micro_usdc) };
    },

    async close() {
      await pool.end();
    },
  };
}
