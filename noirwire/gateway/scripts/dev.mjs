import { API_KEY, authHeaders, listen, makeWorld } from "../test/helpers.mjs";

// Local development: the real gateway (server, authentication, template checks, split,
// quotes, budgets) over the in-memory store, with a fake Kora, a fake RPC and a fixed SOL
// price. Nothing here touches the network or a real key; every key is generated on start.
//
//   node scripts/dev.mjs           serve on 127.0.0.1:8787 until stopped
//   node scripts/dev.mjs --smoke   serve, run /health, /v1/prepare and /v1/sign once, exit
//
// DEV_PORT picks another port.

const port = Number(process.env.DEV_PORT ?? 8787);
const smoke = process.argv.includes("--smoke");
const print = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

const world = makeWorld({ clock: { now: Date.now } });
const http = await listen(world, port, (line) => print(`log  ${JSON.stringify(line)}`));
const base = `http://127.0.0.1:${port}`;

if (!smoke) {
  print(`gateway (fake Kora, fake RPC, in-memory store) on ${base}`);
  print({
    customer: "acme (markup 50 percent)",
    apiKey: API_KEY,
    hmacSecret: world.secrets.hmacSecret,
    prepareBody: world.prepareBody(),
    note: "these credentials exist only in this process; run with --smoke for a full prepare and sign",
  });
} else {
  const post = async (path, body) => {
    const text = JSON.stringify(body);
    const headers = authHeaders({ secret: world.secrets.hmacSecret, timestamp: Math.floor(Date.now() / 1000), path, body: text });
    const response = await fetch(base + path, { method: "POST", headers, body: text, signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() };
  };
  const short = (text) => (text.length > 44 ? `${text.slice(0, 40)}... (${text.length} chars)` : text);

  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
  print(`GET  /health      -> ${health.status} ${JSON.stringify(await health.json())}`);

  const prepared = await post("/v1/prepare", world.prepareBody());
  print(`POST /v1/prepare  -> ${prepared.status}`);
  print({ ...prepared.body, transaction: short(prepared.body.transaction) });

  // The user signs exactly what was prepared, with a key generated in this process.
  const signed = await post("/v1/sign", world.signedBody(prepared.body));
  print(`POST /v1/sign     -> ${signed.status} ${JSON.stringify(signed.body)}`);

  const repeat = await post("/v1/sign", world.signedBody(prepared.body));
  print(`POST /v1/sign     -> ${repeat.status} ${JSON.stringify(repeat.body)} (same quote again)`);

  print(`fake Kora saw: ${world.fetchFn.requests.map((request) => request.method).join(", ")}`);
  print(`fake RPC broadcasts: ${world.conn.count("sendRawTransaction")}`);
  const stored = await world.store.getQuote(prepared.body.quoteId);
  print(`stored quote: state ${stored.state}, signature kept in the store only: ${stored.signature === signed.body.signature}`);
  await http.close();
  const ok = health.status === 200 && prepared.status === 200 && signed.status === 200 && repeat.body.signature === signed.body.signature && world.conn.count("sendRawTransaction") === 1;
  print(ok ? "smoke: ok" : "smoke: FAILED");
  process.exitCode = ok ? 0 : 1;
}
