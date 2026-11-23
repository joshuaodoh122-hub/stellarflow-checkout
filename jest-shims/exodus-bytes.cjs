/**
 * jest-shims/exodus-bytes.cjs
 *
 * CJS shim for @exodus/bytes (ESM-only package).
 * Used ONLY by the Jest test runner to satisfy require() calls from
 * @stellar/stellar-sdk's CJS build. Production code uses the real package
 * via Node's ESM loader.
 *
 * Implements only the exports used by @stellar/stellar-sdk:
 *   @exodus/bytes/base32.js: fromBase32, fromBase32crockford, toBase32
 *
 * RFC 4648 base32 (standard alphabet A-Z 2-7, no padding by default).
 */
'use strict';

// ─── RFC 4648 base32 (standard alphabet) ─────────────────────────────────────

const ALPHABET_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DECODE_STD = new Uint8Array(256).fill(0xff);
for (let i = 0; i < ALPHABET_STD.length; i++) DECODE_STD[ALPHABET_STD.charCodeAt(i)] = i;

const ALPHABET_HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV';
const DECODE_HEX = new Uint8Array(256).fill(0xff);
for (let i = 0; i < ALPHABET_HEX.length; i++) DECODE_HEX[ALPHABET_HEX.charCodeAt(i)] = i;

const ALPHABET_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECODE_CROCKFORD = new Uint8Array(256).fill(0xff);
for (let i = 0; i < ALPHABET_CROCKFORD.length; i++) DECODE_CROCKFORD[ALPHABET_CROCKFORD.charCodeAt(i)] = i;

function encodeBase32(data, alphabet) {
  const bytes = data instanceof Uint8Array ? data : Buffer.from(data);
  let result = '';
  let bits = 0, value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 0x1f];
  return result;
}

function decodeBase32(str, decode) {
  const s = str.replace(/=/g, '').toUpperCase();
  const bytes = [];
  let bits = 0, value = 0;
  for (let i = 0; i < s.length; i++) {
    const v = decode[s.charCodeAt(i)];
    if (v === 0xff) throw new SyntaxError(`Invalid character in base32: ${s[i]}`);
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

// ─── @exodus/bytes/base32.js exports ─────────────────────────────────────────
// The stellar-sdk CJS build uses: fromBase32(str, opts), toBase32(arr, opts)

function fromBase32(str, opts) {
  // opts: { padding?: bool | 'both', format?: 'uint8' | 'buffer' }
  const stripped = typeof str === 'string' ? str.replace(/=/g, '') : str;
  return decodeBase32(stripped, DECODE_STD);
}

function fromBase32hex(str, opts) {
  const stripped = typeof str === 'string' ? str.replace(/=/g, '') : str;
  return decodeBase32(stripped, DECODE_HEX);
}

function fromBase32crockford(str, opts) {
  const stripped = typeof str === 'string' ? str.replace(/=/g, '') : str;
  return decodeBase32(stripped, DECODE_CROCKFORD);
}

function toBase32(arr, opts) {
  // opts: { padding?: bool }
  return encodeBase32(arr, ALPHABET_STD);
}

function toBase32hex(arr, opts) {
  return encodeBase32(arr, ALPHABET_HEX);
}

function toBase32crockford(arr, opts) {
  return encodeBase32(arr, ALPHABET_CROCKFORD);
}

module.exports = {
  fromBase32,
  fromBase32hex,
  fromBase32crockford,
  toBase32,
  toBase32hex,
  toBase32crockford,
};
