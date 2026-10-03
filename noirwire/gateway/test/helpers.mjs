import { createHmac, timingSafeEqual } from "node:crypto";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../src/config.mjs";
import { hashApiKey } from "../src/customers.mjs";
import { createKora } from "../src/kora.mjs";
import { PYTH_SOL_USD } from "../src/price.mjs";
import { createRateLimiter } from "../src/ratelimit.mjs";
import { createGatewayServer } from "../src/server.mjs";
import { createService } from "../src/service.mjs";
import { createMemoryStore } from "../src/store/memory.mjs";

// Fakes for the RPC, for Kora and for the price source. No test touches the network: the
// only sockets opened are loopback ones to the gateway's own server.

export const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/** 150 dollars per SOL, in micro-dollars: two signatures (10,000 lamports) cost 1,500 micro-USDC. */
export const PRICE = 150_000_000n;
/** What the fake Kora charges unless a test says otherwise. Above the floor, so it is B. */
export const KORA_FEE = 1_600n;
/** The moment every test happens at, in seconds. */
export const NOW = 1_800_000_000;

/** A fake clock starting at NOW. Time moves only when a test moves it. */
export function fakeClock() {
  let time = NOW * 1000;
  return { now: () => time, advance: (ms) => void (time += ms) };
}

/** The 165 bytes of a classic SPL token account. `state` 1 is initialized, 2 frozen. */
export function tokenAccount(mint, owner, { amount = 1_000_000_000n, state = 1, program = TOKEN_PROGRAM_ID } = {}) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = state;
  return { owner: program, data, lamports: 2_039_280 };
}

/** A Pyth PriceUpdateV2 account for SOL/USD. */
export function pythAccount({ price = PRICE, age = 5, confidence = 10_000n, verified = 1, owner = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", feed, exponent = -8 } = {}) {
  const data = Buffer.alloc(134);
  data[40] = verified;
  Buffer.from(feed ?? "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "hex").copy(data, 41);
  data.writeBigInt64LE(price * 100n, 73); // micro-dollars to exponent -8
  data.writeBigUInt64LE(confidence, 81);
  data.writeInt32LE(exponent, 89);
  data.writeBigInt64LE(BigInt(NOW - age), 93);
  return { owner: new PublicKey(owner), data, lamports: 1 };
}

/**
 * A fake RPC over a map of address to account. Records every call. `options.onSend(raw)`
 * decides what a broadcast does; by default it is accepted.
 */
export function fakeConn(accounts, options = {}) {
  const calls = [];
  const record = (name, fn) => async (...args) => {
    calls.push({ name, args });
    return fn(...args);
  };
  const read = (key) => accounts.get(key.toBase58()) ?? null;
  return {
    calls,
    accounts,
    options,
    count: (name) => calls.filter((call) => call.name === name).length,
    sent: () => calls.filter((call) => call.name === "sendRawTransaction").map((call) => call.args[0]),
    getMultipleAccountsInfo: record("getMultipleAccountsInfo", (keys) => {
      if (options.failReads) throw new Error("rpc down");
      return keys.map(read);
    }),
    getAccountInfo: record("getAccountInfo", (key) => {
      if (options.failReads) throw new Error("rpc down");
      return read(key);
    }),
    getLatestBlockhash: record("getLatestBlockhash", () => {
      if (options.failBlockhash) throw new Error("rpc down");
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 };
    }),
    sendRawTransaction: record("sendRawTransaction", (raw) => (options.onSend ? options.onSend(raw) : "accepted")),
  };
}

export const fakePrice = (state) => ({
  async microUsdPerSol() {
    if (state.priceFails) throw new Error("price source down");
    return state.price;
  },
});

/**
 * A fake Kora, at the level of `fetch`. It checks the three authentication headers the way
 * Kora's middleware does and really signs with the fee payer's key, so a test that gets a
 * signature back has proven both. `state` steers it:
 *   fee            what estimateTransactionFee answers (a bigint, or a function of the call count)
 *   estimateError / signError   answer a JSON-RPC error
 *   httpStatus     answer this status with an empty body (signHttpStatus: only when signing)
 *   networkError   the request fails before any answer (signNetworkError: only when signing)
 *   hang           "estimate" or "sign": never answer (until the caller's signal aborts)
 *   tamper         "message", "user_signature", "fee_payer_signature" or "garbage"
 */
export function fakeKora(world, state) {
  const requests = [];
  const answer = (body, status = 200) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const authentic = (init) => {
    const timestamp = init.headers["x-timestamp"];
    const expected = createHmac("sha256", world.secrets.koraHmacSecret).update(timestamp + init.body).digest();
    const provided = Buffer.from(init.headers["x-hmac-signature"] ?? "", "hex");
    return (
      init.headers["x-api-key"] === world.secrets.koraApiKey &&
      Math.abs(Math.floor(world.clock.now() / 1000) - Number(timestamp)) <= 60 &&
      provided.length === expected.length &&
      timingSafeEqual(provided, expected)
    );
  };
  const never = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

  const fetchFn = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    requests.push({ url, method, params, headers: init.headers });
    if (state.networkError) throw new TypeError("fetch failed");
    if (!authentic(init)) return answer("", 401);
    if (state.httpStatus) return answer("", state.httpStatus);

    if (method === "estimateTransactionFee") {
      if (state.hang === "estimate") return never(init.signal);
      if (state.estimateError) return answer({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Invalid transaction: details that must not leak" } });
      const estimates = requests.filter((request) => request.method === "estimateTransactionFee").length;
      const fee = typeof state.fee === "function" ? state.fee(estimates) : state.fee;
      return answer({
        jsonrpc: "2.0",
        id: 1,
        result: {
          fee_in_lamports: 10_000,
          fee_in_token: typeof fee === "bigint" ? Number(fee) : fee,
          signer_pubkey: (state.signer ?? world.feePayer.publicKey).toBase58(),
          payment_address: (state.paymentAddress ?? world.paymentWallet.publicKey).toBase58(),
        },
      });
    }
    if (method === "signTransaction") {
      if (state.hang === "sign") return never(init.signal);
      if (state.signNetworkError) throw new TypeError("fetch failed");
      if (state.signHttpStatus) return answer("", state.signHttpStatus);
      if (state.signError) return answer({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Invalid transaction: Insufficient token payment. Required 10000 lamports" } });
      if (state.tamper === "garbage") return answer({ jsonrpc: "2.0", id: 1, result: { signed_transaction: "AAAA", signer_pubkey: "x" } });
      let transaction = VersionedTransaction.deserialize(Buffer.from(params.transaction, "base64"));
      if (state.tamper === "message") {
        const userSignature = transaction.signatures[1];
        transaction = usdcTransfer(world, { amount: 999_999n, platform: 1n, customer: 0n });
        transaction.signatures[1] = userSignature;
      }
      transaction.sign([world.feePayer]);
      if (state.tamper === "user_signature") transaction.signatures[1] = new Uint8Array(64);
      if (state.tamper === "fee_payer_signature") transaction.signatures[0] = new Uint8Array(64).fill(7);
      return answer({ jsonrpc: "2.0", id: 1, result: { signed_transaction: encode(transaction), signer_pubkey: world.feePayer.publicKey.toBase58(), lighthouse_assertion_added: false } });
    }
    return answer("", 405);
  };
  fetchFn.requests = requests;
  fetchFn.count = (method) => requests.filter((request) => request.method === method).length;
  return fetchFn;
}

export const encode = (transaction) => Buffer.from(transaction.serialize()).toString("base64");

/** A TransferChecked of USDC authorised by the user, with every part replaceable. */
export function transfer(world, destination, amount, { source = world.userUsdc, mint = USDC, authority = world.user.publicKey, decimals = 6, program = TOKEN_PROGRAM_ID } = {}) {
  return createTransferCheckedInstruction(source, mint, destination, authority, amount, decimals, [], program);
}

/** Any instructions as a transaction with the customer's fee payer, v0 unless told otherwise. */
export function transactionOf(world, instructions, { payer = world.feePayer.publicKey, legacy = false, lookupTables } = {}) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions });
  return new VersionedTransaction(legacy ? message.compileToLegacyMessage() : message.compileToV0Message(lookupTables));
}

/** The template's transaction: the action, the platform payment, the customer payment. */
export function usdcTransfer(world, { amount = 5_000_000n, platform = 1_760n, customer = 640n, before = [], after = [], ...options } = {}) {
  const instructions = [...before, transfer(world, world.recipientUsdc, amount), transfer(world, world.paymentAccount, platform)];
  if (customer > 0n) instructions.push(transfer(world, world.payoutAccount, customer));
  return transactionOf(world, [...instructions, ...after], options);
}

export const API_KEY = "test-api-key-000000000000000000000000";

/**
 * One customer ("acme", 50 percent markup), its relayer, a user with USDC and a recipient,
 * all wired to fakes. `overrides.customer` changes the customers file entry,
 * `overrides.env` the environment, `overrides.clock` replaces the fake clock.
 */
export function makeWorld(overrides = {}) {
  const world = {
    feePayer: Keypair.generate(),
    paymentWallet: Keypair.generate(),
    payoutWallet: Keypair.generate(),
    user: Keypair.generate(),
    recipientWallet: Keypair.generate(),
    clock: overrides.clock ?? fakeClock(),
    secrets: {
      hmacSecret: "customer-hmac-secret-0000000000000000",
      koraApiKey: "kora-api-key-00000000000000000000000000",
      koraHmacSecret: "kora-hmac-secret-000000000000000000000",
    },
  };
  const ata = (wallet) => getAssociatedTokenAddressSync(USDC, wallet.publicKey);
  world.userUsdc = ata(world.user);
  world.recipientUsdc = ata(world.recipientWallet);
  world.paymentAccount = ata(world.paymentWallet);
  world.payoutAccount = ata(world.payoutWallet);

  world.customerEntry = {
    id: "acme",
    name: "Acme Example",
    apiKeyHash: hashApiKey(API_KEY),
    templates: ["usdc-transfer"],
    markupBps: 5_000,
    payoutAccount: world.payoutAccount.toBase58(),
    paymentAccount: world.paymentAccount.toBase58(),
    koraUrl: "http://kora.invalid/",
    feePayer: world.feePayer.publicKey.toBase58(),
    budgets: { requestsPerMinute: 600, transactionsPerDay: 100, networkCostMicroUsdcPerDay: "1000000" },
    status: "active",
    ...overrides.customer,
  };
  world.env = {
    RPC_URL: "http://rpc.invalid",
    STORE: "memory",
    CUSTOMERS_FILE: "/customers.json",
    GATEWAY_HMAC_SECRET_ACME: world.secrets.hmacSecret,
    KORA_API_KEY_ACME: world.secrets.koraApiKey,
    KORA_HMAC_SECRET_ACME: world.secrets.koraHmacSecret,
    ...overrides.env,
  };
  world.cfg = loadConfig(world.env, () => JSON.stringify({ customers: [world.customerEntry] }));
  world.customer = world.cfg.customers.byId.get("acme");

  world.accounts = new Map([
    [world.userUsdc.toBase58(), tokenAccount(USDC, world.user.publicKey)],
    [world.recipientUsdc.toBase58(), tokenAccount(USDC, world.recipientWallet.publicKey)],
    [world.paymentAccount.toBase58(), tokenAccount(USDC, world.paymentWallet.publicKey)],
    [world.payoutAccount.toBase58(), tokenAccount(USDC, world.payoutWallet.publicKey)],
    [world.user.publicKey.toBase58(), { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 0 }],
    [PYTH_SOL_USD.toBase58(), pythAccount()],
  ]);
  world.conn = fakeConn(world.accounts);
  world.koraState = { fee: KORA_FEE };
  world.priceState = { price: PRICE };
  world.fetchFn = fakeKora(world, world.koraState);
  world.kora = createKora({ fetchFn: world.fetchFn, clock: world.clock, timeoutMs: 40, secretsFor: world.cfg.customers.secretsFor });
  world.store = createMemoryStore();
  world.deps = { conn: world.conn, kora: world.kora, priceSource: fakePrice(world.priceState), store: world.store, clock: world.clock };
  world.service = createService(world.deps, world.cfg);

  world.prepareBody = (fields = {}) => ({
    user: world.user.publicKey.toBase58(),
    source: world.userUsdc.toBase58(),
    recipient: world.recipientUsdc.toBase58(),
    amountMicroUsdc: "5000000",
    ...fields,
  });
  world.prepare = (fields) => world.service.prepare(world.customer, world.prepareBody(fields), {});
  /** The prepared transaction, signed by the user, as the body of /v1/sign. */
  world.signedBody = (prepared, signer = world.user) => {
    const transaction = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    transaction.sign([signer]);
    return { quoteId: prepared.quoteId, transaction: encode(transaction) };
  };
  world.sign = (prepared, report = {}) => world.service.sign(world.customer, world.signedBody(prepared), report);
  return world;
}

/** The three headers a customer sends, computed the way the README tells customers to. */
export function authHeaders({ apiKey = API_KEY, secret, timestamp, method = "POST", path, body }) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "x-timestamp": String(timestamp),
    "x-signature": createHmac("sha256", secret).update(`${timestamp}${method}${path}${body}`).digest("hex"),
  };
}

/** The gateway's HTTP server over a world, on loopback: a port the system picks unless one is given. */
export async function listen(world, port = 0, onLine = () => {}) {
  const lines = [];
  const server = createGatewayServer({
    service: world.service,
    customers: world.cfg.customers,
    rateLimiter: createRateLimiter(world.clock),
    clock: world.clock,
    log: (line) => {
      lines.push(line);
      onLine(line);
    },
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headerOverrides = {}, method = "POST") => {
    const text = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const headers = method === "POST"
      ? { ...authHeaders({ secret: world.secrets.hmacSecret, timestamp: Math.floor(world.clock.now() / 1000), path, body: text ?? "" }), ...headerOverrides }
      : {};
    const response = await fetch(base + path, { method, headers, body: text, signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json() };
  };
  return { call, lines, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Asserts that `fn` ends in a Refusal with this code. */
export async function refusal(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, got an answer");
}
