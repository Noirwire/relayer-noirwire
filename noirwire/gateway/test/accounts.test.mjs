import assert from "node:assert/strict";
import { test } from "node:test";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { checkAccounts, paymentAccountProblems } from "../src/accounts.mjs";
import { inspect } from "../src/template.mjs";
import { makeWorld, tokenAccount, transactionOf, transfer, usdcTransfer, USDC } from "./helpers.mjs";

const other = () => Keypair.generate().publicKey;
const run = (world, transaction = usdcTransfer(world)) =>
  checkAccounts(world.conn, inspect(transaction, world.customer, world.cfg), world.customer, world.cfg);
const refuses = (world, code, transaction) => assert.rejects(run(world, transaction), (error) => error.code === code);
/** A world with one account replaced (or removed, with null). */
function worldWith(name, account) {
  const world = makeWorld();
  if (account === null) world.accounts.delete(world[name].toBase58());
  else world.accounts.set(world[name].toBase58(), account);
  return world;
}

test("accepts real USDC accounts and reports who owns the payment account", async () => {
  const world = makeWorld();
  const { paymentOwner } = await run(world);
  assert.ok(paymentOwner.equals(world.paymentWallet.publicKey));
  assert.equal(world.conn.count("getMultipleAccountsInfo"), 1);
});

test("refuses a source account that is not owned by the signing user", async () => {
  await refuses(worldWith("userUsdc", tokenAccount(USDC, other())), "source_not_owned_by_user");
  // Someone else's account as the source, with the user as mere authority (a delegate's view).
  const world = makeWorld();
  const victim = Keypair.generate().publicKey;
  const victimUsdc = getAssociatedTokenAddressSync(USDC, victim);
  world.accounts.set(victimUsdc.toBase58(), tokenAccount(USDC, victim));
  const transaction = transactionOf(world, [
    transfer(world, world.recipientUsdc, 5_000_000n, { source: victimUsdc }),
    transfer(world, world.paymentAccount, 1_760n),
    transfer(world, world.payoutAccount, 640n),
  ]);
  await refuses(world, "source_not_owned_by_user", transaction);
});

test("every source is checked, not only the action's", async () => {
  const world = makeWorld();
  const victimUsdc = getAssociatedTokenAddressSync(USDC, Keypair.generate().publicKey);
  world.accounts.set(victimUsdc.toBase58(), tokenAccount(USDC, other()));
  const transaction = transactionOf(world, [
    transfer(world, world.recipientUsdc, 5_000_000n),
    transfer(world, world.paymentAccount, 1_760n, { source: victimUsdc }),
    transfer(world, world.payoutAccount, 640n),
  ]);
  await refuses(world, "source_not_owned_by_user", transaction);
});

test("refuses a source that does not exist or is not a USDC token account", async () => {
  await refuses(worldWith("userUsdc", null), "source_invalid");
  await refuses(worldWith("userUsdc", { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1 }), "source_invalid");
  const world = makeWorld();
  await refuses(worldWith("userUsdc", tokenAccount(other(), world.user.publicKey)), "source_invalid");
  await refuses(worldWith("userUsdc", tokenAccount(USDC, world.user.publicKey, { program: TOKEN_2022_PROGRAM_ID })), "source_invalid");
  await refuses(worldWith("userUsdc", tokenAccount(USDC, world.user.publicKey, { state: 2 })), "source_invalid");
  await refuses(worldWith("userUsdc", tokenAccount(USDC, world.user.publicKey, { state: 0 })), "source_invalid");
});

test("refuses a recipient that does not exist or is not a USDC token account", async () => {
  await refuses(worldWith("recipientUsdc", null), "recipient_invalid");
  // A wallet address given where a token account belongs.
  await refuses(worldWith("recipientUsdc", { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1 }), "recipient_invalid");
  await refuses(worldWith("recipientUsdc", tokenAccount(other(), other())), "recipient_invalid");
  await refuses(worldWith("recipientUsdc", tokenAccount(USDC, other(), { program: TOKEN_2022_PROGRAM_ID })), "recipient_invalid");
  await refuses(worldWith("recipientUsdc", { ...tokenAccount(USDC, other()), data: Buffer.alloc(82) }), "recipient_invalid");
});

test("refuses a payment or payout account that does not exist or is not a USDC token account", async () => {
  await refuses(worldWith("paymentAccount", null), "payment_account_invalid");
  await refuses(worldWith("paymentAccount", tokenAccount(other(), other())), "payment_account_invalid");
  await refuses(worldWith("payoutAccount", null), "payout_account_invalid");
  await refuses(worldWith("payoutAccount", tokenAccount(USDC, other(), { state: 2 })), "payout_account_invalid");
});

test("the payout account need only exist when the transaction pays into it", async () => {
  const world = worldWith("payoutAccount", null);
  await run(world, usdcTransfer(world, { platform: 1_600n, customer: 0n }));
});

test("refuses when the chain cannot be read", async () => {
  const world = makeWorld();
  world.conn.options.failReads = true;
  await refuses(world, "chain_unavailable");
});

// ── Our share goes to an account the platform owns ──────────────────────────────────────

test("refuses a payment account whose owner is not a platform payment owner", async () => {
  // A valid USDC account, owned by a wallet that is not ours.
  await refuses(worldWith("paymentAccount", tokenAccount(USDC, other())), "payment_account_not_platform");
  // The customer names its own payout wallet's account as the payment account.
  const world = makeWorld();
  world.accounts.set(world.paymentAccount.toBase58(), tokenAccount(USDC, world.payoutWallet.publicKey));
  await refuses(world, "payment_account_not_platform");
});

test("accepts any of the configured platform payment owners", async () => {
  const world = makeWorld();
  const second = Keypair.generate().publicKey;
  world.accounts.set(world.paymentAccount.toBase58(), tokenAccount(USDC, second));
  const cfg = { ...world.cfg, platformPaymentOwners: [world.paymentWallet.publicKey, second] };
  const { paymentOwner } = await checkAccounts(world.conn, inspect(usdcTransfer(world), world.customer, cfg), world.customer, cfg);
  assert.ok(paymentOwner.equals(second));
});

test("refuses a payment account that shares its owner with the payout account, even a platform owner", async () => {
  // The operator's list wrongly holds the customer's payout wallet.
  const world = makeWorld();
  world.accounts.set(world.paymentAccount.toBase58(), tokenAccount(USDC, world.payoutWallet.publicKey));
  const cfg = { ...world.cfg, platformPaymentOwners: [world.payoutWallet.publicKey] };
  const run = (transaction) => checkAccounts(world.conn, inspect(transaction, world.customer, cfg), world.customer, cfg);
  await assert.rejects(run(usdcTransfer(world)), (error) => error.code === "payment_account_not_platform");
  // Also when this transaction pays nothing into the payout account.
  await assert.rejects(run(usdcTransfer(world, { platform: 1_600n, customer: 0n })), (error) => error.code === "payment_account_not_platform");
});

test("refuses a customer whose payment account is its payout account, whatever the configuration let through", async () => {
  const world = makeWorld();
  const customer = { ...world.customer, payoutAccount: world.customer.paymentAccount };
  const parsed = inspect(usdcTransfer(world, { platform: 1_600n, customer: 0n }), world.customer, world.cfg);
  await assert.rejects(checkAccounts(world.conn, parsed, customer, world.cfg), (error) => error.code === "payment_account_not_platform");
});

test("refuses a source that does not hold what the transaction takes out of it", async () => {
  // 5,000,000 to the recipient, 1,760 and 640 in payments.
  await refuses(worldWith("userUsdc", tokenAccount(USDC, makeWorld().user.publicKey, { amount: 0n })), "source_not_owned_by_user");
  const world = makeWorld();
  world.accounts.set(world.userUsdc.toBase58(), tokenAccount(USDC, world.user.publicKey, { amount: 5_002_399n }));
  await refuses(world, "insufficient_balance");
  world.accounts.set(world.userUsdc.toBase58(), tokenAccount(USDC, world.user.publicKey, { amount: 5_002_400n }));
  await run(world);
});

test("at start: every customer's payment account is checked against the chain", async () => {
  const world = makeWorld();
  assert.deepEqual(await paymentAccountProblems(world.conn, world.cfg), []);
  // A payout account that does not exist yet is not a reason to refuse to start.
  const withoutPayout = worldWith("payoutAccount", null);
  assert.deepEqual(await paymentAccountProblems(withoutPayout.conn, withoutPayout.cfg), []);

  const problemsOf = async (name, account) => {
    const changed = worldWith(name, account);
    const problems = await paymentAccountProblems(changed.conn, changed.cfg);
    assert.equal(problems.length, 1);
    // A customer is named by its id, never by an address.
    for (const key of [changed.paymentAccount, changed.payoutAccount, changed.paymentWallet.publicKey]) assert.ok(!problems[0].includes(key.toBase58()));
    return problems[0];
  };
  assert.match(await problemsOf("paymentAccount", tokenAccount(USDC, other())), /^customer acme: paymentAccount is not owned by a platform payment owner/);
  assert.match(await problemsOf("paymentAccount", null), /^customer acme: paymentAccount does not exist or is not a USDC token account/);
  assert.match(await problemsOf("paymentAccount", tokenAccount(other(), world.paymentWallet.publicKey)), /not a USDC token account/);

  world.conn.options.failReads = true;
  assert.match((await paymentAccountProblems(world.conn, world.cfg))[0], /^RPC_URL: the chain could not be read/);
});
