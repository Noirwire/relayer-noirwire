// Amounts are bigint base units everywhere (lamports, raw USDC). Decimal strings are parsed
// by hand because a float cannot hold "0.1" exactly and these numbers move money.

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

/** "0.03" with 9 decimals -> 30000000n. Throws on anything that is not a plain decimal. */
export function parseUnits(text, decimals) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  // The value itself is never put in the message: a key pasted into the wrong variable
  // would otherwise be printed.
  if (!match) throw new Error("not a plain decimal number");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`more than ${decimals} decimals`);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 30000000n with 9 decimals -> "0.03". For the report only. */
export function formatUnits(amount, decimals) {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export const ceilDiv = (a, b) => (a + b - 1n) / b;
export const min = (...values) => values.reduce((a, b) => (b < a ? b : a));

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  for (; value > 0n; value /= 58n) encoded = ALPHABET[Number(value % 58n)] + encoded;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) encoded = `1${encoded}`;
  return encoded;
}

export function base58Decode(text) {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("not base58");
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; value > 0n; value /= 256n) bytes.unshift(Number(value % 256n));
  for (let i = 0; i < text.length && text[i] === "1"; i += 1) bytes.unshift(0);
  return Uint8Array.from(bytes);
}
