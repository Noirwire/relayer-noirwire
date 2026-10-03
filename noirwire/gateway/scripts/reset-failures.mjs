import { createPostgresStore } from "../src/store/postgres.mjs";

// The operator's reset of a paused customer: sets its count of transactions that failed on
// chain back to zero, so its requests are accepted again. Look at why they failed first.
//
//   DATABASE_URL=postgres://... node scripts/reset-failures.mjs <customer id>

const customerId = process.argv[2];
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!customerId || !/^postgres(ql)?:\/\//.test(databaseUrl ?? "")) {
  process.stderr.write("usage: DATABASE_URL=postgres://... node scripts/reset-failures.mjs <customer id>\n");
  process.exit(2);
}

const store = createPostgresStore({ databaseUrl, timeoutMs: 15_000 });
try {
  const before = await store.failures(customerId);
  await store.resetFailures(customerId);
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: "reset_failures", customer: customerId, failedOnChain: before })}\n`);
} finally {
  await store.close();
}
