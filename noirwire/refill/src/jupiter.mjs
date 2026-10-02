// Jupiter's HTTP API: an order (quote plus built transaction in one call) and the endpoint
// that lands a signed order. Nothing here decides anything.

import { Refusal } from "./errors.mjs";

export const JUPITER_API_URL = "https://api.jup.ag";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

const ORDER_TIMEOUT_MS = 10_000;
const EXECUTE_TIMEOUT_MS = 30_000;

const headers = (cfg, extra = {}) => ({
  ...(cfg.jupiterApiKey ? { "x-api-key": cfg.jupiterApiKey } : {}),
  ...extra,
});

/**
 * Asks for a USDC to SOL order for exactly `usdcAmount`, with the payment wallet as taker,
 * from market makers only.
 *
 * Jupiter has four routers. Three are aggregators: their transaction carries its own
 * slippage limit, and holding that limit to the quote would mean decoding each router's
 * instruction. The fourth, JupiterZ, is a request-for-quote: a market maker commits to an
 * exact input and output, both written in the one instruction the taker signs, and the fill
 * either happens at those amounts or not at all. So the aggregators are excluded here and
 * the guard refuses anything else that comes back.
 */
export async function fetchOrder(fetchFn, cfg, usdcAmount) {
  const query = new URLSearchParams({
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    amount: usdcAmount.toString(),
    taker: cfg.wallet.publicKey.toBase58(),
    excludeRouters: "metis,dflow,okx",
  });
  const response = await fetchFn(`${JUPITER_API_URL}/swap/v2/order?${query}`, {
    headers: headers(cfg),
    signal: AbortSignal.timeout(ORDER_TIMEOUT_MS),
  }).catch(() => null);
  const body = response ? await response.json().catch(() => null) : null;
  if (!response?.ok || !body) {
    throw new Refusal("no_quote", `no market maker order was offered (HTTP ${response?.status ?? "none"})`);
  }
  return body;
}

/**
 * Hands the signed order back to Jupiter to land: a market-maker order still needs the
 * maker's signature, which Jupiter collects there.
 *
 * Returns what was learned, never throws: the swap may land whether or not an answer comes
 * back, so the caller settles it against the chain.
 */
export async function executeOrder(fetchFn, cfg, signedTransactionBase64, requestId) {
  try {
    const response = await fetchFn(`${JUPITER_API_URL}/swap/v2/execute`, {
      method: "POST",
      headers: headers(cfg, { "content-type": "application/json" }),
      body: JSON.stringify({ signedTransaction: signedTransactionBase64, requestId }),
      signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, status: body?.status, signature: body?.signature, code: body?.code };
  } catch {
    return { httpStatus: 0 };
  }
}
