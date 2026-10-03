import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { authenticate, expectedSignature } from "../src/auth.mjs";
import { REFUSAL_CODES, Refusal } from "../src/errors.mjs";
import { createRateLimiter } from "../src/ratelimit.mjs";
import { API_KEY, authHeaders, fakeClock, listen, makeWorld, NOW } from "./helpers.mjs";

/** A world behind its HTTP server; the server is closed when the test ends. */
async function served(t, overrides) {
  const world = makeWorld(overrides);
  const http = await listen(world);
  t.after(http.close);
  return { world, http };
}
const lastLine = (http) => http.lines.at(-1);

// ── Routes ──────────────────────────────────────────────────────────────────────────────

test("GET /health answers without credentials", async (t) => {
  const { http } = await served(t);
  const response = await http.call("/health", undefined, {}, "GET");
  assert.deepEqual(response, { status: 200, body: { status: "ok" } });
  assert.equal(lastLine(http).outcome, "ok");
});

test("anything else is not a route, and its path is not echoed into the log", async (t) => {
  const { http } = await served(t);
  for (const [path, method] of [["/v1/quote", "POST"], ["/v1/prepare", "GET"], ["/v1/prepare?x=1", "POST"], ["/secret-looking-path", "GET"]]) {
    const response = await http.call(path, method === "POST" ? {} : undefined, {}, method);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not_found");
  }
  assert.equal(lastLine(http).route, "other");
  assert.ok(!JSON.stringify(http.lines).includes("secret-looking-path"));
});

test("prepare and sign over HTTP, end to end", async (t) => {
  const { world, http } = await served(t);
  const prepared = await http.call("/v1/prepare", world.prepareBody());
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.platformMicroUsdc, "1760");
  const signed = await http.call("/v1/sign", world.signedBody(prepared.body));
  assert.equal(signed.status, 200);
  assert.match(signed.body.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.deepEqual(Object.keys(signed.body), ["signature"]);
});

// ── Authentication ──────────────────────────────────────────────────────────────────────

test("a wrong or missing API key is unauthorized", async (t) => {
  const { world, http } = await served(t);
  for (const headers of [{ "x-api-key": "wrong-key" }, { "x-api-key": "" }, { "x-api-key": world.customer.apiKeyHash }]) {
    const response = await http.call("/v1/prepare", world.prepareBody(), headers);
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: { code: "unauthorized", message: "Authentication failed." } });
    assert.equal(lastLine(http).detail, "bad_key");
    assert.equal(lastLine(http).customer, undefined);
  }
  assert.equal(world.fetchFn.requests.length, 0);
});

test("a wrong signature is unauthorized, whichever part of the request it does not cover", async (t) => {
  const { world, http } = await served(t);
  const body = JSON.stringify(world.prepareBody());
  const signed = (overrides) => authHeaders({ secret: world.secrets.hmacSecret, timestamp: NOW, path: "/v1/prepare", body, ...overrides });
  const rejected = async (headers, detail = "bad_signature") => {
    const response = await http.call("/v1/prepare", body, headers);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthorized");
    assert.equal(lastLine(http).detail, detail);
  };
  await rejected(signed({ secret: "another-secret-00000000000000000000" }));
  // Signed for another route, another method, another body, another timestamp.
  await rejected(signed({ path: "/v1/sign" }));
  await rejected(signed({ method: "GET" }));
  await rejected(signed({ body: `${body} ` }));
  await rejected({ ...signed({}), "x-signature": signed({ timestamp: NOW + 1 })["x-signature"] });
  // Missing, not hex, upper case, cut short.
  await rejected({ "x-signature": "" });
  await rejected({ "x-signature": "zz".repeat(32) });
  await rejected({ "x-signature": signed({})["x-signature"].toUpperCase() });
  await rejected({ "x-signature": signed({})["x-signature"].slice(0, 62) });
  // Kora's construction (timestamp + body, no method or path) is not this gateway's.
  await rejected({ "x-signature": createHmac("sha256", world.secrets.hmacSecret).update(`${NOW}${body}`).digest("hex") });
  assert.equal(world.fetchFn.requests.length, 0);
  // And the right one passes.
  assert.equal((await http.call("/v1/prepare", body, signed({}))).status, 200);
});

test("the timestamp must be within five minutes, either way", async (t) => {
  const { world, http } = await served(t);
  const body = JSON.stringify(world.prepareBody());
  const at = (timestamp) => http.call("/v1/prepare", body, authHeaders({ secret: world.secrets.hmacSecret, timestamp, path: "/v1/prepare", body }));
  assert.equal((await at(NOW - 300)).status, 200);
  assert.equal((await at(NOW + 300)).status, 200);
  assert.equal((await at(NOW - 301)).status, 401);
  assert.equal(lastLine(http).detail, "stale_timestamp");
  assert.equal((await at(NOW + 301)).status, 401);
  for (const timestamp of ["", "now", "1.8e9", "-1", `${NOW}000`.repeat(2)]) {
    assert.equal((await at(timestamp)).status, 401);
    assert.equal(lastLine(http).detail, "bad_timestamp");
  }
});

test("a replayed request is accepted inside the window and refused after it", async (t) => {
  const { world, http } = await served(t);
  const prepared = (await http.call("/v1/prepare", world.prepareBody())).body;
  const body = JSON.stringify(world.signedBody(prepared));
  const headers = authHeaders({ secret: world.secrets.hmacSecret, timestamp: NOW, path: "/v1/sign", body });

  const first = await http.call("/v1/sign", body, headers);
  assert.equal(first.status, 200);
  // The identical bytes and headers again, four minutes later: authenticated, and answered
  // from the quote. Nothing is signed or sent a second time.
  world.clock.advance(240_000);
  const replay = await http.call("/v1/sign", body, headers);
  assert.deepEqual(replay, first);
  assert.equal(world.fetchFn.count("signTransaction"), 1);
  assert.equal(world.conn.count("sendRawTransaction"), 1);
  // Past five minutes the same request no longer authenticates at all.
  world.clock.advance(61_000);
  assert.equal((await http.call("/v1/sign", body, headers)).status, 401);
});

test("a replayed prepare only issues another quote", async (t) => {
  const { world, http } = await served(t);
  const body = JSON.stringify(world.prepareBody());
  const headers = authHeaders({ secret: world.secrets.hmacSecret, timestamp: NOW, path: "/v1/prepare", body });
  const first = await http.call("/v1/prepare", body, headers);
  const second = await http.call("/v1/prepare", body, headers);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.quoteId, first.body.quoteId);
  assert.equal(world.fetchFn.count("signTransaction"), 0);
});

test("a suspended customer is refused after authenticating, not before", async (t) => {
  const { world, http } = await served(t, { customer: { status: "suspended" } });
  const response = await http.call("/v1/prepare", world.prepareBody());
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "customer_suspended");
  assert.equal(lastLine(http).customer, "acme");
  // With a wrong signature a suspended customer looks like anyone else.
  assert.equal((await http.call("/v1/prepare", world.prepareBody(), { "x-signature": "00".repeat(32) })).body.error.code, "unauthorized");
});

test("authenticate compares in constant time over equal lengths and signs the raw bytes", () => {
  const world = makeWorld();
  const body = Buffer.from('{"caf\u00e9":1}', "utf8");
  const signature = expectedSignature(world.secrets.hmacSecret, String(NOW), "POST", "/v1/sign", body).toString("hex");
  assert.equal(signature, createHmac("sha256", world.secrets.hmacSecret).update(`${NOW}POST/v1/sign{"caf\u00e9":1}`).digest("hex"));
  const request = { method: "POST", path: "/v1/sign", body, headers: { "x-api-key": API_KEY, "x-timestamp": String(NOW), "x-signature": signature } };
  assert.equal(authenticate(world.cfg.customers, NOW, request), world.customer);
  // Header arrays (a header sent twice) are not strings and never authenticate.
  assert.throws(() => authenticate(world.cfg.customers, NOW, { ...request, headers: { ...request.headers, "x-api-key": [API_KEY, API_KEY] } }), Refusal);
});

// ── Bodies, limits, logs ────────────────────────────────────────────────────────────────

test("a body that is not JSON, or too large, is refused", async (t) => {
  const { world, http } = await served(t);
  const notJson = await http.call("/v1/prepare", "{ nope");
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error.code, "bad_request");
  const huge = await http.call("/v1/prepare", JSON.stringify({ transaction: "A".repeat(9_000) }));
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error.code, "body_too_large");
  assert.equal(world.fetchFn.requests.length, 0);
});

test("the per-customer rate limit is per minute", async (t) => {
  const { world, http } = await served(t, { customer: { budgets: { requestsPerMinute: 3, transactionsPerDay: 100, networkCostMicroUsdcPerDay: "1000000" } } });
  for (let i = 0; i < 3; i += 1) assert.equal((await http.call("/v1/prepare", world.prepareBody())).status, 200);
  const limited = await http.call("/v1/prepare", world.prepareBody());
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "rate_limited");
  // Unauthenticated requests do not count against the customer.
  assert.equal((await http.call("/v1/prepare", world.prepareBody(), { "x-signature": "00".repeat(32) })).status, 401);
  world.clock.advance(60_000);
  assert.equal((await http.call("/v1/prepare", world.prepareBody())).status, 200);
});

test("the rate limiter counts each customer separately", () => {
  const clock = fakeClock();
  const limiter = createRateLimiter(clock);
  assert.ok(limiter.allow("a", 2) && limiter.allow("a", 2));
  assert.equal(limiter.allow("a", 2), false);
  assert.ok(limiter.allow("b", 2));
  clock.advance(60_000);
  assert.ok(limiter.allow("a", 2));
});

test("one log line per request: customer, route, outcome, quote and amounts, and nothing secret", async (t) => {
  const { world, http } = await served(t);
  const prepared = (await http.call("/v1/prepare", world.prepareBody())).body;
  const signedBody = world.signedBody(prepared);
  const signed = (await http.call("/v1/sign", signedBody)).body;
  await http.call("/v1/sign", { ...signedBody, quoteId: "missing" });
  assert.equal(http.lines.length, 3);

  const amounts = { quoteId: prepared.quoteId, networkCostMicroUsdc: "1600", platformMicroUsdc: "1760", customerMicroUsdc: "640" };
  const [first, second, third] = http.lines;
  assert.deepEqual({ ...first, ms: 0 }, { time: new Date(NOW * 1000).toISOString(), route: "/v1/prepare", method: "POST", customer: "acme", ...amounts, outcome: "ok", status: 200, ms: 0 });
  assert.deepEqual({ ...second, ms: 0 }, { time: first.time, route: "/v1/sign", method: "POST", customer: "acme", ...amounts, signature: signed.signature, outcome: "ok", status: 200, ms: 0 });
  assert.deepEqual({ ...third, ms: 0 }, { time: first.time, route: "/v1/sign", method: "POST", customer: "acme", outcome: "refused", code: "quote_not_found", status: 404, ms: 0 });

  const text = http.lines.map((line) => JSON.stringify(line)).join("\n");
  for (const secret of [API_KEY, ...Object.values(world.secrets), prepared.transaction, signedBody.transaction, world.user.publicKey.toBase58(), world.userUsdc.toBase58(), world.recipientUsdc.toBase58()]) {
    assert.ok(!text.includes(secret), "a log line carries something it must not");
  }
});

test("refusals over HTTP carry the stable code, a plain message and the right status", async (t) => {
  const { world, http } = await served(t);
  const prepared = (await http.call("/v1/prepare", world.prepareBody())).body;
  world.koraState.signError = true;
  const refused = await http.call("/v1/sign", world.signedBody(prepared));
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.body, { error: { code: "kora_refused", message: "The relayer refused to sign. Nothing was sent." } });
  // Kora's own words (they name amounts and addresses) are in neither the answer nor the log.
  assert.ok(!JSON.stringify([refused.body, http.lines]).includes("Insufficient"));
});

test("an unknown outcome over HTTP says so and carries the signature when there is one", async (t) => {
  const { world, http } = await served(t);
  const prepared = (await http.call("/v1/prepare", world.prepareBody())).body;
  world.conn.options.onSend = () => {
    throw new Error("ECONNRESET with details");
  };
  const response = await http.call("/v1/sign", world.signedBody(prepared));
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, "outcome_unknown");
  assert.match(response.body.signature, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.equal(lastLine(http).outcome, "unknown");
  assert.equal(lastLine(http).signature, response.body.signature);
  assert.ok(!JSON.stringify(http.lines).includes("ECONNRESET"));
});

test("an unexpected error is a plain 500 that leaks nothing", async (t) => {
  const { world, http } = await served(t);
  world.store.putQuote = async () => {
    throw new Error("connection to postgres://user:hunter2@db failed");
  };
  const response = await http.call("/v1/prepare", world.prepareBody());
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: { code: "internal", message: "Internal error. Nothing was signed." } });
  assert.equal(lastLine(http).outcome, "error");
  assert.ok(!JSON.stringify(http.lines).includes("hunter2"));
});

test("every refusal code has a status and a message without a dash that is not a hyphen", () => {
  for (const code of REFUSAL_CODES) {
    const refusal = new Refusal(code);
    assert.ok(refusal.status >= 400 && refusal.status < 600, code);
    assert.ok(refusal.message.length > 0 && ![0x2013, 0x2014].some((dash) => refusal.message.includes(String.fromCharCode(dash))), code);
  }
  assert.throws(() => new Refusal("no_such_code"));
});
