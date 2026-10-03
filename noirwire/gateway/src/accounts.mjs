import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { Refusal } from "./errors.mjs";

// What the chain says about the accounts a transaction names. The template check proves the
// shape of the transaction; this proves the accounts are what the shape assumes: classic
// USDC token accounts that exist, the sources owned by the user who signs and holding what
// the transaction moves, and the payment account owned by a wallet of the platform.

const TOKEN_ACCOUNT_BYTES = 165;
const MINT_OFFSET = 0;
const OWNER_OFFSET = 32;
const AMOUNT_OFFSET = 64;
const STATE_OFFSET = 108;
const STATE_INITIALIZED = 1;

/** Owner and balance of a usable classic USDC token account, or null for anything else. */
function readUsdcAccount(account, usdcMint) {
  if (!account || !account.owner?.equals(TOKEN_PROGRAM_ID)) return null;
  const data = Buffer.from(account.data);
  if (data.length !== TOKEN_ACCOUNT_BYTES) return null;
  if (!data.subarray(MINT_OFFSET, MINT_OFFSET + 32).equals(usdcMint.toBuffer())) return null;
  // Uninitialized and frozen accounts cannot move or receive tokens.
  if (data[STATE_OFFSET] !== STATE_INITIALIZED) return null;
  return { owner: new PublicKey(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)), amount: data.readBigUInt64LE(AMOUNT_OFFSET) };
}

/**
 * Why a customer's payment account may not receive our share, as a refusal code, or null.
 * It must be a USDC account owned by one of the platform's payment owners, which come from
 * the operator's environment and never from the customers file. A customer record alone
 * therefore cannot point our share at an account the customer controls.
 */
function paymentAccountProblem(customer, payment, payout, cfg) {
  if (!payment) return "payment_account_invalid";
  if (!cfg.platformPaymentOwners.some((owner) => owner.equals(payment.owner))) return "payment_account_not_platform";
  if (customer.paymentAccount.equals(customer.payoutAccount)) return "payment_account_not_platform";
  if (payout && payout.owner.equals(payment.owner)) return "payment_account_not_platform";
  return null;
}

/**
 * Reads every account once and refuses on the first that is not right. Returns the wallet
 * that owns the customer's payment account, which the relayer must name as its own.
 */
export async function checkAccounts(conn, parsed, customer, cfg) {
  const wanted = [...parsed.sources, parsed.action.destination, customer.paymentAccount, customer.payoutAccount];

  let accounts;
  try {
    accounts = await conn.getMultipleAccountsInfo(wanted, "confirmed");
  } catch {
    throw new Refusal("chain_unavailable", "account_read");
  }
  if (!Array.isArray(accounts) || accounts.length !== wanted.length) throw new Refusal("chain_unavailable", "account_read");
  const read = accounts.map((account) => readUsdcAccount(account, cfg.usdcMint));

  parsed.sources.forEach((_, index) => {
    if (!read[index]) throw new Refusal("source_invalid");
    if (!read[index].owner.equals(parsed.user)) throw new Refusal("source_not_owned_by_user");
  });
  const [recipient, payment, payout] = read.slice(parsed.sources.length);
  if (!recipient) throw new Refusal("recipient_invalid");
  const problem = paymentAccountProblem(customer, payment, payout, cfg);
  if (problem) throw new Refusal(problem);
  if (parsed.customerPayment && !payout) throw new Refusal("payout_account_invalid");

  // Each source must hold everything the transaction takes out of it. This is the balance
  // as it is now: it does not stop the user from moving it away before the transaction lands.
  const transfers = [parsed.action, parsed.platformPayment, parsed.customerPayment].filter(Boolean);
  parsed.sources.forEach((source, index) => {
    const needed = transfers.filter((transfer) => transfer.source.equals(source)).reduce((sum, transfer) => sum + transfer.amount, 0n);
    if (read[index].amount < needed) throw new Refusal("insufficient_balance");
  });

  return { paymentOwner: payment.owner };
}

/**
 * At start: every customer's payment account as the chain shows it. Returns what is wrong,
 * naming customers by id and never an address. A chain that cannot be read is a problem
 * too: a gateway that cannot vouch for where our share goes does not start.
 */
export async function paymentAccountProblems(conn, cfg) {
  const problems = [];
  for (const customer of cfg.customers.list) {
    let accounts;
    try {
      accounts = await conn.getMultipleAccountsInfo([customer.paymentAccount, customer.payoutAccount], "confirmed");
    } catch {
      accounts = null;
    }
    if (!Array.isArray(accounts) || accounts.length !== 2) {
      problems.push("RPC_URL: the chain could not be read to check the customers' payment accounts");
      break;
    }
    const [payment, payout] = accounts.map((account) => readUsdcAccount(account, cfg.usdcMint));
    const problem = paymentAccountProblem(customer, payment, payout, cfg);
    if (problem === "payment_account_invalid") problems.push(`customer ${customer.id}: paymentAccount does not exist or is not a USDC token account`);
    else if (problem) problems.push(`customer ${customer.id}: paymentAccount is not owned by a platform payment owner, or shares its owner with payoutAccount`);
  }
  return problems;
}
