> Record of the fork test run on 2026-10-02: kept as evidence, not as instructions. File paths in it (`logs/`, `deploy/`, the `.mjs` scripts) refer to the test workspace and are not part of this repository.
> Where it differs from `../README.md` and `../deploy.md`, those two are current (notably: the key rotation order was corrected, and the configuration and pricing sections were superseded).

# Kora relayer: what the app needs

For the engineer who implements it. Nothing here is app code. Every behaviour described was
observed on a local mainnet fork with Kora `v2.2.0-beta.8` and the `kora.toml` in
RUNBOOK.md, unless marked **NOT VERIFIED**. The working reference is the set of scripts in
this directory: `flow.mjs` (the full relayed flow), `t3a3.mjs`, `t3b.mjs`, `t3c.mjs`,
`t3d.mjs` (the four cases), `abuse.mjs` (what must be refused). All captured exchanges are
in `logs/exchanges.jsonl`; the ones quoted below are in `logs/examples.json`.

## 0. Facts that shape the design

1. **Kora never builds or alters the transaction** (with Lighthouse off, as configured). The
   app builds the whole thing with the relayer as fee payer, the portfolio signs, Kora adds
   the fee payer's signature. The signed bytes Kora returns have the same message.
2. **`getPaymentInstruction` is not a server method.** Kora's docs: "Client-Side Only
   Method: This method is only available in the TypeScript SDK and does not make actual
   JSON-RPC calls to the server." The payment is an ordinary `TransferChecked` the app adds
   itself. The SDK (`@solana/kora`) was not used and is not needed: it depends on
   `@solana/kit`, the app uses `@solana/web3.js`.
3. **The payment is recognised by destination owner.** Kora sums every SPL transfer in the
   transaction whose destination token account is owned by the payment wallet and whose
   mint is on `allowed_spl_paid_tokens`, values it at the oracle price, and compares with
   the required lamports. Source or position in the transaction does not matter.
4. **Kora simulates the transaction to read inner instructions.** A transaction that fails
   simulation is refused with the simulation error, and every program reached by a CPI must
   be on Kora's allowlist.
5. **A relayer-funded `CreateIdempotent` is always charged rent on the beta**, whether or
   not the account exists (measured: 2,254,263 lamports' worth of USDC charged for a no-op
   that cost the relayer 10,000 lamports). Add the create instruction only when the account
   is missing.
6. **No priority fee.** ComputeBudget is not on Kora's allowlist (RUNBOOK.md section 3
   explains why), so a relayed transaction must not contain a ComputeBudget instruction.
7. **Exactly two signatures**: the fee payer, then the portfolio.

## 1. The relay route

A new same-origin route next to the existing three, for example `POST /api/relayer`, built
on the same `admit` and `relay` helpers in `src/lib/server/relay.ts` (same-origin check,
per-visitor rate limit, body cap, nothing logged). Server-only configuration:

| Variable | Use |
| --- | --- |
| `KORA_URL` | upstream |
| `KORA_API_KEY` | sent as `x-api-key` |
| `KORA_HMAC_SECRET` | signs each upstream request |
| `KORA_FEE_PAYERS` | pinned fee payer public keys |
| `KORA_PAYMENT_WALLET` | pinned payment wallet public key |

Forward only these methods, one call per request, no batches:

| Method | Params the browser may send | Notes |
| --- | --- | --- |
| `getPayerSigner` | none | answer is checked against the pinned keys before it is returned |
| `estimateTransactionFee` | `transaction`, `fee_token`, `signer_key` | route forces `sig_verify: false` |
| `signTransaction` | `transaction`, `signer_key` | route forces `sig_verify: false` |

Everything else is refused by the route. `signAndSendTransaction`, `transferTransaction`,
`getBlockhash`, `getSupportedTokens` and the bundle methods are also disabled on Kora (they
answer 405). `getConfig` and `getVersion` stay enabled on Kora for the operator but are not
forwarded.

Upstream authentication, verified byte for byte (`lib.mjs`, `hmacHeaders`):

```
x-api-key: <KORA_API_KEY>
x-timestamp: <unix seconds>
x-hmac-signature: hex( HMAC-SHA256( KORA_HMAC_SECRET, x-timestamp + <exact request body string> ) )
```

The body that is signed must be the exact string that is sent. With both secrets set Kora
requires both; a missing or wrong one answers `401` with an empty body. Timestamps older
than `max_timestamp_age` (60 s in the config) answer 401, so the server clock matters.

Checks the route makes itself, before forwarding `signTransaction` (Kora is the second
line, the route is the first, and the route is where a refusal costs nothing):

- the transaction's fee payer is one of `KORA_FEE_PAYERS`, and `signer_key` equals it;
- it requires exactly two signatures;
- every top-level program is one of: System (only as reached through the ATA program, so in
  practice none at top level), SPL Token, Token-2022, Associated Token Account, Jupiter Lend
  (`jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9`);
- an Associated Token Account instruction funded by the fee payer appears at most once.

Kora answers validation refusals with HTTP 200 and a JSON-RPC `error` (`code` -32000 or
-32001, `message` as in section 7). The route should pass the error through as a fixed
reason, not the message text: messages name addresses. Count refusals here; Kora's own
request counter records them as 200.

Rate limits: `signTransaction` deserves a tight per-visitor budget (each accepted signature
can cost the relayer 10,000 lamports if the transaction is then made to fail, see
RUNBOOK.md section 8). Kora's own `rate_limit` did not throttle in testing.

Privacy of the route: the body is a full transaction, so it carries the portfolio, the
recipient and the amount, exactly like `sendTransaction` on `/api/rpc` already does. One
relayed send names one portfolio; the funding wallet and other portfolios never appear.
The README's table needs a new row: the Kora service sees the portfolio that sends or
lends and its counterparty, never the funding wallet, and never an IP (the request comes
from the app's server). Kora must run with `RUST_LOG=warn`; at its default level it logs
whole transactions.

## 2. Client flow for a send (USDC or a tracker)

1. `getPayerSigner` through the relay. Response (captured):

```json
{"jsonrpc":"2.0","result":{"signer_address":"DVLrS7KrTPhMN7mB5Hj9PA4V2nwAeiEveVP6nwRcPW2e","payment_address":"GSb1G2iyVrhM6UWhxJj216a6zmbg2Df6vsXc9nSu4WL5"},"id":1}
```

   `signer_address` is the fee payer for this transaction; pass it as `signer_key` on the
   next two calls so a pool cannot hand a different key to the second call.
   `payment_address` is a wallet, not a token account: the payment goes to its associated
   token account for USDC.
2. Read the sender's source account and, in a separate request, the recipient's account
   (unchanged from today).
3. Build the draft, fee payer = `signer_address`, blockhash from the app's own RPC relay:
   - if the recipient's token account is missing: a `Create` associated-token-account
     instruction with the **fee payer** as funder (today the portfolio funds it). Token
     program per mint, as now;
   - the `TransferChecked` to the recipient (trackers: Token-2022 program id; no hook
     accounts are needed while the mint's hook program is unset, which the catalog already
     requires);
   - a placeholder payment: `TransferChecked` of 1 unit of USDC from the portfolio's USDC
     account to the payment wallet's USDC account, authority the portfolio. The placeholder
     makes the signer set, and so the fee, identical to the final transaction.
4. `estimateTransactionFee` with `fee_token` = the USDC mint. Request and response
   (captured, a send that opens the recipient's account, 10 percent margin, mock price):

```json
{"jsonrpc":"2.0","id":1,"method":"estimateTransactionFee","params":{"transaction":"<base64, unsigned, 2 signature slots>","fee_token":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","sig_verify":false,"signer_key":"DVLrS7KrTPhMN7mB5Hj9PA4V2nwAeiEveVP6nwRcPW2e"}}
```
```json
{"jsonrpc":"2.0","result":{"fee_in_lamports":2254263,"fee_in_token":2254263,"signer_pubkey":"DVLrS7KrTPhMN7mB5Hj9PA4V2nwAeiEveVP6nwRcPW2e","payment_address":"GSb1G2iyVrhM6UWhxJj216a6zmbg2Df6vsXc9nSu4WL5"},"id":1}
```

   `fee_in_token` is in raw units of `fee_token` (6 decimals for USDC). The two numbers are
   equal here only because the fork's mock price makes 1 USDC worth 1,000,000 lamports.
5. Show the fee on the review screen in USDC, as "network cost", and refuse to continue if
   it is above the cap in section 3.
6. Rebuild with the payment amount set to `fee_in_token`, run the pre-sign guard
   (section 3), have the portfolio sign.
7. `signTransaction`:

```json
{"jsonrpc":"2.0","id":1,"method":"signTransaction","params":{"transaction":"<base64, portfolio's signature present, fee payer's slot zeroed>","signer_key":"DVLrS7KrTPhMN7mB5Hj9PA4V2nwAeiEveVP6nwRcPW2e","sig_verify":false}}
```
```json
{"jsonrpc":"2.0","result":{"signed_transaction":"<base64, both signatures>","signer_pubkey":"DVLrS7KrTPhMN7mB5Hj9PA4V2nwAeiEveVP6nwRcPW2e"},"id":1}
```

8. Before broadcasting, check that `signed_transaction` has the same message bytes as what
   the portfolio signed, and that the signature in the portfolio's slot is unchanged.
9. Broadcast through the existing `/api/rpc` `sendTransaction`, and confirm with the
   existing loop (`outcomeWithin`: `getSignatureStatuses` until confirmed or the blockhash
   expires). The signature is the fee payer's, which is the first signature of the signed
   transaction, so `signatureOf` must be read from Kora's answer, not from the draft.
   The portfolio's own signature is no longer the transaction id.

When the amount is the portfolio's whole USDC balance, the send amount must be reduced by
the fee: the payment and the send come out of the same account.

With a live price (**NOT VERIFIED**), the required amount can rise between step 4 and step
7 and Kora then answers "Insufficient token payment. Required N lamports". Handle it by
re-estimating once and asking the user again only if the new fee is above what they
reviewed. Kora accepts overpayment, so a small buffer also works, at the user's expense.

## 3. Pre-sign guard for a relayer-paid transaction

The portfolio signs a transaction whose fee payer it does not control, built by the app
itself (sends) or partly by Jupiter (Earn). Before signing, all of the following must hold.
The existing private-payment check in `src/lib/solana/private-payments.ts` is the closest
model: sponsor as fee payer, one fee transfer of bounded size to the sponsor's account.

Structure, read from the message:

1. `staticAccountKeys[0]` is in the pinned fee payer list from server configuration (served
   to the client by the app, not taken from Kora's answer). Kora's `getPayerSigner` answer
   must agree with it.
2. `numRequiredSignatures` is 2 and the second signer is the portfolio.
3. No address lookup tables.
4. No ComputeBudget instruction, no durable nonce (`usesDurableNonce` exists already).
5. Top-level programs are within the per-flow list: sends allow the Associated Token
   Account program and the one token program of the asset plus SPL Token for the payment;
   Earn allows the Associated Token Account program, SPL Token and Jupiter Lend.
6. Exactly one payment: one `TransferChecked`, SPL Token program, mint USDC, source the
   portfolio's USDC account, destination the associated token account of the pinned payment
   wallet for USDC, authority the portfolio, amount at most the cap. Any other instruction
   that names the payment wallet's account is a refusal.
7. Fee cap. Pin it in code, in USDC, per flow: a ceiling for a transaction that opens no
   account and a higher one for a transaction that opens one. Derive them from the measured
   costs (10,000 lamports, and 2,049,280 or 2,146,720 lamports) times your margin times a
   generous SOL price; the point is that a wrong or hostile estimate cannot take more than
   a known amount.
8. An Associated Token Account instruction, when present, is `Create` (instruction byte 0
   or empty data), funded by the fee payer, for the expected owner and mint, and appears at
   most once. If the app is ever run against Kora `v2.0.5`, `CreateIdempotent` (byte 1)
   funded by the fee payer must be refused outright by the relay route: on that version it
   is the stale-state rent drain shown in RUNBOOK.md section 0.
9. For a send, the portfolio is a read-only signer (it is only a token authority), so none
   of its SOL can move. For Earn the Lend instruction marks it writable; rule 10 covers it.
10. Nothing else is debited. Simulate (the existing `verifyBalancesBeforeSigning` path,
    `sigVerify: false`) and require: the portfolio's USDC falls by exactly the send or
    deposit amount plus the payment; the asset account falls by exactly the send amount;
    the portfolio's SOL does not fall; no other token account the portfolio owns loses
    balance or gains a delegate. `maxLamportsSpent` becomes 0 for relayed transactions.
11. The funding wallet and every other portfolio of this wallet are absent from the account
    list. The client knows all of them; this is a set check on `staticAccountKeys`.

After Kora signs (step 8 of section 2): same message bytes, portfolio signature untouched.

## 4. Client flow for Earn (Jupiter Lend)

Jupiter's Lend API cannot build with a separate fee payer. The request body is
`asset`, `signer`, `amount` and nothing else (OpenAPI spec, saved in
`logs/jupiter-lend-openapi.yaml`); sending `payer` or `feePayer` as well is ignored and the
returned transaction still has the signer as fee payer (both tried against the live API).

It does not need to. Two ways to get the instruction, both proven on the fork:

- keep calling `POST /lend/v1/earn/deposit` (or `/withdraw`) and decompile the returned
  transaction, as `withTokenAccount` already does. It is a legacy message with one Lend
  instruction and no lookup tables;
- or call `POST /lend/v1/earn/deposit-instructions` (or `/withdraw-instructions`), which
  returns `{"instructions":[{"programId","accounts":[{"pubkey","isSigner","isWritable"}],"data"}]}`
  with `data` in base64. This needs the relay's Jupiter path allowlist extended.

Then build the relayed transaction:

1. if the receipt account (deposit) or the USDC account (withdrawal) is missing: `Create`
   associated-token-account, funded by the **fee payer**, owner the portfolio. Only when
   missing: today's code prepends `CreateIdempotent` unconditionally, which on the relayer
   would charge the user rent every time;
2. Jupiter's Lend instruction, unmodified;
3. the USDC payment.

Fee payer the relayer, compiled as a legacy message (no lookup tables), no ComputeBudget
instruction: the deposit used about 57,000 compute units, inside the default limit. Then
estimate, guard, sign, Kora signs, broadcast, confirm, exactly as a send. The existing
Earn limits still apply (`maxCashSpent` grows by the payment, `maxLamportsSpent` becomes 0,
`receive.minAmount` unchanged). `PROGRAMS` loses `COMPUTE_BUDGET_RULE` for relayed
transactions.

On a withdrawal the payment comes out of the portfolio's USDC account before the withdrawn
USDC arrives only if the payment instruction is placed first; place it last, after the Lend
instruction, so a portfolio whose USDC is all lent can still pay. Proven order: create (if
needed), Lend, payment. A portfolio with no USDC at all and nothing but a receipt balance
can therefore withdraw and pay from the proceeds; that exact case (zero USDC before the
withdrawal) is **NOT VERIFIED**, because Kora's simulation and the payment check both ran
with USDC already present.

Kora's allowlist carries Lend (`jup3YeL8...`) and the program it calls into
(`jupeiUmn...`). Is that safe for the relayer? What was tested: a Lend deposit built for
`signer` = the fee payer, which would have lent the relayer's own USDC, is refused ("Fee
payer cannot be used for 'SPL Token Transfer'"), because Kora inspects the inner token
transfer. What is not covered: Kora has no parser for Lend's own instructions (it says so
at startup), so its protection is limited to what those programs do through System and the
token programs. With the payment wallet separate from the fee payer, the fee payer owns no
tokens and no Lend position, which is what makes that limit acceptable.

Open risk, **NOT VERIFIED**: the app's code notes that Jupiter opens an account of its own
for some first-time depositors (first deposits were seen costing up to 3,656,268 lamports).
The payer of that account is the Lend instruction's `signer`, the portfolio, which holds no
SOL in this design. The first deposit run on the fork did not need it. If it occurs, the
simulation fails and Kora refuses; the app should then offer the fallback in section 5.

## 5. When Kora is unavailable or refuses

Treat the relayer as an optimisation with a tested fallback, not a dependency.

- `getPayerSigner` or `estimateTransactionFee` fails (network error, 401, 5xx, timeout):
  nothing has been signed. Fall back to today's path: the portfolio pays in SOL if it has
  enough, otherwise the existing "Cover network fees" swap. Say that the network cost
  could not be covered in USDC right now.
- `signTransaction` is refused: the portfolio has signed a transaction that cannot land
  (the fee payer's signature is missing). Discard it. For "Insufficient token payment",
  re-estimate once. For any other refusal, fall back as above; do not retry in a loop.
- `signTransaction` succeeded but broadcast fails or the outcome is unknown: this is the
  existing `UnknownOutcomeError` case. Settle it against the chain using the fee payer's
  signature. Never ask Kora to sign a second copy before the first one's blockhash has
  expired: both could land.
- The relayer's SOL has run out: Kora's simulation fails and it refuses; same fallback. The
  refill job and the balance alert exist to keep this from happening.
- The route's kill switch: with `KORA_URL` unset the route answers a fixed "unavailable"
  and the client goes straight to the fallback. That is also the rollback.

## 6. Refilling SOL (to be built separately, specified here)

Kora has nothing built in for this; see RUNBOOK.md section 9 for the quotes. The smallest
safe version is one scheduled job, outside Kora and outside the wallet app's request path.

- **Trigger**: on a schedule (every 10 to 15 minutes), read the fee payer's SOL balance.
  Do nothing while it is above the refill threshold (for example 0.2 SOL).
- **Key**: the job holds the **payment wallet's** key and nothing else. The fee payer's key
  never signs a swap and never leaves the Kora service. The job needs no Kora credentials.
- **Action**, two transactions:
  1. swap a bounded amount of the payment wallet's USDC to SOL through Jupiter's Swap API,
     payment wallet as taker, SOL delivered to the payment wallet;
  2. a System transfer of the received SOL, less a small reserve, from the payment wallet to
     the fee payer's pinned public key.
  The payment wallet needs a little SOL of its own for these two fees (about 0.01 SOL keeps
  it going for hundreds of runs); the job tops that reserve up from the swap output.
- **Caps**, all constants in the job:
  - at most N USDC per run (for example 25) and at most M runs per day;
  - never more than the payment wallet's USDC balance minus a floor;
  - a minimum output: refuse the quote if it is worse than the independent SOL price by
    more than a set slippage, the same idea as the app's swap guard;
  - the transfer destination is a constant, never an input;
  - an upper bound on the fee payer balance after refill, so a bug cannot move everything.
- **Failure**: the job fails closed and alerts. Nothing depends on it in the request path.
  If it stays down, the fee payer runs dry, Kora starts refusing, and the app falls back to
  portfolio-paid fees (section 5). A half-finished run (swap done, transfer not) leaves SOL
  in the payment wallet; the next run's step 2 picks it up, so step 2 must be written to
  transfer whatever SOL is above the reserve regardless of whether step 1 ran.
- **What it reveals on chain**: a recurring transfer from the payment wallet to the fee
  payer, linking the two. They are linked already by every relayed transaction.

## 7. Refusal messages seen (for mapping to fixed reasons)

| Message | Meaning |
| --- | --- |
| `Invalid transaction: Insufficient token payment. Required N lamports` | no payment, too little, wrong token, or wrong destination |
| `Invalid transaction: Program X is not in the allowed list` | top-level or inner program not allowlisted |
| `Invalid transaction: Fee payer cannot be used for '...'` | fee payer policy |
| `Invalid transaction: Total transfer amount N exceeds maximum allowed 2200000` | more than one account creation, or other fee payer outflow |
| `Invalid transaction: Too many signatures: 3 > 2` | more than fee payer plus portfolio |
| `Invalid transaction: Transaction simulation failed: ...` | the transaction would fail on chain |
| `Validation error: Blocked mint extension found on mint account X` | Token-2022 block list |
| `Validation error: Mutable transfer-hook authority found on mint account X` | `transfer_hook_policy` is not `allow_all` |
| HTTP 401, empty body | authentication |
| HTTP 405, empty body | method disabled in `kora.toml` |

## 8. Privacy for this product

What an on-chain observer sees in one relayed send (account list of a real fork
transaction, `4VSz4RMav6EaCH29bZbmoF4ELX5Z4PMRAhwUhG3G5GFKSjXF7XYmHwgzdBKSVCW9WhSR1kq97BqUnNnbks8Dmbra`):

| Index | Account | Role |
| --- | --- | --- |
| 0 | fee payer | signer, pays the fee and any rent |
| 1 | the portfolio | signer |
| 2 | recipient's token account | |
| 3 | portfolio's USDC account | |
| 4 | payment wallet's USDC account | receives the fee |
| 5 to 9 | programs, recipient wallet, mint | |

- **The relayer key and the payment account are shared by every user, so they define a
  public set**: every address that ever appears as second signer next to the fee payer, or
  as the source of a transfer into the payment wallet's USDC account, is a portfolio of this
  product. Listing them takes one `getSignaturesForAddress` on either account. Today a
  portfolio that only sends pays its own fee and carries no such mark.
- This marks an address as "a portfolio of this app". It does **not** link two portfolios
  to the same owner, and it never involves the funding wallet: one relayed transaction
  names one portfolio. What it adds for an analyst is a small candidate set in which timing
  and amount correlation (the gap the README already names) becomes easier. The trading
  referral account already marks portfolios that trade in the same way.
- **A pool of fee payers** is supported: several `[[signers]]`, strategy `round_robin`,
  `random` or `weighted`, and a `signer_key` parameter to pin one per request (verified
  with two signers). It does not restore privacy. `getConfig` lists every pool key, they
  are funded and refilled from one place, and with `payment_address` set they all pay into
  one account.
- **The payment destination can differ from the fee payer** (`payment_address`, verified),
  but it is a single address for the whole server, not one per signer or per user. Leaving
  it unset makes each signer collect into its own account, which spreads the payments over
  the pool keys at the cost of leaving revenue on the signing keys; the keys are still
  enumerable.
- So the honest statement for users is: sending or lending with the network cost covered
  in USDC makes that portfolio identifiable as one of this app's portfolios. If that
  matters to a user, the existing self-paid path (portfolio holds SOL) leaves no such mark
  and should remain selectable.
- **Off chain**: Kora receives full transactions from the app's server, so it sees
  portfolio, counterparty and amount, never an IP and never the funding wallet. It keeps
  no database in this configuration (Redis is off). At its default log level it writes
  every request and response body, transaction included; `RUST_LOG=warn` removes them
  (verified: zero lines containing a transaction or the user's address across a send and a
  refusal). Its metrics carry method names, status codes and the fee payer's balance only.
  The RPC provider Kora uses sees each relayed transaction simulated once more, from
  Railway's address.
