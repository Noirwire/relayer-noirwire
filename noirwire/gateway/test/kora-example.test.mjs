import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// kora.customer.example.toml is what every customer's Kora is started with. A field Kora
// does not know stops Kora from starting, and a few values make every sign fail, so both
// are pinned here.

const example = readFileSync(new URL("../kora.customer.example.toml", import.meta.url), "utf8");

/** Sections and their keys, enough TOML for a file of `[section]` and `key = value` lines. */
function sectionsOf(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^\[([a-z0-9_.]+)\]$/);
    const entry = line.match(/^([a-z0-9_]+) = (.+)$/);
    if (header) sections.set(header[1], (current = new Map()));
    else if (entry) current.set(entry[1], entry[2]);
  }
  return sections;
}
const sections = sectionsOf(example);
const value = (section, key) => sections.get(section)?.get(key);

test("the Kora example sets what the gateway depends on", () => {
  assert.equal(value("validation.price", "type"), '"margin"');
  assert.equal(value("validation.price", "margin"), "0.0");
  assert.equal(value("validation", "max_signatures"), "2");
  assert.equal(value("validation", "allow_durable_transactions"), "false");
  assert.equal(value("kora", "force_sig_verify"), "false");
  assert.equal(value("kora.lighthouse", "enabled"), "false");
  assert.equal(value("kora.usage_limit", "enabled"), "false");
  assert.equal(value("kora.enabled_methods", "estimate_transaction_fee"), "true");
  assert.equal(value("kora.enabled_methods", "sign_transaction"), "true");
  assert.equal(value("kora.enabled_methods", "sign_and_send_transaction"), "false");
  assert.match(value("kora", "payment_address"), /^"REPLACE_/);
  // Exactly the two programs of the template, ComputeBudget among them.
  const programs = example.slice(example.indexOf("allowed_programs = ["), example.indexOf("]", example.indexOf("allowed_programs = [")));
  assert.deepEqual(programs.match(/"[1-9A-HJ-NP-Za-km-z]{32,44}"/g), ['"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"', '"ComputeBudget111111111111111111111111111111"']);
  // The fee payer may do nothing but pay the fee.
  for (const policy of ["validation.fee_payer_policy.system", "validation.fee_payer_policy.spl_token"]) {
    for (const [key, setting] of sections.get(policy)) assert.equal(setting, "false", `${policy}.${key}`);
  }
  // The most the template can cost with the default caps: two signatures and 30,000 units at 500,000.
  assert.ok(Number(value("validation", "max_allowed_lamports")) >= 10_000 + 15_000);
  assert.ok(Number(value("validation", "max_priority_fee_lamports")) >= 15_000);
  assert.ok(!example.includes(String.fromCharCode(0x2014)));
});

// The Kora source this repository carries, when the test runs inside the repository.
const koraSource = new URL("../../../crates/lib/src/", import.meta.url);
const haveSource = existsSync(new URL("config.rs", koraSource));

test("every section and field of the Kora example is a field of Kora's own configuration", { skip: haveSource ? false : "the Kora source is not next to the gateway" }, () => {
  const source = ["config.rs", "usage_limit/config.rs"].map((file) => readFileSync(new URL(file, koraSource), "utf8")).join("\n");
  const fieldsOf = (struct) => {
    const body = source.match(new RegExp(`pub struct ${struct} \\{([\\s\\S]*?)\\n\\}`));
    assert.ok(body, `struct ${struct}`);
    return [...body[1].matchAll(/^\s+pub ([a-z0-9_]+):/gm)].map((match) => match[1]);
  };
  const structs = {
    kora: "KoraConfig",
    "kora.auth": "AuthConfig",
    "kora.lighthouse": "LighthouseConfig",
    "kora.usage_limit": "UsageLimitConfig",
    "kora.enabled_methods": "EnabledMethods",
    validation: "ValidationConfig",
    "validation.fee_payer_policy.system": "SystemInstructionPolicy",
    "validation.fee_payer_policy.spl_token": "SplTokenInstructionPolicy",
    metrics: "MetricsConfig",
    "metrics.fee_payer_balance": "FeePayerBalanceMetricsConfig",
  };
  for (const [section, keys] of sections) {
    // The price model is a tagged enum (`type`, then the variant's own fields), not a struct.
    if (section === "validation.price") {
      assert.deepEqual([...keys.keys()], ["type", "margin"]);
      continue;
    }
    assert.ok(structs[section], `section [${section}] has no known struct`);
    const fields = fieldsOf(structs[section]);
    for (const key of keys.keys()) assert.ok(fields.includes(key), `[${section}] ${key} is not a field of ${structs[section]}`);
  }
  // Sections are fields too.
  assert.ok(fieldsOf("KoraConfig").includes("lighthouse") && fieldsOf("KoraConfig").includes("usage_limit") && fieldsOf("KoraConfig").includes("enabled_methods"));
  assert.ok(fieldsOf("FeePayerPolicy").includes("system") && fieldsOf("FeePayerPolicy").includes("spl_token"));
  // A struct that is given at all must be given whole where it has no defaults.
  for (const required of ["enabled", "fallback_if_unavailable"]) assert.ok(sections.get("kora.usage_limit").has(required));
  const splRequired = fieldsOf("SplTokenInstructionPolicy").filter((field) => !["allow_withdraw_excess_lamports", "allow_unwrap_lamports"].includes(field));
  assert.deepEqual([...sections.get("validation.fee_payer_policy.spl_token").keys()].sort(), splRequired.sort());
});
