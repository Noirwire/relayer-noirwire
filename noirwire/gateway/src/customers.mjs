import { createHash, timingSafeEqual } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { MAX_MARKUP_BPS } from "./split.mjs";
import { TEMPLATE } from "./template.mjs";

// Customers come from one JSON file of public fields. Their secrets come from the
// environment, by customer id, and never touch the file:
//
//   GATEWAY_HMAC_SECRET_<ID>  what the customer signs its requests to this gateway with
//   KORA_API_KEY_<ID>         this gateway's API key on the customer's Kora
//   KORA_HMAC_SECRET_<ID>     this gateway's HMAC secret on the customer's Kora
//
// <ID> is the customer id in upper case with "-" written as "_".

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MIN_SECRET_LENGTH = 32;
const STATUSES = ["active", "suspended"];
const KNOWN_TEMPLATES = [TEMPLATE];
const FIELDS = ["id", "name", "apiKeyHash", "templates", "markupBps", "payoutAccount", "paymentAccount", "koraUrl", "feePayer", "budgets", "status"];
const BUDGET_FIELDS = ["requestsPerMinute", "transactionsPerDay", "networkCostMicroUsdcPerDay"];
const HARD_MAX_REQUESTS_PER_MINUTE = 6_000;
const HARD_MAX_TRANSACTIONS_PER_DAY = 1_000_000;
const HARD_MAX_COST_PER_DAY = 10_000_000_000n; // 10,000 USDC of network cost

export const envSuffix = (id) => id.toUpperCase().replaceAll("-", "_");
export const hashApiKey = (key) => createHash("sha256").update(key).digest("hex");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function publicKey(value) {
  if (typeof value !== "string") return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

function microUsdc(value) {
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d{1,18}$/.test(value)) return BigInt(value);
  return null;
}

function readCustomer(raw, at, env, problems) {
  const bad = (field, rule) => problems.push(`${at}.${field}: ${rule}`);
  if (!isPlainObject(raw)) {
    problems.push(`${at}: must be an object`);
    return null;
  }
  for (const field of Object.keys(raw)) if (!FIELDS.includes(field)) problems.push(`${at}: has a field that is not allowed`);
  const before = problems.length;

  const idValid = typeof raw.id === "string" && ID_PATTERN.test(raw.id);
  if (!idValid) bad("id", "must be 2 to 32 characters of a-z, 0-9 and -");
  if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.length > 100) bad("name", "must be 1 to 100 characters");
  if (typeof raw.apiKeyHash !== "string" || !SHA256_HEX.test(raw.apiKeyHash)) bad("apiKeyHash", "must be the lowercase hex SHA-256 of the API key");
  if (!Array.isArray(raw.templates) || raw.templates.length === 0 || raw.templates.some((name) => !KNOWN_TEMPLATES.includes(name)) || new Set(raw.templates).size !== raw.templates.length) {
    bad("templates", `must be a non-empty list drawn from: ${KNOWN_TEMPLATES.join(", ")}`);
  }
  if (!Number.isInteger(raw.markupBps) || raw.markupBps < 0 || raw.markupBps > MAX_MARKUP_BPS) {
    bad("markupBps", `must be a whole number between 0 and ${MAX_MARKUP_BPS}`);
  }
  if (!STATUSES.includes(raw.status)) bad("status", `must be one of: ${STATUSES.join(", ")}`);

  const payoutAccount = publicKey(raw.payoutAccount);
  const paymentAccount = publicKey(raw.paymentAccount);
  const feePayer = publicKey(raw.feePayer);
  if (!payoutAccount) bad("payoutAccount", "must be a token account address");
  if (!paymentAccount) bad("paymentAccount", "must be a token account address");
  if (!feePayer) bad("feePayer", "must be a public key");
  // A fee payer signs, so it is a point on the curve. A token account address is not.
  else if (!PublicKey.isOnCurve(feePayer.toBytes())) bad("feePayer", "is not a wallet address (off curve)");
  if (payoutAccount && paymentAccount && payoutAccount.equals(paymentAccount)) bad("payoutAccount", "must differ from paymentAccount");
  if (feePayer && [payoutAccount, paymentAccount].some((account) => account?.equals(feePayer))) bad("feePayer", "must differ from the payment and payout accounts");

  let koraUrl = null;
  try {
    const url = new URL(raw.koraUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("not allowed");
    koraUrl = url.toString();
  } catch {
    bad("koraUrl", "must be an http(s) URL without credentials");
  }

  let budgets = null;
  if (!isPlainObject(raw.budgets) || Object.keys(raw.budgets).some((field) => !BUDGET_FIELDS.includes(field))) {
    bad("budgets", `must be an object with exactly: ${BUDGET_FIELDS.join(", ")}`);
  } else {
    const { requestsPerMinute, transactionsPerDay } = raw.budgets;
    const networkCostMicroUsdcPerDay = microUsdc(raw.budgets.networkCostMicroUsdcPerDay);
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > HARD_MAX_REQUESTS_PER_MINUTE) {
      bad("budgets.requestsPerMinute", `must be a whole number between 1 and ${HARD_MAX_REQUESTS_PER_MINUTE}`);
    }
    if (!Number.isInteger(transactionsPerDay) || transactionsPerDay < 1 || transactionsPerDay > HARD_MAX_TRANSACTIONS_PER_DAY) {
      bad("budgets.transactionsPerDay", `must be a whole number between 1 and ${HARD_MAX_TRANSACTIONS_PER_DAY}`);
    }
    if (networkCostMicroUsdcPerDay === null || networkCostMicroUsdcPerDay < 1n || networkCostMicroUsdcPerDay > HARD_MAX_COST_PER_DAY) {
      bad("budgets.networkCostMicroUsdcPerDay", `must be a whole number of micro-USDC between 1 and ${HARD_MAX_COST_PER_DAY}`);
    }
    budgets = { requestsPerMinute, transactionsPerDay, networkCostMicroUsdcPerDay };
  }

  let secrets = null;
  if (idValid) {
    secrets = {};
    for (const [field, prefix] of [["hmacSecret", "GATEWAY_HMAC_SECRET_"], ["koraApiKey", "KORA_API_KEY_"], ["koraHmacSecret", "KORA_HMAC_SECRET_"]]) {
      const name = prefix + envSuffix(raw.id);
      const value = env[name]?.trim();
      // The name is reported, the value never is, not even its length.
      if (!value || value.length < MIN_SECRET_LENGTH) problems.push(`${name}: missing or shorter than ${MIN_SECRET_LENGTH} characters`);
      secrets[field] = value;
    }
    if (secrets.hmacSecret && secrets.hmacSecret === secrets.koraHmacSecret) {
      problems.push(`GATEWAY_HMAC_SECRET_${envSuffix(raw.id)}: must not be the same secret as the Kora one`);
    }
  }

  if (problems.length > before) return null;
  return {
    customer: Object.freeze({
      id: raw.id,
      name: raw.name,
      apiKeyHash: raw.apiKeyHash,
      templates: Object.freeze([...raw.templates]),
      markupBps: raw.markupBps,
      payoutAccount,
      paymentAccount,
      koraUrl,
      feePayer,
      budgets: Object.freeze(budgets),
      status: raw.status,
    }),
    secrets: Object.freeze(secrets),
  };
}

/** Parses and checks the whole file. Every problem found is added to `problems`. */
export function loadCustomers(text, env, problems) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    problems.push("CUSTOMERS_FILE: is not valid JSON");
    return null;
  }
  const entries = isPlainObject(parsed) ? parsed.customers : null;
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push('CUSTOMERS_FILE: must be an object with a non-empty "customers" list');
    return null;
  }

  const before = problems.length;
  const loaded = entries.map((raw, index) => readCustomer(raw, `customers[${index}]`, env, problems)).filter(Boolean);
  // Isolation: no two customers may share an identity, a relayer or a payment account.
  for (const [field, label] of [["id", "id"], ["apiKeyHash", "apiKeyHash"], ["feePayer", "feePayer"], ["koraUrl", "koraUrl"], ["paymentAccount", "paymentAccount"]]) {
    const seen = new Set();
    for (const { customer } of loaded) {
      const value = String(customer[field]);
      if (seen.has(value)) problems.push(`customers: two customers share the same ${label}`);
      seen.add(value);
    }
  }
  if (problems.length > before) return null;

  const byId = new Map(loaded.map(({ customer }) => [customer.id, customer]));
  const secrets = new Map(loaded.map(({ customer, secrets: own }) => [customer.id, own]));
  const hashes = loaded.map(({ customer }) => ({ customer, hash: Buffer.from(customer.apiKeyHash, "hex") }));
  return {
    list: [...byId.values()],
    byId,
    secretsFor: (id) => secrets.get(id),
    /** The customer whose stored hash matches this key. Every hash is compared, in constant time. */
    findByApiKey(key) {
      const provided = createHash("sha256").update(key).digest();
      let match = null;
      for (const entry of hashes) if (timingSafeEqual(provided, entry.hash)) match = entry.customer;
      return match;
    },
  };
}
