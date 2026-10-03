import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { Refusal } from "./errors.mjs";

// What the chain says about the accounts a transaction names. The template check proves the
// shape of the transaction; this proves the accounts are what the shape assumes: classic
// USDC token accounts that exist, the sources owned by the user who signs.

const TOKEN_ACCOUNT_BYTES = 165;
const MINT_OFFSET = 0;
const OWNER_OFFSET = 32;
const STATE_OFFSET = 108;
const STATE_INITIALIZED = 1;

/** The wallet that owns a usable classic USDC token account, or null for anything else. */
function usdcAccountOwner(account, usdcMint) {
  if (!account || !account.owner?.equals(TOKEN_PROGRAM_ID)) return null;
  const data = Buffer.from(account.data);
  if (data.length !== TOKEN_ACCOUNT_BYTES) return null;
  if (!data.subarray(MINT_OFFSET, MINT_OFFSET + 32).equals(usdcMint.toBuffer())) return null;
  // Uninitialized and frozen accounts cannot move or receive tokens.
  if (data[STATE_OFFSET] !== STATE_INITIALIZED) return null;
  return new PublicKey(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32));
}

/**
 * Reads every account once and refuses on the first that is not right. Returns the wallet
 * that owns the customer's payment account, which the relayer must name as its own.
 */
export async function checkAccounts(conn, parsed, customer, cfg) {
  const wanted = [...parsed.sources, parsed.action.destination, customer.paymentAccount];
  if (parsed.customerPayment) wanted.push(customer.payoutAccount);

  let accounts;
  try {
    accounts = await conn.getMultipleAccountsInfo(wanted, "confirmed");
  } catch {
    throw new Refusal("chain_unavailable", "account_read");
  }
  if (!Array.isArray(accounts) || accounts.length !== wanted.length) throw new Refusal("chain_unavailable", "account_read");
  const owners = accounts.map((account) => usdcAccountOwner(account, cfg.usdcMint));

  parsed.sources.forEach((_, index) => {
    if (!owners[index]) throw new Refusal("source_invalid");
    if (!owners[index].equals(parsed.user)) throw new Refusal("source_not_owned_by_user");
  });
  const recipientIndex = parsed.sources.length;
  if (!owners[recipientIndex]) throw new Refusal("recipient_invalid");
  if (!owners[recipientIndex + 1]) throw new Refusal("payment_account_invalid");
  if (parsed.customerPayment && !owners[recipientIndex + 2]) throw new Refusal("payout_account_invalid");

  return { paymentOwner: owners[recipientIndex + 1] };
}
