import assert from "node:assert/strict";
import { test } from "node:test";
import { floorLamports, lamportsToMicroUsdc, MAX_MARKUP_BPS, splitFor, withBuffer } from "../src/split.mjs";

const parts = (cost, bps) => {
  const { markup, platformShare, platform, customer } = splitFor(cost, bps);
  return { markup, platformShare, platform, customer };
};

test("the documented example: 50 percent markup on 1,600 micro-USDC", () => {
  assert.deepEqual(parts(1_600n, 5_000), { markup: 800n, platformShare: 160n, platform: 1_760n, customer: 640n });
});

test("a markup of zero charges the network cost and nothing else", () => {
  assert.deepEqual(parts(1_600n, 0), { markup: 0n, platformShare: 0n, platform: 1_600n, customer: 0n });
  assert.deepEqual(parts(0n, 0), { markup: 0n, platformShare: 0n, platform: 0n, customer: 0n });
});

test("the markup rounds up to a whole micro-USDC", () => {
  // 1 * 1 / 10000 is far below one unit and still costs one.
  assert.equal(splitFor(1n, 1).markup, 1n);
  assert.equal(splitFor(9_999n, 1).markup, 1n);
  assert.equal(splitFor(10_000n, 1).markup, 1n);
  assert.equal(splitFor(10_001n, 1).markup, 2n);
  // Exact multiples do not round.
  assert.equal(splitFor(20_000n, 1).markup, 2n);
  assert.equal(splitFor(3n, 3_333).markup, 1n);
  assert.equal(splitFor(3n, 3_334).markup, 2n);
});

test("our share is a fifth of the markup, rounded up, and the customer gets the rest", () => {
  const shares = (markup) => {
    // A markup of exactly `markup`: cost equal to it at 100 percent.
    const { platformShare, customer } = splitFor(markup, 10_000);
    return [platformShare, customer];
  };
  assert.deepEqual(shares(0n), [0n, 0n]);
  assert.deepEqual(shares(1n), [1n, 0n]);
  assert.deepEqual(shares(2n), [1n, 1n]);
  assert.deepEqual(shares(4n), [1n, 3n]);
  assert.deepEqual(shares(5n), [1n, 4n]);
  assert.deepEqual(shares(6n), [2n, 4n]);
  assert.deepEqual(shares(10n), [2n, 8n]);
  assert.deepEqual(shares(11n), [3n, 8n]);
});

test("a tiny network cost: the customer share can be zero while ours is not", () => {
  assert.deepEqual(parts(1n, 5_000), { markup: 1n, platformShare: 1n, platform: 2n, customer: 0n });
  assert.deepEqual(parts(2n, 5_000), { markup: 1n, platformShare: 1n, platform: 3n, customer: 0n });
  assert.deepEqual(parts(3n, 5_000), { markup: 2n, platformShare: 1n, platform: 4n, customer: 1n });
});

test("at the cap the markup is three times the cost", () => {
  assert.deepEqual(parts(1_600n, MAX_MARKUP_BPS), { markup: 4_800n, platformShare: 960n, platform: 2_560n, customer: 3_840n });
  assert.deepEqual(parts(1n, MAX_MARKUP_BPS), { markup: 3n, platformShare: 1n, platform: 2n, customer: 2n });
});

test("above the cap, below zero or not a whole number is not a markup", () => {
  assert.throws(() => splitFor(1_600n, MAX_MARKUP_BPS + 1), RangeError);
  assert.throws(() => splitFor(1_600n, -1), RangeError);
  assert.throws(() => splitFor(1_600n, 12.5), RangeError);
  assert.throws(() => splitFor(1_600n, "5000"), RangeError);
});

test("amounts are bigints or nothing: a float never enters", () => {
  assert.throws(() => splitFor(1600, 5_000), TypeError);
  assert.throws(() => splitFor(1.5, 5_000), TypeError);
  assert.throws(() => splitFor(-1n, 5_000), TypeError);
  assert.throws(() => lamportsToMicroUsdc(10_000, 150_000_000n), TypeError);
});

test("the parts always add up, for every markup and a spread of costs", () => {
  const costs = [0n, 1n, 2n, 3n, 4n, 5n, 7n, 99n, 1_499n, 1_500n, 1_600n, 99_999n, 100_000n, 18_446_744_073_709n];
  for (const cost of costs) {
    for (let bps = 0; bps <= MAX_MARKUP_BPS; bps += 7) {
      const { markup, platformShare, platform, customer } = splitFor(cost, bps);
      assert.equal(platform + customer, cost + markup);
      assert.equal(platformShare + customer, markup);
      assert.ok(customer >= 0n && platformShare >= 0n);
      // Ceilings: never under, and by less than one unit over.
      assert.ok(markup * 10_000n >= cost * BigInt(bps) && (markup - 1n) * 10_000n < cost * BigInt(bps) || markup === 0n);
      assert.ok(platformShare * 5n >= markup && (platformShare - 1n) * 5n < markup || platformShare === 0n);
    }
  }
});

test("amounts beyond what a float can hold stay exact", () => {
  const cost = 9_007_199_254_740_993n; // 2^53 + 1
  const { markup, platformShare, customer } = splitFor(cost, 10_000);
  assert.equal(markup, cost);
  assert.equal(platformShare, 1_801_439_850_948_199n);
  assert.equal(customer, cost - 1_801_439_850_948_199n);
});

test("the floor: one signature fee per signer plus the priority fee, rounded up", () => {
  assert.equal(floorLamports({ signatures: 2, computeUnitLimit: 0n, computeUnitPrice: 0n }), 10_000n);
  assert.equal(floorLamports({ signatures: 2, computeUnitLimit: 30_000n, computeUnitPrice: 0n }), 10_000n);
  assert.equal(floorLamports({ signatures: 2, computeUnitLimit: 30_000n, computeUnitPrice: 500_000n }), 25_000n);
  // 30,000 units at 1 micro-lamport is 0.03 lamports, charged as one.
  assert.equal(floorLamports({ signatures: 2, computeUnitLimit: 30_000n, computeUnitPrice: 1n }), 10_001n);
  assert.equal(floorLamports({ signatures: 2, computeUnitLimit: 1_000_000n, computeUnitPrice: 1n }), 10_001n);
  assert.equal(floorLamports({ signatures: 2, computeUnitLimit: 1_000_001n, computeUnitPrice: 1n }), 10_002n);
});

test("lamports to micro-USDC rounds up", () => {
  assert.equal(lamportsToMicroUsdc(10_000n, 150_000_000n), 1_500n);
  assert.equal(lamportsToMicroUsdc(10_001n, 150_000_000n), 1_501n); // 1500.15
  assert.equal(lamportsToMicroUsdc(1n, 150_000_000n), 1n); // 0.15
  assert.equal(lamportsToMicroUsdc(0n, 150_000_000n), 0n);
  assert.equal(lamportsToMicroUsdc(10_000n, 99_999n), 1n);
});

test("the buffer raises the cost and rounds up; zero leaves it alone", () => {
  assert.equal(withBuffer(1_600n, 0), 1_600n);
  assert.equal(withBuffer(1_600n, 200), 1_632n);
  assert.equal(withBuffer(1_601n, 200), 1_634n); // 1633.02
  assert.equal(withBuffer(1n, 1), 2n);
});
