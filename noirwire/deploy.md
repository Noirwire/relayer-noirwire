# Deploying both services on Railway

Everything is run from this folder (the one that contains `kora/`, `refill/` and `.railway/`).

**Status of these commands.** The Docker and `openssl` commands were run against a local
mainnet fork. **Every `railway` command below is NOT VERIFIED**: none was run against Railway.
They are written from Railway's documentation as fetched on 2026-10-02
(docs.railway.com: `cli/*`, `cron-jobs`, `infrastructure-as-code`, `config-as-code`,
`deployments/monorepo`, `deployments/healthchecks`, `deployments/restart-policy`,
`builds/dockerfiles`, `variables`). If a flag is refused, the dashboard setting that does the
same thing is named next to it.

**Why there is no `railway.json`.** Railway's per-service config files (`railway.json`,
`railway.toml`) are deprecated: its docs say new services cannot opt into them and existing
ones stop being read on 2026-12-01. The replacement is one file for the whole project,
`.railway/railway.ts`, applied with `railway config apply`. That file is here and holds every
setting that is not a secret: build, healthcheck, restart policy, cron schedule, start command
and the tunables.

## 0. What you need

- Railway CLI, a version that has `railway config` (see Railway's "Installing the CLI").
- Node 22 or newer, Docker, the Solana CLI, `openssl`.
- A mainnet RPC URL and a Jupiter API key.

## 1. Keys

```bash
mkdir -p ~/kora-keys && chmod 700 ~/kora-keys
solana-keygen new --no-bip39-passphrase --outfile ~/kora-keys/fee-payer.json
solana-keygen new --no-bip39-passphrase --outfile ~/kora-keys/payment.json
solana-keygen pubkey ~/kora-keys/fee-payer.json   # FEE_PAYER
solana-keygen pubkey ~/kora-keys/payment.json     # PAYMENT_WALLET
```

Keep these files out of the repository. The `.gitignore` here excludes the usual names, but
the safe place is outside the working tree, as above.

## 2. The payment address in `kora.toml`

In `kora/kora.toml`, replace `REPLACE_WITH_PAYMENT_WALLET_PUBKEY` with the PAYMENT_WALLET
public key. It is a public address; committing it is fine.

The file is for Kora `v2.2.0-beta.8`, the default (`README.md`, "Stable or pre-release", says
why). Account opening is on from the start, which is why "Before real funds" below is not
optional.

## 3. Fund the wallets and open the USDC account

```bash
# NOT VERIFIED (nothing was sent to mainnet):
solana transfer --url <YOUR_MAINNET_RPC> --from <funded-keypair.json> <FEE_PAYER> 0.11 --allow-unfunded-recipient
solana transfer --url <YOUR_MAINNET_RPC> --from <funded-keypair.json> <PAYMENT_WALLET> 0.01 --allow-unfunded-recipient
```

0.11 SOL, not 0.1: opening the payment wallet's USDC account below costs the fee payer
2,044,280 lamports. The 0.01 SOL in the payment wallet is the refill job's reserve; with it
the job never depends on Jupiter sponsoring the fee of its first swap.

Open the payment wallet's USDC account (Kora refuses payments without it) and check the
configuration against the chain. Verified on the fork with this image:

```bash
cd kora
KORA=ghcr.io/solana-foundation/kora:v2.2.0-beta.8@sha256:1b929cd9b32e6a3dddb646669fbe0d30651e07377b2bface044cd84289df59bf
export KORA_PRIVATE_KEY="$(cat ~/kora-keys/fee-payer.json)"

docker run --rm -v "$PWD":/config:ro -e RPC_URL=<YOUR_MAINNET_RPC> -e JUPITER_API_KEY=<key> -e KORA_PRIVATE_KEY \
  "$KORA" kora --config /config/kora.toml rpc initialize-atas --signers-config /config/signers.toml

docker run --rm -v "$PWD":/config:ro -e RPC_URL=<YOUR_MAINNET_RPC> -e JUPITER_API_KEY=<key> -e KORA_PRIVATE_KEY \
  "$KORA" kora --config /config/kora.toml config validate-with-rpc --signers-config /config/signers.toml

unset KORA_PRIVATE_KEY
cd ..
```

The second command must end with "Configuration validation successful".

## 4. Create the project and the two services

```bash
railway login
railway init --name noirwire-relayer
railway add --service kora
railway add --service refill
```

## 5. Set the variables

Secrets are piped in with `--stdin` so they stay out of the shell history. `--skip-deploys`
stops Railway from deploying before everything is in place.

Kora service (all of these are secrets):

```bash
openssl rand -hex 32   # run twice; keep both values, the app's server needs the same two

printf '%s' '<YOUR_MAINNET_RPC>'         | railway variable set RPC_URL          --stdin --service kora --skip-deploys
cat ~/kora-keys/fee-payer.json           | railway variable set KORA_PRIVATE_KEY --stdin --service kora --skip-deploys
printf '%s' '<first openssl value>'      | railway variable set KORA_API_KEY     --stdin --service kora --skip-deploys
printf '%s' '<second openssl value>'     | railway variable set KORA_HMAC_SECRET --stdin --service kora --skip-deploys
printf '%s' '<your Jupiter API key>'     | railway variable set JUPITER_API_KEY  --stdin --service kora --skip-deploys
```

Refill service (`FEE_PAYER` is a public key, the other three are secrets):

```bash
printf '%s' '<YOUR_MAINNET_RPC>'         | railway variable set RPC_URL                    --stdin --service refill --skip-deploys
cat ~/kora-keys/payment.json             | railway variable set PAYMENT_WALLET_PRIVATE_KEY --stdin --service refill --skip-deploys
printf '%s' '<your Jupiter API key>'     | railway variable set JUPITER_API_KEY            --stdin --service refill --skip-deploys
railway variable set FEE_PAYER=<FEE_PAYER> --service refill --skip-deploys
railway variable set MAX_USDC_PER_SOL=<about twice the current SOL price in USD> --service refill --skip-deploys
railway variable set FEE_PAYER_UNSEEN_OK=<FEE_PAYER> --service refill --skip-deploys
```

- `MAX_USDC_PER_SOL` is required and has no default: the job refuses to start without it. It
  is the most USDC the job will ever pay for one SOL, whatever any price source says. Look
  the SOL price up, double it, and put a reminder in your calendar to revisit it; if SOL
  rises above it the job refuses (`price_above_bound`) until you raise it.
- `FEE_PAYER_UNSEEN_OK` is for the first refill only. The job normally sends SOL only to an
  address the chain shows relaying payments into this payment wallet; a brand new fee payer
  has no such history, so you vouch for it once by repeating its address. **Remove it after
  the first relayed transaction** (step 10). It must equal `FEE_PAYER` exactly or the job
  refuses to start.

`PORT`, `RUST_LOG` and the refill tunables (`TARGET_SOL` and the rest) are not set here: the
next step sets them from `.railway/railway.ts`. Their names are exactly the ones the job
reads; the full list is in `README.md`.

Dashboard only: seal each secret (service, Variables, the three-dot menu on the variable,
"Seal"). A sealed value can no longer be read back through the UI or the CLI. The CLI has no
command for sealing.

## 6. Apply the settings

```bash
npm install                 # installs the SDK that .railway/railway.ts imports
railway config plan         # shows what would change; changes nothing
railway config apply        # asks for confirmation
```

The plan should show two existing services being updated, with these settings, and no
variable being deleted:

| Service | Setting | Value | Dashboard location, if you set it by hand |
| --- | --- | --- | --- |
| `kora` | builder | Dockerfile, `Dockerfile` | Settings, Build |
| `kora` | healthcheck path | `/liveness` (timeout 60 s) | Settings, Deploy, Healthcheck Path |
| `kora` | restart policy | on failure, 10 retries | Settings, Deploy, Restart Policy |
| `kora` | variables | `PORT=8080`, `RUST_LOG=warn` | Variables |
| `refill` | start command | `node src/main.mjs` | Settings, Deploy, Custom Start Command |
| `refill` | cron schedule | `*/10 * * * *` (UTC) | Settings, Cron Schedule |
| `refill` | restart policy | never | Settings, Deploy, Restart Policy |
| `refill` | variables | the eight tunables (`MAX_USDC_PER_SOL` is yours, from step 5) | Variables |

The restart policy "never" on `refill` matters: Railway's default restarts a service that
exits non-zero, up to 10 times, which would turn every refusal into ten runs.

If the plan wants to delete a variable you set in step 5, stop: do not apply, and set the
settings in the table by hand in the dashboard instead.

## 7. Deploy

Each service is built from its own folder. Two ways; pick one.

**From this machine:**

```bash
railway up kora   --path-as-root --service kora
railway up refill --path-as-root --service refill
```

**From GitHub, on every push:** set the repository once and apply again. The file then gives
each service its root directory.

```bash
RELAYER_GITHUB_REPO=<owner>/<repo> railway config apply
```

| Service | Root directory |
| --- | --- |
| `kora` | `/noirwire/kora` |
| `refill` | `/noirwire/refill` |

(Dashboard: service, Settings, Source, Root Directory. CLI alternative from Railway's docs:
`railway environment edit --service-config kora source.rootDirectory /noirwire/kora`.)
Keep `RELAYER_GITHUB_REPO` set on every later `railway config apply`, or the plan will want
to remove the source.

### Gate deploys on CI passing

With deploys wired to GitHub, turn on Railway's **Wait for CI** on each service (Settings,
Source, "Wait for CI") so a deploy only starts once `.github/workflows/noirwire.yml` has
passed on that commit. Railway waits for every GitHub Actions check suite on the commit to
conclude, skips the deploy outright on a failed one, and deploys anyway after two hours if
nothing reports. It requires the workflow to trigger on `push` with `branches: [main]`, which
`noirwire.yml` already does.

One consequence of the path filter: a push to `main` that touches neither `noirwire/**` nor
the workflow file produces no run of `noirwire.yml` at all, which GitHub reports as a skipped
check. Wait for CI does not block on a skipped check, so such a push still deploys. That is
the intended behaviour, not a reason to drop the filter.

## 8. Give Kora a public domain

Kora only. The refill job needs none and must not have one.

```bash
railway domain --service kora --port 8080
```

(Dashboard: service, Settings, Networking, Generate Domain, port 8080.)

The app's server runs outside Railway, so this domain is public and the API key plus the
HMAC secret are the only gate. Read "The operating rule" in `README.md` before sharing them.

## 9. Check it

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/liveness     # 200

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-domain> \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getConfig"}'   # 401
```

Or all of it at once, including that the two secrets work, that one alone does not, and that
Kora signs with the fee payer you think it does:

```bash
KORA_URL=https://<your-domain> ./scripts/check-deploy.sh

export KORA_API_KEY KORA_HMAC_SECRET      # read them in without echoing, e.g. `read -rs KORA_API_KEY`
KORA_URL=https://<your-domain> FEE_PAYER=<FEE_PAYER> PAYMENT_WALLET=<PAYMENT_WALLET> ./scripts/check-deploy.sh
```

It prints PASS or FAIL per check, never prints a secret and never puts one on a command line
(it needs `node` for that). With the secrets it asks Kora's `getPayerSigner` which key it
signs with and where it collects payments, and **fails if those are not the `FEE_PAYER` and
`PAYMENT_WALLET` you passed**. `FEE_PAYER` is the only address the refill job ever sends SOL
to, so do not set that variable on the refill service until this check passes with the same
value. It also prints the settings the running server reports: expect `"margin":0.1`,
`"max_allowed_lamports":2200000`, `"allow_create_account":true`, `"max_signatures":2`.

## 10. First refill

Start in dry-run and read one run's output before letting it move money:

```bash
railway variable set DRY_RUN=1 --service refill
railway logs --service refill        # one JSON line per run
railway variable set DRY_RUN=0 --service refill
```

`.railway/railway.ts` says `DRY_RUN: "0"`. While you test with `1`, do not run
`railway config apply`, or change the value in the file first.

A healthy quiet run looks like `{"outcome":"nothing_to_do", ... "reconcile":{...,"drainSuspected":false}}`
with exit code 0. Then give the app's server its five variables (`README.md`, "The app's server").

**After the first relayed transaction** (the app has sent one transaction through Kora and
it paid USDC into the payment wallet), remove the acknowledgement:

```bash
railway variable delete FEE_PAYER_UNSEEN_OK --service refill
```

From then on the job proves the fee payer from the chain on every run that moves SOL. If a
later run reports `fee_payer_unproven`, do not put the variable back by reflex: first find
out why the fee payer has no relayed payment among the wallet's newest 100.

Do not run the job by hand within three minutes of a run that exited with code 3. And never
run a second copy (by hand, or as a second service) while the scheduled service is enabled:
Railway runs one cron execution at a time and skips an overlapping one, but it cannot know
about a copy started elsewhere. Two copies can each sign a refill from the same state; the
result is the fee payer one refill above its target, inside the daily ceiling, between your
own two wallets. Disable the cron service first, or use `DRY_RUN=1`.

## 11. Before real funds

Account opening is on, and Kora is only the second line of defence. Do not point real users
or real funds at the relayer until all of these hold:

1. **The caller's minimum-payment check passes against the deployed route.** It is the test
   "relayer route: minimum payment for a relayer-funded account" in the app repository's
   `tests/relayer/minimum-payment.test.ts`. Run it there:

   ```bash
   RELAYER_CHECK_APP_URL=<app url> RELAYER_CHECK_RPC_URL=<rpc url> npm run test:relayer
   ```

   It belongs to the app, not to this repository, and was not run as part of this work. If it
   fails, stop: the relayer must not be used until it passes.
2. The Kora URL, API key and HMAC secret are known to that server route and to nothing else.
3. Steps 9 and 10 passed: Kora signs with the fee payer you set, a refill run is clean.

Then watch the refill job's `reconcile` output for the first account-opening sends:
`underpaid` must stay 0. An account creation that was not paid for is 2,039,280 lamports
uncovered and halts refills (exit 4) on the next run.

## 12. Adding a second relayer

The app's server accepts several relayer endpoints, each with its own fee payer
(`README.md`, "More than one relayer", explains the limits). A second replica is one more Kora
service and one more refill service. Same payment wallet, new fee payer.

```bash
# A new fee payer key, funded with 0.1 SOL. The payment wallet and its USDC account already exist.
solana-keygen new --no-bip39-passphrase --outfile ~/kora-keys/fee-payer-2.json
solana-keygen pubkey ~/kora-keys/fee-payer-2.json        # FEE_PAYER_2
solana transfer --url <YOUR_MAINNET_RPC> --from <funded-keypair.json> <FEE_PAYER_2> 0.1 --allow-unfunded-recipient

railway add --service kora-2
railway add --service refill-2

# kora-2: the same values as kora, except its own key.
printf '%s' '<YOUR_MAINNET_RPC>'           | railway variable set RPC_URL          --stdin --service kora-2 --skip-deploys
cat ~/kora-keys/fee-payer-2.json           | railway variable set KORA_PRIVATE_KEY --stdin --service kora-2 --skip-deploys
printf '%s' '<same KORA_API_KEY>'          | railway variable set KORA_API_KEY     --stdin --service kora-2 --skip-deploys
printf '%s' '<same KORA_HMAC_SECRET>'      | railway variable set KORA_HMAC_SECRET --stdin --service kora-2 --skip-deploys
printf '%s' '<your Jupiter API key>'       | railway variable set JUPITER_API_KEY  --stdin --service kora-2 --skip-deploys

# refill-2: the SAME payment wallet key, the NEW fee payer.
printf '%s' '<YOUR_MAINNET_RPC>'           | railway variable set RPC_URL                    --stdin --service refill-2 --skip-deploys
cat ~/kora-keys/payment.json               | railway variable set PAYMENT_WALLET_PRIVATE_KEY --stdin --service refill-2 --skip-deploys
printf '%s' '<your Jupiter API key>'       | railway variable set JUPITER_API_KEY            --stdin --service refill-2 --skip-deploys
railway variable set FEE_PAYER=<FEE_PAYER_2> --service refill-2 --skip-deploys
railway variable set FEE_PAYER_UNSEEN_OK=<FEE_PAYER_2> --service refill-2 --skip-deploys
railway variable set MAX_USDC_PER_SOL=<same value as refill> --service refill-2 --skip-deploys
```

Then set `const REPLICAS = 2;` in `.railway/railway.ts` and apply. It gives `kora-2` the same
settings as `kora`, and `refill-2` the same as `refill` except its schedule, `5-59/10 * * * *`
(:05, :15, ...), five minutes after `refill`'s, so the two jobs never start together.

```bash
railway config plan
railway config apply
railway up kora   --path-as-root --service kora-2
railway up refill --path-as-root --service refill-2
railway domain --service kora-2 --port 8080
KORA_URL=https://<kora-2 domain> FEE_PAYER=<FEE_PAYER_2> PAYMENT_WALLET=<PAYMENT_WALLET> ./scripts/check-deploy.sh
```

Finally add the second endpoint and `FEE_PAYER_2` to the app's server configuration, and
remove `FEE_PAYER_UNSEEN_OK` from `refill-2` after that replica's first relayed transaction.

Things that differ from a single relayer:

- The swap cap (`MAX_RUNS_PER_DAY`) is counted on the shared payment wallet, so both jobs draw
  on one count. If six swaps a day is too few for two fee payers, raise it on **both** refill
  services to the same value.
- The 0.5 SOL daily ceiling is per refill job, so two replicas can receive up to 1 SOL a day.
- Using the shared API key and HMAC secret on both replicas is the simple setup; separate
  secrets per replica also work if the app's server is configured with both.
- The file supports one or two replicas. A third needs its own schedule offset, and Railway
  requires five minutes between a service's runs; think about the wallet's shared swap cap
  before adding one.

## Changing things later

- `MAX_USDC_PER_SOL`: `railway variable set MAX_USDC_PER_SOL=<value> --service refill`.
- A tunable: edit `.railway/railway.ts`, `railway config plan`, `railway config apply`.
- The Kora configuration: edit `kora/kora.toml`, validate it, deploy again.

  ```bash
  cd kora && docker run --rm -v "$PWD":/config:ro -e JUPITER_API_KEY=placeholder \
    ghcr.io/solana-foundation/kora:v2.2.0-beta.8@sha256:1b929cd9b32e6a3dddb646669fbe0d30651e07377b2bface044cd84289df59bf \
    kora --config /config/kora.toml config validate
  ```

- Keys: see "Rotating the fee payer" in `README.md`.
