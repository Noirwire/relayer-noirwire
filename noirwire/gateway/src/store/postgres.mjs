import pg from "pg";

// The store, in Postgres: quotes and budgets shared by every process. The interface is
// described in store/memory.mjs; the schema is migrations/001_gateway.sql.

const INSERT_QUOTE = `
  INSERT INTO gateway_quotes
    (id, customer_id, message_hash, network_cost_micro_usdc, platform_micro_usdc, customer_micro_usdc, created_at_ms, expires_at_ms)
  VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6::bigint, $7::bigint, $8::bigint)`;

const SELECT_QUOTE = "SELECT * FROM gateway_quotes WHERE id = $1";

// Only a prepared, unexpired quote of this customer can be claimed, and only once.
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

const FINISH_SIGN = `
  UPDATE gateway_quotes SET state = $2, signature = $3, code = $4
  WHERE id = $1 AND state = 'signing'`;

const SELECT_BUDGET = "SELECT transactions, network_cost_micro_usdc FROM gateway_budgets WHERE customer_id = $1 AND day = $2::date";

const toQuote = (row) => ({
  id: row.id,
  customerId: row.customer_id,
  messageHash: row.message_hash,
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
export function createPostgresStore({ databaseUrl, timeoutMs, pool: given }) {
  const pool = given ?? new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  // An idle connection that breaks must not take the process down; the next query reports it.
  pool.on?.("error", () => {});

  return {
    /** Fails at start, not on the first customer request, when the schema is missing. */
    async check() {
      await pool.query("SELECT id FROM gateway_quotes LIMIT 0");
      await pool.query("SELECT customer_id FROM gateway_budgets LIMIT 0");
    },

    async putQuote(quote) {
      await pool.query(INSERT_QUOTE, [
        quote.id,
        quote.customerId,
        quote.messageHash,
        quote.networkCost.toString(),
        quote.platform.toString(),
        quote.customer.toString(),
        String(quote.createdAtMs),
        String(quote.expiresAtMs),
      ]);
    },

    async getQuote(id) {
      const { rows } = await pool.query(SELECT_QUOTE, [id]);
      return rows.length === 1 ? toQuote(rows[0]) : null;
    },

    // Claim and budget in one transaction: a refused budget rolls the claim back, so the
    // quote stays prepared and nothing was consumed.
    async beginSign({ quoteId, customerId, nowMs, day, cost, limits }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const claimed = await client.query(CLAIM_QUOTE, [quoteId, customerId, String(nowMs)]);
        if (claimed.rowCount !== 1) {
          await client.query("ROLLBACK");
          return { kind: "gone" };
        }
        const consumed = await client.query(CONSUME_BUDGET, [
          customerId,
          day,
          cost.toString(),
          limits.transactionsPerDay,
          limits.networkCostMicroUsdcPerDay.toString(),
        ]);
        if (consumed.rowCount !== 1) {
          await client.query("ROLLBACK");
          return { kind: "budget" };
        }
        await client.query("COMMIT");
        return { kind: "claimed" };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async finishSign(id, { state, signature = null, code = null }) {
      const result = await pool.query(FINISH_SIGN, [id, state, signature, code]);
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
