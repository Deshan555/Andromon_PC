// SPDX-License-Identifier: GPL-3.0-only
// API tester (src/qa/apitest.js): sends one HTTP(S) request from the main process. The page can't do
// this itself: its Content-Security-Policy only allows its own origin, and browsers enforce CORS.
//
// Only http: and https: URLs. Response bodies are decoded (gzip / deflate / br) and capped at 10 MB.
"use strict";

const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");

const MAX_BODY = 10 * 1024 * 1024;
const TEXT_TYPE = /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|graphql)|image\/svg)/i;
const inflight = new Map(); // id -> abort()

function decode(buf, encoding) {
  const enc = String(encoding || "").toLowerCase().trim();
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch {}
  return buf;
}

function once(req, redirectsLeft, started, hops) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(req.url); } catch { return reject(new Error("That isn't a valid URL.")); }
    if (url.protocol !== "http:" && url.protocol !== "https:") return reject(new Error("Only http:// and https:// URLs can be sent."));
    const lib = url.protocol === "https:" ? https : http;
    const headers = {};
    for (const [k, v] of req.headers || []) {
      if (!k || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) continue;
      headers[k] = headers[k] !== undefined ? [].concat(headers[k], String(v)) : String(v);
    }
    const body = req.bodyBase64 ? Buffer.from(req.bodyBase64, "base64") : req.body != null && req.body !== "" ? Buffer.from(String(req.body), "utf8") : null;
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) headers["Content-Length"] = String(body.length);
    let ttfb = 0, timer = null, settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const r = lib.request(url, {
      method: req.method || "GET", headers,
      rejectUnauthorized: !req.insecure,
      timeout: 0,
    }, (res) => {
      ttfb = Date.now() - started;
      const loc = res.headers.location;
      if (req.followRedirects && loc && [301, 302, 303, 307, 308].includes(res.statusCode) && redirectsLeft > 0) {
        res.resume();
        const next = new URL(loc, url).toString();
        const keepBody = res.statusCode === 307 || res.statusCode === 308;
        hops.push({ status: res.statusCode, url: url.toString() });
        once({ ...req, url: next, method: keepBody ? req.method : (req.method === "HEAD" ? "HEAD" : "GET"), body: keepBody ? req.body : null, bodyBase64: keepBody ? req.bodyBase64 : null },
          redirectsLeft - 1, started, hops).then((v) => finish(resolve, v), (e) => finish(reject, e));
        return;
      }
      const chunks = []; let size = 0, truncated = false;
      res.on("data", (c) => {
        size += c.length;
        if (size <= MAX_BODY) chunks.push(c); else truncated = true;
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const data = decode(raw, res.headers["content-encoding"]);
        const type = String(res.headers["content-type"] || "");
        const isText = TEXT_TYPE.test(type) || (!type && !data.subarray(0, 512).includes(0));
        finish(resolve, {
          status: res.statusCode, statusText: res.statusMessage || "", httpVersion: res.httpVersion,
          headers: rawPairs(res.rawHeaders), url: url.toString(), redirects: hops,
          body: isText ? data.toString("utf8") : null, bodyBase64: isText ? null : data.toString("base64"),
          type, size, decodedSize: data.length, truncated,
          time: { total: Date.now() - started, ttfb },
          remote: r.socket?.remoteAddress || "",
          tls: url.protocol === "https:" && r.socket?.getPeerCertificate ? tlsInfo(r.socket) : null,
        });
      });
      res.on("error", (e) => finish(reject, e));
    });
    r.on("error", (e) => finish(reject, friendly(e, url)));
    if (req.timeoutMs > 0) timer = setTimeout(() => r.destroy(new Error(`No answer within ${Math.round(req.timeoutMs / 1000)} s`)), req.timeoutMs);
    inflight.set(req.id, () => r.destroy(new Error("Cancelled")));
    if (body) r.write(body);
    r.end();
  });
}

function rawPairs(raw) {
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
}
function tlsInfo(sock) {
  try {
    const c = sock.getPeerCertificate();
    return { protocol: sock.getProtocol?.() || "", subject: c?.subject?.CN || "", issuer: c?.issuer?.O || c?.issuer?.CN || "", validTo: c?.valid_to || "" };
  } catch { return null; }
}
function friendly(e, url) {
  const host = url.host;
  const map = {
    ENOTFOUND: `Couldn't find ${url.hostname} (DNS lookup failed).`,
    ECONNREFUSED: `Nothing is listening at ${host}.`,
    ECONNRESET: `${host} closed the connection.`,
    ETIMEDOUT: `${host} didn't answer.`,
    CERT_HAS_EXPIRED: `${host}'s certificate has expired. Turn on “Allow untrusted certificates” to send anyway.`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `${host} uses a self-signed certificate. Turn on “Allow untrusted certificates” to send anyway.`,
    SELF_SIGNED_CERT_IN_CHAIN: `${host}'s certificate isn't trusted. Turn on “Allow untrusted certificates” to send anyway.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `${host}'s certificate can't be verified. Turn on “Allow untrusted certificates” to send anyway.`,
    ERR_TLS_CERT_ALTNAME_INVALID: `${host}'s certificate is for a different name.`,
  };
  return new Error(map[e?.code] || e?.message || String(e));
}

/** Registers the IPC handlers (`handle` wraps ipcMain.handle with the sender check used in main.js). */
function setupApiClient(handle) {
  handle("api:send", async (_event, id, req) => {
    req = { ...(req || {}), id: String(id) };
    try { return await once(req, req.followRedirects ? 5 : 0, Date.now(), []); }
    finally { inflight.delete(req.id); }
  });
  handle("api:cancel", (_event, id) => { inflight.get(String(id))?.(); inflight.delete(String(id)); return true; });
}

module.exports = { setupApiClient };
