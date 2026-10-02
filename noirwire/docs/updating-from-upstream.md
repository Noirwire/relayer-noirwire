# Keeping up with upstream Kora

This repository is a fork of https://github.com/solana-foundation/kora. Everything of ours
lives in the top-level `noirwire/` folder (its own `package.json`, lockfiles and `.gitignore`
included), so an upstream merge never touches our files and our files never conflict with
upstream's. We do not build Kora from the fork's source: the services run the **published
image**, pinned by digest in `noirwire/kora/Dockerfile*`. Updating therefore has two separate
parts: bringing the source tree up to date (for reading and diffing), and moving the pin.

The git commands below are for the repository owner and are NOT VERIFIED here: they were
written, not run. Commands are run from the repository root unless they start with `cd`.

## 1. See whether there is anything to do

```bash
noirwire/scripts/check-upstream.sh
```

It prints the latest upstream stable and pre-release tags with their image digests next to
what is pinned, and exits 1 when either differs. A difference is a reason to read on, not a
reason to bump.

## 2. Bring the source tree up to date

One-time setup:

```bash
git remote add upstream https://github.com/solana-foundation/kora.git
```

Each time:

```bash
git fetch upstream --tags
git merge upstream/main          # or: git rebase upstream/main
```

Because our files are all under `noirwire/`, this should apply without conflicts. If it does
conflict, upstream has added a path called `noirwire/`, which would be a surprise: stop and
look.

## 3. Read before moving the pin

For the release you are moving to (`<NEW>`), compared with the pinned one (`<OLD>`):

```bash
git log --oneline <OLD>..<NEW> -- crates/
git diff <OLD>..<NEW> -- audits/AUDIT_STATUS.md kora.toml
```

Look for:

- **`audits/AUDIT_STATUS.md`**: the "audited-through" commit. Is `<NEW>` at or before it?
  Code after that commit is unaudited by upstream's own statement.
- **The changelog / release notes**, for anything about: fee payer protection, rent or
  associated token account handling, payment validation, the fee payer policy defaults,
  Token-2022 extensions and transfer hooks, authentication, pricing or the price oracle.
- **Config keys**: renamed, removed or newly required keys in the sample `kora.toml`, and
  whether unknown keys are refused or silently ignored (v2.0.5 ignores
  `[validation.token2022]`; only `[validation.token_2022]` is read).
- **Method flags** under `[kora.enabled_methods]`: a new method defaults to something; make
  sure anything we do not use is off.
- **Changed defaults** in `getConfig`'s answer: compare it before and after (step 5).

## 4. Move the pin

Get the new digest (the script prints it), then edit the `FROM` line of
`noirwire/kora/Dockerfile` (stable) or `noirwire/kora/Dockerfile.account-opening.beta`
(pre-release): both the tag and the `@sha256:` digest. Update the version named in the
comment above it, in the header of the matching `.toml`, and in `noirwire/README.md` and
`noirwire/deploy.md` (search for the old tag and the old digest).

## 5. Re-validate both configs

```bash
cd noirwire/kora
docker run --rm -v "$PWD":/config:ro -e JUPITER_API_KEY=placeholder \
  ghcr.io/solana-foundation/kora:<STABLE_TAG>@<STABLE_DIGEST> \
  kora --config /config/kora.toml config validate

mkdir -p /tmp/kora-beta && cp kora.account-opening.beta.toml /tmp/kora-beta/kora.toml
docker run --rm -v /tmp/kora-beta:/config:ro -e JUPITER_API_KEY=placeholder \
  ghcr.io/solana-foundation/kora:<BETA_TAG>@<BETA_DIGEST> \
  kora --config /config/kora.toml config validate

docker build -t kora-stable-check .
docker build -t kora-beta-check -f Dockerfile.account-opening.beta .
```

(`config validate` needs a real public key in `payment_address`; the committed placeholder is
refused, so validate after filling it in.) Both must print "Configuration validation
successful". Read the warnings: a new warning is upstream telling you about a new risk.

## 6. Re-run the fork checks

Against a local mainnet fork (Surfpool: `docker run surfpool/surfpool:latest start --network
mainnet --host 0.0.0.0 --no-tui --no-studio --no-deploy`), with throwaway keys:

1. Start the new image built from the Dockerfile against the fork, with `KORA_API_KEY` and
   `KORA_HMAC_SECRET` set, and run `noirwire/scripts/check-deploy.sh` against it with and
   without the secrets. Compare the `INFO` lines with the previous release's.
2. `rpc initialize-atas` and `config validate-with-rpc` (see `noirwire/deploy.md` step 3).
3. The relayed flows and the refusals in `fork-test-runbook.md` section 8: a plain send, a
   send that opens an account, an Earn deposit and withdrawal; then no payment, short payment,
   payment to the wrong wallet, a program off the list, a priority fee, a third signer, the
   fee payer moving its own SOL or tokens.
4. **The rent case, every time:** a relayer-funded create for an account that exists when
   Kora signs and is closed before the transaction lands (`fork-test-runbook.md` section 0).
   Record whether the release charges rent for it. This is the fact the next section turns on.
5. Validate the stable config in both states: as shipped, and with
   `allow_create_account = true` and `max_allowed_lamports = 2200000`.
6. The refill job is independent of the Kora version, but run its tests anyway:
   `cd noirwire/refill && npm ci && npm test`.

Nothing in these checks is sent to mainnet.

## 7. The rule for account opening

Today the stable release ships with account opening off, and may fund account creation only
after "Stage two" in `noirwire/deploy.md`, because only the app's server enforcing a minimum
payment makes it safe (see "The operating rule" in `noirwire/README.md`). That caller-side rule can
be relaxed, and the pre-release variant retired, only when a release meets **all** of these:

1. It is a stable release, not a pre-release.
2. Its commit is at or before the audited-through commit in `audits/AUDIT_STATUS.md`, so the
   rent fix is inside audited code.
3. Step 6.4 on the fork shows it charges rent for a relayer-funded create whether or not the
   account exists at signing.
4. The other fork checks pass with its config.

Until then: stable keeps relying on the caller's rule, and the pre-release stays an opt-in
variant. When all four hold, move `kora/Dockerfile` to that release, carry over any config
keys it needs (the pre-release required `transfer_hook_policy = "allow_all"` for the tracker
mints), delete the `.account-opening.beta` pair, and update the README's warning. Keep the
caller's minimum-payment check in the app anyway: it costs nothing and is a second line.

## 8. Deploy

Deploy to Railway as in `noirwire/deploy.md` step 7, then run `check-deploy.sh` against the
live service (step 9 there).
