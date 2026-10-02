import { feePayerHasRelayed, outcomeWithin, readBalances, reconcileFeePayer, sendRefillTransfer, TRANSFER_WAIT_MS, walletLast24h } from "./chain.mjs";
import { EXIT, Failed, Refusal, UnknownOutcome } from "./errors.mjs";
import { checkOrder, checkTransaction } from "./guard.mjs";
import { executeOrder, fetchOrder, USDC_MINT } from "./jupiter.mjs";
import { dailyCapRefusal, planSwap, planTransfer, withinDailyCeiling } from "./plan.mjs";
import { readReferencePrice } from "./price.mjs";
import { base58Encode, formatUnits, SOL_DECIMALS, USDC_DECIMALS } from "./units.mjs";

/**
 * The whole run must end before the next scheduled one starts (every 10 minutes), so that
 * two runs never work on the same balances. No leg is started unless it can finish its own
 * bounded wait inside this.
 */
export const RUN_DEADLINE_MS = 8 * 60_000;
/** How long a submitted swap is watched for before its outcome is called unknown. */
const SWAP_WAIT_MS = 90_000;
/**
 * No swap within this many slots (about three minutes) of the wallet's newest swap attempt
 * that this run did not send itself. A blockhash lives about 150 slots, so by then anything
 * an earlier run or a person sent has either landed, and is counted, or can no longer land.
 */
export const SWAP_QUIET_SLOTS = 450;

const sol = (lamports) => formatUnits(lamports, SOL_DECIMALS);
const usdc = (units) => formatUnits(units, USDC_DECIMALS);
const balancesForReport = (b) =>
  b && { feePayerSol: sol(b.feePayerLamports), paymentWalletSol: sol(b.walletLamports), paymentWalletUsdc: usdc(b.usdc) };

/** What a landed swap really moved for the wallet, read from the transaction's own record. */
function movedByLanded(landed, wallet) {
  const keys = landed.transaction.message.staticAccountKeys;
  const index = keys.findIndex((key) => key.equals(wallet));
  const tokens = (list) =>
    BigInt(list?.find((b) => b.owner === wallet.toBase58() && b.mint === USDC_MINT)?.uiTokenAmount.amount ?? 0);
  return {
    solReceived: sol(BigInt(landed.meta.postBalances[index]) - BigInt(landed.meta.preBalances[index])),
    usdcSpent: usdc(tokens(landed.meta.preTokenBalances) - tokens(landed.meta.postTokenBalances)),
  };
}

/**
 * Signs the checked order and hands it to Jupiter, once. The reply is a receipt for the
 * submission, not proof of a trade, so the swap counts as done only when the chain shows a
 * confirmed transaction carrying this wallet's signature. Jupiter's own refusal is a
 * failure. Anything the chain cannot settle inside the wait is an unknown outcome, and
 * there is no second attempt.
 */
async function submitSwap({ conn, fetchFn, clock }, cfg, quote) {
  const wallet = cfg.wallet.publicKey;
  const { transaction } = quote;
  transaction.sign([cfg.wallet]);
  const slot = transaction.message.staticAccountKeys.findIndex((key) => key.equals(wallet));
  const ours = base58Encode(transaction.signatures[slot]);

  const serialized = Buffer.from(transaction.serialize()).toString("base64");
  const answer = await executeOrder(fetchFn, cfg, serialized, quote.requestId);
  if (answer.status === "Failed" || (answer.httpStatus >= 400 && answer.httpStatus < 500)) {
    // Only numbers from the reply are logged, never its text.
    throw new Failed(`Jupiter did not execute the swap (HTTP ${answer.httpStatus}, code ${Number.isInteger(answer.code) ? answer.code : "none"})`);
  }
  // The transaction's id is the maker's signature, which only Jupiter can tell us.
  const signature = answer.signature;
  if (!signature) throw new UnknownOutcome("The swap");
  const outcome = await outcomeWithin(conn, signature, undefined, SWAP_WAIT_MS, clock);
  if (outcome === "failed") throw new Failed("the swap failed on chain", signature);
  if (outcome === "unknown") throw new UnknownOutcome("The swap", signature);

  const landed = await conn
    .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    .catch(() => null);
  // Some confirmed transaction existing under a signature Jupiter named proves nothing. Our
  // own signature among its signatures does: a signature is only valid over one message.
  if (!landed?.transaction.signatures.includes(ours)) throw new UnknownOutcome("The swap", signature);
  return { signature, ...(landed.meta ? movedByLanded(landed, wallet) : {}) };
}

/**
 * One run. Returns `{ exitCode, report }`; the caller prints the report as one JSON line.
 *
 * `deps` carries everything that touches the outside world (`conn`, `fetchFn`, `clock`), so
 * the tests can run the whole thing against fakes.
 */
export async function run(cfg, deps) {
  const { conn, fetchFn, clock } = deps;
  const startedAt = clock.now();
  const nowSeconds = () => Math.floor(clock.now() / 1000);
  // The two addresses below are the operator's own (the relayer's fee payer and its payment
  // wallet). They are public on chain and identify no user, so they may be logged. No user
  // address, no key and no raw environment value is ever put in this report.
  const report = {
    time: new Date(startedAt).toISOString(),
    dryRun: cfg.dryRun,
    feePayer: cfg.feePayer.toBase58(),
    paymentWallet: cfg.wallet.publicKey.toBase58(),
    outcome: "nothing_to_do",
    before: null,
    after: null,
    actions: [],
  };
  let exitCode = EXIT.ok;
  let watch = null;
  const sentByThisRun = new Set();

  /** Refuses to start a leg that could not finish its own bounded wait before the deadline. */
  const needTime = (ms, what) => {
    if (clock.now() - startedAt + ms > RUN_DEADLINE_MS) {
      throw new Refusal("deadline", `not enough of the run's time is left to ${what}; the next run will`);
    }
  };

  /**
   * FEE_PAYER must be shown to be the relayer before a lamport goes to it: an ordinary
   * System account that the chain shows paying for transactions which paid this wallet.
   * Before its first relayed transaction no such history exists, and only then does the
   * operator's explicit FEE_PAYER_UNSEEN_OK stand in for it.
   */
  let feePayerProven = false;
  const proveFeePayer = async (balances) => {
    if (feePayerProven) return;
    if (!balances.feePayerIsSystemAccount) {
      throw new Refusal("fee_payer_not_a_wallet", "FEE_PAYER does not exist on chain as an ordinary System account");
    }
    if (watch.sawPaidRelay || (await feePayerHasRelayed(conn, cfg))) report.feePayerEvidence = "relayed_payments";
    else if (cfg.feePayerUnseenOk) report.feePayerEvidence = "operator_acknowledged";
    else {
      throw new Refusal(
        "fee_payer_unproven",
        "the chain shows no transaction paid for by FEE_PAYER that paid this wallet; for the first refill set FEE_PAYER_UNSEEN_OK to the same address",
      );
    }
    feePayerProven = true;
  };

  /**
   * Step 1 and step 3 are this one function: move what is above the reserve, up to the
   * target. Balances and the day's total are read again here, immediately before signing,
   * so the amount is decided on what the chain shows now and not on what it showed when the
   * run began. (A dry run keeps the balances it was handed: they are projections.)
   */
  const settle = async (handed) => {
    if (planTransfer(handed, cfg) === 0n) return handed;
    await proveFeePayer(handed);
    needTime(TRANSFER_WAIT_MS + 20_000, "send a transfer");
    const balances = cfg.dryRun ? handed : await readBalances(conn, cfg);
    const day = await walletLast24h(conn, cfg, nowSeconds(), sentByThisRun);
    report.solToFeePayerLast24h = sol(day.lamportsToFeePayer);
    const planned = planTransfer(balances, cfg);
    if (planned === 0n) return balances;
    const lamports = withinDailyCeiling(planned, day.lamportsToFeePayer);
    if (lamports === 0n) {
      throw new Refusal("daily_sol_ceiling", "the daily ceiling on SOL moved into the fee payer is reached");
    }
    if (cfg.dryRun) {
      report.actions.push({ type: "transfer", wouldSendSol: sol(lamports) });
      return {
        ...balances,
        walletLamports: balances.walletLamports - lamports,
        feePayerLamports: balances.feePayerLamports + lamports,
      };
    }
    const action = { type: "transfer", sol: sol(lamports), signature: null };
    report.actions.push(action);
    action.signature = await sendRefillTransfer(conn, cfg, lamports, clock);
    sentByThisRun.add(action.signature);
    return readBalances(conn, cfg);
  };

  /** Everything a swap is decided on, read from the chain at the moment of asking. */
  const swapPlan = async (microUsdcPerSol) => {
    const balances = await readBalances(conn, cfg);
    const day = await walletLast24h(conn, cfg, nowSeconds(), sentByThisRun);
    report.swapsLast24h = day.swapAttempts;
    // Asked first: once the cap is reached nothing else is worth reading.
    const cap = dailyCapRefusal(day.swapAttempts, cfg);
    if (cap) throw new Refusal(cap.code, cap.reason);
    if (day.newestSwapSlot > 0 && (await conn.getSlot("confirmed")) - day.newestSwapSlot < SWAP_QUIET_SLOTS) {
      throw new Refusal("recent_activity", "the payment wallet attempted a swap in the last three minutes; no new swap until that has settled");
    }
    // No point buying SOL that the daily ceiling would then keep out of the fee payer.
    if (withinDailyCeiling(cfg.targetLamports - balances.feePayerLamports, day.lamportsToFeePayer) === 0n) {
      throw new Refusal("daily_sol_ceiling", "the daily ceiling on SOL moved into the fee payer is reached");
    }
    const plan = planSwap({ ...balances, swapsLast24h: day.swapAttempts, microUsdcPerSol }, cfg);
    if (plan.action === "refuse") throw new Refusal(plan.code, plan.reason);
    return { balances, plan };
  };

  try {
    let balances = await readBalances(conn, cfg);
    report.before = balancesForReport(balances);

    // Independent of Jupiter. Null when it cannot be trusted right now.
    const microUsdcPerSol = await readReferencePrice(conn, nowSeconds()).catch((error) => {
      if (error instanceof Refusal) return null;
      throw error;
    });
    report.referenceUsdcPerSol = microUsdcPerSol ? usdc(microUsdcPerSol) : null;

    const { lamportsSpent, lamportsUncovered, usdcReceived, ...rest } = await reconcileFeePayer(conn, cfg, nowSeconds(), microUsdcPerSol);
    watch = rest;
    report.reconcile = { ...rest, feePayerSolSpent: sol(lamportsSpent), feePayerSolUncovered: sol(lamportsUncovered), usdcReceived: usdc(usdcReceived) };

    if (watch.drainSuspected) {
      // Nothing is refilled. If the float is being drained, losing what is left of it is the
      // bounded loss; topping it up from the collected USDC would not be. The wallet app
      // falls back to its own path when the relayer runs dry.
      report.outcome = "halted";
      report.alert = "drain_suspected";
      exitCode = EXIT.drainSuspected;
    } else {
      balances = await settle(balances);

      if (balances.feePayerLamports <= cfg.refillBelowLamports) {
        await proveFeePayer(balances);
        if (!microUsdcPerSol) throw new Refusal("no_price", "no usable reference SOL price, so no quote can be checked");
        needTime(SWAP_WAIT_MS + 30_000, "swap");
        const { plan } = cfg.dryRun ? { plan: await dryPlan(balances, microUsdcPerSol) } : await swapPlan(microUsdcPerSol);
        if (plan.action === "swap") {
          const order = await fetchOrder(fetchFn, cfg, plan.usdcAmount);
          const quote = checkOrder(order, { usdcAmount: plan.usdcAmount, taker: cfg.wallet.publicKey }, microUsdcPerSol, cfg, nowSeconds());
          const checked = await checkTransaction(conn, quote, cfg.wallet.publicKey, cfg, nowSeconds());
          const action = {
            type: "swap",
            usdcQuoted: usdc(quote.inAmount),
            minSolQuoted: sol(quote.minLamports),
            simulatedSol: sol(checked.lamports),
            router: order.router,
            cappedBelowNeed: plan.capped,
          };
          report.actions.push(action);

          if (cfg.dryRun) {
            action.wouldSwap = true;
            await settle({ ...balances, usdc: balances.usdc - checked.usdcSpent, walletLamports: balances.walletLamports + checked.lamports });
          } else {
            // Once more, immediately before signing: if another run or a person moved
            // anything since the plan was made, the amounts no longer hold.
            const again = await swapPlan(microUsdcPerSol);
            if (again.plan.action !== "swap" || again.plan.usdcAmount !== plan.usdcAmount) {
              throw new Refusal("state_changed", "balances or counters changed while the order was being checked");
            }
            // The price too: the first reading may be minutes old by now. A fresh one is read
            // and validated, and the order must still pass against it and the operator's bound.
            const freshPrice = await readReferencePrice(conn, nowSeconds());
            report.referenceUsdcPerSolAtSigning = usdc(freshPrice);
            checkOrder(order, { usdcAmount: plan.usdcAmount, taker: cfg.wallet.publicKey }, freshPrice, cfg, nowSeconds());
            Object.assign(action, await submitSwap(deps, cfg, quote));
            sentByThisRun.add(action.signature);
            balances = await settle(await readBalances(conn, cfg));
          }
        }
      }
      if (report.actions.length > 0) report.outcome = cfg.dryRun ? "dry_run" : "done";
    }
  } catch (error) {
    if (error instanceof Refusal) {
      report.outcome = "refused";
      report.refusal = error.code;
      exitCode = EXIT.refused;
    } else if (error instanceof UnknownOutcome) {
      report.outcome = "unknown";
      report.pendingSignature = error.signature ?? null;
      exitCode = EXIT.unknown;
    } else {
      report.outcome = "failed";
      if (error instanceof Failed) report.failedSignature = error.signature ?? null;
      exitCode = EXIT.failed;
    }
    report.reason = error.message;
  }

  report.after = balancesForReport(await readBalances(conn, cfg).catch(() => null));
  return { exitCode, report };

  /** The dry-run plan works on projected balances, with the day read from the chain. */
  async function dryPlan(balances, microUsdcPerSol) {
    const day = await walletLast24h(conn, cfg, nowSeconds(), sentByThisRun);
    report.swapsLast24h = day.swapAttempts;
    const plan = planSwap({ ...balances, swapsLast24h: day.swapAttempts, microUsdcPerSol }, cfg);
    if (plan.action === "refuse") throw new Refusal(plan.code, plan.reason);
    return plan;
  }
}
