// Andromon — preload. Exposes a small, fixed API to the sandboxed UI for Wi‑Fi transfer
// (LocalSend protocol, implemented in localsend.js in the main process). No Node.js APIs leak through.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Electron prefixes errors from the main process with "Error invoking remote method ...": strip that.
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((e) => {
  throw new Error(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
});

// The phone's Android level and CPU types, for choosing an app version that fits (F-Droid page).
const fdPhone = (p) => (p && Number(p.sdk) > 0 ? { sdk: Number(p.sdk), abis: Array.from(p.abis || [], String) } : null);

contextBridge.exposeInMainWorld("andromon", {
  // release(serial) closes the programs (adb servers and others) holding the phone so WebUSB can claim it.
  // guard(true, serial) does that and keeps closing adb started by other programs while a phone is
  // connected; guard(false) stops it. Both resolve to { closed: [names], browsers: [names], ... }.
  adb: { release: (serial) => call("adb:release", String(serial || "")), guard: (on, serial) => call("adb:guard", !!on, String(serial || "")) },
  // Screen mirror › Keep on top: the window stays above other windows.
  win: { setOnTop: (on) => call("win:setOnTop", !!on) },
  // Wireless debugging (wadb.js). The ADB byte stream itself arrives as a MessagePort, forwarded
  // below to the page with window.postMessage.
  wadb: {
    browse: (on) => call("wadb:browse", !!on),
    qr: () => call("wadb:qr"),
    cancelPair: () => call("wadb:cancelPair"),
    pairCode: (host, port, code) => call("wadb:pairCode", String(host), Number(port), String(code)),
    connect: (target) => call("wadb:connect", target && typeof target === "object"
      ? { serial: target.serial ? String(target.serial) : undefined, host: target.host ? String(target.host) : undefined, port: Number(target.port) || undefined } : null),
    forget: (serial) => call("wadb:forget", String(serial)),
    // The USB adb key (PKCS#8 bytes), reused for Wi‑Fi so already-trusted phones need no pairing.
    setKey: (pkcs8) => call("wadb:setKey", new Uint8Array(pkcs8)),
    remember: (phone) => call("wadb:remember", { serial: String(phone.serial), model: String(phone.model || ""), host: String(phone.host || ""), port: Number(phone.port) || 0 }),
    setAuto: (on) => call("wadb:setAuto", !!on),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("wadb:event", h);
      return () => ipcRenderer.removeListener("wadb:event", h);
    },
  },
  // System notifications (calls, phone notifications). onEvent gets {id, kind: "click" | "action" | "reply", index, text}.
  notify: {
    show: (opts) => call("notify:show", {
      id: String(opts?.id || ""), title: String(opts?.title || ""), body: String(opts?.body || ""),
      silent: !!opts?.silent, urgent: !!opts?.urgent, actions: Array.isArray(opts?.actions) ? opts.actions.map(String) : [],
      reply: !!opts?.reply, icon: typeof opts?.icon === "string" ? opts.icon : "",
    }),
    close: (id) => call("notify:close", String(id)),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("notify:event", h);
      return () => ipcRenderer.removeListener("notify:event", h);
    },
  },
  // Developer tab port forwarding (main.js setupDevnet). TCP on this computer's 127.0.0.1 only;
  // each connection arrives as a MessagePort, forwarded below with window.postMessage.
  // App testing › API tester: one HTTP(S) request sent by the main process (apiclient.js).
  api: {
    send: (id, req) => call("api:send", String(id), {
      method: String(req?.method || "GET"), url: String(req?.url || ""),
      headers: Array.isArray(req?.headers) ? req.headers.map((h) => [String(h?.[0] ?? ""), String(h?.[1] ?? "")]) : [],
      body: req?.body == null ? null : String(req.body), bodyBase64: req?.bodyBase64 ? String(req.bodyBase64) : null,
      timeoutMs: Number(req?.timeoutMs) || 0, insecure: !!req?.insecure, followRedirects: req?.followRedirects !== false,
    }),
    cancel: (id) => call("api:cancel", String(id)),
  },
  // Phone backup, restore and the automatic photo copy (backupfs.js). The page only ever names one
  // of three folders the person picked ("backup", "photos", "restore") plus a relative path inside it.
  backupFs: {
    get: (kind) => call("bfs:get", String(kind)),
    choose: (kind) => call("bfs:choose", String(kind)),
    pickBackup: () => call("bfs:pickBackup"),
    reveal: (kind, rel) => call("bfs:reveal", String(kind), String(rel || "")),
    mkdir: (kind, rel) => call("bfs:mkdir", String(kind), String(rel || "")),
    stat: (kind, rel) => call("bfs:stat", String(kind), String(rel || "")),
    list: (kind, rel, recursive) => call("bfs:list", String(kind), String(rel || ""), !!recursive),
    writeFile: (kind, rel, data, opts) => call("bfs:writeFile", String(kind), String(rel), typeof data === "string" ? data : new Uint8Array(data), { mtime: Number(opts?.mtime) || 0, replace: !!opts?.replace }),
    open: (kind, rel) => call("bfs:open", String(kind), String(rel)),
    write: (id, data) => call("bfs:write", Number(id), new Uint8Array(data)),
    close: (id, opts) => call("bfs:close", Number(id), { mtime: Number(opts?.mtime) || 0 }),
    abort: (id) => call("bfs:abort", Number(id)),
    readFile: (kind, rel) => call("bfs:readFile", String(kind), String(rel)),
    read: (kind, rel, offset, length) => call("bfs:read", String(kind), String(rel), Number(offset) || 0, Number(length) || 0),
    recordGet: (serial) => call("bfs:recordGet", String(serial)),
    recordSet: (serial, record) => call("bfs:recordSet", String(serial), record && typeof record === "object" ? record : {}),
  },
  // App testing › Traces: open a trace in the Perfetto UI in the default browser (traceview.js).
  trace: {
    openPerfetto: (bytes, name) => call("trace:openPerfetto", new Uint8Array(bytes), String(name || "trace")),
  },
  // App testing › API calls: the HTTP(S) proxy that records the phone's requests (inspector.js).
  inspector: {
    start: (opts) => call("inspector:start", { port: Number(opts?.port) || 8899, decrypt: !!opts?.decrypt }),
    stop: () => call("inspector:stop"),
    clear: () => call("inspector:clear"),
    status: () => call("inspector:status"),
    list: () => call("inspector:list"),
    get: (id) => call("inspector:get", Number(id)),
    caPem: () => call("inspector:caPem"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("inspector:event", h);
      return () => ipcRenderer.removeListener("inspector:event", h);
    },
  },
  // ReVanced page: download ReVanced's tools, patch an APK on this computer (revanced.js).
  // The page never names a path: an APK from the phone is streamed in, a dropped file crosses as its path only.
  revanced: {
    status: () => call("rv:status"),
    recheckJava: () => call("rv:recheckJava"),
    setup: () => call("rv:setup"),
    patches: () => call("rv:patches"),
    inputOpen: (name) => call("rv:inputOpen", String(name || "")),
    inputWrite: (data) => call("rv:inputWrite", new Uint8Array(data)),
    inputClose: (ok) => call("rv:inputClose", !!ok),
    inputFile: (file) => call("rv:inputFile", webUtils.getPathForFile(file)),
    patch: (opts) => call("rv:patch", {
      patches: Array.isArray(opts?.patches) ? opts.patches.map(String) : [], force: !!opts?.force,
      // { "<patch>": { "<setting>": "<value>" } }
      options: Object.fromEntries(Object.entries(opts?.options || {}).map(([p, o]) => [String(p), Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [String(k), String(v)]))])),
    }),
    cancel: () => call("rv:cancel"),
    toolInfo: () => call("rv:toolInfo"),
    fetchTool: (which, huawei) => call("rv:fetchTool", String(which), !!huawei),
    read: (which, offset, length) => call("rv:read", String(which), Number(offset) || 0, Number(length) || 0),
    saveOutput: () => call("rv:saveOutput"),
    clear: () => call("rv:clear"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("rv:event", h);
      return () => ipcRenderer.removeListener("rv:event", h);
    },
  },
  // F-Droid page: F-Droid's catalogue of free apps, and an app's APK to install (fdroid.js).
  // The page never names a path or an address: an app is asked for by package name and version code.
  fdroid: {
    status: () => call("fd:status"),
    update: () => call("fd:update"),
    // { q, category, sort, offset, limit, phone: { sdk, abis } }
    search: (o) => call("fd:search", {
      q: String(o?.q || ""), category: String(o?.category || ""), sort: String(o?.sort || ""),
      offset: Number(o?.offset) || 0, limit: Number(o?.limit) || 0, phone: fdPhone(o?.phone),
    }),
    lookup: (pkgs, phone) => call("fd:lookup", Array.from(pkgs || [], String), fdPhone(phone)),
    app: (pkg, phone) => call("fd:app", String(pkg), fdPhone(phone)),
    icon: (pkg) => call("fd:icon", String(pkg)),
    shot: (pkg, i) => call("fd:shot", String(pkg), Number(i) || 0),
    fetch: (pkg, code) => call("fd:fetch", String(pkg), Number(code)),
    read: (offset, length) => call("fd:read", Number(offset) || 0, Number(length) || 0),
    save: () => call("fd:save"),
    cancel: () => call("fd:cancel"),
    clear: () => call("fd:clear"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("fd:event", h);
      return () => ipcRenderer.removeListener("fd:event", h);
    },
  },
  // Settings page: where saved files go, and the size of what Andromon has downloaded (appsettings.js).
  app: {
    info: () => call("app:info"),
    openData: () => call("app:openData"),
    saveOpen: () => call("app:saveOpen"),
    saveAsk: (ask) => call("app:saveAsk", !!ask),
    saveChoose: () => call("app:saveChoose"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("app:event", h);
      return () => ipcRenderer.removeListener("app:event", h);
    },
  },
  // Update check (updater.js): is a newer build published, and download its installer for this computer.
  updates: {
    status: () => call("upd:status"),
    check: () => call("upd:check"),
    setAuto: (on) => call("upd:setAuto", !!on),
    download: () => call("upd:download"),
    cancel: () => call("upd:cancel"),
    install: () => call("upd:install"),
    openReleases: () => call("upd:openReleases"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("upd:event", h);
      return () => ipcRenderer.removeListener("upd:event", h);
    },
  },
  // SD card recovery (recovery.js): PhotoRec on a card in this computer's reader, or on an image file.
  recovery: {
    status: () => call("rc:status"),
    install: () => call("rc:install"),
    drives: () => call("rc:drives"),
    chooseOut: () => call("rc:chooseOut"),
    chooseImage: () => call("rc:chooseImage"),
    start: (opts) => call("rc:start", { source: String(opts?.source || ""), drive: String(opts?.drive || ""), what: String(opts?.what || "") }),
    stop: () => call("rc:stop"),
    open: (dir) => call("rc:open", String(dir || "")),
    openSite: () => call("rc:openSite"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("rc:event", h);
      return () => ipcRenderer.removeListener("rc:event", h);
    },
  },
  // Settings › This computer: the tools Andromon can use (Java, adb…) and whether they are installed (requirements.js).
  system: {
    requirements: (force) => call("sys:requirements", !!force),
    openPage: (id) => call("sys:openPage", String(id)),
    install: (id) => call("sys:install", String(id)),
    adbChoose: () => call("sys:adbChoose"),
    adbReset: () => call("sys:adbReset"),
  },
  devnet: {
    listen: (ruleId, port) => call("devnet:listen", String(ruleId), Number(port)),
    unlisten: (ruleId) => call("devnet:unlisten", String(ruleId)),
    unlistenAll: () => call("devnet:unlistenAll"),
    connect: (reqId, port) => call("devnet:connect", String(reqId), Number(port)),
  },
  wifi: {
    status: () => call("wifi:status"),
    start: () => call("wifi:start"),
    stop: () => call("wifi:stop"),
    scan: () => call("wifi:scan"),
    // Opens a native file picker in the main process and sends the chosen files.
    // method: "auto" | "lan" (same Wi‑Fi) | "direct" (Andromon Companion's Direct link)
    pickAndSend: (fingerprint, method) => call("wifi:pickAndSend", String(fingerprint), String(method || "")),
    // Files dropped onto the window: only their paths cross the bridge.
    sendFiles: (fingerprint, files, method) => call("wifi:sendPaths", String(fingerprint),
      Array.from(files || [], (f) => webUtils.getPathForFile(f)).filter(Boolean), String(method || "")),
    setMethod: (method) => call("wifi:setMethod", String(method)),
    // This computer's Wi‑Fi link, each phone's (if known) and an estimated speed.
    link: () => call("wifi:link"),
    cancelSend: () => call("wifi:cancelSend"),
    respond: (requestId, accept) => call("wifi:respond", String(requestId), !!accept),
    openFolder: () => call("wifi:openFolder"),
    chooseFolder: () => call("wifi:chooseFolder"),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on("wifi:event", h);
      return () => ipcRenderer.removeListener("wifi:event", h);
    },
  },
});

// Port-forwarding connections (devnet) go to the page the same way.
ipcRenderer.on("devnet:port", (e, meta) => {
  window.postMessage({ source: "andromon-devnet", meta }, window.location.origin, e.ports);
});

// Hand the wireless-ADB MessagePort to the page (ports can't cross contextBridge directly).
ipcRenderer.on("wadb:port", (e, meta) => {
  window.postMessage({ source: "andromon-wadb", meta }, window.location.origin, e.ports);
});
