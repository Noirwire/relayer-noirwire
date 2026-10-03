import { ASSOCIATED_TOKEN_PROGRAM_ID, createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Refusal } from "./errors.mjs";

// The one template, "usdc-transfer": what a transaction must look like before this gateway
// lets a customer's relayer pay for it. Everything here is read from the bytes alone; what
// the chain says about the accounts is checked in accounts.mjs, the amounts against the
// quote in checkPayments below.
//
// Allowed, and nothing else:
//   - at most one SetComputeUnitLimit and one SetComputeUnitPrice, both under the caps;
//   - one TransferChecked of USDC, the user's action;
//   - one TransferChecked of USDC to the customer's payment account;
//   - at most one TransferChecked of USDC to the customer's payout account.

export const TEMPLATE = "usdc-transfer";
export const USDC_DECIMALS = 6;
/** The largest serialized transaction a Solana packet carries. */
export const MAX_TRANSACTION_BYTES = 1232;

const FEE_PAYER_INDEX = 0;
const USER_INDEX = 1;

// ComputeBudget instruction tags and their exact lengths.
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
// SPL Token instruction tags.
const TOKEN_TRANSFER_CHECKED = 12;
const TOKEN_ACCOUNT_CREATION = new Set([1, 16, 18, 20]); // InitializeAccount, 2, 3, InitializeImmutableOwner
const TOKEN_DELEGATION = new Set([4, 5, 13]); // Approve, Revoke, ApproveChecked
const TOKEN_SET_AUTHORITY = 6;
const TOKEN_CLOSE_ACCOUNT = 9;
// System instruction tags (u32 little endian).
const SYSTEM_ACCOUNT_CREATION = new Set([0, 3]); // CreateAccount, CreateAccountWithSeed
const SYSTEM_NONCE = new Set([4, 5, 6, 7, 12]); // Advance, Withdraw, Initialize, Authorize, Upgrade

/**
 * Bytes to a transaction, or a refusal. The bytes must be the canonical encoding of what
 * they decode to, so nothing can ride along after the transaction or hide in a loose
 * length prefix.
 */
export function decodeTransaction(bytes) {
  if (bytes.length > MAX_TRANSACTION_BYTES) throw new Refusal("oversize_transaction");
  let transaction;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
    if (!Buffer.from(transaction.serialize()).equals(Buffer.from(bytes))) throw new Error("not canonical");
  } catch {
    throw new Refusal("malformed_transaction");
  }
  return transaction;
}

function readComputeBudget(data, seen, cfg) {
  const view = Buffer.from(data);
  if (view[0] === SET_COMPUTE_UNIT_LIMIT && view.length === 5 && seen.limit === null) {
    seen.limit = BigInt(view.readUInt32LE(1));
    if (seen.limit > BigInt(cfg.computeUnitLimit)) throw new Refusal("compute_limit_above_cap");
    return;
  }
  if (view[0] === SET_COMPUTE_UNIT_PRICE && view.length === 9 && seen.price === null) {
    seen.price = view.readBigUInt64LE(1);
    if (seen.price > cfg.maxPriorityMicroLamports) throw new Refusal("priority_fee_above_cap");
    return;
  }
  throw new Refusal("compute_budget_not_allowed");
}

function refuseSystem(data) {
  const tag = data.length >= 4 ? Buffer.from(data).readUInt32LE(0) : -1;
  if (SYSTEM_NONCE.has(tag)) throw new Refusal("durable_nonce_not_allowed");
  if (SYSTEM_ACCOUNT_CREATION.has(tag)) throw new Refusal("account_creation_not_allowed");
  throw new Refusal("program_not_allowed");
}

function readTransfer(instruction, keys, cfg) {
  const data = Buffer.from(instruction.data);
  const tag = data[0];
  if (TOKEN_ACCOUNT_CREATION.has(tag)) throw new Refusal("account_creation_not_allowed");
  if (TOKEN_DELEGATION.has(tag)) throw new Refusal("delegate_not_allowed");
  if (tag === TOKEN_SET_AUTHORITY) throw new Refusal("authority_change_not_allowed");
  if (tag === TOKEN_CLOSE_ACCOUNT) throw new Refusal("close_account_not_allowed");
  // Exactly source, mint, destination, authority: a fifth account would be a multisig signer.
  if (tag !== TOKEN_TRANSFER_CHECKED || data.length !== 10 || instruction.accountKeyIndexes.length !== 4) {
    throw new Refusal("token_instruction_not_allowed");
  }
  const [source, mint, destination, authority] = instruction.accountKeyIndexes;
  if (!keys[mint].equals(cfg.usdcMint) || data[9] !== USDC_DECIMALS) throw new Refusal("wrong_mint");
  if (authority !== USER_INDEX) throw new Refusal("wrong_authority");
  if (source === destination) throw new Refusal("recipient_not_allowed");
  return { source: keys[source], destination: keys[destination], amount: data.readBigUInt64LE(1) };
}

/**
 * Every structural rule of the template, from scratch. Returns what the transaction does,
 * for the account, cost and payment checks that follow.
 */
export function inspect(transaction, customer, cfg) {
  const message = transaction.message;
  if (message.version !== "legacy" && message.version !== 0) throw new Refusal("unsupported_version");
  if (message.addressTableLookups.length > 0) throw new Refusal("lookup_tables_not_allowed");

  const keys = message.staticAccountKeys;
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) throw new Refusal("malformed_transaction");
  if (!keys[FEE_PAYER_INDEX]?.equals(customer.feePayer)) throw new Refusal("wrong_fee_payer");
  if (message.header.numRequiredSignatures !== 2 || transaction.signatures.length !== 2) {
    throw new Refusal("unexpected_signers");
  }
  // The user only authorises token transfers, so nothing may mark it writable.
  if (message.isAccountWritable(USER_INDEX)) throw new Refusal("user_writable");

  const budget = { limit: null, price: null };
  const transfers = [];
  for (const instruction of message.compiledInstructions) {
    // The fee payer pays the fee and does nothing else: not an account of any instruction,
    // signer or not, writable or not, and not a program.
    if (instruction.programIdIndex === FEE_PAYER_INDEX || instruction.accountKeyIndexes.includes(FEE_PAYER_INDEX)) {
      throw new Refusal("fee_payer_misused");
    }
    const program = keys[instruction.programIdIndex];
    if (!program) throw new Refusal("malformed_transaction");
    if (instruction.accountKeyIndexes.some((index) => index >= keys.length)) throw new Refusal("malformed_transaction");

    if (program.equals(ComputeBudgetProgram.programId)) {
      if (instruction.accountKeyIndexes.length !== 0) throw new Refusal("compute_budget_not_allowed");
      readComputeBudget(instruction.data, budget, cfg);
    } else if (program.equals(TOKEN_PROGRAM_ID)) {
      transfers.push(readTransfer(instruction, keys, cfg));
    } else if (program.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Refusal("token_2022_not_allowed");
    } else if (program.equals(SystemProgram.programId)) {
      refuseSystem(instruction.data);
    } else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      throw new Refusal("account_creation_not_allowed");
    } else {
      throw new Refusal("program_not_allowed");
    }
  }
  // Without a limit the runtime picks one itself and the priority fee is no longer a number
  // read from the transaction.
  if (budget.price !== null && budget.price > 0n && budget.limit === null) throw new Refusal("compute_budget_not_allowed");

  const to = (account) => transfers.filter((transfer) => transfer.destination.equals(account));
  const platformPayments = to(customer.paymentAccount);
  const customerPayments = to(customer.payoutAccount);
  const actions = transfers.filter(
    (transfer) => !transfer.destination.equals(customer.paymentAccount) && !transfer.destination.equals(customer.payoutAccount),
  );
  if (actions.length !== 1 || actions[0].amount === 0n) throw new Refusal("action_mismatch");
  if (platformPayments.length !== 1 || customerPayments.length > 1) throw new Refusal("payment_mismatch");

  return {
    user: keys[USER_INDEX],
    signatures: message.header.numRequiredSignatures,
    computeUnitLimit: budget.limit ?? 0n,
    computeUnitPrice: budget.price ?? 0n,
    action: actions[0],
    platformPayment: platformPayments[0],
    customerPayment: customerPayments[0] ?? null,
    sources: [...new Map(transfers.map((transfer) => [transfer.source.toBase58(), transfer.source])).values()],
  };
}

/**
 * Exact amounts, no extras: B + S to our payment account, C to the customer's payout
 * account, and no payout transfer at all when C is zero.
 */
export function checkPayments(parsed, split) {
  if (parsed.platformPayment.amount !== split.platform) throw new Refusal("payment_mismatch", "platform_amount");
  if (split.customer === 0n) {
    if (parsed.customerPayment) throw new Refusal("payment_mismatch", "payout_not_expected");
  } else if (!parsed.customerPayment || parsed.customerPayment.amount !== split.customer) {
    throw new Refusal("payment_mismatch", "customer_amount");
  }
}

/**
 * The transaction this gateway hands out: the action, then the payment transfers, with the
 * customer's relayer as fee payer. ComputeBudget instructions are present only when the
 * client asked for a priority fee.
 */
export function buildTransaction({ customer, cfg, user, source, recipient, amount, priorityMicroLamports, platform, customerAmount, blockhash }) {
  const transfer = (destination, units) =>
    createTransferCheckedInstruction(source, cfg.usdcMint, destination, user, units, USDC_DECIMALS);
  const instructions = [];
  if (priorityMicroLamports > 0n) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }));
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));
  }
  instructions.push(transfer(recipient, amount));
  instructions.push(transfer(customer.paymentAccount, platform));
  if (customerAmount > 0n) instructions.push(transfer(customer.payoutAccount, customerAmount));
  const message = new TransactionMessage({ payerKey: customer.feePayer, recentBlockhash: blockhash, instructions });
  return new VersionedTransaction(message.compileToV0Message());
}
