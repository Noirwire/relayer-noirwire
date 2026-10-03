import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { authenticate } from "./auth.mjs";
import { Refusal, UnknownOutcome } from "./errors.mjs";

// The HTTP surface: three routes, JSON in and out, one JSON log line per request.
//
// A log line carries an opaque event id made here, the route, the customer id, the quote id
// and the outcome. It never carries a transaction signature, an amount, an address, a
// request body, a transaction, a header or anything an upstream said. A signature next to
// a customer and a quote would let anyone who reads logs look the transaction up on chain
// and learn who paid whom; signatures are kept in the store only.

/** A prepared transaction is at most 1644 base64 characters; nothing sent here needs more. */
export const MAX_BODY_BYTES = 8 * 1024;
/** How long a client may take to send its request. Upstream waits have their own bounds. */
const REQUEST_TIMEOUT_MS = 30_000;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Refusal("body_too_large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", () => reject(new Refusal("bad_request", "read_failed")));
  });
}

export function createGatewayServer({ service, customers, store, clock, log, newEventId = randomUUID }) {
  const routes = { "/v1/prepare": service.prepare, "/v1/sign": service.sign };

  async function handle(request, report) {
    if (request.method === "GET" && request.url === "/health") return { status: "ok" };
    const operation = routes[request.url];
    if (!operation || request.method !== "POST") throw new Refusal("not_found");

    const raw = await readBody(request);
    let customer;
    try {
      customer = authenticate(customers, Math.floor(clock.now() / 1000), { method: request.method, path: request.url, headers: request.headers, body: raw });
    } catch (error) {
      if (error.customer) report.customer = error.customer.id;
      throw error;
    }
    report.customer = customer.id;
    // Counted in the store, so the limit holds across every gateway process.
    if (!(await store.allowRequest(customer.id, customer.budgets.requestsPerMinute, clock.now()))) throw new Refusal("rate_limited");

    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Refusal("bad_request", "not_json");
    }
    return operation(customer, body, report);
  }

  const server = createServer(async (request, response) => {
    const startedAt = clock.now();
    // Known routes are logged by name; anything else is not echoed into the log.
    const route = request.url === "/health" || routes[request.url] ? request.url : "other";
    const report = { time: new Date(startedAt).toISOString(), eventId: newEventId(), route, method: request.method };
    let status = 200;
    let answer;
    try {
      answer = await handle(request, report);
      report.outcome = "ok";
    } catch (error) {
      if (error instanceof Refusal) {
        status = error.status;
        answer = { error: { code: error.code, message: error.message } };
        Object.assign(report, { outcome: "refused", code: error.code, ...(error.detail ? { detail: error.detail } : {}) });
      } else if (error instanceof UnknownOutcome) {
        status = 502;
        answer = { error: { code: "outcome_unknown", message: error.message }, ...(error.signature ? { signature: error.signature } : {}) };
        Object.assign(report, { outcome: "unknown", code: "outcome_unknown", detail: error.detail });
      } else {
        // Not a decision of this service: a bug or a store failure. Its text is not logged,
        // since it may quote input; its type is enough to find it.
        const internal = new Refusal("internal");
        status = internal.status;
        answer = { error: { code: internal.code, message: internal.message } };
        Object.assign(report, { outcome: "error", code: "internal", detail: error?.constructor?.name ?? "unknown" });
      }
    }
    const payload = JSON.stringify(answer);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
    response.end(payload);
    log({ ...report, status, ms: clock.now() - startedAt });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
