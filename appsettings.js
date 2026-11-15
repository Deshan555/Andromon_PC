// Droid Desk — Settings page helpers (main process): where saved files go, and how much room the
// things Droid Desk has downloaded take. The page never names a path: it asks for "the save folder"
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
  const defaultDir = () => path.join(app.getPath("downloads"), "Droid Desk");
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

  handle("app:info", () => info());
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
