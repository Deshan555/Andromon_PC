// Developer tab › App tools: everything about one app — info and start/stop, permissions, saving its
// APK, opening links/intents in it, and browsing its own storage (private via run-as for debuggable
// apps, or its shared folder under Android/data).
//
// Every string from the phone is untrusted: inserted only with textContent / el(). Everything the user
// or the phone gives us goes into shell commands through shQuote, and package names are validated.

import { LinuxFileType } from "@yume-chan/adb";
import { fileIcon } from "../fileicons.js";
import { zipSync } from "fflate";

const PKG_RE = /^[A-Za-z0-9_.]+$/;
const COMP_RE = /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/;
const TEXT_MAX = 256 * 1024;
const CHUNK = 36 * 1024; // raw bytes per upload command (≈48 KB of base64)
const HISTORY_MAX = 20;
const COMMON_ACTIONS = [
  "android.intent.action.VIEW", "android.intent.action.MAIN", "android.intent.action.SEND", "android.intent.action.SENDTO",
  "android.intent.action.DIAL", "android.intent.action.EDIT", "android.intent.action.PICK", "android.intent.action.BOOT_COMPLETED",
  "android.intent.action.MY_PACKAGE_REPLACED", "android.intent.action.LOCALE_CHANGED", "android.settings.APPLICATION_DETAILS_SETTINGS",
];
const EXTRA_TYPES = [["string", "--es", "Text"], ["int", "--ei", "Integer"], ["long", "--el", "Long"], ["float", "--ef", "Decimal"], ["bool", "--ez", "true/false"], ["uri", "--eu", "Uri"]];
// Permissions that are switched with app-ops (special access), not pm grant.
const SPECIAL_OPS = [
  ["android.permission.SYSTEM_ALERT_WINDOW", "SYSTEM_ALERT_WINDOW", "Display over other apps"],
  ["android.permission.MANAGE_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE", "All files access"],
  ["android.permission.REQUEST_INSTALL_PACKAGES", "REQUEST_INSTALL_PACKAGES", "Install unknown apps"],
  ["android.permission.WRITE_SETTINGS", "WRITE_SETTINGS", "Modify system settings"],
  ["android.permission.PACKAGE_USAGE_STATS", "GET_USAGE_STATS", "Usage access"],
  ["android.permission.SCHEDULE_EXACT_ALARM", "SCHEDULE_EXACT_ALARM", "Alarms & reminders"],
];
const TEXT_EXT = /\.(xml|json|txt|log|csv|ini|conf|cfg|properties|prefs|html?|js|md|yaml|yml)$/i;

const shortPerm = (p) => p.replace(/^android\.permission\./, "");
// The useful sentence out of a shell error (Java stack traces included).
const errText = (s) => {
  const lines = String(s).trim().split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of lines) { const m = l.match(/^[\w.$]*(?:Exception|Error):\s*(.+)$/); if (m) return m[1]; }
  return lines.find((l) => /error|denied|failed|not /i.test(l)) || lines[0] || "";
};

/** Parses the `Package [pkg]` block of `dumpsys package <pkg>`. Returns null if the app isn't there. */
export function parsePackageDump(out, pkg) {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`  Package [${pkg}]`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end++;
  const block = lines.slice(start, end);
  const text = block.join("\n");
  const get = (re) => (text.match(re) || [])[1] || "";
  const info = {
    versionName: get(/versionName=(.*)/).trim(), versionCode: get(/versionCode=(\d+)/),
    minSdk: get(/minSdk=(\d+)/), targetSdk: get(/targetSdk=(\d+)/), uid: get(/userId=(\d+)/),
    dataDir: get(/dataDir=(.*)/).trim(), firstInstall: get(/firstInstallTime=(.*)/).trim(), lastUpdate: get(/lastUpdateTime=(.*)/).trim(),
    debuggable: /flags=\[[^\]]*\bDEBUGGABLE\b/.test(text), system: /flags=\[[^\]]*\bSYSTEM\b/.test(text),
    requested: [], install: [], runtime: [],
  };
  // Indented sections: "requested permissions:", "install permissions:", and "runtime permissions:" under "User 0:".
  let section = null, indent = 0, user = null;
  for (const l of block) {
    const ind = l.length - l.trimStart().length, t = l.trim();
    const um = t.match(/^User (\d+):/);
    if (um) { user = Number(um[1]); section = null; continue; }
    if (/^requested permissions:$/.test(t)) { section = "requested"; indent = ind; continue; }
    if (/^install permissions:$/.test(t)) { section = "install"; indent = ind; continue; }
    if (/^runtime permissions:$/.test(t)) { section = user == null || user === 0 ? "runtime" : null; indent = ind; continue; }
    if (!section) continue;
    if (ind <= indent || !t) { section = null; continue; }
    if (section === "requested") { const name = t.split(/[\s:,]/)[0]; if (name) info.requested.push(name); continue; }
    const m = t.match(/^([A-Za-z0-9_.]+): granted=(true|false)(?:, flags=\[\s*(.*?)\])?/);
    if (m) info[section].push({ name: m[1], granted: m[2] === "true", flags: (m[3] || "").trim() });
  }
  return info;
}

/** `ls -la` lines (toybox) -> entries. */
export function parseLs(out) {
  const res = [];
  for (const l of out.split("\n")) {
    const m = l.match(/^([dlcbps-])[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d)\s(.*)$/);
    if (!m) continue;
    let name = m[4];
    if (m[1] === "l") name = name.replace(/ -> .*$/, "");
    if (name === "." || name === "..") continue;
    res.push({ name, dir: m[1] === "d", link: m[1] === "l", size: Number(m[2]), when: m[3] });
  }
  return res;
}

export function mount(root, ctx) {
  const { el, sh, shBytes, shQuote, withSync, download, armedClick, busy, makeSwitch, fmtSize, toast, showError, clearError, readAll, store, app } = ctx;
  const btn = (text, onclick, cls = "btn sm") => { const b = el("button", { type: "button", className: cls, textContent: text }); if (onclick) b.onclick = onclick; return b; };
  const validPkg = () => { const p = app.get(); return PKG_RE.test(p) ? p : ""; };
  const guard = (fn) => async (...a) => { try { clearError(); await fn(...a); } catch (e) { showError(e); } };
  let info = null;   // parsed dumpsys for the selected app
  let dirty = true;  // selection changed while hidden

  root.append(el("div", { className: "card apt-top" }, app.picker({ label: "App" })));

  // ======================= 1. App info =======================
  const infoBody = el("div", {});
  const runState = el("span", { className: "chip" });
  const launchB = btn("Launch", guard(() => launch()), "btn sm primary");
  const restartB = btn("Restart", guard(async () => { const p = need(); await sh(`am force-stop --user 0 ${shQuote(p)}`); await launch(); }));
  const stopB = btn("Force stop", guard(async () => { const p = need(); await sh(`am force-stop --user 0 ${shQuote(p)}`); toast("Stopped"); refreshRun(); }));
  const clearB = btn("Clear data & restart", null, "btn sm danger");
  armedClick(clearB, guard(async () => {
    const p = need();
    const out = await sh(`pm clear --user 0 ${shQuote(p)}`);
    if (!/success/i.test(out)) throw new Error(`Couldn't clear data: ${errText(out) || "no answer"}`);
    toast("Data cleared"); await launch();
  }));
  const settingsB = btn("App settings on phone", guard(async () => {
    const p = need();
    await sh(`am start --user 0 -a android.settings.APPLICATION_DETAILS_SETTINGS -d ${shQuote("package:" + p)}`);
    toast("Opened on the phone");
  }));
  const actions = el("div", { className: "dev-row apt-actions" }, launchB, restartB, stopB, clearB, settingsB);
  root.append(ctx.card("App info", runState, infoBody, actions));

  function need() { const p = validPkg(); if (!p) throw new Error("Pick an app first (a package name like com.example.app)."); return p; }

  async function launch() {
    const p = need();
    const out = await sh(`cmd package resolve-activity --user 0 --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${shQuote(p)}`);
    const comp = out.trim().split("\n").pop().trim();
    let res;
    if (COMP_RE.test(comp)) res = await sh(`am start --user 0 -n ${shQuote(comp)}`);
    else res = await sh(`monkey -p ${shQuote(p)} -c android.intent.category.LAUNCHER 1`);
    if (/Error|No activities found|aborted/i.test(res)) throw new Error(`Couldn't start the app: ${errText(res) || "it has no launcher screen"}`);
    toast("Launched"); setTimeout(refreshRun, 800);
  }

  async function refreshRun() {
    const p = validPkg();
    if (!p) { runState.textContent = ""; return; }
    const pid = (await sh(`pidof ${shQuote(p)}`).catch(() => "")).trim();
    runState.textContent = pid ? `Running · pid ${pid}` : "Not running";
    runState.classList.toggle("apt-on", !!pid);
  }

  async function loadInfo() {
    const p = validPkg();
    info = null;
    if (!p) { infoBody.replaceChildren(el("div", { className: "empty", textContent: "Pick an app above, or click “Current app”." })); return; }
    infoBody.replaceChildren(ctx.spinner(), " Reading app details…");
    const [dump, paths, inst] = await Promise.all([
      sh(`dumpsys package ${shQuote(p)}`), sh(`pm path --user 0 ${shQuote(p)}`).catch(() => ""),
      sh(`pm list packages --user 0 -i ${shQuote(p)}`).catch(() => ""),
    ]);
    info = parsePackageDump(dump, p);
    if (!info) { infoBody.replaceChildren(el("div", { className: "empty", textContent: `${p} isn't installed on this phone.` })); return; }
    info.pkg = p;
    info.apks = paths.split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean);
    const im = inst.split("\n").map((l) => l.match(new RegExp(`^package:${p.replace(/\./g, "\\.")}\\s+installer=(\\S+)`))).find(Boolean);
    info.installer = im && im[1] !== "null" ? im[1] : "";
    const kv = el("div", { className: "dev-kv" });
    const row = (k, v) => kv.append(el("div", { textContent: k }), el("div", { textContent: v || "—" }));
    row("Version", info.versionName ? `${info.versionName} (${info.versionCode})` : info.versionCode);
    row("Target / min SDK", `${info.targetSdk || "?"} / ${info.minSdk || "?"}`);
    row("Debuggable", info.debuggable ? "Yes — private files can be opened below" : "No");
    row("Type", info.system ? "System app" : "Installed app");
    row("Installed from", info.installer || "Unknown (sideloaded or adb)");
    row("First installed", info.firstInstall);
    row("Last updated", info.lastUpdate);
    row("User id (uid)", info.uid);
    row("Data folder", info.dataDir);
    row("APK files", info.apks.length > 1 ? `${info.apks.length} (base + ${info.apks.length - 1} splits)` : String(info.apks.length));
    infoBody.replaceChildren(kv);
  }

  // ======================= 2. Permissions =======================
  const permBody = el("div", {});
  const grantAllB = btn("Grant all", null), revokeAllB = btn("Revoke all", null);
  grantAllB.onclick = guard(() => setAll(true, grantAllB));
  revokeAllB.onclick = guard(() => setAll(false, revokeAllB));
  root.append(ctx.card("Permissions", el("div", {}, grantAllB, revokeAllB), permBody));

  async function readPerms() {
    const p = need();
    return parsePackageDump(await sh(`dumpsys package ${shQuote(p)}`), p);
  }
  async function setPerm(name, on) {
    const p = need();
    const out = await sh(`pm ${on ? "grant" : "revoke"} --user 0 ${shQuote(p)} ${shQuote(name)}`);
    if (out.trim()) throw new Error(`${shortPerm(name)}: ${errText(out)}`);
  }
  async function setAll(on, b) {
    if (!info) return;
    busy(b, true, on ? "Granting…" : "Revoking…");
    const failed = [];
    try {
      for (const r of info.runtime) if (r.granted !== on) { try { await setPerm(r.name, on); } catch { failed.push(shortPerm(r.name)); } }
    } finally { busy(b, false); }
    if (failed.length) showError(`Some permissions can't be ${on ? "granted" : "revoked"} this way: ${failed.join(", ")}`);
    else toast(on ? "All granted" : "All revoked");
    await renderPerms(true);
  }

  async function renderPerms(reread = false) {
    if (reread && validPkg()) { const fresh = await readPerms(); if (fresh) Object.assign(info || (info = {}), { runtime: fresh.runtime, install: fresh.install, requested: fresh.requested }); }
    permBody.replaceChildren();
    grantAllB.disabled = revokeAllB.disabled = !info?.runtime?.length;
    if (!info) { permBody.append(el("div", { className: "muted", textContent: "No app selected." })); return; }
    // Runtime permissions: one switch each.
    if (info.runtime.length) {
      const grid = el("div", { className: "ctl-grid" });
      for (const r of [...info.runtime].sort((a, b) => a.name.localeCompare(b.name))) {
        const sw = makeSwitch(r.granted, async (want) => {
          await setPerm(r.name, want);
          const fresh = await readPerms();
          const now = fresh?.runtime.find((x) => x.name === r.name);
          if (now) { r.granted = now.granted; if (now.granted !== want) showError(`${shortPerm(r.name)} didn't change (it may be fixed by policy).`); }
          return now ? now.granted : want;
        });
        const flags = r.flags.split("|").map((f) => f.trim()).filter((f) => /USER_SET|USER_FIXED|POLICY_FIXED|SYSTEM_FIXED|GRANTED_BY_DEFAULT|REVOKE_WHEN_REQUESTED/.test(f));
        grid.append(el("div", { className: "ctl" },
          el("div", {}, el("div", { className: "mono", textContent: shortPerm(r.name) }), flags.length ? el("div", { className: "sub", textContent: flags.join(" · ").toLowerCase().replace(/_/g, " ") }) : ""),
          sw));
      }
      permBody.append(grid);
    } else permBody.append(el("div", { className: "muted", textContent: "This app asks for no runtime permissions." }));

    // Special access (app-ops).
    const special = SPECIAL_OPS.filter(([perm]) => info.requested.includes(perm));
    if (special.length) {
      const grid = el("div", { className: "ctl-grid apt-gap" });
      permBody.append(el("h3", { className: "apt-h3", textContent: "Special access" }), grid);
      for (const [, op, label] of special) {
        const sw = makeSwitch(false, async (want) => {
          const p = need();
          const out = await sh(`appops set --user 0 ${shQuote(p)} ${op} ${want ? "allow" : "default"}`);
          if (out.trim()) throw new Error(`${label}: ${errText(out)}`);
          return readOp(op);
        });
        sw.disabled = true;
        grid.append(el("div", { className: "ctl" }, el("div", {}, el("div", { textContent: label }), el("div", { className: "sub mono", textContent: op })), sw));
        readOp(op).then((v) => { sw.set(v); sw.disabled = false; }).catch(() => {});
      }
    }

    // Install-time permissions, read-only.
    if (info.install.length) {
      const det = el("details", { className: "apt-det" }, el("summary", { textContent: `Granted at install (${info.install.length}) — can't be changed` }));
      const ul = el("ul", { className: "apt-list" });
      for (const r of [...info.install].sort((a, b) => a.name.localeCompare(b.name)))
        ul.append(el("li", { className: "mono", textContent: `${shortPerm(r.name)}${r.granted ? "" : "  (not granted)"}` }));
      det.append(ul); permBody.append(det);
    }
  }
  async function readOp(op) {
    const p = need();
    const out = await sh(`appops get --user 0 ${shQuote(p)} ${op}`);
    const m = out.match(new RegExp(`^${op}: (\\w+)`, "m"));
    return !!m && m[1] === "allow";
  }

  // ======================= 3. Save APK =======================
  const apkNote = el("div", { className: "dev-note" });
  const saveB = btn("Save APK to this computer", null, "btn sm primary");
  saveB.onclick = guard(() => saveApk());
  root.append(ctx.card("Save APK", null, el("div", { className: "dev-row" }, saveB), apkNote));

  async function saveApk() {
    const p = need();
    if (!info?.apks?.length) throw new Error("No APK found for this app.");
    const ver = (info.versionName || info.versionCode || "app").replace(/[^\w.-]+/g, "_");
    busy(saveB, true, "Reading…");
    try {
      const files = await withSync(async (s) => {
        let total = 0;
        for (const a of info.apks) { try { total += Number((await s.stat(a)).size); } catch {} }
        const out = []; let got = 0;
        for (const a of info.apks) {
          const reader = s.read(a).getReader(), parts = [];
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            parts.push(value.slice()); got += value.length;
            saveB.lastChild.textContent = total ? `Copying… ${Math.round(got / total * 100)}%` : `Copying… ${fmtSize(got)}`;
          }
          out.push({ name: a.split("/").pop(), blob: new Blob(parts) });
        }
        return out;
      });
      if (files.length === 1) {
        download(files[0].blob, `${p}-${ver}.apk`);
        apkNote.textContent = `Saved ${p}-${ver}.apk (${fmtSize(files[0].blob.size)}).`;
      } else {
        saveB.lastChild.textContent = "Packing…";
        const entries = {};
        for (const f of files) entries[f.name] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }];
        const zip = new Blob([zipSync(entries)]);
        download(zip, `${p}-${ver}.apks`);
        apkNote.textContent = `This app is split into ${files.length} APKs, so they were saved together as ${p}-${ver}.apks (${fmtSize(zip.size)}). Install it with Droid Desk's Apps tab or “adb install-multiple”.`;
      }
    } finally { busy(saveB, false); }
  }

  // ======================= 4. Links & intents =======================
  let mode = "activity";
  const modeSeg = el("div", { className: "seg" });
  for (const [id, label] of [["activity", "Activity"], ["broadcast", "Broadcast"], ["service", "Service"]]) {
    const b = el("button", { type: "button", textContent: label, className: id === mode ? "on" : "" });
    b.onclick = () => { mode = id; for (const x of modeSeg.children) x.classList.toggle("on", x === b); };
    b.dataset.mode = id; modeSeg.append(b);
  }
  const fData = el("input", { type: "text", className: "mono", placeholder: "Link or data, e.g. myapp://orders/42 or https://…", spellcheck: false });
  const actList = el("datalist", { id: "aptActions" });
  for (const a of COMMON_ACTIONS) actList.append(el("option", { value: a }));
  const fAction = el("input", { type: "text", className: "mono", value: "android.intent.action.VIEW", spellcheck: false });
  fAction.setAttribute("list", "aptActions");
  const fOnly = el("input", { type: "checkbox", checked: true });
  const fComp = el("input", { type: "text", className: "mono", placeholder: "Component (optional), e.g. com.example/.MainActivity", spellcheck: false });
  const fCat = el("input", { type: "text", className: "mono", placeholder: "Category (optional)", spellcheck: false });
  const extrasBox = el("div", { className: "apt-extras" });
  const addExtra = (x = { k: "", t: "string", v: "" }) => {
    const k = el("input", { type: "text", className: "mono", placeholder: "key", value: x.k, spellcheck: false });
    const t = el("select", {}); for (const [id, , label] of EXTRA_TYPES) t.append(el("option", { value: id, textContent: label }));
    t.value = x.t;
    const v = el("input", { type: "text", className: "mono", placeholder: "value", value: x.v, spellcheck: false });
    const rm = btn("✕", null, "btn sm"); rm.title = "Remove";
    const rowEl = el("div", { className: "apt-extra" }, k, t, v, rm);
    rm.onclick = () => rowEl.remove();
    rowEl.read = () => ({ k: k.value.trim(), t: t.value, v: v.value });
    extrasBox.append(rowEl);
  };
  const sendB = btn("Send", null, "btn sm primary");
  const intentOut = el("pre", { className: "out apt-out", hidden: true });
  const histBox = el("div", { className: "apt-hist" });
  const onlyLbl = el("label", { className: "apt-check" }, fOnly, el("span", { textContent: "Only in the selected app" }));
  root.append(ctx.card("Open a link or intent", modeSeg,
    el("div", { className: "apt-form" },
      fData,
      el("div", { className: "apt-two" }, fAction, actList, fCat),
      fComp,
      el("div", { className: "dev-row" }, onlyLbl),
      el("div", { className: "dev-lbl", textContent: "Extras" }), extrasBox,
      el("div", { className: "dev-row" }, btn("+ Add extra", () => addExtra()), sendB)),
    intentOut, histBox));

  const readForm = () => ({
    mode, data: fData.value.trim(), action: fAction.value.trim(), cat: fCat.value.trim(), comp: fComp.value.trim(), only: fOnly.checked,
    extras: [...extrasBox.children].map((r) => r.read()).filter((x) => x.k),
  });
  function fillForm(f) {
    mode = f.mode || "activity";
    for (const x of modeSeg.children) x.classList.toggle("on", x.dataset.mode === mode);
    fData.value = f.data || ""; fAction.value = f.action || ""; fCat.value = f.cat || ""; fComp.value = f.comp || ""; fOnly.checked = !!f.only;
    extrasBox.replaceChildren(); for (const x of f.extras || []) addExtra(x);
  }
  function buildIntent(f) {
    const parts = [];
    if (f.action) parts.push("-a", shQuote(f.action));
    if (f.data) parts.push("-d", shQuote(f.data));
    if (f.cat) parts.push("-c", shQuote(f.cat));
    if (f.comp) { if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(f.comp)) throw new Error("Component should look like com.example/.MainActivity"); parts.push("-n", shQuote(f.comp)); }
    else if (f.only) parts.push("-p", shQuote(need()));
    for (const x of f.extras) {
      const [, flag] = EXTRA_TYPES.find(([id]) => id === x.t) || EXTRA_TYPES[0];
      if ((x.t === "int" || x.t === "long") && !/^-?\d+$/.test(x.v.trim())) throw new Error(`Extra “${x.k}” needs a whole number.`);
      if (x.t === "float" && !isFinite(Number(x.v)) ) throw new Error(`Extra “${x.k}” needs a number.`);
      if (x.t === "bool" && !/^(true|false)$/i.test(x.v.trim())) throw new Error(`Extra “${x.k}” must be true or false.`);
      parts.push(flag, shQuote(x.k), shQuote(x.t === "string" || x.t === "uri" ? x.v : x.v.trim().toLowerCase()));
    }
    if (!f.action && !f.data && !f.comp) throw new Error("Enter a link, an action or a component.");
    const verb = f.mode === "broadcast" ? "broadcast" : f.mode === "service" ? "start-foreground-service" : "start -W";
    return `am ${verb} --user 0 ${parts.join(" ")}`;
  }
  sendB.onclick = guard(async () => {
    const f = readForm();
    const cmd = buildIntent(f);
    busy(sendB, true, "Sending…");
    try {
      const out = await sh(cmd);
      intentOut.hidden = false;
      intentOut.textContent = `$ ${cmd}\n${out.trim() || "(no output)"}`;
      if (/Error|Exception|unable to resolve/i.test(out)) showError(`The phone said: ${errText(out)}`);
      else toast("Sent");
      remember(f);
    } finally { busy(sendB, false); }
  });
  function remember(f) {
    const key = JSON.stringify({ ...f, extras: f.extras });
    const list = store.get("intents", []).filter((x) => JSON.stringify(x) !== key);
    list.unshift(f); store.set("intents", list.slice(0, HISTORY_MAX));
    renderHistory();
  }
  function renderHistory() {
    const list = store.get("intents", []);
    histBox.replaceChildren();
    if (!list.length) return;
    histBox.append(el("div", { className: "dev-lbl", textContent: "Recent" }));
    list.forEach((f, i) => {
      const label = (f.mode !== "activity" ? `[${f.mode}] ` : "") + (f.data || f.comp || f.action || "?") + (f.extras?.length ? `  +${f.extras.length} extra${f.extras.length > 1 ? "s" : ""}` : "");
      const use = el("button", { type: "button", className: "apt-histbtn mono", textContent: label, title: "Fill the form with this" });
      use.onclick = () => fillForm(f);
      const del = btn("✕", () => { const l = store.get("intents", []); l.splice(i, 1); store.set("intents", l); renderHistory(); });
      del.title = "Remove from history";
      histBox.append(el("div", { className: "apt-histrow" }, use, del));
    });
  }
  renderHistory();

  // ======================= 5. App storage =======================
  let root2 = "private"; // "private" (run-as) | "shared" (/sdcard/Android/data/<pkg>)
  let cwd = [];          // path segments below the root
  const rootSeg = el("div", { className: "seg" });
  for (const [id, label] of [["private", "Private (debuggable apps)"], ["shared", "Shared app folder"]]) {
    const b = el("button", { type: "button", textContent: label, className: id === root2 ? "on" : "" });
    b.dataset.root = id;
    b.onclick = guard(async () => { root2 = id; cwd = []; for (const x of rootSeg.children) x.classList.toggle("on", x === b); await loadDir(); });
    rootSeg.append(b);
  }
  const crumbs = el("div", { className: "crumbs apt-crumbs" });
  const jumps = el("div", { className: "dev-row apt-jumps" });
  for (const d of ["shared_prefs", "databases", "files", "cache"]) jumps.append(btn(d, guard(async () => { cwd = [d]; await loadDir(); })));
  const fileInput = el("input", { type: "file", multiple: true, hidden: true });
  const addB = btn("Add files", () => fileInput.click());
  const refreshB = btn("Refresh", guard(() => loadDir()));
  const listBox = el("div", { className: "apt-files" });
  const status = el("div", { className: "dev-note" });
  const viewBox = el("div", { hidden: true });
  const storeCard = ctx.card("App storage", rootSeg,
    el("div", { className: "dev-row" }, crumbs, el("span", { className: "apt-grow" }), addB, refreshB, fileInput),
    jumps, listBox, status, viewBox,
    el("div", { className: "dev-note", textContent: "Drop files here to copy them into the folder shown." }));
  root.append(storeCard);

  const relPath = (name) => [...cwd, ...(name ? [name] : [])].join("/");
  const sharedBase = () => `/sdcard/Android/data/${need()}`;
  const fullShared = (name) => [sharedBase(), ...cwd, ...(name ? [name] : [])].join("/");
  const runAs = (cmd) => `run-as ${shQuote(need())} ${cmd}`;

  function renderCrumbs() {
    crumbs.replaceChildren();
    const rootLabel = root2 === "private" ? "app data" : `Android/data/${validPkg() || "…"}`;
    const segs = [rootLabel, ...cwd];
    segs.forEach((s, i) => {
      if (i) crumbs.append(el("span", { className: "muted", textContent: " / " }));
      const b = el("button", { type: "button", className: "link", textContent: s });
      b.onclick = guard(async () => { cwd = cwd.slice(0, i); await loadDir(); });
      crumbs.append(b);
    });
    jumps.hidden = root2 !== "private" || cwd.length > 0;
  }

  async function listEntries() {
    if (root2 === "private") {
      const target = cwd.length ? relPath() : ".";
      const out = await sh(`${runAs("ls -la")} ${shQuote(target)} 2>&1`);
      if (/not debuggable/i.test(out)) throw Object.assign(new Error("This app isn't debuggable, so its private files can't be opened. Use a debug build, or the “Shared app folder”."), { soft: true });
      if (/unknown package/i.test(out)) throw Object.assign(new Error("This app isn't installed."), { soft: true });
      if (/No such file/i.test(out)) throw Object.assign(new Error("This folder doesn't exist (yet)."), { soft: true });
      if (/run-as:/i.test(out) && !/^total/m.test(out)) throw Object.assign(new Error(errText(out) || out.trim()), { soft: true });
      return parseLs(out);
    }
    const entries = await withSync(async (s) => {
      try { await s.stat(fullShared()); } catch { throw Object.assign(new Error(cwd.length ? "This folder doesn't exist any more." : "This app has no shared folder yet (it's created when the app first stores something there)."), { soft: true }); }
      return s.readdir(fullShared());
    });
    return entries.filter((e) => e.name !== "." && e.name !== "..").map((e) => ({
      name: e.name, dir: e.type === LinuxFileType.Directory, link: e.type === LinuxFileType.Link, size: Number(e.size),
      when: new Date(Number(e.mtime) * 1000).toLocaleString(),
    }));
  }

  async function loadDir() {
    renderCrumbs(); viewBox.hidden = true;
    if (!validPkg()) { listBox.replaceChildren(el("div", { className: "empty", textContent: "Pick an app first." })); return; }
    listBox.replaceChildren(el("div", { className: "empty" }, ctx.spinner(), " Loading…"));
    let entries;
    try { entries = await listEntries(); }
    catch (e) {
      listBox.replaceChildren(el("div", { className: "empty", textContent: e.message })); return;
    }
    entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    if (!entries.length) { listBox.replaceChildren(el("div", { className: "empty", textContent: "This folder is empty." })); return; }
    const tbody = el("tbody", {});
    for (const e of entries) {
      const tile = fileIcon(e.name, e.dir ? "dir" : e.link ? "link" : "file"); tile.classList.add("sm");
      const name = el("button", { type: "button", className: "link", style: "display:inline-flex;align-items:center;gap:8px" }, tile, el("span", { textContent: e.name }));
      name.onclick = guard(async () => { if (e.dir || e.link) { cwd = [...cwd, e.name]; await loadDir(); } else await viewFile(e); });
      const act = el("td", { className: "act" });
      if (!e.dir) {
        if (e.size <= TEXT_MAX) act.append(btn("View", guard(() => viewFile(e))));
        act.append(btn("Download", guard(async () => download(await readFile(e.name), e.name))));
      }
      const rm = btn("Delete", null, "btn sm danger");
      armedClick(rm, guard(async () => {
        const out = root2 === "private" ? await sh(`${runAs("rm -r")} ${shQuote(relPath(e.name))} 2>&1`) : await sh(`rm -r ${shQuote(fullShared(e.name))} 2>&1`);
        if (out.trim()) throw new Error(`Couldn't delete: ${out.trim()}`);
        toast(`Deleted ${e.name}`); await loadDir();
      }));
      act.append(rm);
      tbody.append(el("tr", {}, el("td", {}, name), el("td", { className: "muted", textContent: e.dir ? "" : fmtSize(e.size) }), el("td", { className: "muted", textContent: e.when }), act));
    }
    listBox.replaceChildren(el("table", { className: "apt-table" }, el("thead", {}, el("tr", {}, ...["Name", "Size", "Modified", ""].map((h) => el("th", { textContent: h })))), tbody));
  }

  async function readFile(name) {
    if (root2 === "private") return new Blob([await shBytes(`${runAs("cat")} ${shQuote(relPath(name))}`)]);
    return withSync((s) => readAll(s.read(fullShared(name))));
  }
  async function viewFile(e) {
    if (e.size > TEXT_MAX) { download(await readFile(e.name), e.name); return; }
    const blob = await readFile(e.name);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const binary = !TEXT_EXT.test(e.name) && bytes.subarray(0, 4096).some((b) => b === 0);
    const pre = el("pre", { className: "out apt-view", textContent: binary ? "(This file isn't text. Use Download to open it on this computer.)" : new TextDecoder().decode(bytes) });
    viewBox.replaceChildren(el("div", { className: "dev-row" }, el("b", { textContent: relPath(e.name) }), el("span", { className: "apt-grow" }),
      btn("Download", () => download(blob, e.name)), btn("Close", () => { viewBox.hidden = true; })), pre);
    viewBox.hidden = false;
    viewBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function upload(files) {
    if (!files.length) return;
    need();
    for (const f of files) {
      if (/[\/\0]/.test(f.name)) continue;
      status.textContent = `Copying ${f.name}…`;
      if (root2 === "shared") {
        await withSync((s) => s.write({ filename: fullShared(f.name), file: f.stream(), permission: 0o660, mtime: Math.floor(f.lastModified / 1000) }));
      } else {
        const target = shQuote(relPath(f.name));
        const buf = new Uint8Array(await f.arrayBuffer());
        for (let off = 0, first = true; off < buf.length || first; off += CHUNK, first = false) {
          const part = buf.subarray(off, off + CHUNK);
          let bin = ""; for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
          const b64 = btoa(bin);
          const out = await sh(`echo ${b64 || "''"} | base64 -d | ${runAs("sh -c")} ${shQuote(`cat ${first ? ">" : ">>"} ${target}`)} 2>&1`);
          if (out.trim()) throw new Error(`Couldn't copy ${f.name}: ${errText(out) || out.trim()}`);
          status.textContent = `Copying ${f.name}… ${Math.min(100, Math.round((off + part.length) / Math.max(1, buf.length) * 100))}%`;
        }
      }
    }
    status.textContent = `Copied ${files.length} file${files.length > 1 ? "s" : ""}.`;
    toast("Copied to the phone");
    await loadDir();
  }
  fileInput.onchange = guard(async () => { const fs = [...fileInput.files]; fileInput.value = ""; await upload(fs); });
  storeCard.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) { e.preventDefault(); storeCard.classList.add("apt-drop"); } });
  storeCard.addEventListener("dragleave", (e) => { if (!storeCard.contains(e.relatedTarget)) storeCard.classList.remove("apt-drop"); });
  storeCard.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); storeCard.classList.remove("apt-drop");
    guard(() => upload([...e.dataTransfer.files]))();
  });

  // ======================= lifecycle =======================
  async function reloadAll() {
    dirty = false;
    cwd = [];
    try { await loadInfo(); } catch (e) { showError(e); }
    await Promise.all([renderPerms().catch(showError), refreshRun().catch(() => {}), loadDir().catch(showError)]);
    const none = !validPkg();
    for (const b of [launchB, restartB, stopB, clearB, settingsB, saveB, addB, refreshB]) b.disabled = none || !ctx.getAdb();
  }
  app.onChange(() => { if (ctx.isShown("apptools")) reloadAll(); else dirty = true; });

  return {
    show() { if (dirty || !info) reloadAll(); else refreshRun().catch(() => {}); },
    connected() { dirty = true; },
    disconnected() {
      dirty = true; info = null;
      infoBody.replaceChildren(el("div", { className: "empty", textContent: "Connect a phone to see app details." }));
      permBody.replaceChildren(); listBox.replaceChildren(); runState.textContent = ""; viewBox.hidden = true;
    },
  };
}
