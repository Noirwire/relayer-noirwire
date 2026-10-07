import { defineRailway, github, preserve, project, service } from "railway/iac";

// The Railway services, as code. Apply with `railway config apply` from this folder (see
// ../deploy.md). Secrets and the public keys are never written here: they are set once with
// `railway variable set`, and `preserve()` tells Railway to keep them.

// This repository manages one slice of the Railway project it shares with the API, so
// applying this file never touches a service another repository declared.
export const partial = "relayer";

// How many relayers to run. Each replica is one Kora service with its OWN fee payer key and
// one refill service for that fee payer. All of them share the same payment wallet.
// Replica 1 is `kora` and `refill`; replica 2 is `kora-2` and `refill-2`; and so on.
const REPLICAS = 1;

// Set RELAYER_GITHUB_REPO=owner/repo to have Railway build from GitHub on every push.
// Leave it unset to deploy from this machine with `railway up`.
const repo = process.env.RELAYER_GITHUB_REPO;
const source = (rootDirectory: string) =>
  repo ? github(repo, { branch: process.env.RELAYER_GITHUB_BRANCH ?? "main", rootDirectory }) : undefined;

// The fee relayer: a web service built from kora/Dockerfile.
const kora = (name: string) =>
  service(name, {
    source: source("/noirwire/kora"),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      healthcheckPath: "/liveness",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: {
      PORT: "8080",
      // Not "info": at that level Kora logs every transaction it is sent.
      RUST_LOG: "warn",
      RPC_URL: preserve(),
      KORA_PRIVATE_KEY: preserve(),
      KORA_API_KEY: preserve(),
      KORA_HMAC_SECRET: preserve(),
      JUPITER_API_KEY: preserve(),
    },
  });

// The refill job for one fee payer: runs once an hour and exits. Never restarted:
// a run that ends with a non-zero code must be looked at, not repeated. Jobs that share the
// payment wallet must not run at the same minute, so each replica's schedule is shifted
// (replica 1 at :00, replica 2 at :05, ...; Railway needs 5 minutes between runs).
const refill = (name: string, minute: number) =>
  service(name, {
    source: source("/noirwire/refill"),
    start: "node src/main.mjs",
    deploy: {
      cronSchedule: `${minute} * * * *`,
      restartPolicyType: "NEVER",
    },
    env: {
      TARGET_SOL: "0.1",
      REFILL_BELOW_SOL: "0.03",
      MAX_USDC_PER_RUN: "15",
      MAX_RUNS_PER_DAY: "6",
      USDC_FLOOR: "1",
      PAYMENT_WALLET_SOL_RESERVE: "0.01",
      MAX_SLIPPAGE_BPS: "100",
      DRY_RUN: "0",
      RPC_URL: preserve(),
      PAYMENT_WALLET_PRIVATE_KEY: preserve(),
      FEE_PAYER: preserve(),
      // Required, no default: the most USDC the job may ever pay for one SOL.
      MAX_USDC_PER_SOL: preserve(),
      JUPITER_API_KEY: preserve(),
    },
  });

export default defineRailway(() => {
  if (REPLICAS < 1 || REPLICAS > 2) throw new Error("REPLICAS must be 1 or 2: the refill schedules are 5 minutes apart");
  const resources = [];
  for (let replica = 1; replica <= REPLICAS; replica += 1) {
    const suffix = replica === 1 ? "" : `-${replica}`;
    resources.push(kora(`kora${suffix}`), refill(`refill${suffix}`, (replica - 1) * 5));
  }
  return project("noirwire-relayer", { resources });
});
