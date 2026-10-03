const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bytes as base58, the way Solana writes signatures and addresses. */
export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  for (; value > 0n; value /= 58n) encoded = ALPHABET[Number(value % 58n)] + encoded;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) encoded = `1${encoded}`;
  return encoded;
}
