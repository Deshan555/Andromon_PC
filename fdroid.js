// Andromon — the F-Droid catalogue (main process).
//
// F-Droid (https://f-droid.org) is a catalogue of free and open-source Android apps. Andromon
// doesn't ship any of it: when the person asks, this file downloads F-Droid's own index and, for an
// app they choose, that app's APK. Everything is checked before it is used:
//   - entry.jar       a small signed JAR. Its signature is checked here against F-Droid's signing
//                     certificate (pinned by SHA-256 fingerprint). It names the index and its hash.
//   - index-v2.json   every app and version, with the SHA-256 of each file. Checked against the
//                     hash from entry.jar, then boiled down to the English texts (catalog.json).
//   - icons, screenshots and APKs  each one is checked against its SHA-256 from the index.
// An index older than the one already here is refused, so an old signed index can't be replayed.
//
// Everything is kept in <userData>/fdroid. The sandboxed page never names a path or an address: it
// asks for an app by package name and version code, and reads the downloaded APK in pieces.
const { app, dialog, net, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = fs.promises;
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const REPO = "https://f-droid.org/repo";
// SHA-256 of the certificate that signs f-droid.org's index (published on f-droid.org/docs).
const FINGERPRINT = "43238d512c1e5eb2d6569f4a3afbf5523418b82e0a3ed1552770abb9a9c9ccab";
const FORMAT = 2; // of catalog.json; bump when buildCatalog returns something new. 2: screenshots
const OLD_FORMATS = [1]; // still readable; the next catalogue check downloads the index again to fill in what is new
const MAX_ENTRY = 4 * 1024 ** 2;
const MAX_INDEX = 400 * 1024 ** 2;
const MAX_ICON = 2 * 1024 ** 2;
const MAX_SHOT = 12 * 1024 ** 2;
const MAX_SHOTS = 8; // screenshots kept per app
const MAX_APK = 2 * 1024 ** 3;
const READ_CHUNK = 8 * 1024 * 1024;
const SAFE_NAME = /^\/[\w.\-+=@~ ]+(?:\/[\w.\-+=@~ ]+)*$/; // a file inside the repo
const PKG = /^[A-Za-z][\w]*(?:\.[\w]+)+$/;
const HEX64 = /^[0-9a-f]{64}$/;

// ---------- a small ZIP reader: enough for a signed JAR of a few files ----------
function unzip(buf, maxFile = MAX_ENTRY) {
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65557); p--) if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) throw new Error("Not a ZIP file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad ZIP file");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const n = buf.readUInt16LE(p + 28), e = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + n);
    p += 46 + n + e + c;
    if (usize > maxFile || csize > maxFile) throw new Error("Bad ZIP file");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("Bad ZIP file");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error("Bad ZIP file");
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: maxFile });
    else throw new Error("Bad ZIP file");
    if (!files.has(name)) files.set(name, data);
  }
  return files;
}

// ---------- a small DER reader: enough to check the JAR's PKCS#7 signature ----------
function der(buf, p = 0) {
  if (p + 2 > buf.length) throw new Error("Bad signature data");
  const tag = buf[p];
  let len = buf[p + 1], hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + 2 + n > buf.length) throw new Error("Bad signature data");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + 2 + i];
    hdr = 2 + n;
  }
  const end = p + hdr + len;
  if (end > buf.length) throw new Error("Bad signature data");
  return { tag, body: buf.subarray(p + hdr, end), raw: buf.subarray(p, end), end };
}
function kids(node) {
  const out = [];
  for (let p = 0; p < node.body.length;) { const k = der(node.body, p); out.push(k); p = k.end; }
  return out;
}
const OID_SIGNED_DATA = "2a864886f70d010702";
const OID_MESSAGE_DIGEST = "2a864886f70d010904";
const DIGESTS = { "608648016503040201": "sha256", "608648016503040202": "sha384", "608648016503040203": "sha512" };
// True when `block` (META-INF/*.RSA) holds a signature over `signed` (the .SF file) made with the
// certificate whose SHA-256 is `fingerprint`.
function checkPkcs7(block, signed, fingerprint) {
  const [type, wrapped] = kids(der(block));
  if (type?.tag !== 0x06 || type.body.toString("hex") !== OID_SIGNED_DATA || wrapped?.tag !== 0xa0) return false;
  const parts = kids(kids(wrapped)[0]);
  const certs = parts.find((k) => k.tag === 0xa0);
  const infos = parts.filter((k) => k.tag === 0x31).pop();
  if (!certs || !infos) return false;
  const cert = kids(certs).find((c) => crypto.createHash("sha256").update(c.raw).digest("hex") === fingerprint);
  if (!cert) return false;
  const key = new crypto.X509Certificate(cert.raw).publicKey;
  for (const info of kids(infos)) {
    const f = kids(info);
    const hash = DIGESTS[kids(f[2])[0]?.body.toString("hex")]; // version, signer id, digest algorithm, ...
    const attrs = f.find((k, i) => i > 2 && k.tag === 0xa0);
    const sig = f.find((k, i) => i > 2 && k.tag === 0x04);
    if (!hash || !sig) continue;
    let data = signed;
    if (attrs) {
      // With signed attributes, the signature covers them (as a SET) and they hold the file's digest.
      const digest = kids(attrs).map(kids).find((a) => a[0]?.body.toString("hex") === OID_MESSAGE_DIGEST);
      const want = digest && kids(digest[1])[0]?.body;
      if (!want || !want.equals(crypto.createHash(hash).update(signed).digest())) continue;
      data = Buffer.from(attrs.raw); data[0] = 0x31;
    }
    try { if (crypto.verify(hash, data, key, sig.body)) return true; } catch {}
  }
  return false;
}

// A JAR manifest or .SF file: sections of "Key: value" lines; a line starting with a space continues the one before.
function manifestSections(buf) {
  const text = buf.toString("utf8").replace(/\r\n?/g, "\n").replace(/\n /g, "");
  return text.split(/\n{2,}/).map((block) => {
    const m = new Map();
    for (const line of block.split("\n")) { const i = line.indexOf(": "); if (i > 0) m.set(line.slice(0, i), line.slice(i + 2)); }
    return m;
  }).filter((m) => m.size);
}
const sha256b64 = (b) => crypto.createHash("sha256").update(b).digest("base64");
// Returns the bytes of `name` from a JAR signed by `fingerprint`, or throws.
function readSignedJar(jar, name, fingerprint = FINGERPRINT) {
  const bad = () => new Error("F-Droid's index isn't signed by F-Droid. Nothing was kept.");
  const files = unzip(jar);
  const manifest = files.get("META-INF/MANIFEST.MF"), data = files.get(name);
  if (!manifest || !data) throw bad();
  for (const [file, block] of files) {
    const m = file.match(/^META-INF\/([^/]+)\.(RSA|EC|DSA)$/);
    const sf = m && files.get(`META-INF/${m[1]}.SF`);
    if (!sf) continue;
    let ok = false;
    try { ok = checkPkcs7(block, sf, fingerprint); } catch {}
    if (!ok) continue;
    // The .SF vouches for the whole manifest; the manifest vouches for the file.
    if (manifestSections(sf)[0]?.get("SHA-256-Digest-Manifest") !== sha256b64(manifest)) continue;
    const entry = manifestSections(manifest).find((s) => s.get("Name") === name);
    if (entry?.get("SHA-256-Digest") !== sha256b64(data)) continue;
    return data;
  }
  throw bad();
}

// ---------- index-v2.json -> the catalogue Andromon keeps ----------
const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
// A text in several languages: English, else the first one.
function text(v, max) {
  if (!v || typeof v !== "object") return str(v, max);
  return str(v["en-US"] ?? v["en-GB"] ?? v.en ?? Object.values(v)[0], max);
}
// Descriptions may carry simple HTML; the page shows plain text.
function plain(s) {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<li[^<>]*>/gi, "• ").replace(/<\/(li|ul|ol|h\d)>/gi, "\n")
    .replace(/<\/?[a-zA-Z][^<>]{0,300}>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" })[e])
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const link = (v) => (typeof v === "string" && /^https?:\/\/[^\s"<>]{1,500}$/.test(v) ? v : "");
const fileRef = (f) => (f && typeof f === "object" && typeof f.name === "string" && SAFE_NAME.test(f.name) && !f.name.includes("..") && HEX64.test(f.sha256 || "") ? { name: f.name, sha256: f.sha256, size: Number(f.size) || 0 } : null);
// Only pictures that can't carry code: no SVG or XML.
const pictureType = (name) => (/\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : null);
// An app's screenshots: the phone ones, in English when there are any, else in the first language.
// Apps with only tablet screenshots show those.
function shotsOf(all) {
  for (const kind of ["phone", "sevenInch", "tenInch"]) {
    const byLanguage = all && typeof all === "object" ? all[kind] : null;
    if (!byLanguage || typeof byLanguage !== "object") continue;
    const list = byLanguage["en-US"] ?? byLanguage["en-GB"] ?? byLanguage.en ?? Object.values(byLanguage)[0];
    const files = (Array.isArray(list) ? list : []).map(fileRef).filter((f) => f && pictureType(f.name) && f.size <= MAX_SHOT).slice(0, MAX_SHOTS);
    if (files.length) return files.map((f) => ({ name: f.name, sha256: f.sha256 }));
  }
  return [];
}
function buildCatalog(index, timestamp) {
  const named = (o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).map(([id, v]) => [id, { name: text(v?.name, 80) || id, description: text(v?.description, 400) }]));
  const apps = [];
  for (const [pkg, p] of Object.entries(index?.packages && typeof index.packages === "object" ? index.packages : {})) {
    const m = p?.metadata;
    if (!PKG.test(pkg) || !m || typeof m !== "object") continue;
    const versions = [];
    for (const v of Object.values(p.versions && typeof p.versions === "object" ? p.versions : {})) {
      const mf = v?.manifest, file = fileRef(v?.file);
      const code = Number(mf?.versionCode);
      if (!file || !/\.apk$/i.test(file.name) || !Number.isSafeInteger(code) || code < 0 || file.size <= 0 || file.size > MAX_APK) continue;
      const perms = [...(Array.isArray(mf.usesPermission) ? mf.usesPermission : []), ...(Array.isArray(mf.usesPermissionSdk23) ? mf.usesPermissionSdk23 : [])];
      versions.push({
        code, name: str(mf.versionName, 80) || String(code), file: file.name, sha256: file.sha256, size: file.size,
        added: Number(v.added) || 0,
        minSdk: Number(mf.usesSdk?.minSdkVersion) || 1, targetSdk: Number(mf.usesSdk?.targetSdkVersion) || 0, maxSdk: Number(mf.maxSdkVersion) || 0,
        abis: (Array.isArray(mf.nativecode) ? mf.nativecode : []).filter((a) => typeof a === "string").map((a) => a.slice(0, 40)),
        perms: [...new Set(perms.map((x) => str(x?.name, 200)).filter(Boolean))],
        signers: (Array.isArray(mf.signer?.sha256) ? mf.signer.sha256 : []).filter((s) => HEX64.test(s)),
        beta: Array.isArray(v.releaseChannels) && v.releaseChannels.length > 0,
        anti: Object.keys(v.antiFeatures && typeof v.antiFeatures === "object" ? v.antiFeatures : {}).map((a) => a.slice(0, 60)),
        whatsNew: plain(text(v.whatsNew, 4000)),
      });
    }
    if (!versions.length) continue;
    versions.sort((a, b) => b.code - a.code);
    apps.push({
      pkg, name: text(m.name, 120) || pkg, summary: text(m.summary, 300), description: plain(text(m.description, 20000)),
      icon: fileRef(m.icon?.["en-US"] ?? Object.values(m.icon && typeof m.icon === "object" ? m.icon : {})[0]),
      shots: shotsOf(m.screenshots),
      categories: (Array.isArray(m.categories) ? m.categories : []).filter((c) => typeof c === "string").map((c) => c.slice(0, 60)),
      license: str(m.license, 80), author: str(m.authorName, 120),
      webSite: link(m.webSite), sourceCode: link(m.sourceCode), issueTracker: link(m.issueTracker), changelog: link(m.changelog),
      added: Number(m.added) || 0, lastUpdated: Number(m.lastUpdated) || 0,
      preferredSigner: HEX64.test(m.preferredSigner || "") ? m.preferredSigner : "",
      versions,
    });
  }
  return { format: FORMAT, timestamp, fetchedAt: Date.now(), categories: named(index?.repo?.categories), antiFeatures: named(index?.repo?.antiFeatures), apps };
}

// ---------- which version fits a phone ----------
// phone: { sdk, abis } or null (no phone connected: everything fits).
function fits(v, phone) {
  if (!phone?.sdk) return "";
  if (v.minSdk > phone.sdk) return `Needs Android ${androidName(v.minSdk)} or newer`;
  if (v.maxSdk && phone.sdk > v.maxSdk) return "Made for older Android versions";
  if (v.abis.length && phone.abis?.length && !v.abis.some((a) => phone.abis.includes(a))) return "Not made for this phone's processor";
  return "";
}
const ANDROID = { 21: "5", 22: "5.1", 23: "6", 24: "7", 25: "7.1", 26: "8", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16" };
const androidName = (sdk) => ANDROID[sdk] || (sdk < 21 ? "4" : `(API ${sdk})`);
// The version to offer: the newest stable one that fits, signed with the key F-Droid prefers for the app.
function suggest(a, phone) {
  const ok = a.versions.filter((v) => !fits(v, phone));
  const mine = (v) => !a.preferredSigner || !v.signers.length || v.signers.includes(a.preferredSigner);
  return ok.find((v) => !v.beta && mine(v)) || ok.find((v) => !v.beta) || ok[0] || null;
}
const antiOf = (a, v) => (v || a.versions[0]).anti;
function row(a, phone) {
  const v = suggest(a, phone);
  return {
    pkg: a.pkg, name: a.name, summary: a.summary, icon: !!a.icon, license: a.license, lastUpdated: a.lastUpdated,
    anti: antiOf(a, v), v: v ? { code: v.code, name: v.name, size: v.size } : null,
    why: v ? "" : fits(a.versions[0], phone),
  };
}

function setupFdroid(handle, { userData, getWindow }) {
  const dir = path.join(userData, "fdroid");
  const P = { catalog: path.join(dir, "catalog.json"), index: path.join(dir, "index-v2.json"), apk: path.join(dir, "download.apk"), icons: path.join(dir, "icons"), shots: path.join(dir, "shots") };
  const emit = (ev) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send("fd:event", ev); };
  const exists = (f) => fsp.access(f).then(() => true, () => false);

  // ----- the catalogue in memory -----
  // Parsed, it takes 60–100 MB, so it's only kept while the F-Droid page is being used: after a few
  // minutes without a call it's let go, and read from disk again when next needed. A short summary
  // (what Settings shows) stays, so Settings doesn't load it.
  const IDLE_MS = 3 * 60_000;
  let cat = null, byPkg = new Map(), loading = null, idle = null, meta = null;
  const summarize = (c) => ({
    timestamp: c.timestamp, fetchedAt: c.fetchedAt, apps: c.apps.length,
    categories: Object.entries(c.categories).map(([id, x]) => ({ id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)),
    antiFeatures: c.antiFeatures,
    screenshots: c.format >= 2, // false: a catalogue from before screenshots were kept
  });
  function keepAwhile() {
    clearTimeout(idle);
    idle = setTimeout(() => { if (busy || loading) keepAwhile(); else { cat = null; byPkg = new Map(); } }, IDLE_MS);
    idle.unref?.();
  }
  function use(c) {
    cat = c; byPkg = new Map();
    meta = c ? summarize(c) : null;
    if (!c) return;
    keepAwhile();
    for (const a of c.apps) {
      byPkg.set(a.pkg, a);
      // Lower-case copies for searching; not written to disk.
      Object.defineProperty(a, "s", { value: { name: a.name.toLowerCase(), rest: `${a.summary}\n${a.pkg}`.toLowerCase(), desc: a.description.toLowerCase() }, enumerable: false });
    }
  }
  function load() {
    if (cat) { keepAwhile(); return Promise.resolve(cat); }
    return loading ||= (async () => {
      try {
        const c = JSON.parse(await fsp.readFile(P.catalog, "utf8"));
        if ((c?.format === FORMAT || OLD_FORMATS.includes(c?.format)) && Array.isArray(c.apps)) use(c);
      } catch {}
      loading = null;
      return cat;
    })();
  }
  async function need() {
    if (!(await load())) throw new Error("Download the F-Droid catalogue first.");
    return cat;
  }
  const cleanPhone = (ph) => (ph && Number(ph.sdk) > 0 ? { sdk: Number(ph.sdk), abis: (Array.isArray(ph.abis) ? ph.abis : []).map(String).slice(0, 12) } : null);

  // ----- downloads -----
  let busy = null, abort = null; // busy: "update" | "download"
  const lock = async (what, fn) => {
    if (busy) throw new Error(busy === "update" ? "The catalogue is being downloaded. Wait for it to finish." : "A download is running. Wait for it to finish.");
    busy = what; abort = new AbortController();
    try { return await fn(abort.signal); }
    catch (e) { if (abort.signal.aborted) throw new Error("The download was cancelled."); throw e; }
    finally { busy = null; abort = null; }
  };
  const repoUrl = (name) => {
    if (!SAFE_NAME.test(name) || name.includes("..")) throw new Error("Download address not allowed");
    return REPO + name.split("/").map(encodeURIComponent).join("/");
  };
  async function fetchBytes(name, limit, signal) {
    const res = await net.fetch(repoUrl(name), { headers: { "user-agent": "Andromon" }, signal });
    if (!res.ok) throw new Error(`Couldn't reach f-droid.org (HTTP ${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error("F-Droid sent a larger file than expected.");
    return buf;
  }
  // Streams a repo file to `dest`.part and returns its SHA-256. `ev` goes out with the progress.
  async function download(name, dest, what, total, limit, signal, ev = {}) {
    // Start and end are announced for the download manager.
    emit({ kind: "download", phase: "start", what, from: "f-droid.org", total, ...ev });
    try {
      const got = await downloadTo(name, dest, what, total, limit, signal, ev);
      emit({ kind: "download", phase: "end", what, ok: true, ...ev });
      return got;
    } catch (e) {
      emit({ kind: "download", phase: "end", what, ok: false, cancelled: !!signal?.aborted, error: String(e?.message || e), ...ev });
      throw e;
    }
  }
  async function downloadTo(name, dest, what, total, limit, signal, ev = {}) {
    const res = await net.fetch(repoUrl(name), { headers: { "user-agent": "Andromon" }, signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${what} (HTTP ${res.status}).`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = dest + ".part";
    const fh = await fsp.open(part, "w");
    const hash = crypto.createHash("sha256");
    let done = 0, last = 0;
    try {
      for await (const chunk of res.body) {
        done += chunk.length;
        if (done > limit) throw new Error(`${what} is larger than expected.`);
        hash.update(chunk);
        await fh.write(chunk);
        if (Date.now() - last > 200) { last = Date.now(); emit({ kind: "progress", what, done, total, ...ev }); }
      }
    } catch (e) { await fh.close(); await fsp.rm(part, { force: true }); throw e; }
    await fh.close();
    emit({ kind: "progress", what, done, total: total || done, ...ev });
    return { part, sha256: hash.digest("hex"), size: done };
  }

  async function status() {
    if (cat) meta = summarize(cat); // fetchedAt may have changed
    else if (!meta) await load();
    return { catalog: meta, busy };
  }

  // Downloads F-Droid's index when it is newer than the one here. Returns status() plus `changed`.
  const update = () => lock("update", async (signal) => {
    await load();
    let entry;
    try { entry = JSON.parse(readSignedJar(await fetchBytes("/entry.jar", MAX_ENTRY, signal), "entry.json").toString("utf8")); }
    catch (e) { if (e instanceof SyntaxError) throw new Error("F-Droid sent an unexpected answer."); throw e; }
    const ts = Number(entry?.timestamp), idx = entry?.index;
    if (!Number.isFinite(ts) || !idx || typeof idx.name !== "string" || !HEX64.test(idx.sha256 || "") || !(Number(idx.size) > 0) || Number(idx.size) > MAX_INDEX) throw new Error("F-Droid sent an unexpected answer.");
    if (cat && ts < cat.timestamp) throw new Error("F-Droid sent an older catalogue than the one already here. Nothing was changed.");
    if (cat && ts === cat.timestamp && cat.format === FORMAT) {
      cat.fetchedAt = Date.now();
      await fsp.writeFile(P.catalog, JSON.stringify(cat));
      return { ...(await status()), busy: null, changed: false };
    }
    const got = await download(idx.name, P.index, "F-Droid catalogue", Number(idx.size), MAX_INDEX, signal);
    try {
      if (got.sha256 !== idx.sha256) throw new Error("The catalogue download doesn't match F-Droid's signed index. Nothing was kept.");
      const built = buildCatalog(JSON.parse(await fsp.readFile(got.part, "utf8")), ts);
      if (!built.apps.length) throw new Error("F-Droid's catalogue has an unexpected format.");
      await fsp.writeFile(P.catalog + ".part", JSON.stringify(built));
      await fsp.rename(P.catalog + ".part", P.catalog);
      use(built);
    } finally { await fsp.rm(got.part, { force: true }); }
    return { ...(await status()), busy: null, changed: true };
  });

  // ----- browsing -----
  // { q, category, sort: "updated" | "added" | "name", offset, limit, phone } -> { total, items }
  async function search(o) {
    await need();
    const phone = cleanPhone(o?.phone);
    const words = str(o?.q, 100).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const category = str(o?.category, 60);
    let hits = [];
    for (const a of cat.apps) {
      if (category && !a.categories.includes(category)) continue;
      let score = 0;
      if (words.length) {
        // Every word must be somewhere; a hit in the name counts most.
        for (const w of words) {
          const s = a.s.name === w ? 8 : a.s.name.startsWith(w) ? 5 : a.s.name.includes(w) ? 4 : a.s.rest.includes(w) ? 2 : a.s.desc.includes(w) ? 1 : 0;
          if (!s) { score = 0; break; }
          score += s;
        }
        if (!score) continue;
      }
      hits.push({ a, score });
    }
    const by = o?.sort === "name" ? (x, y) => x.a.name.localeCompare(y.a.name) : o?.sort === "added" ? (x, y) => y.a.added - x.a.added : (x, y) => y.a.lastUpdated - x.a.lastUpdated;
    hits.sort((x, y) => (words.length && o?.sort !== "name" ? y.score - x.score : 0) || by(x, y));
    const offset = Math.max(0, Number(o?.offset) || 0), limit = Math.min(200, Math.max(1, Number(o?.limit) || 40));
    return { total: hits.length, items: hits.slice(offset, offset + limit).map((h) => row(h.a, phone)) };
  }
  // The catalogue's rows for these packages (the apps on a phone).
  async function lookup(pkgs, ph) {
    await need();
    const phone = cleanPhone(ph);
    return (Array.isArray(pkgs) ? pkgs : []).slice(0, 5000).map((p) => byPkg.get(String(p))).filter(Boolean).map((a) => row(a, phone));
  }
  async function details(pkg, ph) {
    await need();
    const a = byPkg.get(String(pkg));
    if (!a) return null;
    const phone = cleanPhone(ph);
    const v = suggest(a, phone);
    return {
      pkg: a.pkg, name: a.name, summary: a.summary, description: a.description, icon: !!a.icon, shots: a.shots?.length || 0, categories: a.categories.map((c) => cat.categories[c]?.name || c),
      license: a.license, author: a.author, webSite: a.webSite, sourceCode: a.sourceCode, issueTracker: a.issueTracker, changelog: a.changelog,
      added: a.added, lastUpdated: a.lastUpdated, suggested: v?.code ?? null,
      versions: a.versions.map((x) => ({
        code: x.code, name: x.name, size: x.size, added: x.added, minSdk: x.minSdk, minAndroid: androidName(x.minSdk), targetSdk: x.targetSdk,
        abis: x.abis, perms: x.perms, beta: x.beta, anti: x.anti, whatsNew: x.whatsNew, why: fits(x, phone),
      })),
    };
  }
  // A picture from the repo, checked against its SHA-256 from the index and kept on disk under that
  // hash. Null when it can't be fetched or isn't a plain picture.
  const pictureJobs = new Map();
  function picture(ref, folder, limit) {
    const type = ref && pictureType(ref.name);
    if (!type) return Promise.resolve(null);
    const { name, sha256 } = ref;
    let job = pictureJobs.get(sha256);
    if (!job) {
      job = (async () => {
        const file = path.join(folder, sha256);
        try { return await fsp.readFile(file); } catch {}
        const buf = await fetchBytes(name, limit);
        if (crypto.createHash("sha256").update(buf).digest("hex") !== sha256) throw new Error("Bad picture");
        await fsp.mkdir(folder, { recursive: true });
        await fsp.writeFile(file, buf);
        return buf;
      })().finally(() => pictureJobs.delete(sha256));
      pictureJobs.set(sha256, job);
    }
    return job.then((buf) => ({ type, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) }), () => null);
  }
  async function icon(pkg) {
    await load();
    return picture(byPkg.get(String(pkg))?.icon, P.icons, MAX_ICON);
  }
  // Screenshot number `i` (from 0) of an app; details() says how many there are.
  async function shot(pkg, i) {
    await load();
    return picture(byPkg.get(String(pkg))?.shots?.[Number(i)], P.shots, MAX_SHOT);
  }

  // ----- an app's APK -----
  let current = null; // { pkg, code, name, size }: the APK in P.apk
  const fetchApk = (pkg, code) => lock("download", async (signal) => {
    await need();
    const a = byPkg.get(String(pkg));
    const v = a?.versions.find((x) => x.code === Number(code));
    if (!v) throw new Error("F-Droid no longer has that version. Refresh the catalogue.");
    if (current && current.pkg === a.pkg && current.code === v.code && (await exists(P.apk))) return current;
    current = null;
    const got = await download(v.file, P.apk, a.name, v.size, v.size + 1, signal, { pkg: a.pkg });
    if (got.size !== v.size || got.sha256 !== v.sha256) {
      await fsp.rm(got.part, { force: true });
      throw new Error(`The download of ${a.name} doesn't match F-Droid's catalogue. Nothing was kept.`);
    }
    await fsp.rename(got.part, P.apk);
    current = { pkg: a.pkg, code: v.code, name: `${a.pkg}_${v.code}.apk`, size: v.size, label: a.name, version: v.name };
    return current;
  });
  async function read(offset, length) {
    if (!current) throw new Error("Nothing to read.");
    const off = Math.max(0, Number(offset) || 0), len = Math.min(READ_CHUNK, Math.max(0, Number(length) || 0));
    const fh = await fsp.open(P.apk, "r");
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally { await fh.close(); }
  }
  async function save(event) {
    if (!current || !(await exists(P.apk))) throw new Error("Nothing to save yet.");
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showSaveDialog(win, { title: "Save the app", defaultPath: path.join(app.getPath("downloads"), current.name), filters: [{ name: "Android app", extensions: ["apk"] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.copyFile(P.apk, r.filePath);
    return path.basename(r.filePath);
  }
  function cancel() { abort?.abort(); return true; }
  async function clear() {
    if (busy) throw new Error("Wait for the running download to finish.");
    await fsp.rm(dir, { recursive: true, force: true });
    use(null); current = null;
    return status();
  }

  handle("fd:status", () => status());
  handle("fd:update", () => update());
  handle("fd:search", (_e, o) => search(o));
  handle("fd:lookup", (_e, pkgs, phone) => lookup(pkgs, phone));
  handle("fd:app", (_e, pkg, phone) => details(pkg, phone));
  handle("fd:icon", (_e, pkg) => icon(pkg));
  handle("fd:shot", (_e, pkg, i) => shot(pkg, i));
  handle("fd:fetch", (_e, pkg, code) => fetchApk(pkg, code));
  handle("fd:read", (_e, offset, length) => read(offset, length));
  handle("fd:save", (event) => save(event));
  handle("fd:cancel", () => cancel());
  handle("fd:clear", () => clear());

  return { stop: () => abort?.abort() };
}

module.exports = { setupFdroid, readSignedJar, buildCatalog, suggest, fits, FINGERPRINT };
