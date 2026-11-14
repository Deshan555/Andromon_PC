// Droid Desk — Electron main process.
// The UI in renderer/ talks ADB to the phone over WebUSB (Chromium built into Electron).
// This file only creates the window, serves the UI from a secure app:// origin,
// and answers Chromium's WebUSB permission + device-chooser requests.
const { app, BrowserWindow, protocol, net, session, dialog, shell, Menu, ipcMain, MessageChannelMain, Notification, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const os = require("node:os");
const { LocalSend } = require("./localsend.js");
const wadb = require("./wadb.js");
const { setupApiClient } = require("./apiclient.js");
const { setupTraceView } = require("./traceview.js");
const { setupInspector } = require("./inspector.js");
const { setupBackupFs } = require("./backupfs.js");

const RENDERER_DIR = path.join(__dirname, "renderer");
const ORIGIN = "app://droiddesk";

// app:// must be "secure" (WebUSB needs a secure context) and "standard" (gives a stable
// origin so IndexedDB keeps the ADB RSA key between launches -> no re-authorizing each time).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveRenderer() {
  protocol.handle("app", (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== "droiddesk") return new Response("Not found", { status: 404 });
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    // Block path traversal out of the renderer folder.
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response("Forbidden", { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function allowWebUsb() {
  const ses = session.defaultSession;
  const fromApp = (origin) => typeof origin === "string" && origin.startsWith(ORIGIN);

  // Only our own UI may use USB, go full screen (screen mirror), save into a folder it picks, and write the clipboard
  // (text copied on the phone). Every other permission (camera, mic, location...) is denied.
  // "fileSystem": the folder picker used by Photos/Music "Copy to computer" (File System Access API).
  // "clipboard-read": Overview › Phone links › "Copy to phone's clipboard" reads this computer's clipboard on a click.
  const ALLOWED = new Set(["usb", "fullscreen", "clipboard-sanitized-write", "clipboard-read", "fileSystem"]);
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ALLOWED.has(permission) && fromApp(requestingOrigin));
  ses.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(ALLOWED.has(permission) && fromApp(details?.requestingUrl || wc?.getURL())));
  ses.setDevicePermissionHandler((details) => details.deviceType === "usb" && fromApp(details.origin));

  // Chromium has no built-in WebUSB picker in Electron, so we provide one.
  ses.on("select-usb-device", async (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList;
    if (devices.length === 0) {
      await dialog.showMessageBox({
        type: "info",
        message: "No Android phone found",
        detail:
          "• Connect the phone with a data-capable USB cable.\n" +
          "• Turn on Developer options → USB debugging.\n" +
          "• On Windows, older phones (Android 9 and below) may need the Google or manufacturer USB driver.\n" +
          "• Close other phone tools (adb, Android Studio, scrcpy) that may be holding the device.",
      });
      return callback();
    }
    if (devices.length === 1) return callback(devices[0].deviceId);

    const labels = devices.map((d) => {
      const name = [d.manufacturerName, d.productName].filter(Boolean).join(" ") || "Android device";
      return `${name}${d.serialNumber ? ` (${d.serialNumber})` : ""}`;
    });
    const { response } = await dialog.showMessageBox({
      type: "question",
      message: "Choose a phone",
      buttons: [...labels, "Cancel"],
      cancelId: labels.length,
    });
    callback(response < devices.length ? devices[response].deviceId : undefined);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    title: "Droid Desk",
    backgroundColor: "#111317",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      spellcheck: false,
      // Test runs, mirroring and link checks must keep their timing when the window is behind others.
      backgroundThrottling: false,
    },
  });
  win.once("ready-to-show", () => win.show());

  // Keep navigation inside the app; open external links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });

  win.loadURL(`${ORIGIN}/index.html`);
  mainWindow = win;
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
}

// ---------- Wi‑Fi transfer (LocalSend protocol, see localsend.js) ----------
let mainWindow = null;
let wifi = null;
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), "utf8")); } catch { return {}; } }
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}
const defaultSaveDir = () => path.join(app.getPath("downloads"), "Droid Desk");

function setupWifi() {
  wifi = new LocalSend({
    userData: app.getPath("userData"),
    saveDir: readSettings().wifiSaveDir || defaultSaveDir(),
    emit: (ev) => mainWindow?.webContents.send("wifi:event", ev),
  });
  // Only our own UI (app://droiddesk) may drive the network service.
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    const url = event.senderFrame?.url || "";
    if (!url.startsWith(ORIGIN + "/")) throw new Error("Not allowed");
    return fn(event, ...args);
  });
  handle("adb:release", () => releaseAdb());
  setupWadb(handle);
  setupNotify(handle);
  setupDevnet(handle);
  setupApiClient(handle); // App testing › API tester
  setupTraceView(handle, (url) => shell.openExternal(url)); // App testing › Traces
  inspector = setupInspector(handle, { userData: app.getPath("userData"), getWindow: () => mainWindow }); // App testing › API calls
  setupBackupFs(handle, { userData: app.getPath("userData"), readSettings, writeSettings }); // Phone backup, restore, automatic photo copy
  const method = (m) => (["auto", "lan", "direct"].includes(m) ? m : readSettings().wifiMethod || "auto");
  handle("wifi:status", () => ({ ...wifi.status(), method: method() }));
  handle("wifi:setMethod", (_e, m) => { if (["auto", "lan", "direct"].includes(m)) writeSettings({ wifiMethod: m }); return method(); });
  handle("wifi:link", () => wifi.linkReport());
  handle("wifi:start", () => wifi.start());
  handle("wifi:stop", () => { wifi.stop(); return wifi.status(); });
  handle("wifi:scan", () => { wifi.announce(); return true; });
  handle("wifi:respond", (_e, id, accept) => { wifi.respond(id, accept); return true; });
  handle("wifi:cancelSend", () => { wifi.cancelSend(); return true; });
  handle("wifi:openFolder", async () => {
    fs.mkdirSync(wifi.saveDir, { recursive: true });
    const err = await shell.openPath(wifi.saveDir);
    if (err) throw new Error(err);
    return true;
  });
  handle("wifi:chooseFolder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { title: "Save received files in", properties: ["openDirectory", "createDirectory"], defaultPath: wifi.saveDir });
    if (!r.canceled && r.filePaths[0]) { wifi.saveDir = r.filePaths[0]; writeSettings({ wifiSaveDir: wifi.saveDir }); }
    return wifi.status();
  });
  handle("wifi:pickAndSend", async (event, fingerprint, m) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { title: "Choose files to send", properties: ["openFile", "multiSelections"] });
    if (r.canceled || !r.filePaths.length) return null;
    return wifi.sendFiles(fingerprint, r.filePaths, method(m));
  });
  handle("wifi:sendPaths", (_e, fingerprint, paths, m) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && path.isAbsolute(p))) throw new Error("Invalid files");
    return wifi.sendFiles(fingerprint, paths, method(m));
  });
}

// ---------- port forwarding for the Developer tab ----------
// The page speaks ADB itself, so this only does the PC end of a forward: plain TCP on 127.0.0.1.
// Each TCP connection becomes a MessagePort pair; the page pipes it to an ADB socket on the phone.
//  - listen: a server on 127.0.0.1:port; every accepted connection is handed to the page ("accept").
//  - connect: the phone opened a reverse-forwarded port; dial 127.0.0.1:port and hand it over ("connect").
// Only loopback, only our own UI, at most MAX_LINKS connections at a time.
let inspector = null; // App testing › API calls proxy (inspector.js)
let devnetStopAll = () => {};
function setupDevnet(handle) {
  const nodeNet = require("node:net");
  const MAX_LINKS = 128;
  const RULE = /^[\w-]{1,40}$/;
  const servers = new Map(); // ruleId -> { server, sockets: Set }
  let links = 0;
  const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
  const watched = new WeakSet();

  // Stop everything when the page goes away (reload, close, crash).
  const watch = (sender) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    sender.on("did-navigate", stopAll); // reload or navigation (not downloads)
    sender.on("render-process-gone", stopAll);
    sender.once("destroyed", stopAll);
  };

  function bridge(sock, sender, meta) {
    const { port1, port2 } = new MessageChannelMain();
    let closed = false;
    links++;
    const close = () => {
      if (closed) return;
      closed = true; links--;
      try { port1.postMessage({ closed: true }); } catch {}
      try { port1.close(); } catch {}
      sock.destroy();
    };
    sock.setNoDelay(true);
    sock.on("data", (d) => { try { port1.postMessage(new Uint8Array(d)); } catch { close(); } });
    sock.on("end", close);
    sock.on("close", close);
    sock.on("error", close);
    port1.on("message", (e) => {
      const d = e.data;
      if (d instanceof Uint8Array || d instanceof ArrayBuffer) { if (!sock.destroyed) sock.write(Buffer.from(d)); }
      else if (d && d.closed) {
        // The phone side hung up: send what's still queued, then close (destroy() would drop it).
        if (sock.destroyed) return close();
        sock.end(); setTimeout(close, 5000).unref();
      }
    });
    port1.on("close", close);
    port1.start();
    try { sender.postMessage("devnet:port", meta, [port2]); } catch { close(); }
    return close;
  }

  function unlisten(ruleId) {
    const s = servers.get(ruleId);
    if (!s) return;
    servers.delete(ruleId);
    s.server.close();
    for (const sock of s.sockets) sock.destroy();
  }
  function stopAll() { for (const id of [...servers.keys()]) unlisten(id); }
  devnetStopAll = stopAll;

  handle("devnet:listen", (event, ruleId, port) => {
    if (!RULE.test(ruleId) || !validPort(port)) throw new Error("Invalid port");
    watch(event.sender);
    unlisten(ruleId);
    return new Promise((resolve, reject) => {
      const entry = { server: null, sockets: new Set() };
      const server = nodeNet.createServer((sock) => {
        if (links >= MAX_LINKS || servers.get(ruleId) !== entry) { sock.destroy(); return; }
        entry.sockets.add(sock);
        sock.on("close", () => entry.sockets.delete(sock));
        bridge(sock, event.sender, { kind: "accept", ruleId });
      });
      entry.server = server;
      server.once("error", (e) => reject(new Error(e.code === "EADDRINUSE"
        ? `Port ${port} on this computer is already in use by another program`
        : e.code === "EACCES" ? `This computer doesn't allow listening on port ${port}` : e.message)));
      server.listen(port, "127.0.0.1", () => {
        server.on("error", () => {});
        servers.set(ruleId, entry);
        resolve(true);
      });
    });
  });
  handle("devnet:unlisten", (_e, ruleId) => { unlisten(String(ruleId)); return true; });
  handle("devnet:unlistenAll", () => { stopAll(); return true; });
  handle("devnet:connect", (event, reqId, port) => {
    if (!RULE.test(reqId) || !validPort(port)) throw new Error("Invalid port");
    if (links >= MAX_LINKS) throw new Error("Too many open connections");
    watch(event.sender);
    return new Promise((resolve, reject) => {
      const sock = nodeNet.connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Nothing answered on port ${port} on this computer`)); }, 5000);
      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(new Error(e.code === "ECONNREFUSED" ? `Nothing is listening on port ${port} on this computer` : e.message));
      });
      sock.once("connect", () => {
        clearTimeout(timer);
        bridge(sock, event.sender, { kind: "connect", reqId });
        resolve(true);
      });
    });
  });
}

// ---------- system notifications (call alerts) ----------
// The page decides what to show; this only puts it on screen and reports clicks back. Buttons
// ("actions") only appear on macOS, and only in a signed build (see "extendInfo" in package.json);
// everywhere else a click opens the window, where the call card has the same buttons.
function setupNotify(handle) {
  const shown = new Map();
  const send = (ev) => mainWindow?.webContents.send("notify:event", ev);
  const focus = () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
  };
  const close = (id) => { const n = shown.get(id); shown.delete(id); n?.close(); };
  handle("notify:show", (_e, opts) => {
    if (!Notification.isSupported() || !opts || typeof opts !== "object") return false;
    const id = String(opts.id || "").slice(0, 80);
    close(id);
    const n = new Notification({
      title: String(opts.title || "").slice(0, 120),
      body: String(opts.body || "").slice(0, 300),
      silent: !!opts.silent,
      urgency: opts.urgent ? "critical" : "normal",
      timeoutType: opts.urgent ? "never" : "default",
      actions: process.platform === "darwin" && Array.isArray(opts.actions)
        ? opts.actions.slice(0, 3).map((t) => ({ type: "button", text: String(t).slice(0, 30) })) : [],
      // macOS shows a reply field ("reply" event below); elsewhere a click opens the window.
      hasReply: process.platform === "darwin" && !!opts.reply,
      replyPlaceholder: "Reply",
      icon: typeof opts.icon === "string" && /^data:image\/(png|jpeg);base64,/.test(opts.icon) && opts.icon.length < 300_000
        ? nativeImage.createFromDataURL(opts.icon) : undefined,
    });
    n.on("reply", (_ev, text) => send({ id, kind: "reply", text: String(text || "").slice(0, 4000) }));
    n.on("click", () => { focus(); send({ id, kind: "click" }); });
    n.on("action", (_ev, index) => send({ id, kind: "action", index }));
    n.on("close", () => { if (shown.get(id) === n) shown.delete(id); });
    shown.set(id, n);
    n.show();
    return true;
  });
  handle("notify:close", (_e, id) => { close(String(id)); return true; });
}

// ---------- wireless ADB (Wireless debugging: QR / code pairing, TLS link; see wadb.js) ----------
let mdns = null, qrPairing = null;
const wadbSend = (ev) => mainWindow?.webContents.send("wadb:event", ev);
// Phones this computer can reach over Wi‑Fi: { serial, model, lastHost, lastPort, addedAt, how }.
const pairedPhones = () => (readSettings().wadbPhones || []).map((p) => (p.serial ? p : { ...p, serial: wadb.serialOfService(p.guid || "") })).filter((p) => p.serial);
function savePhone(serial, patch) {
  const prev = pairedPhones().find((p) => p.serial === serial) || { serial, addedAt: Date.now() };
  writeSettings({ wadbPhones: [{ ...prev, ...patch, serial }, ...pairedPhones().filter((p) => p.serial !== serial)].slice(0, 20) });
}
function startMdns() {
  if (!mdns) {
    mdns = new wadb.AdbMdns((services) => wadbSend({ type: "services", services }));
    mdns.start();
  }
  return mdns;
}
const state = () => ({ services: mdns ? mdns.list() : [], phones: pairedPhones(), auto: !!readSettings().wadbAuto });
async function afterPaired(guid, from) {
  savePhone(wadb.serialOfService(guid), { lastHost: from?.host, how: "paired" });
  wadbSend({ type: "paired", serial: wadb.serialOfService(guid), ...state() });
}

function setupWadb(handle) {
  const userData = app.getPath("userData");
  const SERIAL = /^[\w.:-]{1,64}$/;
  // The renderer's USB key (PKCS#8), so phones that trust this computer over USB accept it over Wi‑Fi.
  handle("wadb:setKey", (_e, pkcs8) => {
    if (!(pkcs8 instanceof Uint8Array) || pkcs8.length > 4096) throw new Error("Invalid key");
    wadb.setKey(pkcs8);
    return true;
  });
  handle("wadb:browse", (_e, on) => {
    if (on) { startMdns(); return state(); }
    if (!qrPairing) { mdns?.stop(); mdns = null; }
    return null;
  });
  handle("wadb:setAuto", (_e, on) => { writeSettings({ wadbAuto: !!on }); return !!on; });
  handle("wadb:remember", (_e, p) => {
    const serial = String(p?.serial || "");
    if (!SERIAL.test(serial)) throw new Error("Invalid phone");
    savePhone(serial, { model: String(p.model || "").slice(0, 80), lastHost: String(p.host || ""), lastPort: Number(p.port) || 0, how: "usb-setup" });
    return state();
  });
  // QR pairing: returns the QR text; progress and the result arrive as "wadb:event"s.
  handle("wadb:qr", () => {
    if (qrPairing) qrPairing.cancelled = true;
    const qr = wadb.newQr();
    const job = (qrPairing = { cancelled: false });
    startMdns();
    (async () => {
      try {
        const svc = await wadb.waitForService(mdns, "pairing", qr.name, 5 * 60_000, () => job.cancelled);
        wadbSend({ type: "pairing", stage: "pairing", host: svc.host });
        const guid = await wadb.pair({ host: svc.host, port: svc.port, password: qr.password, userData });
        await afterPaired(guid, svc);
      } catch (e) {
        if (!job.cancelled) wadbSend({ type: "pair-error", message: e.message });
      } finally {
        if (qrPairing === job) qrPairing = null;
      }
    })();
    return { text: qr.text, name: qr.name };
  });
  handle("wadb:cancelPair", () => { if (qrPairing) qrPairing.cancelled = true; qrPairing = null; return true; });
  handle("wadb:pairCode", async (_e, host, port, code) => {
    host = String(host).trim(); port = Number(port); code = String(code).replace(/\s/g, "");
    if (!/^[0-9a-fA-F.:\[\]-]+$/.test(host) || !(port > 0 && port < 65536) || !/^\d{6}$/.test(code)) throw new Error("Enter the IP address & port and the 6-digit code shown on the phone.");
    const guid = await wadb.pair({ host, port, password: code, userData });
    await afterPaired(guid, { host });
    return wadb.serialOfService(guid);
  });
  handle("wadb:forget", (_e, serial) => { writeSettings({ wadbPhones: pairedPhones().filter((p) => p.serial !== serial) }); return state(); });
  // Opens the link and hands the renderer a MessagePort carrying raw ADB bytes.
  handle("wadb:connect", async (event, target) => {
    const serial = target?.serial ? String(target.serial) : null;
    // Where to try, in order: what the phone advertises now (mDNS), then where it was last time.
    const candidates = [];
    if (target?.host && Number(target?.port)) candidates.push({ host: String(target.host), port: Number(target.port) });
    if (serial) {
      startMdns();
      const svc = await wadb.waitForService(mdns, "connect", (name) => wadb.serialOfService(name) === serial, 8000).catch(() => null);
      if (svc) candidates.push({ host: svc.host, port: svc.port });
      const saved = pairedPhones().find((p) => p.serial === serial);
      if (saved?.lastHost && saved.lastPort) candidates.push({ host: saved.lastHost, port: saved.lastPort });
      if (!candidates.length) throw new Error("The phone isn't on the network right now. On the phone, open Droid Desk Companion › PC link and tap “Turn on Wi‑Fi connection” (same Wi‑Fi as this computer).");
    }
    if (!candidates.length) throw new Error("Enter the phone's IP address & port (Wireless debugging › IP address & Port).");
    const { port1, port2 } = new MessageChannelMain();
    let link = null, host = "", port = 0, lastErr = null;
    for (const c of candidates.filter((c, i, a) => c.host && c.port > 0 && c.port < 65536 && a.findIndex((x) => x.host === c.host && x.port === c.port) === i)) {
      const l = wadb.openLink({
        host: c.host, port: c.port, userData,
        onData: (d) => { try { port1.postMessage(new Uint8Array(d)); } catch {} },
        onClose: (err) => { if (link !== l) return; try { port1.postMessage({ closed: true, error: err?.message || null }); port1.close(); } catch {} },
      });
      try {
        await Promise.race([l.connected, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), 6000))]);
        link = l; host = c.host; port = c.port; break;
      } catch (e) { lastErr = e; l.close(); }
    }
    if (!link) {
      port1.close();
      const c = candidates[0];
      throw new Error(`Couldn't reach the phone at ${c.host}:${c.port} (${lastErr?.code || lastErr?.message}). Check that both are on the same Wi‑Fi.`);
    }
    port1.on("message", (e) => { if (e.data instanceof Uint8Array || e.data instanceof ArrayBuffer) link.write(Buffer.from(e.data)); });
    port1.on("close", () => link.close());
    port1.start();
    if (serial) savePhone(serial, { lastHost: host, lastPort: port });
    event.sender.postMessage("wadb:port", { serial: serial || `${host}:${port}`, host, port }, [port2]);
    return true;
  });
}

// ---------- free the phone from another adb server ----------
// WebUSB can't claim the phone while an adb server (from the SDK, Android Studio, scrcpy...)
// holds its USB interface. Stop it: politely with `adb kill-server`, then any adb left over.
function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") })));
}
function adbCandidates() {
  const win = process.platform === "win32";
  const exe = win ? "adb.exe" : "adb";
  const home = os.homedir();
  const dirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
    .filter(Boolean).map((d) => path.join(d, "platform-tools"));
  // Apps started from Finder get a minimal PATH, so also try the usual install places.
  if (process.platform === "darwin") dirs.push(path.join(home, "Library/Android/sdk/platform-tools"), "/opt/homebrew/bin", "/usr/local/bin");
  else if (win) dirs.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData/Local"), "Android/Sdk/platform-tools"),
    path.join(home, "scoop/shims"), "C:\\platform-tools", path.join(process.env.ProgramData || "C:\\ProgramData", "chocolatey/bin"));
  else dirs.push(path.join(home, "Android/Sdk/platform-tools"), "/usr/local/bin", "/usr/bin");
  dirs.push(...(process.env.PATH || "").split(path.delimiter).filter(Boolean));
  return [...new Set(dirs.map((d) => path.join(d, exe)))].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}
async function releaseAdb() {
  let killServer = false;
  for (const bin of adbCandidates()) {
    if ((await run(bin, ["kill-server"])).ok) { killServer = true; break; }
  }
  await new Promise((r) => setTimeout(r, 400));
  // Whatever is still running (a server that ignored kill-server, or one whose adb isn't on this PC's PATH).
  const forced = process.platform === "win32"
    ? (await run("taskkill", ["/F", "/T", "/IM", "adb.exe"])).ok
    : (await run("pkill", ["-x", "adb"])).ok;
  return { killServer, forced };
}

app.whenReady().then(() => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  if (process.platform === "win32") app.setAppUserModelId("dev.droiddesk.app"); // needed for notifications
  serveRenderer();
  allowWebUsb();
  setupWifi();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => { wifi?.stop(); devnetStopAll(); inspector?.stop().catch(() => {}); });

app.on("window-all-closed", () => {
  wifi?.stop(); // never leave a network listener running without a window to ask for consent
  if (process.platform !== "darwin") app.quit();
});
