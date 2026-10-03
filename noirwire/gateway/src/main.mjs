import { Connection } from "@solana/web3.js";
import { bounded } from "./bounded.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { createKora } from "./kora.mjs";
import { createPythPriceSource } from "./price.mjs";
import { createRateLimiter } from "./ratelimit.mjs";
import { createGatewayServer } from "./server.mjs";
import { createService } from "./service.mjs";
import { createMemoryStore } from "./store/memory.mjs";
import { createPostgresStore } from "./store/postgres.mjs";

// Entry point: check the configuration, check the store, listen. One JSON line per event on
// stdout. Anything wrong before listening is a refusal to start (exit 2).

const print = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const refuseToStart = (reason) => {
  print({ time: new Date().toISOString(), event: "start", outcome: "refused", refusal: "bad_config", reason });
  process.exit(2);
};

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (error) {
  // ConfigError messages name variables and rules, never values.
  refuseToStart(error instanceof ConfigError ? error.message : "configuration could not be read");
}

const clock = { now: Date.now };
// Every RPC call is given a wall-clock bound; web3.js has none of its own.
const conn = bounded(new Connection(cfg.rpcUrl, "confirmed"), cfg.upstreamTimeoutMs);
const store = cfg.store === "postgres"
  ? createPostgresStore({ databaseUrl: cfg.databaseUrl, timeoutMs: cfg.upstreamTimeoutMs })
  : createMemoryStore();
if (cfg.store === "postgres") {
  try {
    await store.check();
  } catch {
    refuseToStart("DATABASE_URL: the database could not be reached or the migration has not been applied");
  }
}

const service = createService(
  {
    conn,
    kora: createKora({ fetchFn: fetch, clock, timeoutMs: cfg.upstreamTimeoutMs, secretsFor: cfg.customers.secretsFor }),
    priceSource: createPythPriceSource(conn, { maxAgeSeconds: cfg.maxPriceAgeSeconds }),
    store,
    clock,
  },
  cfg,
);
const server = createGatewayServer({ service, customers: cfg.customers, rateLimiter: createRateLimiter(clock), clock, log: print });

server.listen(cfg.port, () => {
  print({ time: new Date().toISOString(), event: "start", outcome: "listening", port: cfg.port, store: cfg.store, customers: cfg.customers.list.length });
});

// Stop taking requests, let the ones in flight finish, then close the store.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    print({ time: new Date().toISOString(), event: "stop", signal });
    server.close(() => store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), cfg.upstreamTimeoutMs * 2 + 5_000).unref();
  });
}
