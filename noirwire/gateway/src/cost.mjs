import { Refusal } from "./errors.mjs";
import { floorLamports, lamportsToMicroUsdc, max } from "./split.mjs";

/**
 * The network cost of one transaction in micro-USDC: the larger of what the customer's Kora
 * says it will charge and a floor computed here from the transaction's own signature and
 * priority fees at an independent SOL price. Either one missing is a refusal: a cost known
 * from one side only is not a cost this gateway quotes or signs against.
 */
export async function networkCost({ kora, priceSource, clock }, cfg, customer, parsed, transactionBase64, paymentOwner) {
  let estimate;
  try {
    estimate = await kora.estimate(customer, transactionBase64, cfg.usdcMint.toBase58());
  } catch {
    throw new Refusal("kora_unavailable", "estimate");
  }
  // The Kora behind this customer must sign with this customer's fee payer and collect into
  // the wallet that owns the payment account. Anything else is another relayer.
  if (estimate.signerPubkey !== customer.feePayer.toBase58()) throw new Refusal("kora_mismatch", "fee_payer");
  if (estimate.paymentAddress !== paymentOwner.toBase58()) throw new Refusal("kora_mismatch", "payment_address");

  let microUsdPerSol;
  try {
    microUsdPerSol = await priceSource.microUsdPerSol(Math.floor(clock.now() / 1000));
  } catch (error) {
    throw new Refusal("price_unavailable", error instanceof Refusal ? error.detail : "source_failed");
  }
  if (typeof microUsdPerSol !== "bigint" || microUsdPerSol <= 0n) throw new Refusal("price_unavailable", "not_a_price");

  const floor = lamportsToMicroUsdc(floorLamports(parsed), microUsdPerSol);
  const cost = max(estimate.feeInToken, floor);
  if (cost > cfg.maxNetworkCostMicroUsdc) throw new Refusal("cost_above_cap");
  return cost;
}
