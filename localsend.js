// Droid Desk — Wi‑Fi file transfer that speaks the LocalSend protocol v2
// (https://github.com/localsend/protocol, Apache-2.0). Phones running the LocalSend app can send
// files to this computer and receive files from it, with no USB cable or companion app.
//
// Runs in the Electron main process (the renderer is sandboxed and has no network access).
// Security rules (see ../research.md, "Security design"):
//  - Nothing listens on the network until the user turns Wi‑Fi transfer on; it stops when turned off.
//  - HTTPS only. Our identity is a self-signed RSA-2048 certificate; peers are identified by the
//    SHA-256 fingerprint of their certificate, which we pin when sending to them.
//  - Every incoming transfer needs the user's consent in the UI. Uploads are bound to the session,
//    a per-file random token and the sender's IP, and may not exceed the size announced up front.
//  - File names from the network are untrusted: sanitised and confined to the download folder.
"use strict";
const dgram = require("node:dgram");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const netlink = require("./netlink.js");

const PORT = 53317;
const GROUP = "224.0.0.167";
const API = "/api/localsend/v2";
const PROTOCOL_VERSION = "2.1";
const MAX_FILES = 10_000;
const CONSENT_TIMEOUT_MS = 60_000;
const SESSION_IDLE_MS = 5 * 60_000;
const DEVICE_TTL_MS = 10 * 60_000;
// Sending speed: many small files are dominated by per-file round trips, so connections are kept
// alive and reused, and a few files upload at once (the protocol allows parallel /upload calls).
const UPLOAD_CONCURRENCY = 3;
const IO_CHUNK = 1024 * 1024; // larger disk reads/writes than Node's 64 KB / 16 KB defaults
// "Auto" uses a Direct link (Droid Desk Companion's temporary hotspot) only when it's worth leaving
// the current Wi‑Fi for a moment: big transfers over a link estimated to be slow.
const AUTO_DIRECT_MIN_BYTES = 100e6;
const AUTO_DIRECT_BELOW_MBPS = 6;
const METHODS = ["auto", "lan", "direct"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- self-signed certificate (minimal DER writer; no extra dependencies) ----------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  while (n) { b.unshift(n & 0xff); n >>>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
const derInt = (buf) => der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
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
const utcTime = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

// Self-signed certificate (and new RSA-2048 key unless [pair] is given). Also used by wadb.js.
function createIdentity(pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), commonName = "Droid Desk") {
  const { publicKey, privateKey } = pair;
  const sigAlg = seq(oid("1.2.840.113549.1.1.11"), der(0x05)); // sha256WithRSAEncryption, NULL params
  const name = seq(set(seq(oid("2.5.4.3"), der(0x0c, Buffer.from(commonName)))));
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const now = Date.now();
  const tbs = seq(
    der(0xa0, derInt(Buffer.from([2]))), // v3
    derInt(serial), sigAlg, name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date("2049-12-31T23:59:59Z"))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certDer = seq(tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = "-----BEGIN CERTIFICATE-----\n" + certDer.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
  return { cert: certPem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
const fingerprintOf = (certDer) => crypto.createHash("sha256").update(certDer).digest("hex").toUpperCase();

function loadIdentity(file) {
  try {
    const id = JSON.parse(fs.readFileSync(file, "utf8"));
    const x = new crypto.X509Certificate(id.cert);
    if (new Date(x.validTo) > new Date(Date.now() + 30 * 86_400_000)) return id;
  } catch {}
  const id = createIdentity();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 });
  return id;
}

// ---------- helpers ----------
const FILE_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
  pdf: "application/pdf", txt: "text/plain", zip: "application/zip", apk: "application/vnd.android.package-archive",
};
const fileTypeOf = (name) => FILE_TYPES[path.extname(name).slice(1).toLowerCase()] || "application/octet-stream";
const cleanIp = (ip) => String(ip || "").replace(/^::ffff:/, "");
const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

// Turn a network-supplied name (which may contain sub-folders) into a safe relative path.
function safeRelPath(name) {
  const parts = String(name).split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/[. ]+$/, "").trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(p) ? "_" + p : p).slice(0, 180));
  return parts.length ? parts.slice(-8).join(path.sep) : "file";
}
async function uniquePath(p) {
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let i = 0; ; i++) {
    const c = i ? path.join(dir, `${base} (${i})${ext}`) : p;
    try { await fsp.access(c); } catch { return c; }
  }
}
function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

class LocalSend {
  /**
   * @param {object} o
   * @param {string} o.userData   folder for the persistent identity
   * @param {string} o.saveDir    where received files go
   * @param {(event: object) => void} o.emit  sends an event to the UI
   */
  constructor({ userData, saveDir, emit }) {
    this.identityFile = path.join(userData, "localsend-identity.json");
    this.saveDir = saveDir;
    this.emit = emit;
    this.server = null; this.udp = null;
    this.devices = new Map(); // fingerprint -> device
    this.session = null;      // current incoming session
    this.pending = new Map(); // consent requests waiting for the UI
    this.outgoing = null;     // { cancelled, reqs:Set }
    this.linkCache = new Map(); // fingerprint -> { at, value }
    this.alias = os.hostname().replace(/\.local$/i, "").slice(0, 60) || "Droid Desk";
  }

  get running() { return !!this.server; }

  info() {
    return {
      alias: this.alias, version: PROTOCOL_VERSION, deviceModel: "Droid Desk", deviceType: "desktop",
      fingerprint: this.fingerprint, port: PORT, protocol: "https", download: false,
    };
  }

  status() {
    return {
      running: this.running, alias: this.alias, port: PORT, saveDir: this.saveDir,
      addresses: Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address),
      fingerprint: this.fingerprint,
    };
  }

  async start() {
    if (this.running) return this.status();
    this.identity = loadIdentity(this.identityFile);
    this.fingerprint = fingerprintOf(new crypto.X509Certificate(this.identity.cert).raw);

    const server = https.createServer({ cert: this.identity.cert, key: this.identity.key }, (req, res) => {
      this.handle(req, res).catch((e) => {
        console.warn("[localsend]", e);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    });
    server.requestTimeout = 0; // uploads can be long; idle sockets still time out below
    server.headersTimeout = 20_000;
    server.keepAliveTimeout = 5_000;
    await new Promise((resolve, reject) => {
      server.once("error", (e) => reject(e.code === "EADDRINUSE"
        ? new Error(`Port ${PORT} is already in use. Close the LocalSend desktop app (or anything else using that port) and try again.`)
        : e));
      server.listen(PORT, "0.0.0.0", resolve);
    });
    server.on("error", (e) => console.warn("[localsend] server", e));
    this.server = server;

    try { await this.startUdp(); }
    catch (e) { console.warn("[localsend] multicast unavailable", e); this.emit({ type: "warning", message: "Multicast discovery is blocked on this network. Phones can still find this computer if you scan from LocalSend." }); }

    this.announce();
    this.pruneTimer = setInterval(() => this.prune(), 30_000);
    return this.status();
  }

  startUdp() {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      udp.once("error", reject);
      udp.on("message", (msg, rinfo) => this.onMulticast(msg, rinfo));
      udp.bind(PORT, () => {
        udp.removeListener("error", reject);
        udp.on("error", (e) => console.warn("[localsend] udp", e));
        // Join the group on every IPv4 interface so phones on any adapter can find us.
        const ifaces = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
        let joined = 0;
        for (const a of ifaces) { try { udp.addMembership(GROUP, a.address); joined++; } catch {} }
        if (!joined) { try { udp.addMembership(GROUP); joined++; } catch {} }
        udp.setMulticastTTL(1);
        this.udp = udp;
        joined ? resolve() : reject(new Error("could not join multicast group"));
      });
    });
  }

  stop() {
    clearInterval(this.pruneTimer);
    for (const [, p] of this.pending) p.resolve(false);
    this.pending.clear();
    this.dropSession("Wi‑Fi transfer turned off");
    this.cancelSend();
    try { this.udp?.close(); } catch {}
    this.udp = null;
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections?.();
    }
    this.server = null;
    this.devices.clear();
    this.emitDevices();
  }

  // ---------- discovery ----------
  announce() {
    if (!this.udp) return;
    const msg = Buffer.from(JSON.stringify({ ...this.info(), announce: true }));
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal);
    const send = () => {
      if (!this.udp) return;
      if (!ifaces.length) return this.udp.send(msg, PORT, GROUP, () => {});
      for (const a of ifaces) {
        try { this.udp.setMulticastInterface(a.address); this.udp.send(msg, PORT, GROUP, () => {}); } catch {}
      }
    };
    // LocalSend repeats its announcement a few times; UDP can drop packets.
    send(); setTimeout(send, 500); setTimeout(send, 2000);
  }

  onMulticast(buf, rinfo) {
    let m; try { m = JSON.parse(buf.toString("utf8")); } catch { return; }
    if (!m || typeof m !== "object" || m.fingerprint === this.fingerprint) return;
    const dev = this.remember(m, rinfo.address);
    if (!dev || !m.announce) return;
    // Answer an announcement: register with them over HTTPS, or fall back to multicast.
    this.request(dev, "POST", `${API}/register`, this.info(), { timeout: 4000 })
      .catch(() => {
        try { this.udp?.send(Buffer.from(JSON.stringify({ ...this.info(), announce: false })), PORT, GROUP, () => {}); } catch {}
      });
  }

  remember(m, ip) {
    const fingerprint = str(m.fingerprint, 128);
    const port = Number(m.port) || PORT;
    if (!fingerprint || port < 1 || port > 65535) return null;
    const dev = {
      fingerprint, ip: cleanIp(ip), port,
      protocol: m.protocol === "http" ? "http" : "https",
      alias: str(m.alias, 80) || "Unknown device",
      deviceModel: str(m.deviceModel, 80), deviceType: str(m.deviceType, 20),
      // Droid Desk Companion adds a "droiddesk" object (other LocalSend apps don't).
      companion: m.droiddesk && typeof m.droiddesk === "object" ? { directLink: m.droiddesk.directLink === true } : null,
      seen: Date.now(),
    };
    this.devices.set(fingerprint, dev);
    this.emitDevices();
    return dev;
  }
  prune() {
    const cutoff = Date.now() - DEVICE_TTL_MS; let changed = false;
    for (const [k, d] of this.devices) if (d.seen < cutoff) { this.devices.delete(k); changed = true; }
    if (changed) this.emitDevices();
    if (this.session && Date.now() - this.session.active > SESSION_IDLE_MS) this.dropSession("The sender stopped responding");
  }
  emitDevices() {
    this.emit({ type: "devices", devices: [...this.devices.values()].map(({ fingerprint, ip, alias, deviceModel, deviceType, protocol, companion }) => ({ fingerprint, ip, alias, deviceModel, deviceType, protocol, companion })) });
  }

  // ---------- server (receiving) ----------
  async handle(req, res) {
    const url = new URL(req.url, "https://localhost");
    const ip = cleanIp(req.socket.remoteAddress);
    const send = (code, body) => {
      if (body === undefined) { res.writeHead(code); res.end(); return; }
      const json = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
      res.end(json);
    };

    if (req.method === "GET" && (url.pathname === `${API}/info` || url.pathname === "/api/localsend/v1/info")) {
      const { port, protocol, ...rest } = this.info(); return send(200, rest);
    }
    if (req.method === "POST" && url.pathname === `${API}/register`) {
      const body = await readJson(req, 64 * 1024).catch(() => null);
      if (!body || typeof body !== "object") return send(400);
      // In HTTPS mode the peer's self-declared fingerprint is untrusted; it only de-duplicates devices.
      if (body.fingerprint !== this.fingerprint) this.remember(body, ip);
      const { port, protocol, ...rest } = this.info(); return send(200, rest);
    }
    if (req.method === "POST" && url.pathname === `${API}/prepare-upload`) return this.prepareUpload(req, ip, send);
    if (req.method === "POST" && url.pathname === `${API}/upload`) return this.upload(req, res, url, ip, send);
    if (req.method === "POST" && url.pathname === `${API}/cancel`) {
      if (this.session && this.session.id === url.searchParams.get("sessionId") && this.session.ip === ip) this.dropSession("The sender cancelled the transfer");
      return send(200);
    }
    req.resume();
    send(404);
  }

  async prepareUpload(req, ip, send) {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== "object" || !body.files || typeof body.files !== "object") return send(400);
    if (this.session || this.pending.size) return send(409);
    const entries = Object.entries(body.files).slice(0, MAX_FILES + 1);
    if (!entries.length) return send(204);
    if (entries.length > MAX_FILES) return send(400);
    const files = [];
    for (const [id, f] of entries) {
      const size = Number(f?.size);
      if (!f || typeof f !== "object" || !Number.isSafeInteger(size) || size < 0) return send(400);
      files.push({ id: str(id, 200), name: str(f.fileName, 1000) || "file", size, sha256: /^[0-9a-f]{64}$/i.test(f.sha256 || "") ? f.sha256.toLowerCase() : null });
    }
    const info = body.info && typeof body.info === "object" ? body.info : {};
    const from = { alias: str(info.alias, 80) || "Unknown device", deviceModel: str(info.deviceModel, 80), ip };

    const requestId = crypto.randomUUID();
    const accepted = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); resolve(false); this.emit({ type: "incoming-expired", requestId }); }, CONSENT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); this.pending.delete(requestId); resolve(v); } });
      // The sender gave up while we were asking (it closed the connection): withdraw the question,
      // so accepting it later can't open a session nobody uploads to.
      req.socket.once("close", () => { const p = this.pending.get(requestId); if (p) { p.resolve(false); this.emit({ type: "incoming-expired", requestId }); } });
      this.emit({ type: "incoming", requestId, from, files: files.map(({ name, size }) => ({ name, size })), totalSize: files.reduce((s, f) => s + f.size, 0) });
    });
    if (!accepted || !this.running) return send(403);
    if (this.session) return send(409);

    const dir = this.saveDir;
    await fsp.mkdir(dir, { recursive: true });
    const session = {
      id: crypto.randomUUID(), ip, from, active: Date.now(), dir,
      files: new Map(files.map((f) => [f.id, { ...f, token: crypto.randomBytes(24).toString("hex"), done: false, received: 0, partPath: null, finalPath: null }])),
      total: files.reduce((s, f) => s + f.size, 0), received: 0, saved: [],
    };
    this.session = session;
    this.emit({ type: "progress", dir: "in", sessionId: session.id, from, received: 0, total: session.total, filesDone: 0, fileCount: files.length });
    send(200, { sessionId: session.id, files: Object.fromEntries([...session.files].map(([id, f]) => [id, f.token])) });
  }

  async upload(req, res, url, ip, send) {
    const s = this.session;
    const sessionId = url.searchParams.get("sessionId"), fileId = url.searchParams.get("fileId"), token = url.searchParams.get("token");
    if (!sessionId || !fileId || !token) { req.resume(); return send(400); }
    if (!s || s.id !== sessionId) { req.resume(); return send(s ? 409 : 403); }
    const f = s.files.get(fileId);
    const tokenOk = f && f.token.length === token.length && crypto.timingSafeEqual(Buffer.from(f.token), Buffer.from(token));
    if (!tokenOk || s.ip !== ip || f.done || f.busy) { req.resume(); return send(403); }
    f.busy = true;

    const rel = safeRelPath(f.name);
    const target = path.resolve(s.dir, rel);
    if (!target.startsWith(path.resolve(s.dir) + path.sep)) { req.resume(); f.busy = false; return send(403); }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const part = target + `.${crypto.randomBytes(4).toString("hex")}.part`;
    f.partPath = part;
    const out = fs.createWriteStream(part, { flags: "wx", highWaterMark: IO_CHUNK });
    const hash = f.sha256 ? crypto.createHash("sha256") : null;
    let received = 0, failed = null;

    await new Promise((resolve) => {
      req.on("data", (chunk) => {
        if (failed) return;
        received += chunk.length;
        if (received > f.size) { failed = 400; req.unpipe?.(); req.destroy(); return; }
        hash?.update(chunk);
        s.received += chunk.length; s.active = Date.now();
        if (!out.write(chunk)) { req.pause(); out.once("drain", () => req.resume()); }
        this.progress(s);
      });
      req.on("end", resolve);
      req.on("close", resolve);
      req.on("error", () => { failed = failed || 500; resolve(); });
    });
    await new Promise((r) => out.end(r));
    f.busy = false;

    if (this.session !== s) { await fsp.rm(part, { force: true }); return send(409); }
    if (!failed && received !== f.size) failed = 400;
    if (!failed && hash && hash.digest("hex") !== f.sha256) failed = 422;
    if (failed) {
      await fsp.rm(part, { force: true });
      s.received -= received;
      return res.headersSent ? undefined : send(failed);
    }
    const finalPath = await uniquePath(target);
    await fsp.rename(part, finalPath);
    f.done = true; f.finalPath = finalPath; s.saved.push(finalPath);
    send(200);
    this.progress(s, true);
    if ([...s.files.values()].every((x) => x.done)) {
      this.session = null;
      this.emit({ type: "done", dir: "in", sessionId: s.id, from: s.from, files: s.saved.map((p) => path.relative(s.dir, p)), saveDir: s.dir });
    }
  }

  progress(s, force = false) {
    const now = Date.now();
    if (!force && now - (s.lastEmit || 0) < 200) return;
    s.lastEmit = now;
    this.emit({ type: "progress", dir: "in", sessionId: s.id, from: s.from, received: s.received, total: s.total, filesDone: [...s.files.values()].filter((f) => f.done).length, fileCount: s.files.size });
  }

  dropSession(reason) {
    const s = this.session; if (!s) return;
    this.session = null;
    for (const f of s.files.values()) if (!f.done && f.partPath) fsp.rm(f.partPath, { force: true }).catch(() => {});
    this.emit({ type: "cancelled", dir: "in", sessionId: s.id, message: reason, files: s.saved.map((p) => path.relative(s.dir, p)), saveDir: s.dir });
  }

  respond(requestId, accept) {
    const p = this.pending.get(String(requestId));
    if (p) p.resolve(!!accept);
  }

  // ---------- client (sending) ----------
  request(dev, method, pathname, body, { timeout = 10_000, stream, length, onSocket, agent = false } = {}) {
    if (dev.protocol !== "https") return Promise.reject(new Error(`${dev.alias} has encryption turned off. Turn on "Encryption" in LocalSend's settings to use it with Droid Desk.`));
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = https.request({
        host: dev.ip, port: dev.port, method, path: pathname,
        // Peers use self-signed certificates. Instead of a CA we pin the fingerprint they announced
        // (checked in the "secureConnect" handler below), and present our own certificate.
        rejectUnauthorized: false, cert: this.identity.cert, key: this.identity.key,
        agent, timeout,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length }
          : stream ? { "Content-Type": "application/octet-stream", "Content-Length": length } : {},
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => { if (chunks.length < 1024) chunks.push(c); });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
          resolve({ status: res.statusCode, json });
        });
      });
      req.on("socket", (sock) => {
        onSocket?.(req);
        const verify = () => {
          const raw = sock.getPeerCertificate()?.raw;
          if (!raw || fingerprintOf(raw) !== dev.fingerprint.toUpperCase()) {
            req.destroy(new Error(`Security check failed: ${dev.alias}'s certificate doesn't match the one it announced. Transfer stopped.`));
          }
        };
        // A kept-alive socket is already connected (and was checked when it was): check it again anyway.
        if (sock.connecting || !sock.getPeerCertificate()?.raw) sock.once("secureConnect", verify); else verify();
      });
      req.on("timeout", () => req.destroy(new Error(`${dev.alias} didn't respond`)));
      req.on("error", reject);
      if (stream) stream.on("error", (e) => req.destroy(e)).pipe(req);
      else req.end(data);
    });
  }

  // ---------- link quality ----------

  /** This computer's link, the phone's (companion only, over pinned HTTPS) and an estimated speed. */
  async linkFor(dev) {
    const c = this.linkCache.get(dev.fingerprint);
    if (c && Date.now() - c.at < 30_000) return c.value;
    const [pc, info] = await Promise.all([
      netlink.localLink(),
      dev.companion && dev.protocol === "https" ? this.request(dev, "GET", `${API}/info`, undefined, { timeout: 4000 }).catch(() => null) : null,
    ]);
    const w = info?.json?.droiddesk?.wifi;
    const phone = w && typeof w === "object" ? {
      band: str(w.band, 10) || null, linkMbps: Number(w.linkMbps) || null, txMbps: Number(w.txMbps) || null,
      rssi: Number.isFinite(Number(w.rssi)) ? Number(w.rssi) : null,
    } : null;
    if (info?.json?.droiddesk && dev.companion) dev.companion.directLink = info.json.droiddesk.directLink === true;
    const value = { pc, phone, estimateMBps: netlink.estimateMBps(pc, phone) };
    this.linkCache.set(dev.fingerprint, { at: Date.now(), value });
    return value;
  }

  async linkReport() {
    const pc = await netlink.localLink();
    const devices = {};
    await Promise.all([...this.devices.values()].map(async (d) => {
      devices[d.fingerprint] = await this.linkFor(d).catch(() => null);
    }));
    return { pc, devices };
  }

  async useDirect(dev, total, method) {
    if (!dev.companion?.directLink) return false;
    if (method === "direct") return true;
    if (method !== "auto" || total < AUTO_DIRECT_MIN_BYTES) return false;
    const est = (await this.linkFor(dev).catch(() => null))?.estimateMBps;
    return est != null && est < AUTO_DIRECT_BELOW_MBPS;
  }

  /**
   * Joins the phone's Direct link network (automatically, or by asking the person), checks it's
   * the same phone (pinned certificate), and returns where to upload plus how to go back.
   */
  async directJoin(dev, dl, out, stage) {
    const cancelled = () => out.cancelled;
    const ssid = str(dl.ssid, 64), passphrase = String(dl.passphrase || "").slice(0, 128);
    const addresses = (Array.isArray(dl.addresses) ? dl.addresses : []).map((a) => String(a)).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    const port = Number(dl.port) || dev.port;
    const band = str(dl.band, 20) || null;
    if (!ssid || !passphrase || !addresses.length) throw new Error("the phone sent incomplete network details");
    const before = await netlink.localLink({ fresh: true }).catch(() => null);
    stage({ stage: "joining", ssid, band });
    let restore = null, manual = false;
    try {
      restore = await netlink.joinNetwork({ ssid, passphrase, security: str(dl.security, 20) }, { cancelled });
    } catch (e) {
      if (out.cancelled) throw e;
      manual = true; // e.g. no permission to change Wi‑Fi: the person can join from the Wi‑Fi menu
      stage({ stage: "manual", ssid, passphrase, band, reason: e.message });
    }
    const phoneIp = await netlink.waitForSubnet(addresses, { timeoutMs: manual ? 120_000 : 30_000, cancelled });
    if (manual && phoneIp) restore = () => netlink.forgetNetwork(ssid, before);
    if (!phoneIp) {
      await restore?.().catch(() => {});
      throw new Error(manual ? "this computer didn't join the phone's network in time" : "this computer got no address on the phone's network");
    }
    stage({ stage: "connecting", ssid, band });
    const target = { ...dev, ip: phoneIp, port };
    for (let i = 0; i < 8; i++) {
      if (out.cancelled) break;
      const r = await this.request(target, "GET", `${API}/info`, undefined, { timeout: 3000 }).catch(() => null);
      if (r?.status === 200) return { target, restore, band };
      await sleep(1000);
    }
    await restore?.().catch(() => {});
    throw new Error(out.cancelled ? "Cancelled" : "couldn't reach the phone on its network");
  }

  /**
   * Sends files to a device. [method]: "lan" — over the current Wi‑Fi (works with any
   * LocalSend-compatible app); "direct" — Droid Desk Companion's Direct link; "auto" — Direct link
   * for big transfers when the current Wi‑Fi looks slow, otherwise "lan".
   */
  async sendFiles(fingerprint, filePaths, method = "auto") {
    if (!METHODS.includes(method)) method = "auto";
    const dev = this.devices.get(fingerprint);
    if (!dev) throw new Error("That device is no longer on the network. Scan again.");
    if (this.outgoing) throw new Error("A transfer is already in progress.");
    const files = [];
    for (const p of filePaths) {
      const st = await fsp.stat(p);
      if (!st.isFile()) continue;
      files.push({ id: crypto.randomUUID(), path: p, fileName: path.basename(p), size: st.size, fileType: fileTypeOf(p), modified: st.mtime.toISOString() });
    }
    if (!files.length) throw new Error("Nothing to send.");
    const out = { cancelled: false, reqs: new Set(), dev, target: dev, via: null, restore: null };
    this.outgoing = out;
    const total = files.reduce((s, f) => s + f.size, 0);
    let sent = 0, last = 0, count = 0;
    const base = () => ({ type: "progress", dir: "out", to: dev.alias, total, fileCount: files.length });
    const emitProgress = (force) => {
      const now = Date.now(); if (!force && now - last < 200) return; last = now;
      this.emit({ ...base(), received: sent, filesDone: count, via: out.via });
    };
    const stage = (extra) => this.emit({ ...base(), received: sent, ...extra });
    try {
      if (method === "direct" && !dev.companion) throw new Error(`Direct link needs Droid Desk Companion on ${dev.alias}. Choose "Same Wi‑Fi" to send to this device.`);
      if (method === "direct" && !dev.companion.directLink) throw new Error(`Direct link is off or unavailable on ${dev.alias}. Check the Receive screen in Droid Desk Companion, or choose "Same Wi‑Fi".`);
      const wantDirect = await this.useDirect(dev, total, method);
      stage({ waiting: true, direct: wantDirect });
      const prep = await this.request(dev, "POST", `${API}/prepare-upload`, {
        info: this.info(),
        files: Object.fromEntries(files.map((f) => [f.id, { id: f.id, fileName: f.fileName, size: f.size, fileType: f.fileType, metadata: { modified: f.modified } }])),
        ...(wantDirect ? { droiddesk: { directLink: true } } : {}),
      }, { timeout: CONSENT_TIMEOUT_MS + 45_000 });
      if (out.cancelled) throw new Error("Cancelled");
      if (prep.status === 204) return { sent: 0, skipped: files.length };
      if (prep.status === 403) throw new Error(`${dev.alias} declined the files.`);
      if (prep.status === 401) throw new Error(`${dev.alias} requires a PIN. Turn off "Require PIN" in LocalSend's settings on that device, then try again.`);
      if (prep.status === 409) throw new Error(`${dev.alias} is busy with another transfer.`);
      if (prep.status !== 200 || !prep.json?.sessionId) throw new Error(`${dev.alias} refused the transfer (HTTP ${prep.status}).`);
      const { sessionId, files: tokens = {} } = prep.json;
      out.sessionId = sessionId;

      if (wantDirect) {
        const dl = prep.json.droiddesk;
        if (dl?.directLink && typeof dl.directLink === "object") {
          try {
            const j = await this.directJoin(dev, dl.directLink, out, stage);
            out.target = j.target; out.restore = j.restore;
            out.via = `Direct link${j.band ? ` (${j.band})` : ""}`;
          } catch (e) {
            if (out.cancelled) throw e;
            this.emit({ type: "warning", message: `Direct link didn't work (${e.message}). Sending over your Wi‑Fi instead.` });
            await netlink.waitForSubnet([dev.ip], { timeoutMs: 30_000, cancelled: () => out.cancelled });
          }
        } else if (dl?.directLinkError) {
          this.emit({ type: "warning", message: `${dev.alias}: ${str(dl.directLinkError, 200)}. Sending over your Wi‑Fi instead.` });
        }
      }
      const target = out.target;

      // One keep-alive agent per transfer: TLS handshakes happen once per connection, not once per file.
      // No TLS session cache, so every new connection does a full handshake and shows its certificate.
      out.agent = new https.Agent({ keepAlive: true, maxSockets: UPLOAD_CONCURRENCY, maxCachedSessions: 0 });
      const queue = files.filter((f) => tokens[f.id]);
      let next = 0, failure = null;
      const worker = async () => {
        while (!failure && next < queue.length) {
          const f = queue[next++];
          if (out.cancelled) throw new Error("Cancelled");
          const stream = fs.createReadStream(f.path, { highWaterMark: IO_CHUNK });
          stream.on("data", (c) => { sent += c.length; emitProgress(); });
          const qs = new URLSearchParams({ sessionId, fileId: f.id, token: tokens[f.id] });
          let req;
          const r = await this.request(target, "POST", `${API}/upload?${qs}`, undefined, {
            stream, length: f.size, timeout: 60_000, agent: out.agent, onSocket: (q) => out.reqs.add(req = q),
          }).finally(() => out.reqs.delete(req));
          if (r.status !== 200) throw new Error(`${dev.alias} rejected ${f.fileName} (HTTP ${r.status}).`);
          count++;
        }
      };
      // Stop the other uploads as soon as one fails, and report the first error.
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, () => worker().catch((e) => {
        if (!failure) { failure = e; for (const q of out.reqs) q.destroy(); }
      })));
      if (failure) throw failure;
      emitProgress(true);
      return { sent: count, skipped: files.length - count, via: out.via };
    } catch (e) {
      if (out.sessionId && !out.cancelled) this.request(out.target, "POST", `${API}/cancel?sessionId=${encodeURIComponent(out.sessionId)}`, undefined, { timeout: 3000 }).catch(() => {});
      throw out.cancelled ? new Error("Transfer cancelled") : e;
    } finally {
      out.agent?.destroy();
      if (out.restore) {
        stage({ stage: "restoring" });
        await out.restore().catch((e) => console.warn("[localsend] restore", e));
        this.linkCache.clear();
      }
      this.outgoing = null;
    }
  }

  cancelSend() {
    const out = this.outgoing; if (!out) return;
    out.cancelled = true;
    for (const r of out.reqs) r.destroy();
    if (out.sessionId) this.request(out.target, "POST", `${API}/cancel?sessionId=${encodeURIComponent(out.sessionId)}`, undefined, { timeout: 3000 }).catch(() => {});
  }
}

module.exports = { LocalSend, createIdentity, fingerprintOf, safeRelPath, PORT };
