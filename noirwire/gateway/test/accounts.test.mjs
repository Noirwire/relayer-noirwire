import assert from "node:assert/strict";
import { test } from "node:test";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { checkAccounts } from "../src/accounts.mjs";
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

test("the payout account is only read when the transaction pays into it", async () => {
  const world = worldWith("payoutAccount", null);
  await run(world, usdcTransfer(world, { platform: 1_600n, customer: 0n }));
});

test("refuses when the chain cannot be read", async () => {
  const world = makeWorld();
  world.conn.options.failReads = true;
  await refuses(world, "chain_unavailable");
});
