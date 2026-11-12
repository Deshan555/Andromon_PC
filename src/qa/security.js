// App testing › Security scan: checks an app the user builds for common security mistakes, like MobSF
// or Android lint's security checks.
//
// - Static (./scanner.js): manifest flags, network security config, exported components, deep links,
//   permissions, signing, and strings in the code (secrets, http:// URLs, risky APIs, weak crypto).
//   Works on the app installed on the phone (its APKs are copied over) or an .apk from this computer.
// - On the phone (installed app only): content providers that answer any app, private files and
//   SharedPreferences (debuggable builds, via run-as), files in Android/data, secrets in the app's
//   log, and whether its WebViews can be debugged. Everything is read-only.
//
// Strings from the app and the phone are untrusted: shown with textContent / el() only, and escaped
// in the HTML report. Secrets are masked before they are stored (scanner.mask).

import { scanApk, mask, SEVERITIES } from "./scanner.js";

const SEV_LABEL = { high: "High", medium: "Medium", low: "Low", info: "Info" };
const PKG_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const AUTH_RE = /^[A-Za-z0-9._-]+$/;
const PREF_KEY = /token|passw|pwd|secret|api_?key|apikey|session|auth|jwt|refresh|credential|private/i;
const LOG_RULES = [
  { re: /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/, sev: "medium", what: "Bearer token" },
  { re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/, sev: "medium", what: "JWT" },
  { re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?id)["']?\s*[:=]\s*["']?([^\s"',;}]{4,})/i, sev: "medium", what: "Password or token" },
  { re: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/, sev: "low", what: "Email address" },
];
const RISKY_FILE = /\.(db|sqlite3?|realm|json|xml|txt|log|csv|key|pem|p12|pfx|jks|keystore|bks|crt|cer|zip|bak)$/i;

export function mount(root, ctx) {
  const { el, sh, shQuote, toast, showError, clearError, store } = ctx;
  let source = store.get("securitySource", "phone"); // "phone" | "file"
  let files = null; // [File] chosen from this computer
  let result = null; // last scan
  let filter = "all";
  let running = false;

  // ---------- input ----------
  const sourceSeg = el("div", { className: "seg" });
  const srcBtns = {};
  for (const [id, label] of [["phone", "App on the phone"], ["file", "APK file"]]) {
    const b = el("button", { type: "button", textContent: label });
    b.onclick = () => { source = id; store.set("securitySource", id); renderSource(); };
    srcBtns[id] = b; sourceSeg.append(b);
  }
  const picker = ctx.app.picker();
  const lastScan = el("div", { className: "dev-note" });
  const phoneSw = ctx.makeSwitch(store.get("securityPhone", true), async (want) => { store.set("securityPhone", want); return want; });
  const phoneRow = el("label", { className: "sec-opt" }, phoneSw,
    el("span", {}, el("span", { textContent: "Also check on the phone" }),
      el("span", { className: "sub", textContent: "Content providers, private files (debuggable builds), shared folder, the app's log, WebView debugging. Read-only." })));
  const fileIn = el("input", { type: "file", accept: ".apk", multiple: true, hidden: true });
  const fileName = el("span", { className: "muted", textContent: "No file chosen" });
  const chooseBtn = el("button", { className: "btn sm", type: "button", textContent: "Choose APK…" });
  chooseBtn.onclick = () => fileIn.click();
  fileIn.onchange = () => { if (fileIn.files.length) setFiles([...fileIn.files]); fileIn.value = ""; };
  const drop = el("div", { className: "sec-drop" }, chooseBtn, fileName,
    el("span", { className: "dev-lbl", textContent: "or drop an .apk here (several files for a split app, base first)" }));
  for (const t of ["dragenter", "dragover"]) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const t of ["dragleave", "drop"]) drop.addEventListener(t, () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const fs = [...(e.dataTransfer?.files || [])].filter((f) => /\.apk$/i.test(f.name));
    if (fs.length) setFiles(fs); else toast("Drop an .apk file");
  });
  function setFiles(fs) {
    // base.apk (or the one without "split"/"config" in its name) first.
    fs.sort((a, b) => rank(a.name) - rank(b.name));
    files = fs;
    fileName.textContent = fs.map((f) => `${f.name} (${ctx.fmtSize(f.size)})`).join(", ");
  }
  const rank = (n) => (/^base\.apk$/i.test(n) ? 0 : /split|config\./i.test(n) ? 2 : 1);

  const scanBtn = el("button", { className: "btn primary", type: "button", textContent: "Scan" });
  scanBtn.onclick = () => runScan();
  const progress = el("div", { className: "sec-progress", hidden: true }, el("div", { className: "bar" }, el("i")), el("div", { className: "dev-note" }));
  const setProgress = (text, frac) => {
    progress.hidden = false;
    progress.querySelector("i").style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    progress.querySelector(".dev-note").textContent = text;
  };

  const phoneBox = el("div", {}, picker, lastScan, phoneRow);
  const fileBox = el("div", { hidden: true }, drop);
  root.append(ctx.card("Security scan", sourceSeg, phoneBox, fileBox,
    el("div", { className: "dev-row", style: "margin-top:14px" }, scanBtn), progress,
    el("p", { className: "dev-note", textContent: "For apps you build or are allowed to test. It reads the app and the phone; it doesn't attack anything or change the app." })));

  function renderSource() {
    for (const [id, b] of Object.entries(srcBtns)) b.classList.toggle("on", id === source);
    phoneBox.hidden = source !== "phone"; fileBox.hidden = source !== "file";
    renderLast();
  }
  function renderLast() {
    const p = ctx.app.get();
    const last = (store.get("security", {}) || {})[p];
    lastScan.textContent = last ? `Last scan of ${p}: ${new Date(last.date).toLocaleString()} · ${SEVERITIES.map((s) => `${last.counts[s] || 0} ${SEV_LABEL[s].toLowerCase()}`).join(", ")}` : "";
  }
  ctx.app.onChange(renderLast);
  renderSource();

  // ---------- results ----------
  const results = el("div", { className: "card sec-results", hidden: true });
  root.append(results);

  // ---------- scanning ----------
  async function runScan() {
    if (running) return;
    clearError();
    let parts, pkg = "";
    running = true; ctx.busy(scanBtn, true, "Scanning…");
    try {
      if (source === "file") {
        if (!files?.length) throw new Error("Choose an .apk file first.");
        setProgress("Reading the file…", 0.01);
        parts = [];
        for (const f of files) parts.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      } else {
        if (!ctx.getAdb()) throw new Error("Connect a phone first.");
        pkg = ctx.app.get();
        if (!PKG_RE.test(pkg)) throw new Error("Pick an app first (type its package or click “Current app”).");
        parts = await pullApks(pkg);
      }
      const r = await scanApk(parts, { onProgress: (t, f) => setProgress(t, source === "phone" ? 0.25 + f * 0.55 : f) });
      parts = null; // let the APK bytes go
      if (source === "phone" && pkg && r.info.package && r.info.package !== pkg) throw new Error("The copied APK belongs to another app.");
      if (source === "phone" && store.get("securityPhone", true) && ctx.getAdb()) {
        setProgress("Checking on the phone…", 0.82);
        const extra = await phoneChecks(r.info.package, r);
        r.findings.push(...extra);
        r.findings.sort((a, b) => SEVERITIES.indexOf(a.sev) - SEVERITIES.indexOf(b.sev));
        r.findings.forEach((f, i) => { f.id = i + 1; });
        r.counts = Object.fromEntries(SEVERITIES.map((s) => [s, r.findings.filter((f) => f.sev === s).length]));
        r.phoneChecked = true;
      }
      r.date = Date.now(); r.source = source;
      result = r; filter = "all";
      const all = store.get("security", {}) || {};
      all[r.info.package || "file"] = { date: r.date, counts: r.counts, version: r.info.versionName };
      store.set("security", all);
      renderLast(); renderResults();
      toast(`Scan finished: ${r.counts.high} high, ${r.counts.medium} medium`);
    } catch (e) { showError(e); }
    finally { running = false; ctx.busy(scanBtn, false); progress.hidden = true; }
  }

  // Copies the app's APKs (base + splits) from the phone, with a progress bar.
  async function pullApks(pkg) {
    setProgress("Finding the app on the phone…", 0.01);
    const out = await sh(`pm path --user 0 ${shQuote(pkg)} 2>/dev/null || pm path ${shQuote(pkg)}`);
    const paths = out.split("\n").map((l) => l.trim().replace(/^package:/, "")).filter((p) => p.endsWith(".apk"));
    if (!paths.length) throw new Error(`${pkg} isn't installed on the phone.`);
    paths.sort((a, b) => (/\/base\.apk$/.test(a) ? -1 : 0) - (/\/base\.apk$/.test(b) ? -1 : 0));
    const sizes = await Promise.all(paths.map((p) => ctx.withSync((s) => s.stat(p)).then((st) => Number(st.size), () => 0)));
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    let got = 0;
    const parts = [];
    for (const p of paths) {
      const chunks = [];
      await ctx.withSync(async (s) => {
        const reader = s.read(p).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value.slice()); got += value.length;
          setProgress(`Copying the app from the phone… ${ctx.fmtSize(got)} of ${ctx.fmtSize(total)}`, 0.02 + 0.22 * (got / total));
        }
      });
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0; for (const c of chunks) { bytes.set(c, o); o += c.length; }
      parts.push({ name: p.split("/").pop(), bytes });
    }
    return parts;
  }

  // ---------- checks on the phone ----------
  async function phoneChecks(pkg, r) {
    const out = [];
    const add = (f) => out.push({ cat: "On the phone", evidence: [], ...f });
    if (!PKG_RE.test(pkg)) return out;
    const q = shQuote(pkg);

    // 1. Exported content providers: does a plain query return rows?
    const auths = [...new Set(r.providers.flatMap((p) => p.authorities))].filter((a) => AUTH_RE.test(a)).slice(0, 12);
    const open = [];
    for (const a of auths) {
      const res = await sh(`content query --uri ${shQuote(`content://${a}/`)} 2>&1 | head -3`).catch(() => "");
      if (/^Row:/m.test(res)) open.push(`content://${a}/ — ${res.split("\n").filter((l) => l.startsWith("Row:")).length}+ row(s), e.g. ${maskRow(res.split("\n").find((l) => l.startsWith("Row:")) || "")}`);
    }
    if (open.length)
      add({ sev: "high", title: "A content provider returned data to an outside caller", what: "A query from the adb shell (which has no special rights to this app) got rows back, so other apps can read them too.", fix: "Set android:exported=\"false\" on the provider, or require a signature permission.", evidence: open });

    // 2. Private files (only possible for debuggable builds, which is what run-as allows).
    const ra = (cmd) => sh(`run-as ${q} sh -c ${shQuote(cmd)} 2>&1`);
    const probe = await ra("echo ok").catch((e) => e.message);
    if (/^ok/m.test(probe)) {
      const ls = await ra("for d in shared_prefs databases files no_backup app_flutter; do [ -d $d ] && ls -la $d | sed \"s|^|$d |\"; done").catch(() => "");
      const world = [], dbs = [];
      for (const line of ls.split("\n")) {
        const m = line.match(/^(\S+) ([-dlrwxsStT]{10})\s+\S+\s+\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/);
        if (!m) continue;
        const [, dir, mode, name] = m;
        if (name === "." || name === "..") continue;
        if (mode[7] === "r" || mode[8] === "w") world.push(`${dir}/${name} (${mode})`);
        if (dir === "databases" && /\.(db|sqlite3?)$/i.test(name)) dbs.push(`${dir}/${name}`);
      }
      if (world.length)
        add({ sev: "high", title: "Private files readable or writable by other apps", what: "These files in the app's data folder have \"others\" permissions.", fix: "Create files with Context.MODE_PRIVATE and don't chmod them.", evidence: world.slice(0, 30) });
      const prefs = await ra("for f in shared_prefs/*.xml; do [ -f \"$f\" ] && { echo \"==> $f\"; head -c 200000 \"$f\"; echo; }; done").catch(() => "");
      const hits = [];
      let file = "";
      for (const line of prefs.split("\n")) {
        const fm = line.match(/^==> shared_prefs\/(.+)$/);
        if (fm) { file = fm[1]; continue; }
        for (const m of line.matchAll(/<(string|int|long)\s+name="([^"]+)"(?:\s+value="([^"]*)")?\s*>?([^<]*)/g)) {
          const key = m[2], value = (m[3] ?? m[4] ?? "").trim();
          // EncryptedSharedPreferences keeps its own (encrypted) keysets: not a finding.
          if (!key.startsWith("__androidx_security_crypto") && PREF_KEY.test(key) && value.length >= 4 && !/^(true|false|null|0|-1)$/i.test(value)) hits.push(`${file} › ${key} = ${mask(decodeXml(value))}`);
        }
      }
      if (hits.length)
        add({ sev: "medium", title: "Tokens or passwords in SharedPreferences", what: "These look like credentials stored as plain text. Anyone with a backup, root, or a debuggable build can read them.", fix: "Store secrets with the Android Keystore (e.g. EncryptedSharedPreferences / DataStore + Tink), and keep only short-lived tokens.", evidence: hits.slice(0, 30) });
      if (dbs.length)
        add({ sev: "info", title: `${dbs.length} database${dbs.length > 1 ? "s" : ""} in private storage`, what: "SQLite files are stored unencrypted unless you use SQLCipher or similar.", fix: "Don't keep secrets in them, or encrypt the database.", evidence: dbs.slice(0, 20) });
    } else {
      add({ sev: "info", title: "Private files not checked", what: r.debuggable ? `run-as didn't work: ${String(probe).trim().split("\n")[0]}` : "The app isn't debuggable, so its private files can't be opened from the computer. That's right for a release build.", fix: "To check private storage, scan a debug build of the app." });
    }

    // 3. Shared app folder (Android/data/<pkg>): readable over USB and in some backups.
    const ext = await sh(`ls -laR ${shQuote(`/sdcard/Android/data/${pkg}`)} 2>/dev/null | head -400`).catch(() => "");
    const extFiles = [];
    let dir = "";
    for (const line of ext.split("\n")) {
      if (line.endsWith(":")) { dir = line.slice(0, -1).replace(`/sdcard/Android/data/${pkg}`, "").replace(/^\//, ""); continue; }
      const m = line.match(/^-\S{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/);
      if (m && RISKY_FILE.test(m[2])) extFiles.push(`${dir ? dir + "/" : ""}${m[2]} (${ctx.fmtSize(m[1])})`);
    }
    if (extFiles.length)
      add({ sev: "low", title: "Data files in the shared app folder", what: `Android/data/${pkg} can be read over USB and by file managers on older Android versions.`, fix: "Keep anything private in internal storage (getFilesDir()).", evidence: extFiles.slice(0, 30) });

    // 4. Secrets in the app's log, and 5. WebView debugging: both need the app running.
    // The main process plus any ":remote"-style processes of the app.
    const pids = (await sh(`pidof ${q}; ps -A -o PID,NAME 2>/dev/null | grep -F ${shQuote(pkg + ":")} | awk '{print $1}'`).catch(() => ""))
      .split(/\s+/).filter((x) => /^\d+$/.test(x));
    const uniq = [...new Set(pids)];
    if (!uniq.length) {
      add({ sev: "info", title: "Log and WebView not checked", what: "The app isn't running, so its log and WebViews couldn't be looked at.", fix: "Open the app, use it for a moment (log in, browse), then scan again." });
      return out;
    }
    const logs = (await Promise.all(uniq.slice(0, 6).map((p) => sh(`logcat -d -v brief --pid=${p} 2>/dev/null | tail -5000`).catch(() => "")))).join("\n");
    const logHits = new Map();
    for (const line of logs.split("\n")) {
      for (const rule of LOG_RULES) {
        const m = rule.re.exec(line);
        if (!m) continue;
        const v = m[1];
        if (rule.what === "Email address" && /@(?:[0-9]+x|2x|3x)\./.test(v)) continue;
        const shown = scrub(line).replace(/^\S\/([^(]+)\(\s*\d+\):\s*/, "$1: ").slice(0, 200);
        let set = logHits.get(rule); if (!set) logHits.set(rule, (set = new Set()));
        if (set.size < 8) set.add(shown);
      }
    }
    for (const [rule, set] of logHits)
      add({ sev: rule.sev, title: `${rule.what} written to the log`, what: "Other apps can't read the log on Android 4.1+, but it ends up in bug reports, crash tools and anything with adb access.", fix: "Remove the log line, or only log in debug builds (e.g. Timber with a release tree that drops sensitive tags).", evidence: [...set] });
    const unix = await sh("cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[0-9]*' | sort -u").catch(() => "");
    const dbgPids = unix.split("\n").map((l) => l.replace("webview_devtools_remote_", "").trim()).filter((p) => uniq.includes(p));
    if (dbgPids.length)
      add({ sev: r.debuggable ? "info" : "medium", title: "WebView debugging is on", what: "Chrome on a computer (chrome://inspect) can inspect and run code in the app's WebViews right now.", fix: "Only call WebView.setWebContentsDebuggingEnabled(true) in debug builds.", evidence: dbgPids.map((p) => `process ${p}`) });
    return out;
  }
  // Masks every secret-looking value in a log line, whichever rule found the line.
  const scrub = (line) => {
    for (const r of LOG_RULES) line = line.replace(new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"), (m0, v) => m0.replace(v, mask(v)));
    return line;
  };
  const maskRow = (row) => row.replace(/=([^,]{4,})/g, (_, v) => "=" + mask(v.trim())).slice(0, 160);
  const decodeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  // ---------- report ----------
  function renderResults() {
    const r = result;
    results.hidden = false;
    const i = r.info;
    const chips = el("div", { className: "sec-chips" });
    const all = el("button", { type: "button", className: "sec-chip" + (filter === "all" ? " on" : ""), textContent: `All ${r.findings.length}` });
    all.onclick = () => { filter = "all"; renderResults(); };
    chips.append(all);
    for (const s of SEVERITIES) {
      const b = el("button", { type: "button", className: `sec-chip sev-${s}` + (filter === s ? " on" : "") }, el("b", { textContent: String(r.counts[s] || 0) }), ` ${SEV_LABEL[s]}`);
      b.onclick = () => { filter = filter === s ? "all" : s; renderResults(); };
      chips.append(b);
    }
    const htmlBtn = el("button", { className: "btn sm", type: "button", textContent: "Save HTML report" });
    htmlBtn.onclick = () => ctx.download(new Blob([reportHtml(r)], { type: "text/html" }), `security-${safe(i.package || "app")}-${stamp(r.date)}.html`);
    const jsonBtn = el("button", { className: "btn sm", type: "button", textContent: "Save JSON" });
    jsonBtn.onclick = () => ctx.download(new Blob([JSON.stringify(reportJson(r), null, 2)], { type: "application/json" }), `security-${safe(i.package || "app")}-${stamp(r.date)}.json`);

    const kv = el("div", { className: "dev-kv sec-kv" });
    const row = (k, v) => kv.append(el("span", { textContent: k }), el("span", { textContent: v }));
    row("App", `${i.label || "?"} (${i.package || "?"})`);
    row("Version", `${i.versionName || "?"} (${i.versionCode})`);
    row("SDK", `target ${i.targetSdk}, min ${i.minSdk}`);
    row("Signature", i.signing);
    row("Built with", i.framework + (i.abis?.length ? ` · native ${i.abis.join(", ")}` : ""));
    row("Scanned", `${ctx.fmtSize(i.size)} in ${i.parts} file${i.parts > 1 ? "s" : ""} · ${r.stats.strings.toLocaleString()} code strings · ${r.stats.components} components (${r.stats.exported} exported)${r.phoneChecked ? " · checked on the phone" : ""}`);

    const list = el("div", { className: "sec-list" });
    const shown = r.findings.filter((f) => filter === "all" || f.sev === filter);
    if (!shown.length) list.append(el("div", { className: "empty", textContent: filter === "all" ? "Nothing found." : `No ${SEV_LABEL[filter].toLowerCase()} findings.` }));
    for (const f of shown) {
      const body = el("div", { className: "sec-body" },
        el("p", { textContent: f.what }),
        f.fix ? el("p", { className: "sec-fix" }, el("b", { textContent: "Fix: " }), f.fix) : "");
      if (f.evidence?.length) {
        const ev = el("ul", { className: "sec-ev" });
        for (const e of f.evidence.slice(0, 40)) ev.append(el("li", { textContent: e }));
        if (f.evidence.length > 40) ev.append(el("li", { className: "muted", textContent: `…and ${f.evidence.length - 40} more` }));
        body.append(ev);
      }
      const d = el("details", { className: `sec-item sev-${f.sev}` },
        el("summary", {}, el("span", { className: `sec-sev sev-${f.sev}`, textContent: SEV_LABEL[f.sev] }),
          el("span", { className: "sec-title", textContent: f.title }), el("span", { className: "sec-cat", textContent: f.cat })),
        body);
      if (f.sev === "high") d.open = true;
      list.append(d);
    }
    results.replaceChildren(
      el("div", { className: "dev-head" }, el("h2", { textContent: "Findings" }), el("div", {}, htmlBtn, jsonBtn)),
      kv, chips, list,
      el("p", { className: "dev-note", textContent: "Code findings can come from libraries the app includes. Secrets are shown masked; the full values are never stored or saved in reports." }));
  }

  const safe = (s) => String(s).replace(/[^\w.-]+/g, "_");
  const stamp = (t) => new Date(t).toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function reportJson(r) {
    return { tool: "Droid Desk security scan", date: new Date(r.date).toISOString(), source: r.source, checkedOnPhone: !!r.phoneChecked,
      app: r.info, counts: r.counts, findings: r.findings.map(({ id, sev, cat, title, what, fix, evidence }) => ({ id, severity: sev, category: cat, title, what, fix, evidence })) };
  }
  function reportHtml(r) {
    const i = r.info;
    const colors = { high: "#d9443f", medium: "#c77700", low: "#6b5200", info: "#5a5a66" };
    const items = r.findings.map((f) => `<section class="f"><h3><span class="s" style="background:${colors[f.sev]}">${SEV_LABEL[f.sev]}</span> ${esc(f.title)} <small>${esc(f.cat)}</small></h3>
<p>${esc(f.what)}</p>${f.fix ? `<p><b>Fix:</b> ${esc(f.fix)}</p>` : ""}${f.evidence?.length ? `<ul>${f.evidence.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>` : ""}</section>`).join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Security scan · ${esc(i.package)}</title><style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#1b1b1f;background:#fff}
h1{font-weight:400;margin:0 0 4px}h3{font-size:15px;margin:0 0 6px;font-weight:600}small{color:#6e6e78;font-weight:400;margin-left:6px}
.s{color:#fff;border-radius:999px;padding:1px 9px;font-size:12px;margin-right:6px}.f{border:1px solid #e6e6ec;border-radius:14px;padding:12px 16px;margin:10px 0}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;color:#444;margin:12px 0}code{font-size:12px;word-break:break-all}
.c span{display:inline-block;margin-right:12px}@media(prefers-color-scheme:dark){body{background:#121216;color:#f1f1f5}.f{border-color:#2c2c34}.kv{color:#bbb}}
</style></head><body><h1>Security scan</h1><div class="kv">
<span>App</span><span>${esc(i.label)} (${esc(i.package)})</span><span>Version</span><span>${esc(i.versionName)} (${esc(i.versionCode)})</span>
<span>SDK</span><span>target ${esc(i.targetSdk)}, min ${esc(i.minSdk)}</span><span>Signature</span><span>${esc(i.signing)}</span>
<span>Built with</span><span>${esc(i.framework)}</span><span>Scanned</span><span>${esc(new Date(r.date).toLocaleString())}${r.phoneChecked ? " · checked on the phone" : ""}</span></div>
<p class="c">${SEVERITIES.map((s) => `<span><b style="color:${colors[s]}">${r.counts[s]}</b> ${SEV_LABEL[s]}</span>`).join("")}</p>
${items || "<p>Nothing found.</p>"}
<p><small>Made with Droid Desk. Code findings can come from libraries. Secrets are masked.</small></p></body></html>`;
  }

  return {
    show: () => renderLast(),
    disconnected: () => { if (running && source === "phone") progress.hidden = true; },
  };
}
