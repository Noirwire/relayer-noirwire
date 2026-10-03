import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { hashApiKey } from "../src/customers.mjs";
import { API_KEY, makeWorld, USDC } from "./helpers.mjs";

const base = makeWorld();
const load = (env = {}, entries = [base.customerEntry]) =>
  loadConfig({ ...base.env, ...env }, () => (typeof entries === "string" ? entries : JSON.stringify({ customers: entries })));
const refuses = (pattern, env, entries) =>
  assert.throws(() => load(env, entries), (error) => {
    assert.ok(error instanceof ConfigError, `threw ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
const withCustomer = (fields) => [{ ...base.customerEntry, ...fields }];
const second = (fields = {}) => {
  const wallet = () => Keypair.generate().publicKey;
  return {
    ...base.customerEntry,
    id: "globex",
    apiKeyHash: hashApiKey("another-key"),
    feePayer: wallet().toBase58(),
    paymentAccount: getAssociatedTokenAddressSync(USDC, wallet()).toBase58(),
    koraUrl: "http://kora-globex.invalid/",
    ...fields,
  };
};
const secondEnv = { GATEWAY_HMAC_SECRET_GLOBEX: "g".repeat(40), KORA_API_KEY_GLOBEX: "h".repeat(40), KORA_HMAC_SECRET_GLOBEX: "i".repeat(40) };

test("defaults are the documented numbers", () => {
  const cfg = load();
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.usdcMint.toBase58(), "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(cfg.computeUnitLimit, 30_000);
  assert.equal(cfg.maxPriorityMicroLamports, 500_000n);
  assert.equal(cfg.maxNetworkCostMicroUsdc, 100_000n);
  assert.equal(cfg.costBufferBps, 0);
  assert.equal(cfg.quoteTtlMs, 45_000);
  assert.equal(cfg.maxPriceAgeSeconds, 60);
  assert.equal(cfg.upstreamTimeoutMs, 15_000);
  assert.equal(cfg.store, "memory");
});

test("loads a customer with its public fields and its secrets from the environment", () => {
  const cfg = load();
  const customer = cfg.customers.byId.get("acme");
  assert.equal(customer.markupBps, 5_000);
  assert.equal(customer.budgets.networkCostMicroUsdcPerDay, 1_000_000n);
  assert.ok(customer.feePayer.equals(base.feePayer.publicKey));
  assert.deepEqual(cfg.customers.secretsFor("acme"), base.secrets);
  assert.equal(cfg.customers.findByApiKey(API_KEY), customer);
  assert.equal(cfg.customers.findByApiKey("wrong"), null);
  // Secrets are not on the customer, so a customer can be logged without leaking one.
  assert.ok(!JSON.stringify(customer, (_, value) => (typeof value === "bigint" ? value.toString() : value)).includes(base.secrets.hmacSecret));
});

test("the mint is configurable per network", () => {
  const devnetMint = Keypair.generate().publicKey.toBase58();
  assert.equal(load({ USDC_MINT: devnetMint }).usdcMint.toBase58(), devnetMint);
  refuses(/USDC_MINT/, { USDC_MINT: "not-a-key" });
});

test("STORE has no default and Postgres needs its URL", () => {
  refuses(/STORE: required/, { STORE: "" });
  refuses(/STORE/, { STORE: "redis" });
  refuses(/DATABASE_URL/, { STORE: "postgres" });
  refuses(/DATABASE_URL/, { STORE: "postgres", DATABASE_URL: "mysql://x" });
  assert.equal(load({ STORE: "postgres", DATABASE_URL: "postgres://u:p@localhost/db" }).store, "postgres");
});

test("refuses a missing RPC, a missing or unreadable customers file, and bad JSON", () => {
  refuses(/RPC_URL/, { RPC_URL: "" });
  refuses(/CUSTOMERS_FILE: required/, { CUSTOMERS_FILE: "" });
  assert.throws(() => loadConfig(base.env, () => { throw new Error("ENOENT /secret/path"); }), (error) => /CUSTOMERS_FILE: could not be read/.test(error.message) && !error.message.includes("secret"));
  refuses(/not valid JSON/, {}, "{ nope");
  refuses(/non-empty "customers" list/, {}, "[]");
  refuses(/non-empty "customers" list/, {}, []);
});

test("refuses settings outside their hard ranges", () => {
  refuses(/PORT/, { PORT: "0" });
  refuses(/PORT/, { PORT: "70000" });
  refuses(/COMPUTE_UNIT_LIMIT/, { COMPUTE_UNIT_LIMIT: "1400000" });
  refuses(/MAX_PRIORITY_MICRO_LAMPORTS/, { MAX_PRIORITY_MICRO_LAMPORTS: "999999999" });
  refuses(/MAX_NETWORK_COST_MICRO_USDC/, { MAX_NETWORK_COST_MICRO_USDC: "0" });
  refuses(/MAX_NETWORK_COST_MICRO_USDC/, { MAX_NETWORK_COST_MICRO_USDC: "50000000" });
  refuses(/COST_BUFFER_BPS/, { COST_BUFFER_BPS: "5000" });
  refuses(/QUOTE_TTL_SECONDS/, { QUOTE_TTL_SECONDS: "600" });
  refuses(/MAX_PRICE_AGE_SECONDS/, { MAX_PRICE_AGE_SECONDS: "0" });
  refuses(/UPSTREAM_TIMEOUT_MS/, { UPSTREAM_TIMEOUT_MS: "100" });
  refuses(/QUOTE_TTL_SECONDS/, { QUOTE_TTL_SECONDS: "4.5" });
  refuses(/QUOTE_TTL_SECONDS/, { QUOTE_TTL_SECONDS: "-45" });
  refuses(/QUOTE_TTL_SECONDS/, { QUOTE_TTL_SECONDS: "1e1" });
});

test("the markup has a hard cap of 30000 basis points", () => {
  assert.equal(load({}, withCustomer({ markupBps: 30_000 })).customers.byId.get("acme").markupBps, 30_000);
  assert.equal(load({}, withCustomer({ markupBps: 0 })).customers.byId.get("acme").markupBps, 0);
  refuses(/customers\[0\]\.markupBps/, {}, withCustomer({ markupBps: 30_001 }));
  refuses(/markupBps/, {}, withCustomer({ markupBps: -1 }));
  refuses(/markupBps/, {}, withCustomer({ markupBps: 12.5 }));
  refuses(/markupBps/, {}, withCustomer({ markupBps: "5000" }));
  refuses(/markupBps/, {}, withCustomer({ markupBps: undefined }));
});

test("refuses malformed customer fields", () => {
  refuses(/\.id/, {}, withCustomer({ id: "Acme Corp" }));
  refuses(/\.id/, {}, withCustomer({ id: "a" }));
  refuses(/\.name/, {}, withCustomer({ name: "" }));
  refuses(/\.apiKeyHash/, {}, withCustomer({ apiKeyHash: API_KEY }));
  refuses(/\.apiKeyHash/, {}, withCustomer({ apiKeyHash: hashApiKey(API_KEY).toUpperCase() }));
  refuses(/\.templates/, {}, withCustomer({ templates: [] }));
  refuses(/\.templates/, {}, withCustomer({ templates: ["usdc-transfer", "swap"] }));
  refuses(/\.templates/, {}, withCustomer({ templates: "usdc-transfer" }));
  refuses(/\.status/, {}, withCustomer({ status: "enabled" }));
  refuses(/\.koraUrl/, {}, withCustomer({ koraUrl: "ftp://kora" }));
  refuses(/\.koraUrl/, {}, withCustomer({ koraUrl: "https://user:pass@kora.example/" }));
  refuses(/\.koraUrl/, {}, withCustomer({ koraUrl: 5 }));
  refuses(/\.payoutAccount/, {}, withCustomer({ payoutAccount: "nope" }));
  refuses(/\.paymentAccount/, {}, withCustomer({ paymentAccount: undefined }));
  refuses(/\.feePayer/, {}, withCustomer({ feePayer: "nope" }));
  refuses(/must be an object/, {}, ["acme"]);
  refuses(/field that is not allowed/, {}, withCustomer({ hmacSecret: "pasted-in-the-wrong-place-000000000000" }));
});

test("refuses accounts that cannot be right", () => {
  // A token account address as fee payer: derived, so off the curve.
  refuses(/feePayer: is not a wallet address/, {}, withCustomer({ feePayer: base.customerEntry.paymentAccount }));
  refuses(/payoutAccount: must differ/, {}, withCustomer({ payoutAccount: base.customerEntry.paymentAccount }));
  refuses(/feePayer: must differ/, {}, withCustomer({ payoutAccount: base.customerEntry.feePayer }));
  refuses(/USDC mint itself/, {}, withCustomer({ payoutAccount: USDC.toBase58() }));
});

test("refuses budgets that are missing, zero, fractional or beyond the ceilings", () => {
  const budgets = (fields) => withCustomer({ budgets: { ...base.customerEntry.budgets, ...fields } });
  refuses(/budgets/, {}, withCustomer({ budgets: undefined }));
  refuses(/budgets/, {}, withCustomer({ budgets: { ...base.customerEntry.budgets, perHour: 5 } }));
  refuses(/requestsPerMinute/, {}, budgets({ requestsPerMinute: 0 }));
  refuses(/requestsPerMinute/, {}, budgets({ requestsPerMinute: 1e9 }));
  refuses(/transactionsPerDay/, {}, budgets({ transactionsPerDay: 0 }));
  refuses(/transactionsPerDay/, {}, budgets({ transactionsPerDay: 1.5 }));
  refuses(/networkCostMicroUsdcPerDay/, {}, budgets({ networkCostMicroUsdcPerDay: "0" }));
  refuses(/networkCostMicroUsdcPerDay/, {}, budgets({ networkCostMicroUsdcPerDay: 1.5 }));
  refuses(/networkCostMicroUsdcPerDay/, {}, budgets({ networkCostMicroUsdcPerDay: "1.5" }));
  refuses(/networkCostMicroUsdcPerDay/, {}, budgets({ networkCostMicroUsdcPerDay: "99999999999999" }));
  assert.equal(load({}, budgets({ networkCostMicroUsdcPerDay: 250_000 })).customers.byId.get("acme").budgets.networkCostMicroUsdcPerDay, 250_000n);
});

test("refuses a customer whose secrets are missing, short or reused", () => {
  refuses(/GATEWAY_HMAC_SECRET_ACME/, { GATEWAY_HMAC_SECRET_ACME: "" });
  refuses(/KORA_API_KEY_ACME/, { KORA_API_KEY_ACME: "short" });
  refuses(/KORA_HMAC_SECRET_ACME/, { KORA_HMAC_SECRET_ACME: undefined });
  refuses(/must not be the same secret/, { KORA_HMAC_SECRET_ACME: base.secrets.hmacSecret });
});

test("the environment name of a customer's secrets: upper case, dashes as underscores", () => {
  const entry = { ...base.customerEntry, id: "acme-pay-2" };
  refuses(/GATEWAY_HMAC_SECRET_ACME_PAY_2/, {}, [entry]);
  const cfg = load({ GATEWAY_HMAC_SECRET_ACME_PAY_2: "a".repeat(32), KORA_API_KEY_ACME_PAY_2: "b".repeat(32), KORA_HMAC_SECRET_ACME_PAY_2: "c".repeat(32) }, [entry]);
  assert.equal(cfg.customers.secretsFor("acme-pay-2").hmacSecret, "a".repeat(32));
});

test("customers are isolated: no shared id, key, fee payer, Kora or payment account", () => {
  assert.equal(load(secondEnv, [base.customerEntry, second()]).customers.list.length, 2);
  refuses(/share the same id/, secondEnv, [base.customerEntry, second({ id: "acme" })]);
  refuses(/share the same apiKeyHash/, secondEnv, [base.customerEntry, second({ apiKeyHash: base.customerEntry.apiKeyHash })]);
  refuses(/share the same feePayer/, secondEnv, [base.customerEntry, second({ feePayer: base.customerEntry.feePayer })]);
  refuses(/share the same koraUrl/, secondEnv, [base.customerEntry, second({ koraUrl: base.customerEntry.koraUrl })]);
  refuses(/share the same paymentAccount/, secondEnv, [base.customerEntry, second({ paymentAccount: base.customerEntry.paymentAccount })]);
});

test("reports every problem at once", () => {
  refuses(/RPC_URL.*STORE.*markupBps.*status/s, { RPC_URL: "", STORE: "" }, withCustomer({ markupBps: 99_999, status: "x" }));
});

test("no secret and no raw value ever appears in an error", () => {
  const secret = "s3cr3t-value-that-must-never-be-printed-0123456789";
  const leaks = (fn) => {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.ok(!error.message.includes(secret) && !error.message.includes(secret.slice(0, 10)), error.message);
      return;
    }
    assert.fail("accepted a bad value");
  };
  for (const name of ["PORT", "RPC_URL", "STORE", "USDC_MINT", "COMPUTE_UNIT_LIMIT", "MAX_PRIORITY_MICRO_LAMPORTS", "MAX_NETWORK_COST_MICRO_USDC", "COST_BUFFER_BPS", "QUOTE_TTL_SECONDS", "MAX_PRICE_AGE_SECONDS", "UPSTREAM_TIMEOUT_MS"]) {
    leaks(() => load({ [name]: secret }));
  }
  leaks(() => load({ STORE: "postgres", DATABASE_URL: `https://user:${secret}@db` }));
  for (const field of ["id", "name", "apiKeyHash", "templates", "markupBps", "payoutAccount", "paymentAccount", "koraUrl", "feePayer", "budgets", "status"]) {
    leaks(() => load({}, withCustomer({ [field]: field === "name" ? secret.repeat(3) : secret })));
  }
  leaks(() => load({}, withCustomer({ [secret]: 1 })));
  // A secret that is present but reused is named by variable, not by value.
  leaks(() => load({ GATEWAY_HMAC_SECRET_ACME: secret, KORA_HMAC_SECRET_ACME: secret }));
  leaks(() => load({ GATEWAY_HMAC_SECRET_ACME: secret.slice(0, 20) }));
});

test("the example customers file is refused as it stands: placeholders are not values", () => {
  const example = readFileSync(new URL("../customers.example.json", import.meta.url), "utf8");
  assert.ok(Array.isArray(JSON.parse(example).customers));
  assert.throws(() => loadConfig(base.env, () => example), ConfigError);
});
