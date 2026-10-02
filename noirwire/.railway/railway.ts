import { defineRailway, github, preserve, project, service } from "railway/iac";

// The two Railway services, as code. Apply with `railway config apply` from this folder
// (see ../deploy.md). Secrets and the two public keys are never written here: they are set
// once with `railway variable set`, and `preserve()` tells Railway to keep them.

// Set RELAYER_GITHUB_REPO=owner/repo to have Railway build from GitHub on every push.
// Leave it unset to deploy from this machine with `railway up`.
const repo = process.env.RELAYER_GITHUB_REPO;
const source = (rootDirectory: string) =>
  repo ? github(repo, { branch: process.env.RELAYER_GITHUB_BRANCH ?? "main", rootDirectory }) : undefined;

export default defineRailway(() => {
  // The fee relayer: a web service built from kora/Dockerfile.
  const kora = service("kora", {
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

  // The refill job: runs once every ten minutes and exits. Never restarted: a run that ends
  // with a non-zero code must be looked at, not repeated.
  const refill = service("refill", {
    source: source("/noirwire/refill"),
    start: "node src/main.mjs",
    deploy: {
      cronSchedule: "*/10 * * * *",
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

  return project("noirwire-relayer", { resources: [kora, refill] });
});
