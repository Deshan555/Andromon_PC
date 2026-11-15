// Developer tab: tools for people who build Android apps. Each sub-tab lives in ./dev/<name>.js and
// is mounted the first time it's opened. A part module exports `mount(root, ctx)` and may return
// hooks { show(), hide(), connected(), disconnected() }.
//
// Every string from the phone is untrusted: parts insert it with textContent / el(), never innerHTML.

import * as logcat from "./dev/logcat.js";
import * as settings from "./dev/settings.js";
import * as apptools from "./dev/apptools.js";
import * as capture from "./dev/capture.js";
import * as perf from "./dev/perf.js";
import * as network from "./dev/network.js";
import * as input from "./dev/input.js";
import * as location from "./dev/location.js";
import * as phones from "./dev/phones.js";
import * as perftest from "./qa/perftest.js";
import * as security from "./qa/security.js";
import * as traffic from "./qa/traffic.js";
import * as apitest from "./qa/apitest.js";
import * as trace from "./qa/trace.js";

const PARTS = [
  { id: "logcat", label: "Logcat", mod: logcat },
  { id: "settings", label: "Dev settings", mod: settings },
  { id: "apptools", label: "App tools", mod: apptools },
  { id: "capture", label: "Capture", mod: capture },
  { id: "perf", label: "Performance", mod: perf },
  { id: "network", label: "Network", mod: network, eager: true }, // restores port forwards on connect
  { id: "input", label: "Input", mod: input },
  { id: "location", label: "Fake location", mod: location, eager: true }, // clears a fake location left from last time
  { id: "phones", label: "Phones", mod: phones },
];

// App testing tab: the same kind of sub-tabs, for testers and app security checks.
const QA_PARTS = [
  { id: "perftest", label: "Performance tests", mod: perftest },
  { id: "security", label: "Security scan", mod: security },
  { id: "traffic", label: "API calls", mod: traffic, eager: true }, // turns the phone's proxy back off after a crash
  { id: "apitest", label: "API tester", mod: apitest },
  { id: "trace", label: "Traces", mod: trace },
];

export function initDevtools(base) {
  return initPartTabs(base, { view: "dev", rootId: "devRoot", tabsId: "devTabs", parts: PARTS, tabKey: "tab", shellExtras: true });
}
export function initAppTesting(base) {
  return initPartTabs(base, { view: "qa", rootId: "qaRoot", tabsId: "qaTabs", parts: QA_PARTS, tabKey: "qaTab" });
}

// One set of helpers (settings store, selected app...) shared by both tabs.
let shared = null;
function sharedCtx(base) {
  if (shared) return shared;
  const { el, sh } = base;

  // ---------- small shared helpers ----------
  const store = {
    get(key, def) { try { const v = localStorage.getItem("dd.dev." + key); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(key, v) { try { localStorage.setItem("dd.dev." + key, JSON.stringify(v)); } catch {} },
  };

  // A long-running shell process (logcat, screenrecord...). Not tracked by the busy spinner.
  const spawn = (cmd) => base.getAdb().subprocess.noneProtocol.spawn(cmd);

  // Reads a process's output line by line until it ends or `stop()` is called.
  async function readLines(proc, onLine) {
    const reader = proc.output.getReader(), dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
      }
    } catch {} finally { if (buf) onLine(buf); try { reader.releaseLock(); } catch {} }
  }

  // ---------- the selected app, shared by every part ----------
  let pkg = store.get("pkg", "");
  let appList = null; // [{ pkg, system }]
  const appListeners = new Set();
  const app = {
    get: () => pkg,
    set(p) {
      p = String(p || "").trim();
      if (p === pkg) return;
      pkg = p; store.set("pkg", p);
      for (const cb of appListeners) { try { cb(p); } catch (e) { console.error(e); } }
    },
    onChange(cb) { appListeners.add(cb); return () => appListeners.delete(cb); },
    async list(force = false) {
      if (appList && !force) return appList;
      const [all, third] = await Promise.all([sh("pm list packages --user 0"), sh("pm list packages --user 0 -3")]);
      const user = new Set(third.split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean));
      appList = all.split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean)
        .map((p) => ({ pkg: p, system: !user.has(p) }))
        .sort((a, b) => a.system - b.system || a.pkg.localeCompare(b.pkg));
      return appList;
    },
    /** The app in the foreground on the phone, or "". */
    async foreground() {
      const out = await sh("dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity|ResumedActivity:' | head -3").catch(() => "");
      const m = out.match(/u\d+ ([A-Za-z0-9_.]+)\//);
      return m ? m[1] : "";
    },
    /** A package box (type or pick) plus "Current app" button, kept in sync with the shared selection. */
    picker({ label = "App" } = {}) {
      const id = "devApps" + Math.random().toString(36).slice(2, 8);
      const list = el("datalist", { id });
      const box = el("input", { type: "text", className: "mono", placeholder: "com.example.app", value: pkg, spellcheck: false, autocomplete: "off" });
      box.setAttribute("list", id);
      const fill = async () => {
        if (list.childElementCount) return;
        try { for (const a of await app.list()) list.append(el("option", { value: a.pkg, label: a.system ? "system" : "" })); } catch {}
      };
      box.addEventListener("focus", fill);
      box.addEventListener("change", () => app.set(box.value));
      box.addEventListener("keydown", (e) => { if (e.key === "Enter") app.set(box.value); });
      const cur = el("button", { className: "btn sm", type: "button", textContent: "Current app", title: "Use the app that's on the phone's screen now" });
      cur.onclick = async () => {
        const p = await app.foreground();
        if (p) { box.value = p; app.set(p); } else base.toast("Couldn't tell which app is open");
      };
      app.onChange((p) => { if (box.value !== p) box.value = p; });
      return el("div", { className: "dev-picker" }, el("span", { className: "dev-lbl", textContent: label }), box, list, cur);
    },
  };

  shared = {
    ...base, store, spawn, readLines, app,
    net: globalThis.droidDesk?.devnet || null,
    // A titled card; `extra` goes on the right of the title.
    card(title, extra, ...kids) {
      const head = el("div", { className: "dev-head" }, el("h2", { textContent: title }));
      if (extra) head.append(extra);
      return el("div", { className: "card" }, head, ...kids);
    },
    resetAppList: () => { appList = null; },
  };
  return shared;
}

function initPartTabs(base, { view, rootId, tabsId, parts: PARTS, tabKey, shellExtras = false }) {
  const { $, el } = base;
  const root = $(rootId), tabs = $(tabsId);
  const mounted = new Map(); // id -> hooks
  let currentPart = null, visible = false;
  const ctx = { ...sharedCtx(base), isShown: (id) => visible && currentPart === id };
  const { store } = ctx;

  if (shellExtras) mountShellExtras(ctx);

  // ---------- tabs ----------
  for (const p of PARTS) {
    const b = el("button", { type: "button", textContent: p.label });
    b.dataset.part = p.id;
    b.onclick = () => openPart(p.id);
    tabs.append(b);
    const pane = el("div", { className: "dev-pane", hidden: true });
    pane.dataset.dev = p.id;
    root.append(pane);
  }

  function ensureMounted(id) {
    if (mounted.has(id)) return mounted.get(id);
    const pane = root.querySelector(`[data-dev="${id}"]`);
    try { mounted.set(id, PARTS.find((p) => p.id === id).mod.mount(pane, ctx) || {}); }
    catch (e) { mounted.set(id, {}); base.showError(e); }
    return mounted.get(id);
  }

  function openPart(id) {
    if (!PARTS.some((p) => p.id === id)) id = PARTS[0].id;
    if (currentPart && currentPart !== id) mounted.get(currentPart)?.hide?.();
    currentPart = id; store.set(tabKey, id);
    for (const b of tabs.children) b.classList.toggle("on", b.dataset.part === id);
    for (const pane of root.children) pane.hidden = pane.dataset.dev !== id;
    ensureMounted(id);
    if (visible && base.getAdb()) mounted.get(id).show?.();
  }

  return {
    load() {
      visible = true;
      openPart(currentPart || store.get(tabKey, PARTS[0].id));
    },
    onShow(v) {
      if (v === view || !visible) return;
      visible = false;
      if (currentPart) mounted.get(currentPart)?.hide?.();
    },
    onConnected() {
      // Parts marked eager work in the background (e.g. port forwards), so they exist from the start.
      for (const p of PARTS) if (p.eager && !mounted.has(p.id)) { ensureMounted(p.id); }
      for (const h of mounted.values()) h.connected?.();
    },
    // Called before the user disconnects, while the phone can still be reached: parts undo changes.
    beforeDisconnect() { return Promise.all([...mounted.values()].map((h) => Promise.resolve(h.beforeDisconnect?.()).catch(() => {}))); },
    onDisconnected() { ctx.resetAppList(); for (const h of mounted.values()) h.disconnected?.(); },
    openPart,
  };
}

// ---------- Shell tab extras: saved snippets and command history (↑ / ↓) ----------
const DEFAULT_SNIPPETS = [
  ["Battery", "dumpsys battery"],
  ["App on screen", "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'"],
  ["Memory", "head -5 /proc/meminfo"],
  ["Storage", "df -h /data /sdcard"],
  ["My apps", "pm list packages -3"],
  ["IP address", "ip -f inet addr show wlan0"],
  ["Build", "getprop | grep -E 'ro.build.(fingerprint|version.release|version.sdk|type)'"],
  ["Running services", "dumpsys activity services | grep ServiceRecord | head -40"],
];
function mountShellExtras({ $, el, store }) {
  const form = $("shellForm"), input = $("shellCmd");
  if (!form || !input) return;
  let snippets = store.get("snippets", null) || DEFAULT_SNIPPETS.map(([name, cmd]) => ({ name, cmd }));
  let history = store.get("history", []);
  const bar = el("div", { className: "snips" });
  const save = el("button", { className: "btn sm", type: "button", textContent: "Save as snippet", title: "Keep the command in the box as a one-click button" });
  const run = (cmd) => { input.value = cmd; form.requestSubmit(); };
  function render() {
    bar.replaceChildren(...snippets.map((sn, i) => {
      const chip = el("span", { className: "snip" });
      const go = el("button", { type: "button", textContent: sn.name, title: sn.cmd });
      go.onclick = () => run(sn.cmd);
      const x = el("button", { type: "button", className: "x", textContent: "×", title: "Remove this snippet", ariaLabel: `Remove ${sn.name}` });
      x.onclick = () => { snippets.splice(i, 1); store.set("snippets", snippets); render(); };
      chip.append(go, x);
      return chip;
    }), save);
  }
  save.onclick = () => {
    const cmd = input.value.trim();
    if (!cmd) { input.focus(); return; }
    if (snippets.some((s) => s.cmd === cmd)) return;
    const name = cmd.length > 28 ? cmd.slice(0, 27) + "…" : cmd;
    snippets.push({ name, cmd }); store.set("snippets", snippets); render();
  };
  form.after(bar);
  render();

  // History: the form's own submit handler runs the command; this only remembers it.
  let pos = -1, draft = "";
  form.addEventListener("submit", () => {
    const cmd = input.value.trim();
    if (!cmd) return;
    history = [cmd, ...history.filter((h) => h !== cmd)].slice(0, 100);
    store.set("history", history); pos = -1;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (!history.length) return;
    e.preventDefault();
    if (pos === -1) draft = input.value;
    pos = e.key === "ArrowUp" ? Math.min(history.length - 1, pos + 1) : Math.max(-1, pos - 1);
    input.value = pos === -1 ? draft : history[pos];
    input.setSelectionRange(input.value.length, input.value.length);
  });
}
