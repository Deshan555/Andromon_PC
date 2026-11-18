import { Adb, AdbDaemonTransport, LinuxFileType, AdbPacket, AdbPacketSerializeStream } from "@yume-chan/adb";
import { StructDeserializeStream, pipeFrom, Consumable } from "@yume-chan/stream-extra";
import qrcode from "qrcode-generator";
import { AdbDaemonWebUsbDeviceManager, AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbScrcpyClient, AdbScrcpyExitedError, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import {
  DefaultServerPath, ScrcpyPointerId, AndroidMotionEventAction, AndroidKeyCode,
  AndroidKeyEventAction, AndroidScreenPowerMode, h264ParseConfiguration,
} from "@yume-chan/scrcpy";
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer, BitmapVideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";
import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket } from "mediabunny";
import { openPackageFiles, selectSplits, SENSITIVE_PERMISSIONS } from "./apk.js";
import { initAutotest } from "./autotest.js";
import { initDevtools, initAppTesting } from "./devtools.js";
import { initLinks } from "./links.js";
import { initSettings } from "./settings.js";
import { initDownloads } from "./downloads.js";
import { initDropdowns } from "./dropdown.js";
import { initFiles } from "./files.js";
import { icon } from "./fileicons.js";
import { initScreenshot, shotPrefs } from "./screenshot.js";
import { initShell, shellPrefs } from "./shell.js";
import { initKnowledge } from "./knowledge.js";
import { initShizuku } from "./shizuku.js";
import { initWifiRadar } from "./wifiradar.js";
import { initRevanced } from "./revanced.js";
import { initFdroid } from "./fdroid.js";
import { initPeople } from "./people.js";
import { initCalendar } from "./calendar.js";
import { initBackup } from "./backup.js";
import { createProgress, countBytes } from "./progress.js";
import { toCsv, toVcard, parseVcf, buildSmsXml, parseSmsXml, buildCallsCsv, parseCallsFile, threadPeople, mmsPeople, attachmentName, base64ToBytes, makeContactMatcher } from "./pdata.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const k of kids) n.append(k);
  return n;
};
// Every string from the phone is untrusted: always insert via textContent / el(), never innerHTML.

let adb = null;
let autotest = null; // Test automation tab (./autotest.js), set up at the end of this file
let devtools = null; // Developer tab (./devtools.js), set up at the end of this file
let apptesting = null; // App testing tab (./devtools.js › initAppTesting, ./qa/*.js)
let people = null; // Contacts: photos, edit, delete, duplicates (./people.js), set up at the end of this file
let calendarTab = null; // Calendar tab (./calendar.js)
let backup = null; // Phone backup, restore and the automatic photo copy (./backup.js)
let revancedTab = null; // ReVanced page: patch an app on this computer (./revanced.js)
let fdroidTab = null; // F-Droid page: free apps from F-Droid's catalogue (./fdroid.js)
let shizukuCard = null; // The Shizuku page (./shizuku.js), set up at the end of this file
let downloads = null; // the download manager (./downloads.js), set up at the end of this file
let links = null; // Phone links on the Overview and the Call buttons (./links.js), set up at the end of this file
const credentialStore = new AdbWebCredentialStore("Andromon");

// ---------- helpers ----------
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}
function showError(e) {
  console.error(e);
  const box = $("errBox");
  box.textContent = e instanceof Error ? e.message : String(e);
  box.hidden = false;
}
function clearError() { $("errBox").hidden = true; }
const fmtSize = (n) => {
  n = Number(n); if (!isFinite(n)) return "";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + " " + u[i];
};
const shQuote = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
// ---- activity: a spinning circle in the top bar while anything talks to the phone ----
// Every shell command, file transfer and companion call goes through track(). The circle appears
// only if the work takes longer than a moment, so quick calls don't make it flicker.
const spinner = () => el("span", { className: "spin", ariaHidden: "true" });
let activeOps = 0, activityShow = null, activityHide = null;
function opStart() {
  if (activeOps++ > 0) return;
  clearTimeout(activityHide);
  activityShow = setTimeout(() => { $("activity").hidden = false; }, 150);
}
function opEnd() {
  if (--activeOps > 0) return;
  clearTimeout(activityShow);
  activityHide = setTimeout(() => { $("activity").hidden = true; }, 120); // bridges back-to-back calls
}
function track(fn) {
  opStart();
  let p;
  try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
  return p.finally(opEnd);
}
const sh = (cmd) => track(() => adb.subprocess.noneProtocol.spawnWaitText(cmd));
function shBytes(cmd) { return track(() => adb.subprocess.noneProtocol.spawnWait(cmd)); }

async function readAll(stream) {
  const reader = stream.getReader(); const parts = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value.slice()); }
  return new Blob(parts);
}
function download(blob, name) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function withSync(fn) {
  return track(async () => {
    const sync = await adb.sync();
    try { return await fn(sync); } finally { await sync.dispose(); }
  });
}
// While busy, a button shows a spinning circle and `label`, and can't be clicked again.
function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.replaceChildren(spinner(), label || "Working…"); btn.disabled = true; btn.setAttribute("aria-busy", "true"); }
  else { btn.textContent = btn.dataset.label; btn.disabled = false; btn.removeAttribute("aria-busy"); }
}
const loadingBox = (text) => el("div", { className: "empty" }, spinner(), " ", text);
const loadingRow = (cols, text) => el("tr", {}, el("td", { colSpan: cols, className: "empty" }, spinner(), " ", text));
// Two-click confirm instead of a blocking confirm() dialog.
function armedClick(btn, action) {
  const label = btn.textContent;
  btn.addEventListener("click", async () => {
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed"); btn.textContent = "Confirm?";
      setTimeout(() => { if (btn.classList.contains("armed")) { btn.classList.remove("armed"); btn.textContent = label; } }, 3000);
      return;
    }
    btn.classList.remove("armed"); btn.textContent = label;
    await action();
  });
}

// Options live in Settings; a page that shows their state links there with this button.
const settingsLink = (text = "Change in Settings") => {
  const b = el("button", { className: "btn sm", type: "button", textContent: text });
  b.onclick = () => show("settings");
  return b;
};

// ---------- navigation ----------
let current = "overview";
const loaders = { overview: loadOverview, backup: () => backup?.renderCard(), shizuku: () => Promise.all([shizukuCard?.render(), renderRamCard()]), apps: loadApps, controls: loadControls, debloat: () => loadDebloat(), revanced: () => revancedTab.load(),
  messages: () => loadMessages(), contacts: () => loadContacts(), calls: () => loadCalls(), files: () => filesTab.load(), photos: () => loadPhotos(), music: () => loadMusic(), notifs: () => loadNotifs(), calendar: () => calendarTab.load(), mirror: () => {}, tests: () => autotest.load(), dev: () => devtools.load(), qa: () => apptesting.load(), screen: () => {}, shell: () => $("shellCmd").focus() };
// Views that work without a phone on USB.
const offlineViews = { wifi: () => loadWifi(), settings: () => settingsUi?.load(), fdroid: () => fdroidTab.load() };
let settingsUi = null;
// The sidebar's tools are in groups. A group folds when its heading is clicked; which ones are folded is remembered.
const NAV_FOLD_KEY = "andromon.navClosed";
function setNavGroup(g, open) {
  g.classList.toggle("closed", !open);
  g.querySelector(".nhead").setAttribute("aria-expanded", String(open));
}
{
  let closed = ["dev"];
  try { const v = JSON.parse(localStorage.getItem(NAV_FOLD_KEY)); if (Array.isArray(v)) closed = v; } catch {}
  for (const g of $("nav").querySelectorAll(".ngroup")) setNavGroup(g, !closed.includes(g.dataset.group));
}
$("nav").addEventListener("click", (e) => {
  const head = e.target.closest(".nhead");
  if (head) {
    const g = head.parentElement; setNavGroup(g, g.classList.contains("closed"));
    try { localStorage.setItem(NAV_FOLD_KEY, JSON.stringify([...$("nav").querySelectorAll(".ngroup.closed")].map((x) => x.dataset.group))); } catch {}
    return;
  }
  const b = e.target.closest("button[data-view]"); if (!b || b.disabled) return;
  show(b.dataset.view);
});
// Big light headings with an italic part, like the companion app's screens.
const HEADINGS = {
  overview: ["Your phone, ", "at a glance"], apps: ["Your ", "apps"], messages: ["Your ", "messages"], contacts: ["Your ", "people"],
  calls: ["Call ", "history"], notifs: ["Phone ", "notifications"], controls: ["Quick ", "controls"], debloat: ["Clean up ", "extra apps"], revanced: ["Patch apps with ", "ReVanced"], fdroid: ["Free apps from ", "F-Droid"], files: ["Your ", "files"],
  photos: ["Photos ", "& videos"], music: ["Your ", "music"], mirror: ["Your screen, ", "on your desk"], tests: ["Test ", "automation"], screen: ["Take a ", "screenshot"], dev: ["Developer ", "tools"], qa: ["App ", "testing"],
  shell: ["ADB ", "shell"], backup: ["Backup ", "& restore"], shizuku: ["Shizuku ", "on this phone"], wifi: ["Wi‑Fi ", "transfer"], settings: ["Settings", ""], calendar: ["Your ", "calendar"],
};
function setTitle(view) {
  const [plain, italic] = view === "overview" && !adb ? ["Connect ", "your phone"] : HEADINGS[view] || [view, ""];
  $("title").replaceChildren(plain, el("i", { textContent: italic }));
  document.title = `${$("nav").querySelector(`[data-view="${view}"]`).textContent} · Andromon`;
}
function show(view) {
  if (view !== "mirror" && view !== "tests" && mirror) stopMirror("Mirroring stopped");
  autotest?.onShow(view);
  devtools?.onShow(view);
  apptesting?.onShow(view);
  if (view !== "photos") closeViewer();
  current = view;
  for (const b of $("nav").querySelectorAll("button[data-view]")) {
    b.classList.toggle("active", b.dataset.view === view);
    // Opened from somewhere else (an Overview card, a pop-up): unfold its group so the open tool is visible.
    if (b.dataset.view === view && b.closest(".ngroup.closed")) setNavGroup(b.closest(".ngroup"), true);
  }
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== view;
  document.querySelector(".app").dataset.view = view;
  setTitle(view);
  clearError();
  if (offlineViews[view]) Promise.resolve(offlineViews[view]()).catch(showError);
  else if (adb) Promise.resolve(loaders[view]()).catch(showError);
}

// ---------- connection ----------
if (!AdbDaemonWebUsbDeviceManager.BROWSER) {
  $("connectBtn").disabled = true;
  showError("WebUSB is not available here. Use the Andromon desktop app, or open this page in desktop Chrome/Edge from http://localhost.");
}

// The header's Connect phone button is an icon: while it works, a spinner takes the icon's place and
// what it is doing ("Connecting…") goes in its tooltip and its name for screen readers.
const connectBtnUi = (() => {
  const btn = $("connectBtn"), icon = [...btn.childNodes], title = btn.title, name = btn.getAttribute("aria-label");
  const say = (text) => { btn.title = text; btn.setAttribute("aria-label", text); };
  return {
    start(text) { btn.replaceChildren(spinner()); btn.disabled = true; btn.setAttribute("aria-busy", "true"); say(text); },
    set textContent(text) { say(text); }, // connectUsb reports its steps this way
    stop() { if (!btn.hasAttribute("aria-busy")) return; btn.replaceChildren(...icon); btn.disabled = false; btn.removeAttribute("aria-busy"); btn.title = title; btn.setAttribute("aria-label", name); },
  };
})();
$("connectBtn").addEventListener("click", async () => {
  clearError();
  try {
    const device = await AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice();
    if (!device) return; // picker cancelled
    connectBtnUi.start("Connecting…");
    const connection = await connectUsb(device, connectBtnUi);
    $("authBox").hidden = false;
    const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore });
    $("authBox").hidden = true;
    startSession(transport, "Connected to " + device.serial);
  } catch (e) {
    $("authBox").hidden = true;
    showError(e);
  } finally {
    connectBtnUi.stop();
  }
});
let connectedVia = null; // "usb" | "wifi"
const phoneVia = new WeakMap(); // Adb -> "usb" | "wifi"

// ---------- several phones at once (Developer › Phones) ----------
// Opens one more USB phone next to the main one and returns its Adb (null if the picker was cancelled).
async function openExtraUsbPhone(btn) {
  const device = await AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice();
  if (!device) return null;
  const connection = await connectUsb(device, btn);
  const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore });
  const a = new Adb(transport);
  phoneVia.set(a, "usb");
  return a;
}
// Makes `next` (an open Adb) the phone the whole app works with. The previous one stays open and is returned.
async function swapMainPhone(next) {
  const prev = adb;
  if (prev === next) return null;
  if (prev) {
    stopCallAlerts();
    if (companionInfo) await Promise.race([companionCall("stop").catch(() => {}), wait(1500)]);
    if (devtools) await Promise.race([Promise.all([devtools.beforeDisconnect(), apptesting?.beforeDisconnect()]), wait(2500)]);
    resetSessionState();
  }
  startSession(next, `Now using ${next.banner?.model || next.serial}`, phoneVia.get(next) || "usb");
  return prev;
}
// `transport` may also be an already open Adb (a phone made the main one in Developer › Phones).
function startSession(transport, message, via = "usb") {
  const a = adb = transport instanceof Adb ? transport : new Adb(transport);
  connectedVia = via; phoneVia.set(a, via);
  // Only the phone in use ends the session; others open in Developer › Phones handle their own.
  const lost = () => { if (adb === a) onDisconnected(); };
  a.disconnected.then(lost, lost);
  setConnected(true);
  toast(message);
  show(current);
  renderWadbIntro(); renderWadbSetup();
  startCallAlerts();
  autoStartRamHelper();
  removeLegacyCompanion().catch(() => {});
  devtools?.onConnected();
  links?.onConnected();
  backup?.onConnected();
  apptesting?.onConnected();
}

// ---------- connect over Wi‑Fi (Wireless debugging; protocol work happens in ../wadb.js) ----------
const wadbApi = globalThis.andromon?.wadb || null;
let wadbUi = { services: [], phones: [], auto: false, qr: null, status: "", attempting: false, quietUntil: 0 };
const serialOf = (name) => String(name).replace(/^adb-/, "").replace(/-[^-]*$/, "");
const onlineService = (serial) => wadbUi.services.find((s) => s.kind === "connect" && serialOf(s.name) === serial);

// Wi‑Fi connections use the same key as USB, so a phone that already trusts this computer
// ("Always allow from this computer") accepts it over Wi‑Fi without pairing.
const wadbKeyReady = wadbApiReady();
async function wadbApiReady() {
  const api = globalThis.andromon?.wadb;
  if (!api) return;
  try {
    let key = null;
    for await (const k of credentialStore.iterateKeys()) { key = k; break; }
    if (!key) key = await credentialStore.generateKey();
    await api.setKey(key.buffer ?? key);
  } catch (e) { console.warn("wireless key", e); }
}

// ADB packets over the MessagePort the main process hands us (raw bytes; TLS is done there).
let killWifiLink = null; // drops the current Wi‑Fi link when it has stopped responding
function portConnection(port) {
  let controller, done = false;
  const finish = () => { done = true; port.onmessage = null; port.close(); };
  killWifiLink = () => {
    if (done) return;
    try { controller.error(new Error("The Wi‑Fi connection to the phone stopped responding")); } catch {}
    finish();
  };
  // Closing the port tells the main process to close the network link.
  const bytes = new ReadableStream({ start(c) { controller = c; }, cancel: finish });
  port.onmessage = (e) => {
    if (done) return;
    const d = e.data;
    if (d instanceof Uint8Array || d instanceof ArrayBuffer) controller.enqueue(new Uint8Array(d));
    else if (d && d.closed) {
      try { d.error ? controller.error(new Error(d.error)) : controller.close(); } catch {}
      finish();
    }
  };
  return {
    readable: bytes.pipeThrough(new StructDeserializeStream(AdbPacket)),
    writable: pipeFrom(new Consumable.WritableStream({ write(chunk) { port.postMessage(chunk); } }), new AdbPacketSerializeStream()),
  };
}
let portWaiter = null; // one connection attempt at a time
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin || e.data?.source !== "andromon-wadb" || !e.ports[0]) return;
  const w = portWaiter; portWaiter = null;
  if (w) w({ port: e.ports[0], meta: e.data.meta }); else e.ports[0].close();
});

/** Opens a Wi‑Fi ADB connection and authenticates it. Returns the transport (caller owns it). */
async function wadbOpen(target, timeoutMs = 60_000) {
  await wadbKeyReady;
  let timer;
  const got = new Promise((resolve, reject) => {
    portWaiter = resolve;
    timer = setTimeout(() => { portWaiter = null; reject(new Error("The connection didn't open.")); }, 20_000);
  });
  try { await wadbApi.connect(target); } catch (e) { portWaiter = null; clearTimeout(timer); throw e; }
  const { port, meta } = await got.finally(() => clearTimeout(timer));
  // The timeout must be cancelled once the phone answers: firing later would close a working link.
  let authTimer;
  const transport = await Promise.race([
    AdbDaemonTransport.authenticate({ serial: meta.serial, connection: portConnection(port), credentialStore }),
    new Promise((_, reject) => {
      authTimer = setTimeout(() => {
        killWifiLink?.(); port.close();
        reject(new Error("The phone didn't answer. If it shows an “Allow debugging?” prompt, tap Allow, then try again."));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(authTimer));
  return { transport, meta };
}

async function wadbConnect(target, btn) {
  clearError();
  if (adb || wadbUi.attempting) { if (adb) showError("Disconnect the current phone first."); return; }
  wadbUi.attempting = true;
  if (btn) busy(btn, true, "Connecting…");
  try {
    const { transport, meta } = await wadbOpen(target);
    closeWadb();
    startSession(transport, `Connected over Wi‑Fi to ${transport.banner.model || meta.host}`, "wifi");
  } catch (e) {
    showError(target?.serial && /refused|closed/i.test(e.message)
      ? new Error("The phone didn't accept this computer over Wi‑Fi. Connect it with the USB cable once and click “Use this phone without the cable”, or pair it with the QR code.")
      : e);
  } finally { wadbUi.attempting = false; if (btn?.isConnected) busy(btn, false); renderWadbIntro(); }
}

// ---- welcome screen: remembered phones that are on the network right now (+ auto-connect) ----
function renderWadbIntro() {
  const box = $("wadbIntro");
  if (!wadbApi || adb) { box.hidden = true; return; }
  const phones = wadbUi.phones.map((p) => ({ ...p, svc: onlineService(p.serial) }));
  box.hidden = !phones.length;
  if (!phones.length) return;
  box.replaceChildren(
    el("div", { className: "toolbar", style: "margin:0 0 6px;justify-content:space-between" },
      el("h2", { style: "margin:0", textContent: "Your phones over Wi‑Fi" })),
    ...phones.map((p) => {
      const go = el("button", { className: "btn sm primary", textContent: "Connect", type: "button" });
      go.onclick = () => wadbConnect({ serial: p.serial }, go);
      go.disabled = !p.svc || wadbUi.attempting;
      return el("div", { className: "wadb-row" },
        el("div", { className: "grow" },
          el("b", { textContent: p.model || p.serial }),
          el("span", { className: p.svc ? "chip" : "chip warn", style: "margin-left:8px", textContent: p.svc ? `on Wi‑Fi · ${p.svc.host}` : "not on the network" }),
          p.svc ? "" : el("div", { className: "sub", textContent: "On the phone: Andromon Companion › PC link › Turn on Wi‑Fi connection." })),
        go);
    }));
}
function maybeAutoConnect() {
  if (!wadbUi.auto || adb || wadbUi.attempting || Date.now() < wadbUi.quietUntil) return;
  const p = wadbUi.phones.find((x) => onlineService(x.serial));
  if (p) wadbConnect({ serial: p.serial });
}

// ---- one-time setup while on USB: "Use this phone without the cable" ----
function renderWadbSetup() {
  const box = $("wadbSetup");
  if (!wadbApi || connectedVia !== "usb") { box.hidden = true; return; }
  const status = el("div", { className: "sub", style: "margin-top:8px" });
  const btn = el("button", { className: "btn primary", textContent: "Use this phone without the cable", type: "button" });
  btn.onclick = async () => { busy(btn, true, "Setting up…"); clearError(); try { await setupWireless(status, box); } catch (e) { status.textContent = ""; showError(e); } finally { if (btn.isConnected) busy(btn, false); } };
  box.replaceChildren(
    el("div", { className: "toolbar", style: "margin:0;justify-content:space-between" },
      el("div", {}, el("b", { textContent: "Connect over Wi‑Fi next time" }),
        el("div", { className: "sub", textContent: "One click sets it up while the cable is in. After that, the phone connects over your Wi‑Fi (Android 11+)." })),
      btn),
    status);
  box.hidden = false;
}

// Listening sockets owned by adbd (it runs as the shell user, uid 2000), from /proc/net/tcp*.
async function adbdListeners() {
  const text = await sh("cat /proc/net/tcp6 /proc/net/tcp 2>/dev/null").catch(() => "");
  const tcpPort = Number((await sh("getprop service.adb.tcp.port").catch(() => "")).trim()) || 5555;
  const out = new Set();
  for (const m of text.matchAll(/^\s*\d+:\s+([0-9A-F]+):([0-9A-F]{4})\s+[0-9A-F]+:0000\s+0A\s+\S+\s+\S+\s+\S+\s+(\d+)/gm)) {
    const port = parseInt(m[2], 16);
    if (m[3] === "2000" && /^0+$/.test(m[1]) && port !== tcpPort) out.add(port);
  }
  return out;
}
/** The Wireless debugging port: from mDNS (also gives the address), the property, or adbd's new listener. */
async function findWirelessPort(serial, before) {
  const svc = onlineService(serial);
  if (svc) return { host: svc.host, port: svc.port };
  const prop = Number((await sh("getprop service.adb.tls.port")).trim()) || 0;
  if (prop) return { port: prop };
  if ((await sh("settings get global adb_wifi_enabled")).trim() !== "1") return null;
  const now = [...(await adbdListeners())];
  const fresh = now.filter((p) => !before.has(p));
  if (fresh.length === 1) return { port: fresh[0] };
  if (now.length === 1) return { port: now[0] };
  return null;
}

async function setupWireless(status, box) {
  const step = (t) => { status.textContent = t; };
  const sdk = Number((await sh("getprop ro.build.version.sdk")).trim());
  if (sdk < 30) throw new Error("This phone has Android 10 or older. Connecting over Wi‑Fi needs Android 11 or later, so keep using the cable.");
  const ip = (await sh("ip -4 -o addr show wlan0 2>/dev/null")).match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!ip) throw new Error("The phone isn't connected to Wi‑Fi. Connect it to the same Wi‑Fi as this computer, then try again.");
  step("Preparing Andromon Companion on the phone…");
  companionInfo = await ensureCompanion(step);
  // Lets the companion's PC link screen switch Wireless debugging on and off with one tap later.
  await sh(`pm grant ${COMPANION_PKG} android.permission.WRITE_SECURE_SETTINGS`).catch(() => {});
  const serial = (await sh("getprop ro.serialno")).trim() || adb.serial;
  step("Turning on the Wi‑Fi connection… If the phone asks “Allow wireless debugging on this network?”, tick “Always allow” and tap Allow.");
  const before = await adbdListeners();
  await sh("settings put global adb_wifi_enabled 1");
  let target = null;
  for (let i = 0; i < 90 && !target; i++) {
    await wait(1000);
    target = await findWirelessPort(serial, before);
  }
  if (!target) throw new Error("The phone didn't turn on the Wi‑Fi connection. When the phone asks “Allow wireless debugging on this network?”, tap Allow, then click the button again.");
  const port = target.port, host = target.host || ip;
  const model = [(await sh("getprop ro.product.manufacturer")).trim(), (await sh("getprop ro.product.model")).trim()].filter(Boolean).join(" ");
  step(`Checking the Wi‑Fi connection to ${host}…`);
  let ok = false, why = "";
  let used = host;
  for (const h of [...new Set([host, ip])]) {
    try {
      const { transport } = await wadbOpen({ host: h, port }, 20_000);
      ok = true; used = h;
      await transport.close();
      break;
    } catch (e) { why = e.message; }
  }
  if (ok) {
    const st = await wadbApi.remember({ serial, model, host: used, port });
    wadbUi.phones = st.phones;
    const sw = el("button", { className: "btn primary", textContent: "Switch to Wi‑Fi now", type: "button" });
    sw.onclick = async () => {
      busy(sw, true, "Switching…");
      try { await adb?.close(); } catch {}
      onDisconnected();
      await wait(800);
      await wadbConnect({ serial }, null);
    };
    box.replaceChildren(
      el("b", { textContent: "✓ All set: this phone can connect over Wi‑Fi" }),
      el("ul", { className: "muted small" },
        el("li", { textContent: "You can unplug the cable." }),
        el("li", { textContent: "Next time: on the phone open Andromon Companion › PC link › Turn on Wi‑Fi connection. Andromon shows the phone on its welcome screen (or connects by itself if you tick “Connect automatically”)." }),
        el("li", { textContent: "Wireless debugging stays on until you turn it off there, or the phone restarts." })),
      el("div", { className: "toolbar", style: "margin:8px 0 0" }, sw));
    return;
  }
  // This phone wants a separate pairing (e.g. "Always allow" wasn't ticked for USB): one QR scan.
  console.warn("Wi‑Fi check failed:", why);
  box.replaceChildren(
    el("b", { textContent: "One more step: pair over Wi‑Fi" }),
    el("div", { className: "muted small", textContent: /reach/i.test(why)
      ? `This computer can't reach the phone at ${ip}. Make sure both are on the same Wi‑Fi (not a guest network), then try again.`
      : "This phone wants to confirm the computer once more. Click Pair, then on the phone tap Wireless debugging › Pair device with QR code and scan the code." }));
  if (!/reach/i.test(why)) {
    const pairBtn = el("button", { className: "btn primary", textContent: "Pair", type: "button" });
    pairBtn.onclick = () => openWadb().catch(showError);
    await sh("am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS").catch(() => {});
    box.append(el("div", { className: "toolbar", style: "margin:8px 0 0" }, pairBtn));
  }
}

function closeWadb() {
  $("wadbBox").hidden = true;
  if (wadbUi.qr) wadbApi.cancelPair().catch(() => {});
  wadbUi.qr = null;
}

async function openWadb() {
  clearError();
  $("wadbBox").hidden = false;
  wadbUi.status = ""; wadbUi.qr = null; wadbUi.codeOpen = false;
  Object.assign(wadbUi, await wadbApi.browse(true));
  renderWadb();
  startQr();
}

async function startQr() {
  try {
    const qr = await wadbApi.qr();
    wadbUi.qr = qr; wadbUi.status = "Waiting for the phone to scan the code…";
    renderWadb();
  } catch (e) { wadbUi.status = e.message; renderWadb(); }
}

function qrImage(text) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  return el("img", { src: q.createDataURL(6, 2), alt: "Pairing QR code" });
}

function renderWadb() {
  const card = $("wadbCard");
  const close = el("button", { className: "btn sm", textContent: "Close", type: "button" }); close.onclick = closeWadb;
  const online = new Map(wadbUi.services.filter((s) => s.kind === "connect").map((s) => [serialOf(s.name), s]));
  // Saved phones, plus phones with Wireless debugging on that aren't paired yet
  const rows = wadbUi.phones.map((p) => {
    const svc = online.get(p.serial);
    const go = el("button", { className: "btn sm primary", textContent: "Connect", type: "button" });
    go.onclick = () => wadbConnect({ serial: p.serial }, go);
    const forget = el("button", { className: "btn sm", textContent: "Forget", type: "button", title: "Remove from this list (to fully unpair, use Wireless debugging › Paired devices on the phone)" });
    forget.onclick = async () => { Object.assign(wadbUi, await wadbApi.forget(p.serial)); renderWadb(); renderWadbIntro(); };
    return el("div", { className: "wadb-row" },
      el("div", { className: "grow" },
        el("div", {}, el("b", { textContent: p.model || p.serial }), el("span", { className: svc ? "chip" : "chip warn", style: "margin-left:8px", textContent: svc ? `online · ${svc.host}` : "not seen on the network" })),
        el("div", { className: "sub", textContent: `Added ${fmtDate(p.addedAt || p.pairedAt, true)}` })),
      go, forget);
  });
  for (const [serial, svc] of online) {
    if (wadbUi.phones.some((p) => p.serial === serial)) continue;
    const go = el("button", { className: "btn sm", textContent: "Try connecting", type: "button", title: "Works if this phone already trusts this computer over USB" });
    go.onclick = () => wadbConnect({ host: svc.host, port: svc.port }, go);
    rows.push(el("div", { className: "wadb-row" },
      el("div", { className: "grow" }, el("b", { textContent: serial }), el("div", { className: "sub", textContent: `Wireless debugging on at ${svc.host}:${svc.port} · not set up with this computer yet: scan the QR code below` })), go));
  }

  const qrPart = wadbUi.qr
    ? el("div", { className: "qrbox" }, qrImage(wadbUi.qr.text), el("ol", { className: "small" },
        el("li", { textContent: "Phone and computer on the same Wi‑Fi." }),
        el("li", {}, "On the phone: ", el("b", { textContent: "Settings › Developer options › Wireless debugging" }), " (turn it on)."),
        el("li", {}, "Tap ", el("b", { textContent: "Pair device with QR code" }), " and scan this."),
        el("li", { textContent: "Andromon pairs and connects by itself. You only do this once." })))
    : el("div", { className: "muted", textContent: "Making a pairing code…" });

  const codeToggle = el("button", { className: "link", textContent: wadbUi.codeOpen ? "Hide" : "Pair with a 6-digit code instead", type: "button" });
  codeToggle.onclick = () => { wadbUi.codeOpen = !wadbUi.codeOpen; renderWadb(); };
  const parts = [
    el("div", { className: "toolbar", style: "justify-content:space-between" }, el("h2", { style: "margin:0", textContent: "Connect over Wi‑Fi" }), close),
    el("p", { className: "muted small", style: "margin-top:0", textContent: "Uses Android's Wireless debugging (Android 11 and later). Everything in Andromon works the same as over USB. The connection is encrypted, and only computers you've paired can connect." }),
  ];
  if (rows.length) parts.push(el("h3", { textContent: "Your phones" }), el("div", {}, ...rows));
  parts.push(el("h3", { textContent: "Pair a phone" }), qrPart,
    el("div", { className: "sub", style: "margin:8px 0", textContent: wadbUi.status }), codeToggle);
  if (wadbUi.codeOpen) {
    const addr = el("input", { type: "text", placeholder: "IP address & port, e.g. 192.168.1.20:37099", size: 30 });
    const code = el("input", { type: "text", placeholder: "6-digit code", size: 10, inputMode: "numeric", maxLength: 6 });
    const btn = el("button", { className: "btn sm primary", textContent: "Pair", type: "button" });
    btn.onclick = async () => {
      const m = addr.value.trim().match(/^(.+):(\d+)$/);
      if (!m) return showError("Enter the IP address & port shown under “Pair device with pairing code”.");
      busy(btn, true, "Pairing…"); clearError();
      try { await wadbApi.pairCode(m[1], m[2], code.value); } catch (e) { showError(e); } finally { if (btn.isConnected) busy(btn, false); }
    };
    parts.push(el("div", { className: "small muted", style: "margin:8px 0 6px", textContent: "On the phone: Wireless debugging › Pair device with pairing code. Type the address and code it shows:" }),
      el("div", { className: "wadb-form" }, addr, code, btn));
  }
  // Manual connect (networks that block discovery), and turning it on while on USB.
  const host = el("input", { type: "text", placeholder: "IP address & port (Wireless debugging screen)", size: 32 });
  const go = el("button", { className: "btn sm", textContent: "Connect", type: "button" });
  go.onclick = () => { const m = host.value.trim().match(/^(.+):(\d+)$/); if (!m) return showError("Enter it as IP:port, e.g. 192.168.1.20:37099"); wadbConnect({ host: m[1], port: Number(m[2]) }, go); };
  parts.push(el("h3", { textContent: "Connect by address" }),
    el("div", { className: "wadb-form" }, host, go),
    el("div", { className: "sub", style: "margin-top:6px", textContent: "For paired phones on networks that hide devices from each other's discovery." }));
  card.replaceChildren(...parts);
}

if (wadbApi) {
  $("wifiConnectBtn").hidden = false;
  // Watch for remembered phones on the network while nothing is connected.
  wadbApi.browse(true).then((st) => { Object.assign(wadbUi, st); renderWadbIntro(); maybeAutoConnect(); }).catch(() => {});
  $("wifiConnectBtn").addEventListener("click", () => openWadb().catch(showError));
  $("wadbBox").addEventListener("click", (e) => { if (e.target === $("wadbBox")) closeWadb(); });
  wadbApi.onEvent((ev) => {
    if (ev.type === "services") { wadbUi.services = ev.services; if (!$("wadbBox").hidden) renderWadb(); renderWadbIntro(); maybeAutoConnect(); }
    else if (ev.type === "pairing") { wadbUi.status = `Pairing with the phone at ${ev.host}…`; renderWadb(); }
    else if (ev.type === "pair-error") { wadbUi.status = `Pairing didn't work: ${ev.message}`; renderWadb(); startQr(); }
    else if (ev.type === "paired") {
      wadbUi.phones = ev.phones; wadbUi.status = "Paired. Connecting…"; renderWadb(); renderWadbIntro();
      toast("Paired with the phone");
      if (!adb) wadbConnect({ serial: ev.serial });
      else { wadbUi.status = "Paired. Disconnect the current phone to connect over Wi‑Fi."; renderWadb(); }
    }
  });
}

// Another adb server (SDK, Android Studio, scrcpy...) holding the phone's USB interface is the
// usual reason a connect fails. In the desktop app, stop it and try again.
async function connectUsb(device, btn) {
  const isBusy = (e) => e instanceof AdbDaemonWebUsbDevice.DeviceBusyError;
  try { return await device.connect(); }
  catch (e) { if (!isBusy(e)) throw e; }
  if (!window.andromon?.adb)
    throw new Error("The phone's USB debugging connection is in use by another program. Run `adb kill-server` (or close Android Studio / scrcpy / other phone tools) and try again.");
  btn.textContent = "Stopping other adb…";
  await window.andromon.adb.release().catch(() => {});
  btn.textContent = "Connecting…";
  for (let i = 0; i < 5; i++) {
    await wait(500 + i * 300);
    try {
      const connection = await device.connect();
      toast("Stopped another adb server that was using the phone");
      return connection;
    } catch (e) { if (!isBusy(e)) throw e; }
  }
  throw new Error("The phone's USB debugging connection is still in use. Andromon stopped adb, but another program took the phone back. Close Android Studio, scrcpy or other phone tools and try again.");
}

$("disconnectBtn").addEventListener("click", async () => {
  stopCallAlerts();
  // Stop the companion's foreground service so its notification goes away.
  if (companionInfo) await Promise.race([companionCall("stop").catch(() => {}), wait(1500)]);
  if (devtools) await Promise.race([Promise.all([devtools.beforeDisconnect(), apptesting?.beforeDisconnect()]), wait(2500)]);
  try { await adb?.close(); } catch {}
  onDisconnected();
});

function onDisconnected() {
  if (!adb) return;
  if (connectedVia === "wifi") wadbUi.quietUntil = Date.now() + 60_000; // don't jump straight back in
  connectedVia = null;
  setTimeout(() => { renderWadbIntro(); renderWadbSetup(); }, 0);
  resetSessionState();
  setConnected(false); toast("Phone disconnected"); if (!offlineViews[current]) show("overview"); else if (current === "fdroid") show("fdroid");
}
// Forgets everything that belongs to the phone in use (on disconnect, and when switching phones).
function resetSessionState() {
  if (mirror) stopMirror();
  filesTab?.reset(); shotTab?.reset();
  autotest?.onDisconnected();
  devtools?.onDisconnected();
  links?.onDisconnected();
  apptesting?.onDisconnected();
  stopCallAlerts(); resetNotifs();
  adb = null; companionInfo = null; resetAppIcons();
  people?.reset(); calendarTab?.onDisconnected(); backup?.onDisconnected(); mmsList = []; mmsThumbs.clear(); mmsWant.length = 0;
  smsList = null; threads = []; currentThread = null; contactsCache = null; contactNames = new Map(); callsCache = null;
  debloat = { ...debloat, phone: null };
  resetMedia();
  setCallAlertState("off");
}
function setConnected(on) {
  $("connectBtn").hidden = on; $("disconnectBtn").hidden = !on;
  if (wadbApi) $("wifiConnectBtn").hidden = on;
  $("intro").hidden = on; $("overview").hidden = !on;
  if (current === "overview") setTitle("overview");
  for (const b of $("nav").querySelectorAll("button[data-view]")) if (b.dataset.view !== "overview" && !offlineViews[b.dataset.view]) b.disabled = !on;
}

// ---------- overview ----------
$("refreshInfo").addEventListener("click", () => loadOverview().catch(showError));
async function loadOverview() {
  if (!adb) return;
  const props = {};
  for (const line of (await sh("getprop")).split("\n")) {
    const m = line.match(/^\[(.+?)\]: \[(.*)\]$/); if (m) props[m[1]] = m[2];
  }
  const [battery, size, density, df, uptime] = await Promise.all([
    sh("dumpsys battery").catch(() => ""),
    sh("wm size").catch(() => ""),
    sh("wm density").catch(() => ""),
    sh("df -k /data").catch(() => ""),
    sh("cat /proc/uptime").catch(() => ""),
  ]);
  const level = battery.match(/level:\s*(\d+)/)?.[1];
  const status = { 2: "Charging", 3: "Discharging", 4: "Not charging", 5: "Full" }[battery.match(/status:\s*(\d+)/)?.[1]] || "";
  const temp = battery.match(/temperature:\s*(\d+)/)?.[1];
  const res = (size.match(/Override size:\s*(\S+)/) || size.match(/Physical size:\s*(\S+)/))?.[1];
  const dpi = (density.match(/Override density:\s*(\d+)/) || density.match(/Physical density:\s*(\d+)/))?.[1];
  const dfCols = df.trim().split("\n").pop()?.trim().split(/\s+/) || [];
  const total = Number(dfCols[1]) * 1024, used = Number(dfCols[2]) * 1024;
  const up = Number(uptime.split(" ")[0]);

  $("devName").textContent = `${props["ro.product.manufacturer"] || ""} ${props["ro.product.model"] || adb.serial}`.trim();
  const items = [
    ["Android version", `${props["ro.build.version.release"] || "?"} (API ${props["ro.build.version.sdk"] || "?"})`],
    ["Security patch", props["ro.build.version.security_patch"] || "—"],
    ["Brand / device", `${props["ro.product.brand"] || "?"} / ${props["ro.product.device"] || "?"}`],
    ["CPU ABI", props["ro.product.cpu.abi"] || "—"],
    ["Serial", adb.serial],
    ["Screen", res ? `${res}${dpi ? ` @ ${dpi} dpi` : ""}` : "—"],
    ["Battery", level ? `${level}%${status ? " · " + status : ""}${temp ? ` · ${(temp / 10).toFixed(1)}°C` : ""}` : "—", level ? level / 100 : null],
    ["Storage (/data)", total ? `${fmtSize(used)} of ${fmtSize(total)} used` : "—", total ? used / total : null],
    ["Uptime", isFinite(up) ? `${Math.floor(up / 86400)}d ${Math.floor(up % 86400 / 3600)}h ${Math.floor(up % 3600 / 60)}m` : "—"],
    ["Build", props["ro.build.display.id"] || "—"],
  ];
  $("ovHero").replaceChildren(
    heroCard("Battery", ICON_BOLT, level, "%", level ? status || "Charge level" : "Unknown", level ? level / 100 : null,
      temp ? `${(temp / 10).toFixed(1)}°C` : "—", "temperature"),
    heroCard("Storage", ICON_SD, total ? Math.round(used / total * 100) : null, "%", total ? `used of ${fmtSize(total)}` : "Unknown", total ? used / total : null,
      total ? fmtSize(total - used) : "—", "free"),
  );
  // Chips under the name: what people check first.
  const via = phoneVia.get(adb) === "wifi" ? "Wi‑Fi" : "USB";
  $("devChips").replaceChildren(...[
    `Android ${props["ro.build.version.release"] || "?"}`, via,
    isFinite(up) ? `On for ${Math.floor(up / 86400)}d ${Math.floor(up % 86400 / 3600)}h` : "",
  ].filter(Boolean).map((t) => el("span", { className: "chip", textContent: t })));
  // The details as a compact list; click a row to copy its value.
  const grid = $("infoGrid"); grid.replaceChildren();
  for (const [k, v] of items.filter(([k]) => k !== "Battery" && k !== "Storage (/data)")) {
    const row = el("button", { type: "button", title: "Click to copy" }, el("span", { className: "k", textContent: k }), el("span", { className: "v", textContent: v }));
    row.onclick = () => navigator.clipboard.writeText(String(v)).then(() => toast(`${k} copied`), () => {});
    grid.append(row);
  }
  renderQuick();
}

// Shortcuts on the Overview: the tools people open most, one click away. Icons are the sidebar's own.
const QUICK = [
  ["mirror", "Screen mirror", "See and use the phone here"], ["screen", "Screenshot", "Save what's on screen"],
  ["files", "Files", "Copy to and from the phone"], ["photos", "Photos", "Browse and back up"],
  ["apps", "Apps", "Install or remove"], ["messages", "Messages", "Read and reply"],
];
function renderQuick() {
  const box = $("ovQuick");
  if (box.childNodes.length) return;
  for (const [view, label, sub] of QUICK) {
    const icon = $("nav").querySelector(`[data-view="${view}"] svg`)?.cloneNode(true);
    const b = el("button", { type: "button" }, ...(icon ? [icon] : []), el("span", {}, label, el("small", { textContent: sub })));
    b.onclick = () => show(view);
    box.append(b);
  }
}

// ---------- phone RAM manager (the companion's Memory screen, with ADB rights) ----------
// Android only lets an app see and stop its own processes. Andromon can start a small helper from
// the companion's APK as the shell user (ShellHelper.kt, like Shizuku): the companion's RAM manager
// then lists running apps and stops them, until the phone restarts, even without the cable.
const RAM_HELPER_CLASS = "dev.andromon.companion.ShellHelper";
const RAM_HELPER_SOCKET = "andromon_helper";
const RAM_HELPER_MIN_COMPANION = 18; // first companion version with ShellHelper
const RAM_AUTO_KEY = "andromon-ram-helper-auto";
const ramAuto = () => { try { return localStorage.getItem(RAM_AUTO_KEY) === "1"; } catch { return false; } };

async function ramHelperRunning() {
  return /@andromon_helper\b/.test(await sh("cat /proc/net/unix").catch(() => ""));
}
async function companionVersionOnPhone() {
  const path = (await sh(`pm path ${COMPANION_PKG}`)).trim().split("\n")[0] || "";
  if (!path.startsWith("package:")) return { version: 0 };
  const version = Number((await sh(`dumpsys package ${COMPANION_PKG}`)).match(/versionCode=(\d+)/)?.[1] || 0);
  return { version, apk: path.slice(8).trim() };
}
async function startRamHelper() {
  const { version, apk } = await companionVersionOnPhone();
  if (version < RAM_HELPER_MIN_COMPANION) throw new Error("The companion app on the phone is too old for the RAM manager. Update it first.");
  // setsid + redirects: it keeps running after this shell (and the cable) goes away.
  await sh(`CLASSPATH=${shQuote(apk)} setsid app_process /system/bin --nice-name=${RAM_HELPER_SOCKET} ${RAM_HELPER_CLASS} </dev/null >/dev/null 2>&1 &`);
  for (let i = 0; i < 15; i++) { if (await ramHelperRunning()) return; await wait(200); }
  throw new Error("The RAM manager helper didn't start on the phone.");
}
async function stopRamHelper() {
  const socket = await adb.createSocket(`localabstract:${RAM_HELPER_SOCKET}`);
  try {
    const w = socket.writable.getWriter();
    await w.write(new TextEncoder().encode("exit\n")); w.releaseLock();
  } finally { await socket.close().catch(() => {}); }
  for (let i = 0; i < 10 && await ramHelperRunning(); i++) await wait(200);
}
async function autoStartRamHelper() {
  if (!ramAuto()) return;
  try {
    if (await ramHelperRunning()) return;
    if ((await companionVersionOnPhone()).version < RAM_HELPER_MIN_COMPANION) return;
    await startRamHelper();
    toast("Phone RAM manager turned on");
    if (current === "shizuku") renderRamCard().catch(() => {});
  } catch (e) { console.warn("RAM manager auto-start:", e); }
}

async function renderRamCard() {
  const box = $("ramCard");
  if (!adb) { box.hidden = true; return; }
  const [{ version }, running] = await Promise.all([companionVersionOnPhone(), ramHelperRunning()]);
  box.hidden = false;
  const status = el("span", { className: "muted small" });
  let main;
  if (version < RAM_HELPER_MIN_COMPANION) {
    main = actionBtn(version ? "Update companion" : "Install companion", version ? "Updating…" : "Installing…", async () => {
      companionInfo = await ensureCompanion((m) => { status.textContent = m; });
      status.textContent = ""; await renderRamCard();
    });
  } else if (running) {
    main = actionBtn("Turn off", "Turning off…", async () => { await stopRamHelper(); toast("Phone RAM manager turned off"); await renderRamCard(); });
  } else {
    main = actionBtn("Turn on", "Turning on…", async () => {
      await startRamHelper(); toast("Phone RAM manager is on: open Memory in the companion app"); await renderRamCard();
    });
    main.classList.add("primary");
  }
  const state = version < RAM_HELPER_MIN_COMPANION ? ["Needs the companion app", "neutral"]
    : running ? ["On until the phone restarts", "on"] : ["Off", "neutral"];
  box.replaceChildren(
    el("div", { className: "toolbar", style: "justify-content:space-between;margin-bottom:8px" },
      el("h2", { style: "margin:0", textContent: "Phone RAM manager" }),
      el("span", { className: `badge ${state[1]}`, textContent: state[0] })),
    el("p", { className: "muted", style: "margin:0 0 12px", textContent:
      "Lets the companion app's Memory screen list the apps in memory and stop them, the way App Manager does with ADB. " +
      "Andromon starts a small helper on the phone with ADB rights. It can only list processes, stop apps and free memory, " +
      "only the companion app can use it, and it keeps working after you unplug, until the phone restarts." }),
    el("div", { className: "toolbar", style: "margin:0" }, main,
      el("span", { className: "muted small", textContent: ramAuto() ? "Turns on by itself when a phone connects." : "" }),
      status),
  );
}

// Icons are Lucide (lucide.dev, ISC License): outlines, stroked by the stylesheet. An icon is a list of path strings.
const svgIcon = (paths) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); for (const d of paths) { const p = document.createElementNS(s.namespaceURI, "path"); p.setAttribute("d", d); s.append(p); } return s; };
const ICON_BOLT = ["M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"];
const ICON_SD = ["M10 16h.01", "M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z", "M21.946 12.013H2.054", "M6 16h.01"];
/** Pastel card with a big number and a ring, as on the companion's home screen. */
function heroCard(label, icon, value, unit, sub, frac, ringValue, ringLabel) {
  const ring = el("div", { className: "ring" }, el("div", {}, el("b", { textContent: ringValue }), el("span", { textContent: ringLabel })));
  ring.style.setProperty("--p", frac != null && isFinite(frac) ? Math.min(1, frac) : 0);
  return el("div", { className: "card" },
    el("div", {}, el("div", { className: "what" }, svgIcon(icon), label),
      el("div", { className: "big" }, value != null ? String(value) : "—", el("small", { textContent: value != null ? unit : "" })),
      el("div", { className: "sub", textContent: sub })),
    ring);
}

// ---------- apps ----------
let appScope = "-3", apps = [], disabledSet = new Set(), selectedApp = null;
$("appScope").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  appScope = b.dataset.scope;
  for (const x of $("appScope").children) x.classList.toggle("on", x === b);
  loadApps().catch(showError);
});
$("refreshApps").addEventListener("click", () => loadApps().catch(showError));
// Every app's cache, private ones included. Apps on the phone can only clear caches on shared
// storage; the adb shell may ask Android to trim them all (apps rebuild what they need).
armedClick($("trimCaches"), async () => {
  const btn = $("trimCaches");
  busy(btn, true, "Clearing…");
  try {
    const free = async () => Number((await sh("df -k /data")).trim().split("\n").pop().trim().split(/\s+/)[3]) * 1024;
    const before = await free();
    const out = (await sh("pm trim-caches 999999999999 2>&1")).trim();
    if (/exception|error|denied|unknown/i.test(out)) throw new Error("Couldn't clear app caches: " + out);
    const after = await free();
    toast(isFinite(after - before) ? `App caches cleared · ${fmtSize(Math.max(0, after - before))} freed` : "App caches cleared");
  } catch (e) {
    showError(e);
  } finally {
    busy(btn, false);
  }
});
$("appSearch").addEventListener("input", renderApps);

const pkgLines = (out) => out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice(8));

// ---- app icons and names ----
// ADB can list packages but can't draw icons, so they come from the companion ("apps.icons"),
// asked for in batches as rows scroll into view. Without the companion, rows show a letter instead.
const appMeta = new Map(); // pkg -> { label, icon } (icon: data URL or "")
const iconWant = new Map(); // pkg -> [refs] waiting for that package
const iconRefs = new WeakMap(); // icon element -> { icon, name, sub }
let iconSource = null, iconCheck = null; // iconSource: null (not checked) | "ready" | "missing" | "outdated"
let iconTimer = null, iconBusy = false;
const ICON_HINT_OFF = "andromon-icon-hint-off";

const appInitial = (pkg) => (pkg.split(".").pop() || pkg).charAt(0).toUpperCase();

const iconObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    iconObserver.unobserve(e.target);
    const refs = iconRefs.get(e.target), pkg = e.target.dataset.pkg;
    if (!refs || !pkg) continue;
    if (appMeta.has(pkg)) { paintApp(refs, pkg); continue; }
    if (!iconWant.has(pkg)) iconWant.set(pkg, []);
    iconWant.get(pkg).push(refs);
  }
  if (iconWant.size && !iconTimer) iconTimer = setTimeout(pumpIcons, 30);
}, { rootMargin: "300px" });

function paintApp(refs, pkg) {
  const m = appMeta.get(pkg);
  if (!m) return;
  if (m.icon) { refs.icon.replaceChildren(el("img", { src: m.icon, alt: "" })); refs.icon.classList.add("has-img"); }
  if (m.label && m.label !== pkg) { refs.name.textContent = m.label; refs.name.classList.remove("mono"); refs.sub.hidden = false; }
}

// An app's icon, name and package. Until the name arrives, the package name stands in for it.
function appIdent(pkg, { onClick, large = false, badges = [] } = {}) {
  const icon = el("span", { className: "appicon" + (large ? " lg" : ""), textContent: appInitial(pkg) });
  const name = onClick
    ? el("button", { className: "link mono appname", type: "button", textContent: pkg, onclick: onClick })
    : el("span", { className: "mono appname", textContent: pkg });
  const sub = el("div", { className: "mono appsub", textContent: pkg, hidden: true });
  const refs = { icon, name, sub };
  if (appMeta.has(pkg)) paintApp(refs, pkg);
  else if (iconSource === "ready") { icon.dataset.pkg = pkg; iconRefs.set(icon, refs); iconObserver.observe(icon); }
  return el("div", { className: "appident" + (large ? " lg" : "") }, icon,
    el("div", { className: "appwho" }, el("div", { className: "appline" }, name, ...badges), sub));
}

async function pumpIcons() {
  iconTimer = null;
  if (iconBusy || !adb) return;
  iconBusy = true;
  const phone = adb;
  try {
    while (iconWant.size && adb === phone && iconSource === "ready") {
      const batch = [...iconWant.keys()].slice(0, 40);
      let got;
      try { got = await cc("apps.icons", { pkgs: batch, size: 96 }); }
      catch (e) {
        // Leave the letters in place; the rows ask again the next time the list is drawn.
        console.warn("App icons:", e);
        for (const pkg of batch) iconWant.delete(pkg);
        if (/Unknown method/.test(e?.message)) { iconSource = "outdated"; renderIconHint(); }
        else iconSource = iconCheck = null; // check the companion again next time
        break;
      }
      if (adb !== phone) break;
      for (const pkg of batch) {
        const waiting = iconWant.get(pkg) || []; iconWant.delete(pkg);
        const r = got?.[pkg];
        appMeta.set(pkg, { label: r?.label || "", icon: r?.icon ? `data:image/png;base64,${r.icon}` : "" });
        for (const refs of waiting) paintApp(refs, pkg);
      }
    }
  } finally { iconBusy = false; }
}

// Is the companion there to draw icons? Checked once per connection.
function checkIconSource() {
  if (iconSource) return Promise.resolve(iconSource);
  iconCheck ??= (async () => {
    let st;
    if (companionInfo?.version >= COMPANION_VERSION) st = { state: "ready" };
    else st = await companionStatus().catch(() => ({ state: "missing" }));
    if (st.info) companionInfo = st.info;
    iconSource = st.state === "stopped" ? "ready" : st.state; // cc() starts a stopped companion
    return iconSource;
  })().finally(() => { iconCheck = null; });
  return iconCheck;
}

function renderIconHint() {
  const box = $("appIconHint");
  let off = false;
  try { off = localStorage.getItem(ICON_HINT_OFF) === "1"; } catch {}
  box.hidden = off || !(iconSource === "missing" || iconSource === "outdated");
  if (box.hidden) return;
  const update = iconSource === "outdated";
  const btn = el("button", { className: "btn sm", type: "button", textContent: update ? "Update companion" : "Install companion" });
  btn.onclick = async () => {
    busy(btn, true, update ? "Updating…" : "Installing…"); clearError();
    try {
      companionInfo = await ensureCompanion();
      iconSource = "ready"; renderIconHint(); renderApps();
      toast("Companion ready: loading app icons");
    } catch (e) { showError(e); }
    finally { if (btn.isConnected) busy(btn, false); }
  };
  const later = el("button", { className: "link muted", type: "button", textContent: "Not now" });
  later.onclick = () => { try { localStorage.setItem(ICON_HINT_OFF, "1"); } catch {} box.hidden = true; };
  box.replaceChildren(
    el("span", { textContent: update
      ? "Update the Andromon Companion on the phone to show app icons and names."
      : "App icons and names come from the Andromon Companion, a small helper app (about 200 KB) on the phone." }),
    btn, later);
}

function resetAppIcons() {
  appMeta.clear(); iconWant.clear(); iconSource = null; iconCheck = null;
}

async function loadApps() {
  if (!adb) return;
  $("appRows").replaceChildren(loadingRow(3, "Loading apps…"));
  const [out, dis] = await Promise.all([
    sh(`pm list packages --user 0 -f ${appScope}`),
    sh("pm list packages --user 0 -d").catch(() => ""),
    checkIconSource(),
  ]);
  renderIconHint();
  disabledSet = new Set(pkgLines(dis));
  // lines look like: package:/data/app/~~x==/com.foo-y==/base.apk=com.foo
  apps = pkgLines(out).map((s) => {
    const i = s.lastIndexOf("=");
    return { path: s.slice(0, i), pkg: s.slice(i + 1), version: null };
  }).sort((a, b) => a.pkg.localeCompare(b.pkg));
  renderApps();
}

function renderApps() {
  const q = $("appSearch").value.toLowerCase();
  const list = apps.filter((a) => a.pkg.toLowerCase().includes(q) || (appMeta.get(a.pkg)?.label || "").toLowerCase().includes(q));
  $("appCount").textContent = `${list.length} of ${apps.length} apps` + (disabledSet.size ? ` · ${disabledSet.size} disabled on phone` : "");
  const rows = list.map((a) => {
    const badges = disabledSet.has(a.pkg) ? [el("span", { className: "badge", textContent: "disabled" })] : [];
    const nameCell = el("td", {}, appIdent(a.pkg, { onClick: () => openAppDetail(a).catch(showError), badges }));
    const ver = el("td", { className: "muted hide-sm" });
    const verBtn = el("button", { className: "link muted", textContent: a.version ?? "show" });
    verBtn.onclick = async () => {
      verBtn.textContent = "…";
      const d = await sh(`dumpsys package ${shQuote(a.pkg)}`).catch(() => "");
      a.version = d.match(/versionName=(\S+)/)?.[1] || "?"; verBtn.textContent = a.version;
    };
    ver.append(verBtn);
    const open = actionBtn("Open", "…", () => launchApp(a));
    if (disabledSet.has(a.pkg)) open.disabled = true;
    const manage = el("button", { className: "btn sm", textContent: "Manage" });
    manage.onclick = () => openAppDetail(a).catch(showError);
    const tr = el("tr", {}, nameCell, ver, el("td", { className: "act" }, open, manage));
    if (selectedApp?.pkg === a.pkg) tr.classList.add("sel");
    return tr;
  });
  $("appRows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colSpan: 3, className: "empty", textContent: "No packages" }))]));
}

// A button that shows a busy label while `fn` runs; `confirm` makes it a two-click button.
function actionBtn(label, busyLabel, fn, opts = {}) {
  const b = el("button", { className: "btn sm" + (opts.danger ? " danger" : ""), textContent: label, type: "button" });
  const run = async () => {
    busy(b, true, busyLabel);
    try { await fn(); } catch (e) { showError(e); } finally { if (b.isConnected) busy(b, false); }
  };
  if (opts.confirm) armedClick(b, run); else b.onclick = run;
  return b;
}

// pm/am print errors to stdout; pull out the useful line.
function pmError(out) {
  return out.match(/(?:Exception|Error):\s*(.+)/)?.[1] || out.trim().split("\n")[0] || "Unknown error";
}

async function launchApp(a) {
  const out = await sh(`monkey -p ${shQuote(a.pkg)} -c android.intent.category.LAUNCHER 1`);
  if (/No activities found|monkey aborted/i.test(out)) throw new Error(`${a.pkg} has no launcher screen to open.`);
  toast(`Opened ${a.pkg} on the phone`);
}

function parsePackageDump(dump, pkg) {
  const start = dump.indexOf(`Package [${pkg}]`);
  let block = start >= 0 ? dump.slice(start) : "";
  const end = block.indexOf("\n\n"); if (end > 0) block = block.slice(0, end);
  const get = (re) => block.match(re)?.[1]?.trim();
  const perms = []; let inRuntime = false;
  for (const line of block.split("\n")) {
    if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
    if (!inRuntime) continue;
    const m = line.match(/^\s+([\w.]+): granted=(true|false)(?:, flags=\[\s*(.*?)\s*\])?/);
    if (m) perms.push({ name: m[1], granted: m[2] === "true", flags: m[3] || "" });
    else inRuntime = false;
  }
  return {
    versionName: get(/versionName=(\S+)/), versionCode: get(/versionCode=(\d+)/),
    minSdk: get(/minSdk=(\d+)/), targetSdk: get(/targetSdk=(\d+)/),
    firstInstall: get(/firstInstallTime=([^\n]+)/), lastUpdate: get(/lastUpdateTime=([^\n]+)/),
    installer: get(/installerPackageName=(\S+)/),
    enabledState: Number(get(/User 0:[^\n]*?enabled=(\d)/) ?? 0), // 2/3 = disabled
    system: /pkgFlags=\[[^\]]*\bSYSTEM\b/.test(block),
    perms,
  };
}

function makeSwitch(on, onToggle) {
  const s = el("button", { className: "switch", type: "button" });
  s.setAttribute("role", "switch");
  const set = (v) => s.setAttribute("aria-checked", String(!!v));
  set(on);
  s.onclick = async () => {
    const want = s.getAttribute("aria-checked") !== "true";
    s.disabled = true;
    try { const actual = await onToggle(want); set(actual ?? want); }
    catch (e) { showError(e); }
    finally { s.disabled = false; }
  };
  s.set = set;
  return s;
}
const statCard = (k, v) => el("div", { className: "stat" }, el("div", { className: "k", textContent: k }), el("div", { className: "v", textContent: v ?? "—" }));
const shortPerm = (p) => p.replace(/^android\.permission\./, "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

async function openAppDetail(a) {
  selectedApp = a; renderApps();
  const box = $("appDetail");
  box.hidden = false;
  box.replaceChildren(loadingBox(`Loading ${appMeta.get(a.pkg)?.label || a.pkg}…`));
  box.scrollIntoView({ block: "start", behavior: "smooth" });
  const info = parsePackageDump(await sh(`dumpsys package ${shQuote(a.pkg)}`), a.pkg);
  if (selectedApp !== a) return;
  if (info.versionName) a.version = info.versionName;
  const disabled = disabledSet.has(a.pkg) || info.enabledState === 2 || info.enabledState === 3;
  const refresh = () => openAppDetail(a).catch(showError);

  const close = el("button", { className: "btn sm", textContent: "Close", type: "button" });
  close.onclick = () => { box.hidden = true; selectedApp = null; renderApps(); };
  const badges = [];
  if (disabled) badges.push(el("span", { className: "badge", textContent: "disabled" }));
  if (info.system) badges.push(el("span", { className: "badge neutral", textContent: "system" }));
  const title = appIdent(a.pkg, { large: true, badges });
  const head = el("div", { className: "toolbar" }, title, el("span", { style: "flex:1" }), close);

  const stats = el("div", { className: "grid" },
    statCard("Version", info.versionName ? `${info.versionName}${info.versionCode ? ` (${info.versionCode})` : ""}` : null),
    statCard("Target / min SDK", info.targetSdk ? `API ${info.targetSdk} / ${info.minSdk ?? "?"}` : null),
    statCard("Installed", info.firstInstall),
    statCard("Updated", info.lastUpdate),
    statCard("Installed by", info.installer && info.installer !== "null" ? info.installer : "Unknown / sideloaded"),
  );

  const actions = el("div", { className: "toolbar", style: "margin-top:14px" },
    actionBtn("Open", "Opening…", () => launchApp(a)),
    actionBtn("Force stop", "Stopping…", async () => {
      await sh(`am force-stop ${shQuote(a.pkg)}`); toast(`Stopped ${a.pkg}`);
    }),
    actionBtn("Clear data", "Clearing…", async () => {
      const out = await sh(`pm clear ${shQuote(a.pkg)}`);
      if (!/Success/.test(out)) throw new Error(`Clear data failed: ${pmError(out)}`);
      toast(`Cleared all data for ${a.pkg}`);
    }, { danger: true, confirm: true }),
    disabled
      ? actionBtn("Enable", "Enabling…", async () => {
          const out = await sh(`pm enable ${shQuote(a.pkg)}`);
          if (!/new state/i.test(out)) throw new Error(`Enable failed: ${pmError(out)}`);
          disabledSet.delete(a.pkg); toast(`Enabled ${a.pkg}`); refresh();
        })
      : actionBtn("Disable", "Disabling…", async () => {
          const out = await sh(`pm disable-user --user 0 ${shQuote(a.pkg)}`);
          if (!/new state/i.test(out)) throw new Error(`Disable failed: ${pmError(out)}`);
          disabledSet.add(a.pkg); toast(`Disabled ${a.pkg} — it's hidden and can't run until re-enabled`); refresh();
        }, { danger: true, confirm: true }),
    actionBtn("Show on phone", "…", async () => {
      await sh(`am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d ${shQuote("package:" + a.pkg)}`);
      toast("Opened the app's settings page on the phone");
    }),
    actionBtn("Export APK", "Pulling…", () => exportApk(a)),
    actionBtn(info.system ? "Uninstall (for user)" : "Uninstall", "Removing…", async () => {
      await uninstall(a, info.system);
      box.hidden = true; selectedApp = null; renderApps();
    }, { danger: true, confirm: true }),
  );

  const permsTitle = el("h2", { textContent: `Runtime permissions (${info.perms.filter((p) => p.granted).length} of ${info.perms.length} granted)`, style: "margin-top:18px" });
  const perms = el("div", { className: "perms" });
  for (const p of info.perms) {
    const fixed = /SYSTEM_FIXED|POLICY_FIXED/.test(p.flags);
    const sw = makeSwitch(p.granted, async (on) => {
      const out = (await sh(`pm ${on ? "grant" : "revoke"} ${shQuote(a.pkg)} ${shQuote(p.name)}`)).trim();
      if (out) throw new Error(`Couldn't ${on ? "grant" : "revoke"} ${shortPerm(p.name)}: ${pmError(out)}`);
      p.granted = on; toast(`${on ? "Granted" : "Revoked"} ${shortPerm(p.name)}`);
      return on;
    });
    if (fixed) { sw.disabled = true; sw.title = "Fixed by the system or a device policy"; }
    perms.append(el("div", { className: "ctl" },
      el("div", {}, el("div", { textContent: shortPerm(p.name) }), el("div", { className: "sub mono", textContent: p.name })), sw));
  }
  if (!info.perms.length) perms.append(el("div", { className: "muted", textContent: "This app has no runtime permissions to manage." }));

  box.replaceChildren(head, stats, actions, permsTitle, perms);
}

async function exportApk(a) {
  const blob = await withSync((s) => readAll(s.read(a.path)));
  download(new Blob([blob], { type: "application/vnd.android.package-archive" }), `${a.pkg}.apk`);
  toast(`Saved ${a.pkg}.apk (${fmtSize(blob.size)})`);
}
async function uninstall(a, isSystem) {
  // System apps can't be removed without root; "--user 0" removes them for the current user only
  // (restore later with: cmd package install-existing <pkg>).
  const out = (await sh(`pm uninstall ${isSystem ? "--user 0 " : ""}${shQuote(a.pkg)}`)).trim();
  if (!/Success/.test(out)) throw new Error(`Uninstall failed: ${pmError(out)}`);
  toast(`Uninstalled ${a.pkg}`);
  apps = apps.filter((x) => x !== a); renderApps();
}

// ---------- install: preview first, then install (single APK or split bundle) ----------
// Accepts .apk, several split .apk files at once, or .apks / .xapk / .apkm bundles.
// The app's details are read from the file itself (src/apk.js) and shown before anything is installed.
const drop = $("apkDrop");
const dropIdle = () => drop.replaceChildren("Drop an ", el("b", { textContent: ".apk" }), " or a split bundle (", el("b", { textContent: ".apks / .xapk / .apkm" }), ") here, or click to choose");
dropIdle();
drop.addEventListener("click", () => $("apkInput").click());
$("apkInput").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) previewInstall(f); });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault(); drop.classList.remove("over");
  const files = [...e.dataTransfer.files];
  if (files.length) previewInstall(files);
});

let deviceFacts = null; // { sdk, abis[] } for the connected phone
async function getDeviceFacts() {
  if (deviceFacts?.serial === adb.serial) return deviceFacts;
  const [sdk, abilist, abi] = await Promise.all([sh("getprop ro.build.version.sdk"), sh("getprop ro.product.cpu.abilist"), sh("getprop ro.product.cpu.abi")]);
  const abis = abilist.trim() ? abilist.trim().split(",") : [abi.trim()].filter(Boolean);
  return (deviceFacts = { serial: adb.serial, sdk: Number(sdk.trim()) || 0, abis });
}

let pendingInstall = null;
async function previewInstall(files) {
  if (!adb) return;
  clearError();
  const box = $("installPreview");
  drop.textContent = `Reading ${files.length === 1 ? files[0].name : files.length + " files"}…`;
  let pkg;
  try {
    pkg = await openPackageFiles(files);
  } catch (e) { dropIdle(); return showError(e); }
  dropIdle();
  const dev = await getDeviceFacts();
  const { info } = pkg;
  const pick = selectSplits(pkg.parts, dev.abis);
  pendingInstall = { pkg, pick };

  // What's on the phone now?
  let installed = null;
  if (info.package) {
    const d = await sh(`dumpsys package ${shQuote(info.package)}`).catch(() => "");
    const p = parsePackageDump(d, info.package);
    if (p.versionCode) installed = { versionName: p.versionName, versionCode: Number(p.versionCode) };
  }
  // Single APKs carry their own native libraries; check them against the phone's CPU too.
  const libAbis = pkg.parts.length === 1 ? pkg.parts[0].abis : [];
  const abiMismatch = libAbis.length > 0 && !libAbis.some((a) => dev.abis.includes(a));

  const warnings = [];
  if (info.minSdk && dev.sdk && info.minSdk > dev.sdk) warnings.push(`Needs Android API ${info.minSdk}; this phone has API ${dev.sdk}. The install will fail.`);
  if (pick.needsAbi || abiMismatch) warnings.push(`Built for ${(libAbis.length ? libAbis : pick.skipped.map((p) => p.split)).join(", ")}; this phone's CPU is ${dev.abis.join(", ")}. The install will probably fail.`);
  if (installed && info.versionCode != null && info.versionCode < installed.versionCode) warnings.push(`This is older than the installed version (${installed.versionName || installed.versionCode}). Android refuses downgrades; uninstall the app first (which deletes its data).`);
  if (info.targetSdk && dev.sdk >= 34 && info.targetSdk < 23) warnings.push(`Targets a very old Android version (API ${info.targetSdk}); Android 14+ blocks installing it.`);

  const icon = el("div", { className: "app-icon" });
  if (info.icon) { const img = el("img", { alt: "" }); img.src = URL.createObjectURL(info.icon); img.onload = () => URL.revokeObjectURL(img.src); icon.append(img); }
  else icon.textContent = (info.label || info.package || "?").trim().charAt(0).toUpperCase();

  const title = el("div", { style: "min-width:0;flex:1" },
    el("h2", { textContent: info.label || info.package || "Unknown app", style: "margin:0" }),
    el("div", { className: "mono muted", textContent: info.package || "" }));
  const head = el("div", { className: "toolbar", style: "align-items:center" }, icon, title);

  const verText = `${info.versionName || "?"}${info.versionCode != null ? ` (${info.versionCode})` : ""}`;
  const stats = el("div", { className: "grid" },
    statCard("Version", verText),
    statCard("On the phone", installed ? `${installed.versionName || "?"} (${installed.versionCode}) → ${installed.versionCode === info.versionCode ? "reinstall" : installed.versionCode < (info.versionCode ?? 0) ? "update" : "downgrade"}` : "Not installed"),
    statCard("Needs", info.minSdk ? `Android API ${info.minSdk}+` : null),
    statCard("Targets", info.targetSdk ? `API ${info.targetSdk}` : null),
    statCard("Files", pkg.parts.length > 1
      ? `${pick.chosen.length} of ${pkg.parts.length} splits${pick.abi ? ` · ${pick.abi}` : ""} · ${fmtSize(pick.chosen.reduce((n, p) => n + p.size, 0))}`
      : `${pkg.sourceName} · ${fmtSize(pkg.parts[0].size)}`),
  );
  if (pkg.obb.length) stats.append(statCard("Game data (OBB)", `${pkg.obb.length} file${pkg.obb.length > 1 ? "s" : ""} · ${fmtSize(pkg.obb.reduce((n, o) => n + o.bytes.byteLength, 0))}`));

  const warnBox = el("div");
  for (const w of warnings) warnBox.append(el("div", { className: "notice", textContent: w, style: "margin:12px 0 0" }));

  const perms = info.permissions.map((p) => ({ full: p, short: p.replace(/^android\.permission\./, "") }));
  const sensitive = perms.filter((p) => p.full.startsWith("android.permission.") && SENSITIVE_PERMISSIONS.has(p.short));
  const permBox = el("details", { style: "margin-top:14px" },
    el("summary", { textContent: `${perms.length} permission${perms.length === 1 ? "" : "s"}${sensitive.length ? ` · ${sensitive.length} sensitive` : ""}` }));
  const chips = el("div", { className: "chips" });
  for (const p of [...sensitive, ...perms.filter((p) => !sensitive.includes(p))]) {
    chips.append(el("span", { className: "chip" + (sensitive.includes(p) ? " warn" : ""), textContent: p.full.startsWith("android.permission.") ? shortPerm(p.full) : p.full, title: p.full }));
  }
  permBox.append(chips);

  const cancel = el("button", { className: "btn", textContent: "Cancel", type: "button" });
  cancel.onclick = () => { box.hidden = true; pendingInstall = null; };
  const go = el("button", { className: "btn primary", textContent: installed ? (installed.versionCode === info.versionCode ? "Reinstall" : "Update") : "Install", type: "button" });
  go.onclick = async () => {
    const job = pendingInstall; if (!job) return;
    busy(go, true, "Installing…"); cancel.disabled = true;
    const bar = createProgress({ el, fmtSize });
    go.parentElement.before(bar.node); bar.node.style.marginTop = "14px";
    try { await runInstall(job, (t, done, total) => bar.update(t, done, total)); box.hidden = true; pendingInstall = null; }
    catch (e) { showError(e); }
    finally { bar.node.remove(); if (go.isConnected) { busy(go, false); cancel.disabled = false; } }
  };
  box.replaceChildren(head, stats, warnBox, permBox, el("div", { className: "toolbar", style: "margin:16px 0 0" }, go, cancel));
  box.hidden = false;
  box.scrollIntoView({ block: "start", behavior: "smooth" });
}

async function runInstall({ pkg, pick }, progress) {
  const dir = `/data/local/tmp/andromon-${Date.now()}`;
  const parts = pick.chosen;
  const label = pkg.info.label || pkg.info.package;
  try {
    await sh(`mkdir -p ${shQuote(dir)}`);
    const remote = [];
    // progress(text, done, total): the bytes copied to the phone so far, for the progress bar.
    const upTotal = parts.reduce((n, p) => n + (p.bytes?.byteLength ?? p.size ?? 0), 0);
    let up = 0;
    for (const [i, p] of parts.entries()) {
      const what = `Copying ${label} to the phone${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ""}`;
      progress(what, up, upTotal);
      const path = `${dir}/${i}.apk`;
      await withSync((s) => s.write({ filename: path, file: countBytes(new Blob([p.bytes]).stream(), (b) => { up += b; progress(what, up, upTotal); }), permission: 0o644 }));
      remote.push({ path, size: p.size, name: `${i}_${(p.split || "base").replace(/[^\w.-]/g, "_")}` });
    }
    progress(`Installing ${label}…`);
    if (remote.length === 1) {
      const out = (await sh(`pm install -r ${shQuote(remote[0].path)}`)).trim();
      if (!/Success/.test(out)) throw new Error(`Install failed: ${out}`);
    } else {
      // Split APKs go in one install session (the same thing `adb install-multiple` does).
      const total = remote.reduce((n, r) => n + r.size, 0);
      const created = await sh(`pm install-create -r -S ${total}`);
      const session = created.match(/\[(\d+)\]/)?.[1];
      if (!session) throw new Error(`Install failed: ${created.trim()}`);
      try {
        for (const r of remote) {
          const out = await sh(`pm install-write -S ${r.size} ${session} ${shQuote(r.name)} ${shQuote(r.path)}`);
          if (!/Success/i.test(out)) throw new Error(`Install failed while copying ${r.name}: ${out.trim()}`);
        }
        const out = (await sh(`pm install-commit ${session}`)).trim();
        if (!/Success/.test(out)) throw new Error(`Install failed: ${out}`);
      } catch (e) {
        sh(`pm install-abandon ${session}`).catch(() => {});
        throw e;
      }
    }
    // Game data that ships next to the app (.xapk): Android/obb/<package>/...
    const obbTotal = pkg.obb.reduce((n, o) => n + (o.bytes?.byteLength ?? 0), 0);
    let obbDone = 0;
    for (const [i, o] of pkg.obb.entries()) {
      const rel = o.path.split("/").filter((x) => x && x !== "." && x !== "..").join("/");
      if (!/^Android\/obb\//i.test(rel)) continue;
      const what = `Copying game data${pkg.obb.length > 1 ? ` (${i + 1} of ${pkg.obb.length})` : ""}`;
      progress(what, obbDone, obbTotal);
      const target = "/sdcard/" + rel;
      await sh(`mkdir -p ${shQuote(target.replace(/\/[^/]+$/, ""))}`);
      await withSync((s) => s.write({ filename: target, file: countBytes(new Blob([o.bytes]).stream(), (b) => { obbDone += b; progress(what, obbDone, obbTotal); }), permission: 0o660 }));
    }
    toast(`Installed ${label}`);
    loadApps().catch(showError);
  } finally {
    sh(`rm -rf ${shQuote(dir)}`).catch(() => {});
  }
}

// ---------- files ----------
// The Files page lives in ./files.js (set up at the end of this file).
let filesTab = null;

// ---------- controls (quick toggles) ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const getSetting = async (ns, key) => (await sh(`settings get ${ns} ${key}`)).trim();
const putSetting = (ns, key, v) => sh(`settings put ${ns} ${key} ${shQuote(String(v))}`);
const truthy = (v) => v !== "" && v !== "0" && v !== "0.0" && v !== "null";

// Each toggle: how to read its state and how to set it. `cmd ... || svc ...` falls back for older Android.
const TOGGLES = [
  { group: "Connectivity", label: "Wi‑Fi",
    read: async () => {
      const s = await sh("cmd wifi status 2>/dev/null").catch(() => "");
      const m = s.match(/Wifi is (enabled|disabled)/i);
      return m ? m[1].toLowerCase() === "enabled" : ["1", "2"].includes(await getSetting("global", "wifi_on"));
    },
    set: (on) => sh(`cmd wifi set-wifi-enabled ${on ? "enabled" : "disabled"} || svc wifi ${on ? "enable" : "disable"}`) },
  { group: "Connectivity", label: "Mobile data",
    read: async () => (await getSetting("global", "mobile_data")) === "1",
    set: (on) => sh(`svc data ${on ? "enable" : "disable"}`) },
  { group: "Connectivity", label: "Bluetooth",
    read: async () => (await getSetting("global", "bluetooth_on")) === "1",
    set: (on) => sh(`cmd bluetooth_manager ${on ? "enable" : "disable"} || svc bluetooth ${on ? "enable" : "disable"}`) },
  { group: "Connectivity", label: "Airplane mode",
    read: async () => (await getSetting("global", "airplane_mode_on")) === "1",
    set: (on) => sh(`cmd connectivity airplane-mode ${on ? "enable" : "disable"}`) },
  { group: "Connectivity", label: "Location",
    read: async () => truthy(await getSetting("secure", "location_mode")),
    set: (on) => sh(`cmd location set-location-enabled ${on}`) },

  { group: "Display", label: "Dark theme",
    read: async () => /yes/i.test(await sh("cmd uimode night")),
    set: (on) => sh(`cmd uimode night ${on ? "yes" : "no"}`) },
  { group: "Display", label: "Auto-rotate",
    read: async () => (await getSetting("system", "accelerometer_rotation")) === "1",
    set: (on) => putSetting("system", "accelerometer_rotation", on ? 1 : 0) },
  { group: "Display", label: "Auto brightness",
    read: async () => (await getSetting("system", "screen_brightness_mode")) === "1",
    set: (on) => putSetting("system", "screen_brightness_mode", on ? 1 : 0) },
  { group: "Display", label: "Animations", sub: "Off makes the phone feel snappier",
    read: async () => truthy(await getSetting("global", "window_animation_scale")),
    set: (on) => Promise.all(["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]
      .map((k) => putSetting("global", k, on ? 1 : 0))) },
  { group: "Display", label: "Show taps", sub: "Draws a dot where you touch",
    read: async () => (await getSetting("system", "show_touches")) === "1",
    set: (on) => putSetting("system", "show_touches", on ? 1 : 0) },

  { group: "System", label: "Do Not Disturb",
    read: async () => truthy(await getSetting("global", "zen_mode")),
    set: (on) => sh(`cmd notification set_dnd ${on ? "on" : "off"}`) },
  { group: "System", label: "Stay awake while charging",
    read: async () => truthy(await getSetting("global", "stay_on_while_plugged_in")),
    set: (on) => sh(`svc power stayon ${on ? "true" : "false"}`) },
];

const TIMEOUTS = [[15e3, "15 seconds"], [30e3, "30 seconds"], [60e3, "1 minute"], [120e3, "2 minutes"], [300e3, "5 minutes"], [600e3, "10 minutes"], [1800e3, "30 minutes"]];
const FONT_SCALES = [["0.85", "Small"], ["1.0", "Default"], ["1.15", "Large"], ["1.3", "Largest"]];

let controls = null; // DOM refs, built once
$("refreshControls").addEventListener("click", () => refreshControls().catch(showError));

async function loadControls() {
  if (!adb) return;
  if (!controls) buildControls();
  await refreshControls();
}

const ctlRow = (label, sub, control) =>
  el("div", { className: "ctl" }, el("div", {}, el("div", { textContent: label }), sub ? el("div", { className: "sub", textContent: sub }) : ""), control);

function buildControls() {
  controls = { switches: [] };
  const root = $("controlsRoot"); root.replaceChildren();
  const groups = {};
  const card = (name) => {
    if (!groups[name]) {
      const grid = el("div", { className: "ctl-grid" });
      root.append(el("div", { className: "card" }, el("h2", { textContent: name }), grid));
      groups[name] = grid;
    }
    return groups[name];
  };

  for (const t of TOGGLES) {
    const sw = makeSwitch(false, async (want) => {
      const out = await t.set(want);
      // Some settings apply asynchronously (radios); poll briefly for the new state.
      let actual;
      for (let i = 0; i < 5; i++) { await wait(i ? 600 : 250); actual = await t.read(); if (actual === want) break; }
      if (actual !== want) {
        const detail = typeof out === "string" && out.trim() ? ` Phone said: ${pmError(out)}` : "";
        showError(`${t.label} didn't change.${detail} Some phones (e.g. Xiaomi) need "USB debugging (Security settings)" turned on in Developer options.`);
      } else { clearError(); toast(`${t.label} ${want ? "on" : "off"}`); }
      if (t.label === "Auto brightness") refreshControls().catch(() => {});
      return actual;
    });
    controls.switches.push([t, sw]);
    card(t.group).append(ctlRow(t.label, t.sub, sw));
  }

  // Brightness
  const bright = el("input", { type: "range", min: 1, max: 255 });
  bright.addEventListener("change", async () => {
    try {
      await putSetting("system", "screen_brightness_mode", 0);
      await putSetting("system", "screen_brightness", bright.value);
      refreshControls().catch(() => {});
    } catch (e) { showError(e); }
  });
  controls.bright = bright;
  card("Display").append(ctlRow("Brightness", "Turns off auto brightness", bright));

  // Screen timeout
  const timeout = el("select");
  for (const [ms, label] of TIMEOUTS) timeout.append(el("option", { value: ms, textContent: label }));
  timeout.addEventListener("change", () => putSetting("system", "screen_off_timeout", timeout.value).then(() => toast("Screen timeout updated")).catch(showError));
  controls.timeout = timeout;
  card("Display").append(ctlRow("Screen timeout", "", timeout));

  // Font size
  const font = el("select");
  for (const [v, label] of FONT_SCALES) font.append(el("option", { value: v, textContent: label }));
  font.addEventListener("change", () => putSetting("system", "font_scale", font.value).then(() => toast("Font size updated")).catch(showError));
  controls.font = font;
  card("Display").append(ctlRow("Font size", "", font));

  // Media volume
  const vol = el("input", { type: "range", min: 0, max: 15 });
  vol.addEventListener("change", () => sh(`cmd media_session volume --stream 3 --set ${Number(vol.value)}`).catch(showError));
  controls.vol = vol; controls.volRow = ctlRow("Media volume", "", vol);
  card("System").append(controls.volRow);

  // Resolution & density
  const sizeIn = el("input", { type: "text", placeholder: "1080x2400", size: 10 });
  const dpiIn = el("input", { type: "number", placeholder: "420", min: 120, max: 960, style: "width:80px" });
  const apply = actionBtn("Apply", "…", async () => {
    if (sizeIn.value.trim()) {
      if (!/^\d{3,5}x\d{3,5}$/.test(sizeIn.value.trim())) throw new Error("Resolution must look like 1080x2400");
      await sh(`wm size ${sizeIn.value.trim()}`);
    }
    if (dpiIn.value) await sh(`wm density ${Math.round(Number(dpiIn.value))}`);
    toast("Display size updated"); await refreshControls();
  });
  const reset = actionBtn("Reset", "…", async () => {
    await sh("wm size reset"); await sh("wm density reset"); toast("Display size reset"); await refreshControls();
  });
  controls.displayInfo = el("div", { className: "sub" });
  const displayCard = el("div", { className: "card" },
    el("h2", { textContent: "Screen resolution & density" }),
    controls.displayInfo,
    el("div", { className: "toolbar", style: "margin:10px 0 0" }, sizeIn, dpiIn, apply, reset));
  controls.sizeIn = sizeIn; controls.dpiIn = dpiIn;
  root.append(displayCard);

  // Power
  const power = el("div", { className: "toolbar", style: "margin:0" },
    actionBtn("Wake screen", "…", () => sh("input keyevent KEYCODE_WAKEUP")),
    actionBtn("Lock screen", "…", () => sh("input keyevent KEYCODE_SLEEP")),
    actionBtn("Reboot", "Rebooting…", () => adb.power.reboot(), { danger: true, confirm: true }),
    actionBtn("Reboot to recovery", "Rebooting…", () => adb.power.recovery(), { danger: true, confirm: true }),
    actionBtn("Reboot to bootloader", "Rebooting…", () => adb.power.bootloader(), { danger: true, confirm: true }),
    actionBtn("Power off", "Shutting down…", () => adb.power.powerOff(), { danger: true, confirm: true }),
  );
  root.append(el("div", { className: "card" }, el("h2", { textContent: "Power" }), power));
}

async function refreshControls() {
  if (!adb || !controls) return;
  await Promise.all([
    ...controls.switches.map(async ([t, sw]) => {
      try { sw.set(await t.read()); sw.disabled = false; sw.title = ""; }
      catch { sw.disabled = true; sw.title = "Not supported on this phone"; }
    }),
    (async () => {
      const v = Number(await getSetting("system", "screen_brightness"));
      if (isFinite(v)) { controls.bright.max = Math.max(255, v); controls.bright.value = v; }
    })().catch(() => {}),
    (async () => {
      const v = await getSetting("system", "screen_off_timeout");
      if (![...controls.timeout.options].some((o) => o.value === v) && /^\d+$/.test(v))
        controls.timeout.append(el("option", { value: v, textContent: `${Math.round(v / 1000)} seconds` }));
      controls.timeout.value = v;
    })().catch(() => {}),
    (async () => {
      const v = Number(await getSetting("system", "font_scale")) || 1;
      const best = FONT_SCALES.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a));
      controls.font.value = best[0];
    })().catch(() => {}),
    (async () => {
      const out = await sh("cmd media_session volume --stream 3 --get");
      const m = out.match(/volume is (\d+) in range \[(\d+)\.\.(\d+)\]/);
      controls.volRow.hidden = !m;
      if (m) { controls.vol.min = m[2]; controls.vol.max = m[3]; controls.vol.value = m[1]; }
    })().catch(() => { controls.volRow.hidden = true; }),
    (async () => {
      const [size, density] = await Promise.all([sh("wm size"), sh("wm density")]);
      const ps = size.match(/Physical size:\s*(\S+)/)?.[1], os = size.match(/Override size:\s*(\S+)/)?.[1];
      const pd = density.match(/Physical density:\s*(\d+)/)?.[1], od = density.match(/Override density:\s*(\d+)/)?.[1];
      controls.displayInfo.textContent =
        `Physical: ${ps ?? "?"} @ ${pd ?? "?"} dpi` + (os || od ? ` · Current override: ${os ?? ps} @ ${od ?? pd} dpi` : " · No override");
      controls.sizeIn.placeholder = os ?? ps ?? "1080x2400";
      controls.dpiIn.placeholder = od ?? pd ?? "420";
    })().catch(() => {}),
  ]);
}

// ---------- companion app link ----------
// The companion (../android) runs a foreground service with an abstract Unix socket. We reach it
// through ADB with "localabstract:<name>" — over the USB cable only, nothing listens on Wi‑Fi.
// It only accepts connections from adbd (shell uid), so other apps on the phone can't use it.
const COMPANION_PKG = "dev.andromon.companion";
// The same app installed under the product's old name (Droid Desk Companion); replaced by the one above.
const LEGACY_COMPANION_PKG = "dev.droiddesk.companion";
const COMPANION_SOCKET = "andromon_companion";
const COMPANION_VERSION = 29; // keep in sync with versionCode in android/app/build.gradle.kts
let companionInfo = null;

class CompanionUnavailable extends Error {
  constructor(msg = "The companion app isn't running") { super(msg); }
}

function companionCall(method, params = {}) { return track(() => companionCallRaw(method, params)); }
async function companionCallRaw(method, params) {
  let socket;
  try { socket = await adb.createSocket(`localabstract:${COMPANION_SOCKET}`); }
  catch { throw new CompanionUnavailable(); }
  try {
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify({ id: 1, method, params }) + "\n"));
    writer.releaseLock();
    const text = await (await readAll(socket.readable)).text();
    if (!text.trim()) throw new CompanionUnavailable("The companion closed the connection");
    const resp = JSON.parse(text);
    if (resp.error) throw new Error(resp.error);
    return resp.result;
  } finally {
    try { await socket.close(); } catch {}
  }
}

// Call the companion, restarting it once if it stopped (it exits after 15 idle minutes).
async function cc(method, params) {
  try { return await companionCall(method, params); }
  catch (e) {
    if (!(e instanceof CompanionUnavailable)) throw e;
    companionInfo = await startCompanion(() => {});
    return companionCall(method, params);
  }
}

async function companionStatus() {
  try {
    const info = await companionCall("info");
    return { state: info.version >= COMPANION_VERSION ? "ready" : "outdated", info };
  } catch (e) { if (!(e instanceof CompanionUnavailable)) throw e; }
  const path = (await sh(`pm path ${COMPANION_PKG}`)).trim();
  if (!path.startsWith("package:")) return { state: "missing" };
  const v = Number((await sh(`dumpsys package ${COMPANION_PKG}`)).match(/versionCode=(\d+)/)?.[1] || 0);
  return { state: v >= COMPANION_VERSION ? "stopped" : "outdated" };
}

async function installCompanion(progress) {
  progress("Uploading companion app…");
  const res = await fetch("companion.apk");
  if (!res.ok) throw new Error("companion.apk is missing from this build of Andromon (run: npm run build:companion)");
  const apk = await res.blob();
  const tmp = "/data/local/tmp/andromon-companion.apk";
  await withSync((s) => s.write({ filename: tmp, file: apk.stream(), permission: 0o644 }));
  progress("Installing…");
  // -g grants the runtime permissions. Installing from adb also allow-lists the "restricted"
  // SMS / call-log permissions, which Android refuses for APKs installed by tapping.
  let out = await sh(`pm install -r -g ${tmp}`);
  if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) {
    // Built with a different signing key (e.g. another PC): replace it. The companion stores no data.
    await sh(`pm uninstall ${COMPANION_PKG}`);
    out = await sh(`pm install -r -g ${tmp}`);
  }
  sh(`rm -f ${tmp}`).catch(() => {});
  if (!/Success/.test(out)) {
    throw new Error(`Couldn't install the companion: ${pmError(out)}. On Xiaomi/Oppo/Vivo, turn on "Install via USB" in Developer options.`);
  }
  // The companion's Cleaner needs two special accesses that -g doesn't cover: "All files access"
  // (to find junk on shared storage / SD cards) and "Usage access" (to size app caches). Without
  // them the phone screen asks the person instead, so failures here are fine.
  await sh(`appops set --uid ${COMPANION_PKG} MANAGE_EXTERNAL_STORAGE allow`).catch(() => {});
  await sh(`appops set ${COMPANION_PKG} GET_USAGE_STATS allow`).catch(() => {});
  await sh(`appops set ${COMPANION_PKG} WRITE_SMS allow`).catch(() => {}); // Messages › Restore: only the default SMS app may write otherwise
  // Find my phone: its "Found it" screen may open over the lock screen (an app-op on Android 14+).
  await sh(`appops set ${COMPANION_PKG} USE_FULL_SCREEN_INTENT allow 2>/dev/null`).catch(() => {});
}

async function waitForCompanion(tries, gap) {
  for (let i = 0; i < tries; i++) {
    await wait(gap);
    try { return await companionCall("info"); } catch (e) { if (!(e instanceof CompanionUnavailable)) throw e; }
  }
  return null;
}

async function startCompanion(progress) {
  progress("Starting companion…");
  await sh(`am start-foreground-service -n ${COMPANION_PKG}/.CompanionService`).catch(() => {});
  let info = await waitForCompanion(8, 300);
  if (!info) {
    // Fallback: open the companion's screen; it starts the service from the foreground and hides itself.
    await sh(`am start -n ${COMPANION_PKG}/.MainActivity --ez autostart true`);
    info = await waitForCompanion(15, 400);
  }
  if (!info) throw new Error("The companion app didn't start. Open “Andromon Companion” on the phone once, then try again.");
  return info;
}

async function ensureCompanion(progress = () => {}) {
  const st = await companionStatus();
  if (st.state !== "ready" && st.state !== "stopped") await installCompanion(progress);
  const info = st.state === "ready" ? st.info : await startCompanion(progress);
  await removeLegacyCompanion(progress);
  return info;
}

// Takes the old Droid Desk Companion off the phone once Andromon Companion is there, so the phone
// doesn't run two copies (two notification listeners, two services, two sets of tiles). Checked when a
// phone connects and after the companion is installed; never leaves a phone without a companion.
const legacyChecked = new WeakSet();
async function removeLegacyCompanion(progress = () => {}) {
  if (!adb || legacyChecked.has(adb)) return;
  const installed = async (pkg) => (await sh(`pm path ${pkg}`).catch(() => "")).trim().startsWith("package:");
  if (!(await installed(LEGACY_COMPANION_PKG))) { legacyChecked.add(adb); return; }
  if (!(await installed(COMPANION_PKG))) return; // not yet: the old one stays until the new one is installed
  legacyChecked.add(adb);
  progress("Removing the old Droid Desk Companion…");
  await sh(`pkill -f '${LEGACY_COMPANION_PKG}.ShellHelpe[r]'; pm uninstall ${LEGACY_COMPANION_PKG}`).catch(() => {});
  toast("Removed the old Droid Desk Companion. Andromon Companion replaces it.");
}

// For features outside the companion's own tabs (backup, automatic photo copy): is the companion
// usable right now? Starts it when it is only stopped; never installs or updates it.
async function companionAvailable() {
  if (!adb) return false;
  if (companionInfo) return true;
  const st = await companionStatus();
  if (st.state === "ready") companionInfo = st.info;
  else if (st.state === "stopped") companionInfo = await startCompanion(() => {});
  return !!companionInfo;
}

const emptyBox = (text) => el("div", { className: "empty", textContent: text });

// Shows the panel's content once the companion is ready, or an install card if it isn't.
async function withCompanion(gate, main, load) {
  if (!adb) return;
  if (!companionInfo) {
    gate.hidden = false; main.hidden = true;
    gate.replaceChildren(loadingBox("Checking companion app…"));
    const st = await companionStatus();
    if (st.state === "ready") companionInfo = st.info;
    else if (st.state === "stopped") {
      gate.replaceChildren(loadingBox("Starting companion app on the phone…"));
      companionInfo = await startCompanion(() => {});
    } else return showCompanionGate(gate, main, st.state, load);
  }
  gate.hidden = true; main.hidden = false;
  await load();
}

function showCompanionGate(gate, main, state, load) {
  gate.hidden = false; main.hidden = true;
  const status = el("span", { className: "muted" });
  const btn = el("button", { className: "btn primary", type: "button", textContent: state === "outdated" ? "Update companion" : "Install companion" });
  btn.onclick = async () => {
    busy(btn, true, "Working…"); clearError();
    try {
      companionInfo = await ensureCompanion((m) => { status.textContent = m; });
      toast("Companion ready");
      await withCompanion(gate, main, load);
    } catch (e) { showError(e); status.textContent = ""; }
    finally { if (btn.isConnected) busy(btn, false); }
  };
  const li = (t) => el("li", { textContent: t });
  gate.replaceChildren(
    el("h2", { textContent: state === "outdated" ? "Update the Andromon Companion" : "This needs the Andromon Companion" }),
    el("p", { className: "muted", textContent: "Android only lets apps on the phone read messages, contacts, the call log and the photo/music library, so Andromon installs a small helper app (about 200 KB) over USB." }),
    el("ul", { className: "muted" },
      li("It talks to this computer over the USB cable only. No internet, no accounts. (Its optional Wi‑Fi receive is off unless you turn it on, on the phone.)"),
      li("It gets access to SMS, contacts, call log, calendar, photos, videos and music. You'll see a “Connected to Andromon” notification while it runs."),
      li("It stops by itself after 15 minutes without use. Remove it any time from the Apps tab.")),
    el("div", { className: "toolbar", style: "margin:12px 0 0" }, btn, status),
  );
}

function needPermission(key, what) {
  if (companionInfo?.permissions && companionInfo.permissions[key] === false) {
    throw new Error(`The companion doesn't have ${what} access. Remove “Andromon Companion” from the phone (Apps tab → dev.andromon.companion → Uninstall), then open this tab again so Andromon reinstalls it with access.`);
  }
}

// ---------- shared formatting / export helpers ----------
const stamp = () => new Date().toISOString().slice(0, 10);
const digits = (n) => String(n || "").replace(/\D/g, "").slice(-9);
function fmtDate(ms, full = false) {
  const d = new Date(Number(ms));
  if (!isFinite(d)) return "";
  const today = new Date().toDateString() === d.toDateString();
  if (full) return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return today ? d.toLocaleTimeString([], { timeStyle: "short" }) : d.toLocaleDateString([], { dateStyle: "medium" });
}
// csvCell, toCsv, xmlAttr, the vCard reader/writer and the backup file formats live in ./pdata.js
// (no DOM in there, so node can test them).

// ---------- contacts (shared by Messages for names) ----------
let contactsCache = null, contactNames = new Map();
function indexContactNames() {
  contactNames = new Map();
  for (const c of contactsCache || []) for (const p of c.phones) {
    const d = digits(p.number);
    if (d.length >= 6 && !contactNames.has(d)) contactNames.set(d, c.name);
  }
}
const nameFor = (addr) => contactNames.get(digits(addr)) || "";
async function fetchContacts() {
  contactsCache = await cc("contacts.list");
  indexContactNames();
}

// ---------- messages ----------
// SMS and MMS together, grouped by the phone's thread id. MMS (pictures, group texts) can be read
// and saved here; sending MMS is not supported, so a reply is always a plain SMS to one number.
let smsList = null, mmsList = [], mmsNote = "", threads = [], currentThread = null;
$("msgSearch").addEventListener("input", () => renderThreads());
$("msgReload").addEventListener("click", () => loadMessages(true).catch(showError));
$("msgNew").addEventListener("click", () => { currentThread = null; renderThreads(); renderNewMessage(); });
$("msgExportXml").addEventListener("click", () => {
  if (!smsList) return;
  const xml = buildSmsXml({ sms: smsList, mms: mmsList, nameFor, fmtDate: (d) => fmtDate(d, true) });
  download(new Blob([xml], { type: "application/xml" }), `sms-backup-${stamp()}.xml`);
  toast(`Exported ${smsList.length} text messages` + (mmsList.length ? ` and ${mmsList.length} MMS (text only, without attachments)` : ""));
});
$("msgExportCsv").addEventListener("click", () => {
  if (!smsList) return;
  const all = [...smsList, ...mmsList].sort((a, b) => b.date - a.date);
  const csv = toCsv(["Date", "Direction", "Number", "Contact", "Message"], all.map((m) => {
    const who = m.mms ? mmsPeople(m) : [m.address];
    const text = m.mms ? [m.subject, m.body, m.parts.length ? `[${m.parts.length} attachment${m.parts.length === 1 ? "" : "s"}]` : ""].filter(Boolean).join(" ") : m.body;
    return [new Date(m.date).toISOString(), m.type === 1 ? "received" : "sent", who.join("; "), who.map(nameFor).filter(Boolean).join("; "), text];
  }));
  download(new Blob(["﻿" + csv], { type: "text/csv" }), `sms-${stamp()}.csv`);
});
$("msgRestore").addEventListener("click", () => $("msgRestoreInput").click());
$("msgRestoreInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (file) showSmsRestore(file).catch(showError);
});

async function loadMessages(force = false) {
  await withCompanion($("msgGate"), $("msgMain"), async () => {
    needPermission("READ_SMS", "SMS");
    if (smsList && !force) { renderThreads(); return renderThread(); }
    $("threadList").replaceChildren(loadingBox("Loading messages…"));
    mmsNote = "";
    const [list, mms] = await Promise.all([
      cc("sms.list"),
      cc("mms.list").catch((e) => {
        console.warn("MMS:", e);
        mmsNote = /Unknown method/.test(e?.message) ? "update the companion to see pictures and group messages" : "pictures and group messages couldn't be read";
        return [];
      }),
      contactsCache ? null : fetchContacts().catch(() => {}),
    ]);
    smsList = list;
    mmsList = (Array.isArray(mms) ? mms : []).map((m) => ({ ...m, mms: true, body: m.text || "", subject: m.subject || "", parts: Array.isArray(m.parts) ? m.parts : [], to: Array.isArray(m.to) ? m.to : [], recipients: Array.isArray(m.recipients) ? m.recipients : [] }));
    const map = new Map();
    for (const m of [...smsList, ...mmsList]) {
      let t = map.get(m.thread);
      if (!t) map.set(m.thread, (t = { id: m.thread, address: "", people: [], group: false, msgs: [] }));
      t.msgs.push(m);
    }
    threads = [...map.values()];
    for (const t of threads) {
      t.msgs.sort((a, b) => b.date - a.date); // newest first
      t.people = threadPeople(t.msgs);
      t.group = t.people.length > 1;
      t.address = t.people[0] || t.msgs.find((m) => !m.mms)?.address || "";
    }
    threads.sort((a, b) => b.msgs[0].date - a.msgs[0].date);
    if (currentThread) currentThread = threads.find((t) => t.id === currentThread.id || (!t.group && digits(t.address) === digits(currentThread.address))) || null;
    renderThreads(); renderThread();
  });
}

const threadTitle = (t) => (t.people.length ? t.people : [t.address]).map((a) => nameFor(a) || a).filter(Boolean).join(", ") || "(unknown)";
const partsLabel = (m) => !m.parts?.length ? "" : m.parts.every((p) => /^image\//.test(p.mime)) ? (m.parts.length > 1 ? `${m.parts.length} pictures` : "Picture") : (m.parts.length > 1 ? `${m.parts.length} attachments` : "Attachment");
function msgPreview(t, m) {
  const who = m.type !== 1 ? "You: " : t.group && m.mms && m.from ? `${nameFor(m.from) || m.from}: ` : "";
  return who + (m.body || (m.mms ? m.subject || partsLabel(m) || "Multimedia message" : ""));
}

function renderThreads() {
  if (!smsList) return;
  const q = $("msgSearch").value.trim().toLowerCase();
  const has = (s) => String(s || "").toLowerCase().includes(q);
  const list = threads.filter((t) => !q || has(t.address) || t.people.some((a) => has(a) || has(nameFor(a))) ||
    t.msgs.some((m) => has(m.body) || (m.mms && (has(m.subject) || m.parts.some((p) => has(p.name))))));
  $("msgCount").textContent = `${smsList.length} text messages${mmsList.length ? ` · ${mmsList.length} MMS` : ""} · ${threads.length} conversations` + (mmsNote ? ` (${mmsNote})` : "");
  const items = list.slice(0, 500).map((t) => {
    const last = t.msgs[0];
    const b = el("button", { className: "thread-item" + (currentThread === t ? " on" : ""), type: "button" },
      el("div", { className: "t" }, el("span", { textContent: (t.group ? "👥 " : "") + threadTitle(t) }), el("span", { className: "muted small", textContent: fmtDate(last.date) })),
      el("div", { className: "s", textContent: msgPreview(t, last) }));
    b.onclick = () => { currentThread = t; renderThreads(); renderThread(); };
    return b;
  });
  $("threadList").replaceChildren(...(items.length ? items : [emptyBox(q ? "No matches" : "No messages")]));
}

function renderThread() {
  const t = currentThread, view = $("threadView");
  if (!t) return view.replaceChildren(emptyBox("Select a conversation, or start a new message"));
  if (!t.msgs) return; // a message was just sent to a new number; the list is reloading
  const name = nameFor(t.address);
  const head = el("div", { className: "thread-head" }, el("span", { textContent: threadTitle(t) }),
    t.group ? el("span", { className: "muted small", textContent: `  group · ${t.people.length} people`, title: t.people.join("\n") })
      : name ? el("span", { className: "muted small", textContent: "  " + t.address }) : "");
  const bubbles = el("div", { className: "bubbles" });
  for (const m of [...t.msgs].reverse()) {
    const note = m.type === 5 ? " · failed" : m.type === 3 ? " · draft" : m.type === 4 || m.type === 6 ? " · sending" : "";
    if (m.mms) bubbles.append(mmsBubble(t, m, note));
    else bubbles.append(el("div", { className: "bubble" + (m.type === 1 ? "" : " out") }, m.body, el("span", { className: "when", textContent: fmtDate(m.date, true) + note })));
  }
  view.replaceChildren(head, bubbles, t.group ? groupReply(t) : composer(() => t.address));
  bubbles.scrollTop = bubbles.scrollHeight;
}

// ---- MMS: pictures inline (small previews first), other attachments as a link to save ----
const MMS_IMAGE = /^image\/(jpeg|jpg|png|gif|webp|bmp|heic|heif)$/i;
const mmsThumbs = new Map(); // partId -> data URL ("" = no preview)
const mmsWant = [];
let mmsBusy = false;
const mmsObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    mmsObserver.unobserve(e.target);
    mmsWant.push(e.target);
  }
  pumpMmsThumbs();
}, { rootMargin: "300px" });
async function pumpMmsThumbs() {
  if (mmsBusy) return;
  mmsBusy = true;
  const phone = adb;
  try {
    while (mmsWant.length && adb && adb === phone) {
      const box = mmsWant.pop(); // newest (lowest on screen) first
      if (!box.isConnected) continue;
      const id = Number(box.dataset.part);
      let url = mmsThumbs.get(id);
      if (url === undefined) {
        url = "";
        try {
          const r = await cc("mms.part", { partId: id, thumb: 360 });
          if (r?.data && /^[A-Za-z0-9+/=]+$/.test(r.data)) url = `data:${/^image\/(png|gif|webp)$/.test(r.mime) ? r.mime : "image/jpeg"};base64,${r.data}`;
        } catch (e) { console.warn("MMS preview:", e); }
        if (adb !== phone) break;
        mmsThumbs.set(id, url);
        if (mmsThumbs.size > 400) mmsThumbs.delete(mmsThumbs.keys().next().value);
      }
      paintMmsThumb(box, url);
    }
  } finally { mmsBusy = false; }
}
function paintMmsThumb(box, url) {
  if (url) box.replaceChildren(el("img", { src: url, alt: "", draggable: false }));
  else box.classList.add("nopreview");
}
const partTitle = (p) => `${p.name || p.mime || "Attachment"}${p.size > 0 ? ` · ${fmtSize(p.size)}` : ""}`;
async function fetchMmsPart(p) {
  const r = await cc("mms.part", { partId: p.partId });
  if (!r?.data) throw new Error("The phone returned no data for this attachment.");
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(r.mime || p.mime || "") ? (r.mime || p.mime) : "application/octet-stream";
  return new Blob([base64ToBytes(r.data)], { type: mime });
}
async function saveMmsPart(p, btn) {
  if (btn) busy(btn, true, "Saving…");
  try { const blob = await fetchMmsPart(p); download(blob, attachmentName(p)); }
  catch (e) { showError(e); }
  finally { if (btn?.isConnected) busy(btn, false); }
}
function openMmsImage(p) {
  const img = el("img", { alt: "", className: "mms-full" });
  const status = el("div", { className: "empty" }, spinner(), " Loading picture…");
  const save = el("button", { className: "btn primary", type: "button", textContent: "Save…", disabled: true });
  const close = el("button", { className: "btn", type: "button", textContent: "Close" });
  const modal = el("div", { className: "modal" }, el("div", { className: "card mms-view" },
    el("div", { className: "toolbar", style: "justify-content:space-between" }, el("span", { className: "muted small", textContent: partTitle(p) }), el("span", {}, save, " ", close)), status, img));
  let url = "", blob = null;
  const done = () => { modal.remove(); if (url) URL.revokeObjectURL(url); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") done(); };
  close.onclick = done;
  modal.onclick = (e) => { if (e.target === modal) done(); };
  save.onclick = () => { if (blob) download(blob, attachmentName(p)); };
  document.addEventListener("keydown", onKey);
  document.body.append(modal);
  fetchMmsPart(p).then((b) => {
    if (!modal.isConnected) return;
    // Shown through <img> only, so even an SVG can't run scripts.
    blob = b; url = URL.createObjectURL(b); img.src = url; save.disabled = false; status.remove();
    img.onerror = () => { img.remove(); modal.querySelector(".card").append(emptyBox("This picture format can't be shown here. Use Save… to keep the file.")); };
  }).catch((e) => { status.replaceChildren(String(e?.message || e)); });
}
function mmsBubble(t, m, note) {
  const out = m.type !== 1;
  const b = el("div", { className: "bubble mms" + (out ? " out" : "") });
  if (t.group && !out && m.from) b.append(el("span", { className: "who", textContent: nameFor(m.from) || m.from }));
  if (m.subject) b.append(el("b", { className: "subj", textContent: m.subject }));
  for (const p of m.parts) {
    if (MMS_IMAGE.test(p.mime || "")) {
      const box = el("button", { className: "mms-img", type: "button", title: `${partTitle(p)}\nClick to open or save` });
      box.dataset.part = String(p.partId);
      box.onclick = () => openMmsImage(p);
      if (mmsThumbs.get(p.partId)) paintMmsThumb(box, mmsThumbs.get(p.partId)); else mmsObserver.observe(box);
      b.append(box);
    } else {
      const f = el("button", { className: "mms-file", type: "button", textContent: `📎 ${partTitle(p)} · Save…` });
      f.onclick = () => saveMmsPart(p, f);
      b.append(f);
    }
  }
  if (m.body) b.append(el("span", { textContent: m.body }));
  if (!m.body && !m.parts.length && !m.subject) b.append(el("span", { className: "muted", textContent: "(empty multimedia message)" }));
  b.append(el("span", { className: "when", textContent: `${fmtDate(m.date, true)}${note} · MMS` }));
  return b;
}
// Group conversations are MMS, which Andromon can't send: offer a normal SMS to one person instead.
function groupReply(t) {
  const sel = el("select", {}, ...t.people.map((a) => el("option", { value: a, textContent: nameFor(a) ? `${nameFor(a)} (${a})` : a })));
  return el("div", { className: "group-reply" },
    el("div", { className: "muted small" }, "Andromon can't send group messages (MMS). Reply to everyone on the phone, or send a normal SMS to just ", sel, " :"),
    composer(() => sel.value));
}

function renderNewMessage() {
  const to = el("input", { type: "text", placeholder: "Phone number", className: "to-input" });
  const head = el("div", { className: "thread-head" }, el("span", { textContent: "To: " }), to);
  $("threadView").replaceChildren(head, el("div", { className: "bubbles" }), composer(() => to.value.trim()));
  to.focus();
}

function composer(getTo) {
  const ta = el("textarea", { placeholder: "Text message (sent from the phone, normal SMS charges apply)" });
  const send = el("button", { className: "btn primary", textContent: "Send", type: "button" });
  armedClick(send, async () => {
    const to = getTo(), body = ta.value;
    if (!to || !body.trim()) return showError("Enter a phone number and a message.");
    needPermission("SEND_SMS", "send-SMS");
    busy(send, true, "Sending…");
    try {
      const r = await cc("sms.send", { to, body });
      ta.value = "";
      toast(`Sent${r.parts > 1 ? ` (${r.parts} parts)` : ""}`);
      if (!currentThread || currentThread.group) currentThread = { id: -1, address: to };
      await wait(1500); // give the phone a moment to store it in Sent
      await loadMessages(true);
    } catch (e) { showError(e); }
    finally { if (send.isConnected) busy(send, false); }
  });
  return el("div", { className: "composer" }, ta, send);
}

// ---- restoring from a backup file (shared by Messages, Call log and "Restore from a backup…") ----
// If the companion lacks a permission that was added after it was installed, grant it over adb.
async function ensurePerms(keys) {
  const missing = keys.filter((k) => companionInfo?.permissions && companionInfo.permissions[k] !== true);
  if (!missing.length) return;
  for (const k of missing) await sh(`pm grant ${COMPANION_PKG} android.permission.${k}`).catch(() => {});
  try { companionInfo = await cc("info"); } catch {}
}
const restoreSummary = (r, what) => `${r.added} ${what} added to the phone · ${r.skipped} already there${r.failed ? ` · ${r.failed} couldn't be stored` : ""}`;
/** Puts SMS back on the phone. list: [{address, body, date, dateSent, type, read}] → {added, skipped, failed}. */
async function restoreSms(list, onProgress = () => {}) {
  needPermission("READ_SMS", "SMS");
  // Android lets only the default SMS app write messages, unless the WRITE_SMS app-op is allowed
  // for the app, which a computer can do over adb. The companion reads back what it stored and
  // reports what really happened; some phones ignore the app-op, and then it says so.
  await sh(`appops set ${COMPANION_PKG} WRITE_SMS allow`).catch(() => {});
  const total = { added: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < list.length; i += 1000) {
    const r = await cc("sms.restore", { messages: list.slice(i, i + 1000) });
    for (const k of Object.keys(total)) total[k] += Number(r?.[k]) || 0;
    onProgress(Math.min(i + 1000, list.length), list.length, total);
  }
  return total;
}
/** Puts call-log entries back. list: [{number, date, duration, type, name?}] → {added, skipped, failed}. */
async function restoreCalls(list, onProgress = () => {}) {
  await ensurePerms(["WRITE_CALL_LOG", "READ_CALL_LOG"]);
  needPermission("WRITE_CALL_LOG", "write-call-log");
  const total = { added: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < list.length; i += 1000) {
    const r = await cc("calls.restore", { calls: list.slice(i, i + 1000) });
    for (const k of Object.keys(total)) total[k] += Number(r?.[k]) || 0;
    onProgress(Math.min(i + 1000, list.length), list.length, total);
  }
  return total;
}
// A card with what the file holds, and a button that does the restore: nothing is written before that click.
function restoreCard(box, { title, notes, okLabel, run }) {
  box.hidden = false;
  const closeBox = () => { box.hidden = true; box.replaceChildren(); };
  const status = el("span", { className: "muted" });
  const cancel = el("button", { className: "btn", type: "button", textContent: okLabel ? "Cancel" : "Close" });
  cancel.onclick = closeBox;
  const ok = el("button", { className: "btn primary", type: "button", textContent: okLabel || "" });
  ok.onclick = async () => {
    busy(ok, true, "Restoring…"); cancel.disabled = true; clearError();
    try {
      const summary = await run((text) => { status.textContent = text; });
      const done = el("button", { className: "btn", type: "button", textContent: "Close" });
      done.onclick = closeBox;
      box.replaceChildren(el("h2", { textContent: "Restore finished" }), el("p", { className: "muted", textContent: summary }), done);
    } catch (e) { showError(e); status.textContent = ""; }
    finally { if (ok.isConnected) { busy(ok, false); cancel.disabled = false; } }
  };
  box.replaceChildren(el("h2", { textContent: title }), ...notes.filter(Boolean).map((t) => el("p", { className: "muted", textContent: t })),
    el("div", { className: "toolbar", style: "margin:0" }, ...(okLabel ? [ok] : []), cancel, status));
  box.scrollIntoView({ block: "nearest" });
}
async function showSmsRestore(file) {
  if (file.size > 1024 ** 3) throw new Error("That file is larger than 1 GB, too large to read here.");
  const { sms, mmsCount, bad } = parseSmsXml(await file.text());
  const n = (x) => x.toLocaleString();
  restoreCard($("msgRestoreBox"), {
    title: sms.length ? `Restore ${n(sms.length)} text messages from ${file.name}?` : `Nothing to restore in ${file.name}`,
    notes: [
      sms.length ? `${n(sms.filter((m) => m.type === 1).length)} received and ${n(sms.filter((m) => m.type !== 1).length)} sent or other messages. Messages that are already on the phone (same number, time and text) are skipped.` : "No text messages were found. The file should be an XML export from Andromon or from the “SMS Backup & Restore” app.",
      mmsCount ? `${n(mmsCount)} MMS (pictures and group messages) in the file will be skipped: Android doesn't let Andromon write MMS.` : "",
      bad ? `${n(bad)} entries couldn't be read and will be skipped.` : "",
      sms.length ? "Andromon first allows the companion to write messages (an Android setting only a computer can change). A few phones ignore it; you'll be told if nothing could be stored." : "",
    ],
    okLabel: sms.length ? `Restore ${n(sms.length)} messages` : "",
    run: async (say) => {
      const r = await restoreSms(sms, (done, total) => say(`${n(done)} of ${n(total)}…`));
      loadMessages(true).catch(showError);
      return restoreSummary(r, "messages") + (mmsCount ? ` · ${n(mmsCount)} MMS skipped` : "");
    },
  });
}

// ---------- contacts tab ----------
$("ctSearch").addEventListener("input", () => renderContacts());
$("ctReload").addEventListener("click", () => loadContacts(true).catch(showError));
$("ctExport").addEventListener("click", async () => {
  if (!contactsCache) return;
  const btn = $("ctExport"); busy(btn, true, "Exporting…");
  try {
    const { text, photos } = await contactsVcf(contactsCache, (i, n) => { $("ctCount").textContent = `Reading photos… ${i} of ${n}`; });
    download(new Blob([text], { type: "text/vcard" }), `contacts-${stamp()}.vcf`);
    toast(`Exported ${contactsCache.length} contacts${photos ? ` (${photos} with a photo)` : ""}`);
  } catch (e) { showError(e); }
  finally { busy(btn, false); renderContacts(); }
});
/** vCard text for these contacts, photos included (PHOTO, base64). */
async function contactsVcf(list, onProgress = () => {}) {
  const cards = []; let photos = 0;
  for (const [i, c] of list.entries()) {
    let photo = "";
    if (c.hasPhoto) {
      try { photo = (await cc("contacts.photo", { id: c.id, size: 720 })) || ""; } catch (e) { console.warn("Contact photo:", e); }
      if (photo) photos++;
      onProgress(i + 1, list.length);
    }
    cards.push(toVcard(c, photo));
  }
  return { text: cards.join("\r\n") + "\r\n", photos };
}
/** Adds contacts (photos included) in requests small enough for the companion. Returns how many were added. */
async function addContacts(list, onProgress = () => {}) {
  needPermission("WRITE_CONTACTS", "write-contacts");
  let done = 0, i = 0;
  while (i < list.length) {
    const batch = []; let bytes = 0;
    while (i < list.length && batch.length < 200 && (bytes < 3_000_000 || !batch.length)) { bytes += list[i].photo?.length || 0; batch.push(list[i++]); }
    const r = await cc("contacts.add", { contacts: batch });
    done += Number(r?.added) || 0; onProgress(done, list.length);
  }
  return done;
}
$("ctImportBtn").addEventListener("click", () => $("ctImportInput").click());
$("ctImportInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (file) showImport(file.name, parseVcf(await file.text()));
});

async function loadContacts(force = false) {
  await withCompanion($("ctGate"), $("ctMain"), async () => {
    needPermission("READ_CONTACTS", "contacts");
    if (!contactsCache || force) {
      $("ctRows").replaceChildren(loadingRow(3, "Loading contacts…"));
      await fetchContacts();
    }
    renderContacts();
  });
}

// Icon button beside a contact's number: opens Messages with a new message addressed to it.
function textButton(number, name) {
  const raw = String(number || "").trim();
  if (!/^[+\d][\d\s().-]*$/.test(raw)) return "";
  const title = `Text ${String(name || "").trim() || raw}`;
  const b = el("button", { className: "lk-icon", type: "button", title },
    document.querySelector('#nav button[data-view="messages"] svg')?.cloneNode(true) || "");
  b.setAttribute("aria-label", title);
  b.addEventListener("click", async () => {
    show("messages");
    await loadMessages().catch(() => {});
    renderNewMessage();
    const to = document.querySelector(".to-input"); if (to) to.value = raw;
    document.querySelector(".composer textarea")?.focus();
  });
  return b;
}

function renderContacts() {
  if (!contactsCache) return;
  const q = $("ctSearch").value.trim().toLowerCase();
  const list = contactsCache.filter((c) => !q || (c.name || "").toLowerCase().includes(q) ||
    c.phones.some((p) => p.number.includes(q) || digits(p.number).includes(q.replace(/\D/g, "") || "\u0000")) ||
    c.emails.some((m) => m.address.toLowerCase().includes(q)));
  $("ctCount").textContent = `${list.length} of ${contactsCache.length} contacts` + (list.length > 1000 ? " · showing the first 1000" : "") + " · click a name to edit";
  const lines = (arr, f) => el("div", {}, ...arr.map((x) => el("div", { textContent: f(x) })));
  const rows = list.slice(0, 1000).map((c) => el("tr", {},
    el("td", {}, people ? people.nameCell(c) : el("span", { textContent: (c.starred ? "★ " : "") + (c.name || "(no name)") })),
    el("td", { className: "mono" }, el("div", {}, ...c.phones.map((p) => el("div", { className: "lk-tel" }, el("span", { textContent: `${p.number}  ·  ${p.type}` }),
      el("span", { className: "lk-acts" }, textButton(p.number, c.name), links?.callButton(p.number, c.name) || ""))))),
    el("td", { className: "hide-sm" }, lines(c.emails, (m) => m.address))));
  $("ctRows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colSpan: 3, className: "empty", textContent: q ? "No matches" : "No contacts" }))]));
  people?.renderSelection();
}

function showImport(fileName, list) {
  const box = $("ctImport");
  box.hidden = false;
  const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
  cancel.onclick = () => { box.hidden = true; };
  if (!list.length) {
    box.replaceChildren(el("h2", { textContent: "Nothing to import" }), el("p", { className: "muted", textContent: `No contacts found in ${fileName}.` }), cancel);
    return;
  }
  const status = el("span", { className: "muted" });
  const isKnown = makeContactMatcher(contactsCache || []);
  const fresh = list.filter((c) => !isKnown(c));
  const known = list.length - fresh.length;
  const skip = el("input", { type: "checkbox", checked: true });
  const chosen = () => (skip.checked ? fresh : list);
  const add = el("button", { className: "btn primary", type: "button" });
  const label = () => { add.textContent = `Add ${chosen().length} contacts to phone`; add.disabled = !chosen().length; };
  skip.onchange = label; label();
  add.onclick = async () => {
    try {
      const todo = chosen();
      busy(add, true, "Adding…"); cancel.disabled = true;
      const done = await addContacts(todo, (n, total) => { status.textContent = `${n} of ${total}…`; });
      toast(`Added ${done} contacts`); box.hidden = true;
      await loadContacts(true);
    } catch (e) { showError(e); }
    finally { if (add.isConnected) { busy(add, false); cancel.disabled = false; } }
  };
  const preview = list.slice(0, 5).map((c) => c.name || c.phones[0]?.number || c.emails[0]?.address).join(", ");
  const photos = list.filter((c) => c.photo).length;
  box.replaceChildren(
    el("h2", { textContent: `Import ${list.length} contacts from ${fileName}?` }),
    el("p", { className: "muted", textContent: `${preview}${list.length > 5 ? ", …" : ""}. They're added to the phone's local contacts${photos ? `, ${photos} with a photo` : ""}.` }),
    known ? el("label", { className: "muted", style: "display:block;margin-bottom:12px" }, skip, ` Skip ${known} that ${known === 1 ? "is" : "are"} already on the phone (same name with the same numbers and addresses)`) : "",
    el("div", { className: "toolbar", style: "margin:0" }, add, cancel, status));
}

// ---------- call log ----------
let callsCache = null, callFilter = "";
const CALL_TYPES = { 1: ["↙", "Incoming"], 2: ["↗", "Outgoing"], 3: ["✕", "Missed"], 4: ["●", "Voicemail"], 5: ["⊘", "Declined"], 6: ["⊘", "Blocked"], 7: ["↙", "Answered elsewhere"] };
const fmtDur = (s) => { s = Number(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };
$("callSearch").addEventListener("input", () => renderCalls());
$("callReload").addEventListener("click", () => loadCalls(true).catch(showError));
$("callFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  callFilter = b.dataset.f;
  for (const x of $("callFilter").children) x.classList.toggle("on", x === b);
  renderCalls();
});
$("callExport").addEventListener("click", () => {
  if (!callsCache) return;
  download(new Blob([buildCallsCsv(callsCache, nameFor)], { type: "text/csv" }), `call-log-${stamp()}.csv`);
});
$("callRestore").addEventListener("click", () => $("callRestoreInput").click());
$("callRestoreInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (file) showCallsRestore(file).catch(showError);
});
async function showCallsRestore(file) {
  if (file.size > 200 * 1024 * 1024) throw new Error("That file is too large to be a call log.");
  const { calls, bad } = parseCallsFile(await file.text());
  const n = (x) => x.toLocaleString();
  const count = (type) => calls.filter((c) => c.type === type).length;
  restoreCard($("callRestoreBox"), {
    title: calls.length ? `Restore ${n(calls.length)} calls from ${file.name}?` : `Nothing to restore in ${file.name}`,
    notes: [
      calls.length ? `${n(count(1))} incoming, ${n(count(2))} outgoing, ${n(count(3))} missed, ${n(calls.length - count(1) - count(2) - count(3))} other. Calls that are already in the phone's call log (same number, time, length and type) are skipped.`
        : "No calls were found. The file should be a call-log CSV exported by Andromon, or a calls XML file.",
      bad ? `${n(bad)} rows couldn't be read and will be skipped.` : "",
    ],
    okLabel: calls.length ? `Restore ${n(calls.length)} calls` : "",
    run: async (say) => {
      const r = await restoreCalls(calls, (done, total) => say(`${n(done)} of ${n(total)}…`));
      loadCalls(true).catch(showError);
      return restoreSummary(r, "calls");
    },
  });
}

async function loadCalls(force = false) {
  await withCompanion($("callGate"), $("callMain"), async () => {
    needPermission("READ_CALL_LOG", "call-log");
    if (!callsCache || force) {
      $("callRows").replaceChildren(loadingRow(4, "Loading call log…"));
      const [list] = await Promise.all([cc("calls.list"), contactsCache ? null : fetchContacts().catch(() => {})]);
      callsCache = list;
    }
    renderCalls();
  });
}

function renderCalls() {
  if (!callsCache) return;
  const q = $("callSearch").value.trim().toLowerCase();
  const list = callsCache.filter((c) => (!callFilter || String(c.type) === callFilter) &&
    (!q || c.number.includes(q) || (c.name || nameFor(c.number)).toLowerCase().includes(q)));
  $("callCount").textContent = `${list.length} of ${callsCache.length} calls` + (list.length > 1000 ? " · showing the first 1000" : "");
  const rows = list.slice(0, 1000).map((c) => {
    const [icon, label] = CALL_TYPES[c.type] || ["?", "Other"];
    const name = c.name || nameFor(c.number);
    return el("tr", {},
      el("td", { className: c.type === 3 || c.type === 5 ? "missed" : "" }, `${icon} ${label}`),
      el("td", {}, el("div", { textContent: name || c.number || "Private number" }), name ? el("div", { className: "sub mono", textContent: c.number }) : ""),
      el("td", { className: "muted hide-sm", textContent: fmtDate(c.date, true) }),
      el("td", { className: "num" }, c.duration ? fmtDur(c.duration) : "—", links?.callButton(c.number, name) || ""));
  });
  $("callRows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colSpan: 4, className: "empty", textContent: "No calls" }))]));
}

// ---------- call alerts ----------
// While a phone is connected (USB or Wi‑Fi), the companion streams call events over one long-lived
// "events" connection (see CallWatch.kt). Incoming calls pop up here with Answer / Decline /
// Silence, and as a system notification when Andromon isn't in front; missed calls stay until
// dismissed. Talking still happens on the phone: answering just picks up there.
const notifyApi = globalThis.andromon?.notify || null;
const CALL_PERMS = ["READ_PHONE_STATE", "ANSWER_PHONE_CALLS", "READ_CALL_LOG", "READ_CONTACTS"];
const callAlerts = {
  on: (() => { try { return localStorage.getItem("andromon.callAlerts") !== "off"; } catch { return true; } })(),
  gen: 0, socket: null, state: "off", detail: "", call: null, timer: 0,
};

function setCallAlertState(state, detail = "") {
  callAlerts.state = state; callAlerts.detail = detail;
  links?.onLinkState(state);
  renderCallAlertCard();
  if (typeof notifs !== "undefined") renderNotifCard();
}

function renderCallAlertCard() {
  const card = $("callAlertCard"); if (!card) return;
  const st = callAlerts.on ? callAlerts.state : "off";
  const text = {
    off: callAlerts.on ? "Connect a phone to get call alerts here." : "Off. Turn on in Settings to see incoming calls on this computer.",
    starting: "Starting…",
    on: "On. Incoming calls pop up here, and as a notification when Andromon is in the background.",
    reconnecting: "Lost the link to the phone. Reconnecting…",
    noperm: "The companion can't see calls yet. Allow “Phone” for Andromon Companion on the phone (Settings › Apps), then reconnect.",
    missing: "Needs the Andromon Companion app on the phone.",
    outdated: "Needs a newer Andromon Companion on the phone.",
    error: "Couldn't start call alerts.",
  }[st] || "";
  const kids = [el("div", { className: "grow" }, el("div", {}, el("b", { textContent: "Call alerts on this computer" })),
    el("div", { className: "sub", textContent: text + (callAlerts.detail ? ` ${callAlerts.detail}` : "") }))];
  if (adb && callAlerts.on && (callAlerts.state === "missing" || callAlerts.state === "outdated")) {
    const btn = el("button", { className: "btn sm primary", type: "button", textContent: callAlerts.state === "outdated" ? "Update companion" : "Install companion" });
    btn.onclick = async () => {
      busy(btn, true, "Installing…"); clearError();
      try { companionInfo = await ensureCompanion(() => {}); startCallAlerts(); }
      catch (e) { showError(e); if (btn.isConnected) busy(btn, false); }
    };
    kids.push(btn);
  }
  kids.push(settingsLink());
  card.replaceChildren(...kids);
}

function stopCallAlerts() {
  callAlerts.gen++;
  const s = callAlerts.socket; callAlerts.socket = null;
  if (s) s.close().catch(() => {});
  hideCallPop();
}

async function startCallAlerts() {
  stopCallAlerts();
  if (!adb || (!callAlerts.on && !notifs.on && !links?.wantsEvents())) return setCallAlertState("off");
  const gen = callAlerts.gen, phone = adb;
  const live = () => gen === callAlerts.gen && adb === phone;
  setCallAlertState("starting");
  try {
    const st = await companionStatus();
    if (!live()) return;
    if (st.state === "missing" || st.state === "outdated") return setCallAlertState(st.state);
    // Let the companion see and answer calls (pm grant is allowed from the adb shell).
    if (callAlerts.on) await sh(CALL_PERMS.map((p) => `pm grant ${COMPANION_PKG} android.permission.${p} 2>/dev/null`).join("; ")).catch(() => {});
    if (notifs.on) await grantNotifAccess();
    companionInfo = st.state === "ready" ? st.info : await startCompanion(() => {});
    for (let fails = 0; live(); ) {
      const opened = await streamCallEvents(gen).catch((e) => { if (e?.outdated) throw e; return false; });
      if (!live()) return;
      fails = opened ? 0 : fails + 1;
      setCallAlertState("reconnecting");
      await wait(Math.min(30_000, 2000 * 2 ** fails));
      if (!live()) return;
      try { companionInfo = await startCompanion(() => {}); } catch {}
    }
  } catch (e) {
    if (!live()) return;
    if (e?.outdated) setCallAlertState("outdated");
    else setCallAlertState("error", e?.message || String(e));
  }
}

// Reads the event stream until it closes. Resolves true if it got as far as the "hello".
async function streamCallEvents(gen) {
  let socket;
  try { socket = await adb.createSocket(`localabstract:${COMPANION_SOCKET}`); }
  catch { throw new CompanionUnavailable(); }
  if (gen !== callAlerts.gen) { socket.close().catch(() => {}); return false; }
  callAlerts.socket = socket;
  let hello = false;
  // The companion writes a ping every 20 s. If nothing arrives for 50 s, check the link: a Wi‑Fi
  // connection can die silently (phone out of range or asleep), and then nothing else notices.
  const phone = adb;
  let lastSeen = Date.now(), checking = false;
  const watchdog = setInterval(async () => {
    if (checking || Date.now() - lastSeen < 50_000) return;
    checking = true;
    const ok = await Promise.race([sh("echo ok").then((o) => /ok/.test(o), () => false), wait(8000).then(() => false)]);
    checking = false;
    if (adb !== phone || gen !== callAlerts.gen) return;
    if (ok) { lastSeen = Date.now(); socket.close().catch(() => {}); return; } // link fine, stream stuck: reopen it
    if (connectedVia === "wifi") killWifiLink?.(); else socket.close().catch(() => {});
  }, 10_000);
  try {
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify({ id: 1, method: "events", params: { calls: callAlerts.on, notifications: notifs.on, media: !!links?.wantsMedia() } }) + "\n"));
    writer.releaseLock();
    const reader = socket.readable.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done || gen !== callAlerts.gen) break;
      lastSeen = Date.now();
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        // Companions before 0.13 answer {"error":"Unknown method: events"}.
        if (ev.error) throw Object.assign(new Error(ev.error), { outdated: /Unknown method/.test(ev.error) });
        if (ev.type === "hello") {
          hello = true;
          setCallAlertState(callAlerts.on && ev.permissions?.READ_PHONE_STATE === false ? "noperm" : "on");
          if (notifs.on) onNotifHello(ev.notifications);
          links?.onHello(ev);
        } else if (ev.type === "call") onCallEvent(ev);
        else if (ev.type === "notif" && notifs.on) onNotifEvent(ev);
        else if (ev.type === "clip" || ev.type === "ring" || ev.type === "media") links?.onEvent(ev);
      }
    }
  } finally {
    clearInterval(watchdog);
    if (callAlerts.socket === socket) callAlerts.socket = null;
    socket.close().catch(() => {});
  }
  return hello;
}

const callerName = (ev) => ev.name || nameFor(ev.number) || "";
const callerLabel = (ev) => callerName(ev) || ev.number || "Unknown number";

function onCallEvent(ev) {
  const cur = callAlerts.call;
  const same = cur && cur.id === ev.id;
  switch (ev.state) {
    case "ringing":
      callAlerts.call = { ...ev, phase: "ringing", byUs: false };
      showCallPop();
      if (!document.hasFocus()) notifyApi?.show({ id: "call", title: "Incoming call", body: callerLabel(ev) + (callerName(ev) && ev.number ? ` · ${ev.number}` : ""), urgent: true, actions: ["Answer", "Decline"] }).catch(() => {});
      break;
    case "answered":
      notifyApi?.close("call").catch(() => {});
      if (same) { cur.phase = "active"; cur.since = Date.now(); showCallPop(); }
      break;
    case "ended":
      if (same) hideCallPop();
      break;
    default: { // missed / declined / blocked
      notifyApi?.close("call").catch(() => {});
      const byUs = same && cur.byUs;
      if (same || !cur) hideCallPop();
      callsCache = null;
      if (current === "calls") loadCalls(true).catch(() => {});
      if (ev.state === "missed" && !byUs) {
        callAlerts.call = { ...ev, phase: "missed" };
        showCallPop();
        if (!document.hasFocus()) notifyApi?.show({ id: "missed", title: "Missed call", body: callerLabel(ev) + " · " + fmtDate(ev.time) }).catch(() => {});
      }
    }
  }
}

renderCallAlertCard();
notifyApi?.onEvent((ev) => {
  if (ev.id === "missed" && ev.kind === "click") show("calls");
  const key = notifs.sysIds.get(ev.id);
  if (key) {
    const n = notifs.items.get(key), reply = n?.actions?.find((a) => a.reply);
    if (ev.kind === "reply" && n && reply && ev.text) cc("notif.reply", { key, action: reply.i, text: ev.text }).then((r) => toast(replyToast(n, r)), showError);
    else if (ev.kind === "click") { show("notifs"); notifs.toasts.get(key)?.el.openReply?.(); }
  }
  if (ev.id === "call" && ev.kind === "action") callAction(ev.index === 0 ? "answer" : "decline").catch(showError);
});

function hideCallPop() {
  clearInterval(callAlerts.timer);
  callAlerts.call = null;
  $("callPop").hidden = true;
  notifyApi?.close("call").catch(() => {});
}

function showCallPop() {
  const c = callAlerts.call; if (!c) return;
  clearInterval(callAlerts.timer);
  const pop = $("callPop");
  pop.className = `callpop ${c.phase}`;
  const name = callerName(c);
  const initial = (name.match(/\p{L}/u)?.[0] || "#").toUpperCase();
  const kind = el("div", { className: "kind", textContent: { ringing: "Incoming call", active: "On a call", missed: "Missed call" }[c.phase] });
  const who = el("div", { className: "who" }, el("div", { className: "av", textContent: initial }),
    el("div", { style: "min-width:0" }, el("div", { className: "name", textContent: name || c.number || "Unknown number" }),
      name && c.number ? el("div", { className: "num", textContent: c.number }) : ""));
  const btn = (label, cls, action) => {
    const b = el("button", { className: `btn ${cls}`, type: "button", textContent: label });
    b.onclick = async () => { busy(b, true, "…"); try { await action(); } catch (e) { showError(e); } finally { if (b.isConnected) busy(b, false); } };
    return b;
  };
  const kids = [kind, who];
  if (c.phase === "ringing") {
    kids.push(el("div", { className: "acts" },
      btn("Decline", "decline", () => callAction("decline")),
      btn("Silence", "", () => callAction("silence")),
      btn("Answer", "answer", () => callAction("answer"))),
      el("div", { className: "note", textContent: "Answering picks up on the phone; talk there or on its speaker." }));
  } else if (c.phase === "active") {
    const t = el("div", { className: "note" });
    const tick = () => { t.textContent = `${fmtDur(Math.round((Date.now() - c.since) / 1000))} · on the phone`; };
    tick(); callAlerts.timer = setInterval(tick, 1000);
    kids.push(t, el("div", { className: "acts" }, btn("Hang up", "decline", () => callAction("decline"))));
  } else {
    kids.push(el("div", { className: "note", textContent: fmtDate(c.time, true) }));
    const acts = el("div", { className: "acts" });
    if (/^[+\d*#][\d*#\s()-]*$/.test(c.number || "")) {
      acts.append(btn("Call back", "answer", () => callAction("callback")), btn("Message", "", async () => {
        const num = c.number; hideCallPop(); show("messages");
        await loadMessages().catch(() => {});
        renderNewMessage(); const to = document.querySelector(".to-input"); if (to) to.value = num;
        document.querySelector(".composer textarea")?.focus();
      }));
    }
    kids.push(acts);
    const x = el("button", { className: "x", type: "button", textContent: "✕", title: "Dismiss" }); x.onclick = hideCallPop;
    kids.push(x);
  }
  pop.replaceChildren(...kids);
  pop.hidden = false;
}

// Answer / decline go through the companion (Android's call API, needs "Phone" permission);
// if that fails, the same keys a headset would press. Silence = a volume key, as on the phone.
async function callAction(what) {
  if (!adb) return;
  const c = callAlerts.call;
  if (what === "silence") { await sh("input keyevent KEYCODE_VOLUME_DOWN"); toast("Ringer silenced"); return; }
  if (what === "callback") {
    const num = String(c?.number || "").replace(/[^\d+*#]/g, "");
    if (!num) return;
    hideCallPop();
    await sh(`am start -a android.intent.action.CALL -d ${shQuote("tel:" + num)}`);
    toast(`Calling ${callerLabel(c)} on the phone`);
    return;
  }
  if (c) c.byUs = what === "decline";
  const method = what === "answer" ? "call.answer" : "call.end";
  try { await cc(method); }
  catch { await sh(`input keyevent ${what === "answer" ? "KEYCODE_CALL" : "KEYCODE_ENDCALL"}`); }
  if (what === "decline" && c?.phase === "ringing") toast("Call declined");
}

// ---------- phone notifications ----------
// WhatsApp, SMS, email… everything the phone shows, mirrored live over the same "events" stream
// (NotifListener.kt). Each one can be answered (the app's own Reply, as on a smartwatch), its
// buttons pressed ("Mark as read"…), or dismissed on the phone. Needs "Notification access" for the
// companion, which Andromon turns on over adb the first time the person switches this on.
const NOTIF_LISTENER = `${COMPANION_PKG}/${COMPANION_PKG}.NotifListener`;
const DEFAULT_QUICK = ["OK", "On my way", "Can't talk now, I'll call you later", "Thanks!", "👍"];
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const notifs = {
  on: lsGet("andromon.notifs", false), popups: lsGet("andromon.notifPopups", true),
  muted: new Set(lsGet("andromon.notifMuted", [])), quick: lsGet("andromon.quickReplies", DEFAULT_QUICK),
  items: new Map(), icons: new Map(), status: null, toasts: new Map(), sysIds: new Map(), seq: 0,
};

function resetNotifs() {
  notifs.items.clear(); notifs.status = null;
  for (const t of notifs.toasts.values()) t.el.remove();
  notifs.toasts.clear();
  updateNotifBadge(); renderNotifs(); renderNotifCard();
}

async function grantNotifAccess() {
  await sh(`cmd notification allow_listener ${NOTIF_LISTENER}`).catch(() => {});
}

function renderNotifCard() {
  const card = $("ntCard"); if (!card) return;
  const sw = (on, title, fn) => {
    const b = el("button", { className: "switch", type: "button", title });
    b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(on)); b.onclick = fn;
    return b;
  };
  const st = notifs.status;
  let text;
  if (!notifs.on) text = "Off. Turn on in Settings to see the phone's notifications here (WhatsApp, SMS, email…) and answer them from this computer. This gives Andromon Companion “Notification access” on the phone.";
  else if (!adb) text = "Connect a phone to see its notifications.";
  else if (callAlerts.state === "missing" || callAlerts.state === "outdated") text = callAlerts.state === "missing" ? "Needs the Andromon Companion app on the phone." : "Needs a newer Andromon Companion on the phone.";
  else if (!st) text = "Starting…";
  else if (!st.access) text = "The phone hasn't given Andromon Companion “Notification access” yet.";
  else text = "On. New notifications pop up here; reply, use their buttons or dismiss them on the phone.";
  const main = el("div", { className: "ctl" }, el("div", {}, el("div", {}, el("b", { textContent: "Phone notifications on this computer" })), el("div", { className: "sub", textContent: text })),
    settingsLink());
  const rows = [main];
  if (adb && notifs.on && st && !st.access) {
    const allow = el("button", { className: "btn sm primary", type: "button", textContent: "Allow again" });
    allow.onclick = async () => { busy(allow, true, "…"); await grantNotifAccess(); startCallAlerts(); };
    const open = el("button", { className: "btn sm", type: "button", textContent: "Open the setting on the phone" });
    open.onclick = () => sh("am start -a android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").then(() => toast("Turn on Andromon Companion on the phone"), showError);
    rows.push(el("div", { className: "toolbar", style: "margin:0" }, allow, open));
  }
  if (adb && notifs.on && (callAlerts.state === "missing" || callAlerts.state === "outdated")) {
    const btn = el("button", { className: "btn sm primary", type: "button", textContent: callAlerts.state === "outdated" ? "Update companion" : "Install companion" });
    btn.onclick = async () => {
      busy(btn, true, "Installing…"); clearError();
      try { companionInfo = await ensureCompanion(() => {}); startCallAlerts(); }
      catch (e) { showError(e); if (btn.isConnected) busy(btn, false); }
    };
    rows.push(el("div", { className: "toolbar", style: "margin:0" }, btn));
  }
  card.replaceChildren(el("div", { className: "rows" }, ...rows));
}

async function loadNotifList() {
  try {
    let list = await cc("notif.list");
    notifs.items.clear();
    for (const n of list) notifs.items.set(n.key, n);
  } catch (e) {
    if (/Notification access/.test(e.message)) {
      // Allowed a moment ago: Android connects the listener shortly after.
      await wait(1500);
      try { const list = await cc("notif.list"); notifs.items.clear(); for (const n of list) notifs.items.set(n.key, n); notifs.status = { ...notifs.status, connected: true }; }
      catch { /* stays empty; events still arrive once connected */ }
    } else showError(e);
  }
  updateNotifBadge(); renderNotifs();
}

async function loadNotifs() {
  $("ntGate").hidden = true;
  renderNotifCard(); renderNotifs();
}

function onNotifHello(status) {
  notifs.status = status || { access: false };
  renderNotifCard();
  $("ntBar").hidden = !(notifs.on && notifs.status.access);
  if (notifs.status.access) loadNotifList(); else recheckNotifAccess();
}
// Android applies "Notification access" a moment after it's allowed, so look again for a few seconds.
async function recheckNotifAccess() {
  const phone = adb;
  for (let i = 0; i < 5; i++) {
    await wait(1500);
    if (adb !== phone || !notifs.on || notifs.status?.access) return;
    try {
      const st = await cc("notif.status");
      if (st.access) { notifs.status = st; renderNotifCard(); return loadNotifList(); }
    } catch {}
  }
}

function onNotifEvent(ev) {
  if (ev.op === "removed") {
    notifs.items.delete(ev.key);
    closeNotifToast(ev.key);
  } else {
    notifs.items.set(ev.key, ev);
    if (smsDefaultPkg() === ev.pkg) smsList = null; // Messages tab reloads with the new SMS
    if (ev.alert !== false && (ev.importance == null || ev.importance >= 3) && notifs.popups && !notifs.muted.has(ev.pkg)) popNotif(ev);
    else if (notifs.toasts.has(ev.key)) popNotif(ev, true);
  }
  updateNotifBadge();
  if (current === "notifs") renderNotifs();
}
const smsDefaultPkg = () => companionInfo?.defaultSmsApp || "";

function updateNotifBadge() {
  const b = $("ntBadge"); const n = notifs.items.size;
  b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n);
}

function appIcon(pkg) {
  const c = notifs.icons.get(pkg);
  if (c) return c.promise;
  const entry = { promise: cc("notif.icon", { pkg }).then((r) => { entry.app = r.app; entry.url = r.icon ? `data:image/png;base64,${r.icon}` : ""; return entry; }).catch(() => entry) };
  notifs.icons.set(pkg, entry);
  return entry.promise;
}

function renderNotifs() {
  const list = $("ntList"); if (!list) return;
  if (!adb || !notifs.on || !notifs.status?.access) { list.replaceChildren(); $("ntBar").hidden = true; return; }
  $("ntBar").hidden = false;
  const q = $("ntSearch").value.trim().toLowerCase(), appSel = $("ntApp").value;
  const all = [...notifs.items.values()].sort((a, b) => b.time - a.time);
  const apps = [...new Map(all.map((n) => [n.pkg, n.app])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  $("ntApp").replaceChildren(el("option", { value: "", textContent: `All apps (${all.length})` }),
    ...apps.map(([pkg, app]) => el("option", { value: pkg, textContent: `${app} (${all.filter((n) => n.pkg === pkg).length})`, selected: pkg === appSel })));
  const shown = all.filter((n) => (!appSel || n.pkg === appSel) &&
    (!q || [n.app, n.title, n.text, ...(n.messages || []).map((m) => m.text)].join(" ").toLowerCase().includes(q)));
  list.replaceChildren(...(shown.length ? shown.map((n) => notifCard(n, false)) : [el("div", { className: "card empty", textContent: all.length ? "Nothing matches." : "No notifications on the phone." })]));
}
$("ntSearch").addEventListener("input", renderNotifs);
$("ntApp").addEventListener("change", renderNotifs);
$("ntReload").addEventListener("click", () => loadNotifList());
armedClick($("ntClear"), async () => {
  const keys = [...notifs.items.values()].filter((n) => n.clearable).map((n) => n.key);
  if (!keys.length) return;
  await cc("notif.dismiss", { keys });
  toast(`Cleared ${keys.length} notifications on the phone`);
});

function notifCard(n, popup) {
  const icon = el("span", { className: "ph" });
  appIcon(n.pkg).then((e) => { if (e.url) icon.replaceWith(el("img", { src: e.url, alt: "" })); });
  const head = el("div", { className: "nh" }, icon, el("span", { className: "an", textContent: n.app }),
    el("span", { textContent: `· ${fmtDate(n.time)}` }), el("span", { className: "sp" }));
  if (!popup) {
    const mute = el("button", { type: "button", textContent: notifs.muted.has(n.pkg) ? "Unmute" : "Mute", title: `Pop-ups from ${n.app}` });
    mute.onclick = () => {
      notifs.muted.has(n.pkg) ? notifs.muted.delete(n.pkg) : notifs.muted.add(n.pkg);
      lsSet("andromon.notifMuted", [...notifs.muted]); renderNotifs(); renderNotifCard();
    };
    head.append(mute);
  }
  if (n.clearable || popup) {
    const x = el("button", { type: "button", textContent: "✕", title: popup ? "Close" : "Dismiss on the phone" });
    x.onclick = () => popup ? closeNotifToast(n.key) : cc("notif.dismiss", { keys: [n.key] }).catch(showError);
    head.append(x);
  }
  const body = el("div", { style: "min-width:0;flex:1" });
  if (n.title) body.append(el("div", { className: "nt", textContent: n.title }));
  if (n.messages?.length) {
    const msgs = n.messages.slice(popup ? -3 : -6);
    body.append(el("div", { className: "msgs" }, ...msgs.map((m) => el("div", { className: m.me ? "me" : "" },
      n.conversation || m.me || (m.sender && m.sender !== n.title) ? el("b", { textContent: `${m.me ? "You" : m.sender}: ` }) : "", m.text))));
  } else if (n.lines?.length) {
    body.append(el("div", { className: "msgs" }, ...n.lines.slice(popup ? -3 : -8).map((l) => el("div", { textContent: l }))));
  } else if (n.text) body.append(el("div", { className: "nx", textContent: n.text }));
  const b = el("div", { className: "nb" });
  if (n.largeIcon) b.append(el("img", { className: "av", src: `data:image/png;base64,${n.largeIcon}`, alt: "" }));
  b.append(body);
  const card = el("div", { className: "ncard" }, head, b);
  const acts = el("div", { className: "na" });
  const reply = n.actions?.find((a) => a.reply);
  let rbox = null;
  const openReply = () => {
    if (rbox) { rbox.querySelector("input")?.focus(); return; }
    rbox = replyBox(n, reply, () => { if (popup) closeNotifToast(n.key); });
    card.append(rbox); rbox.querySelector("input").focus();
    if (popup) notifs.toasts.get(n.key)?.hold();
  };
  if (reply) { const r = el("button", { className: "btn sm primary", type: "button", textContent: reply.title || "Reply" }); r.onclick = openReply; acts.append(r); }
  for (const a of (n.actions || []).filter((a) => !a.reply).slice(0, 3)) {
    const btn = el("button", { className: "btn sm", type: "button", textContent: a.title });
    btn.onclick = async () => {
      busy(btn, true, "…");
      try { await cc("notif.action", { key: n.key, action: a.i }); toast(`${a.title} · ${n.app}`); if (popup) closeNotifToast(n.key); }
      catch (e) { showError(e); } finally { if (btn.isConnected) busy(btn, false); }
    };
    acts.append(btn);
  }
  if (acts.childElementCount) card.append(acts);
  card.openReply = openReply;
  return card;
}

const replyToast = (n, r) => r?.via === "sms" ? `SMS sent to ${r.to}`
  : r?.opensScreen ? `Sent to ${n.app}. It finishes on the phone's screen, so unlock the phone if it doesn't go.` : `Replied in ${n.app}`;

function replyBox(n, action, done) {
  const input = el("input", { type: "text", placeholder: `Reply to ${n.title || n.app}…`, maxLength: 2000 });
  const send = el("button", { className: "btn sm primary", type: "submit", textContent: "Send" });
  const go = async (text) => {
    text = text.trim(); if (!text) return;
    busy(send, true, "…");
    try {
      toast(replyToast(n, await cc("notif.reply", { key: n.key, action: action.i, text }))); input.value = ""; done?.();
    } catch (e) { showError(e); }
    finally { if (send.isConnected) busy(send, false); }
  };
  const form = el("form", {}, input, send);
  form.onsubmit = (e) => { e.preventDefault(); go(input.value); };
  const chips = el("div", { className: "chips" }, ...notifs.quick.map((q) => {
    const c = el("button", { className: "chip", type: "button", textContent: q, title: "Send this reply" });
    c.onclick = () => go(q);
    return c;
  }));
  return el("div", { className: "rbox" }, chips, form);
}

// Pop-ups: newest at the bottom of the stack (above a call card), at most three, each for 8 s
// unless the pointer is on it or a reply is being written.
function popNotif(n, updateOnly = false) {
  const old = notifs.toasts.get(n.key);
  // The same message can arrive twice in a row (its own alert, then its group's): don't notify twice.
  if (old && Date.now() - old.shownAt < 3000) updateOnly = true;
  const card = notifCard(n, true);
  if (old) { clearTimeout(old.timer); old.el.replaceWith(card); }
  else if (updateOnly) return;
  else $("popStack").insertBefore(card, $("callPop"));
  const t = { el: card, timer: 0, held: false, shownAt: updateOnly && old ? old.shownAt : Date.now() };
  t.arm = () => { clearTimeout(t.timer); if (!t.held) t.timer = setTimeout(() => closeNotifToast(n.key), 8000); };
  t.hold = () => { t.held = true; clearTimeout(t.timer); };
  card.addEventListener("mouseenter", () => clearTimeout(t.timer));
  card.addEventListener("mouseleave", () => t.arm());
  notifs.toasts.set(n.key, t); t.arm();
  while (notifs.toasts.size > 3) closeNotifToast(notifs.toasts.keys().next().value);
  if (!updateOnly && !document.hasFocus()) {
    const id = `n${++notifs.seq}`; notifs.sysIds.set(id, n.key);
    if (notifs.sysIds.size > 50) notifs.sysIds.delete(notifs.sysIds.keys().next().value);
    const last = n.messages?.at(-1);
    notifyApi?.show({ id, title: n.title ? `${n.title} · ${n.app}` : n.app, body: last ? (!last.me && last.sender && last.sender !== n.title ? `${last.sender}: ${last.text}` : last.text) : n.text || "",
      reply: !!n.actions?.some((a) => a.reply), icon: n.largeIcon ? `data:image/png;base64,${n.largeIcon}` : notifs.icons.get(n.pkg)?.url || "" }).catch(() => {});
  }
}

function closeNotifToast(key) {
  const t = notifs.toasts.get(key); if (!t) return;
  clearTimeout(t.timer); t.el.remove(); notifs.toasts.delete(key);
}

// ---------- screen mirror (scrcpy) ----------
// Uses the open-source scrcpy server (Apache-2.0, renderer/scrcpy-server.jar, v3.3.3 to match
// @yume-chan/scrcpy). It runs on the phone as a shell process via app_process (nothing is
// installed), captures the screen with MediaCodec (H.264) and streams it over the ADB link.
// We decode with WebCodecs (hardware) and send touches/keys back over the control socket.
const SCRCPY_VERSION = "3.3.3";
const MIRROR_QUALITY = {
  fast: { maxSize: 1280, videoBitRate: 4_000_000 },
  balanced: { maxSize: 1920, videoBitRate: 8_000_000 },
  sharp: { maxSize: 0, videoBitRate: 16_000_000 },
};
let mirror = null; // { client, decoder, canvas, controller, screenOff, stopping }

// The options on the mirror page, remembered between launches; Settings edits the same ones.
const mirrorPrefs = {
  QUALITY: [["fast", "Fast (720p · 4 Mbps)"], ["balanced", "Balanced (1080p · 8 Mbps)"], ["sharp", "Sharp (full resolution · 16 Mbps)"]],
  SOURCE: [["screen", "Phone screen"], ["back", "Back camera"], ["front", "Front camera"]],
  FPS: [["60", "Up to 60 a second"], ["30", "Up to 30 a second"], ["15", "Up to 15 a second"]],
  CODEC: [["h264", "H.264 (works everywhere)"], ["h265", "H.265 (sharper at the same speed)"]],
  get() {
    let p = {}; try { p = JSON.parse(localStorage.getItem("andromon.mirror")) || {}; } catch {}
    const one = (list, v, d) => (list.some(([id]) => id === String(v)) ? v : d);
    return {
      quality: one(this.QUALITY, p.quality, "balanced"), source: one(this.SOURCE, p.source, "screen"),
      audio: p.audio !== false, screenOff: p.screenOff === true, fps: Number(one(this.FPS, p.fps, 60)),
      codec: one(this.CODEC, p.codec, "h264"), touches: p.touches === true, awake: p.awake !== false,
      lockOnStop: p.lockOnStop === true, clipboard: p.clipboard !== false,
    };
  },
  set(patch) {
    try { localStorage.setItem("andromon.mirror", JSON.stringify({ ...this.get(), ...patch })); } catch {}
    this.show();
  },
  // The mirror page only says what is chosen; the options themselves are in Settings.
  show() {
    const p = this.get(), label = (list, v) => list.find(([id]) => id === String(v))?.[1] || "";
    $("mirrorSummary").replaceChildren(...[
      ["Quality", label(this.QUALITY, p.quality)], ["Show", label(this.SOURCE, p.source)],
      ["Sound", p.audio ? "Plays on this computer" : "Off"], ["Phone screen", p.screenOff ? "Turns off while mirroring" : "Stays on"],
      ["Frame rate", label(this.FPS, p.fps)], ["Video", p.codec === "h265" ? "H.265" : "H.264"],
    ].flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  },
};
mirrorPrefs.show();
$("mirrorSettings").addEventListener("click", () => show("settings"));
// A control's label sits in a <span> beside its icon.
const keyLabel = (btn, text) => { btn.querySelector("span").textContent = text; };

// The control grid: [key, label, tooltip, icon] in named groups. What each does is in KEY_BUTTONS below.
const MIRROR_KEYS = [
  ["Navigation", [["back", "Back", "Back (Esc or right-click)", "arrow-left"], ["home", "Home", "Home", "circle"], ["recents", "Recents", "Recent apps", "square"],
    ["menu", "Menu", "Menu key", "menu"], ["notif", "Notifications", "Open the notification shade", "bell"], ["quick", "Quick settings", "Open the quick settings", "sliders-horizontal"],
    ["closepanels", "Close panels", "Close the notification shade and quick settings", "panel-top-close"]]],
  ["Sound and power", [["voldown", "Vol −", "Volume down", "volume-1"], ["volup", "Vol +", "Volume up", "volume-2"], ["mutephone", "Mute phone", "Mute or unmute the phone's own sound", "volume-x"],
    ["power", "Power", "Power button", "power"], ["lock", "Lock", "Lock the phone (screen off)", "lock"], ["screen", "Screen off", "Turn the phone's own display off or on; mirroring continues", "eye-off", "mirrorScreenToggle"]]],
  ["Media and brightness", [["prev", "Previous", "Previous track", "skip-back"], ["play", "Play / pause", "Play or pause", "play"], ["next", "Next", "Next track", "skip-forward"],
    ["bdown", "Dimmer", "Brightness down", "sun-dim"], ["bup", "Brighter", "Brightness up", "sun"], ["rotate", "Rotate", "Rotate the phone's screen", "rotate-ccw"]]],
  ["View", [["full", "Full screen", "Fill this computer's screen", "maximize"], ["zoom", "Actual size", "Show the picture at its real size, or fit it to the window", "zoom-in"],
    ["ontop", "Keep on top", "Keep this window above other windows while mirroring", "pin"]]],
  ["Capture", [["shot", "Save frame", "Save the current picture as a PNG file", "camera"], ["copyframe", "Copy frame", "Copy the current picture to this computer's clipboard", "copy"],
    ["paste", "Paste", "Paste this computer's clipboard text on the phone", "clipboard-paste"], ["audio", "Mute", "Mute or unmute the phone's sound on this computer", "headphones"]]],
];
$("mirrorKeys").replaceChildren(...MIRROR_KEYS.flatMap(([group, keys]) => [
  el("div", { className: "mr-grp", textContent: group }),
  ...keys.map(([k, label, title, ic, id]) => {
    const b = el("button", { className: "mr-key", type: "button", title }, icon(ic), el("span", { textContent: label }));
    b.dataset.k = k; if (id) b.id = id;
    return b;
  }),
]), (() => {
  const b = el("button", { className: "mr-key mr-rec", type: "button", id: "mirrorRecord", title: "Record the mirrored screen (and sound) to an MP4 file" }, icon("circle-dot"), el("span", { textContent: "Record" }));
  b.dataset.k = "record"; return b;
})());

function mirrorUi(on) {
  $("mirrorStart").hidden = on; $("mirrorStop").hidden = !on;
  $("mirrorText").disabled = !on; $("mirrorType").querySelector("button").disabled = !on;
  if (!on) { // the view options end with the mirroring
    $("mirrorStage").classList.remove("actual");
    for (const k of ["zoom", "ontop"]) $("mirrorKeys").querySelector(`[data-k="${k}"]`).classList.remove("on");
    globalThis.andromon?.win?.setOnTop(false).catch(() => {});
  }
  $("mirrorKeys").querySelector('[data-k="audio"]').hidden = true;
  recUi(null);
  for (const b of $("mirrorKeys").querySelectorAll("button")) b.disabled = !on;
  $("mirrorIdle").hidden = on; $("mirrorStage").hidden = !on;
  $("mirrorRoot").classList.toggle("on", on);
  if (!on) { $("mirrorInfo").textContent = "Not mirroring"; keyLabel($("mirrorScreenToggle"), "Screen off"); $("mirrorScreenToggle").classList.remove("on"); }
  autotest?.onMirror(on);
}
mirrorUi(false);

async function startMirror() {
  if (!adb || mirror) return;
  if (!WebCodecsVideoDecoder.isSupported) throw new Error("This computer's browser engine can't decode video (WebCodecs missing).");
  const btn = $("mirrorStart"); busy(btn, true, "Starting…");
  const info = $("mirrorInfo"); info.textContent = "Uploading the mirroring server…";
  let client;
  try {
    const res = await fetch("scrcpy-server.jar");
    if (!res.ok) throw new Error("scrcpy-server.jar is missing from this build of Andromon.");
    const jar = await res.blob();
    await AdbScrcpyClient.pushServer(adb, jar.stream(), DefaultServerPath);

    info.textContent = "Starting…";
    const prefs = mirrorPrefs.get(); // Settings › Screen mirror
    const q = MIRROR_QUALITY[prefs.quality] || MIRROR_QUALITY.balanced;
    const source = prefs.source; // screen | back | front
    // H.265 only when this computer can decode it; a phone that can't encode it falls back below.
    let codec = prefs.codec;
    if (codec === "h265" && !(await VideoDecoder.isConfigSupported({ codec: "hev1.1.6.L120.B0" }).then((r) => r.supported, () => false))) {
      codec = "h264"; toast("This computer can't play H.265; using H.264");
    }
    const options = (videoCodec) => new AdbScrcpyOptions3_3_3({
      ...q,
      maxFps: prefs.fps,
      videoCodec,
      // Camera mirroring needs Android 12+. The phone's audio needs Android 11+ (with a camera
      // source, scrcpy records the microphone instead).
      ...(source === "screen" ? {} : { videoSource: "camera", cameraFacing: source }),
      audio: prefs.audio,
      audioCodec: "opus",
      control: true,
      stayAwake: prefs.awake,            // keep the screen on while mirroring (USB powered)
      clipboardAutosync: prefs.clipboard, // phone → PC copy
      powerOffOnClose: prefs.lockOnStop,
      showTouches: prefs.touches,
      logLevel: "info",
    }, { version: SCRCPY_VERSION });
    try { client = await AdbScrcpyClient.start(adb, DefaultServerPath, options(codec)); }
    catch (e) {
      if (codec === "h264" || !(e instanceof AdbScrcpyExitedError)) throw e;
      toast("This phone can't send H.265; using H.264");
      client = await AdbScrcpyClient.start(adb, DefaultServerPath, options("h264"));
    }
  } catch (e) {
    busy(btn, false); info.textContent = "Not mirroring";
    if (e instanceof AdbScrcpyExitedError) {
      const tail = e.output.filter(Boolean).slice(-6).join("\n");
      throw new Error("The phone refused to start screen capture:\n" + (tail || "no output"));
    }
    throw e;
  }

  // Server log: must be read so the connection never stalls; keep the tail for errors.
  const log = [];
  client.output.pipeTo(new WritableStream({ write(line) { log.push(line); if (log.length > 40) log.shift(); console.debug("[scrcpy]", line); } })).catch(() => {});

  const canvas = $("mirrorCanvas");
  const renderer = WebGLVideoFrameRenderer.isSupported ? new WebGLVideoFrameRenderer(canvas) : new BitmapVideoFrameRenderer(canvas);
  const video = await client.videoStream;
  const decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec, renderer });
  const controller = client.controller;
  const m = mirror = { client, decoder, canvas, controller, screenOff: false, stopping: false, log, videoConfig: null, rec: null, audio: null };

  const showSize = () => {
    info.textContent = `${video.metadata.deviceName || "Phone"} · ${decoder.width || video.width}×${decoder.height || video.height}`;
  };
  decoder.sizeChanged(showSize);
  // Every packet also passes by the recorder, which copies it into an MP4 while recording is on.
  const tap = new TransformStream({ transform(packet, ctl) { recordVideoPacket(m, packet); ctl.enqueue(packet); } });
  video.stream.pipeThrough(tap).pipeTo(decoder.writable).catch((e) => { if (mirror && !mirror.stopping) console.warn("video stream ended", e); });
  // The audio stream must always be consumed (or it stalls the connection), even if it fails to start.
  client.audioStream?.then((meta) => startAudio(m, meta)).catch((e) => console.warn("audio", e));

  if (client.clipboard) {
    // Text copied on the phone lands in the PC clipboard.
    client.clipboard.pipeTo(new WritableStream({
      write(text) { navigator.clipboard.writeText(text).then(() => toast("Copied from phone"), () => {}); },
    })).catch(() => {});
  }

  client.exited.then(() => {
    if (!mirror || mirror.stopping) return;
    const tail = mirror.log.filter((l) => /error|exception/i.test(l)).slice(-3).join("\n");
    stopMirror();
    showError("Screen mirroring ended" + (tail ? ":\n" + tail : ". The phone may have locked or disconnected."));
  });

  busy(btn, false);
  mirrorUi(true); showSize();
  canvas.focus();
  if (mirrorPrefs.get().screenOff) setPhoneScreen(false);
}

async function stopMirror(message) {
  const m = mirror; if (!m) return;
  m.stopping = true; mirror = null;
  await stopRecording(m); // save what was recorded so far
  try { if (m.screenOff) await m.controller?.setScreenPowerMode(AndroidScreenPowerMode.Normal); } catch {}
  try { await m.client.close(); } catch {}
  try { m.decoder.dispose(); } catch {}
  stopAudio(m);
  mirrorUi(false);
  if (message) toast(message);
}

// --- phone audio (scrcpy, Opus) -> WebCodecs AudioDecoder -> Web Audio ---
let audioMuted = false;
function startAudio(m, meta) {
  if (meta.type !== "success") {
    if (meta.type === "errored" && !m.stopping) toast("Phone audio isn't available: it needs Android 11+ and an unlocked phone when mirroring starts");
    return;
  }
  const sink = new WritableStream({ write(packet) { m.audio?.write(packet); } });
  if (m.stopping || typeof AudioDecoder === "undefined") { meta.stream.pipeTo(sink).catch(() => {}); return; }
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const gain = ctx.createGain(); gain.gain.value = audioMuted ? 0 : 1; gain.connect(ctx.destination);
  let next = 0;
  const decoder = new AudioDecoder({
    output(data) {
      try {
        const buf = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
        for (let c = 0; c < data.numberOfChannels; c++) data.copyTo(buf.getChannelData(c), { planeIndex: c, format: "f32-planar" });
        const now = ctx.currentTime;
        // Keep ~60 ms of buffer; if playback fell behind or a backlog built up, restart the schedule.
        if (next < now + 0.01 || next > now + 0.35) next = now + 0.06;
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(gain); src.start(next);
        next += buf.duration;
      } finally { data.close(); }
    },
    error(e) { console.warn("audio decoder", e); },
  });
  decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
  ctx.resume().catch(() => {});
  m.audio = {
    ctx, gain, decoder,
    write(packet) {
      if (packet.type !== "data") return;
      recordAudioPacket(m, packet);
      if (decoder.state === "configured") decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Number(packet.pts ?? 0n), data: packet.data }));
    },
  };
  $("mirrorKeys").querySelector('[data-k="audio"]').hidden = false;
  meta.stream.pipeTo(sink).catch(() => {});
}
function stopAudio(m) {
  const a = m.audio; if (!a) return;
  m.audio = null;
  try { a.decoder.close(); } catch {}
  a.ctx.close().catch(() => {});
}
function setMuted(on) {
  audioMuted = on;
  if (mirror?.audio) mirror.audio.gain.gain.value = on ? 0 : 1;
  const mute = $("mirrorKeys").querySelector('[data-k="audio"]');
  keyLabel(mute, on ? "Unmute" : "Mute"); mute.classList.toggle("on", on);
}

// --- recording to MP4 (Mediabunny muxes the phone's own H.264 + Opus packets; nothing is re-encoded) ---
const REC_LIMIT = 1.5 * 1024 ** 3; // the file is built in memory; stop before it gets too big
const hex2 = (n) => n.toString(16).padStart(2, "0");
const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const fileStamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function startRecording() {
  const m = mirror; if (!m || m.rec) return;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const video = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(video);
  let audio = null;
  if (m.audio) { audio = new EncodedAudioPacketSource("opus"); output.addAudioTrack(audio); }
  await output.start();
  const rec = m.rec = { output, video, audio, t0: null, bytes: 0, started: 0, queue: Promise.resolve(), error: null, audioStarted: false, stopping: false };
  // Packets must reach the muxer in order, one at a time.
  rec.add = (source, packet, meta) => {
    rec.bytes += packet.data.byteLength;
    rec.queue = rec.queue.then(() => source.add(packet, meta)).catch((e) => { rec.error ||= e; });
    if (rec.bytes > REC_LIMIT) stopRecording(m, "Recording stopped at 1.5 GB and saved. Start a new one to keep going.");
  };
  // Ask the phone for a key frame now rather than waiting for the next one (up to 10 s).
  m.controller?.resetVideo?.().catch(() => {});
  rec.timer = setInterval(() => recUi(m), 500);
  recUi(m);
}

function recordVideoPacket(m, packet) {
  if (packet.type === "configuration") {
    const changed = m.rec?.t0 != null && m.videoConfig && !bytesEqual(m.videoConfig, packet.data);
    m.videoConfig = packet.data;
    if (changed) stopRecording(m, "Recording saved: the picture size changed (rotation). Start a new recording for the new size.");
    return;
  }
  const rec = m.rec; if (!rec || rec.stopping || packet.pts == null) return;
  if (rec.t0 == null) {
    // Start on a key frame, with the SPS/PPS in front so the file is self-contained.
    if (!packet.keyframe || !m.videoConfig) return;
    rec.t0 = packet.pts; rec.started = Date.now();
    const cfg = h264ParseConfiguration(m.videoConfig);
    const data = new Uint8Array(m.videoConfig.length + packet.data.length);
    data.set(m.videoConfig); data.set(packet.data, m.videoConfig.length);
    rec.add(rec.video, new EncodedPacket(data, "key", 0, 0), {
      decoderConfig: {
        codec: `avc1.${hex2(cfg.profileIndex)}${hex2(cfg.constraintSet)}${hex2(cfg.levelIndex)}`,
        codedWidth: cfg.croppedWidth, codedHeight: cfg.croppedHeight,
      },
    });
    return;
  }
  const ts = Number(packet.pts - rec.t0) / 1e6;
  if (ts < 0) return;
  rec.add(rec.video, new EncodedPacket(packet.data, packet.keyframe ? "key" : "delta", ts, 0));
}

function recordAudioPacket(m, packet) {
  const rec = m.rec;
  if (!rec || rec.stopping || !rec.audio || rec.t0 == null || packet.pts == null) return;
  const ts = Number(packet.pts - rec.t0) / 1e6;
  if (ts < 0) return;
  const meta = rec.audioStarted ? undefined : { decoderConfig: { codec: "opus", numberOfChannels: 2, sampleRate: 48000 } };
  rec.audioStarted = true;
  rec.add(rec.audio, new EncodedPacket(packet.data, "key", ts, 0.02), meta);
}

async function stopRecording(m, message) {
  const rec = m?.rec; if (!rec || rec.stopping) return;
  rec.stopping = true; m.rec = null;
  clearInterval(rec.timer);
  recUi(m);
  try {
    await rec.queue;
    if (rec.t0 == null) { await rec.output.cancel(); toast("Nothing was recorded yet"); return; }
    if (rec.error) throw rec.error;
    await rec.output.finalize();
    const buf = rec.output.target.buffer;
    download(new Blob([buf], { type: "video/mp4" }), `recording-${fileStamp()}.mp4`);
    toast(message || `Saved recording (${fmtSize(buf.byteLength)})`);
  } catch (e) {
    showError(new Error("Couldn't save the recording: " + (e?.message || e)));
  }
}

function recUi(m) {
  const b = $("mirrorRecord");
  const rec = m === mirror ? m?.rec : null;
  b.classList.toggle("rec-on", !!rec);
  if (!rec) { keyLabel(b, "Record"); return; }
  if (rec.t0 == null) { keyLabel(b, "Waiting for picture…"); return; }
  const s = Math.floor((Date.now() - rec.started) / 1000);
  keyLabel(b, `Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · ${fmtSize(rec.bytes)}`);
}

function setPhoneScreen(on) {
  if (!mirror?.controller) return;
  mirror.controller.setScreenPowerMode(on ? AndroidScreenPowerMode.Normal : AndroidScreenPowerMode.Off).catch(showError);
  mirror.screenOff = !on;
  keyLabel($("mirrorScreenToggle"), on ? "Screen off" : "Screen on"); $("mirrorScreenToggle").classList.toggle("on", !on);
}

// --- input: mouse / touch / pen -> Android touches ---
function videoPoint(e) {
  const r = mirror.canvas.getBoundingClientRect();
  const w = mirror.decoder.width || mirror.canvas.width, h = mirror.decoder.height || mirror.canvas.height;
  return {
    pointerX: Math.max(0, Math.min(w, ((e.clientX - r.left) / r.width) * w)),
    pointerY: Math.max(0, Math.min(h, ((e.clientY - r.top) / r.height) * h)),
    videoWidth: w, videoHeight: h,
  };
}
// The same point as fractions of the screen (0..1), for test recording.
function mirrorFrac(e) {
  const p = videoPoint(e);
  return { x: p.pointerX / p.videoWidth, y: p.pointerY / p.videoHeight };
}
function sendTouch(e, action) {
  if (!mirror?.controller) return;
  // Mouse clicks act as a finger (like scrcpy); real touch/pen keep their own pointer ids for multi-touch.
  const pointerId = e.pointerType === "mouse" ? ScrcpyPointerId.Finger : BigInt(e.pointerId);
  mirror.controller.injectTouch({
    action, pointerId, ...videoPoint(e),
    pressure: action === AndroidMotionEventAction.Up ? 0 : 1,
    actionButton: 0, buttons: 0,
  }).catch(() => {});
}
const mc = $("mirrorCanvas");
mc.addEventListener("pointerdown", (e) => {
  if (!mirror) return;
  mc.focus();
  // While a test is being recorded, the gesture is recorded first and then performed (see autotest.js).
  if (autotest?.capturePointer("down", e, mirrorFrac(e))) { e.preventDefault(); mc.setPointerCapture(e.pointerId); return; }
  if (e.pointerType === "mouse" && e.button === 2) { pressBack(); return; } // right-click = Back
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault(); mc.setPointerCapture(e.pointerId);
  sendTouch(e, AndroidMotionEventAction.Down);
});
mc.addEventListener("pointermove", (e) => {
  if (!mirror) return;
  if (autotest?.capturePointer("move", e, mirrorFrac(e))) return;
  if (!mc.hasPointerCapture(e.pointerId)) return;
  sendTouch(e, AndroidMotionEventAction.Move);
});
for (const type of ["pointerup", "pointercancel"]) {
  mc.addEventListener(type, (e) => {
    if (!mirror) return;
    if (autotest?.capturePointer(type === "pointerup" ? "up" : "cancel", e, mirrorFrac(e))) {
      if (mc.hasPointerCapture(e.pointerId)) mc.releasePointerCapture(e.pointerId);
      return;
    }
    if (!mc.hasPointerCapture(e.pointerId)) return;
    sendTouch(e, AndroidMotionEventAction.Up);
    mc.releasePointerCapture(e.pointerId);
  });
}
mc.addEventListener("contextmenu", (e) => e.preventDefault());
mc.addEventListener("wheel", (e) => {
  if (!mirror?.controller) return;
  e.preventDefault();
  if (autotest?.captureWheel(e, mirrorFrac(e))) return;
  const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100; // lines / pages / pixels → notches
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  mirror.controller.injectScroll({
    ...videoPoint(e), scrollX: clamp(-e.deltaX / unit), scrollY: clamp(-e.deltaY / unit), buttons: 0,
  }).catch(() => {});
}, { passive: false });

// --- input: keyboard ---
// Printable characters are sent as text (respects the PC keyboard layout); other keys as Android key codes.
function sendKey(keyCode, action, metaState = 0) {
  return mirror?.controller?.injectKeyCode({ action, keyCode, repeat: 0, metaState }).catch(() => {});
}
async function pressKey(keyCode) {
  await sendKey(keyCode, AndroidKeyEventAction.Down);
  await sendKey(keyCode, AndroidKeyEventAction.Up);
}
async function pressBack() {
  // Back, or wake the screen if it is off.
  await mirror?.controller?.backOrScreenOn(AndroidKeyEventAction.Down).catch(() => {});
  await mirror?.controller?.backOrScreenOn(AndroidKeyEventAction.Up).catch(() => {});
}
const META = (e) => (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 0x1000 : 0);
mc.addEventListener("keydown", (e) => {
  if (!mirror || e.isComposing) return;
  if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) return; // handled by the paste event
  if (autotest?.captureKey(e)) return;
  if (e.metaKey) return; // leave Cmd shortcuts to the PC
  if (e.key === "Escape") { e.preventDefault(); if (!e.repeat) pressBack(); return; }
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); mirror.controller?.injectText(e.key).catch(() => {}); return;
  }
  const code = AndroidKeyCode[e.code];
  if (code === undefined) return;
  e.preventDefault();
  mirror.controller?.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: code, repeat: e.repeat ? 1 : 0, metaState: META(e) }).catch(() => {});
});
mc.addEventListener("keyup", (e) => {
  if (!mirror || e.metaKey || e.key === "Escape" || (e.key.length === 1 && !e.ctrlKey && !e.altKey)) return;
  const code = AndroidKeyCode[e.code];
  if (code === undefined) return;
  e.preventDefault(); sendKey(code, AndroidKeyEventAction.Up, META(e));
});
document.addEventListener("paste", (e) => {
  if (!mirror?.controller || document.activeElement !== mc) return;
  const text = e.clipboardData?.getData("text/plain");
  if (!text) return;
  e.preventDefault();
  if (autotest?.capturePaste(text)) return;
  // Put the PC clipboard on the phone and paste it into the focused field.
  mirror.controller.setClipboard({ sequence: 0n, paste: true, content: text }).catch(showError);
});

// --- toolbar ---
$("mirrorStart").addEventListener("click", () => startMirror().catch(showError));
$("mirrorStop").addEventListener("click", () => stopMirror());
const KEY_BUTTONS = {
  back: pressBack,
  home: () => pressKey(AndroidKeyCode.AndroidHome),
  recents: () => pressKey(AndroidKeyCode.AndroidAppSwitch),
  voldown: () => pressKey(AndroidKeyCode.VolumeDown),
  volup: () => pressKey(AndroidKeyCode.VolumeUp),
  power: () => pressKey(AndroidKeyCode.Power),
  notif: () => mirror?.controller?.expandNotificationPanel(),
  rotate: () => mirror?.controller?.rotateDevice(),
  screen: () => setPhoneScreen(mirror?.screenOff),
  shot: async () => {
    const blob = await mirror?.decoder.snapshot();
    if (blob) download(blob, `mirror-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  },
  record: () => (mirror?.rec ? stopRecording(mirror) : startRecording()),
  audio: () => setMuted(!audioMuted),
  full: () => $("mirrorStage").requestFullscreen?.().catch(showError),
  // Keys the phone understands by number (Android's KeyEvent codes), sent as a shell command.
  menu: () => sh("input keyevent 82"), mutephone: () => sh("input keyevent 164"), lock: () => sh("input keyevent 223"),
  prev: () => sh("input keyevent 88"), play: () => sh("input keyevent 85"), next: () => sh("input keyevent 87"),
  bdown: () => sh("input keyevent 220"), bup: () => sh("input keyevent 221"),
  quick: () => mirror?.controller?.expandSettingPanel(),
  closepanels: () => mirror?.controller?.collapseNotificationPanel(),
  zoom: () => { const on = $("mirrorStage").classList.toggle("actual"); mirrorKey("zoom").classList.toggle("on", on); keyLabel(mirrorKey("zoom"), on ? "Fit window" : "Actual size"); },
  ontop: async () => {
    const b = mirrorKey("ontop"), on = !b.classList.contains("on");
    await globalThis.andromon?.win?.setOnTop(on);
    b.classList.toggle("on", on);
  },
  copyframe: async () => {
    const blob = await mirror?.decoder.snapshot(); if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Picture copied");
  },
  paste: async () => {
    const text = await navigator.clipboard.readText();
    if (!text) return toast("This computer's clipboard has no text");
    await mirror?.controller?.setClipboard({ sequence: 0n, paste: true, content: text });
  },
};
const mirrorKey = (k) => $("mirrorKeys").querySelector(`[data-k="${k}"]`);
// The text box under the controls: whatever is typed there is pasted on the phone, in any language.
$("mirrorType").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("mirrorText").value; if (!text || !mirror?.controller) return;
  mirror.controller.setClipboard({ sequence: 0n, paste: true, content: text }).then(() => { $("mirrorText").value = ""; }, showError);
});
$("mirrorKeys").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-k]"); if (!b || !mirror) return;
  Promise.resolve(KEY_BUTTONS[b.dataset.k]?.()).catch(showError);
  if (b.dataset.k !== "full" && b.dataset.k !== "paste") mc.focus();
});

// The Screenshot page lives in ./screenshot.js (set up at the end of this file).
let shotTab = null;

// The ADB shell page lives in ./shell.js (set up at the end of this file).

// ---------- debloat (community package list from Universal Android Debloater Next Generation) ----------
// The list (GPL-3.0) is not bundled: it's downloaded from the UAD-ng GitHub repository when the user
// asks for it and cached locally. Each entry says what a package does and how safe it is to remove.
// "Remove" uninstalls the package for the current user only (pm uninstall -k --user 0): the APK stays
// on the system partition, so it can always be restored here, and a factory reset brings it back.
const UAD_URL = "https://raw.githubusercontent.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation/main/resources/assets/uad_lists.json";
const UAD_CACHE = "andromon-uad-v1";
const SAFETY = {
  Recommended: { rank: 1, hint: "Safe to remove for most people." },
  Advanced: { rank: 2, hint: "Removes a feature you may use. Read the description." },
  Expert: { rank: 3, hint: "Can break things. Only if you know what it does." },
  Unsafe: { rank: 4, hint: "Can break the phone or make it bootloop. Don't remove." },
  Unlisted: { rank: 5, hint: "Not reviewed yet." },
};
const STATUS_LABEL = { installed: "Installed", disabled: "Disabled", removed: "Removed" };
let debloat = { list: null, fetchedAt: null, phone: null, safety: "Recommended", group: "", status: "present", q: "", selected: new Set() };

async function readUadCache() {
  try {
    const cache = await caches.open(UAD_CACHE);
    const res = await cache.match(UAD_URL);
    if (!res) return null;
    return { list: await res.json(), fetchedAt: Number(res.headers.get("x-fetched-at")) || null };
  } catch { return null; }
}
const downloadUadList = () => downloads.track("uad", "Debloat list", "raw.githubusercontent.com", (report, signal) => fetchUadList(report, signal));
async function fetchUadList(report, signal) {
  const res = await fetch(UAD_URL, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`Couldn't download the debloat list (HTTP ${res.status}).`);
  // Read in pieces so the download manager can show how much has arrived.
  const parts = []; let got = 0;
  for (const reader = res.body.getReader(); ;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length; report(got, 0);
  }
  const text = await new Blob(parts).text();
  const list = JSON.parse(text);
  if (!list || typeof list !== "object" || Array.isArray(list)) throw new Error("The debloat list has an unexpected format.");
  const fetchedAt = Date.now();
  try {
    const cache = await caches.open(UAD_CACHE);
    await cache.put(UAD_URL, new Response(text, { headers: { "content-type": "application/json", "x-fetched-at": String(fetchedAt) } }));
  } catch {}
  return { list, fetchedAt };
}

async function loadDebloat(force = false) {
  if (!debloat.list) {
    const cached = await readUadCache();
    if (cached) Object.assign(debloat, cached);
  }
  if (!debloat.list) { showDebloatIntro(); return; }
  $("dbIntro").hidden = true; $("dbMain").hidden = false;
  if (adb && (force || !debloat.phone || debloat.phone.serial !== adb.serial)) {
    $("dbRows").replaceChildren(loadingRow(5, "Reading packages on the phone…"));
    const [all, installed, disabled] = await Promise.all([
      sh("pm list packages --user 0 -u"), sh("pm list packages --user 0"), sh("pm list packages --user 0 -d").catch(() => ""),
    ]);
    const inst = new Set(pkgLines(installed)), dis = new Set(pkgLines(disabled));
    const status = new Map();
    for (const p of pkgLines(all)) status.set(p, !inst.has(p) ? "removed" : dis.has(p) ? "disabled" : "installed");
    debloat.phone = { serial: adb.serial, status };
    debloat.selected = new Set([...debloat.selected].filter((p) => status.has(p)));
  }
  renderDebloat();
}

function showDebloatIntro() {
  $("dbMain").hidden = true;
  const box = $("dbIntro"); box.hidden = false;
  const btn = el("button", { className: "btn primary", textContent: "Download the list", type: "button" });
  btn.onclick = async () => {
    busy(btn, true, "Downloading…");
    try { Object.assign(debloat, await downloadUadList()); await loadDebloat(true); }
    catch (e) { showError(e); }
    finally { if (btn.isConnected) busy(btn, false); }
  };
  box.replaceChildren(
    el("h2", { textContent: "Remove pre-installed apps you don't use" }),
    el("p", { className: "muted", textContent: "Andromon uses the package list from Universal Android Debloater Next Generation (UAD-ng), a community project. For thousands of pre-installed Google, manufacturer and carrier packages, it says what each one does and how safe it is to remove." }),
    el("ul", { className: "muted" },
      el("li", { textContent: "Removal is for your user only. Nothing is deleted from the system partition, so you can restore any package here, and a factory reset brings everything back." }),
      el("li", { textContent: "The list (about 2 MB) is downloaded from GitHub once and kept on this computer. It's GPL-3.0 licensed and isn't bundled with Andromon." }),
    ),
    btn,
  );
}

function debloatRows() {
  const st = debloat.phone?.status || new Map();
  const q = debloat.q.toLowerCase();
  const rows = [];
  for (const [pkg, e] of Object.entries(debloat.list)) {
    const status = st.get(pkg);
    if (!status) continue; // only packages that exist on this phone
    if (debloat.status === "present" && status === "removed") continue;
    if (debloat.status === "removed" && status !== "removed") continue;
    const safety = SAFETY[e?.removal] ? e.removal : "Unlisted";
    if (debloat.safety !== "all" && safety !== debloat.safety) continue;
    if (debloat.group && e?.list !== debloat.group) continue;
    const desc = typeof e?.description === "string" ? e.description : "";
    if (q && !pkg.toLowerCase().includes(q) && !desc.toLowerCase().includes(q)) continue;
    rows.push({ pkg, safety, group: typeof e?.list === "string" ? e.list : "", desc, status });
  }
  return rows.sort((a, b) => SAFETY[a.safety].rank - SAFETY[b.safety].rank || a.pkg.localeCompare(b.pkg));
}

function renderDebloat() {
  if (!debloat.list) return;
  // Icons need the companion; find out once, then draw again so the rows can ask for them.
  if (!iconSource && adb) checkIconSource().then((s) => { if (s === "ready" && current === "debloat") renderDebloat(); }, () => {});
  const rows = debloatRows();
  const st = debloat.phone?.status || new Map();
  const onPhone = Object.keys(debloat.list).filter((p) => st.has(p));
  $("dbCount").textContent = `${rows.length} shown · ${onPhone.length} listed packages on this phone · ${onPhone.filter((p) => st.get(p) === "removed").length} removed`
    + (debloat.fetchedAt ? ` · list from ${new Date(debloat.fetchedAt).toLocaleDateString()}` : "");
  $("dbSafetyHint").textContent = debloat.safety === "all" ? "" : SAFETY[debloat.safety].hint;
  const groups = [...new Set(Object.values(debloat.list).map((e) => e?.list).filter((x) => typeof x === "string"))].sort();
  const sel = $("dbGroup");
  if (sel.options.length !== groups.length + 1) {
    sel.replaceChildren(el("option", { value: "", textContent: "All sources" }), ...groups.map((g) => el("option", { value: g, textContent: g === "Oem" ? "Manufacturer" : g })));
    sel.value = debloat.group;
  }

  const trs = rows.slice(0, 600).map((r) => {
    const cb = el("input", { type: "checkbox", checked: debloat.selected.has(r.pkg) });
    cb.onchange = () => { cb.checked ? debloat.selected.add(r.pkg) : debloat.selected.delete(r.pkg); updateDebloatSelection(); };
    const desc = el("div", { className: "desc", textContent: r.desc || "No description." });
    desc.onclick = () => desc.classList.toggle("open");
    return el("tr", {},
      el("td", { style: "width:28px" }, cb),
      el("td", {}, appIdent(r.pkg), desc),
      el("td", { className: "hide-sm muted small", textContent: r.group === "Oem" ? "Manufacturer" : r.group }),
      el("td", {}, el("span", { className: `badge safety-${r.safety.toLowerCase()}`, textContent: r.safety, title: SAFETY[r.safety].hint })),
      el("td", { className: "small" + (r.status === "installed" ? " muted" : ""), textContent: STATUS_LABEL[r.status] }));
  });
  if (rows.length > 600) trs.push(el("tr", {}, el("td", { colSpan: 5, className: "empty", textContent: `Showing the first 600 of ${rows.length}. Search to narrow it down.` })));
  $("dbRows").replaceChildren(...(trs.length ? trs : [el("tr", {}, el("td", { colSpan: 5, className: "empty", textContent: "Nothing matches on this phone." }))]));
  updateDebloatSelection();
}

function updateDebloatSelection() {
  const n = debloat.selected.size;
  const st = debloat.phone?.status || new Map();
  const risky = [...debloat.selected].filter((p) => ["Expert", "Unsafe"].includes(debloat.list[p]?.removal));
  $("dbSelCount").textContent = n ? `${n} selected` : "";
  for (const id of ["dbRemove", "dbDisable", "dbRestore"]) $(id).disabled = !n || !adb;
  $("dbRestore").disabled = ![...debloat.selected].some((p) => st.get(p) !== "installed") || !adb;
  const warn = $("dbWarn");
  warn.hidden = !risky.length;
  warn.textContent = risky.length ? `Your selection includes ${risky.length} Expert/Unsafe package${risky.length > 1 ? "s" : ""} (${risky.slice(0, 3).join(", ")}${risky.length > 3 ? "…" : ""}). Removing these can break features or stop the phone from starting.` : "";
}

async function debloatApply(action) {
  if (!adb) return;
  const pkgs = [...debloat.selected];
  const failed = [];
  let done = 0;
  const btn = $({ remove: "dbRemove", disable: "dbDisable", restore: "dbRestore" }[action]);
  busy(btn, true, "Working…");
  try {
    for (const p of pkgs) {
      btn.textContent = `${++done}/${pkgs.length}…`;
      const q = shQuote(p);
      let out = "";
      if (action === "remove") {
        out = await sh(`pm uninstall -k --user 0 ${q}`);
        if (!/Success/.test(out)) { failed.push(`${p}: ${pmError(out)}`); continue; }
      } else if (action === "disable") {
        out = await sh(`pm disable-user --user 0 ${q}`);
        if (!/new state/i.test(out)) { failed.push(`${p}: ${pmError(out)}`); continue; }
      } else {
        const status = debloat.phone?.status.get(p);
        if (status === "removed") {
          out = await sh(`cmd package install-existing --user 0 ${q} 2>&1 || pm install-existing --user 0 ${q}`);
          if (!/installed for user|Success/i.test(out)) { failed.push(`${p}: ${pmError(out)}`); continue; }
        }
        out = await sh(`pm enable --user 0 ${q}`);
      }
    }
  } finally { busy(btn, false); }
  debloat.selected.clear();
  await loadDebloat(true);
  if (failed.length) showError(`${failed.length} of ${pkgs.length} didn't work:\n${failed.slice(0, 8).join("\n")}${failed.length > 8 ? "\n…" : ""}`);
  else toast(`${{ remove: "Removed", disable: "Disabled", restore: "Restored" }[action]} ${pkgs.length} package${pkgs.length > 1 ? "s" : ""}`);
}

$("dbSearch").addEventListener("input", (e) => { debloat.q = e.target.value; renderDebloat(); });
$("dbSafety").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  debloat.safety = b.dataset.s;
  for (const x of $("dbSafety").children) x.classList.toggle("on", x === b);
  renderDebloat();
});
$("dbStatus").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  debloat.status = b.dataset.s;
  for (const x of $("dbStatus").children) x.classList.toggle("on", x === b);
  renderDebloat();
});
$("dbGroup").addEventListener("change", (e) => { debloat.group = e.target.value; renderDebloat(); });
$("dbSelectAll").addEventListener("click", () => {
  const rows = debloatRows();
  const all = rows.length && rows.every((r) => debloat.selected.has(r.pkg));
  for (const r of rows) all ? debloat.selected.delete(r.pkg) : debloat.selected.add(r.pkg);
  renderDebloat();
});
$("dbUpdate").addEventListener("click", async () => {
  const btn = $("dbUpdate"); busy(btn, true, "Downloading…");
  try { Object.assign(debloat, await downloadUadList()); await loadDebloat(true); toast("Debloat list updated"); }
  catch (e) { showError(e); } finally { busy(btn, false); }
});
armedClick($("dbRemove"), () => debloatApply("remove"));
armedClick($("dbDisable"), () => debloatApply("disable"));
$("dbRestore").addEventListener("click", () => debloatApply("restore").catch(showError));

// ---------- Photos & Music ----------
// The companion supplies Android's media index (names, albums, artists, sizes, paths) and
// thumbnails; file contents go straight over adb (sync read/write). Deleting goes through the
// companion so galleries and music apps update; adding pushes the files, then asks the companion
// to index them.
const PHOTO_PAGE = 300;
const media = {
  photos: { items: [], type: "all", album: "", sort: "new", q: "", sel: new Set(), dups: null, shown: 0, list: [] },
  music: { items: [], view: "songs", group: null, q: "", sel: new Set(), dups: null, allAudio: false, list: [], playing: null },
};
const mkey = (it) => `${it.kind}:${it.id}`;
const fmtDuration = (ms) => {
  const s = Math.round(Number(ms) / 1000); if (!isFinite(s) || s <= 0) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
const safeFileName = (s) => String(s || "file").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "").slice(0, 150) || "file";
const parentDir = (p) => String(p || "").replace(/\/[^/]*$/, "");

function needMedia(kinds) {
  const p = companionInfo?.permissions || {};
  const missing = kinds.filter((k) => p[{ image: "MEDIA_IMAGES", video: "MEDIA_VIDEO", audio: "MEDIA_AUDIO" }[k]] === false);
  if (missing.length) throw new Error(`The companion doesn't have access to ${missing.includes("audio") ? "music" : "photos and videos"}. On the phone, open Settings › Apps › Andromon Companion › Permissions and allow “Photos and videos” / “Music and audio”, or remove the companion so Andromon reinstalls it with access.`);
}

// ---- thumbnails: requested in batches as tiles scroll into view, cached (LRU) as data URLs ----
const thumbs = new Map();
const thumbWant = new Map(); // key -> [img]
let thumbTimer = null, thumbBusy = false;
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    const key = e.target.dataset.thumb, img = e.target.querySelector("img");
    if (!key || !img) continue;
    if (thumbs.has(key)) { img.src = thumbs.get(key); continue; }
    if (!thumbWant.has(key)) thumbWant.set(key, []);
    thumbWant.get(key).push(img);
  }
  if (thumbWant.size && !thumbTimer) thumbTimer = setTimeout(pumpThumbs, 30);
}, { rootMargin: "400px" });

async function pumpThumbs() {
  thumbTimer = null;
  if (thumbBusy || !adb) return;
  thumbBusy = true;
  try {
    while (thumbWant.size && adb) {
      const keys = [...thumbWant.keys()];
      const kind = keys[0].split(":")[0];
      const batch = keys.filter((k) => k.startsWith(kind + ":")).slice(0, 40);
      let got = {};
      try { got = await cc("media.thumbs", { kind, ids: batch.map((k) => Number(k.split(":")[1])), size: 256 }); } catch (e) { console.warn(e); }
      for (const k of batch) {
        const imgs = thumbWant.get(k) || []; thumbWant.delete(k);
        const b64 = got[k.split(":")[1]];
        const url = b64 ? `data:image/jpeg;base64,${b64}` : "";
        thumbs.set(k, url);
        if (thumbs.size > 3000) thumbs.delete(thumbs.keys().next().value);
        for (const img of imgs) if (url) img.src = url; else img.closest(".mtile, .mcard")?.classList.add("nothumb");
      }
    }
  } finally { thumbBusy = false; }
}

// ---- reading files from the phone ----
async function pullBlob(it, onBytes) {
  return withSync(async (s) => {
    const reader = s.read(it.path).getReader(); const parts = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value.slice()); n += value.length; onBytes?.(n); }
    return new Blob(parts, { type: it.mime || "" });
  });
}

/** Copies items into a folder the person picks (album/artist subfolders when there are several). */
async function exportMedia(items, progressEl, groupOf) {
  if (!items.length) return;
  if (!window.showDirectoryPicker) throw new Error("Copying to a folder needs the Andromon desktop app.");
  let dir;
  try { dir = await window.showDirectoryPicker({ id: "andromon-media", mode: "readwrite" }); }
  catch (e) { if (e.name === "AbortError") return; throw e; }
  const groups = new Set(items.map(groupOf).filter(Boolean));
  const total = items.reduce((s, it) => s + (it.size || 0), 0);
  let done = 0, count = 0, failed = 0;
  const bar = createProgress({ el, fmtSize });
  progressEl.replaceChildren(bar.node); progressEl.hidden = false;
  let current = "";
  const show = () => bar.update(items.length > 1 ? `Copying ${current} (${Math.min(count + 1, items.length)} of ${items.length})` : `Copying ${current}`, done, total);
  try {
    await withSync(async (s) => {
      for (const it of items) {
        try {
          const target = groups.size > 1 && groupOf(it) ? await dir.getDirectoryHandle(safeFileName(groupOf(it)), { create: true }) : dir;
          let name = safeFileName(it.name);
          for (let i = 1; ; i++) {
            try { await target.getFileHandle(name); } catch { break; } // free name
            name = safeFileName(it.name).replace(/(\.[^.]*)?$/, ` (${i})$1`);
          }
          const w = await (await target.getFileHandle(name, { create: true })).createWritable();
          current = it.name; show();
          const reader = s.read(it.path).getReader();
          try {
            for (;;) {
              const { done: end, value } = await reader.read(); if (end) break;
              await w.write(value.slice()); done += value.length;
              show();
            }
            await w.close();
          } catch (e) { await w.abort().catch(() => {}); throw e; }
        } catch (e) { console.warn(it.path, e); failed++; }
        count++; show();
      }
    });
  } finally { progressEl.hidden = true; progressEl.replaceChildren(); }
  toast(`Copied ${count - failed} file${count - failed === 1 ? "" : "s"} to “${dir.name}”${failed ? ` · ${failed} failed` : ""}`);
}

/** Pushes files from the computer into [dir] on the phone, then has Android index them. */
async function addMediaFiles(files, dirFor, progressEl) {
  if (!files.length) return 0;
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0, i = 0;
  const paths = [];
  const bar = createProgress({ el, fmtSize });
  bar.update(`Adding ${files.length} file${files.length === 1 ? "" : "s"} to the phone…`);
  progressEl.replaceChildren(bar.node); progressEl.hidden = false;
  try {
    const dirs = new Set(files.map(dirFor));
    for (const d of dirs) await sh(`mkdir -p ${shQuote(d)}`);
    await withSync(async (s) => {
      for (const f of files) {
        i++;
        const dir = dirFor(f);
        let name = safeFileName(f.name);
        for (let n = 1; ; n++) {
          try { await s.stat(`${dir}/${name}`); } catch { break; }
          name = safeFileName(f.name).replace(/(\.[^.]*)?$/, ` (${n})$1`);
        }
        const what = files.length > 1 ? `Adding ${f.name} (${i} of ${files.length})` : `Adding ${f.name}`;
        bar.update(what, done, total);
        await s.write({ filename: `${dir}/${name}`, file: countBytes(f.stream(), (b) => { done += b; bar.update(what, done, total); }), permission: 0o660, mtime: Math.floor(f.lastModified / 1000) });
        paths.push(`${dir}/${name}`);
      }
    });
    bar.update("Adding to the phone's library…");
    await cc("media.scan", { paths });
  } finally { progressEl.hidden = true; progressEl.replaceChildren(); }
  toast(`Added ${paths.length} file${paths.length === 1 ? "" : "s"} (${fmtSize(total)})`);
  return paths.length;
}

/** Deletes items through the companion; anything it can't remove is deleted over adb and re-indexed. */
async function deleteMedia(items) {
  let deleted = 0; const leftover = [];
  for (const kind of ["image", "video", "audio"]) {
    const ids = items.filter((it) => it.kind === kind).map((it) => it.id);
    for (let i = 0; i < ids.length; i += 200) {
      const r = await cc("media.delete", { kind, ids: ids.slice(i, i + 200) });
      deleted += r.deleted;
      for (const f of r.failed || []) if (f.path) leftover.push(f.path);
    }
  }
  if (leftover.length) {
    for (const p of leftover) { const out = (await adb.rm(p)).trim(); if (!out) deleted++; }
    await cc("media.scan", { paths: leftover }).catch(() => {});
  }
  return deleted;
}

function selectionBar(bar, st, all, { onExport, onDelete, onChange }) {
  const chosen = all.filter((it) => st.sel.has(mkey(it)));
  bar.hidden = !chosen.length;
  if (!chosen.length) { bar.replaceChildren(); return; }
  const size = chosen.reduce((s, it) => s + (it.size || 0), 0);
  const clear = el("button", { className: "btn sm", textContent: "Clear", type: "button" });
  clear.onclick = () => { st.sel.clear(); onChange(); };
  const exp = el("button", { className: "btn sm primary", textContent: "Copy to computer…", type: "button" });
  exp.onclick = async () => { busy(exp, true, "Copying…"); try { await onExport(chosen); } catch (e) { showError(e); } finally { if (exp.isConnected) busy(exp, false); } };
  const del = el("button", { className: "btn sm danger", textContent: `Delete ${chosen.length}`, type: "button" });
  armedClick(del, async () => {
    busy(del, true, "Deleting…");
    try { await onDelete(chosen); } catch (e) { showError(e); } finally { if (del.isConnected) busy(del, false); }
  });
  bar.replaceChildren(el("b", { textContent: `${chosen.length} selected` }), el("span", { className: "muted small", textContent: fmtSize(size), style: "flex:1" }), clear, exp, del);
}

// ---------------- Photos ----------------
async function loadPhotos(force = false) {
  await withCompanion($("phGate"), $("phMain"), async () => {
    needMedia(["image", "video"]);
    const st = media.photos;
    if (force || !st.loaded) {
      $("phSummary").textContent = "Reading the phone's gallery…";
      const [images, videos] = await Promise.all([cc("media.list", { kind: "image" }), cc("media.list", { kind: "video" })]);
      st.items = [...images.map((x) => ({ ...x, kind: "image" })), ...videos.map((x) => ({ ...x, kind: "video" }))];
      st.loaded = true;
      const keys = new Set(st.items.map(mkey));
      for (const k of [...st.sel]) if (!keys.has(k)) st.sel.delete(k);
      if (st.dups) st.dups = null;
      fillAlbums();
    }
    renderPhotos();
  });
}

function fillAlbums() {
  const st = media.photos, counts = new Map();
  for (const it of st.items) counts.set(it.album || "(no album)", (counts.get(it.album || "(no album)") || 0) + 1);
  const opts = [el("option", { value: "", textContent: `All albums (${st.items.length})` })];
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) opts.push(el("option", { value: name, textContent: `${name} (${n})` }));
  $("phAlbum").replaceChildren(...opts);
  if (![...counts.keys()].includes(st.album)) st.album = "";
  $("phAlbum").value = st.album;
}

function photoList() {
  const st = media.photos, q = st.q.toLowerCase();
  let list = st.items.filter((it) => (st.type === "all" || it.kind === st.type) &&
    (!st.album || (it.album || "(no album)") === st.album) && (!q || String(it.name).toLowerCase().includes(q)));
  list.sort(st.sort === "big" ? (a, b) => b.size - a.size : st.sort === "old" ? (a, b) => a.date - b.date : (a, b) => b.date - a.date);
  return list;
}

function photoTile(it, list, keep) {
  const st = media.photos, key = mkey(it);
  const img = el("img", { alt: "", decoding: "async", draggable: false });
  const chk = el("span", { className: "mchk", textContent: st.sel.has(key) ? "✓" : "" });
  const t = el("div", { className: "mtile" + (st.sel.has(key) ? " sel" : ""), title: `${it.name}\n${fmtSize(it.size)} · ${fmtDate(it.date, true)}${it.album ? ` · ${it.album}` : ""}` }, img, chk);
  if (it.kind === "video") t.append(el("span", { className: "mbadge", textContent: `▶ ${fmtDuration(it.duration)}` }));
  else if (st.sort === "big") t.append(el("span", { className: "mbadge", textContent: fmtSize(it.size) }));
  if (keep) t.append(el("span", { className: "mbadge mkeep", textContent: "Keep" }));
  t.dataset.thumb = key;
  const toggle = () => {
    if (st.sel.has(key)) st.sel.delete(key); else st.sel.add(key);
    t.classList.toggle("sel", st.sel.has(key)); chk.textContent = st.sel.has(key) ? "✓" : "";
    renderPhotoSelection();
  };
  t.onclick = (e) => {
    if (e.target === chk || e.metaKey || e.ctrlKey || e.shiftKey || st.sel.size) toggle();
    else openViewer(list, list.indexOf(it));
  };
  if (thumbs.get(key)) img.src = thumbs.get(key); else thumbObserver.observe(t);
  return t;
}

function renderPhotos() {
  const st = media.photos;
  for (const b of $("phType").children) b.classList.toggle("on", b.dataset.t === st.type);
  const images = st.items.filter((it) => it.kind === "image"), videos = st.items.filter((it) => it.kind === "video");
  $("phSummary").textContent = `${images.length.toLocaleString()} photos · ${videos.length.toLocaleString()} videos · ${fmtSize(st.items.reduce((s, it) => s + it.size, 0))}`;
  const grid = $("phGrid");
  if (st.dups) return renderPhotoDups();
  $("phDupHead").hidden = true;
  st.list = photoList();
  st.shown = 0;
  grid.replaceChildren();
  if (!st.list.length) { grid.append(el("div", { className: "card" }, emptyBox(st.items.length ? "Nothing matches." : "No photos or videos on the phone."))); renderPhotoSelection(); return; }
  const g = el("div", { className: "mgrid" }); grid.append(g);
  const more = () => {
    const next = st.list.slice(st.shown, st.shown + PHOTO_PAGE);
    g.append(...next.map((it) => photoTile(it, st.list)));
    st.shown += next.length;
    if (st.shown < st.list.length) { const s = el("div", { style: "height:1px" }); grid.append(s); sentinel.observe(s); }
  };
  const sentinel = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { sentinel.unobserve(e.target); e.target.remove(); more(); } }, { rootMargin: "800px" });
  more();
  renderPhotoSelection();
}

function renderPhotoSelection() {
  const st = media.photos;
  selectionBar($("phSelBar"), st, st.items, {
    onChange: renderPhotos,
    onExport: (items) => exportMedia(items, $("phProgress"), (it) => it.album),
    onDelete: async (items) => {
      const n = await deleteMedia(items);
      toast(`Deleted ${n} of ${items.length}`);
      st.sel.clear();
      await loadPhotos(true);
    },
  });
}

function renderPhotoDups() {
  const st = media.photos, byKey = new Map(st.items.map((it) => [mkey(it), it]));
  const groups = st.dups.map((g) => g.keys.map((k) => byKey.get(k)).filter(Boolean)).filter((g) => g.length > 1);
  const extra = groups.flatMap((g) => g.slice(1));
  const selectExtras = el("button", { className: "btn sm primary", textContent: "Select all extra copies", type: "button" });
  selectExtras.onclick = () => { for (const it of extra) st.sel.add(mkey(it)); renderPhotoDups(); };
  const close = el("button", { className: "btn sm", textContent: "Back to gallery", type: "button" });
  close.onclick = () => { st.dups = null; renderPhotos(); };
  $("phDupHead").hidden = false;
  $("phDupHead").replaceChildren(el("div", { className: "toolbar", style: "margin:0" },
    el("span", { style: "flex:1", textContent: groups.length
      ? `${groups.length} sets of duplicates · ${extra.length} extra copies · ${fmtSize(extra.reduce((s, it) => s + it.size, 0))} can be freed. The oldest copy in each set is kept.`
      : "No duplicate photos or videos found." }),
    groups.length ? selectExtras : "", close));
  $("phGrid").replaceChildren(...groups.map((g) => el("div", { className: "mgroup card" },
    el("div", { className: "sub", textContent: `${g.length} copies · ${fmtSize(g[0].size)} each · ${g.map((it) => it.album || "?").filter((v, i, a) => a.indexOf(v) === i).join(", ")}` }),
    el("div", { className: "mgrid" }, ...g.map((it, i) => photoTile(it, g, i === 0))))));
  renderPhotoSelection();
}

async function findDuplicates(kinds, progressEl) {
  progressEl.hidden = false;
  progressEl.textContent = "Comparing files on the phone… (this reads files that have the same size, so it can take a minute)";
  try {
    const out = [];
    for (const kind of kinds) for (const g of await cc("media.duplicates", { kind })) out.push({ size: g.size, keys: g.ids.map((id) => `${kind}:${id}`) });
    return out.sort((a, b) => b.size * b.keys.length - a.size * a.keys.length);
  } finally { progressEl.hidden = true; }
}

// ---- full-screen viewer (photos and videos) ----
let viewer = null;
function openViewer(list, index) {
  closeViewer();
  viewer = { list, index, url: null, token: 0 };
  document.addEventListener("keydown", viewerKeys);
  showViewerItem();
}
function closeViewer() {
  if (!viewer) return;
  if (viewer.url) URL.revokeObjectURL(viewer.url);
  viewer = null;
  document.removeEventListener("keydown", viewerKeys);
  $("viewer").hidden = true; $("viewer").replaceChildren();
}
function viewerKeys(e) {
  if (!viewer) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft" && viewer.index > 0) { viewer.index--; showViewerItem(); }
  else if (e.key === "ArrowRight" && viewer.index < viewer.list.length - 1) { viewer.index++; showViewerItem(); }
}
async function showViewerItem() {
  const v = viewer, it = v.list[v.index], token = ++v.token;
  if (v.url) { URL.revokeObjectURL(v.url); v.url = null; }
  const btn = (label, fn, cls = "btn sm") => { const b = el("button", { className: cls, textContent: label, type: "button" }); b.onclick = fn; return b; };
  const prev = btn("‹ Prev", () => { v.index--; showViewerItem(); }); prev.disabled = v.index === 0;
  const next = btn("Next ›", () => { v.index++; showViewerItem(); }); next.disabled = v.index >= v.list.length - 1;
  const save = btn("Copy to computer…", () => exportMedia([it], $("phProgress"), () => "").catch(showError));
  const del = el("button", { className: "btn sm danger", textContent: "Delete", type: "button" });
  armedClick(del, async () => {
    try {
      await deleteMedia([it]);
      media.photos.items = media.photos.items.filter((x) => x !== it);
      v.list.splice(v.index, 1);
      toast(`Deleted ${it.name}`);
      if (!v.list.length) { closeViewer(); renderPhotos(); return; }
      v.index = Math.min(v.index, v.list.length - 1);
      showViewerItem(); renderPhotos();
    } catch (e) { showError(e); }
  });
  const info = [fmtSize(it.size), fmtDate(it.date, true), it.width && it.height ? `${it.width}×${it.height}` : "", it.album, `${v.index + 1} of ${v.list.length}`].filter(Boolean).join(" · ");
  const body = el("div", { className: "vbody" }, el("div", { className: "muted", textContent: "Loading…" }));
  $("viewer").replaceChildren(
    el("header", {}, el("div", { className: "vtitle" }, el("b", { textContent: it.name }), el("div", { className: "small", style: "opacity:.75", textContent: info })),
      prev, next, save, del, btn("Close", closeViewer)),
    body);
  $("viewer").hidden = false;
  try {
    // Big files show a progress bar while they come over from the phone.
    let bar = null;
    const blob = await pullBlob(it, (n) => {
      if (v.token !== token || it.size <= 2e6) return;
      if (!bar) { bar = createProgress({ el, fmtSize }); body.replaceChildren(bar.node); }
      bar.update(`Loading ${it.kind === "video" ? "video" : "photo"} from the phone…`, n, it.size);
    });
    if (viewer !== v || v.token !== token) return;
    v.url = URL.createObjectURL(blob);
    const m = it.kind === "video" ? el("video", { src: v.url, controls: true, autoplay: true }) : el("img", { src: v.url, alt: it.name });
    body.replaceChildren(m);
  } catch (e) { if (viewer === v) body.replaceChildren(el("div", { textContent: `Couldn't open: ${e.message}` })); }
}
$("viewer").addEventListener("click", (e) => { if (e.target.classList.contains("vbody")) closeViewer(); });

// photos toolbar
$("phType").addEventListener("click", (e) => { const b = e.target.closest("button[data-t]"); if (!b) return; media.photos.type = b.dataset.t; media.photos.dups = null; renderPhotos(); });
$("phAlbum").addEventListener("change", () => { media.photos.album = $("phAlbum").value; media.photos.dups = null; renderPhotos(); });
$("phSort").addEventListener("change", () => { media.photos.sort = $("phSort").value; renderPhotos(); });
$("phSearch").addEventListener("input", () => { media.photos.q = $("phSearch").value.trim(); clearTimeout(media.photos.qt); media.photos.qt = setTimeout(renderPhotos, 200); });
$("phReload").addEventListener("click", () => loadPhotos(true).catch(showError));
$("phAdd").addEventListener("click", () => $("phAddInput").click());
$("phAddInput").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  if (!files.length) return;
  const st = media.photos;
  // Into the album being viewed, otherwise Pictures/Andromon or Movies/Andromon.
  const albumDir = st.album ? parentDir(st.items.find((it) => (it.album || "(no album)") === st.album)?.path) : "";
  const root = (st.items.find((it) => /^\/storage\/emulated\/\d+\//.test(it.path))?.path.match(/^\/storage\/emulated\/\d+/) || ["/storage/emulated/0"])[0];
  const dirFor = (f) => albumDir || `${root}/${f.type.startsWith("video/") ? "Movies" : "Pictures"}/Andromon`;
  try { await addMediaFiles(files, dirFor, $("phProgress")); await loadPhotos(true); } catch (err) { showError(err); }
});
$("phDups").addEventListener("click", async () => {
  const b = $("phDups"); busy(b, true, "Searching…");
  try { media.photos.dups = await findDuplicates(["image", "video"], $("phProgress")); renderPhotos(); }
  catch (e) { showError(e); } finally { busy(b, false); }
});

// ---------------- Music ----------------
async function loadMusic(force = false) {
  await withCompanion($("muGate"), $("muMain"), async () => {
    needMedia(["audio"]);
    const st = media.music;
    if (force || !st.loaded) {
      $("muSummary").textContent = "Reading the phone's music…";
      st.items = (await cc("media.list", { kind: "audio", allAudio: st.allAudio })).map((x) => ({ ...x, kind: "audio" }));
      st.loaded = true; st.dups = null;
      const keys = new Set(st.items.map(mkey));
      for (const k of [...st.sel]) if (!keys.has(k)) st.sel.delete(k);
    }
    renderMusic();
  });
}

const songTitle = (it) => it.title || String(it.name || "").replace(/\.[^.]+$/, "");
const groupKey = (it, view) => view === "artist" ? (it.artist || "Unknown artist") : view === "album" ? (it.album || "Unknown album") : parentDir(it.path).split("/").pop() || "/";

function songList() {
  const st = media.music, q = st.q.toLowerCase();
  let list = st.items;
  if (st.group) list = list.filter((it) => groupKey(it, st.group.view) === st.group.name);
  if (q) list = list.filter((it) => [songTitle(it), it.artist, it.album, it.name].some((v) => String(v || "").toLowerCase().includes(q)));
  if (st.group?.view === "album") list = [...list].sort((a, b) => (a.track || 0) - (b.track || 0) || songTitle(a).localeCompare(songTitle(b)));
  else list = [...list].sort((a, b) => songTitle(a).localeCompare(songTitle(b)));
  return list;
}

function renderMusic() {
  const st = media.music;
  for (const b of $("muView").children) b.classList.toggle("on", b.dataset.v === st.view);
  const dur = st.items.reduce((s, it) => s + (Number(it.duration) || 0), 0);
  $("muSummary").textContent = `${st.items.length.toLocaleString()} songs · ${fmtSize(st.items.reduce((s, it) => s + it.size, 0))} · ${dur >= 3.6e6 ? `${(dur / 3.6e6).toFixed(1)} hours` : `${Math.round(dur / 6e4)} min`}`;
  const body = $("muBody");
  if (st.dups) return renderMusicDups();
  if (st.view !== "songs" && !st.group) {
    // Artists / albums / folders as cards
    const q = st.q.toLowerCase(), groups = new Map();
    for (const it of st.items) {
      const k = groupKey(it, st.view);
      if (!groups.has(k)) groups.set(k, { name: k, items: [] });
      groups.get(k).items.push(it);
    }
    const list = [...groups.values()].filter((g) => !q || g.name.toLowerCase().includes(q) || g.items.some((it) => songTitle(it).toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    body.replaceChildren(list.length ? el("div", { className: "mcards" }, ...list.map((g) => {
      const art = g.items.find((it) => it.albumId) || g.items[0];
      const img = el("img", { alt: "", decoding: "async" });
      const c = el("button", { className: "mcard", type: "button" }, img,
        el("b", { textContent: g.name }),
        el("span", { className: "muted small", textContent: `${g.items.length} song${g.items.length === 1 ? "" : "s"} · ${fmtSize(g.items.reduce((s, it) => s + it.size, 0))}` }));
      c.dataset.thumb = mkey(art);
      if (thumbs.get(c.dataset.thumb)) img.src = thumbs.get(c.dataset.thumb); else thumbObserver.observe(c);
      c.onclick = () => { st.group = { view: st.view, name: g.name }; renderMusic(); };
      return c;
    })) : emptyBox(st.items.length ? "Nothing matches." : "No music on the phone."));
    renderMusicSelection();
    return;
  }
  st.list = songList();
  const head = [];
  if (st.group) {
    const back = el("button", { className: "btn sm", textContent: `‹ All ${st.group.view === "artist" ? "artists" : st.group.view === "album" ? "albums" : "folders"}`, type: "button" });
    back.onclick = () => { st.group = null; renderMusic(); };
    const playAll = el("button", { className: "btn sm primary", textContent: "▶ Play all", type: "button" });
    playAll.onclick = () => playSong(st.list, 0);
    const selAll = el("button", { className: "btn sm", textContent: "Select all", type: "button" });
    selAll.onclick = () => { for (const it of st.list) st.sel.add(mkey(it)); renderMusic(); };
    head.push(el("div", { className: "toolbar" }, back, el("h2", { style: "margin:0;flex:1", textContent: st.group.name }), playAll, selAll));
  }
  body.replaceChildren(...head, songTable(st.list));
  renderMusicSelection();
}

function songTable(list, keepFirstOf) {
  const st = media.music;
  const all = el("input", { type: "checkbox", title: "Select all" });
  all.checked = list.length > 0 && list.every((it) => st.sel.has(mkey(it)));
  all.onchange = () => { for (const it of list) all.checked ? st.sel.add(mkey(it)) : st.sel.delete(mkey(it)); renderMusic(); };
  const rows = list.map((it, i) => {
    const key = mkey(it);
    const cb = el("input", { type: "checkbox", checked: st.sel.has(key) });
    cb.onchange = () => { cb.checked ? st.sel.add(key) : st.sel.delete(key); renderMusicSelection(); };
    const play = el("button", { className: "btn sm", textContent: "▶", type: "button", title: "Play" });
    play.onclick = () => playSong(list, i);
    const tr = el("tr", { className: st.playing && mkey(st.playing) === key ? "playing" : "" },
      el("td", {}, cb), el("td", {}, play),
      el("td", {}, songTitle(it), keepFirstOf?.has(key) ? el("span", { className: "badge neutral", textContent: "Keep" }) : ""),
      el("td", { className: "muted", textContent: it.artist || "" }),
      el("td", { className: "muted hide-sm", textContent: it.album || "" }),
      el("td", { className: "num", textContent: fmtDuration(it.duration) }),
      el("td", { className: "num hide-sm", textContent: fmtSize(it.size) }));
    tr.title = it.path || "";
    return tr;
  });
  return el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, all), el("th"), el("th", { textContent: "Title" }), el("th", { textContent: "Artist" }),
      el("th", { className: "hide-sm", textContent: "Album" }), el("th", { className: "num", textContent: "Time" }), el("th", { className: "num hide-sm", textContent: "Size" }))),
    el("tbody", {}, ...(rows.length ? rows : [el("tr", {}, el("td", { colSpan: 7, className: "empty", textContent: media.music.items.length ? "Nothing matches." : "No music on the phone." }))])));
}

function renderMusicSelection() {
  const st = media.music;
  selectionBar($("muSelBar"), st, st.items, {
    onChange: renderMusic,
    onExport: (items) => exportMedia(items, $("muProgress"), (it) => it.artist || it.album),
    onDelete: async (items) => {
      if (st.playing && items.some((it) => mkey(it) === mkey(st.playing))) stopSong();
      const n = await deleteMedia(items);
      toast(`Deleted ${n} of ${items.length}`);
      st.sel.clear();
      await loadMusic(true);
    },
  });
}

function renderMusicDups() {
  const st = media.music, byKey = new Map(st.items.map((it) => [mkey(it), it]));
  const groups = st.dups.map((g) => g.keys.map((k) => byKey.get(k)).filter(Boolean)).filter((g) => g.length > 1);
  const extra = groups.flatMap((g) => g.slice(1));
  const keep = new Set(groups.map((g) => mkey(g[0])));
  const selectExtras = el("button", { className: "btn sm primary", textContent: "Select all extra copies", type: "button" });
  selectExtras.onclick = () => { for (const it of extra) st.sel.add(mkey(it)); renderMusic(); };
  const close = el("button", { className: "btn sm", textContent: "Back to music", type: "button" });
  close.onclick = () => { st.dups = null; renderMusic(); };
  st.list = groups.flat();
  $("muBody").replaceChildren(
    el("div", { className: "toolbar" }, el("span", { style: "flex:1", textContent: groups.length
      ? `${groups.length} songs have copies · ${extra.length} extra copies · ${fmtSize(extra.reduce((s, it) => s + it.size, 0))} can be freed. The oldest copy is kept.`
      : "No duplicate songs found." }), groups.length ? selectExtras : "", close),
    groups.length ? songTable(st.list, keep) : "");
  renderMusicSelection();
}

// ---- player: pulls the song over USB, plays it from memory ----
const songCache = new Map(); // key -> blob URL (last few songs)
async function playSong(list, index) {
  const st = media.music, it = list[index]; if (!it) return;
  st.queue = list; st.qi = index; st.playing = it;
  const key = mkey(it), token = (st.playToken = (st.playToken || 0) + 1);
  const box = $("muPlayer");
  const art = el("img", { alt: "" }); art.dataset.thumb = key;
  const audio = el("audio", { controls: true, autoplay: true });
  const status = el("span", { className: "muted small", textContent: "Loading…" });
  const prev = el("button", { className: "btn sm", textContent: "⏮", type: "button", title: "Previous" }); prev.onclick = () => playSong(list, index - 1); prev.disabled = index === 0;
  const next = el("button", { className: "btn sm", textContent: "⏭", type: "button", title: "Next" }); next.onclick = () => playSong(list, index + 1); next.disabled = index >= list.length - 1;
  const close = el("button", { className: "btn sm", textContent: "✕", type: "button", title: "Stop" }); close.onclick = stopSong;
  box.replaceChildren(art, el("div", { style: "min-width:0;max-width:40%" }, el("b", { textContent: songTitle(it) }), el("div", { className: "muted small", textContent: [it.artist, it.album].filter(Boolean).join(" · ") }), status), prev, audio, next, close);
  box.hidden = false;
  if (thumbs.get(key)) art.src = thumbs.get(key); else { thumbWant.set(key, [art]); pumpThumbs(); }
  if (current === "music") renderMusic();
  try {
    let url = songCache.get(key);
    if (!url) {
      const blob = await pullBlob(it, (n) => { if (st.playToken === token) status.textContent = `Loading ${fmtSize(n)} of ${fmtSize(it.size)}…`; });
      url = URL.createObjectURL(blob);
      songCache.set(key, url);
      if (songCache.size > 6) { const [k, u] = songCache.entries().next().value; if (k !== key) { URL.revokeObjectURL(u); songCache.delete(k); } }
    }
    if (st.playToken !== token) return;
    status.textContent = `${fmtDuration(it.duration)} · ${fmtSize(it.size)}`;
    audio.src = url;
    audio.onended = () => { if (index < list.length - 1) playSong(list, index + 1); };
  } catch (e) { if (st.playToken === token) status.textContent = `Couldn't play: ${e.message}`; }
}
function stopSong() {
  const st = media.music;
  st.playing = null; st.playToken = (st.playToken || 0) + 1;
  $("muPlayer").querySelector("audio")?.pause();
  $("muPlayer").hidden = true; $("muPlayer").replaceChildren();
  if (current === "music") renderMusic();
}

// music toolbar
$("muView").addEventListener("click", (e) => { const b = e.target.closest("button[data-v]"); if (!b) return; media.music.view = b.dataset.v; media.music.group = null; media.music.dups = null; renderMusic(); });
$("muSearch").addEventListener("input", () => { media.music.q = $("muSearch").value.trim(); clearTimeout(media.music.qt); media.music.qt = setTimeout(renderMusic, 200); });
$("muAll").addEventListener("change", () => { media.music.allAudio = $("muAll").checked; loadMusic(true).catch(showError); });
$("muReload").addEventListener("click", () => loadMusic(true).catch(showError));
$("muAdd").addEventListener("click", () => $("muAddInput").click());
$("muAddInput").addEventListener("change", async (e) => {
  const files = [...e.target.files]; e.target.value = "";
  if (!files.length) return;
  const root = (media.music.items.find((it) => /^\/storage\/emulated\/\d+\//.test(it.path))?.path.match(/^\/storage\/emulated\/\d+/) || ["/storage/emulated/0"])[0];
  try { await addMediaFiles(files, () => `${root}/Music/Andromon`, $("muProgress")); await loadMusic(true); } catch (err) { showError(err); }
});
$("muDups").addEventListener("click", async () => {
  const b = $("muDups"); busy(b, true, "Searching…");
  try { media.music.dups = await findDuplicates(["audio"], $("muProgress")); renderMusic(); }
  catch (e) { showError(e); } finally { busy(b, false); }
});

function resetMedia() {
  closeViewer(); stopSong();
  for (const st of [media.photos, media.music]) { st.items = []; st.loaded = false; st.sel.clear(); st.dups = null; }
  thumbs.clear(); thumbWant.clear();
  for (const u of songCache.values()) URL.revokeObjectURL(u);
  songCache.clear();
}

// ---------- Wi‑Fi transfer (LocalSend protocol; network code lives in ../localsend.js) ----------
// Works with the free, open-source LocalSend app on the phone (or any LocalSend device) on the same
// Wi‑Fi. No USB or developer options needed. Only available in the desktop app.
const wifiApi = globalThis.andromon?.wifi || null;
let wifiState = { running: false, devices: [], incoming: null, method: "auto", link: null };
const isMac = /Mac/.test(navigator.platform);
const METHOD_NOTES = {
  auto: "Direct link for big transfers (100 MB+) when the Wi‑Fi is slow and the phone has Andromon Companion; otherwise Same Wi‑Fi.",
  lan: "Through your Wi‑Fi router. Works with Andromon Companion and the LocalSend app; this computer stays on its network.",
  direct: "This computer joins a private Wi‑Fi from the phone for each transfer (Andromon Companion only). Fastest on slow networks; no internet here until it reconnects right after.",
};

// The radar of nearby devices (./wifiradar.js). Clicking a device there is the same as its Send files… button.
const wifiSendBtns = new Map(); // fingerprint -> the Send files… button of its row
const wifiRadar = wifiApi ? initWifiRadar({
  el, selfIsMac: isMac,
  onPick: (d) => wifiSend(d, wifiSendBtns.get(d.fingerprint) || el("button"), null),
  onDrop: (d, files) => wifiSend(d, wifiSendBtns.get(d.fingerprint) || el("button"), files),
}) : null;
if (wifiRadar) $("wifiRadar").replaceWith(wifiRadar.node);
let wifiSendingTo = null; // the device files are being sent to right now
/** The device an incoming transfer comes from, matched by address (the sender doesn't say more). */
const wifiDeviceOf = (from) => wifiState.devices.find((d) => d.ip === from?.ip) || wifiState.devices.find((d) => d.alias === from?.alias) || null;

async function loadWifi() {
  if (!wifiApi) { $("wifiUnavailable").hidden = false; $("wifiMain").hidden = true; return; }
  Object.assign(wifiState, await wifiApi.status());
  renderWifi();
  refreshWifiLink();
}

// ---- link quality (this computer's Wi‑Fi, each companion phone's, and the expected speed) ----
let linkTimer = null, linkBusy = false;
async function refreshWifiLink() {
  clearTimeout(linkTimer);
  if (!wifiApi || !wifiState.running || linkBusy) return;
  linkBusy = true;
  try { wifiState.link = await wifiApi.link(); } catch { wifiState.link = null; }
  linkBusy = false;
  if (current === "wifi") { renderWifi(); linkTimer = setTimeout(refreshWifiLink, 30_000); }
}
const signalWord = (rssi) => rssi == null ? "" : rssi >= -60 ? "strong signal" : rssi >= -70 ? "fair signal" : "weak signal";
function describeLink(l) {
  if (!l) return "";
  if (l.kind === "wired") return "Ethernet";
  if (l.kind !== "wifi") return "not on Wi‑Fi";
  return ["Wi‑Fi", l.band, (l.rateMbps || l.txMbps || l.linkMbps) && `${l.rateMbps || l.txMbps || l.linkMbps} Mbit/s`, signalWord(l.rssi)].filter(Boolean).join(" · ");
}
const slowLink = (l) => l?.kind === "wifi" && (l.band === "2.4 GHz" || (l.rateMbps && l.rateMbps < 150) || (l.rssi != null && l.rssi < -70));

const METHOD_NAMES = [["auto", "Auto"], ["lan", "Same Wi‑Fi"], ["direct", "Direct link"]];
function renderMethod() {
  $("wifiMethodName").textContent = METHOD_NAMES.find(([id]) => id === wifiState.method)?.[1] || "Auto";
  $("wifiMethodNote").textContent = METHOD_NOTES[wifiState.method] || "";
}

function renderWifi() {
  const s = wifiState;
  $("wifiSwitch").set(s.running);
  $("wifiStatus").textContent = s.running
    ? `Visible as “${s.alias}”${s.addresses?.length ? ` · ${s.addresses.join(", ")}` : ""}`
    : "Off. Turn on to send and receive files over Wi‑Fi.";
  $("wifiScan").disabled = !s.running;
  $("wifiFolder").textContent = s.saveDir || "";
  renderMethod();
  const pc = s.running ? s.link?.pc : null;
  $("wifiLink").hidden = !pc;
  if (pc) {
    $("wifiLink").replaceChildren(
      el("span", { textContent: `${isMac ? "This Mac" : "This PC"}: ${describeLink(pc)}` }),
      slowLink(pc) ? el("span", { className: "chip warn", style: "margin-left:8px", textContent: pc.band === "2.4 GHz" ? "2.4 GHz is slow: use 5 GHz or Direct link" : "Slow Wi‑Fi link" }) : "");
  }
  const box = $("wifiDevices");
  wifiRadar?.update(s);
  wifiSendBtns.clear();
  if (!s.running) { box.replaceChildren(emptyBox("Turn on Wi‑Fi transfer to find nearby devices.")); return; }
  if (!s.devices.length) {
    box.replaceChildren(emptyBox("Looking for devices… On your phone (same Wi‑Fi), turn on Receive in Andromon Companion, or open LocalSend. It appears here within a few seconds."));
    return;
  }
  box.replaceChildren(...s.devices.map((d) => {
    const send = el("button", { className: "btn sm primary", textContent: "Send files…", type: "button" });
    send.onclick = () => wifiSend(d, send, null);
    wifiSendBtns.set(d.fingerprint, send);
    const link = s.link?.devices?.[d.fingerprint];
    const est = link?.estimateMBps;
    const chips = [];
    if (d.companion) chips.push(el("span", { className: "chip", textContent: d.companion.directLink ? "Companion · Direct link ready" : "Companion" }));
    else chips.push(el("span", { className: "chip", textContent: "LocalSend · Same Wi‑Fi only" }));
    if (est != null) chips.push(el("span", { className: est < 6 ? "chip warn" : "chip", textContent: `≈ ${est < 10 ? est.toFixed(1) : Math.round(est)} MB/s over Wi‑Fi${est < 6 && d.companion?.directLink ? " · Direct link will be faster" : ""}` }));
    const row = el("div", { className: "ctl wifi-dev" },
      el("div", {},
        el("div", { textContent: `${d.deviceType === "mobile" ? "📱" : d.deviceType === "desktop" ? "💻" : "🖧"} ${d.alias}` }),
        el("div", { className: "sub", textContent: [d.deviceModel, d.ip, link?.phone ? `phone: ${describeLink({ kind: "wifi", ...link.phone })}` : "", d.protocol === "http" ? "encryption off (unsupported)" : ""].filter(Boolean).join(" · ") }),
        el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:4px" }, ...chips)),
      send);
    // Drop files on a device to send them.
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("over"); });
    row.addEventListener("dragleave", () => row.classList.remove("over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault(); row.classList.remove("over");
      if (e.dataTransfer.files.length) wifiSend(d, send, e.dataTransfer.files);
    });
    return row;
  }));
}

async function wifiSend(d, btn, files) {
  clearError();
  busy(btn, true, "Waiting…");
  let sent = false;
  wifiSendingTo = d.fingerprint;
  try {
    const m = wifiState.method;
    const r = files ? await wifiApi.sendFiles(d.fingerprint, files, m) : await wifiApi.pickAndSend(d.fingerprint, m);
    if (r) toast(r.sent ? `Sent ${r.sent} file${r.sent > 1 ? "s" : ""} to ${d.alias}${r.via ? ` via ${r.via}` : ""}` : `${d.alias} already had those files`);
    sent = !!r?.sent;
    refreshWifiLink();
  } catch (e) {
    showError(e);
  } finally {
    busy(btn, false);
    $("wifiProgress").hidden = true;
    wifiRadar?.end(d.fingerprint, sent);
    wifiSendingTo = null;
  }
}

function wifiIncoming(ev) {
  const box = $("wifiIncoming");
  if (!ev) { box.hidden = true; wifiState.incoming = null; return; }
  wifiState.incoming = ev;
  const list = el("ul", { className: "small" });
  for (const f of ev.files.slice(0, 8)) list.append(el("li", { textContent: `${f.name} (${fmtSize(f.size)})` }));
  if (ev.files.length > 8) list.append(el("li", { className: "muted", textContent: `and ${ev.files.length - 8} more` }));
  const answer = (accept) => { wifiApi.respond(ev.requestId, accept).catch(showError); wifiIncoming(null); };
  const yes = el("button", { className: "btn primary", textContent: "Accept", type: "button" }); yes.onclick = () => answer(true);
  const no = el("button", { className: "btn", textContent: "Decline", type: "button" }); no.onclick = () => answer(false);
  box.replaceChildren(
    el("h2", { textContent: `${ev.from.alias} wants to send ${ev.files.length} file${ev.files.length > 1 ? "s" : ""} (${fmtSize(ev.totalSize)})` }),
    el("div", { className: "muted small", textContent: [ev.from.deviceModel, ev.from.ip].filter(Boolean).join(" · ") + " · via Wi‑Fi (LocalSend)" }),
    list,
    el("div", { className: "toolbar", style: "margin:0" }, yes, no, el("span", { className: "muted small", textContent: "Declines automatically after 60 seconds." })),
  );
  box.hidden = false;
}

let speed = { at: 0, bytes: 0, rate: 0, dir: null };
function wifiProgress(ev) {
  const box = $("wifiProgress");
  const frac = ev.total ? ev.received / ev.total : 0;
  // Speed: smoothed over the progress events (they come every ~200 ms).
  const now = performance.now();
  if (speed.dir !== ev.dir || ev.received < speed.bytes) speed = { at: now, bytes: ev.received, rate: 0, dir: ev.dir };
  else if (now - speed.at > 700) {
    const r = ((ev.received - speed.bytes) * 1000) / (now - speed.at);
    speed = { at: now, bytes: ev.received, rate: speed.rate ? speed.rate * 0.6 + r * 0.4 : r, dir: ev.dir };
  }
  // The same on the radar: dots flowing between the two, and the ring round the device filling up.
  const radarFp = ev.dir === "in" ? wifiDeviceOf(ev.from)?.fingerprint : wifiSendingTo;
  if (radarFp) wifiRadar?.progress(radarFp, ev.dir, {
    frac, waiting: ev.dir === "out" && (!!ev.waiting || !!ev.stage),
    text: ev.dir === "in" ? `Receiving from ${ev.from?.alias || "device"} · ${Math.round(frac * 100)}%` : ev.waiting || ev.stage ? `Waiting for ${ev.to}…` : `Sending to ${ev.to} · ${Math.round(frac * 100)}%`,
  });
  const cancel = el("button", { className: "btn sm", textContent: "Cancel", type: "button" });
  cancel.onclick = () => wifiApi.cancelSend().catch(() => {});
  if (ev.dir === "out" && ev.stage) {
    const msg = {
      joining: `Joining ${ev.to}'s Direct link “${ev.ssid}”${ev.band ? ` (${ev.band})` : ""}… this computer leaves your Wi‑Fi for a moment.`,
      connecting: `Connecting to ${ev.to} over Direct link…`,
      restoring: "Reconnecting to your Wi‑Fi…",
      manual: `Couldn't switch Wi‑Fi automatically${ev.reason ? ` (${ev.reason})` : ""}. Join this network from the Wi‑Fi menu, and the transfer starts by itself:`,
    }[ev.stage] || "";
    const parts = [el("div", { className: "toolbar", style: "margin:0;justify-content:space-between" }, el("span", { textContent: msg }), ev.stage !== "restoring" ? cancel : "")];
    if (ev.stage === "manual") {
      const copy = (text) => { navigator.clipboard.writeText(text).then(() => toast("Copied"), () => {}); };
      const b1 = el("button", { className: "btn sm", textContent: "Copy", type: "button" }); b1.onclick = () => copy(ev.ssid);
      const b2 = el("button", { className: "btn sm", textContent: "Copy", type: "button" }); b2.onclick = () => copy(ev.passphrase);
      parts.push(el("div", { className: "toolbar", style: "margin:8px 0 0" }, el("span", { className: "muted small", textContent: "Network" }), el("b", { className: "mono", textContent: ev.ssid }), b1));
      parts.push(el("div", { className: "toolbar", style: "margin:4px 0 0" }, el("span", { className: "muted small", textContent: "Password" }), el("b", { className: "mono", textContent: ev.passphrase }), b2));
      parts.push(el("div", { className: "muted small", textContent: "Waiting up to 2 minutes. If you don't join, the files are sent over your Wi‑Fi instead." }));
    }
    box.replaceChildren(...parts);
    box.hidden = false;
    return;
  }
  const what = ev.dir === "in" ? `Receiving from ${ev.from?.alias || "device"}`
    : ev.waiting ? `Waiting for ${ev.to} to accept…${ev.direct ? " (Direct link: accept in Andromon Companion on the phone)" : ""}`
    : `Sending to ${ev.to}${ev.via ? ` via ${ev.via}` : ""}`;
  const bar = el("div", { className: "bar" }, el("i")); bar.firstChild.style.width = Math.round(frac * 100) + "%";
  box.replaceChildren(
    el("div", { className: "toolbar", style: "margin:0;justify-content:space-between" },
      el("span", { textContent: `${what} · ${fmtSize(ev.received)} of ${fmtSize(ev.total)}${ev.fileCount > 1 ? ` · ${ev.filesDone ?? "…"}/${ev.fileCount} files` : ""}${!ev.waiting && speed.rate > 0 ? ` · ${fmtSize(speed.rate)}/s` : ""}` }),
      ev.dir === "out" ? cancel : ""),
    bar);
  box.hidden = false;
}

if (wifiApi) {
  $("wifiSwitch").replaceWith(Object.assign(makeSwitch(false, async (on) => {
    Object.assign(wifiState, on ? await wifiApi.start() : await wifiApi.stop());
    if (!on) { wifiState.devices = []; wifiState.link = null; wifiIncoming(null); $("wifiProgress").hidden = true; }
    renderWifi();
    if (on) refreshWifiLink();
    return wifiState.running;
  }), { id: "wifiSwitch" }));
  $("wifiScan").addEventListener("click", () => { wifiApi.scan().catch(showError); toast("Looking for devices…"); setTimeout(refreshWifiLink, 3000); });
  for (const b of document.querySelectorAll('[data-panel="wifi"] .to-settings')) b.addEventListener("click", () => show("settings"));
  $("wifiOpen").addEventListener("click", () => wifiApi.openFolder().catch(showError));
  wifiApi.onEvent((ev) => {
    switch (ev.type) {
      case "devices": {
        const known = new Set(wifiState.devices.map((d) => d.fingerprint));
        wifiState.devices = ev.devices;
        if (current === "wifi") { renderWifi(); if (ev.devices.some((d) => !known.has(d.fingerprint))) setTimeout(refreshWifiLink, 500); }
        break;
      }
      case "incoming": wifiIncoming(ev); toast(`${ev.from.alias} wants to send you files`); break;
      case "incoming-expired": if (wifiState.incoming?.requestId === ev.requestId) wifiIncoming(null); break;
      case "progress": wifiProgress(ev); break;
      case "done":
        $("wifiProgress").hidden = true;
        wifiRadar?.end(wifiDeviceOf(ev.from)?.fingerprint, true);
        toast(`Received ${ev.files.length} file${ev.files.length > 1 ? "s" : ""} from ${ev.from.alias} (in ${ev.saveDir})`);
        break;
      case "cancelled":
        $("wifiProgress").hidden = true;
        if (ev.dir === "in") wifiRadar?.end(null, false);
        toast(`${ev.message}${ev.files?.length ? ` · ${ev.files.length} file(s) were saved` : ""}`);
        break;
      case "warning": toast(ev.message); break;
    }
  });
} else {
  $("wifiSwitch").replaceWith(Object.assign(makeSwitch(false, async () => false), { id: "wifiSwitch", disabled: true }));
}

// ---------- test automation (record & replay; see ./autotest.js) ----------
// The floating "Recording" badge on the phone (companion's RecOverlay). The badge lives as long as the
// connection opened here, so it disappears by itself if this app or the link goes away.
// Returns { update(steps, last), close() }, or { missing: "missing" | "outdated" } when the companion
// has to be installed first (pass install = true after the tester agreed to that).
async function openRecBadge({ steps = 0, last = "", install = false, onClose = null } = {}) {
  const phone = adb;
  if (!companionInfo) {
    const st = await companionStatus();
    if (st.state === "ready") companionInfo = st.info;
    else if (st.state === "stopped") companionInfo = await startCompanion(() => {});
    else if (install) companionInfo = await ensureCompanion(() => {});
    else return { missing: st.state };
  }
  // "Display over other apps": only the computer can switch it on without a trip to Settings.
  // Both the app-wide and the per-package setting: a Galaxy S20 kept refusing with only the second.
  await sh(`appops set --uid ${COMPANION_PKG} SYSTEM_ALERT_WINDOW allow; appops set ${COMPANION_PKG} SYSTEM_ALERT_WINDOW allow`).catch(() => {});
  const open = () => adb.createSocket(`localabstract:${COMPANION_SOCKET}`);
  let socket;
  try { socket = await open(); }
  catch { companionInfo = await startCompanion(() => {}); socket = await open(); }
  const enc = new TextEncoder();
  const writer = socket.writable.getWriter();
  const send = (o) => writer.write(enc.encode(JSON.stringify(o) + "\n"));
  let closed = false, timer = null, opened = false;
  // byUs = we closed it; otherwise the phone side went away (e.g. the companion was stopped).
  const close = (byUs = false) => {
    if (closed) return;
    closed = true; clearInterval(timer);
    Promise.resolve(socket.close()).catch(() => {});
    if (!byUs && opened) onClose?.();
  };
  try {
    await send({ id: 1, method: "rec.session", params: { steps, last } });
    const reader = socket.readable.getReader(), dec = new TextDecoder();
    let buf = "";
    while (!buf.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    // Nothing more is expected, but the stream must keep draining; its end means the badge is gone.
    (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch {} close(); })();
    const reply = JSON.parse(buf.split("\n")[0] || "{}");
    if (reply.error) throw new Error(reply.error);
    if (!reply.result?.overlay) throw new Error("The phone didn't allow the recording badge to be shown over other apps");
  } catch (e) { close(true); throw e; }
  opened = true;
  timer = setInterval(() => { if (adb !== phone) close(true); else send({ ping: true }).catch(() => close()); }, 20_000);
  return { update: (n, text) => { if (!closed) send({ steps: n, last: text }).catch(() => close()); }, close: () => close(true) };
}

autotest = initAutotest({
  $, el, toast, showError, sh, shBytes, shQuote, withSync, download, armedClick,
  getAdb: () => adb, getMirror: () => mirror, startMirror, stopMirror,
  openRecBadge, companionPkg: COMPANION_PKG,
});
try { if (localStorage.getItem("andromon.debug")) window.ddAutotest = autotest._debug; } catch {}

// ---------- developer tab (see ./devtools.js and ./dev/*.js) ----------
// ---------- ADB shell page (see ./shell.js); before the developer tools, which add saved snippets and history to it ----------
const shellTab = initShell({ $, el, toast, showError, sh, download, show, getAdb: () => adb });
// ---------- knowledge drawer: how each page works, and a tour of it (see ./knowledge.js) ----------
const knowledge = initKnowledge({ $, el, extras: { shell: () => ({ title: "Command guide", node: shellTab.guidePanel }) } });
shellTab.setOnPick(() => knowledge.close());
devtools = initDevtools({
  $, el, toast, showError, clearError, sh, shBytes, shQuote, withSync, download, armedClick, busy, makeSwitch, fmtSize,
  spinner, readAll, track, getAdb: () => adb,
  openExtraUsbPhone, swapMainPhone, phoneVia: (a) => phoneVia.get(a) || "usb",
});
apptesting = initAppTesting({
  $, el, toast, showError, clearError, sh, shBytes, shQuote, withSync, download, armedClick, busy, makeSwitch, fmtSize,
  spinner, readAll, track, getAdb: () => adb,
});

// ---------- the Shizuku page (see ./shizuku.js) ----------
shizukuCard = initShizuku({ $, el, toast, sh, shQuote, actionBtn, getAdb: () => adb });

// ---------- ReVanced page (see ./revanced.js) ----------
revancedTab = initRevanced({ $, el, toast, showError, clearError, sh, shQuote, withSync, busy, fmtSize, spinner, actionBtn, appIdent, getAdb: () => adb });
try { if (localStorage.getItem("andromon.debug")) window.ddRevanced = revancedTab._debug; } catch {}

// ---------- F-Droid page (see ./fdroid.js) ----------
fdroidTab = initFdroid({ $, el, toast, showError, clearError, sh, shQuote, withSync, busy, fmtSize, spinner, actionBtn, getAdb: () => adb });

// ---------- phone links (see ./links.js) ----------
links = initLinks({
  $, el, toast, showError, clearError, sh, shQuote, busy, armedClick, cc, getAdb: () => adb,
  companionPkg: COMPANION_PKG, ensureCompanion, grantNotifAccess, restartEvents: () => startCallAlerts(),
});

// ---------- personal data: contacts extras, calendar, backup and restore (./people.js, ./calendar.js, ./backup.js) ----------
people = initPeople({
  $, el, toast, showError, clearError, busy, armedClick, cc, spinner, needPermission, getAdb: () => adb,
  getContacts: () => contactsCache, render: () => renderContacts(), reload: () => loadContacts(true),
});
calendarTab = initCalendar({
  $, el, toast, showError, clearError, busy, cc, download, spinner, withCompanion, needPermission, ensurePerms,
});
backup = initBackup({
  $, el, toast, showError, clearError, busy, armedClick, makeSwitch, cc, sh, shQuote, withSync, fmtSize, fmtDate, spinner, nameFor,
  getAdb: () => adb, companionInfo: () => companionInfo, companionAvailable, showSettings: () => show("settings"),
  contactsVcf, addContacts, restoreSms, restoreCalls, calendar: () => calendarTab,
  contactsChanged: () => { contactsCache = null; },
  installApk: (parts, label, pkgName, progress) => runInstall({ pkg: { info: { label, package: pkgName }, obb: [] }, pick: { chosen: parts } }, progress),
});

// The header stays in place while a page scrolls; its height tells sticky parts of a page where to stop.
new ResizeObserver(([e]) => document.querySelector(".app").style.setProperty("--head-h", `${Math.round(e.target.offsetHeight)}px`)).observe(document.querySelector("header.top"));
// ---------- screenshot page (see ./screenshot.js) ----------
shotTab = initScreenshot({ $, el, toast, showError, clearError, sh, shBytes, fmtSize, download, show, getAdb: () => adb });
// ---------- files page (see ./files.js) ----------
filesTab = initFiles({ $, el, toast, showError, clearError, busy, sh, shQuote, withSync, fmtSize, fmtDate, download, getAdb: () => adb, LinuxFileType });
// ---------- dropdown menus: every <select> gets the app's own menu (see ./dropdown.js) ----------
initDropdowns();
// ---------- download manager: the Downloads button in the page header (see ./downloads.js) ----------
downloads = initDownloads({ $, el, fmtSize, fmtDate, show });
// ---------- update check (updater.js): a pill in the header when a newer build is published ----------
{
  const updates = globalThis.andromon?.updates, pill = $("updBtn");
  const offer = (s) => { if (s?.last?.available) { pill.textContent = `Update to ${s.last.version}`; pill.hidden = false; } };
  pill.addEventListener("click", () => show("settings"));
  updates?.onEvent((ev) => { if (ev.kind === "available") { offer(ev.status); toast(`Andromon ${ev.status.last.version} is available`); } });
  updates?.status().then(offer).catch(() => {});
}
// ---------- settings tab: appearance, sidebar and a few switches (see ./settings.js) ----------
// With "Ask where to save each file" off, the main process saves downloads itself and says so here.
globalThis.andromon?.app?.onEvent((ev) => { if (ev.kind === "saved") toast(ev.ok ? `Saved ${ev.name}` : `Couldn't save ${ev.name}`); });
settingsUi = initSettings({
  $, el, makeSwitch, fmtSize, fmtDate, busy, showError, toast, armedClick, companionVersion: COMPANION_VERSION, scrcpyVersion: SCRCPY_VERSION,
  mirror: mirrorPrefs, shot: shotPrefs, shell: shellPrefs,
  downloads,
  notifs: {
    get: () => notifs.on,
    set: (on) => { notifs.on = !!on; lsSet("andromon.notifs", notifs.on); if (!notifs.on) resetNotifs(); startCallAlerts(); renderNotifCard(); },
    muted: () => [...notifs.muted].map((pkg) => ({ pkg, label: notifs.icons.get(pkg)?.app || pkg })),
    unmute: (pkg) => { notifs.muted.delete(pkg); lsSet("andromon.notifMuted", [...notifs.muted]); renderNotifCard(); },
    quick: () => notifs.quick,
    setQuick: (lines) => { notifs.quick = lines.map((l) => l.trim()).filter(Boolean).slice(0, 12); lsSet("andromon.quickReplies", notifs.quick); return notifs.quick; },
  },
  ramAuto: { get: ramAuto, set: (on) => { try { localStorage.setItem(RAM_AUTO_KEY, on ? "1" : "0"); } catch {} return !!on; } },
  photoCopy: () => backup?.auto,
  wifiMethod: { NAMES: METHOD_NAMES, NOTES: METHOD_NOTES },
  uad: { read: readUadCache, update: async () => { Object.assign(debloat, await downloadUadList()); } },
  callAlerts: {
    get: () => callAlerts.on,
    set: (on) => {
      callAlerts.on = !!on;
      try { localStorage.setItem("andromon.callAlerts", on ? "on" : "off"); } catch {}
      if (!on) hideCallPop();
      startCallAlerts();
    },
  },
  notifPopups: { get: () => notifs.popups, set: (on) => { notifs.popups = !!on; lsSet("andromon.notifPopups", notifs.popups); renderNotifCard(); } },
  wifiAuto: wadbApi ? { get: () => !!wadbUi.auto, set: async (on) => { wadbUi.auto = await wadbApi.setAuto(on); if (wadbUi.auto) maybeAutoConnect(); return wadbUi.auto; } } : null,
});
