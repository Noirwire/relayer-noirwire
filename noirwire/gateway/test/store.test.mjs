import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMemoryStore } from "../src/store/memory.mjs";
import { CONSUME_BUDGET, createPostgresStore } from "../src/store/postgres.mjs";
import { NOW } from "./helpers.mjs";

// One contract, run against every store. The in-memory store always runs. The Postgres store
// runs only when GATEWAY_TEST_DATABASE_URL names a database that has the migration applied;
// without it those tests are skipped, since no test may reach for the network by itself.

const NOW_MS = NOW * 1000;
const DAY = "2027-01-15";
const LIMITS = { transactionsPerDay: 3, networkCostMicroUsdcPerDay: 5_000n };

const quoteFor = (customerId, fields = {}) => ({
  id: randomUUID(),
  customerId,
  messageHash: "ab".repeat(32),
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
    await store.putQuote(quote);
    assert.deepEqual(await store.getQuote(quote.id), { ...quote, state: "prepared", signature: null, code: null, claimedAtMs: null });
    assert.equal(await store.getQuote(randomUUID()), null);
  });

  run("a quote is claimed once, and the claim consumes the budget", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote);
    assert.deepEqual(await begin(store, customerId, quote), { kind: "claimed" });
    assert.deepEqual(await begin(store, customerId, quote), { kind: "gone" });
    assert.equal((await store.getQuote(quote.id)).state, "signing");
    assert.equal((await store.getQuote(quote.id)).claimedAtMs, NOW_MS + 1_000);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 1_600n });
  });

  run("an expired, unknown or foreign quote is not claimed and consumes nothing", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote);
    assert.deepEqual(await begin(store, customerId, quote, { nowMs: quote.expiresAtMs }), { kind: "gone" });
    assert.deepEqual(await begin(store, "someone-else", quote), { kind: "gone" });
    assert.deepEqual(await begin(store, customerId, { ...quote, id: randomUUID() }), { kind: "gone" });
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 0, cost: 0n });
    assert.deepEqual(await store.budgetUsed("someone-else", DAY), { transactions: 0, cost: 0n });
    assert.equal((await store.getQuote(quote.id)).state, "prepared");
  });

  run("a refused budget leaves the quote prepared and the budget as it was", async (store, customerId) => {
    const quotes = Array.from({ length: 4 }, () => quoteFor(customerId));
    for (const quote of quotes) await store.putQuote(quote);
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
    for (const quote of [exact, over, one]) await store.putQuote(quote);
    assert.deepEqual(await begin(store, customerId, over), { kind: "budget" });
    assert.deepEqual(await begin(store, customerId, exact), { kind: "claimed" });
    assert.deepEqual(await begin(store, customerId, one), { kind: "budget" });
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 1, cost: 5_000n });
  });

  run("concurrent claims: each quote once, and never past the budget", async (store, customerId) => {
    const quotes = Array.from({ length: 10 }, () => quoteFor(customerId));
    for (const quote of quotes) await store.putQuote(quote);
    // Every quote is claimed by three callers at once.
    const results = await Promise.all(quotes.flatMap((quote) => [0, 1, 2].map(() => begin(store, customerId, quote))));
    assert.equal(results.filter((result) => result.kind === "claimed").length, 3);
    assert.deepEqual(await store.budgetUsed(customerId, DAY), { transactions: 3, cost: 4_800n });
    const states = await Promise.all(quotes.map(async (quote) => (await store.getQuote(quote.id)).state));
    assert.equal(states.filter((state) => state === "signing").length, 3);
    assert.equal(states.filter((state) => state === "prepared").length, 7);
  });

  run("a claimed quote is finished once; anything else cannot be finished", async (store, customerId) => {
    const quote = quoteFor(customerId);
    await store.putQuote(quote);
    assert.equal(await store.finishSign(quote.id, { state: "sent", signature: "sig" }), false);
    await begin(store, customerId, quote);
    assert.equal(await store.finishSign(quote.id, { state: "sent", signature: "sig" }), true);
    assert.equal(await store.finishSign(quote.id, { state: "failed", code: "kora_refused" }), false);
    const stored = await store.getQuote(quote.id);
    assert.deepEqual([stored.state, stored.signature, stored.code], ["sent", "sig", null]);
    assert.equal(await store.finishSign(randomUUID(), { state: "sent", signature: "sig" }), false);
  });
}

contract("memory", async () => createMemoryStore(), false);

const databaseUrl = process.env.GATEWAY_TEST_DATABASE_URL;
contract("postgres", async () => createPostgresStore({ databaseUrl, timeoutMs: 5_000 }), databaseUrl ? false : "set GATEWAY_TEST_DATABASE_URL to run");

test("the in-memory store drops prepared quotes long after they expired, and keeps signed ones", async () => {
  const store = createMemoryStore();
  const stale = quoteFor("acme");
  const signed = quoteFor("acme");
  await store.putQuote(stale);
  await store.putQuote(signed);
  await store.beginSign({ quoteId: signed.id, customerId: "acme", nowMs: NOW_MS, day: DAY, cost: 1n, limits: LIMITS });
  await store.putQuote(quoteFor("acme", { createdAtMs: NOW_MS + 2 * 3_600_000, expiresAtMs: NOW_MS + 2 * 3_600_000 + 45_000 }));
  assert.equal(await store.getQuote(stale.id), null);
  assert.equal((await store.getQuote(signed.id)).state, "signing");
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
  const storeWith = (answers) => createPostgresStore({ pool: { connect: async () => client(answers), on() {} } });
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
