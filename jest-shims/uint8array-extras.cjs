// CJS shim for uint8array-extras (ESM-only package) — used by Jest test runner only.
// Generated from the original index.js with ESM exports converted to CommonJS.
'use strict';

const original = (() => {
  // Inline the full implementation using Buffer which is always CJS-safe in Node
  function isUint8Array(value) { return value instanceof Uint8Array; }
  function assertUint8Array(value) { if (!isUint8Array(value)) throw new TypeError(`Expected Uint8Array, got ${typeof value}`); }
  function assertUint8ArrayOrArrayBuffer(value) { if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new TypeError(`Expected Uint8Array or ArrayBuffer, got ${typeof value}`); }
  function toUint8Array(value) { if (value instanceof ArrayBuffer) return new Uint8Array(value); if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength); throw new TypeError(`Unsupported value, got ${typeof value}`); }
  function concatUint8Arrays(arrays, totalLength) {
    if (totalLength === undefined) totalLength = arrays.reduce((acc, a) => acc + a.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const a of arrays) { result.set(a, offset); offset += a.length; }
    return result;
  }
  function areUint8ArraysEqual(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  function compareUint8Arrays(a, b) { for (let i = 0, len = Math.min(a.length, b.length); i < len; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return a.length - b.length; }
  function uint8ArrayToString(array, encoding = 'utf8') { return Buffer.from(array).toString(encoding); }
  function stringToUint8Array(string) { return new TextEncoder().encode(string); }
  function uint8ArrayToBase64(array, {urlSafe = false} = {}) { const b64 = Buffer.from(array).toString('base64'); return urlSafe ? b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'') : b64; }
  function base64ToUint8Array(b64) { return new Uint8Array(Buffer.from(b64, 'base64')); }
  function stringToBase64(string, opts) { return uint8ArrayToBase64(stringToUint8Array(string), opts); }
  function base64ToString(b64) { return Buffer.from(b64, 'base64').toString('utf8'); }
  function uint8ArrayToHex(array) { return Buffer.from(array).toString('hex'); }
  function hexToUint8Array(hex) { return new Uint8Array(Buffer.from(hex, 'hex')); }
  function getUintBE(view) {
    let result = 0n;
    for (let i = 0; i < view.byteLength; i++) result = (result << 8n) | BigInt(view[i]);
    return result;
  }
  function indexOf(array, value) {
    for (let i = 0; i <= array.length - value.length; i++) {
      if (areUint8ArraysEqual(array.subarray(i, i + value.length), value)) return i;
    }
    return -1;
  }
  function includes(array, value) { return indexOf(array, value) !== -1; }
  return { isUint8Array, assertUint8Array, assertUint8ArrayOrArrayBuffer, toUint8Array, concatUint8Arrays, areUint8ArraysEqual, compareUint8Arrays, uint8ArrayToString, stringToUint8Array, uint8ArrayToBase64, base64ToUint8Array, stringToBase64, base64ToString, uint8ArrayToHex, hexToUint8Array, getUintBE, indexOf, includes };
})();

module.exports = original;
