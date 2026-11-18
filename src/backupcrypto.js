// Andromon — backups locked with a password. Every file of such a backup (and the real backup.json)
// is encrypted on this computer before it is written:
//
//   file   = "ANDRENC1" · record · record · … · final record
//   record = length (4 bytes, big-endian, of what follows the IV) · IV (12 random bytes) · AES-256-GCM(piece)
//
// Each record's associated data is its number (4 bytes) and a final flag (1 byte), so records can't
// be reordered, dropped or cut off without the file failing to open: the last record is always an
// empty one marked final. The key comes from the password with PBKDF2-SHA-256 (600 000 rounds) and
// a random salt kept in backup.json, next to a short known text sealed with the key ("check") that
// tells a wrong password apart from a damaged file. The password itself is never stored.

const MAGIC = new TextEncoder().encode("ANDRENC1");
const CHECK = "andromon-backup-key";
export const ITERATIONS = 600_000;
export const PIECE = 1 << 20;

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(String(text || "")), (c) => c.charCodeAt(0));
const aad = (n, final) => { const a = new Uint8Array(5); new DataView(a.buffer).setUint32(0, n); a[4] = final ? 1 : 0; return a; };
export const isSealed = (bytes) => bytes.length >= MAGIC.length && MAGIC.every((b, i) => bytes[i] === b);

export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** A new key for a backup, and what backup.json keeps about it. */
export async function newLock(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const check = await sealBytes(key, new TextEncoder().encode(CHECK));
  return { key, info: { cipher: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations: ITERATIONS, salt: b64(salt), check: b64(check) } };
}
/** The key for a locked backup, or null when the password is wrong. */
export async function unlock(info, password) {
  const iterations = Number(info?.iterations);
  if (!(iterations >= 100_000 && iterations <= 10_000_000)) throw new Error("This backup's lock settings aren't valid.");
  const key = await deriveKey(password, unb64(info.salt), iterations);
  try { return new TextDecoder().decode(await openBytes(key, unb64(info.check))) === CHECK ? key : null; } catch { return null; }
}

async function record(key, n, piece, final) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(n, final) }, key, piece));
  const out = new Uint8Array(4 + 12 + ct.length);
  new DataView(out.buffer).setUint32(0, 12 + ct.length); out.set(iv, 4); out.set(ct, 16);
  return out;
}
const join = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** Seals a file written in pieces: start() first, then piece() for each piece, then end(). */
export function sealer(key) {
  let n = 0;
  return {
    start: () => MAGIC.slice(),
    piece: (bytes) => record(key, n++, bytes, false),
    end: () => record(key, n++, new Uint8Array(0), true),
  };
}
export async function sealBytes(key, bytes) {
  const s = sealer(key), parts = [s.start()];
  for (let i = 0; i < bytes.length; i += PIECE) parts.push(await s.piece(bytes.subarray(i, i + PIECE)));
  parts.push(await s.end());
  return join(parts);
}

/** Opens records one by one from `read(offset, length)`; yields the plain pieces. */
export async function* openPieces(key, read) {
  const head = await read(0, MAGIC.length);
  if (!isSealed(head)) throw new Error("This file isn't encrypted the way Andromon locks backups.");
  let at = MAGIC.length, n = 0;
  for (;;) {
    const lenBytes = await read(at, 4);
    if (lenBytes.length < 4) throw new Error("This file was cut off (its end is missing).");
    const len = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0);
    if (len < 28 || len > PIECE * 2 + 64) throw new Error("This file is damaged.");
    const body = await read(at + 4, len);
    if (body.length < len) throw new Error("This file was cut off (its end is missing).");
    at += 4 + len;
    const iv = body.subarray(0, 12), ct = body.subarray(12);
    let plain, final = false;
    try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(n, false) }, key, ct); }
    catch {
      try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(n, true) }, key, ct); final = true; }
      catch { throw new Error("This file is damaged, or belongs to another backup."); }
    }
    n++;
    if (final) { if (plain.byteLength) throw new Error("This file is damaged."); return; }
    yield new Uint8Array(plain);
  }
}
export async function openBytes(key, bytes) {
  const parts = [];
  for await (const p of openPieces(key, async (o, l) => bytes.subarray(o, o + l))) parts.push(p);
  return join(parts);
}

export const toBase64 = b64;
export const fromBase64 = unb64;
