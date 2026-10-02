import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../src/config.mjs";
import { FILL_DISCRIMINATOR, RFQ_PROGRAM, USDC } from "../src/guard.mjs";
import { SOL_MINT, USDC_MINT } from "../src/jupiter.mjs";
import { PYTH_SOL_USD } from "../src/price.mjs";

// Fakes for the RPC and for Jupiter. No test touches the network.

export const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
export const SOL = 1_000_000_000n;
/** 150 USDC per SOL: what the fake Pyth account reports and what honest orders fill at. */
export const PRICE = 150_000_000n;
/** The moment every test happens at, in seconds. */
export const NOW = 1_800_000_000;
export const MAKER = Keypair.generate().publicKey;

export function testConfig(overrides = {}) {
  const wallet = Keypair.generate();
  const feePayer = Keypair.generate();
  return loadConfig({
    RPC_URL: "http://rpc.invalid",
    PAYMENT_WALLET_PRIVATE_KEY: JSON.stringify([...wallet.secretKey]),
    FEE_PAYER: feePayer.publicKey.toBase58(),
    MAX_USDC_PER_SOL: "300",
    ...overrides,
  });
}

export const usdcAccount = (cfg) => getAssociatedTokenAddressSync(USDC, cfg.wallet.publicKey, true);

/** The 165 bytes of an SPL token account. */
export function tokenAccountData(mint, owner, amount, { delegate } = {}) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  if (delegate) {
    data.writeUInt32LE(1, 72);
    delegate.toBuffer().copy(data, 76);
  }
  data[108] = 1;
  return data;
}

/** A Pyth PriceUpdateV2 account for SOL/USD. */
export function pythAccount({ price = PRICE, age = 5, confidence = 10_000n, verified = 1, owner = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", feed } = {}) {
  const data = Buffer.alloc(134);
  data[40] = verified;
  Buffer.from(feed ?? "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex").copy(data, 41);
  data.writeBigInt64LE(price * 100n, 73); // exponent -8
  data.writeBigUInt64LE(confidence, 81);
  data.writeInt32LE(-8, 89);
  data.writeBigInt64LE(BigInt(NOW - age), 93);
  return { owner: new PublicKey(owner), data, lamports: 1 };
}

/** The fill instruction of a market-maker order, as genuine orders carry it. */
export function fillInstruction(cfg, { input, output, expireAt = NOW + 55, taker = cfg.wallet.publicKey, inputAccount = usdcAccount(cfg), inputMint = USDC, outputMint = NATIVE_MINT, discriminator = FILL_DISCRIMINATOR, extraKeys = [] }) {
  const data = Buffer.alloc(37);
  discriminator.copy(data, 0);
  data.writeBigUInt64LE(input, 8);
  data.writeBigUInt64LE(output, 16);
  data.writeBigInt64LE(BigInt(expireAt), 24);
  const filler = Keypair.generate().publicKey;
  const key = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  return new TransactionInstruction({
    programId: RFQ_PROGRAM,
    keys: [key(taker, true), key(MAKER, true), key(inputAccount), key(filler), key(RFQ_PROGRAM), key(filler), key(inputMint), key(TOKEN_PROGRAM_ID), key(outputMint), key(TOKEN_PROGRAM_ID), key(SystemProgram.programId), key(filler), ...extraKeys.map((k) => key(k))],
    data,
  });
}

/** A market-maker order's transaction: compute budget, one fill, the maker paying the fee. */
export function fillTransaction(cfg, { payer = MAKER, extra = [], fills, ...fill }) {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 14_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 24_732 }),
    ...(fills ?? [fillInstruction(cfg, fill)]),
    ...extra,
  ];
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions });
  return new VersionedTransaction(message.compileToV0Message());
}

export const encode = (transaction) => Buffer.from(transaction.serialize()).toString("base64");

/** Jupiter's answer for `usdcAmount`, at `PRICE` unless `lamports` says otherwise. */
export function order(cfg, usdcAmount, { lamports, transaction, ...fields } = {}) {
  const out = lamports ?? (usdcAmount * SOL) / PRICE;
  const tx = transaction === undefined ? fillTransaction(cfg, { input: usdcAmount, output: out }) : transaction;
  return {
    inputMint: USDC_MINT,
    outputMint: SOL_MINT,
    inAmount: usdcAmount.toString(),
    outAmount: out.toString(),
    otherAmountThreshold: out.toString(),
    swapMode: "ExactIn",
    swapType: "rfq",
    router: "jupiterz",
    taker: cfg.wallet.publicKey.toBase58(),
    transaction: tx ? encode(tx) : "",
    requestId: "request-1",
    expireAt: String(NOW + 55),
    ...fields,
  };
}

/**
 * A fake RPC. `state` holds lamports and USDC; `options.simulate(state)` returns the
 * post-swap view of the watched accounts. Every call is recorded in `calls`.
 */
export function fakeConn(cfg, state, options = {}) {
  const wallet = cfg.wallet.publicKey;
  const calls = [];
  const others = options.otherTokenAccounts ?? [];
  const account = (key) => {
    const address = key.toBase58();
    if (address === cfg.feePayer.toBase58()) {
      if (options.feePayerMissing) return null;
      return { lamports: Number(state.feePayerLamports ?? 0n), data: Buffer.alloc(0), owner: options.feePayerOwner ?? SystemProgram.programId };
    }
    if (address === wallet.toBase58()) {
      return state.walletLamports > 0n ? { lamports: Number(state.walletLamports), data: Buffer.alloc(0), owner: SystemProgram.programId } : null;
    }
    if (address === usdcAccount(cfg).toBase58()) return { lamports: 2_039_280, data: tokenAccountData(USDC, wallet, state.usdc ?? 0n) };
    if (address === PYTH_SOL_USD.toBase58()) return options.pyth === undefined ? pythAccount() : options.pyth;
    const other = others.find((entry) => entry.pubkey.equals(key));
    return other ? { lamports: 2_039_280, data: other.data } : null;
  };
  const record = (name, value) => (...args) => {
    calls.push({ name, args });
    return typeof value === "function" ? value(...args) : value;
  };
  const historyOf = (address) =>
    (address.equals(wallet) ? options.signatures : address.equals(cfg.feePayer) ? options.feePayerSignatures : options.usdcSignatures) ?? [];
  return {
    calls,
    count: (name) => calls.filter((call) => call.name === name).length,
    getAccountInfo: record("getAccountInfo", async (key) => account(key)),
    getMultipleAccountsInfo: record("getMultipleAccountsInfo", async (keys) => keys.map(account)),
    getSignaturesForAddress: record("getSignaturesForAddress", async (address, { limit, before } = {}) => {
      const all = historyOf(address);
      const from = before ? all.findIndex((entry) => entry.signature === before) + 1 : 0;
      return all.slice(from, from + limit);
    }),
    getTransaction: record("getTransaction", async (signature) => options.transactions?.[signature] ?? null),
    getSlot: record("getSlot", async () => options.slot ?? 5_000_000),
    getTokenAccountsByOwner: record("getTokenAccountsByOwner", async (_owner, { programId }) => ({
      value: programId.toBase58().startsWith("Tokenkeg") ? [{ pubkey: usdcAccount(cfg) }, ...others] : [],
    })),
    simulateTransaction: record("simulateTransaction", async (_tx, config) => {
      const view = options.simulate(state);
      return {
        value: {
          err: view.err ?? null,
          accounts: config.accounts.addresses.map((address) => {
            if (address === wallet.toBase58()) {
              return { lamports: Number(view.walletLamports), owner: view.walletOwner ?? SystemProgram.programId.toBase58(), data: ["", "base64"] };
            }
            if (address === usdcAccount(cfg).toBase58()) {
              return view.usdcData === null ? null : { lamports: 2_039_280, data: [(view.usdcData ?? tokenAccountData(USDC, wallet, view.usdc)).toString("base64"), "base64"] };
            }
            const other = view.others?.find((entry) => entry.pubkey.toBase58() === address);
            return other ? { lamports: 2_039_280, data: [other.data.toString("base64"), "base64"] } : null;
          }),
        },
      };
    }),
    getLatestBlockhash: record("getLatestBlockhash", async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 })),
    getBlockHeight: record("getBlockHeight", async () => options.blockHeight ?? 900),
    sendRawTransaction: record("sendRawTransaction", async (raw) => {
      if (options.onSend) return options.onSend(raw);
      return "sent";
    }),
    getSignatureStatuses: record("getSignatureStatuses", async () => ({ value: [options.status?.() ?? null] })),
  };
}

/** A fake clock starting at NOW: sleeping moves time forward instead of waiting. */
export function fakeClock() {
  let time = NOW * 1000;
  return { now: () => time, sleep: async (ms) => void (time += ms), advance: (ms) => void (time += ms) };
}

/** A fake fetch for Jupiter's two endpoints. Records every request. */
export function fakeJupiter({ order: orderBody, execute } = {}) {
  const requests = [];
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchFn = async (url, init) => {
    requests.push({ url, init });
    if (url.includes("/swap/v2/order")) return json(typeof orderBody === "function" ? orderBody(url) : orderBody);
    if (url.includes("/swap/v2/execute")) return execute ? execute(init) : json({ status: "Success", signature: "maker-signature" });
    throw new Error(`unexpected request to ${url}`);
  };
  fetchFn.requests = requests;
  fetchFn.count = (part) => requests.filter((request) => request.url.includes(part)).length;
  fetchFn.json = json;
  return fetchFn;
}

/**
 * A landed transaction as the RPC returns it. `payer` is its fee payer; `feePayerGain` and
 * `usdcGain` are what FEE_PAYER's SOL and the payment wallet's USDC changed by.
 */
export function landed(cfg, { payer, touchesUsdc = false, feePayerGain = 0n, usdcGain = 0n, err = null, signatures = [] }) {
  const candidates = [payer, cfg.feePayer, cfg.wallet.publicKey, ...(touchesUsdc ? [usdcAccount(cfg)] : [])];
  const keys = candidates.filter((key, index) => candidates.findIndex((other) => other.equals(key)) === index);
  const balances = keys.map(() => 1_000_000_000);
  const post = [...balances];
  post[keys.findIndex((key) => key.equals(cfg.feePayer))] += Number(feePayerGain);
  const token = (amount) => [{ owner: cfg.wallet.publicKey.toBase58(), mint: USDC_MINT, uiTokenAmount: { amount: amount.toString() } }];
  return {
    transaction: { message: { staticAccountKeys: keys, header: { numRequiredSignatures: 1 } }, signatures },
    meta: { err, preBalances: balances, postBalances: post, preTokenBalances: token(50_000_000n), postTokenBalances: token(50_000_000n + usdcGain) },
  };
}

/** Signatures and transactions for the fake RPC, newest first. `slot` defaults to an old one. */
export function history(entries) {
  const signatures = [];
  const transactions = {};
  entries.forEach(({ ageMinutes, tx, slot = 1_000 }, index) => {
    const signature = `sig-${index}-${ageMinutes}`;
    signatures.push({ signature, blockTime: NOW - ageMinutes * 60, slot, err: tx?.meta?.err ?? null });
    if (tx) transactions[signature] = tx;
  });
  return { signatures, transactions };
}
