// String tables out of compiled code, for the security scan: every string constant, class, method and
// field name in a .dex file, and printable text runs in native libraries (Flutter's libapp.so).

const utf8 = new TextDecoder("utf-8", { fatal: false });

/** Calls onString(s) for each string in a .dex file's string pool. Returns the count. */
export function dexStrings(bytes, onString) {
  if (bytes.length < 0x70 || bytes[0] !== 0x64 || bytes[1] !== 0x65 || bytes[2] !== 0x78) return 0; // "dex"
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0x38, true), idsOff = dv.getUint32(0x3c, true);
  if (idsOff + count * 4 > bytes.length) return 0;
  for (let i = 0; i < count; i++) {
    let p = dv.getUint32(idsOff + i * 4, true);
    if (p >= bytes.length) continue;
    // uleb128 length in UTF-16 units (skipped), then MUTF-8 bytes up to a 0 byte.
    while (p < bytes.length && bytes[p] & 0x80) p++;
    p++;
    let e = p;
    while (e < bytes.length && bytes[e] !== 0) e++;
    if (e > p) onString(utf8.decode(bytes.subarray(p, e)));
  }
  return count;
}

/** Calls onString(s) for runs of printable ASCII at least `min` long (like `strings`). Stops at `limit` bytes. */
export function asciiStrings(bytes, onString, min = 8, limit = 64 * 1024 * 1024) {
  const n = Math.min(bytes.length, limit);
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const b = i < n ? bytes[i] : 0;
    if (b >= 0x20 && b < 0x7f) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= min) onString(String.fromCharCode.apply(null, bytes.subarray(start, Math.min(i, start + 4096))));
    start = -1;
  }
}
