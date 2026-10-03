# Relayer gateway

One service in front of many private Kora relayers. Other Solana apps ("customers") call it
so that their users pay network costs in USDC and never need SOL. Each customer has its own
credentials, its own Kora instance with its own fee payer, a markup on the network cost, and
a payout account. Customers talk only to the gateway; no Kora is reachable from outside.

Plain Node (ES modules, no framework, no build step). State lives behind a small store
interface with an in-memory and a Postgres implementation.

## What is supported today

One transaction template, `usdc-transfer`: the user sends USDC (classic SPL Token) from an
existing token account to an existing token account, and pays the network cost plus the
markup in USDC inside the same transaction.

Not supported, and refused: any other program or instruction, Token-2022, creating accounts
(the recipient must already have a USDC token account), address lookup tables, durable
nonces, more than one user signer, any other token. There is no dashboard, no sign-up and no
second template. `GET /v1/quote` does not exist: see the client flow.

## Trust model

- **The gateway never holds customer money.** The split is two transfers inside the user's
  own transaction: one to our payment account, one to the customer's payout account. They
  land together with the user's action or not at all.
- **The gateway never holds a signing key.** It decides; the customer's Kora signs. A
  compromised gateway can ask a Kora to sign, and Kora then applies its own rules: Kora is
  the second gate, the gateway is the first.
- **Customers are isolated.** One Kora and one fee payer per customer. The customers file is
  refused if two customers share an id, an API key, a fee payer, a Kora or a payment account.
  A customer's quote is invisible to every other customer.
- **A customer is not trusted with the transaction.** The gateway builds it (`/v1/prepare`)
  and accepts back only those exact message bytes with the user's valid signature
  (`/v1/sign`). Every template, account and payment check then runs again from the bytes and
  from the chain as it is at that moment.
- **The user is protected from the relayer.** The fee payer may not appear in any
  instruction, the user is a read-only signer, the only programs are SPL Token and
  ComputeBudget, and the network cost has a hard cap (`MAX_NETWORK_COST_MICRO_USDC`).
- **The relayer's cost has two independent sources.** Kora's own estimate, and a floor
  computed here from the transaction at Pyth's SOL/USD price. If either is missing or stale,
  nothing is quoted or signed.
- **What is not covered.** A transaction can still fail on chain after it was signed (the
  user moves the USDC away first); the fee payer then pays the fee without being paid. Kora's
  simulation makes this hard and the daily budgets bound it. The Pyth account is read through
  the same RPC as everything else: an RPC that lies can lie about the price too, and the cost
  cap is what bounds that.

## The split

All amounts are whole micro-USDC (6 decimals), computed with integers only.

```
B = max( Kora's estimateTransactionFee in USDC ,
         ceil( (5000 * signatures + ceil(unitLimit * unitPrice / 1e6)) lamports * SOL price ) )
M = ceil( B * markupBps / 10000 )      the markup, markupBps at most 30000
S = ceil( M / 5 )                      our share: 20 percent, rounded up
C = M - S                              the customer's share
```

The transaction carries exactly two USDC `TransferChecked` payments from the user's token
account: **B + S** to our payment account for that customer, and **C** to the customer's
payout account. When C is 0 the second transfer is omitted. Exact amounts, exact
destinations, nothing else.

Example, a network cost of 1,600 micro-USDC at a markup of 5000 (50 percent): M = 800,
S = 160, C = 640. The user pays 1,760 to us and 640 to the customer, 2,400 in total.

Kora's own margin is set to 0 for customer instances: the markup is the only margin.

## Client flow

The payment amounts depend on the cost and the cost depends on the transaction, so the
client does not build the transaction. Two calls:

1. `POST /v1/prepare` with who pays, from which account, to which account, how much. The
   gateway builds the complete unsigned transaction (the transfer, both payments, the
   customer's fee payer, a recent blockhash), prices it, and returns it with a quote.
2. The user signs **exactly** that transaction. Nothing may be changed, not even the
   blockhash.
3. `POST /v1/sign` with the quote id and the signed transaction. The gateway checks
   everything again, has the customer's Kora add the fee payer's signature, broadcasts, and
   returns the transaction signature.

A quote lives for `QUOTE_TTL_SECONDS` (45 by default). If `/v1/sign` answers `cost_rose` or
`quote_expired`, prepare again and have the user sign the new transaction.

`/v1/sign` returns once the network has accepted the transaction, not once it is confirmed.
Confirm it by its signature on your own RPC.

### Repeats and unknown outcomes

`/v1/sign` is idempotent by quote. Repeating it with the same quote returns the first
result (the same signature, or the same refusal) and never signs twice. While the first
request is still running a repeat gets `sign_in_progress` (409): ask again.

If the gateway forwarded the transaction and then lost track of it (a timeout from Kora or
from the RPC), the answer is `outcome_unknown` (502), with the transaction `signature` when
it is known. The quote is closed as unknown and **never retried**: the transaction may still
land. Settle it against the chain by signature, and prepare a new one only after the old
blockhash has expired.

## Endpoints

JSON in, JSON out. Refusals are `{ "error": { "code", "message" } }` with a stable `code`.

### Authentication

Every `/v1` request carries three headers:

| Header | Value |
| --- | --- |
| `x-api-key` | the customer's API key |
| `x-timestamp` | unix seconds, within 5 minutes of the gateway's clock |
| `x-signature` | lowercase hex of `HMAC-SHA256(secret, timestamp + method + path + body)` |

`method` is `POST`, `path` is for example `/v1/prepare`, `body` is the exact bytes sent.

```bash
BODY='{"user":"<user wallet>","source":"<user USDC account>","recipient":"<recipient USDC account>","amountMicroUsdc":"5000000"}'
TS=$(date +%s)
SIG=$(printf '%s' "${TS}POST/v1/prepare${BODY}" | openssl dgst -sha256 -hmac "$GATEWAY_SECRET" -hex | sed 's/^.* //')
curl -s http://127.0.0.1:8787/v1/prepare \
  -H "content-type: application/json" -H "x-api-key: $GATEWAY_API_KEY" \
  -H "x-timestamp: $TS" -H "x-signature: $SIG" -d "$BODY"
```

The gateway stores only the SHA-256 of the API key; the HMAC secret comes from its
environment. A request replayed inside the five minutes authenticates again, which is safe
by construction: a replayed prepare only issues another quote, a replayed sign returns the
first result.

### `GET /health`

`200 {"status":"ok"}`. No credentials.

### `POST /v1/prepare`

```json
{
  "user": "<the user's wallet, the one that will sign>",
  "source": "<the user's USDC token account>",
  "recipient": "<the recipient's USDC token account, which must exist>",
  "amountMicroUsdc": "5000000",
  "priorityMicroLamports": 0
}
```

`amountMicroUsdc` is a string of digits (or a JSON integer). `priorityMicroLamports` is
optional: with a value above 0 the transaction carries a compute unit limit and price, and
the priority fee is part of the network cost.

```json
{
  "quoteId": "10ed5c49-812a-45bd-af1c-719cb166d864",
  "transaction": "<base64, unsigned v0 transaction, two signature slots>",
  "feePayer": "<the customer's relayer>",
  "paymentAccount": "<where B + S goes>",
  "payoutAccount": "<where C goes>",
  "networkCostMicroUsdc": "1600",
  "platformMicroUsdc": "1760",
  "customerMicroUsdc": "640",
  "expiresAt": "2026-10-03T21:13:20.386Z"
}
```

`platformMicroUsdc` is B + S, `customerMicroUsdc` is C. The user's total cost on top of the
transfer is their sum.

### `POST /v1/sign`

```json
{ "quoteId": "10ed5c49-812a-45bd-af1c-719cb166d864", "transaction": "<base64, signed by the user>" }
```

`200 {"signature":"<transaction signature>"}` or a refusal.

What happens, in order (`src/service.mjs`):

1. the quote exists, is this customer's, is unused and unexpired;
2. the message bytes equal the prepared message (compared by SHA-256);
3. the user's ed25519 signature over those bytes verifies;
4. every template rule, from scratch (`src/template.mjs`);
5. the payments are exactly B + S and C for the quoted B and the customer's markup;
6. the accounts on chain: every source is a USDC account owned by the user; recipient,
   payment and payout accounts exist and are USDC accounts (`src/accounts.mjs`);
7. the network cost again; refused if it is above the quoted B (`src/cost.mjs`);
8. the quote is claimed and the daily budget consumed, atomically (`src/store/`);
9. the customer's Kora signs; its answer must be the same message with the user's signature
   untouched and a valid fee payer signature;
10. one broadcast.

### Refusal codes

| Group | Codes |
| --- | --- |
| Request | `not_found` `bad_request` `body_too_large` `unauthorized` `customer_suspended` `template_not_enabled` `rate_limited` `budget_exhausted` |
| Transaction | `oversize_transaction` `malformed_transaction` `unsupported_version` `lookup_tables_not_allowed` `wrong_fee_payer` `unexpected_signers` `user_writable` `fee_payer_misused` |
| Instructions | `program_not_allowed` `token_2022_not_allowed` `durable_nonce_not_allowed` `account_creation_not_allowed` `delegate_not_allowed` `authority_change_not_allowed` `close_account_not_allowed` `token_instruction_not_allowed` `compute_budget_not_allowed` `compute_limit_above_cap` `priority_fee_above_cap` |
| Transfers | `wrong_mint` `wrong_authority` `action_mismatch` `payment_mismatch` `recipient_not_allowed` |
| Accounts | `source_invalid` `source_not_owned_by_user` `recipient_invalid` `payment_account_invalid` `payout_account_invalid` |
| Cost | `price_unavailable` `kora_unavailable` `kora_mismatch` `cost_above_cap` `cost_rose` `chain_unavailable` |
| Signing | `quote_not_found` `quote_expired` `message_mismatch` `bad_user_signature` `sign_in_progress` `kora_refused` `kora_bad_response` `broadcast_rejected` `outcome_unknown` `internal` |

Messages are fixed text. They never repeat an address, a transaction or anything an
upstream said.

## How Kora is called

Two methods only, with Kora's own authentication (`x-api-key`, `x-timestamp`,
`x-hmac-signature` = hex HMAC-SHA256 over `timestamp + body`), see `src/kora.mjs`:

- `estimateTransactionFee` with `fee_token` = the USDC mint and `signer_key` = the
  customer's fee payer. Its `signer_pubkey` must be that fee payer and its `payment_address`
  must be the wallet that owns the customer's payment account, or the request is refused.
- `signTransaction`, then the gateway broadcasts through its own RPC.

`signAndSendTransaction` is deliberately not used. Kora can change a message before signing
it; with `signTransaction` the signed bytes come back to the gateway first and are broadcast
only if they are the message the user signed. The transaction id is the fee payer's
signature, so having the signed bytes also means an unknown outcome is recorded with the
signature needed to settle it. And one fewer method is enabled on every Kora.

### What each customer's Kora needs

- private network address, reachable only by the gateway; its own fee payer and credentials;
- `estimate_transaction_fee` and `sign_transaction` enabled, `sign_and_send_transaction` off;
- `allowed_programs`: SPL Token, plus ComputeBudget if priority fees are offered
  (otherwise set `MAX_PRIORITY_MICRO_LAMPORTS=0`);
- `allowed_spl_paid_tokens`: the USDC mint; `payment_address`: the wallet that owns the
  customer's `paymentAccount`; `max_signatures = 2`; price margin 0;
- the Lighthouse assertion off: it changes the message, and the gateway refuses to broadcast
  a message the user did not sign (`kora_bad_response`).

## Configuration

Everything is checked at start. Anything malformed is a refusal to start (exit code 2) with
one JSON line naming the variable or field and the rule, never a value.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | required | RPC endpoint |
| `STORE` | required | `postgres`, or `memory` for one local process |
| `DATABASE_URL` | required with `postgres` | apply `migrations/001_gateway.sql` first |
| `CUSTOMERS_FILE` | required | path of the customers file |
| `PORT` | 8787 | |
| `USDC_MINT` | mainnet USDC | the mint, per network |
| `COMPUTE_UNIT_LIMIT` | 30000 | limit set on, and the most allowed in, a transaction with a priority fee |
| `MAX_PRIORITY_MICRO_LAMPORTS` | 500000 | cap on the priority fee; 0 forbids it |
| `MAX_NETWORK_COST_MICRO_USDC` | 100000 | cap on B |
| `COST_BUFFER_BPS` | 0 | see "Price movement" |
| `QUOTE_TTL_SECONDS` | 45 | 5 to 60 |
| `MAX_PRICE_AGE_SECONDS` | 60 | staleness bound of the Pyth price |
| `UPSTREAM_TIMEOUT_MS` | 15000 | bound on every RPC, Kora and database call |

### Customers

`CUSTOMERS_FILE` holds public fields only (`customers.example.json`):

| Field | Rule |
| --- | --- |
| `id` | 2 to 32 characters of `a-z`, `0-9`, `-` |
| `name` | free text |
| `apiKeyHash` | lowercase hex SHA-256 of the API key: `printf '%s' "$KEY" \| shasum -a 256` |
| `templates` | `["usdc-transfer"]` |
| `markupBps` | 0 to 30000 |
| `payoutAccount` | the customer's USDC token account, receives C |
| `paymentAccount` | USDC token account of this customer's Kora payment wallet, receives B + S |
| `koraUrl` | this customer's Kora |
| `feePayer` | this customer's Kora fee payer |
| `budgets` | `requestsPerMinute`, `transactionsPerDay`, `networkCostMicroUsdcPerDay` |
| `status` | `active` or `suspended` |

Secrets come from the environment, per customer, named by the id in upper case with `-`
written as `_` (id `example-app` reads `..._EXAMPLE_APP`):

| Variable | Meaning |
| --- | --- |
| `GATEWAY_HMAC_SECRET_<ID>` | what the customer signs its requests with |
| `KORA_API_KEY_<ID>` | the gateway's API key on that customer's Kora |
| `KORA_HMAC_SECRET_<ID>` | the gateway's HMAC secret on that customer's Kora |

Each at least 32 characters. Changing customers means editing the file and restarting.

### Limits

- **Rate limit**: `requestsPerMinute` per customer, counted in each gateway process.
- **Daily budgets**: `transactionsPerDay` and `networkCostMicroUsdcPerDay`, per UTC day, in
  the store, shared by every process. A sign that would pass either limit is refused with
  `budget_exhausted` and consumes nothing. Consumption and the claim of the quote are one
  atomic step. A sign that was claimed and then failed or ended unknown keeps its budget
  consumed: the budget counts what was handed to the relayer, not what landed.

### Price movement

The quoted B is exact, and `/v1/sign` refuses with `cost_rose` when the cost is above it.
Kora prices the fee with a live oracle, so the estimate can tick up between prepare and
sign, and Kora itself then refuses a payment that is one unit short. With
`COST_BUFFER_BPS=0` (the default, the exact formula above) expect such refusals whenever the
SOL price rises inside the quote's lifetime; the client prepares again. Setting
`COST_BUFFER_BPS` (for example 200, two percent) quotes B that much higher, so small moves
no longer refuse. The buffer is paid by the user and collected with B.

## State

| | In memory | Postgres |
| --- | --- | --- |
| Customers | from the file | from the file |
| Quotes and their outcome (idempotency) | lost on restart | `gateway_quotes` |
| Daily budgets | lost on restart | `gateway_budgets`, one statement checks and adds |

The transaction itself is never stored, only the SHA-256 of its message. Prepared quotes that
were never signed can be deleted once expired:
`DELETE FROM gateway_quotes WHERE state = 'prepared' AND expires_at_ms < <now - 1 hour>`.
A quote left in `signing` (the process died between the claim and the result) is answered as
`outcome_unknown` after two minutes and is never claimed again.

## Logs

One JSON line per request on stdout: time, route, method, customer id, outcome (`ok`,
`refused`, `unknown`, `error`), refusal code, quote id, the three amounts, the transaction
signature, status and duration. Never a body, a header, a transaction, a user's address or
an upstream's words.

## Running locally

```bash
npm ci
npm run lint        # node --check on every module
npm test            # no network; Postgres store tests are skipped unless
                    # GATEWAY_TEST_DATABASE_URL names a database with the migration applied
npm run smoke       # real server on 127.0.0.1:8787 with the in-memory store, a fake Kora
                    # and a fake RPC: /health, /v1/prepare, /v1/sign with a generated user key
npm run dev         # the same server, left running; prints the throwaway credentials
```

`DEV_PORT` moves the dev server. The fakes live in `test/helpers.mjs`; the fake Kora checks
the three headers the way Kora's middleware does and signs with a generated fee payer key.

Against a local Kora instead of the fake: start Kora with a config as described above, write
a customers file with its fee payer and payment account, and run `npm start` with
`STORE=memory`, `RPC_URL`, `CUSTOMERS_FILE` and the three secrets set.

## Layout

```
src/main.mjs            entry point: config, store, listen
src/config.mjs          environment, refusal to start
src/customers.mjs       the customers file and per-customer secrets
src/server.mjs          HTTP, body cap, one log line per request
src/auth.mjs            API key, timestamp, HMAC
src/ratelimit.mjs       requests per minute
src/service.mjs         prepare and sign
src/template.mjs        the usdc-transfer rules, the exact payments, the builder
src/accounts.mjs        account checks against the chain
src/cost.mjs            network cost: Kora's estimate and the floor
src/price.mjs           the Pyth SOL/USD price source
src/kora.mjs            Kora JSON-RPC client
src/split.mjs           the arithmetic
src/bounded.mjs         wall-clock bound on every RPC call
src/units.mjs           base58
src/store/memory.mjs    store, in memory (and the interface)
src/store/postgres.mjs  store, Postgres
src/errors.mjs          every refusal code
migrations/             SQL schema
```
