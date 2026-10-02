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

Leave `allow_create_account = false` and `max_allowed_lamports = 50000` as they ship. Account
opening is turned on later, in "Stage two" at the end of this file, and not before.

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
KORA=ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b
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
`"max_allowed_lamports":50000`, `"allow_create_account":false`, `"max_signatures":2`.

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

## Stage two: turning account opening on

Until this stage the relayer does not fund new token accounts, and the app sends
account-opening actions another way. Do this stage only when all of the following hold:

1. **Precondition, not optional:** the wallet app's deployed server route has passed the app
   team's own test proving that it enforces the minimum payment for a relayer-funded account
   creation, both when the recipient's account is missing and when it already exists. That
   test belongs to the app and is provided by the app team; ask them for its result against
   the deployed route. Without it, stop here.
2. The Kora URL, API key and HMAC secret are known to that server route and to nothing else.
3. Stage one has run cleanly for a while: refills work, no `drain_suspected`.

Then, in `kora/kora.toml`:

```toml
max_allowed_lamports = 2200000     # was 50000: admits exactly one account creation

[validation.fee_payer_policy.system]
allow_create_account = true        # was false
```

Validate (the command under "Changing things later"), deploy the `kora` service again
(step 7), and re-run the checks (step 9): expect `"max_allowed_lamports":2200000` and
`"allow_create_account":true`. Then watch the refill job's `reconcile` output for the first
account-opening sends: `underpaid` must stay 0. An account creation that was not paid for is
2,039,280 lamports uncovered and halts refills (exit 4) on the next run.

To turn it off again, put both values back and redeploy.

## Changing things later

- `MAX_USDC_PER_SOL`: `railway variable set MAX_USDC_PER_SOL=<value> --service refill`.
- A tunable: edit `.railway/railway.ts`, `railway config plan`, `railway config apply`.
- The Kora configuration: edit `kora/kora.toml`, validate it, deploy again.

  ```bash
  cd kora && docker run --rm -v "$PWD":/config:ro -e JUPITER_API_KEY=placeholder \
    ghcr.io/solana-foundation/kora:v2.0.5@sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b \
    kora --config /config/kora.toml config validate
  ```

- Keys: see "Rotating the fee payer" in `README.md`.
