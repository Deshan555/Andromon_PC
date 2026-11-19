// SPDX-License-Identifier: GPL-3.0-only
// Andromon — API inspector (App testing › API calls). Main process only.
//
// An HTTP proxy on 127.0.0.1 that the phone uses as its system proxy (through an `adb reverse`
// set up by the page). It forwards every request and keeps a copy for display:
//  - plain HTTP (absolute-form requests) is forwarded and recorded;
//  - CONNECT (HTTPS) is either tunnelled untouched (host, port, bytes and time are recorded), or, with
//    "decrypt" on, answered with a certificate for that host signed by a local CA ("man in the middle"),
//    so requests inside can be read. Only apps that trust that CA accept it.
//  - WebSocket upgrades are passed through and recorded as one entry.
// Upstream TLS is verified normally; a failure is recorded on the entry and the phone gets an error.
//
// Certificates are made here with a minimal DER writer (no dependencies): one RSA-2048 CA, kept in
// userData/inspector-ca.json, and one shared leaf key with a cached certificate per host name.
// Only 127.0.0.1 is listened on. Nothing here may throw into the main process.

const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ENTRIES = 2000;
const MAX_BODY = 2 * 1024 * 1024; // kept per body (raw and decoded)
const MAX_KEPT = 200 * 1024 * 1024; // all kept bodies together; the oldest calls are dropped past this
const HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade"]);

// ---------------------------------------------------------------- DER / X.509
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n) { b.unshift(n & 0xff); n >>>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
const derInt = (buf) => { let i = 0; while (i < buf.length - 1 && buf[i] === 0 && !(buf[i + 1] & 0x80)) i++; buf = buf.subarray(i); return der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf); };
const derBool = (v) => der(0x01, Buffer.from([v ? 0xff : 0]));
const octet = (buf) => der(0x04, buf);
const bitString = (buf, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const utf8 = (s) => der(0x0c, Buffer.from(s, "utf8"));
function oid(s) {
  const a = s.split(".").map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const b = [v & 0x7f]; let x = Math.floor(v / 128);
    while (x) { b.unshift(0x80 | (x & 0x7f)); x = Math.floor(x / 128); }
    out.push(...b);
  }
  return der(0x06, Buffer.from(out));
}
// UTCTime up to 2049, GeneralizedTime after (RFC 5280).
const time = (d) => (d.getUTCFullYear() < 2050
  ? der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"))
  : der(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z")));
const SIG_ALG = seq(oid("1.2.840.113549.1.1.11"), der(0x05)); // sha256WithRSAEncryption
const name = (cn, o) => seq(
  ...(o ? [set(seq(oid("2.5.4.10"), utf8(o)))] : []),
  set(seq(oid("2.5.4.3"), utf8(cn.slice(0, 64)))),
);
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [derBool(true)] : []), octet(value));
const keyId = (publicKey) => crypto.createHash("sha1").update(publicKey.export({ type: "spki", format: "der" })).digest();
const toPem = (derBuf, label = "CERTIFICATE") => `-----BEGIN ${label}-----\n${derBuf.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;

function signCert({ subject, issuer, publicKey, signKey, notBefore, notAfter, extensions }) {
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 0x01;
  const tbs = seq(
    der(0xa0, derInt(Buffer.from([2]))), // v3
    derInt(serial), SIG_ALG, issuer,
    seq(time(notBefore), time(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, signKey);
  return seq(tbs, SIG_ALG, bitString(signature));
}

const CA_NAME = "Andromon API inspector CA";
function createCa() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const nm = name(CA_NAME, "Andromon");
  const ski = keyId(publicKey);
  const now = Date.now();
  const certDer = signCert({
    subject: nm, issuer: nm, publicKey, signKey: privateKey,
    notBefore: new Date(now - 86_400_000), notAfter: new Date(now + 10 * 365 * 86_400_000),
    extensions: [
      ext("2.5.29.19", true, seq(derBool(true), derInt(Buffer.from([0])))), // basicConstraints: CA, pathLen 0
      ext("2.5.29.15", true, bitString(Buffer.from([0x06]), 1)), // keyUsage: keyCertSign, cRLSign
      ext("2.5.29.14", false, octet(ski)), // subjectKeyIdentifier
    ],
  });
  return { cert: toPem(certDer), key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

function loadCa(file) {
  try {
    const ca = JSON.parse(fs.readFileSync(file, "utf8"));
    const x = new crypto.X509Certificate(ca.cert);
    if (new Date(x.validTo) > new Date(Date.now() + 30 * 86_400_000) && x.subject.includes(CA_NAME)) return ca;
  } catch {}
  const ca = createCa();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ca), { mode: 0o600 });
  return ca;
}

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const isIp = (h) => net.isIP(h) !== 0;
function ipBytes(h) {
  if (net.isIPv4(h)) return Buffer.from(h.split(".").map(Number));
  // IPv6: expand "::"
  const [a, b = ""] = h.split("::");
  const pa = a ? a.split(":") : [], pb = b ? b.split(":") : [];
  const parts = h.includes("::") ? [...pa, ...Array(8 - pa.length - pb.length).fill("0"), ...pb] : pa;
  const out = Buffer.alloc(16);
  parts.forEach((p, i) => out.writeUInt16BE(parseInt(p || "0", 16), i * 2));
  return out;
}
const pairs = (raw) => { const out = []; for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]]); return out; };
const header = (raw, n) => { n = n.toLowerCase(); for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i].toLowerCase() === n) return raw[i + 1]; return ""; };
function splitHostPort(s, defPort) {
  const m = String(s || "").match(/^\[([^\]]+)\](?::(\d+))?$/) || String(s || "").match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defPort;
  if (!(port > 0 && port < 65536)) return null;
  return { host: m[1], port };
}
const errText = (e) => (e?.code ? `${e.code}: ${e.message}` : String(e?.message || e));

// Collects up to MAX_BODY bytes of a body while counting all of it.
// `owner` (the inspector) counts what every body keeps, so the total can be held under MAX_KEPT.
class Body {
  constructor(owner) { this.parts = []; this.kept = 0; this.size = 0; this.owner = owner; }
  add(c) {
    this.size += c.length;
    if (this.kept < MAX_BODY) {
      const take = c.subarray(0, MAX_BODY - this.kept); this.parts.push(Buffer.from(take)); this.kept += take.length;
      this.owner?.kept(take.length);
    }
  }
  get truncated() { return this.size > this.kept; }
  buffer() { return this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts); }
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || "").toLowerCase().trim();
  const opts = { maxOutputLength: MAX_BODY };
  try {
    if (enc === "gzip" || enc === "x-gzip") return { buf: zlib.gunzipSync(buf, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }), decoded: "gzip" };
    if (enc === "br") return { buf: zlib.brotliDecompressSync(buf, { ...opts, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }), decoded: "br" };
    if (enc === "deflate") {
      try { return { buf: zlib.inflateSync(buf, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }), decoded: "deflate" }; }
      catch { return { buf: zlib.inflateRawSync(buf, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH }), decoded: "deflate" }; }
    }
  } catch (e) {
    if (e?.code === "ERR_BUFFER_TOO_LARGE") return { buf: null, decoded: enc, error: "Too large to unpack" };
    return { buf: null, decoded: enc, error: `Couldn't unpack (${enc})` };
  }
  return { buf, decoded: "" };
}

// ---------------------------------------------------------------- the inspector
class Inspector {
  constructor({ userData, emit }) {
    this.caFile = path.join(userData, "inspector-ca.json");
    this.emit = emit; // (ev) => void, to the page
    this.ca = null;
    this.server = null;
    this.port = 0;
    this.decrypt = false;
    this.entries = new Map(); // id -> entry (insertion order = time order)
    this.seq = 0;
    this.sockets = new Set();
    this.leafCache = new Map(); // host -> SecureContext
    this.leafKey = null;
    this.dirty = new Map(); // id -> summary waiting to be sent
    this.flushTimer = null;
    this.agentHttp = new http.Agent({ keepAlive: true, maxSockets: 32 });
    this.agentHttps = new https.Agent({ keepAlive: true, maxSockets: 32 });
    // Decrypted HTTPS connections are parsed by this (never listening) server.
    this.inner = http.createServer();
    this.inner.on("request", (req, res) => this.onRequest(req, res, true));
    this.inner.on("upgrade", (req, sock, head) => this.onUpgrade(req, sock, head, true));
    this.inner.on("clientError", (_e, sock) => { try { sock.destroy(); } catch {} });
  }

  // ---- certificates
  ensureCa() { if (!this.ca) this.ca = loadCa(this.caFile); return this.ca; }
  caPem() { return this.ensureCa().cert; }
  contextFor(host) {
    host = String(host || "").toLowerCase().slice(0, 253) || "localhost";
    let c = this.leafCache.get(host);
    if (c) return c;
    const ca = this.ensureCa();
    const caKey = crypto.createPrivateKey(ca.key);
    const caCert = new crypto.X509Certificate(ca.cert);
    if (!this.leafKey) this.leafKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const san = isIp(host) ? der(0x87, ipBytes(host)) : der(0x82, Buffer.from(host, "ascii"));
    const certDer = signCert({
      subject: name(host), issuer: caSubjectDer(caCert), publicKey: this.leafKey.publicKey, signKey: caKey,
      notBefore: new Date(now() - 86_400_000), notAfter: new Date(now() + 397 * 86_400_000),
      extensions: [
        ext("2.5.29.19", true, seq()), // basicConstraints: not a CA
        ext("2.5.29.15", true, bitString(Buffer.from([0xa0]), 5)), // digitalSignature, keyEncipherment
        ext("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
        ext("2.5.29.17", false, seq(san)), // subjectAltName
        ext("2.5.29.35", false, seq(der(0x80, keyId(caCert.publicKey)))), // authorityKeyIdentifier
      ],
    });
    c = tls.createSecureContext({
      key: this.leafKey.privateKey.export({ type: "pkcs8", format: "pem" }),
      cert: toPem(certDer) + ca.cert,
    });
    if (this.leafCache.size > 500) this.leafCache.clear();
    this.leafCache.set(host, c);
    return c;
  }

  // ---- lifecycle
  status() { return { running: !!this.server, port: this.port, decrypt: this.decrypt, count: this.entries.size }; }
  async start({ port = 8899, decrypt = false } = {}) {
    port = Number(port);
    if (!(Number.isInteger(port) && port > 1023 && port < 65536)) throw new Error("Choose a proxy port from 1024 to 65535.");
    this.decrypt = !!decrypt;
    if (this.decrypt) this.ensureCa();
    if (this.server && this.port === port) return this.status();
    await this.stop();
    const server = http.createServer();
    server.keepAliveTimeout = 30_000;
    server.on("request", (req, res) => this.onRequest(req, res, false));
    server.on("connect", (req, sock, head) => this.onConnect(req, sock, head));
    server.on("upgrade", (req, sock, head) => this.onUpgrade(req, sock, head, false));
    server.on("connection", (s) => { this.sockets.add(s); s.on("close", () => this.sockets.delete(s)); });
    server.on("clientError", (_e, sock) => { try { sock.destroy(); } catch {} });
    await new Promise((resolve, reject) => {
      server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`Port ${port} on this computer is already in use. Pick another port.`) : e));
      server.listen(port, "127.0.0.1", resolve);
    });
    server.on("error", () => {});
    this.server = server; this.port = port;
    return this.status();
  }
  async stop() {
    const s = this.server;
    this.server = null;
    if (!s) return this.status();
    for (const sock of this.sockets) { try { sock.destroy(); } catch {} }
    this.sockets.clear();
    await new Promise((r) => s.close(() => r()));
    return this.status();
  }
  clear() { for (const e of this.entries.values()) { if (e.reqBody) e.reqBody.owner = null; if (e.resBody) e.resBody.owner = null; } this.entries.clear(); this.keptBytes = 0; this.dirty.clear(); this.emit({ type: "cleared" }); return true; }

  // ---- entries
  // Bytes held in bodies. Past MAX_KEPT the oldest calls go, as they do past MAX_ENTRIES.
  kept(n) {
    this.keptBytes = (this.keptBytes || 0) + n;
    while (this.keptBytes > MAX_KEPT && this.entries.size > 1) this.dropOldest();
  }
  dropOldest() {
    const first = this.entries.keys().next().value;
    const e = this.entries.get(first);
    this.entries.delete(first);
    this.keptBytes -= (e?.reqBody?.kept || 0) + (e?.resBody?.kept || 0);
    if (e?.reqBody) e.reqBody.owner = null; // a call still running no longer counts
    if (e?.resBody) e.resBody.owner = null;
  }
  newEntry(fields) {
    const e = { id: ++this.seq, time: now(), status: 0, error: "", reqHeaders: [], resHeaders: [], reqBody: null, resBody: null, ...fields };
    this.entries.set(e.id, e);
    if (this.entries.size > MAX_ENTRIES) this.dropOldest();
    this.touch(e);
    return e;
  }
  summary(e) {
    return {
      id: e.id, time: e.time, kind: e.kind, method: e.method, scheme: e.scheme, host: e.host, port: e.port, path: e.path,
      status: e.status, statusText: e.statusText || "", error: e.error,
      type: header(e.resHeaders, "content-type").split(";")[0].trim().toLowerCase(),
      reqSize: e.reqBody ? e.reqBody.size : e.bytesUp || 0, resSize: e.resBody ? e.resBody.size : e.bytesDown || 0,
      duration: e.end ? e.end - e.time : null, done: !!e.end, decrypted: !!e.decrypted,
    };
  }
  touch(e) {
    this.dirty.set(e.id, e);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const items = [...this.dirty.values()].filter((x) => this.entries.has(x.id)).map((x) => this.summary(x));
      this.dirty.clear();
      if (items.length) { try { this.emit({ type: "entries", items }); } catch {} }
    }, 150);
  }
  list() { return [...this.entries.values()].map((e) => this.summary(e)); }
  get(id) {
    const e = this.entries.get(Number(id));
    if (!e) return null;
    const body = (b, headers) => {
      if (!b) return null;
      const raw = b.buffer();
      const dec = decodeBody(raw, header(headers, "content-encoding"));
      const out = dec.buf || raw;
      return {
        size: b.size, kept: b.kept, truncated: b.truncated, encoding: dec.decoded || "", decodeError: dec.error || "",
        base64: (dec.buf ? dec.buf : raw).toString("base64"), decodedSize: out.length,
      };
    };
    return {
      ...this.summary(e), url: e.url || "", httpVersion: e.httpVersion || "",
      reqHeaders: pairs(e.reqHeaders), resHeaders: pairs(e.resHeaders),
      reqBody: body(e.reqBody, e.reqHeaders), resBody: body(e.resBody, e.resHeaders),
      timing: { start: e.time, connected: e.connected || null, firstByte: e.firstByte || null, end: e.end || null },
      tls: e.tls || null, bytesUp: e.bytesUp || 0, bytesDown: e.bytesDown || 0,
    };
  }

  // ---- plain or decrypted HTTP request
  onRequest(req, res, secure) {
    let target;
    try {
      if (secure) {
        const t = req.socket.__ddTarget || {};
        const hp = splitHostPort(req.headers.host, t.port || 443) || { host: t.host, port: t.port };
        target = new URL(`https://${hp.host.includes(":") ? `[${hp.host}]` : hp.host}:${hp.port}${req.url.startsWith("/") ? req.url : "/" + req.url}`);
      } else {
        target = new URL(req.url);
        if (!/^https?:$/.test(target.protocol)) throw new Error("bad scheme");
      }
    } catch {
      if (!secure && req.url.startsWith("/")) { // someone opened the proxy itself
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("Andromon API inspector is running. Point the phone's proxy here.\n");
        return;
      }
      res.writeHead(400); res.end(); return;
    }
    const isHttps = target.protocol === "https:";
    const port = Number(target.port) || (isHttps ? 443 : 80);
    const e = this.newEntry({
      kind: "http", method: req.method, scheme: isHttps ? "https" : "http", host: target.hostname.replace(/^\[|\]$/g, ""), port,
      path: target.pathname + target.search, url: target.href, httpVersion: req.httpVersion, decrypted: secure,
      reqHeaders: req.rawHeaders.slice(), reqBody: new Body(this), resBody: null,
      tls: secure ? { client: { protocol: req.socket.getProtocol?.() || "", cipher: req.socket.getCipher?.()?.name || "", sni: req.socket.servername || "" } } : null,
    });
    const headers = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (HOP.has(k.toLowerCase())) continue;
      headers.push(k, req.rawHeaders[i + 1]);
    }
    const opts = {
      method: req.method, host: e.host, port, path: e.path || "/", headers, setHost: false,
      agent: isHttps ? this.agentHttps : this.agentHttp, servername: isIp(e.host) ? undefined : e.host, rejectUnauthorized: true,
    };
    const up = (isHttps ? https : http).request(opts);
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      e.error = errText(err); e.end = now(); this.touch(e);
      if (!res.headersSent) {
        try { res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-andromon-error": "1" }); res.end(`Andromon proxy: ${e.error}\n`); } catch {}
      } else { try { res.destroy(); } catch {} }
      try { up.destroy(); } catch {}
    };
    up.on("socket", (s) => {
      const mark = () => { if (!e.connected) { e.connected = now(); this.touch(e); } };
      if (s.connecting) s.once(isHttps ? "secureConnect" : "connect", mark); else mark();
    });
    up.on("response", (ur) => {
      e.firstByte = now(); e.status = ur.statusCode; e.statusText = ur.statusMessage || "";
      e.resHeaders = ur.rawHeaders.slice(); e.resBody = new Body(this.entries.has(e.id) ? this : null); // not counted if the call was already dropped
      if (isHttps && ur.socket?.getPeerCertificate) {
        try {
          const pc = ur.socket.getPeerCertificate();
          e.tls = { ...(e.tls || {}), server: { protocol: ur.socket.getProtocol?.() || "", cipher: ur.socket.getCipher?.()?.name || "", subject: pc?.subject?.CN || "", issuer: pc?.issuer?.CN || pc?.issuer?.O || "", validTo: pc?.valid_to || "" } };
        } catch {}
      }
      this.touch(e);
      const out = [];
      for (let i = 0; i + 1 < ur.rawHeaders.length; i += 2) {
        const k = ur.rawHeaders[i];
        if (HOP.has(k.toLowerCase())) continue;
        out.push(k, ur.rawHeaders[i + 1]);
      }
      try { res.writeHead(ur.statusCode, ur.statusMessage, out); } catch (err) { fail(err); return; }
      ur.on("data", (c) => { e.resBody.add(c); });
      ur.on("end", () => { finished = true; e.end = now(); this.touch(e); });
      ur.on("error", fail);
      ur.on("aborted", () => fail(new Error("The server closed the connection early")));
      ur.pipe(res);
    });
    up.on("error", fail);
    up.setTimeout(120_000, () => fail(new Error("No answer from the server in 2 minutes")));
    req.on("data", (c) => e.reqBody.add(c));
    req.on("aborted", () => { if (!finished) { e.error = "The phone cancelled the request"; e.end = now(); this.touch(e); finished = true; try { up.destroy(); } catch {} } });
    res.on("close", () => { if (!finished) { finished = true; e.error = e.error || "The phone closed the connection"; e.end = now(); this.touch(e); try { up.destroy(); } catch {} } });
    req.pipe(up);
  }

  // ---- HTTPS: tunnel or decrypt
  onConnect(req, sock, head) {
    sock.on("error", () => {});
    const hp = splitHostPort(req.url, 443);
    if (!hp) { try { sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {} return; }
    if (this.decrypt) return this.mitm(hp, sock, head);
    const e = this.newEntry({ kind: "tunnel", method: "CONNECT", scheme: "https", host: hp.host, port: hp.port, path: "", url: `${hp.host}:${hp.port}`, bytesUp: 0, bytesDown: 0 });
    const up = net.connect({ host: hp.host, port: hp.port });
    let closed = false;
    const close = (err) => {
      if (closed) return;
      closed = true;
      if (err && !e.status) e.error = errText(err);
      e.end = now(); this.touch(e);
      try { up.destroy(); } catch {}
      try { sock.destroy(); } catch {}
    };
    up.setTimeout(30_000, () => { if (!e.connected) close(new Error("Couldn't reach the server")); });
    up.once("connect", () => {
      up.setTimeout(0);
      e.connected = now(); e.status = 200; e.statusText = "Tunnel"; this.touch(e);
      try { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch { return close(); }
      if (head?.length) { e.bytesUp += head.length; up.write(head); }
      sock.on("data", (c) => { e.bytesUp += c.length; this.touchLater(e); });
      up.on("data", (c) => { e.bytesDown += c.length; this.touchLater(e); });
      sock.pipe(up); up.pipe(sock);
    });
    up.on("error", (err) => {
      if (!e.connected) { try { sock.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`); } catch {} }
      close(err);
    });
    up.on("close", () => close());
    sock.on("close", () => close());
    up.on("end", () => close()); sock.on("end", () => close());
  }
  // Byte counters change constantly: update the page at most twice a second per entry.
  touchLater(e) {
    if (e.__t) return;
    e.__t = setTimeout(() => { e.__t = null; this.touch(e); }, 500);
  }

  mitm(hp, sock, head) {
    try { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch { return; }
    if (head?.length) sock.unshift(head);
    // Peek at the first byte: TLS starts with 0x16. Anything else (plain HTTP over CONNECT) is parsed as is.
    sock.once("readable", () => {
      const first = sock.read(1);
      if (!first) { try { sock.destroy(); } catch {} return; }
      sock.unshift(first);
      if (first[0] !== 0x16) {
        sock.__ddTarget = hp;
        this.inner.emit("connection", sock);
        return;
      }
      let ctx;
      try { ctx = this.contextFor(hp.host); } catch { try { sock.destroy(); } catch {} return; }
      const t = new tls.TLSSocket(sock, {
        isServer: true, secureContext: ctx, ALPNProtocols: ["http/1.1"],
        SNICallback: (servername, cb) => { try { cb(null, this.contextFor(servername || hp.host)); } catch (e) { cb(e); } },
      });
      t.__ddTarget = hp;
      t.on("error", (err) => {
        // Most often: the app doesn't trust our CA (or pins its certificate). Record it once per host.
        const msg = errText(err);
        if (/alert|unknown ca|certificate|bad_certificate|handshake/i.test(msg) && !t.__ddRecorded) {
          t.__ddRecorded = true;
          this.newEntry({ kind: "tls-error", method: "CONNECT", scheme: "https", host: hp.host, port: hp.port, path: "", url: `${hp.host}:${hp.port}`,
            error: "The app refused Andromon's certificate (it doesn't trust the CA, or it pins its certificate).", end: now() });
        }
        try { t.destroy(); } catch {}
      });
      t.on("secure", () => { this.inner.emit("connection", t); });
    });
  }

  // ---- WebSocket and other upgrades: pass through, one entry
  onUpgrade(req, sock, head, secure) {
    sock.on("error", () => {});
    let target;
    try {
      if (secure) {
        const t = sock.__ddTarget || {};
        const hp = splitHostPort(req.headers.host, t.port || 443) || t;
        target = { host: hp.host, port: hp.port, path: req.url, tls: true };
      } else {
        const u = new URL(req.url);
        target = { host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 80, path: u.pathname + u.search, tls: false };
      }
    } catch { try { sock.destroy(); } catch {} return; }
    const e = this.newEntry({
      kind: "ws", method: req.method, scheme: target.tls ? "wss" : "ws", host: target.host, port: target.port, path: target.path,
      url: `${target.tls ? "wss" : "ws"}://${target.host}:${target.port}${target.path}`, reqHeaders: req.rawHeaders.slice(), bytesUp: 0, bytesDown: 0, decrypted: secure,
    });
    const up = target.tls
      ? tls.connect({ host: target.host, port: target.port, servername: isIp(target.host) ? undefined : target.host, ALPNProtocols: ["http/1.1"] })
      : net.connect({ host: target.host, port: target.port });
    let closed = false;
    const close = (err) => {
      if (closed) return;
      closed = true;
      if (err) e.error = errText(err);
      e.end = now(); this.touch(e);
      try { up.destroy(); } catch {}
      try { sock.destroy(); } catch {}
    };
    up.once(target.tls ? "secureConnect" : "connect", () => {
      e.connected = now(); this.touch(e);
      let lines = `${req.method} ${target.path} HTTP/1.1\r\n`;
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^proxy-/i.test(k)) continue;
        lines += `${k}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      up.write(lines + "\r\n");
      if (head?.length) up.write(head);
      // The server's 101 answer is read for the entry, then everything is passed through.
      let resHead = "";
      const onFirst = (c) => {
        resHead += c.toString("latin1");
        const end = resHead.indexOf("\r\n\r\n");
        if (end < 0 && resHead.length < 16384) return;
        up.off("data", onFirst);
        const lines2 = resHead.slice(0, end > 0 ? end : resHead.length).split("\r\n");
        const m = lines2[0].match(/^HTTP\/\d\.\d (\d{3}) ?(.*)$/);
        e.status = m ? Number(m[1]) : 0; e.statusText = m ? m[2] : "";
        e.firstByte = now();
        e.resHeaders = lines2.slice(1).flatMap((l) => { const i = l.indexOf(":"); return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : []; });
        this.touch(e);
        e.bytesDown += c.length;
        sock.write(c);
        up.on("data", (d) => { e.bytesDown += d.length; this.touchLater(e); });
        up.pipe(sock);
      };
      up.on("data", onFirst);
      sock.on("data", (d) => { e.bytesUp += d.length; this.touchLater(e); });
      sock.pipe(up);
    });
    up.on("error", (err) => close(err));
    up.on("close", () => close());
    sock.on("close", () => close());
    // The proxy's sockets allow half-open connections: one side hanging up ends the entry.
    up.on("end", () => close()); sock.on("end", () => close());
  }
}

// Picks the issuer Name out of the CA certificate's DER (its subject), so leaf issuers match byte for byte.
function caSubjectDer(x509) {
  const d = x509.raw;
  // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version, serial, sigAlg, issuer, validity, subject, ... } }
  const read = (buf, off) => {
    const tag = buf[off]; let len = buf[off + 1], hdr = 2;
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i]; hdr = 2 + n; }
    return { tag, start: off, hdr, len, end: off + hdr + len };
  };
  const cert = read(d, 0);
  const tbs = read(d, cert.start + cert.hdr);
  let off = tbs.start + tbs.hdr;
  const fields = [];
  while (off < tbs.end && fields.length < 6) { const f = read(d, off); fields.push(f); off = f.end; }
  const hasVersion = fields[0].tag === 0xa0;
  const subject = fields[hasVersion ? 5 : 4];
  return Buffer.from(d.subarray(subject.start, subject.end));
}

// ---------------------------------------------------------------- IPC
function setupInspector(handle, { userData, getWindow }) {
  const send = (ev) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send("inspector:event", ev); };
  const insp = new Inspector({ userData, emit: send });
  handle("inspector:start", (_e, opts) => insp.start({ port: Number(opts?.port) || 8899, decrypt: !!opts?.decrypt }));
  handle("inspector:stop", () => insp.stop());
  handle("inspector:clear", () => insp.clear());
  handle("inspector:status", () => insp.status());
  handle("inspector:list", () => insp.list());
  handle("inspector:get", (_e, id) => insp.get(Number(id)));
  handle("inspector:caPem", () => insp.caPem());
  return insp;
}

module.exports = { Inspector, setupInspector, createCa, caSubjectDer };
