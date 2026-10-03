// Every way the gateway says no. A refusal has a stable code (what a client switches on), an
// HTTP status and a plain message. Messages are fixed text: they never carry an address, a
// transaction, a secret or anything an upstream answered.

const TABLE = {
  // Request and authentication.
  not_found: [404, "No such route."],
  bad_request: [400, "The request body is not what this route expects."],
  body_too_large: [413, "The request body is too large."],
  unauthorized: [401, "Authentication failed."],
  customer_suspended: [403, "This customer is not active."],
  template_not_enabled: [403, "This customer may not use this transaction template."],
  rate_limited: [429, "Too many requests. Try again in a minute."],
  budget_exhausted: [429, "The customer's daily budget is used up."],
  too_many_open_quotes: [429, "This customer has too many open quotes. Sign them or let them expire."],
  customer_paused: [403, "This customer is paused: too many of its transactions failed on chain."],

  // The transaction as a whole.
  oversize_transaction: [422, "The transaction is larger than a Solana packet allows."],
  malformed_transaction: [422, "The transaction could not be read, or is not in canonical form."],
  unsupported_version: [422, "Only legacy and v0 transactions are accepted."],
  lookup_tables_not_allowed: [422, "Address lookup tables are not allowed."],
  wrong_fee_payer: [422, "The fee payer is not this customer's relayer."],
  unexpected_signers: [422, "The transaction must be signed by the fee payer and exactly one user."],
  user_writable: [422, "The user must be a read-only signer."],
  fee_payer_misused: [422, "The fee payer may only pay the fee. It appears in an instruction."],

  // Instructions.
  program_not_allowed: [422, "The transaction calls a program this template does not allow."],
  token_2022_not_allowed: [422, "Token-2022 is not allowed."],
  durable_nonce_not_allowed: [422, "Durable nonce transactions are not allowed."],
  account_creation_not_allowed: [422, "Creating accounts is not allowed."],
  delegate_not_allowed: [422, "Approving or revoking a delegate is not allowed."],
  authority_change_not_allowed: [422, "Changing an account's authority is not allowed."],
  close_account_not_allowed: [422, "Closing an account is not allowed."],
  token_instruction_not_allowed: [422, "Only TransferChecked is allowed on the token program."],
  compute_budget_not_allowed: [422, "Only one compute unit limit and one compute unit price are allowed, and a price needs a limit."],
  compute_limit_above_cap: [422, "The compute unit limit is above the cap."],
  priority_fee_above_cap: [422, "The priority fee is above the cap."],

  // Transfers.
  wrong_mint: [422, "Every transfer must be USDC."],
  wrong_authority: [422, "Every transfer must be authorised by the signing user."],
  action_mismatch: [422, "The transaction must contain exactly one USDC transfer as its action."],
  payment_mismatch: [422, "The payment transfers are not exactly what the quote requires."],
  recipient_not_allowed: [422, "The recipient may not be the source, the payment account or the payout account."],

  // Accounts, as the chain shows them.
  source_invalid: [422, "A source account does not exist or is not a USDC token account."],
  source_not_owned_by_user: [422, "A source account is not owned by the signing user."],
  recipient_invalid: [422, "The recipient account does not exist or is not a USDC token account."],
  payment_account_invalid: [502, "The customer's payment account does not exist or is not a USDC token account."],
  payment_account_not_platform: [502, "The customer's payment account is not one the platform owns. Nothing was signed."],
  insufficient_balance: [422, "The source account does not hold the transfer plus the payments."],
  source_busy: [409, "Another transaction from this source account is not settled yet. Try again shortly."],
  payout_account_invalid: [502, "The customer's payout account does not exist or is not a USDC token account."],

  // Cost.
  price_unavailable: [502, "No usable SOL price. Nothing was signed."],
  kora_unavailable: [502, "The relayer could not price this transaction. Nothing was signed."],
  kora_mismatch: [502, "The relayer does not answer as this customer's relayer. Nothing was signed."],
  cost_above_cap: [422, "The network cost is above the gateway's cap."],
  cost_rose: [409, "The network cost rose above the quote. Prepare again."],
  chain_unavailable: [502, "The chain could not be read. Nothing was signed."],

  // Quotes and signing.
  quote_not_found: [404, "No such quote."],
  quote_expired: [410, "The quote has expired. Prepare again."],
  message_mismatch: [422, "The transaction is not the one that was prepared."],
  bad_user_signature: [422, "The user's signature is missing or does not verify."],
  sign_in_progress: [409, "This quote is being signed. Ask again with the same quote."],
  kora_refused: [502, "The relayer refused to sign. Nothing was sent."],
  kora_bad_response: [502, "The relayer's answer could not be trusted. Nothing was sent."],
  not_recorded: [503, "The signed transaction could not be recorded, so it was not sent. Prepare again."],
  broadcast_rejected: [502, "The network refused the transaction. Nothing landed."],
  failed_on_chain: [409, "The transaction was included in a block and failed. Nothing was transferred."],
  transaction_expired: [410, "The transaction did not land before its blockhash expired. Prepare again."],
  outcome_unknown: [502, "The transaction may or may not land. It will not be retried. Check the chain."],
  internal: [500, "Internal error. Nothing was signed."],
};

export const REFUSAL_CODES = Object.freeze(Object.keys(TABLE));

/** Nothing was signed because of this request, or the quote already ended this way. */
export class Refusal extends Error {
  constructor(code, detail) {
    const entry = TABLE[code];
    if (!entry) throw new Error(`unknown refusal code ${code}`);
    super(entry[1]);
    this.code = code;
    this.status = entry[0];
    // For the log line only, never for the response: a fixed word saying which check fired.
    this.detail = detail ?? null;
  }
}

/**
 * The transaction was handed on and what became of it is not known. It may still land, so
 * the quote is closed as unknown and nothing is ever tried again for it.
 */
export class UnknownOutcome extends Error {
  constructor(detail, signature = null) {
    super(TABLE.outcome_unknown[1]);
    this.detail = detail;
    this.signature = signature;
  }
}
