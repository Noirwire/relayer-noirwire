import { createHmac } from "node:crypto";

// The client side of a customer's private Kora, over JSON-RPC.
//
// Authentication is Kora's own, reproduced exactly: `x-api-key`, `x-timestamp` in unix
// seconds, and `x-hmac-signature` = hex(HMAC-SHA256(secret, timestamp + body)), where body
// is the exact string that is sent.
//
// Only two methods are ever called: `estimateTransactionFee` and `signTransaction`. The
// gateway broadcasts itself (see service.mjs for why), so `signAndSendTransaction` can stay
// disabled on every Kora.

/**
 * `refused`: Kora answered and the answer is a no (an HTTP error status or a JSON-RPC
 * error). `unreachable`: no usable answer arrived (network error, timeout, unreadable body),
 * so nothing is known about what Kora did with the request.
 */
export class KoraError extends Error {
  constructor(kind, { httpStatus = null, rpcCode = null } = {}) {
    super(`kora ${kind}`);
    this.kind = kind;
    // Numbers only. Kora's message text names addresses and is never kept.
    this.httpStatus = httpStatus;
    this.rpcCode = rpcCode;
  }
}

export function koraHeaders(secrets, body, nowSeconds) {
  const timestamp = String(nowSeconds);
  return {
    "content-type": "application/json",
    "x-api-key": secrets.koraApiKey,
    "x-timestamp": timestamp,
    "x-hmac-signature": createHmac("sha256", secrets.koraHmacSecret).update(timestamp + body).digest("hex"),
  };
}

export function createKora({ fetchFn, clock, timeoutMs, secretsFor }) {
  async function call(customer, method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    let response;
    let text;
    try {
      response = await fetchFn(customer.koraUrl, {
        method: "POST",
        headers: koraHeaders(secretsFor(customer.id), body, Math.floor(clock.now() / 1000)),
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new KoraError("unreachable");
    }
    if (response.status < 200 || response.status >= 300) throw new KoraError("refused", { httpStatus: response.status });
    let answer;
    try {
      answer = JSON.parse(text);
    } catch {
      throw new KoraError("unreachable", { httpStatus: response.status });
    }
    if (answer?.error) {
      throw new KoraError("refused", { httpStatus: response.status, rpcCode: Number.isInteger(answer.error.code) ? answer.error.code : null });
    }
    if (!answer || typeof answer.result !== "object" || answer.result === null) {
      throw new KoraError("unreachable", { httpStatus: response.status });
    }
    return answer.result;
  }

  return {
    /** What Kora will charge for this transaction, in raw units of `mint`. */
    async estimate(customer, transactionBase64, mint) {
      const result = await call(customer, "estimateTransactionFee", {
        transaction: transactionBase64,
        fee_token: mint,
        signer_key: customer.feePayer.toBase58(),
        sig_verify: false,
      });
      const fee = result.fee_in_token;
      // A u64 arrives as a JSON number. Above 2^53 it is no longer exact, and no network
      // cost is anywhere near that, so such an answer is not believed.
      if (!Number.isSafeInteger(fee) || fee < 0) throw new KoraError("unreachable");
      if (typeof result.signer_pubkey !== "string" || typeof result.payment_address !== "string") throw new KoraError("unreachable");
      return { feeInToken: BigInt(fee), signerPubkey: result.signer_pubkey, paymentAddress: result.payment_address };
    },

    /** The transaction with the fee payer's signature added, as base64. Kora does not send it. */
    async sign(customer, transactionBase64) {
      const result = await call(customer, "signTransaction", {
        transaction: transactionBase64,
        signer_key: customer.feePayer.toBase58(),
        sig_verify: false,
      });
      if (typeof result.signed_transaction !== "string") throw new KoraError("unreachable");
      return result.signed_transaction;
    },
  };
}
