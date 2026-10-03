import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CLEANUP, createMemoryStore, UNSETTLED_STATES } from "../src/store/memory.mjs";
import { CONSUME_BUDGET, COUNT_REQUEST, createPostgresStore, FAIL_UNSIGNED, INSERT_QUOTE, SETTLE } from "../src/store/postgres.mjs";
import { NOW } from "./helpers.mjs";

// One contract, run against every store. The in-memory store always runs. The Postgres store
// runs only when GATEWAY_TEST_DATABASE_URL names a database that has the migration applied;
// without it those tests are skipped, since no test may reach for the network by itself.

const NOW_MS = NOW * 1000;
const DAY = "2027-01-15";
const LIMITS = { transactionsPerDay: 3, networkCostMicroUsdcPerDay: 5_000n };
const RETENTION_MS = 30 * 86_400_000;
const MANY = { maxOpen: 1_000 };
const sourceHash = () => createHash("sha256").update(randomUUID()).digest("hex");

const quoteFor = (customerId, fields = {}) => ({
  id: randomUUID(),
  customerId,
  messageHash: "ab".repeat(32),
  // Each quote its own source account, unless a test is about sharing one.
  sourceHash: sourceHash(),
  lastValidBlockHeight: 1_000,
  networkCost: 1_600n,
  platform: 1_760n,
  customer: 640n,
  createdAtMs: NOW_MS,
  expiresAtMs: NOW_MS + 45_000,
  ...fields,
});

function contract(name, open, skip) {
  const run = (title, body) =>
    test(`${name} store: ${title}`, { skip }, async () => {
      const store = await open();
      // A fresh customer per test, so tests against a shared database do not meet.
      const customerId = `test-${randomUUID().slice(0, 8)}`;
      try {
        await body(store, customerId);
      } finally {
        await store.close();
      }
    });
  const begin = (store, customerId, quote, fields = {}) =>
    store.beginSign({ quoteId: quote.id, customerId, nowMs: NOW_MS + 1_000, day: DAY, cost: quote.networkCost, limits: LIMITS, ...fields });

  run("a quote is stored prepared and read back exactly", async (store, customerId) => {
    const quote = quoteFor(customerId, { networkCost: 9_007_199_254_740_993n, platform: 9_007_199_254_740_994n });
    await store.putQuote(quote, MANY);
    assert.deepEqual(await store.getQuote(quote.id), { ...quote, state: "prepared", signature: null, code: null, claimedAtMs: null });
    assert.equal(await store.getQuote(randomUUID()), null);
  });

  run("a quote is claimed once, and the claim consumes the budget", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote, MANY);
    assert.deepEqual(await begin(store, customerId, quote), { kind: "claimed" });
    assert.deepEqual(await begin(store, customerId, quote), { kind: "gone" });
    assert.equal((await store.getQuote(quote.id)).state, "signing");
    assert.equal((await store.getQuote(quote.id)).claimedAtMs, NOW_MS + 1_000);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 1_600n });
  });

  run("an expired, unknown or foreign quote is not claimed and consumes nothing", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote, MANY);
    assert.deepEqual(await begin(store, customerId, quote, { nowMs: quote.expiresAtMs }), { kind: "gone" });
    assert.deepEqual(await begin(store, "someone-else", quote), { kind: "gone" });
    assert.deepEqual(await begin(store, customerId, { ...quote, id: randomUUID() }), { kind: "gone" });
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 0, cost: 0n });
    assert.deepEqual(await store.budgetUsed("someone-else", DAY), { transactions: 0, cost: 0n });
    assert.equal((await store.getQuote(quote.id)).state, "prepared");
  });

  run("a refused budget leaves the quote prepared and the budget as it was", async (store, customerId) => {
    const quotes = Array.from({ length: 4 }, () => quoteFor(customerId));
    for (const quote of quotes) await store.putQuote(quote, MANY);
    for (const quote of quotes.slice(0, 3)) assert.equal((await begin(store, customerId, quote)).kind, "claimed");
    // The transaction count is full; the cost limit is not (4,800 of 5,000).
    assert.deepEqual(await begin(store, customerId, quotes[3]), { kind: "budget" });
    assert.equal((await store.getQuote(quotes[3].id)).state, "prepared");
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 3, cost: 4_800n });
    // Another day has its own budget.
    assert.equal((await begin(store, customerId, quotes[3], { day: "2027-01-16" })).kind, "claimed");
  });

  run("the cost limit is exact, also for the first transaction of the day", async (store, customerId) => {
    const exact = quoteFor(customerId, { networkCost: 5_000n, platform: 5_000n });
    const over = quoteFor(customerId, { networkCost: 5_001n, platform: 5_001n });
    const one = quoteFor(customerId, { networkCost: 1n, platform: 1n });
    for (const quote of [exact, over, one]) await store.putQuote(quote, MANY);
    assert.deepEqual(await begin(store, customerId, over), { kind: "budget" });
    assert.deepEqual(await begin(store, customerId, exact), { kind: "claimed" });
    assert.deepEqual(await begin(store, customerId, one), { kind: "budget" });
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 5_000n });
  });

  run("concurrent claims: each quote once, and never past the budget", async (store, customerId) => {
    const quotes = Array.from({ length: 10 }, () => quoteFor(customerId));
    for (const quote of quotes) await store.putQuote(quote, MANY);
    // Every quote is claimed by three callers at once.
    const results = await Promise.all(quotes.flatMap((quote) => [0, 1, 2].map(() => begin(store, customerId, quote))));
    assert.equal(results.filter((result) => result.kind === "claimed").length, 3);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 3, cost: 4_800n });
    const states = await Promise.all(quotes.map(async (quote) => (await store.getQuote(quote.id)).state));
    assert.equal(states.filter((state) => state === "signing").length, 3);
    assert.equal(states.filter((state) => state === "prepared").length, 7);
  });

  run("the signature is recorded before the outcome, and each step happens once", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote, MANY);
    // Nothing can be recorded for a quote that was not claimed.
    assert.equal(await store.markSigned(quote.id, "sig"), false);
    assert.equal(await store.finishSign(quote.id, { state: "sent" }), false);
    await begin(store, customerId, quote);
    // Sent needs a recorded signature first.
    assert.equal(await store.finishSign(quote.id, { state: "sent" }), false);
    assert.equal(await store.markSigned(quote.id, "sig"), true);
    assert.equal(await store.markSigned(quote.id, "other"), false);
    let stored = await store.getQuote(quote.id);
    assert.deepEqual([stored.state, stored.signature], ["signed", "sig"]);
    assert.equal(await store.finishSign(quote.id, { state: "sent" }), true);
    assert.equal(await store.finishSign(quote.id, { state: "failed", code: "broadcast_rejected" }), false);
    stored = await store.getQuote(quote.id);
    assert.deepEqual([stored.state, stored.signature, stored.code], ["sent", "sig", null]);
    assert.equal(await store.finishSign(randomUUID(), { state: "sent" }), false);
  });

  run("a claim that ends unsigned is refunded once; a signed one never", async (store, customerId) => {
    const [refused, signed] = [quoteFor(customerId), quoteFor(customerId)];
    for (const quote of [refused, signed]) await store.putQuote(quote, MANY);
    for (const quote of [refused, signed]) await begin(store, customerId, quote);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 2, cost: 3_200n });
    assert.equal(await store.failUnsigned(refused.id, { code: "kora_refused", day: DAY }), true);
    assert.equal(await store.failUnsigned(refused.id, { code: "kora_refused", day: DAY }), false);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 1_600n });
    const stored = await store.getQuote(refused.id);
    assert.deepEqual([stored.state, stored.code], ["failed", "kora_refused"]);
    await store.markSigned(signed.id, "sig");
    assert.equal(await store.failUnsigned(signed.id, { code: "kora_refused", day: DAY }), false);
    assert.equal((await store.getQuote(signed.id)).state, "signed");
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 1_600n });
  });

  run("one unsettled quote per source account, across customers, until it is settled", async (store, customerId) => {
    const shared = sourceHash();
    const [first, second] = [quoteFor(customerId, { sourceHash: shared }), quoteFor(customerId, { sourceHash: shared })];
    const foreign = quoteFor(`${customerId}-b`, { sourceHash: shared });
    for (const quote of [first, second, foreign]) await store.putQuote(quote, MANY);
    assert.deepEqual(await store.unsettledForSource(shared), []);
    assert.deepEqual(await begin(store, customerId, first), { kind: "claimed" });
    // Refused in every unsettled state, and the refusal consumes nothing.
    for (const advance of [() => {}, () => store.markSigned(first.id, "sig"), () => store.finishSign(first.id, { state: "sent" })]) {
      await advance();
      assert.deepEqual(await begin(store, customerId, second), { kind: "source_busy" });
      assert.deepEqual(await begin(store, `${customerId}-b`, foreign), { kind: "source_busy" });
    }
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 1_600n });
    assert.equal((await store.getQuote(second.id)).state, "prepared");
    assert.deepEqual((await store.unsettledForSource(shared)).map((quote) => quote.id), [first.id]);

    assert.equal(await store.settle(first.id, { state: "sent", signature: "sig" }, "landed"), true);
    assert.deepEqual(await store.unsettledForSource(shared), []);
    assert.deepEqual(await begin(store, customerId, second), { kind: "claimed" });
  });

  run("a source held by an unknown outcome is busy too", async (store, customerId) => {
    const shared = sourceHash();
    const [first, second] = [quoteFor(customerId, { sourceHash: shared }), quoteFor(customerId, { sourceHash: shared })];
    for (const quote of [first, second]) await store.putQuote(quote, MANY);
    await begin(store, customerId, first);
    await store.finishSign(first.id, { state: "unknown" });
    assert.deepEqual(await begin(store, customerId, second), { kind: "source_busy" });
    // A failure before anything was broadcast settles the source at once.
    assert.equal(await store.settle(first.id, { state: "unknown", signature: null }, "expired"), true);
    assert.deepEqual(await begin(store, customerId, second), { kind: "claimed" });
    await store.failUnsigned(second.id, { code: "kora_refused", day: DAY });
    assert.deepEqual(await store.unsettledForSource(shared), []);
  });

  run("concurrent claims of one source: one is claimed", async (store, customerId) => {
    const shared = sourceHash();
    const quotes = Array.from({ length: 6 }, () => quoteFor(customerId, { sourceHash: shared }));
    for (const quote of quotes) await store.putQuote(quote, MANY);
    const results = await Promise.all(quotes.map((quote) => begin(store, customerId, quote)));
    assert.equal(results.filter((result) => result.kind === "claimed").length, 1);
    assert.equal(results.filter((result) => result.kind === "source_busy").length, 5);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 1_600n });
  });

  run("a quote settles once, only as it was seen, and a failure on chain is counted once", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote, MANY);
    // Not unsettled: nothing to settle.
    assert.equal(await store.settle(quote.id, { state: "prepared", signature: null }, "expired"), false);
    await begin(store, customerId, quote);
    await store.markSigned(quote.id, "sig");
    // Seen before the signature was recorded: the quote changed, so this verdict is void.
    assert.equal(await store.settle(quote.id, { state: "signing", signature: null }, "expired"), false);
    assert.equal(await store.settle(quote.id, { state: "signed", signature: "other" }, "expired"), false);
    assert.equal(await store.failures(customerId), 0);
    assert.equal(await store.settle(quote.id, { state: "signed", signature: "sig" }, "failed_on_chain"), true);
    assert.equal(await store.settle(quote.id, { state: "signed", signature: "sig" }, "failed_on_chain"), false);
    assert.equal((await store.getQuote(quote.id)).state, "failed_on_chain");
    assert.equal(await store.failures(customerId), 1);
    assert.equal(await store.failures(`${customerId}-b`), 0);
    // The outcome of the broadcast arrives late: the settled state stands.
    assert.equal(await store.finishSign(quote.id, { state: "sent" }), false);
    await store.resetFailures(customerId);
    assert.equal(await store.failures(customerId), 0);
  });

  run("landing and expiring are not failures on chain", async (store, customerId) => {
    for (const to of ["landed", "expired"]) {
      const quote = quoteFor(customerId);
      await store.putQuote(quote, MANY);
      await begin(store, customerId, quote, { limits: { transactionsPerDay: 10, networkCostMicroUsdcPerDay: 100_000n } });
      await store.markSigned(quote.id, "sig");
      assert.equal(await store.settle(quote.id, { state: "signed", signature: "sig" }, to), true);
    }
    assert.equal(await store.failures(customerId), 0);
  });

  run("the customer's oldest unsettled quotes, a few at a time", async (store, customerId) => {
    const quotes = Array.from({ length: 4 }, () => quoteFor(customerId));
    const limits = { transactionsPerDay: 10, networkCostMicroUsdcPerDay: 100_000n };
    for (const [index, quote] of quotes.entries()) {
      await store.putQuote(quote, MANY);
      await begin(store, customerId, quote, { nowMs: NOW_MS + 1_000 + index, limits });
    }
    await store.failUnsigned(quotes[1].id, { code: "kora_refused", day: DAY });
    assert.deepEqual((await store.unsettledForCustomer(customerId, 2)).map((quote) => quote.id), [quotes[0].id, quotes[2].id]);
    assert.deepEqual((await store.unsettledForCustomer(customerId, 10)).map((quote) => quote.id), [quotes[0].id, quotes[2].id, quotes[3].id]);
    assert.deepEqual(await store.unsettledForCustomer(`${customerId}-b`, 10), []);
  });

  run("a customer's open quotes are capped; expired, signed and foreign ones do not count", async (store, customerId) => {
    const cap = { maxOpen: 2 };
    const [first, second, third] = Array.from({ length: 3 }, () => quoteFor(customerId));
    assert.deepEqual(await store.putQuote(first, cap), { kind: "stored" });
    assert.deepEqual(await store.putQuote(second, cap), { kind: "stored" });
    assert.deepEqual(await store.putQuote(third, cap), { kind: "too_many" });
    assert.equal(await store.getQuote(third.id), null);
    assert.deepEqual(await store.putQuote(quoteFor(`${customerId}-b`), cap), { kind: "stored" });
    // Signing one makes room.
    await begin(store, customerId, first);
    assert.deepEqual(await store.putQuote(third, cap), { kind: "stored" });
    assert.deepEqual(await store.putQuote(quoteFor(customerId), cap), { kind: "too_many" });
    // So does expiry.
    const later = NOW_MS + 45_000;
    assert.deepEqual(await store.putQuote(quoteFor(customerId, { createdAtMs: later, expiresAtMs: later + 45_000 }), cap), { kind: "stored" });
  });

  run("concurrent prepares never pass the cap on open quotes", async (store, customerId) => {
    const results = await Promise.all(Array.from({ length: 12 }, () => store.putQuote(quoteFor(customerId), { maxOpen: 5 })));
    assert.equal(results.filter((result) => result.kind === "stored").length, 5);
    assert.equal(results.filter((result) => result.kind === "too_many").length, 7);
  });

  run("requests are counted per customer per minute", async (store, customerId) => {
    assert.equal(await store.allowRequest(customerId, 2, NOW_MS), true);
    assert.equal(await store.allowRequest(customerId, 2, NOW_MS + 59_999 - (NOW_MS % 60_000)), true);
    assert.equal(await store.allowRequest(customerId, 2, NOW_MS), false);
    assert.equal(await store.allowRequest(`${customerId}-b`, 2, NOW_MS), true);
    assert.equal(await store.allowRequest(customerId, 2, NOW_MS + 60_000), true);
    // A request stamped by a clock that is behind counts into the current minute.
    assert.equal(await store.allowRequest(customerId, 2, NOW_MS), true);
    assert.equal(await store.allowRequest(customerId, 2, NOW_MS), false);
  });

  run("concurrent requests never pass the rate limit", async (store, customerId) => {
    const results = await Promise.all(Array.from({ length: 20 }, () => store.allowRequest(customerId, 7, NOW_MS)));
    assert.equal(results.filter(Boolean).length, 7);
  });

  run("writes clean up: expired quotes after a grace, closed records after the retention", async (store, customerId) => {
    const expired = quoteFor(customerId);
    const closed = quoteFor(customerId);
    const unsettled = quoteFor(customerId);
    for (const quote of [expired, closed, unsettled]) await store.putQuote(quote, MANY);
    await begin(store, customerId, closed);
    await store.failUnsigned(closed.id, { code: "kora_refused", day: DAY });
    await begin(store, customerId, unsettled);
    const put = (atMs) => store.putQuote(quoteFor(customerId, { createdAtMs: atMs, expiresAtMs: atMs + 45_000 }), MANY);

    // Inside the grace an expired quote still answers "expired" rather than "not found".
    await put(expired.expiresAtMs + CLEANUP.keepExpiredMs);
    assert.equal((await store.getQuote(expired.id)).state, "prepared");
    await put(expired.expiresAtMs + CLEANUP.keepExpiredMs + 1);
    assert.equal(await store.getQuote(expired.id), null);
    assert.equal((await store.getQuote(closed.id)).state, "failed");

    await put(NOW_MS + RETENTION_MS);
    assert.equal((await store.getQuote(closed.id)).state, "failed");
    await put(NOW_MS + RETENTION_MS + 1);
    assert.equal(await store.getQuote(closed.id), null);
    // After the retention nothing can still land, so an unsettled record goes too.
    assert.equal(await store.getQuote(unsettled.id), null);
  });
}

contract("memory", async () => createMemoryStore({ retentionMs: RETENTION_MS }), false);

const databaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;
contract("postgres", async () => createPostgresStore({ databaseUrl, timeoutMs: 5_000, retentionMs: RETENTION_MS }), databaseUrl ? false : "set GATEWAY_TEST_DATABASE_URL to run");

test("the in-memory store cleans up a bounded batch per write", async () => {
  const store = createMemoryStore({ retentionMs: RETENTION_MS });
  const count = CLEANUP.batch + 50;
  const stale = Array.from({ length: count }, () => quoteFor("acme"));
  for (const quote of stale) await store.putQuote(quote, { maxOpen: count });
  const remaining = async () => (await Promise.all(stale.map((quote) => store.getQuote(quote.id)))).filter(Boolean).length;
  const later = NOW_MS + 3_600_000;
  await store.putQuote(quoteFor("acme", { createdAtMs: later, expiresAtMs: later + 45_000 }), MANY);
  assert.equal(await remaining(), 50);
  await store.putQuote(quoteFor("acme", { createdAtMs: later, expiresAtMs: later + 45_000 }), MANY);
  assert.equal(await remaining(), 0);
});

test("the Postgres budget statement checks both limits in the insert and in the update", () => {
  // The single statement is the atomicity; this pins its shape against an accidental edit.
  const sql = CONSUME_BUDGET.replace(/\s+/g, " ");
  assert.match(sql, /INSERT INTO gateway_budgets AS b .* SELECT \$1, \$2::date, 1, \$3::bigint WHERE 1 <= \$4::integer AND \$3::bigint <= \$5::bigint/);
  assert.match(sql, /ON CONFLICT \(customer_id, day\) DO UPDATE SET .* WHERE b\.transactions \+ 1 <= \$4::integer AND b\.network_cost_micro_usdc \+ EXCLUDED\.network_cost_micro_usdc <= \$5::bigint RETURNING/);
});

test("the Postgres store rolls the claim back when the budget refuses, and on any error", async () => {
  const statements = [];
  const client = (answers) => ({
    async query(sql) {
      const text = sql.replace(/\s+/g, " ").trim();
      statements.push(text.split(" ").slice(0, 3).join(" "));
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer ?? { rowCount: 0, rows: [] };
    },
    release: () => statements.push("release"),
  });
  const storeWith = (answers) => createPostgresStore({ retentionMs: RETENTION_MS, pool: { connect: async () => client(answers), on() {} } });
  const args = { quoteId: "q", customerId: "acme", nowMs: NOW_MS, day: DAY, cost: 1_600n, limits: LIMITS };

  assert.deepEqual(await storeWith([{}, { rowCount: 1 }, { rowCount: 0 }, {}]).beginSign(args), { kind: "budget" });
  assert.deepEqual(statements, ["BEGIN", "UPDATE gateway_quotes SET", "INSERT INTO gateway_budgets", "ROLLBACK", "release"]);

  statements.length = 0;
  assert.deepEqual(await storeWith([{}, { rowCount: 0 }, {}]).beginSign(args), { kind: "gone" });
  assert.deepEqual(statements, ["BEGIN", "UPDATE gateway_quotes SET", "ROLLBACK", "release"]);

  statements.length = 0;
  assert.deepEqual(await storeWith([{}, { rowCount: 1 }, { rowCount: 1 }, {}]).beginSign(args), { kind: "claimed" });
  assert.deepEqual(statements, ["BEGIN", "UPDATE gateway_quotes SET", "INSERT INTO gateway_budgets", "COMMIT", "release"]);

  statements.length = 0;
  await assert.rejects(storeWith([{}, { rowCount: 1 }, new Error("connection lost"), {}]).beginSign(args), /connection lost/);
  assert.deepEqual(statements, ["BEGIN", "UPDATE gateway_quotes SET", "INSERT INTO gateway_budgets", "ROLLBACK", "release"]);
});

test("the Postgres store answers source_busy when the claim meets the unique index of unsettled sources", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const text = sql.replace(/\s+/g, " ").trim();
      statements.push(text.split(" ").slice(0, 3).join(" "));
      if (text.startsWith("UPDATE gateway_quotes SET state = 'signing'")) throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return { rowCount: 0, rows: [] };
    },
    release: () => statements.push("release"),
  };
  const store = createPostgresStore({ retentionMs: RETENTION_MS, pool: { connect: async () => client, on() {} } });
  const answer = await store.beginSign({ quoteId: "q", customerId: "acme", nowMs: NOW_MS, day: DAY, cost: 1_600n, limits: LIMITS });
  assert.deepEqual(answer, { kind: "source_busy" });
  assert.deepEqual(statements, ["BEGIN", "UPDATE gateway_quotes SET", "ROLLBACK", "release"]);
});

test("the Postgres statements keep the shapes their atomicity rests on", () => {
  const flat = (sql) => sql.replace(/\s+/g, " ");
  // The cap is checked by the insert itself.
  assert.match(flat(INSERT_QUOTE), /INSERT INTO gateway_quotes .* SELECT .* WHERE \(SELECT count\(\*\) FROM gateway_quotes WHERE customer_id = \$2::text AND state = 'prepared' AND expires_at_ms > \$9::bigint\) < \$10::integer/);
  // The refund is part of the move to failed, and only for a quote without a signature.
  assert.match(flat(FAIL_UNSIGNED), /UPDATE gateway_quotes SET state = 'failed', code = \$2 WHERE id = \$1 AND state = 'signing' AND signature IS NULL RETURNING .* UPDATE gateway_budgets AS b SET transactions = GREATEST\(b\.transactions - 1, 0\)/);
  // A quote settles only as it was seen, and the failure count rises in the same statement.
  assert.match(flat(SETTLE), /WHERE id = \$1 AND state = \$3::text AND state IN \('signing', 'signed', 'sent', 'unknown'\) AND signature IS NOT DISTINCT FROM \$4::text RETURNING customer_id\)/);
  assert.match(flat(SETTLE), /INSERT INTO gateway_failures AS f .* FROM settled WHERE \$2::text = 'failed_on_chain' ON CONFLICT \(customer_id\) DO UPDATE SET failed_on_chain = f\.failed_on_chain \+ 1/);
  // The rate window is raised only while under the limit.
  assert.match(flat(COUNT_REQUEST), /ON CONFLICT \(customer_id\) DO UPDATE .* WHERE r\.window_start < EXCLUDED\.window_start OR r\.requests < \$3::integer RETURNING/);
});

test("the migration has every table, state and index the store relies on", () => {
  const sql = readFileSync(new URL("../migrations/001_gateway.sql", import.meta.url), "utf8").replace(/\s+/g, " ");
  for (const table of ["gateway_quotes", "gateway_budgets", "gateway_failures", "gateway_rate_windows"]) assert.ok(sql.includes(`CREATE TABLE ${table} (`), table);
  for (const column of ["source_hash", "last_valid_block_height", "signature", "failed_on_chain", "window_start"]) assert.ok(sql.includes(column), column);
  const unsettled = UNSETTLED_STATES.map((state) => `'${state}'`).join(", ");
  assert.ok(sql.includes(`CREATE UNIQUE INDEX gateway_quotes_one_unsettled_per_source ON gateway_quotes (source_hash) WHERE state IN (${unsettled});`));
  for (const state of ["prepared", ...UNSETTLED_STATES, "failed", "landed", "failed_on_chain", "expired"]) assert.ok(sql.includes(`'${state}'`), state);
});
