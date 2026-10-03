import { createHmac, timingSafeEqual } from "node:crypto";
import { Refusal } from "./errors.mjs";

// Who is calling. Three headers on every /v1 request:
//
//   x-api-key     the customer's API key (stored here only as its SHA-256)
//   x-timestamp   unix seconds, within five minutes of this server's clock
//   x-signature   hex(HMAC-SHA256(secret, timestamp + method + path + body))
//
// Every failure answers the same "unauthorized", so the response does not say which part
// was wrong. The reason goes to the log line only.
//
// A request replayed inside the five minutes authenticates again. That is safe by
// construction rather than by a nonce store: preparing again only issues another quote, and
// signing again with the same quote returns the first result and never signs twice.

export const MAX_TIMESTAMP_AGE_SECONDS = 300;

const header = (headers, name) => (typeof headers[name] === "string" ? headers[name] : "");

export function expectedSignature(secret, timestamp, method, path, body) {
  return createHmac("sha256", secret).update(timestamp).update(method).update(path).update(body).digest();
}

/** The authenticated customer, or a Refusal. `body` is the raw request body, as bytes. */
export function authenticate(customers, nowSeconds, { method, path, headers, body }) {
  const denied = (why) => new Refusal("unauthorized", why);

  const apiKey = header(headers, "x-api-key");
  const customer = apiKey ? customers.findByApiKey(apiKey) : null;
  if (!customer) throw denied("bad_key");

  const timestamp = header(headers, "x-timestamp");
  if (!/^\d{1,12}$/.test(timestamp)) throw denied("bad_timestamp");
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_TIMESTAMP_AGE_SECONDS) throw denied("stale_timestamp");

  const provided = header(headers, "x-signature");
  if (!/^[0-9a-f]{64}$/.test(provided)) throw denied("bad_signature");
  const expected = expectedSignature(customers.secretsFor(customer.id).hmacSecret, timestamp, method, path, body);
  if (!timingSafeEqual(expected, Buffer.from(provided, "hex"))) throw denied("bad_signature");

  if (customer.status !== "active") throw Object.assign(new Refusal("customer_suspended"), { customer });
  return customer;
}
