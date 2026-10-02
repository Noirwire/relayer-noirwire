// The ways a run ends badly, kept apart because the operator reacts differently to each.

/** Nothing was signed or sent: a cap, a guard or a missing balance stopped the run. Exit 2. */
export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Something was sent and the chain has not said what became of it. It may still land, so the
 * run stops here and never tries again: a second attempt could do the same thing twice. Exit 3.
 */
export class UnknownOutcome extends Error {
  constructor(what, signature) {
    super(`${what} was sent but could not be confirmed. It may still land.`);
    this.signature = signature;
  }
}

/** Something was sent and the chain (or the venue) says it did not happen. Exit 1. */
export class Failed extends Error {
  constructor(message, signature) {
    super(message);
    this.signature = signature;
  }
}

/**
 * 4 is not an error of the run itself: the chain shows the fee payer spending SOL on
 * transactions that did not pay for themselves, or the job could not prove otherwise (see
 * reconcileFeePayer). The run then moves nothing.
 */
export const EXIT = { ok: 0, failed: 1, refused: 2, unknown: 3, drainSuspected: 4 };
