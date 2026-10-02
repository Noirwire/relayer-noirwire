> Record of the fork test run on 2026-10-02: kept as evidence, not as instructions. File paths in it (`logs/`, `deploy/`, the `.mjs` scripts) refer to the test workspace and are not part of this repository.
> Where it differs from `../README.md` and `../deploy.md`, those two are current (notably: the default image is now stable v2.0.5, and the key rotation order was corrected).

# Kora fee relayer: operator runbook

Everything here was run on 2026-10-02 against a local Surfpool 1.6.0 mainnet fork
(genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`) with Kora in Docker, unless a step
is marked **NOT VERIFIED**. Nothing was sent to real mainnet. Evidence (every request and
response, every result row) is in `logs/` next to this file; the scripts that produced it are
the `.mjs` files in this directory.

## 0. What you are running, and which version

Kora is a JSON-RPC server that co-signs a transaction as fee payer after checking that the
transaction pays it in an allowed token. Source: https://github.com/solana-foundation/kora,
docs: https://solana.com/docs/tools/kora (the old `launch.solana.com/docs/kora` URLs
redirect there with a 308).

| | Stable | Pre-release |
| --- | --- | --- |
| Version | `v2.0.5` (2026-03-11) | `v2.2.0-beta.8` (2026-07-29) |
| Image | `ghcr.io/solana-foundation/kora:v2.0.5` | `ghcr.io/solana-foundation/kora:v2.2.0-beta.8` |
| Digest (index) | `sha256:6e575278f559762d673a02c668e6c96ec2c04a2691ab9a668475272c97cd4e9b` | `sha256:1b929cd9b32e6a3dddb646669fbe0d30651e07377b2bface044cd84289df59bf` |

**This runbook uses `v2.2.0-beta.8`.** That is a deliberate choice you should confirm, because
both options have a cost:

- `v2.0.5` lost money on the fork. A token account that exists when Kora signs, and is closed
  before the transaction lands, is re-created at the relayer's expense with no rent charged:
  the relayer spent 2,049,280 lamports and received 0.011 USDC, and the attacker pocketed the
  rent (signature `2Qjgs4BR39g5MDpto7L94vrdRpfMf5umsmLLxggpVcgu3HQ6P8pKquvhNbY3yPC3KDd7xP4ovEHMsDkxQNAqr8P3`).
  It repeats as fast as transactions land. `v2.2.0-beta.8` charges the rent whenever the
  relayer funds an associated token account, so the same attack paid the relayer 2.254208 USDC
  for the same 2,049,280 lamports. The beta changelog names the fix: "harden fee payer
  protection against ATA rent drain and net-zero payment exploits (#428)".
- `v2.0.5` silently ignores the Token-2022 block list when it is written the way the shipped
  sample `kora.toml` and the docs write it, `[validation.token2022]`. Only
  `[validation.token_2022]` is read (verified: `getConfig` shows an empty list and the
  transfer is signed). `v2.2.0-beta.8` accepts both spellings and refuses unknown keys.
- `v2.2.0-beta.8` is a pre-release, and its code is newer than the audit. The audit
  (Runtime Verification, report `audits/20251119_runtime-verification.pdf`) is commit based:
  "Commits after the audited-through SHA are considered unaudited until a new audit or
  mitigation review updates this file" (`audits/AUDIT_STATUS.md`, audited-through commit
  `8c592591debd08424a65cc471ce0403578fd5d5d`). Both READMEs also say: "Kora uses the
  `solana-keychain` package which has not been audited. Use at your own risk."

If you prefer the stable tag, the app's relay route must refuse every relayer-funded
`CreateIdempotent` (see INTEGRATION.md section 3) and the config below needs the two
beta-only lines removed (`transfer_hook_policy`, the `get_version` and bundle method flags).
That combination was not run end to end.

Docs bug to know about: the documented `docker run ... ghcr.io/solana-foundation/kora:<tag>
--config /app/kora.toml rpc start ...` fails with `exec: "--config": executable file not
found`. The image's command is `kora` with no entrypoint, so the arguments must start with
`kora`.

## 1. Keys: two wallets, both brand new

| Wallet | Signs | Holds | Where the secret lives |
| --- | --- | --- | --- |
| Fee payer | every relayed transaction, inside Kora | SOL only | Railway variable `KORA_PRIVATE_KEY` |
| Payment wallet | nothing in Kora. Only the refill job (INTEGRATION.md section 6) | the USDC users pay | not on the Kora server |

Why the fee payer must be a new key used for nothing else: Kora signs any transaction that
passes its checks, and the fee payer's signature covers the whole transaction, so any
instruction in it can name the fee payer as a signer. Kora's fee payer policy blocks the
System and token program instructions that would move its funds, but for other allowlisted
programs it only inspects their inner calls to those standard programs (startup warning:
"has no dedicated fee-payer instruction parser"). A key that owns nothing but a small SOL
float has nothing else to lose. Kora's own docs: "Use a dedicated keypair for your Kora node
and only fund it with the SOL you're willing to spend on transaction fees."

Why the payment wallet is a different key: with `payment_address` set, the fee payer never
holds a token, so a signing bug cannot touch collected revenue, and rotating the fee payer
does not change where users pay.

```bash
mkdir -p ~/kora-keys && chmod 700 ~/kora-keys
solana-keygen new --no-bip39-passphrase --outfile ~/kora-keys/fee-payer.json
solana-keygen new --no-bip39-passphrase --outfile ~/kora-keys/payment.json
solana-keygen pubkey ~/kora-keys/fee-payer.json   # FEE_PAYER
solana-keygen pubkey ~/kora-keys/payment.json     # PAYMENT_WALLET
```

Kora reads the fee payer secret from an environment variable in any of three forms: base58,
the JSON byte array exactly as `solana-keygen` writes it, or a path to that file (verified
with the JSON array form).

## 2. Funding

Measured relayer cost per transaction (fork, real programs):

| Transaction | Lamports the relayer spends |
| --- | --- |
| USDC or tracker send to an existing account, Earn deposit or withdrawal | 10,000 (two signatures) |
| USDC send that opens the recipient's account | 2,049,280 (2,039,280 rent + 10,000) |
| Tracker send that opens the recipient's Token-2022 account | 2,146,720 (2,136,720 rent + 10,000) |

For a first test fund the fee payer with **0.1 SOL**: about 46 account-opening sends, or
about 10,000 plain sends. The account must also stay above the rent-exempt minimum
(890,880 lamports).

```bash
solana transfer --url <YOUR_MAINNET_RPC> --from <your funded wallet keypair> <FEE_PAYER> 0.1 --allow-unfunded-recipient
solana balance <FEE_PAYER> --url <YOUR_MAINNET_RPC>
```

`solana balance` was verified against the fork. `solana transfer` to mainnet is
**NOT VERIFIED** (nothing was sent to mainnet).

### The payment wallet's USDC account

Kora refuses to start a config check with RPC, and refuses payments, if the payment wallet
has no token account for the payment mint ("Missing ATAs for payment address"). Create it
once, paid by the fee payer (2,039,280 lamports + fee), with Kora's own command. Verified on
the fork:

```bash
cd deploy   # the directory with kora.toml and signers.toml, payment_address already filled in
docker run --rm -v "$PWD":/config:ro \
  -e RPC_URL=<YOUR_MAINNET_RPC> \
  -e JUPITER_API_KEY=<key> \
  -e KORA_PRIVATE_KEY="$(cat ~/kora-keys/fee-payer.json)" \
  ghcr.io/solana-foundation/kora:v2.2.0-beta.8 \
  kora --config /config/kora.toml rpc initialize-atas --signers-config /config/signers.toml
```

Then check the whole configuration against the chain (verified on the fork; it is what
reported the missing account before the step above):

```bash
docker run --rm -v "$PWD":/config:ro -e RPC_URL=<YOUR_MAINNET_RPC> -e JUPITER_API_KEY=<key> \
  -e KORA_PRIVATE_KEY="$(cat ~/kora-keys/fee-payer.json)" \
  ghcr.io/solana-foundation/kora:v2.2.0-beta.8 \
  kora --config /config/kora.toml config validate-with-rpc --signers-config /config/signers.toml
```

## 3. `kora.toml`

The file is `deploy/kora.toml`. Replace `REPLACE_WITH_PAYMENT_WALLET_PUBKEY`. The same file
with `price_source = "Mock"` and a throwaway payment wallet is what every result in section
8 was produced with; with `price_source = "Jupiter"` and a placeholder key it passes
`kora config validate`.

```toml
[kora]
rate_limit = 20
payment_address = "REPLACE_WITH_PAYMENT_WALLET_PUBKEY"

[kora.auth]
max_timestamp_age = 60

[kora.enabled_methods]
liveness = true
estimate_transaction_fee = true
get_supported_tokens = false
get_payer_signer = true
sign_transaction = true
sign_and_send_transaction = false
transfer_transaction = false
get_blockhash = false
get_config = true
get_version = true
estimate_bundle_fee = false
sign_and_send_bundle = false
sign_bundle = false

[validation]
max_allowed_lamports = 2200000
max_signatures = 2
price_source = "Jupiter"
allow_durable_transactions = false
allowed_programs = [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
    "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
]
allowed_tokens = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
allowed_spl_paid_tokens = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]
disallowed_accounts = []

[validation.price]
type = "margin"
margin = 0.1

[validation.fee_payer_policy.system]
allow_transfer = false
allow_assign = false
allow_create_account = true
allow_allocate = false

[validation.token_2022]
transfer_hook_policy = "allow_all"
blocked_mint_extensions = ["transfer_fee_config", "non_transferable", "interest_bearing_config", "mint_close_authority", "confidential_mint_burn"]
blocked_account_extensions = ["non_transferable_account", "confidential_transfer_account", "memo_transfer", "cpi_guard"]

[metrics]
enabled = true
endpoint = "/metrics"
port = 9090
scrape_interval = 60

[metrics.fee_payer_balance]
enabled = true
expiry_seconds = 30
```

Why each value, with what was measured:

- **`payment_address`**: payments go to this wallet's USDC account, not the fee payer's. A
  payment sent to the fee payer's own account instead is refused ("Insufficient token
  payment").
- **`max_allowed_lamports = 2200000`**: this caps two things, the SOL the fee payer sends out
  in one transaction and the network fee. The default 1,000,000 refuses every send that
  opens an account ("Total transfer amount 2039280 exceeds maximum allowed 1000000"). A
  tracker's Token-2022 account costs 2,136,720, so 2,200,000 admits exactly one account
  creation per transaction: two are refused ("Total transfer amount 4078560 exceeds maximum
  allowed 2200000").
- **`max_signatures = 2`**: fee payer plus one portfolio. Caps the base fee at 10,000
  lamports and refuses anything needing a third signer, which includes a raw System
  `CreateAccount` for a fresh keypair ("Too many signatures: 3 > 2").
- **`allowed_programs`**: System, both token programs, the Associated Token Account program,
  and Jupiter Lend's two programs. Kora checks inner instructions too, so the Lend deposit is
  refused until `jupeiUmn...` (the program Lend calls into) is listed as well.
  **ComputeBudget is deliberately absent.** With it on the list a priority fee can be set by
  the caller, and a transaction that Kora signed and that then fails on chain cost the
  relayer 1,970,000 lamports with nothing received (signature
  `2pKRmdpN9cdDEN3bPzRVBd99Z2py7FQFZbenjQSTYDQiwwd5Vw6Qso8Bpwbo529QimSGZVpGJN6REr1ZbTWBAYXr`).
  Without it the same attempt is refused and the worst case is the base fee. The cost: no
  relayed transaction can carry a priority fee. None of the four flows needed one on the
  fork; landing under real congestion is **NOT VERIFIED**.
- **`allowed_tokens` / `allowed_spl_paid_tokens`**: USDC only. Tracker mints do not need to be
  listed to be transferred. A payment made in a tracker is ignored and the transaction
  refused.
- **`fee_payer_policy`**: everything is `false` by default (verified in `getConfig`); only
  `system.allow_create_account` is turned on, because the Associated Token Account program
  creates the account with the fee payer as funder and Kora otherwise refuses with "Fee
  payer cannot be used for 'System Create Account'". Kora warns about this setting at
  startup. Under margin pricing the rent is charged back with the margin on top.
- **`[validation.token_2022]`**: note the underscore. Nothing is blocked unless listed
  (docs: "All extensions are enabled by default"). The tracker mints carry
  `permanent_delegate`, `pausable`, `transfer_hook` (program unset), `confidential_transfer_mint`,
  and their accounts carry `immutable_owner`, `pausable_account`, `transfer_hook_account`.
  Blocking any one of those seven refuses every tracker send (each tested separately), and
  the check applies to every Token-2022 transfer in the transaction, not only to the
  payment. So the list above blocks only extensions the trackers do not have.
  `transfer_hook_policy = "allow_all"` is required on the beta: its default refuses with
  "Mutable transfer-hook authority found on mint account", and
  `deny_mutable_for_delayed_signing` still refuses `signTransaction`. Kora warns that a hook
  authority could attach a hook program between signing and landing. For this product the
  exposure is a failed transaction (base fee, 10,000 lamports): a hook program would also
  have to be on `allowed_programs` for Kora to sign a transaction that reaches it, and the
  payment mint (USDC) has no hook.
- **Payment in USDC is safe from the PermanentDelegate warning** Kora prints: that warning
  is about a payment token that can be seized, and USDC is classic SPL Token.
- **`[metrics] port = 9090`**: keeps `/metrics` off the public port. On the RPC port it
  answers without authentication.
- **`rate_limit`**: do not rely on it. With `rate_limit = 20`, 80 concurrent requests all
  returned 200 in 380 ms. The real controls are authentication and the app's own relay
  limits.
- **`[kora.usage_limit]`** (per-wallet transaction caps) needs Redis and was not run.

`deploy/signers.toml`:

```toml
[signer_pool]
strategy = "round_robin"

[[signers]]
name = "fee_payer_1"
type = "memory"
private_key_env = "KORA_PRIVATE_KEY"
```

## 4. Pricing: what the relayer earns

Config keys, all under `[validation.price]`:

| Model | Keys | Charge |
| --- | --- | --- |
| Margin | `type = "margin"`, `margin = 0.1` (a fraction: 0.1 is 10 percent, 1.0 is 100 percent) | (network fee + fee payer outflow + token transfer fee) x (1 + margin), in lamports, converted to the payment token at the oracle price and rounded up |
| Fixed | `type = "fixed"`, `amount = 50000` (raw units of `token`: 50000 is 0.05 USDC), `token = "<mint>"`, `strict = false` | the fixed amount, whatever the transaction costs |
| Free | `type = "free"` | nothing |

The margin applies to account-creation rent as well as the signature fee: the rent is part
of "fee payer outflow", and the multiplier is applied to the sum.

Measured on the fork with the config above (relayer cost is what its SOL balance dropped by;
"charged" is the lamport value Kora demanded, which is what converts to USDC):

| Case | Relayer cost (lamports) | Margin 10% charged | Margin 100% charged | Fixed 0.05 USDC | Fixed 0.05 USDC, strict |
| --- | --- | --- | --- | --- | --- |
| 3a USDC send, account exists | 10,000 | 11,055 | 20,100 | 0.05 USDC | 0.05 USDC |
| 3b USDC send, opens account | 2,049,280 | 2,254,263 | 4,098,660 | 0.05 USDC: **relayer loses the rent** | refused |
| 3c tracker send, account exists | 10,000 | 11,055 | 20,100 | 0.05 USDC | 0.05 USDC |
| 3c tracker send, opens account | 2,146,720 | 2,361,447 | 4,293,540 | 0.05 USDC: **relayer loses the rent** | refused |

The extra 55 or 100 lamports over cost x (1 + margin) is a 50 lamport allowance Kora adds
when the estimate is requested for a transaction that has no payment instruction yet.

USDC charged = lamports charged x (SOL price in USD) / 1,000,000,000. At an illustrative
SOL price of 150 USD: a plain send costs the relayer 0.0015 USD and is charged 0.0017 USD
at 10 percent or 0.0030 USD at 100 percent; an account-opening send costs 0.307 USD and is
charged 0.338 USD or 0.615 USD. Check the live price before choosing.

What this means for the choice:

- Margin always covers cost, and the rent dominates. A percentage margin on a plain send is
  a fraction of a cent whatever you pick, and on an account-opening send it is a visible
  amount to the user. If the goal is revenue per send, Kora cannot express "cost plus a flat
  fee": it is either a multiplier or a flat amount.
- Fixed without `strict` lost 1,999,280 lamports on one account-opening send (signature
  `2WYY8JuZH1ctnWgwT4ZmtrSo3zq32zjx3UdNrj9E1AmG3SoERm3SFRNiagFgXEHJQ5BA6Hd5i99JzRK1NofeErJv`).
  Fixed with `strict = true` refuses those sends ("Strict pricing violation: total fee
  (2049280 lamports) exceeds fixed price (50000 lamports)"), so users could not send to a
  new recipient at all. Do not use fixed pricing with `allow_create_account = true`.
- Free was run for completeness: the relayer paid everything.
- A flat product fee on top of Kora's margin can be taken by the app as a larger payment:
  Kora accepts any payment at or above what it requires. That is an app decision, not a
  Kora setting.

The fork runs used `price_source = "Mock"`, which fixes a non-devnet token at 0.001 SOL
(so 1 USDC = 1,000,000 lamports there). Pricing against the live Jupiter price is
**NOT VERIFIED**: it needs `JUPITER_API_KEY`, and the server refuses to start without it
("JUPITER_API_KEY environment variable not set. Required when price_source = Jupiter",
verified). With a live price the amount can move between estimate and signing; see
INTEGRATION.md section 2.

## 5. Environment variables for the Kora service

| Variable | Value |
| --- | --- |
| `RPC_URL` | your mainnet RPC URL, key included |
| `KORA_PRIVATE_KEY` | contents of `~/kora-keys/fee-payer.json` (the JSON array) or its base58 form |
| `KORA_API_KEY` | 32 or more random characters: `openssl rand -hex 32` |
| `KORA_HMAC_SECRET` | another 32 or more random characters |
| `JUPITER_API_KEY` | a Jupiter API key |
| `RUST_LOG` | `warn` |
| `PORT` | `8080` |

`RUST_LOG=warn` matters for this product. By default Kora logs every request and response
body at INFO, which is the full base64 transaction (every address and amount in it), for
example `Sign transaction request: SignTransactionRequest { transaction: "Ag..." }`. With
`RUST_LOG=warn` a full send and a refused request produced zero log lines containing a
transaction or the user's address (verified). Do not use the docs' suggested
`RUST_LOG=info`.

With both `KORA_API_KEY` and `KORA_HMAC_SECRET` set, a request needs both (verified: key
only 401, HMAC only 401, wrong secret 401, timestamp 120 s old 401 with
`max_timestamp_age = 60`). `/liveness` is always open.

## 6. Deploying on Railway

**NOT VERIFIED on Railway.** The image built from `deploy/Dockerfile` was built and run
locally against the fork with `PORT` set by the environment, and signed a real transaction
(signature `44DfWsWD8LHMz5KN4WnFDEErg8iaP7MwMRFWyLUfu7AYut16tH4R7DmYaH61Lqq8aTYnACfYoVufiJTKEfwizg2S`).
The Railway steps follow Kora's Railway guide
(https://solana.com/docs/tools/kora/operators/deployment/railway) and Railway's docs.

`deploy/Dockerfile`:

```dockerfile
FROM ghcr.io/solana-foundation/kora:v2.2.0-beta.8@sha256:1b929cd9b32e6a3dddb646669fbe0d30651e07377b2bface044cd84289df59bf
WORKDIR /app
COPY kora.toml signers.toml ./
CMD kora --config /app/kora.toml rpc start --signers-config /app/signers.toml --port ${PORT:-8080}
```

1. Put `Dockerfile`, `kora.toml` (payment address filled in) and `signers.toml` in one
   directory. No secret is in any of the three.
2. `railway login`, `railway init` (new project), `railway up`.
3. In the service's Variables, add the seven variables from section 5. Redeploy.
4. Settings, Networking: generate a public domain on port 8080.
5. Settings, Deploy: healthcheck path `/liveness` (answers `GET` with 200 and no auth,
   verified locally).
6. Check it:

```bash
curl -s https://<your-domain>/liveness                      # 200, body: null
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-domain> \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getConfig"}'   # 401
```

Who can call it: the app runs on Vercel, which is outside Railway's private network, so
the Kora service needs a public domain and authentication is the only gate. Keep both the
API key and the HMAC secret on, and keep `/metrics` on port 9090 so it is not reachable from
the internet. If the app's server ever moves onto Railway, remove the public domain and use
the private address; Kora binds `0.0.0.0` only, and whether Railway's private network
reaches an IPv4-only listener in your environment is **NOT VERIFIED**.

## 7. Variables the app's server needs

| Variable | Value |
| --- | --- |
| `KORA_URL` | `https://<your-railway-domain>` |
| `KORA_API_KEY` | same value as on the Kora service |
| `KORA_HMAC_SECRET` | same value as on the Kora service |
| `KORA_FEE_PAYERS` | the fee payer public key (comma separated if you run more than one) |
| `KORA_PAYMENT_WALLET` | the payment wallet public key |

All five are server-only. None is `NEXT_PUBLIC_`. The two public keys are pinned in the
app's configuration on purpose: the app must not trust whatever key a compromised or
misrouted Kora answers with.

## 8. What was proven

Fee payer `DVLrS7KrTPhMN7mB5Hj9PA4V2nwAeiEveVP6nwRcPW2e`, user
`ccJ7ethoKSFuqNXc3rGUu3cLQ1ckEzFaLjb4eeL14Ap` (holding zero SOL throughout), payment wallet
`GSb1G2iyVrhM6UWhxJj216a6zmbg2Df6vsXc9nSu4WL5`. Signers of every transaction: the fee payer,
then the user. Rows are `v2.2.0-beta.8` with the config in section 3 and a 10 percent margin.

| Case | Signature | Relayer lamports spent | USDC units received |
| --- | --- | --- | --- |
| 3a USDC send, existing account | `2jpuYLcLz6iQCJerwcz8kDcu8MHPNdVVdqQF9nANVv6QWuDCAvRs7RUyvqCzErckxEaPEFdTLiTGavvGJuRGPVKb` | 10,000 | 11,055 |
| 3b USDC send, account opened | `4fSuctk6jHi2WzKMqgcv2DYk6FzLyHJDaf3epjduQp3BSknQ2TWmkDmdKTP3LNzNhZS83CNKXY7mxtSvn7mbizm4` | 2,049,280 | 2,254,263 |
| 3c tracker send (SPYx), existing account | `5AY4rxhY2bm3hCKhQK7FSwmGWsSpb59d8DgEgh3CaFpqDnPj5bsfZhaFCxxLHix3sLjMsPhF1F2qDHL5pjucLLtg` | 10,000 | 11,055 |
| 3c tracker send, Token-2022 account opened (179 bytes) | `zSxMPVnNXsNckdL17F7xgUSv12h3o489HsSn6PH4qUzCJBdEBpeiFhykjbBtjhKPpgFvpmSzBiDL9bzXsEURfon` | 2,146,720 | 2,361,447 |
| 3d Jupiter Lend deposit, 20 USDC | `5mqM4Bn49Y5uEaZU3QgiEKrX37APEPb5usXxGSX9GQpfCThFPLkn7vF9opAq6Vz85e1y6Zb9DHfeHU4As9HYjX2R` | 10,000 | 11,055 |
| 3d Jupiter Lend withdrawal | `425ssVt7yuoRCy2UFS1SiYpWgJz9ZZv6kc1x8xt1m9cqvQg1mpmfZBfy7rJLkU87SCBNXCSnQFyUHasojYhuhNfx` | 10,000 | 11,055 |
| 3d first deposit, receipt account opened (run on v2.0.5) | `55EXjvqNpnv2DzcETi2Vk4yjQmPG2kxsNCNgUmQQKnizQPBx1cmHFa4XjRCUvARvhgC3HR3g2p7MjzHsxrS8sLk5` | 2,049,280 | 2,254,263 |

Refused, same config (full list in `logs/results.jsonl`):

| Attempt | Kora's answer |
| --- | --- |
| No payment instruction | Insufficient token payment. Required 11055 lamports |
| Payment 1 unit short (10,999 of 11,000) | Insufficient token payment. Required 11000 lamports |
| Payment in a token not on the list (SPYx) | Insufficient token payment |
| Payment to the fee payer instead of the payment wallet | Insufficient token payment |
| Instruction to a program not on the list (Memo) | Program MemoSq4g... is not in the allowed list |
| Fee payer transfers its SOL | Fee payer cannot be used for 'System Transfer' |
| Fee payer transfers, approves, closes or re-owns its token accounts | Fee payer cannot be used for 'SPL Token Transfer' / 'SPL Token Approve' / 'Token2022 Token Close Account' / 'SPL Token SetAuthority' |
| Fee payer reassigned to another program | Fee payer cannot be used for 'System Assign' |
| Jupiter Lend deposit with the fee payer as depositor | Fee payer cannot be used for 'SPL Token Transfer' |
| Two or five account creations in one transaction | Total transfer amount exceeds maximum allowed 2200000 |
| Priority fee (ComputeBudget) | Program ComputeBudget111... is not in the allowed list |
| Third signer | Too many signatures: 3 > 2 |

Accepted, and what it costs you:

| Behaviour | Result |
| --- | --- |
| A transaction Kora signed fails on chain (the user emptied the paying account first) | Relayer pays 10,000 lamports, receives nothing. Signature `62ojuUF5CtbrZDeiLuitNS67g1PkXuGMuEuk8X5MKr2gXqqh2F7rXWxq8SWKrrBiiw1KRYQMv9RVdosi8mkstVjZ`. This cannot be configured away. **Worst case per accepted transaction: 10,000 lamports lost.** 1 SOL of float absorbs 100,000 of them. |
| User opens a token account at the relayer's expense and closes it in the same transaction, keeping the rent | Allowed. Relayer spent 2,049,280 lamports and was paid 2,254,263 lamports' worth of USDC; the user ended with 2,039,280 lamports. No loss: it is a USDC to SOL purchase at the oracle price plus your margin, capped at one account per transaction. It does drain the SOL float into USDC, so the refill job and the balance alert matter. |
| Stale-state rent farming (account exists at signing, closed before landing) | No loss on the beta: the rent is charged whether or not the account exists (2,254,208 received for 2,049,280 spent). The side effect is that a harmless `CreateIdempotent` for an existing account costs the user 2.25 USDC at the mock price, so the app must only add it when the account is missing. |

## 9. Topping up and monitoring

Kora has no feature that converts collected USDC back to SOL. Its operator docs put that
on you: "**Automation**: Implement automatic SOL top-up procedures for production
environments" (https://solana.com/docs/tools/kora/operators). The source of both versions
has no swap, sweep, treasury or rebalance code; Jupiter is used only to read prices
(`crates/lib/src/oracle/jupiter.rs`, `{JUPITER_API_URL}/price/v3`). The beta's `gas_swap`
plugin is unrelated: it restricts Kora to signing a "user pays a token, fee payer sends the
user SOL" transaction shape. The job to build is specified in INTEGRATION.md section 6.

Manual top-up: `solana transfer --from <funded keypair> <FEE_PAYER> <amount>`, then
`solana balance <FEE_PAYER>`.

Monitor:

- Fee payer SOL. Alert below **0.05 SOL** (about 23 account-opening sends left). Kora
  exports `signer_balance_lamports{signer_name,signer_pubkey}` on `/metrics` (verified), but
  on port 9090, which Railway does not expose; the simplest alert is the refill job or any
  scheduled `getBalance` on the fee payer.
- Request outcomes: `kora_http_requests_total{method,status}` (verified). Refusals by
  validation return HTTP 200 with a JSON-RPC error, so they are not visible in that
  counter; count them in the app's relay route. A rise in 401s means the secret is wrong
  or someone found the URL.
- Payment wallet USDC balance against fee payer SOL spent: they should move together. SOL
  falling with no USDC arriving is the failed-transaction pattern above.

## 10. Rotating the fee payer

Multiple signers and per-request selection are supported (verified with two memory signers:
`getPayerSigner` alternated between them, `getConfig` listed both, `signer_key` pinned one).

1. Generate a new key, fund it.
2. Add its public key to the app's `KORA_FEE_PAYERS`, keeping the old one. Deploy the app.
3. Replace `KORA_PRIVATE_KEY` on Railway with the new secret. Redeploy Kora.
4. Remove the old public key from `KORA_FEE_PAYERS`. Deploy the app.
5. Move what is left out of the old key:
   `solana transfer --from old-fee-payer.json <new FEE_PAYER> ALL`.

The payment wallet does not change, so nothing users pay to moves. Rotate `KORA_API_KEY`
and `KORA_HMAC_SECRET` by setting the new values on both services; there is a short window
of 401s between the two deploys, during which the app falls back (INTEGRATION.md section 5).
Steps 2 to 5 are **NOT VERIFIED** as a sequence; the two-signer pool they rely on is.

## 11. Not verified

- Anything on Railway or Vercel, and anything on real mainnet.
- `price_source = "Jupiter"` with a real key, and how far a live price moves between
  estimate and signing.
- `signAndSendTransaction`: it failed every time on the fork with a Surfpool-side error
  ("Failed to fetch accounts from remote"), on both versions. The integration does not use
  it; it is disabled in the config.
- `sig_verify = true`. Every call used `false`, which is Kora's default.
- Redis-backed features: caching and per-wallet usage limits.
- Lighthouse balance assertions (beta). They change the flow: Kora edits the transaction
  and the portfolio must sign after Kora, not before.
- Remote signers. The beta lists Turnkey, Privy, HashiCorp Vault, AWS KMS, GCP KMS, Fireblocks, Para,
  CDP, Dfns, Crossmint and Openfort; only the in-memory key was run.
- A first Earn deposit where Jupiter Lend opens an extra account of its own for the
  depositor. The app's code records that this happens for some depositors. The payer in
  that case is the instruction's signer, the portfolio, which has no SOL; the one first
  deposit run here did not hit it.
- Landing without priority fees under congestion.
