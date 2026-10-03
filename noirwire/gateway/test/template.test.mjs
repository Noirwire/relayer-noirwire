import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  createApproveCheckedInstruction,
  createApproveInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createRevokeInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Refusal } from "../src/errors.mjs";
import { splitFor } from "../src/split.mjs";
import { buildTransaction, checkPayments, decodeTransaction, inspect } from "../src/template.mjs";
import { BLOCKHASH, makeWorld, transactionOf, transfer, usdcTransfer, USDC } from "./helpers.mjs";

const world = makeWorld();
const { customer, cfg } = world;
const user = world.user.publicKey;
const other = () => Keypair.generate().publicKey;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Runs a transaction through the wire form and the template, as /v1/sign does. */
const check = (transaction) => inspect(decodeTransaction(transaction.serialize()), customer, cfg);
const refuses = (transaction, code) =>
  assert.throws(() => check(transaction), (error) => {
    assert.ok(error instanceof Refusal, `threw ${error}`);
    assert.equal(error.code, code);
    return true;
  });
/** The honest transaction with one more instruction. */
const withExtra = (...instructions) => usdcTransfer(world, { after: instructions });
const raw = (programId, keys, data) => new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
const account = (pubkey, { signer = false, writable = false } = {}) => ({ pubkey, isSigner: signer, isWritable: writable });
const limit = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const price = (microLamports) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

test("accepts the template: action, platform payment, customer payment", () => {
  const parsed = check(usdcTransfer(world));
  assert.ok(parsed.user.equals(user));
  assert.equal(parsed.signatures, 2);
  assert.equal(parsed.action.amount, 5_000_000n);
  assert.ok(parsed.action.destination.equals(world.recipientUsdc));
  assert.equal(parsed.platformPayment.amount, 1_760n);
  assert.equal(parsed.customerPayment.amount, 640n);
  assert.equal(parsed.computeUnitLimit, 0n);
  assert.equal(parsed.computeUnitPrice, 0n);
  assert.deepEqual(parsed.sources.map(String), [world.userUsdc.toBase58()]);
});

test("accepts it as a legacy transaction, in any instruction order, with a priority fee", () => {
  check(usdcTransfer(world, { legacy: true }));
  const shuffled = transactionOf(world, [
    transfer(world, world.payoutAccount, 640n),
    price(1_000n),
    transfer(world, world.paymentAccount, 1_760n),
    transfer(world, world.recipientUsdc, 5_000_000n),
    limit(30_000),
  ]);
  const parsed = check(shuffled);
  assert.equal(parsed.computeUnitLimit, 30_000n);
  assert.equal(parsed.computeUnitPrice, 1_000n);
});

test("accepts no customer payment at all", () => {
  assert.equal(check(usdcTransfer(world, { customer: 0n })).customerPayment, null);
});

test("what prepare builds is what the template accepts", () => {
  const build = (priorityMicroLamports) =>
    buildTransaction({ customer, cfg, user, source: world.userUsdc, recipient: world.recipientUsdc, amount: 9n, priorityMicroLamports, platform: 1_760n, customerAmount: 640n, blockhash: BLOCKHASH });
  assert.equal(build(0n).message.compiledInstructions.length, 3);
  const withFee = check(build(250n));
  assert.equal(withFee.computeUnitLimit, BigInt(cfg.computeUnitLimit));
  assert.equal(withFee.computeUnitPrice, 250n);
  assert.ok(build(0n).message.staticAccountKeys[0].equals(customer.feePayer));
});

test("refuses an oversize transaction", () => {
  const many = Array.from({ length: 50 }, () => transfer(world, world.recipientUsdc, 1n));
  const transaction = usdcTransfer(world, { after: many });
  assert.ok(transaction.serialize().length > 1232);
  refuses(transaction, "oversize_transaction");
  // The size is judged before anything is parsed.
  assert.throws(() => decodeTransaction(Buffer.alloc(1233)), (error) => error.code === "oversize_transaction");
});

test("refuses bytes that are not a transaction, or not canonical", () => {
  const malformed = (bytes) => assert.throws(() => decodeTransaction(bytes), (error) => error instanceof Refusal && error.code === "malformed_transaction");
  malformed(Buffer.from("not a transaction"));
  malformed(Buffer.alloc(0));
  // One byte riding along after a valid transaction.
  malformed(Buffer.concat([usdcTransfer(world).serialize(), Buffer.from([0])]));
  // Cut short.
  malformed(usdcTransfer(world).serialize().subarray(0, 200));
});

test("refuses a message version other than legacy or v0", () => {
  const transaction = decodeTransaction(usdcTransfer(world).serialize());
  const future = { signatures: transaction.signatures, message: new Proxy(transaction.message, { get: (target, name) => (name === "version" ? 1 : Reflect.get(target, name)) }) };
  assert.throws(() => inspect(future, customer, cfg), (error) => error.code === "unsupported_version");
});

test("refuses address lookup tables", () => {
  const table = new AddressLookupTableAccount({
    key: other(),
    state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [world.recipientUsdc] },
  });
  const transaction = usdcTransfer(world, { lookupTables: [table] });
  assert.equal(transaction.message.addressTableLookups.length, 1);
  refuses(transaction, "lookup_tables_not_allowed");
});

test("refuses a fee payer that is not this customer's", () => {
  refuses(usdcTransfer(world, { payer: other() }), "wrong_fee_payer");
  // The user paying for itself is not a relayed transaction either.
  refuses(usdcTransfer(world, { payer: user }), "wrong_fee_payer");
});

test("refuses more signers than the fee payer and the one user", () => {
  // A second authority that has to sign.
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n, { authority: other() })), "unexpected_signers");
  // A multisig co-signer on the action.
  const cosigned = transfer(world, world.recipientUsdc, 5n);
  cosigned.keys.push(account(other(), { signer: true }));
  refuses(transactionOf(world, [cosigned, transfer(world, world.paymentAccount, 1_760n)]), "unexpected_signers");
});

test("refuses fewer signers: a transaction no user signs", () => {
  refuses(transactionOf(world, [limit(1_000)]), "unexpected_signers");
});

test("refuses a user that is writable", () => {
  // The user's wallet named as a transfer destination makes the signer writable.
  refuses(withExtra(transfer(world, user, 1n)), "user_writable");
});

test("refuses the fee payer anywhere but as fee payer", () => {
  const feePayer = customer.feePayer;
  // As the authority (a signer) of a transfer.
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n, { authority: feePayer })), "fee_payer_misused");
  // As a writable source, as a writable destination, and merely read.
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n, { source: feePayer })), "fee_payer_misused");
  refuses(withExtra(transfer(world, feePayer, 1n)), "fee_payer_misused");
  refuses(withExtra(raw(TOKEN_PROGRAM_ID, [account(world.userUsdc, { writable: true }), account(feePayer), account(world.recipientUsdc, { writable: true }), account(user, { signer: true })], [12, 1, 0, 0, 0, 0, 0, 0, 0, 6])), "fee_payer_misused");
  // In an instruction of a program that would otherwise be refused for itself.
  refuses(withExtra(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: other(), lamports: 1 })), "fee_payer_misused");
});

test("refuses any other program", () => {
  refuses(withExtra(raw(MEMO, [], "hello")), "program_not_allowed");
  refuses(withExtra(raw(other(), [account(world.userUsdc, { writable: true })], [1, 2, 3])), "program_not_allowed");
  // System transfer (tag 2), allocate (8) and assign (1): no SOL moves through this gateway.
  for (const tag of [1, 2, 8]) refuses(withExtra(raw(SystemProgram.programId, [account(other(), { writable: true })], [tag, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "program_not_allowed");
});

test("refuses Token-2022", () => {
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n, { program: TOKEN_2022_PROGRAM_ID })), "token_2022_not_allowed");
  // Also as the program of the action itself.
  refuses(transactionOf(world, [transfer(world, world.recipientUsdc, 5n, { program: TOKEN_2022_PROGRAM_ID }), transfer(world, world.paymentAccount, 1_760n)]), "token_2022_not_allowed");
});

test("refuses durable nonces", () => {
  const advance = SystemProgram.nonceAdvance({ noncePubkey: other(), authorizedPubkey: user });
  refuses(usdcTransfer(world, { before: [advance] }), "durable_nonce_not_allowed");
  refuses(usdcTransfer(world, { before: [advance], legacy: true }), "durable_nonce_not_allowed");
});

test("refuses account creation", () => {
  // An associated token account, whoever would fund it.
  refuses(withExtra(raw(ASSOCIATED_TOKEN_PROGRAM_ID, [account(other(), { writable: true }), account(other(), { writable: true }), account(other()), account(USDC), account(SystemProgram.programId), account(TOKEN_PROGRAM_ID)], [1])), "account_creation_not_allowed");
  // A token account initialised in place.
  refuses(withExtra(createInitializeAccount3Instruction(other(), USDC, user)), "account_creation_not_allowed");
  // System CreateAccount (tag 0) and CreateAccountWithSeed (tag 3).
  for (const tag of [0, 3]) refuses(withExtra(raw(SystemProgram.programId, [account(other(), { writable: true })], [tag, 0, 0, 0, 1, 1, 1, 1])), "account_creation_not_allowed");
});

test("refuses delegate changes", () => {
  refuses(withExtra(createApproveInstruction(world.userUsdc, other(), user, 1_000_000n)), "delegate_not_allowed");
  refuses(withExtra(createApproveCheckedInstruction(world.userUsdc, USDC, other(), user, 1_000_000n, 6)), "delegate_not_allowed");
  refuses(withExtra(createRevokeInstruction(world.userUsdc, user)), "delegate_not_allowed");
});

test("refuses authority changes, close authority included", () => {
  refuses(withExtra(createSetAuthorityInstruction(world.userUsdc, user, AuthorityType.CloseAccount, other())), "authority_change_not_allowed");
  refuses(withExtra(createSetAuthorityInstruction(world.userUsdc, user, AuthorityType.AccountOwner, other())), "authority_change_not_allowed");
});

test("refuses closing an account", () => {
  refuses(withExtra(createCloseAccountInstruction(world.userUsdc, world.recipientUsdc, user)), "close_account_not_allowed");
});

test("refuses every other token instruction", () => {
  // The unchecked transfer names no mint, so it cannot be proven to be USDC.
  refuses(withExtra(createTransferInstruction(world.userUsdc, world.recipientUsdc, user, 1n)), "token_instruction_not_allowed");
  refuses(withExtra(createBurnInstruction(world.userUsdc, USDC, user, 1n)), "token_instruction_not_allowed");
  // TransferChecked with a fifth account, and with trailing data.
  const fifth = transfer(world, world.recipientUsdc, 1n);
  fifth.keys.push(account(other()));
  refuses(withExtra(fifth), "token_instruction_not_allowed");
  const padded = transfer(world, world.recipientUsdc, 1n);
  padded.data = Buffer.concat([padded.data, Buffer.from([0])]);
  refuses(withExtra(padded), "token_instruction_not_allowed");
  refuses(withExtra(raw(TOKEN_PROGRAM_ID, [], [])), "token_instruction_not_allowed");
});

test("refuses ComputeBudget instructions other than one limit and one price", () => {
  refuses(usdcTransfer(world, { before: [limit(20_000), limit(20_000)] }), "compute_budget_not_allowed");
  refuses(usdcTransfer(world, { before: [limit(20_000), price(1n), price(2n)] }), "compute_budget_not_allowed");
  refuses(usdcTransfer(world, { before: [ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 })] }), "compute_budget_not_allowed");
  refuses(usdcTransfer(world, { before: [raw(ComputeBudgetProgram.programId, [], [4, 0, 0, 1, 0])] }), "compute_budget_not_allowed");
  // A limit with trailing bytes, and one that names an account.
  refuses(usdcTransfer(world, { before: [raw(ComputeBudgetProgram.programId, [], [2, 1, 0, 0, 0, 0])] }), "compute_budget_not_allowed");
  refuses(usdcTransfer(world, { before: [raw(ComputeBudgetProgram.programId, [account(world.userUsdc)], [2, 1, 0, 0, 0])] }), "compute_budget_not_allowed");
});

test("refuses a priority fee without a compute unit limit", () => {
  refuses(usdcTransfer(world, { before: [price(1_000n)] }), "compute_budget_not_allowed");
  // A price of zero asks for no priority fee and needs no limit.
  check(usdcTransfer(world, { before: [price(0n)] }));
});

test("refuses a compute unit limit above the cap, and accepts the cap", () => {
  check(usdcTransfer(world, { before: [limit(cfg.computeUnitLimit)] }));
  refuses(usdcTransfer(world, { before: [limit(cfg.computeUnitLimit + 1)] }), "compute_limit_above_cap");
  refuses(usdcTransfer(world, { before: [limit(1_400_000)] }), "compute_limit_above_cap");
});

test("refuses a priority fee above the cap, and accepts the cap", () => {
  check(usdcTransfer(world, { before: [limit(30_000), price(cfg.maxPriorityMicroLamports)] }));
  refuses(usdcTransfer(world, { before: [limit(30_000), price(cfg.maxPriorityMicroLamports + 1n)] }), "priority_fee_above_cap");
  refuses(usdcTransfer(world, { before: [limit(30_000), price(2n ** 64n - 1n)] }), "priority_fee_above_cap");
});

test("refuses a transfer of anything but USDC", () => {
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n, { mint: other() })), "wrong_mint");
  refuses(transactionOf(world, [transfer(world, world.recipientUsdc, 5n, { mint: other() }), transfer(world, world.paymentAccount, 1_760n)]), "wrong_mint");
  // The right mint with the wrong decimals is not the USDC the template means.
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n, { decimals: 9 })), "wrong_mint");
});

test("refuses a transfer the user does not authorise", () => {
  // Authority is some other account that does not sign (a delegate, in effect).
  const delegated = raw(TOKEN_PROGRAM_ID, [account(world.userUsdc, { writable: true }), account(USDC), account(world.recipientUsdc, { writable: true }), account(other())], [12, 1, 0, 0, 0, 0, 0, 0, 0, 6]);
  refuses(withExtra(delegated), "wrong_authority");
});

test("refuses a transfer from an account to itself", () => {
  refuses(withExtra(transfer(world, world.userUsdc, 1n)), "recipient_not_allowed");
});

test("refuses anything but exactly one action", () => {
  // None: only the payments.
  refuses(transactionOf(world, [transfer(world, world.paymentAccount, 1_760n), transfer(world, world.payoutAccount, 640n)]), "action_mismatch");
  // Two, to the same or to different recipients.
  refuses(withExtra(transfer(world, world.recipientUsdc, 1n)), "action_mismatch");
  refuses(withExtra(transfer(world, other(), 1n)), "action_mismatch");
  // One that moves nothing.
  refuses(usdcTransfer(world, { amount: 0n }), "action_mismatch");
});

test("refuses a missing or repeated payment transfer", () => {
  refuses(transactionOf(world, [transfer(world, world.recipientUsdc, 5n), transfer(world, world.payoutAccount, 640n)]), "payment_mismatch");
  refuses(withExtra(transfer(world, world.paymentAccount, 1n)), "payment_mismatch");
  refuses(withExtra(transfer(world, world.payoutAccount, 1n)), "payment_mismatch");
});

test("the payments must be exact: B + S to us, C to the customer", () => {
  const split = splitFor(1_600n, 5_000); // platform 1,760, customer 640
  const mismatch = (amounts) => assert.throws(() => checkPayments(check(usdcTransfer(world, amounts)), split), (error) => error.code === "payment_mismatch");
  checkPayments(check(usdcTransfer(world, { platform: 1_760n, customer: 640n })), split);
  mismatch({ platform: 1_759n, customer: 640n });
  // Overpaying us is refused too: exact means exact.
  mismatch({ platform: 1_761n, customer: 640n });
  mismatch({ platform: 1_760n, customer: 639n });
  mismatch({ platform: 1_760n, customer: 641n });
  mismatch({ platform: 1_760n, customer: 0n });
  mismatch({ platform: 640n, customer: 1_760n });
});

test("when the customer share is zero the payout transfer must be absent", () => {
  const split = splitFor(1_600n, 0);
  checkPayments(check(usdcTransfer(world, { platform: 1_600n, customer: 0n })), split);
  assert.throws(() => checkPayments(check(usdcTransfer(world, { platform: 1_600n, customer: 1n })), split), (error) => error.code === "payment_mismatch");
});
