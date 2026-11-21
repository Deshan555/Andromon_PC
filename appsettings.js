// Andromon — Settings page helpers (main process): where saved files go, and how much room the
// things Andromon has downloaded take. The page never names a path: it asks for "the save folder"
// or "the data folder", and a folder only changes through the system's folder picker.
const { app, BrowserWindow, dialog, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");

async function dirSize(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// "shot.png" -> "shot (2).png" when the name is taken.
function freeName(dir, name) {
  const safe = path.basename(String(name || "file")).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "file";
  const ext = path.extname(safe), stem = safe.slice(0, safe.length - ext.length);
  let file = path.join(dir, safe);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${stem} (${i})${ext}`);
  return file;
}

function setupAppSettings(handle, { userData, readSettings, writeSettings, origin, getWindow }) {
  const defaultDir = () => path.join(app.getPath("downloads"), "Andromon");
  const save = () => { const s = readSettings(); return { ask: s.saveAsk !== false, dir: s.saveDir || defaultDir() }; };

  // Screenshots, recordings and exports are saved by the page as downloads. By default the system
  // asks where each one goes; with "ask" off they go straight into the chosen folder.
  session.defaultSession.on("will-download", (_event, item, wc) => {
    const s = save();
    if (s.ask || !String(wc?.getURL() || "").startsWith(origin + "/")) return;
    try {
      fs.mkdirSync(s.dir, { recursive: true });
      const file = freeName(s.dir, item.getFilename());
      item.setSavePath(file);
      item.once("done", (_e, state) => getWindow()?.webContents.send("app:event", { kind: "saved", ok: state === "completed", name: path.basename(file) }));
    } catch (e) { console.warn("[save]", e); } // the folder is gone or read-only: fall back to asking
  });

  const info = async () => {
    const [revanced, fdroid] = await Promise.all([dirSize(path.join(userData, "revanced")), dirSize(path.join(userData, "fdroid"))]);
    return { save: save(), sizes: { revanced, fdroid }, versions: { electron: process.versions.electron, chrome: process.versions.chrome } };
  };
  const open = async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  };

  // Big saves (screen recordings, files from the phone) are written here piece by piece instead of being
  // built in the page's memory and handed over as one download. Where they go follows the same setting:
  // a save window, or straight into the save folder. Written to "name.ddpart" first, renamed when done.
  const saving = new Map(); // id -> { fh, tmp, final, bytes, sender }
  let saveId = 1;
  const dropSave = async (id, remove) => {
    const h = saving.get(id);
    if (!h) return null;
    saving.delete(id);
    await h.fh.close().catch(() => {});
    if (remove) await fsp.unlink(h.tmp).catch(() => {});
    return h;
  };
  const watchedSenders = new WeakSet();
  const watchSender = (sender) => {
    if (watchedSenders.has(sender)) return;
    watchedSenders.add(sender);
    const closeAll = () => { for (const [id, h] of saving) if (h.sender === sender) dropSave(id, true); };
    sender.on("did-navigate", closeAll);
    sender.on("render-process-gone", closeAll);
    sender.once("destroyed", closeAll);
  };
  handle("save:open", async (event, name, opts) => {
    if (saving.size >= 8) throw new Error("Too many files are being saved at once");
    const s = save(), safe = path.basename(String(name || "file")).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_") || "file";
    let final;
    if (s.ask) {
      const ext = path.extname(safe).slice(1);
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
        defaultPath: path.join(s.dir, safe), filters: ext ? [{ name: String(opts?.kind || ext.toUpperCase()), extensions: [ext] }] : [],
      });
      if (r.canceled || !r.filePath) return null;
      final = r.filePath;
    } else {
      await fsp.mkdir(s.dir, { recursive: true });
      final = freeName(s.dir, safe);
    }
    const tmp = final + ".ddpart";
    const fh = await fsp.open(tmp, "w");
    const id = saveId++;
    watchSender(event.sender);
    saving.set(id, { fh, tmp, final, bytes: 0, sender: event.sender });
    return { id, name: path.basename(final) };
  });
  // `position` (a byte offset) lets a writer go back and fill in a header; without it, data is appended.
  handle("save:write", async (_e, id, data, position) => {
    const h = saving.get(Number(id));
    if (!h) throw new Error("The file isn't open");
    if (!(data instanceof Uint8Array)) throw new Error("Invalid data");
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const at = Number.isSafeInteger(position) && position >= 0 ? position : null;
    try { await h.fh.write(buf, 0, buf.length, at); }
    catch (e) { await dropSave(Number(id), true); throw new Error(e.code === "ENOSPC" ? "This computer's disk is full" : e.message); }
    h.bytes += buf.length;
    return true;
  });
  handle("save:close", async (_e, id) => {
    const h = await dropSave(Number(id), false);
    if (!h) throw new Error("The file isn't open");
    await fsp.rm(h.final, { force: true }); // the save window already asked about replacing it
    await fsp.rename(h.tmp, h.final);
    return { name: path.basename(h.final) };
  });
  handle("save:abort", async (_e, id) => { await dropSave(Number(id), true); return true; });

  handle("app:info", () => info());
  // This computer's name and system, which the phone's companion shows on its PC link screen.
  handle("app:computer", () => ({
    name: require("node:os").hostname().replace(/\.local$/i, "").slice(0, 80),
    os: { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform,
    app: require("electron").app.getVersion(),
    // For Report a bug (src/feedback.js): "26.4" on macOS, the build ("10.0.26100") on Windows, the kernel on Linux.
    osVersion: process.platform === "linux" ? require("node:os").release() : process.getSystemVersion(),
    arch: process.arch,
  }));
  handle("app:openData", () => open(userData));
  handle("app:saveOpen", () => open(save().dir));
  handle("app:saveAsk", (_e, ask) => { writeSettings({ saveAsk: !!ask }); return save(); });
  handle("app:saveChoose", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { title: "Save screenshots, recordings and exports in", properties: ["openDirectory", "createDirectory"], defaultPath: save().dir });
    if (!r.canceled && r.filePaths[0]) writeSettings({ saveDir: r.filePaths[0] });
    return save();
  });
}

module.exports = { setupAppSettings };
