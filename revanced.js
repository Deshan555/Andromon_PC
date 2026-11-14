// Droid Desk — ReVanced patching on this computer (main process).
//
// ReVanced (https://revanced.app) patches an app's APK to change how it behaves. Droid Desk doesn't
// ship any of it: when the person asks, this file downloads ReVanced's own tools and runs them.
//   - ReVanced CLI   a Java program (needs Java 17 or newer on this computer). One fixed version,
//                    checked against the SHA-256 below after the download.
//   - patches.rvp    the patches, from api.revanced.app. Its PGP signature is checked here against
//                    ReVanced's signing key (pinned by fingerprint) before the file is ever used.
//   - ReVanced Manager and GmsCore: APKs for the phone, from ReVanced's GitHub releases.
// The app to patch is never downloaded: it comes from the phone or from a file the person chooses.
//
// Everything is kept in <userData>/revanced. The sandboxed page never names a path: it refers to
// files by a fixed name ("out", "manager", "gmscore") or streams an APK in through open/write/close.
const { app, dialog, net, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = fs.promises;
const crypto = require("node:crypto");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");

const API = "https://api.revanced.app/v5";
// Bump these two together when moving to a newer CLI (the hash is of the release's "-all.jar").
const CLI_VERSION = "6.0.0";
const CLI_SHA256 = "c25549bc17d59d2eb94fa5f86e60e9b77a02772ca88f7050f8f1276f923a9958";
const CLI_URL = `https://github.com/ReVanced/revanced-cli/releases/download/v${CLI_VERSION}/revanced-cli-${CLI_VERSION}-all.jar`;
const GMSCORE_RELEASE = "https://api.github.com/repos/ReVanced/GmsCore/releases/latest";
// ReVanced's signing key (primary key fingerprint). The key itself comes from api.revanced.app/keys.
const KEY_FINGERPRINT = "a7835dfcaca14bda3cd6edd3633c6920fbe6a2ff";
const MIN_JAVA = 17;
const LIST_FORMAT = 2; // of the cached patch list; bump when parsePatchList returns something new
const MAX_APK = 2 * 1024 ** 3;
const READ_CHUNK = 8 * 1024 * 1024;
// Downloads may start only at these places (redirects to GitHub's file servers are followed).
const ALLOWED = [/^https:\/\/api\.revanced\.app\//, /^https:\/\/github\.com\/ReVanced\//, /^https:\/\/api\.github\.com\/repos\/ReVanced\//];

// ---------- a small OpenPGP reader: enough to check a detached signature ----------
function dearmor(buf) {
  const text = buf.toString("latin1");
  if (!text.startsWith("-----BEGIN PGP")) return buf;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "");
  const body = [];
  for (const l of lines.slice(start + 1)) { if (l.startsWith("=") || l.startsWith("-----")) break; body.push(l.trim()); }
  return Buffer.from(body.join(""), "base64");
}
function* packets(buf) {
  let p = 0;
  while (p < buf.length) {
    const tagByte = buf[p++];
    if (!(tagByte & 0x80)) throw new Error("Bad PGP data");
    let tag, len;
    if (tagByte & 0x40) {
      tag = tagByte & 0x3f;
      const o = buf[p++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[p++] + 192;
      else if (o === 255) { len = buf.readUInt32BE(p); p += 4; }
      else throw new Error("Unsupported PGP packet length");
    } else {
      tag = (tagByte >> 2) & 0x0f;
      const lt = tagByte & 3;
      if (lt === 0) len = buf[p++];
      else if (lt === 1) { len = buf.readUInt16BE(p); p += 2; }
      else if (lt === 2) { len = buf.readUInt32BE(p); p += 4; }
      else len = buf.length - p;
    }
    if (p + len > buf.length) throw new Error("Bad PGP data");
    yield { tag, body: buf.subarray(p, p + len) };
    p += len;
  }
}
function readMpi(buf, p) {
  const bytes = (buf.readUInt16BE(p) + 7) >> 3;
  return { value: buf.subarray(p + 2, p + 2 + bytes), next: p + 2 + bytes };
}
const b64u = (b) => Buffer.from(b).toString("base64url");
function parseKey(body) {
  if (body[0] !== 4) return null;
  const algo = body[5];
  const k = { body, algo, fingerprint: crypto.createHash("sha1").update(Buffer.from([0x99, body.length >> 8, body.length & 255])).update(body).digest("hex") };
  try {
    if (algo === 1 || algo === 3) {
      const n = readMpi(body, 6), e = readMpi(body, n.next);
      k.bytes = n.value.length;
      k.key = crypto.createPublicKey({ key: { kty: "RSA", n: b64u(n.value), e: b64u(e.value) }, format: "jwk" });
    } else if (algo === 22) {
      const q = readMpi(body, 7 + body[6]);
      if (q.value[0] !== 0x40 || q.value.length !== 33) return null;
      k.key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(q.value.subarray(1)) }, format: "jwk" });
    } else return null;
  } catch { return null; }
  return k;
}
const HASHES = { 8: "sha256", 9: "sha384", 10: "sha512" };
function parseSig(body) {
  if (body[0] !== 4) return null;
  const hashedLen = body.readUInt16BE(4);
  const hashedEnd = 6 + hashedLen;
  const unhashedLen = body.readUInt16BE(hashedEnd);
  const mpiStart = hashedEnd + 2 + unhashedLen + 2;
  const sig = { type: body[1], algo: body[2], hash: HASHES[body[3]], hashed: body.subarray(0, hashedEnd), issuers: [], mpis: [] };
  const subs = (area) => {
    let p = 0;
    while (p < area.length) {
      let len = area[p++];
      if (len >= 192 && len < 255) len = ((len - 192) << 8) + area[p++] + 192;
      else if (len === 255) { len = area.readUInt32BE(p); p += 4; }
      const type = area[p] & 0x7f, data = area.subarray(p + 1, p + len);
      if (type === 33 && data[0] === 4) sig.issuers.push(data.subarray(1).toString("hex"));
      if (type === 16) sig.issuers.push(data.toString("hex"));
      p += len;
    }
  };
  subs(body.subarray(6, hashedEnd));
  subs(body.subarray(hashedEnd + 2, hashedEnd + 2 + unhashedLen));
  for (let p = mpiStart; p < body.length;) { const m = readMpi(body, p); sig.mpis.push(m.value); p = m.next; }
  return sig;
}
const sigTrailer = (sig) => { const t = Buffer.alloc(6); t[0] = 4; t[1] = 0xff; t.writeUInt32BE(sig.hashed.length, 2); return t; };
const leftPad = (b, n) => (b.length >= n ? b : Buffer.concat([Buffer.alloc(n - b.length), b]));
// feed(update): calls update(chunk) for everything that is signed, before the signature's own part.
async function checkSig(sig, key, feed) {
  if (!sig.hash || !key?.key) return false;
  if ((sig.algo === 1 || sig.algo === 3) && (key.algo === 1 || key.algo === 3) && sig.mpis.length === 1) {
    const v = crypto.createVerify(sig.hash);
    await feed((c) => v.update(c));
    v.update(sig.hashed); v.update(sigTrailer(sig));
    return v.verify(key.key, leftPad(sig.mpis[0], key.bytes));
  }
  if (sig.algo === 22 && key.algo === 22 && sig.mpis.length === 2) {
    const h = crypto.createHash(sig.hash);
    await feed((c) => h.update(c));
    h.update(sig.hashed); h.update(sigTrailer(sig));
    return crypto.verify(null, h.digest(), key.key, Buffer.concat([leftPad(sig.mpis[0], 32), leftPad(sig.mpis[1], 32)]));
  }
  return false;
}
const keyFrame = (body) => Buffer.concat([Buffer.from([0x99, body.length >> 8, body.length & 255]), body]);
// The keys that may sign for ReVanced: the pinned primary key and every subkey it vouches for.
async function trustedKeys(keyringBytes) {
  const keys = [];
  let primary = null, sub = null;
  for (const { tag, body } of packets(dearmor(keyringBytes))) {
    if (tag === 6) {
      primary = parseKey(body); sub = null;
      if (!primary || primary.fingerprint !== KEY_FINGERPRINT) throw new Error("The signing key from revanced.app isn't the one Droid Desk expects.");
      keys.push(primary);
    } else if (tag === 14) {
      sub = primary ? parseKey(body) : null;
    } else if (tag === 2 && primary && sub) {
      const sig = parseSig(body);
      const target = sub;
      if (sig?.type === 0x18 && await checkSig(sig, primary, (u) => { u(keyFrame(primary.body)); u(keyFrame(target.body)); })) { keys.push(sub); sub = null; }
    }
  }
  if (!primary) throw new Error("No signing key found.");
  return keys;
}
async function verifyDetached(file, sigBytes, keyringBytes) {
  const keys = await trustedKeys(keyringBytes);
  for (const { tag, body } of packets(dearmor(sigBytes))) {
    if (tag !== 2) continue;
    const sig = parseSig(body);
    if (!sig || sig.type !== 0x00) continue;
    for (const key of keys) {
      if (sig.issuers.length && !sig.issuers.some((i) => key.fingerprint.endsWith(i))) continue;
      const ok = await checkSig(sig, key, async (u) => { for await (const chunk of fs.createReadStream(file)) u(chunk); });
      if (ok) return true;
    }
  }
  return false;
}

// ---------- the list of patches, as the CLI prints it ----------
// Blocks separated by a "Name:" at the start of a line; options and packages are tab-indented.
function parsePatchList(text) {
  const patches = [];
  let cur = null, section = "", pkg = null, field = "", opt = null;
  for (const raw of text.replace(/^INFO: /, "").split(/\r?\n/)) {
    if (/^(SEVERE|WARNING|INFO): /.test(raw)) continue;
    const depth = raw.match(/^\t*/)[0].length;
    const line = raw.trim();
    if (depth === 0) {
      let m;
      if ((m = line.match(/^Name: (.*)$/))) { cur = { name: m[1], description: "", enabled: false, options: [], packages: null }; patches.push(cur); section = ""; field = ""; }
      else if (!cur) continue;
      else if ((m = line.match(/^Description: (.*)$/))) { cur.description = m[1]; field = "description"; }
      else if ((m = line.match(/^Enabled: (true|false)$/))) { cur.enabled = m[1] === "true"; field = ""; }
      else if (line === "Options:") { section = "options"; field = ""; opt = null; }
      else if (line === "Compatible packages:") { section = "packages"; cur.packages = []; pkg = null; field = ""; }
      else if (line && field === "description" && !section) cur.description += " " + line;
      continue;
    }
    if (!cur) continue;
    if (section === "options") {
      // Name, Description, Required, Default, Type; "Possible values:" lists "value (Label)" one level deeper.
      let m;
      if (depth === 1 && (m = line.match(/^Name: (.*)$/))) { opt = { name: m[1], description: "", required: false, default: "", type: "", values: [] }; cur.options.push(opt); field = ""; }
      else if (!opt) continue;
      else if (depth === 1 && (m = line.match(/^Description: (.*)$/))) { opt.description = m[1]; field = ""; }
      else if (depth === 1 && (m = line.match(/^Required: (true|false)$/))) opt.required = m[1] === "true";
      else if (depth === 1 && (m = line.match(/^Default: (.*)$/))) opt.default = m[1];
      else if (depth === 1 && (m = line.match(/^Type: (.*)$/))) opt.type = m[1].replace(/^kotlin\./, "");
      else if (depth === 1 && line === "Possible values:") field = "values";
      else if (depth === 2 && field === "values" && (m = line.match(/^(.*?)(?: \((.*)\))?$/)) && m[1]) opt.values.push({ value: m[1], label: m[2] || "" });
    } else if (section === "packages") {
      const m = line.match(/^Package name: (.*)$/);
      if (depth === 1 && m) { pkg = { name: m[1], versions: [] }; cur.packages.push(pkg); }
      else if (depth === 2 && pkg && line) pkg.versions.push(line);
    }
  }
  return patches;
}

function setupRevanced(handle, { userData, getWindow }) {
  const dir = path.join(userData, "revanced");
  const work = path.join(dir, "work");
  const P = {
    cli: path.join(dir, `revanced-cli-${CLI_VERSION}.jar`),
    patches: path.join(dir, "patches.rvp"),
    meta: path.join(dir, "patches.json"),
    list: path.join(dir, "patch-list.json"),
    keystore: path.join(dir, "droiddesk.keystore"),
    input: path.join(work, "input.apk"),
    out: path.join(work, "patched.apk"),
    tmp: path.join(work, "tmp"),
    manager: path.join(dir, "manager.apk"),
    gmscore: path.join(dir, "gmscore.apk"),
  };
  const emit = (ev) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send("rv:event", ev); };
  const exists = (f) => fsp.access(f).then(() => true, () => false);
  const readJson = async (f) => { try { return JSON.parse(await fsp.readFile(f, "utf8")); } catch { return null; } };

  // ----- Java -----
  let javaCache = null;
  const run = (file, args, opts = {}) => new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout) + String(stderr) }));
  });
  async function javaCandidates() {
    const exe = process.platform === "win32" ? "java.exe" : "java";
    const list = [];
    if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, "bin", exe));
    if (process.platform === "darwin") {
      const r = await run("/usr/libexec/java_home", ["-v", `${MIN_JAVA}+`]);
      if (r.ok && r.out.trim().startsWith("/")) list.push(path.join(r.out.trim().split("\n")[0], "bin", "java"));
      list.push("/opt/homebrew/opt/openjdk/bin/java", "/usr/local/opt/openjdk/bin/java",
        "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java");
    }
    for (const d of (process.env.PATH || "").split(path.delimiter)) {
      // macOS's /usr/bin/java is a stub that opens an "install Java" window when there is none.
      if (d && !(process.platform === "darwin" && d === "/usr/bin")) list.push(path.join(d, exe));
    }
    const roots = process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).flatMap((p) => ["Java", "Eclipse Adoptium", "Microsoft", "Zulu", "Amazon Corretto", "Android\\Android Studio"].map((v) => path.join(p, v)))
      : process.platform === "darwin" ? ["/Library/Java/JavaVirtualMachines", path.join(os.homedir(), "Library/Java/JavaVirtualMachines")]
        : ["/usr/lib/jvm"];
    for (const root of roots) {
      const names = await fsp.readdir(root).catch(() => []);
      for (const n of names) {
        list.push(path.join(root, n, "bin", exe), path.join(root, n, "Contents", "Home", "bin", exe), path.join(root, n, "jbr", "bin", exe));
      }
    }
    return [...new Set(list)];
  }
  async function findJava(force = false) {
    if (javaCache && !force) return javaCache;
    let best = null;
    for (const file of await javaCandidates()) {
      if (!(await exists(file))) continue;
      const r = await run(file, ["-version"]);
      const m = r.out.match(/version "(\d+)(?:\.(\d+))?[^"]*"/);
      if (!m) continue;
      const major = m[1] === "1" ? Number(m[2]) : Number(m[1]);
      const found = { path: file, version: r.out.match(/version "([^"]+)"/)[1], major, ok: major >= MIN_JAVA };
      if (!best || found.major > best.major) best = found;
      if (found.ok) break;
    }
    javaCache = best;
    return best;
  }

  // ----- downloads -----
  let busy = null; // "setup" | "patch" | "download": one long job at a time
  const lock = async (what, fn) => {
    if (busy) throw new Error(busy === "patch" ? "A patch is running. Wait for it to finish." : "A download is running. Wait for it to finish.");
    busy = what;
    try { return await fn(); } finally { busy = null; }
  };
  const allowed = (url) => ALLOWED.some((re) => re.test(url));
  async function getJson(url) {
    if (!allowed(url)) throw new Error("Download address not allowed");
    const res = await net.fetch(url, { headers: { accept: "application/json", "user-agent": "DroidDesk" } });
    if (!res.ok) throw new Error(`Couldn't reach ${new URL(url).host} (HTTP ${res.status}).`);
    return res.json();
  }
  // Every download says when it starts and ends (for the download manager) and can be cancelled.
  let dlAbort = null;
  async function download(url, dest, what, limit = MAX_APK) {
    if (!allowed(url)) throw new Error("Download address not allowed");
    const ac = dlAbort = new AbortController();
    emit({ kind: "download", phase: "start", what, from: new URL(url).host });
    try {
      const part = await downloadTo(url, dest, what, limit, ac.signal);
      emit({ kind: "download", phase: "end", what, ok: true });
      return part;
    } catch (e) {
      emit({ kind: "download", phase: "end", what, ok: false, cancelled: ac.signal.aborted, error: String(e?.message || e) });
      throw ac.signal.aborted ? new Error("The download was cancelled.") : e;
    } finally { if (dlAbort === ac) dlAbort = null; }
  }
  async function downloadTo(url, dest, what, limit, signal) {
    const res = await net.fetch(url, { headers: { "user-agent": "DroidDesk" }, signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${what} (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const part = dest + ".part";
    const fh = await fsp.open(part, "w");
    let done = 0, last = 0;
    try {
      for await (const chunk of res.body) {
        done += chunk.length;
        if (done > limit) throw new Error(`${what} is larger than expected.`);
        await fh.write(chunk);
        if (Date.now() - last > 200) { last = Date.now(); emit({ kind: "progress", what, done, total }); }
      }
    } catch (e) { await fh.close(); await fsp.rm(part, { force: true }); throw e; }
    await fh.close();
    emit({ kind: "progress", what, done, total: total || done });
    return part; // the caller checks it, then renames it into place
  }
  const sha256 = async (file) => {
    const h = crypto.createHash("sha256");
    for await (const c of fs.createReadStream(file)) h.update(c);
    return h.digest("hex");
  };

  async function status() {
    const [java, cli, meta, hasPatches] = await Promise.all([findJava(), exists(P.cli), readJson(P.meta), exists(P.patches)]);
    return {
      java: java ? { version: java.version, ok: java.ok } : null, minJava: MIN_JAVA,
      cli: cli ? { version: CLI_VERSION } : null,
      patches: meta && hasPatches ? { version: meta.version, createdAt: meta.createdAt, fetchedAt: meta.fetchedAt } : null,
      busy,
    };
  }

  // Downloads the CLI (once) and the newest patches, and checks both before they are used.
  const setup = () => lock("setup", async () => {
    if (!(await exists(P.cli))) {
      const part = await download(CLI_URL, P.cli, "ReVanced CLI", 200 * 1024 ** 2);
      if ((await sha256(part)) !== CLI_SHA256) { await fsp.rm(part, { force: true }); throw new Error("The ReVanced CLI download doesn't match the expected file. Nothing was kept."); }
      await fsp.rename(part, P.cli);
    }
    const info = await getJson(`${API}/patches`);
    const meta = await readJson(P.meta);
    if (!meta || meta.version !== info.version || !(await exists(P.patches))) {
      if (typeof info.download_url !== "string" || typeof info.signature_download_url !== "string") throw new Error("revanced.app sent an unexpected answer.");
      const part = await download(info.download_url, P.patches, "ReVanced patches", 200 * 1024 ** 2);
      try {
        if (!allowed(info.signature_download_url)) throw new Error("Download address not allowed");
        const [sig, keys] = await Promise.all([info.signature_download_url, "https://api.revanced.app/keys"].map(async (u) => {
          const r = await net.fetch(u, { headers: { "user-agent": "DroidDesk" } });
          if (!r.ok) throw new Error(`Couldn't download the patches' signature (HTTP ${r.status}).`);
          return Buffer.from(await r.arrayBuffer());
        }));
        if (!(await verifyDetached(part, sig, keys))) throw new Error("The patches file isn't signed by ReVanced. Nothing was kept.");
      } catch (e) { await fsp.rm(part, { force: true }); throw e; }
      await fsp.rename(part, P.patches);
      await fsp.rm(P.list, { force: true });
      await fsp.writeFile(P.meta, JSON.stringify({ version: info.version, createdAt: info.created_at, fetchedAt: Date.now() }));
    } else {
      await fsp.writeFile(P.meta, JSON.stringify({ ...meta, fetchedAt: Date.now() }));
    }
    return status();
  });

  async function needTools() {
    const java = await findJava();
    if (!java?.ok) throw new Error(`Patching needs Java ${MIN_JAVA} or newer on this computer.`);
    if (!(await exists(P.cli)) || !(await exists(P.patches))) throw new Error("Download the ReVanced patcher first.");
    return java;
  }
  // The patches file was verified here when it was downloaded, so the CLI's own check (which wants
  // a GitHub attestation that ReVanced's API doesn't serve) is skipped with -b.
  async function patchList() {
    const meta = await readJson(P.meta);
    const cached = await readJson(P.list);
    if (cached && meta && cached.format === LIST_FORMAT && cached.version === meta.version && cached.cli === CLI_VERSION) return cached.patches;
    const java = await needTools();
    const r = await run(java.path, ["-jar", P.cli, "list-patches", "-p", P.patches, "-b", "--packages", "--versions", "--options"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const patches = parsePatchList(r.out);
    if (!patches.length) throw new Error("Couldn't read the list of patches. " + r.out.trim().split("\n").slice(-2).join(" ").slice(0, 300));
    await fsp.writeFile(P.list, JSON.stringify({ format: LIST_FORMAT, version: meta?.version, cli: CLI_VERSION, patches }));
    return patches;
  }

  // ----- the APK to patch: streamed in from the phone, or a file the person picked -----
  let incoming = null; // { fh, bytes }
  let input = null;    // { path, name } ready to patch
  let output = null;   // { name } after a successful patch
  async function inputOpen(name) {
    if (busy === "patch") throw new Error("A patch is running.");
    if (incoming) { await incoming.fh.close().catch(() => {}); incoming = null; }
    await fsp.mkdir(work, { recursive: true });
    input = null;
    incoming = { fh: await fsp.open(P.input, "w"), bytes: 0, name: String(name || "app.apk").replace(/[^\w.\- ]/g, "_").slice(0, 120) };
    return true;
  }
  async function inputWrite(data) {
    if (!incoming || !(data instanceof Uint8Array)) throw new Error("No file is being received.");
    incoming.bytes += data.byteLength;
    if (incoming.bytes > MAX_APK) throw new Error("The APK is too large.");
    await incoming.fh.write(data);
    return incoming.bytes;
  }
  async function inputClose(ok) {
    if (!incoming) return null;
    const { fh, bytes, name } = incoming; incoming = null;
    await fh.close();
    if (!ok || !bytes) { await fsp.rm(P.input, { force: true }); return null; }
    input = { path: P.input, name };
    return { name, size: bytes };
  }
  async function inputFile(file) {
    if (typeof file !== "string" || !path.isAbsolute(file) || !/\.apk$/i.test(file)) throw new Error("Choose an .apk file.");
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_APK) throw new Error("Choose an .apk file.");
    input = { path: file, name: path.basename(file) };
    return { name: input.name, size: st.size };
  }

  // ----- patching -----
  let child = null, cancelled = false;
  const patch = (opts) => lock("patch", async () => {
    const java = await needTools();
    if (!input || !(await exists(input.path))) throw new Error("Choose the app to patch first.");
    const names = Array.isArray(opts?.patches) ? opts.patches.map(String).filter((n) => n && n.length < 200 && !/[\r\n]/.test(n)) : [];
    if (!names.length) throw new Error("Tick at least one patch.");
    await fsp.rm(P.tmp, { recursive: true, force: true });
    await fsp.rm(P.out, { force: true });
    await fsp.mkdir(P.tmp, { recursive: true });
    output = null;
    // --exclusive: exactly the ticked patches, whatever the defaults are.
    // A patch's settings go right before it: -O "<setting's name>=<value>" ... -e "<patch>".
    const clean = (v) => typeof v === "string" && v.length > 0 && v.length < 500 && !/[\r\n\0]/.test(v);
    const settings = (n) => Object.entries(opts?.options?.[n] && typeof opts.options[n] === "object" ? opts.options[n] : {})
      .filter(([k, v]) => clean(k) && !k.includes("=") && clean(v)).flatMap(([k, v]) => ["-O", `${k}=${v}`]);
    const args = ["-jar", P.cli, "patch", "-p", P.patches, "-b", "--exclusive", ...names.flatMap((n) => [...settings(n), "-e", n]),
      "-o", P.out, "-t", P.tmp, "--purge", "--keystore", P.keystore];
    if (opts?.force) args.push("-f");
    args.push(input.path);
    cancelled = false;
    const tail = [];
    const code = await new Promise((resolve, reject) => {
      child = spawn(java.path, args, { cwd: work, windowsHide: true });
      const feed = (stream) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (d) => {
          buf += d;
          const lines = buf.split(/\r?\n/); buf = lines.pop();
          for (const line of lines) { if (!line.trim()) continue; tail.push(line); if (tail.length > 40) tail.shift(); emit({ kind: "log", line: line.slice(0, 2000) }); }
        });
      };
      feed(child.stdout); feed(child.stderr);
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => { child = null; });
    await fsp.rm(P.tmp, { recursive: true, force: true }).catch(() => {});
    if (cancelled) throw new Error("Patching was cancelled.");
    const failed = tail.filter((l) => /^SEVERE:/.test(l));
    if (code !== 0 || !(await exists(P.out))) {
      throw new Error("Patching failed. " + (failed.at(-1) || tail.at(-1) || `The patcher stopped with code ${code}.`).replace(/^SEVERE:\s*/, "").slice(0, 400));
    }
    const st = await fsp.stat(P.out);
    output = { name: input.name.replace(/\.apk$/i, "") + "-revanced.apk" };
    // A patch that fails is reported by the CLI, but the other patches are still applied.
    return { size: st.size, name: output.name, failed: failed.map((l) => l.replace(/^SEVERE:\s*/, "").slice(0, 300)) };
  });
  function cancel() {
    if (child) { cancelled = true; child.kill(); }
    dlAbort?.abort();
    return true;
  }

  // ----- files for the phone -----
  async function toolInfo() {
    const [manager, gms] = await Promise.allSettled([getJson(`${API}/manager`), getJson(GMSCORE_RELEASE)]);
    const out = { manager: null, gmscore: null };
    if (manager.status === "fulfilled" && typeof manager.value?.download_url === "string") out.manager = { version: String(manager.value.version || "").replace(/^v/, ""), url: manager.value.download_url };
    if (gms.status === "fulfilled" && Array.isArray(gms.value?.assets)) {
      const pick = (hw) => gms.value.assets.find((a) => /\.apk$/i.test(a.name) && /-hw-/.test(a.name) === hw);
      const a = pick(false), h = pick(true);
      if (a) out.gmscore = { version: String(gms.value.tag_name || "").replace(/^v/, ""), url: a.browser_download_url, hwUrl: h?.browser_download_url || null, size: a.size };
    }
    return out;
  }
  const fetchTool = (which, huawei) => lock("download", async () => {
    if (which !== "manager" && which !== "gmscore") throw new Error("Unknown download");
    const info = (await toolInfo())[which];
    if (!info) throw new Error("Couldn't find the download. Check the internet connection.");
    const url = which === "gmscore" && huawei && info.hwUrl ? info.hwUrl : info.url;
    const part = await download(url, P[which], which === "manager" ? "ReVanced Manager" : "GmsCore", 400 * 1024 ** 2);
    await fsp.rename(part, P[which]);
    return { version: info.version, size: (await fsp.stat(P[which])).size };
  });
  async function read(which, offset, length) {
    const file = which === "out" ? (output && P.out) : which === "manager" ? P.manager : which === "gmscore" ? P.gmscore : null;
    if (!file) throw new Error("Nothing to read.");
    const off = Math.max(0, Number(offset) || 0), len = Math.min(READ_CHUNK, Math.max(0, Number(length) || 0));
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally { await fh.close(); }
  }
  async function saveOutput(event) {
    if (!output || !(await exists(P.out))) throw new Error("Nothing to save yet.");
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showSaveDialog(win, { title: "Save the patched app", defaultPath: path.join(app.getPath("downloads"), output.name), filters: [{ name: "Android app", extensions: ["apk"] }] });
    if (r.canceled || !r.filePath) return null;
    await fsp.copyFile(P.out, r.filePath);
    return path.basename(r.filePath);
  }
  // Removes the downloaded tools and work files. The signing key stays: without it, the next
  // patched build couldn't update the one already on the phone.
  async function clear() {
    if (busy) throw new Error("Wait for the running job to finish.");
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (f !== path.basename(P.keystore)) await fsp.rm(path.join(dir, f), { recursive: true, force: true });
    }
    input = null; output = null;
    return status();
  }

  handle("rv:status", () => status());
  handle("rv:recheckJava", async () => { await findJava(true); return status(); });
  handle("rv:setup", () => setup());
  handle("rv:patches", () => patchList());
  handle("rv:inputOpen", (_e, name) => inputOpen(name));
  handle("rv:inputWrite", (_e, data) => inputWrite(data));
  handle("rv:inputClose", (_e, ok) => inputClose(ok));
  handle("rv:inputFile", (_e, file) => inputFile(file));
  handle("rv:patch", (_e, opts) => patch(opts));
  handle("rv:cancel", () => cancel());
  handle("rv:toolInfo", () => toolInfo());
  handle("rv:fetchTool", (_e, which, huawei) => fetchTool(which, huawei));
  handle("rv:read", (_e, which, offset, length) => read(which, offset, length));
  handle("rv:saveOutput", (event) => saveOutput(event));
  handle("rv:clear", () => clear());

  return { stop: () => { if (child) { cancelled = true; child.kill(); } } };
}

module.exports = { setupRevanced, parsePatchList, verifyDetached };
