import { Connection } from "@solana/web3.js";
import { bounded } from "./bounded.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { EXIT } from "./errors.mjs";
import { run, RUN_DEADLINE_MS } from "./run.mjs";

// Entry point: one run, one JSON line on stdout, then exit. Exit code 0 means "nothing to
// do" or "done"; anything else means a human should look (see errors.mjs).

const print = (report) => process.stdout.write(`${JSON.stringify(report)}\n`);

let cfg;
try {
  cfg = loadConfig(process.env);
} catch (error) {
  print({
    time: new Date().toISOString(),
    outcome: "refused",
    refusal: "bad_config",
    // ConfigError messages name variables and rules, never values.
    reason: error instanceof ConfigError ? error.message : "configuration could not be read",
  });
  process.exit(EXIT.refused);
}

// The last line of defence for the deadline: every wait inside the run is bounded, so this
// should never fire. If it does, something may be in flight, so it is reported as unknown.
const watchdog = setTimeout(() => {
  print({ time: new Date().toISOString(), outcome: "unknown", reason: "the run exceeded its deadline and was stopped; check the payment wallet's recent transactions" });
  process.exit(EXIT.unknown);
}, RUN_DEADLINE_MS + 60_000);
watchdog.unref();

const { exitCode, report } = await run(cfg, {
  // Every RPC call is given a wall-clock bound; web3.js retries rate limits by itself.
  conn: bounded(new Connection(cfg.rpcUrl, "confirmed")),
  fetchFn: fetch,
  clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
});
print(report);
// Set the code and let the process end by itself, so stdout is flushed first.
process.exitCode = exitCode;
