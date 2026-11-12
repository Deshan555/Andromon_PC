// Droid Desk — wireless ADB (Android 11+ "Wireless debugging"), main process.
//
// Pairing (once per phone): Droid Desk shows a QR code "WIFI:T:ADB;S:<name>;P:<password>;;".
// The phone's Settings › Developer options › Wireless debugging › "Pair device with QR code"
// scans it, then advertises an mDNS service _adb-tls-pairing._tcp named <name>. We connect to it
// over TLS 1.3 and run adb's pairing protocol: SPAKE2 (BoringSSL's Ed25519 variant) on the
// password + TLS exported key material, then exchange encrypted PeerInfo (our adb public key for
// the phone's GUID). "Pair with code" is the same with the 6-digit code as password.
//
// Connecting: the phone advertises _adb-tls-connect._tcp named after its GUID. We open TCP; the
// renderer's adb library (Tango) speaks ADB through us. When the phone answers CNXN with STLS, we
// answer STLS and upgrade the socket to TLS with our paired key (the phone checks it against its
// paired keys), then keep piping. Tango then sees the phone's CNXN and carries on as over USB.
//
// Protocol sources: AOSP packages/modules/adb (pairing_auth, pairing_connection, tls, adb.cpp,
// transport.cpp) and BoringSSL crypto/curve25519/spake25519.cc.
"use strict";
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { createIdentity } = require("./localsend.js");

// ---------------- Ed25519 group arithmetic (BigInt; only used during pairing) ----------------
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n; // prime subgroup order
const mod = (a, m = P) => ((a % m) + m) % m;
function powm(b, e, m = P) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
const inv = (a) => powm(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = powm(2n, (P - 1n) / 4n);
const ZERO = { X: 0n, Y: 1n, Z: 1n, T: 0n };
const leToBig = (buf) => { let n = 0n; for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]); return n; };
const bigToLe = (n, len) => { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) { b[i] = Number(n & 0xffn); n >>= 8n; } return b; };

function ptAdd(p, q) { // extended coordinates, a = -1 (RFC 8032 §5.1.4)
  const A = mod((p.Y - p.X) * (q.Y - q.X)), B = mod((p.Y + p.X) * (q.Y + q.X));
  const C = mod(2n * D * p.T * q.T), DD = mod(2n * p.Z * q.Z);
  const E = B - A, F = DD - C, G = DD + C, H = B + A;
  return { X: mod(E * F), Y: mod(G * H), Z: mod(F * G), T: mod(E * H) };
}
const ptNeg = (p) => ({ X: mod(-p.X), Y: p.Y, Z: p.Z, T: mod(-p.T) });
// Works for any scalar size (the protocol uses scalars up to 8·l, with small-order components).
function ptMul(k, p) { let r = ZERO, q = p; while (k > 0n) { if (k & 1n) r = ptAdd(r, q); q = ptAdd(q, q); k >>= 1n; } return r; }
function ptEncode(p) {
  const zi = inv(p.Z), x = mod(p.X * zi), y = mod(p.Y * zi);
  const b = bigToLe(y, 32); if (x & 1n) b[31] |= 0x80; return b;
}
function ptDecode(bytes) {
  const b = Buffer.from(bytes); const sign = b[31] >> 7; b[31] &= 0x7f;
  const y = leToBig(b); if (y >= P) throw new Error("bad point");
  const u = mod(y * y - 1n), v = mod(D * y * y + 1n);
  let x = mod(u * powm(v, 3n) * powm(u * powm(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1); else if (vx2 !== u) throw new Error("point not on curve");
  if (x === 0n && sign) throw new Error("bad point");
  if (Number(x & 1n) !== sign) x = mod(-x);
  return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}
const BASE = ptDecode(bigToLe(mod(4n * inv(5n)), 32));
// BoringSSL spake25519.cc: M and N ("edwards25519 point generation seed (M)" / "(N)").
const SPAKE_M = ptDecode(Buffer.from("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e", "hex"));
const SPAKE_N = ptDecode(Buffer.from("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778", "hex"));

/** SPAKE2 as BoringSSL implements it, in the "alice" role (adb's pairing client). */
function spake2Alice(password, myName, theirName) {
  const priv = mod(leToBig(crypto.randomBytes(64)), L) * 8n; // x25519_sc_reduce, then left_shift_3
  const pwHash = crypto.createHash("sha512").update(password).digest();
  let ps = mod(leToBig(pwHash), L);
  // BoringSSL's "password scalar hack": make it a multiple of 8 by adding l, 2l, 4l.
  if (ps & 1n) ps += L;
  if (ps & 2n) ps += 2n * L;
  if (ps & 4n) ps += 4n * L;
  const myMsg = ptEncode(ptAdd(ptMul(priv, BASE), ptMul(ps, SPAKE_M)));
  return {
    msg: myMsg,
    finish(theirMsg) {
      if (theirMsg.length !== 32) throw new Error("bad SPAKE2 message");
      const q = ptAdd(ptDecode(theirMsg), ptNeg(ptMul(ps, SPAKE_N)));
      const dh = ptEncode(ptMul(priv, q));
      const h = crypto.createHash("sha512");
      for (const part of [myName, theirName, myMsg, theirMsg, dh, pwHash]) {
        const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(part.length)); h.update(len); h.update(part);
      }
      return h.digest(); // 64 bytes
    },
  };
}

// ---------------- our adb key ----------------
// Normally the same RSA key Droid Desk uses over USB (the renderer hands it over with setKey), so a
// phone that already trusts this computer over USB ("Always allow") accepts it over Wi‑Fi too, and
// pairing adds that same key. A file key is only a fallback if the renderer hasn't sent one.
let keyCache = null;
function setKey(pkcs8) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyDetails?.modulusLength !== 2048) throw new Error("Unsupported key");
  const id = createIdentity({ publicKey, privateKey }, "Droid Desk");
  keyCache = { key: id.key, cert: id.cert, pubString: adbPublicKeyString(publicKey, `droiddesk@${os.hostname().replace(/\.local$/, "")}`) };
}
function adbKey(userData) {
  if (keyCache) return keyCache;
  const file = path.join(userData, "wireless-adb-key.json");
  let j = null;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); new crypto.X509Certificate(j.cert); } catch { j = null; }
  if (!j) {
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const id = createIdentity(pair, "Droid Desk ADB");
    j = { key: id.key, cert: id.cert };
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j), { mode: 0o600 });
  }
  const pub = crypto.createPublicKey(j.key);
  keyCache = { key: j.key, cert: j.cert, pubString: adbPublicKeyString(pub, `droiddesk@${os.hostname().replace(/\.local$/, "")}`) };
  return keyCache;
}

/** adb's public key format: base64 of Android's RSA public key struct, a space, then a name. */
function adbPublicKeyString(pub, name) {
  const jwk = pub.export({ format: "jwk" });
  const n = leToBig(Buffer.from(jwk.n, "base64url").reverse());
  const e = Number(leToBig(Buffer.from(jwk.e, "base64url").reverse()));
  const words = 64; // 2048 bits
  const buf = Buffer.alloc(4 + 4 + 256 + 256 + 4);
  buf.writeUInt32LE(words, 0);
  const n0 = n & 0xffffffffn;
  const n0inv = (2n ** 32n - powm(n0, 2n ** 31n - 1n, 2n ** 32n)) % 2n ** 32n; // -1/n mod 2^32 (n0 odd: inverse = n0^(2^31-1))
  buf.writeUInt32LE(Number(n0inv), 4);
  bigToLe(n, 256).copy(buf, 8);
  bigToLe((2n ** 4096n) % n, 256).copy(buf, 264); // R² mod n, R = 2^2048
  buf.writeUInt32LE(e, 520);
  return `${buf.toString("base64")} ${name}`;
}

// ---------------- pairing ----------------
const PAIR_VERSION = 1, SPAKE2_MSG = 0, PEER_INFO = 1, PEER_INFO_SIZE = 8192;
const CLIENT_NAME = Buffer.from("adb pair client\0"), SERVER_NAME = Buffer.from("adb pair server\0");

/** A tiny reader over a socket: read(n) resolves with exactly n bytes. */
function socketReader(sock) {
  let buf = Buffer.alloc(0), waiter = null, ended = null;
  const check = () => {
    if (!waiter) return;
    if (buf.length >= waiter.n) { const out = buf.subarray(0, waiter.n); buf = buf.subarray(waiter.n); const w = waiter; waiter = null; w.resolve(out); }
    else if (ended) { const w = waiter; waiter = null; w.reject(ended); }
  };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); check(); });
  sock.on("end", () => { ended = new Error("The phone closed the connection"); check(); });
  sock.on("error", (e) => { ended = e; check(); });
  return (n) => new Promise((resolve, reject) => { waiter = { n, resolve, reject }; check(); });
}

/**
 * Pairs with a phone's pairing service. [password]: the QR password or the 6-digit code.
 * Resolves with the phone's GUID (its _adb-tls-connect mDNS name, e.g. "adb-R58M12ABCDE-a1b2c3").
 */
async function pair({ host, port, password, userData, timeoutMs = 20_000 }) {
  const id = adbKey(userData);
  const sock = tls.connect({ host, port, cert: id.cert, key: id.key, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
  const timer = setTimeout(() => sock.destroy(new Error("Pairing timed out")), timeoutMs);
  try {
    await new Promise((resolve, reject) => { sock.once("secureConnect", resolve); sock.once("error", reject); });
    const read = socketReader(sock);
    const ekm = sock.exportKeyingMaterial(64, "adb-label\0");
    const spake = spake2Alice(Buffer.concat([Buffer.from(password, "utf8"), ekm]), CLIENT_NAME, SERVER_NAME);
    const header = (type, len) => { const h = Buffer.alloc(6); h[0] = PAIR_VERSION; h[1] = type; h.writeUInt32BE(len, 2); return h; };
    const readPacket = async (type) => {
      const h = await read(6);
      if (h[0] !== PAIR_VERSION || h[1] !== type) throw new Error("Unexpected reply from the phone");
      const len = h.readUInt32BE(2);
      if (!len || len > PEER_INFO_SIZE * 2) throw new Error("Bad packet from the phone");
      return read(len);
    };
    // Both sides send first, then read.
    sock.write(Buffer.concat([header(SPAKE2_MSG, spake.msg.length), spake.msg]));
    const key = spake.finish(await readPacket(SPAKE2_MSG));
    const aesKey = Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from("adb pairing_auth aes-128-gcm key"), 16));
    const nonce = (counter) => { const n = Buffer.alloc(12); n.writeBigUInt64LE(BigInt(counter)); return n; };

    const info = Buffer.alloc(PEER_INFO_SIZE);
    info[0] = 0; // ADB_RSA_PUB_KEY
    Buffer.from(id.pubString).copy(info, 1);
    const c = crypto.createCipheriv("aes-128-gcm", aesKey, nonce(0));
    const sealed = Buffer.concat([c.update(info), c.final(), c.getAuthTag()]);
    sock.write(Buffer.concat([header(PEER_INFO, sealed.length), sealed]));

    const theirs = await readPacket(PEER_INFO).catch((e) => {
      throw /closed|ECONNRESET/i.test(e.message) ? new Error("Wrong pairing code (the phone closed the connection)") : e;
    });
    const d = crypto.createDecipheriv("aes-128-gcm", aesKey, nonce(0));
    d.setAuthTag(theirs.subarray(theirs.length - 16));
    let peer;
    try { peer = Buffer.concat([d.update(theirs.subarray(0, theirs.length - 16)), d.final()]); }
    catch { throw new Error("Wrong pairing code"); }
    if (peer.length !== PEER_INFO_SIZE || peer[0] !== 1) throw new Error("The phone sent unexpected pairing data");
    const end = peer.indexOf(0, 1);
    return peer.subarray(1, end < 0 ? undefined : end).toString("utf8");
  } finally {
    clearTimeout(timer);
    sock.destroy();
  }
}

// ---------------- connection: TCP, then TLS when the phone asks for it (STLS) ----------------
const A_STLS = 0x534c5453, A_STLS_VERSION = 0x01000000;

/**
 * Opens an ADB link to host:port. The caller writes/reads raw ADB bytes (Tango's packets).
 * Returns { write(buf), close() }. [onData] gets plaintext bytes, [onClose] the end (with error).
 */
function openLink({ host, port, userData, onData, onClose }) {
  const id = adbKey(userData);
  const raw = net.connect({ host, port });
  raw.setNoDelay(true);
  raw.setKeepAlive(true, 15_000); // notice a phone that left the network instead of waiting forever
  let stream = raw, state = "plain", pending = Buffer.alloc(0), queue = [], closed = false;
  const close = (err) => {
    if (closed) return; closed = true;
    try { stream.destroy(); } catch {} try { raw.destroy(); } catch {}
    onClose(err);
  };
  raw.on("error", (e) => close(e));
  raw.on("close", () => { if (state !== "upgrading") close(); });
  const plainData = (chunk) => {
    // Forward whole packets, watching for STLS (24-byte header, no payload).
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 24) {
      const cmd = pending.readUInt32LE(0), len = pending.readUInt32LE(12);
      if (cmd === A_STLS) {
        pending = pending.subarray(24 + len);
        return upgrade();
      }
      if (pending.length < 24 + len) break;
      onData(pending.subarray(0, 24 + len));
      pending = pending.subarray(24 + len);
    }
  };
  raw.on("data", plainData);
  const upgrade = () => {
    state = "upgrading";
    raw.removeListener("data", plainData);
    const h = Buffer.alloc(24);
    h.writeUInt32LE(A_STLS, 0); h.writeUInt32LE(A_STLS_VERSION, 4); h.writeUInt32LE(0, 8); h.writeUInt32LE(0, 12); h.writeUInt32LE(0, 16);
    h.writeInt32LE(~A_STLS, 20);
    raw.write(h);
    const t = tls.connect({ socket: raw, cert: id.cert, key: id.key, rejectUnauthorized: false, minVersion: "TLSv1.3" });
    stream = t;
    t.on("secureConnect", () => {
      state = "tls";
      for (const b of queue) t.write(b);
      queue = [];
    });
    t.on("data", (d) => onData(d));
    t.on("error", (e) => close(/alert|certificate|handshake|ECONNRESET/i.test(e.message)
      ? new Error("The phone refused this computer. Pair it again from the Wi‑Fi dialog.") : e));
    t.on("close", () => close(state === "upgrading" ? new Error("The phone refused this computer. Pair it again from the Wi‑Fi dialog.") : undefined));
  };
  return {
    write(buf) {
      if (closed) return;
      if (state === "plain") raw.write(buf);
      else if (state === "upgrading") queue.push(Buffer.from(buf));
      else stream.write(buf);
    },
    close: () => close(),
    connected: new Promise((resolve, reject) => { raw.once("connect", resolve); raw.once("error", reject); }),
  };
}

// ---------------- mDNS (DNS-SD) browsing for _adb-tls-pairing / _adb-tls-connect ----------------
const PAIRING_TYPE = "_adb-tls-pairing._tcp.local", CONNECT_TYPE = "_adb-tls-connect._tcp.local";

function encodeName(name) {
  return Buffer.concat([...name.split(".").filter(Boolean).map((l) => { const b = Buffer.from(l); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
}
function readName(msg, off) {
  const labels = []; let jumped = false, end = off, guard = 0;
  while (guard++ < 128) {
    const len = msg[off];
    if (len === undefined) throw new Error("truncated");
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; jumped = true; off = ((len & 0x3f) << 8) | msg[off + 1]; continue; }
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("utf8")); off += 1 + len;
  }
  return { name: labels.join("."), end: jumped ? end : off };
}
function parseDns(msg) {
  const qd = msg.readUInt16BE(4), rrCount = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(msg, off).end + 4;
  const rrs = [];
  for (let i = 0; i < rrCount; i++) {
    const n = readName(msg, off); off = n.end;
    const type = msg.readUInt16BE(off), len = msg.readUInt16BE(off + 8), data = off + 10; off = data + len;
    const rr = { name: n.name.toLowerCase(), rawName: n.name, type };
    if (type === 12) rr.target = readName(msg, data).name;             // PTR
    else if (type === 33) { rr.port = msg.readUInt16BE(data + 4); rr.target = readName(msg, data + 6).name.toLowerCase(); } // SRV
    else if (type === 1 && len === 4) rr.address = [...msg.subarray(data, data + 4)].join(".");   // A
    rrs.push(rr);
  }
  return rrs;
}

/** Browses both adb service types; emits the current list of services on every change. */
class AdbMdns {
  constructor(onChange) { this.onChange = onChange; this.services = new Map(); this.hosts = new Map(); this.sockets = []; }
  start() {
    if (this.sockets.length) return;
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
    const open = (port) => new Promise((resolve) => {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      s.on("error", () => resolve(null));
      s.on("message", (m, rinfo) => { try { this.ingest(parseDns(m), rinfo.address); } catch {} });
      s.bind(port, () => {
        if (port === 5353) for (const a of ifaces) { try { s.addMembership("224.0.0.251", a.address); } catch {} }
        resolve(s);
      });
    });
    // Port 5353 hears every answer on the network; an ephemeral port gets direct (unicast) answers
    // in case 5353 can't be shared on this computer.
    Promise.all([open(5353), open(0)]).then((socks) => {
      this.sockets = socks.filter(Boolean);
      this.query();
      this.timer = setInterval(() => this.query(), 1500);
    });
  }
  stop() { clearInterval(this.timer); for (const s of this.sockets) try { s.close(); } catch {} this.sockets = []; }
  query() {
    const q = (name) => Buffer.concat([encodeName(name), Buffer.from([0, 12, 0, 1])]);
    const msg = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]), q(PAIRING_TYPE), q(CONNECT_TYPE)]);
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
    for (const s of this.sockets) {
      for (const a of ifaces) { try { s.setMulticastInterface(a.address); s.send(msg, 5353, "224.0.0.251"); } catch {} }
    }
  }
  ingest(rrs, from) {
    let changed = false;
    for (const rr of rrs) {
      if (rr.type === 12 && (rr.name === PAIRING_TYPE || rr.name === CONNECT_TYPE)) {
        const key = rr.target.toLowerCase();
        if (!this.services.has(key)) {
          this.services.set(key, { kind: rr.name === PAIRING_TYPE ? "pairing" : "connect", name: rr.target.split(".")[0], from });
          changed = true;
        }
      }
    }
    for (const rr of rrs) {
      if (rr.type === 33 && this.services.has(rr.name)) {
        const s = this.services.get(rr.name);
        if (s.port !== rr.port || s.target !== rr.target) { s.port = rr.port; s.target = rr.target; changed = true; }
      }
      // A host can have several addresses (one per interface): keep them all.
      if (rr.type === 1) { if (!this.hosts.has(rr.name)) this.hosts.set(rr.name, new Set()); this.hosts.get(rr.name).add(rr.address); }
    }
    const mine = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
    const sameSubnet = (ip) => mine.some((a) => {
      const n = (x) => x.split(".").reduce((v, o) => (v << 8) + Number(o), 0) >>> 0;
      const mask = n(a.netmask);
      return (n(ip) & mask) === (n(a.address) & mask);
    });
    for (const s of this.services.values()) {
      // Prefer an address on this computer's network; otherwise where the announcement came from.
      const addrs = [...(this.hosts.get(s.target) || [])];
      const addr = addrs.find(sameSubnet) || (sameSubnet(s.from) ? s.from : addrs[0] || s.from);
      if (s.host !== addr) { s.host = addr; changed = true; }
      s.seen = Date.now();
    }
    if (changed) this.onChange(this.list());
  }
  list() { return [...this.services.values()].filter((s) => s.port && s.host && Date.now() - s.seen < 60_000); }
  find(kind, name) { return this.list().find((s) => s.kind === kind && s.name === name) || null; }
}

/** Waits for an mDNS service of [kind] named [name] (or any, if name is null). */
function waitForService(mdns, kind, name, timeoutMs, cancelled) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    const tick = () => {
      // name: exact service name, or a function (e.g. "starts with adb-<serial>-")
      const s = typeof name === "function" ? mdns.list().find((x) => x.kind === kind && name(x.name))
        : name ? mdns.find(kind, name) : mdns.list().find((x) => x.kind === kind);
      if (s) return resolve(s);
      if (cancelled?.()) return reject(new Error("Cancelled"));
      if (Date.now() > until) return reject(new Error(kind === "pairing" ? "The phone didn't show up. Scan the QR code in Wireless debugging › Pair device with QR code, on the same Wi‑Fi." : "Couldn't find the phone on the network. Make sure Wireless debugging is on and the phone is on the same Wi‑Fi."));
      setTimeout(tick, 300);
    };
    tick();
  });
}

/** Random QR pairing details in Android Studio's format. */
function newQr() {
  const alpha = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => alpha[b % alpha.length]).join("");
  const name = `studio-${pick(8)}`, password = pick(10);
  return { name, password, text: `WIFI:T:ADB;S:${name};P:${password};;` };
}

/** "adb-R58M12ABCDE-a1b2c3" -> "R58M12ABCDE" (phones advertise adb-<serial>-<random>). */
const serialOfService = (name) => String(name).replace(/^adb-/, "").replace(/-[^-]*$/, "");

module.exports = { pair, openLink, AdbMdns, waitForService, newQr, adbKey, setKey, serialOfService, _test: { spake2Alice, ptDecode, ptEncode, ptMul, BASE, SPAKE_M, SPAKE_N, L, leToBig, adbPublicKeyString } };
