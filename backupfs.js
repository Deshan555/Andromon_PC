// Andromon — files for phone backups, restores and the automatic photo copy (main process).
//
// The sandboxed UI can't touch the disk. It gets three folders, each one picked by the person in a
// native dialog and nothing else:
//   "backup"  where "Back up this phone" writes its dated folders          (remembered)
//   "photos"  where new photos are copied when a phone connects             (remembered)
//   "restore" the folder of a backup.json opened with "Restore from a backup…" (this session only)
//   "sync:<id>" a computer folder kept the same as a phone folder by Folder sync      (remembered)
// Every path the UI sends is relative to one of them, is checked segment by segment, and can never
// leave that folder. Files are written as "<name>.ddpart" and renamed when complete, so a copy that
// was cut off is never mistaken for a finished one. Nothing here deletes or overwrites a finished file,
// except in a sync folder: there a file that sync replaces or removes goes to the computer's Trash
// (Recycle Bin), so it can still be brought back.
const { dialog, shell, BrowserWindow, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = fs.promises;

const KINDS = new Set(["backup", "photos", "restore"]);
const SETTING = { backup: "backupDir", photos: "photoBackupDir" };
const SERIAL = /^[\w.:-]{1,64}$/;
const MAX_OPEN = 8;
const MAX_LIST = 200_000;
const MAX_READ = 512 * 1024 * 1024;
const BAD_SEGMENT = /[\u0000-\u001f<>:"|?*\\/]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i; // device names on Windows

function setupBackupFs(handle, { userData, readSettings, writeSettings }) {
  const roots = new Map(); // kind -> absolute folder
  const open = new Map();  // id -> { fh, tmp, final, bytes, sender }
  let nextId = 1;

  const syncId = (kind) => (/^sync:[a-z0-9]{1,16}$/.test(kind) ? kind.slice(5) : null);
  const rootOf = (kind) => {
    if (!KINDS.has(kind) && !syncId(kind)) throw new Error("Unknown folder");
    let r = roots.get(kind);
    if (!r && syncId(kind)) {
      const saved = (readSettings().syncDirs || {})[syncId(kind)];
      if (typeof saved === "string" && path.isAbsolute(saved)) { r = saved; roots.set(kind, r); }
    }
    if (!r && SETTING[kind]) {
      const saved = readSettings()[SETTING[kind]];
      if (typeof saved === "string" && path.isAbsolute(saved)) { r = saved; roots.set(kind, r); }
    }
    if (!r) throw new Error(kind === "restore" ? "Open a backup first." : "Choose a folder first.");
    return r;
  };
  // "a/b/c.jpg" -> absolute path inside the root. Rejects anything that could step outside it.
  const resolve = (kind, rel) => {
    const root = rootOf(kind);
    if (/^[\\/]/.test(String(rel ?? ""))) throw new Error("Invalid file name");
    const segs = String(rel ?? "").split("/").filter((s) => s !== "");
    for (const s of segs) {
      if (s === "." || s === ".." || BAD_SEGMENT.test(s) || s.length > 200 || /[. ]$/.test(s) || RESERVED.test(s)) throw new Error("Invalid file name");
    }
    if (segs.length > 12) throw new Error("Folder is nested too deeply");
    const full = path.join(root, ...segs);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Invalid file name");
    return full;
  };
  const bytesOf = (data) => {
    if (typeof data === "string") return Buffer.from(data, "utf8");
    if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    throw new Error("Invalid data");
  };
  const setTime = async (file, mtime) => {
    const t = Number(mtime);
    if (isFinite(t) && t > 0) await fsp.utimes(file, new Date(), new Date(t)).catch(() => {});
  };
  const dropHandle = async (id, remove) => {
    const h = open.get(id);
    if (!h) return null;
    open.delete(id);
    await h.fh.close().catch(() => {});
    if (remove) await fsp.unlink(h.tmp).catch(() => {});
    return h;
  };
  const watched = new WeakSet();
  const watch = (sender) => {
    if (watched.has(sender)) return;
    watched.add(sender);
    const closeAll = () => { for (const [id, h] of open) if (h.sender === sender) dropHandle(id, true); };
    sender.on("did-navigate", closeAll);
    sender.on("render-process-gone", closeAll);
    sender.once("destroyed", closeAll);
  };

  const info = async (kind) => {
    let p;
    try { p = rootOf(kind); } catch { return null; }
    const exists = await fsp.stat(p).then((s) => s.isDirectory(), () => false);
    return { path: p, name: path.basename(p), exists };
  };

  handle("bfs:get", (_e, kind) => info(String(kind)));
  handle("bfs:choose", async (event, kind) => {
    kind = String(kind);
    if (!SETTING[kind] && !syncId(kind)) throw new Error("Unknown folder");
    const win = BrowserWindow.fromWebContents(event.sender);
    let current; try { current = rootOf(kind); } catch {}
    const r = await dialog.showOpenDialog(win, {
      title: kind === "backup" ? "Keep phone backups in" : kind === "photos" ? "Copy new photos to" : "Keep this folder the same as the phone's",
      properties: ["openDirectory", "createDirectory"], defaultPath: current,
    });
    if (r.canceled || !r.filePaths[0]) return null;
    roots.set(kind, r.filePaths[0]);
    if (syncId(kind)) writeSettings({ syncDirs: { ...(readSettings().syncDirs || {}), [syncId(kind)]: r.filePaths[0] } });
    else writeSettings({ [SETTING[kind]]: r.filePaths[0] });
    return info(kind);
  });
  // Folder sync: a pair was removed, so its folder is no longer reachable from the page.
  handle("bfs:forget", (_e, kind) => {
    kind = String(kind); const id = syncId(kind);
    if (!id) throw new Error("Unknown folder");
    const dirs = { ...(readSettings().syncDirs || {}) }; delete dirs[id];
    writeSettings({ syncDirs: dirs }); roots.delete(kind);
    return true;
  });
  // Folder sync: a file removed on the phone (or replaced) goes to the Trash here, never just deleted.
  handle("bfs:trash", async (_e, kind, rel) => {
    kind = String(kind);
    if (!syncId(kind)) throw new Error("Only sync folders can have files removed");
    const file = resolve(kind, rel);
    if (file === rootOf(kind)) throw new Error("Invalid file name");
    if (!fs.existsSync(file)) return false;
    await shell.trashItem(file);
    return true;
  });
  // "Restore from a backup…": the person picks a backup.json; its folder becomes the "restore" root.
  handle("bfs:pickBackup", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let start; try { start = rootOf("backup"); } catch {}
    const r = await dialog.showOpenDialog(win, {
      title: "Open an Andromon backup (backup.json)", properties: ["openFile"], defaultPath: start,
      filters: [{ name: "Andromon backup", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const st = await fsp.stat(file);
    if (st.size > 64 * 1024 * 1024) throw new Error("That file is too large to be a backup.json.");
    const text = await fsp.readFile(file, "utf8");
    roots.set("restore", path.dirname(file));
    return { path: path.dirname(file), name: path.basename(path.dirname(file)), manifest: text };
  });
  handle("bfs:reveal", async (_e, kind, rel) => {
    const err = await shell.openPath(resolve(String(kind), rel));
    if (err) throw new Error(err);
    return true;
  });

  handle("bfs:mkdir", async (_e, kind, rel) => { await fsp.mkdir(resolve(String(kind), rel), { recursive: true }); return true; });
  handle("bfs:stat", async (_e, kind, rel) => {
    try { const s = await fsp.stat(resolve(String(kind), rel)); return { size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() }; }
    catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; }
  });
  // Files below a folder: [{rel, size, mtime}], relative to `rel`. Symbolic links are not followed.
  handle("bfs:list", async (_e, kind, rel, recursive) => {
    const base = resolve(String(kind), rel);
    const out = [];
    const walk = async (dir, prefix, depth) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === "ENOENT") return; throw e; }
      for (const d of entries) {
        if (out.length >= MAX_LIST) return;
        const relName = prefix ? `${prefix}/${d.name}` : d.name;
        if (d.isDirectory()) { if (recursive && depth < 12) await walk(path.join(dir, d.name), relName, depth + 1); else if (!recursive) out.push({ rel: relName, dir: true, size: 0, mtime: 0 }); }
        else if (d.isFile() && !d.name.endsWith(".ddpart")) {
          const s = await fsp.stat(path.join(dir, d.name)).catch(() => null);
          if (s) out.push({ rel: relName, size: s.size, mtime: s.mtimeMs });
        }
      }
    };
    await walk(base, "", 0);
    return out;
  });

  // Small files in one go. Refuses to replace an existing file unless `replace` is set (manifest updates).
  handle("bfs:writeFile", async (_e, kind, rel, data, opts) => {
    const file = resolve(String(kind), rel);
    const buf = bytesOf(data);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".ddpart";
    await fsp.writeFile(tmp, buf);
    if (!opts?.replace && fs.existsSync(file)) { await fsp.unlink(tmp).catch(() => {}); throw new Error("That file already exists"); }
    await fsp.rename(tmp, file);
    await setTime(file, opts?.mtime);
    return buf.length;
  });
  // Large files in pieces: open -> write… -> close (or abort).
  handle("bfs:open", async (event, kind, rel, opts) => {
    if (open.size >= MAX_OPEN) throw new Error("Too many files open");
    const final = resolve(String(kind), rel);
    const replace = !!opts?.replace && !!syncId(String(kind)); // only sync replaces, and its old copy goes to the Trash
    if (!replace && fs.existsSync(final)) throw new Error("That file already exists");
    await fsp.mkdir(path.dirname(final), { recursive: true });
    const tmp = final + ".ddpart";
    const fh = await fsp.open(tmp, "w");
    const id = nextId++;
    watch(event.sender);
    open.set(id, { fh, tmp, final, bytes: 0, sender: event.sender, replace });
    return id;
  });
  handle("bfs:write", async (_e, id, data) => {
    const h = open.get(Number(id));
    if (!h) throw new Error("File isn't open");
    const buf = bytesOf(data);
    try { await h.fh.write(buf); } catch (e) { await dropHandle(Number(id), true); throw new Error(e.code === "ENOSPC" ? "This computer's disk is full" : e.message); }
    h.bytes += buf.length;
    return h.bytes;
  });
  handle("bfs:close", async (_e, id, opts) => {
    const h = await dropHandle(Number(id), false);
    if (!h) throw new Error("File isn't open");
    if (fs.existsSync(h.final)) {
      if (!h.replace) { await fsp.unlink(h.tmp).catch(() => {}); throw new Error("That file already exists"); }
      await shell.trashItem(h.final).catch(() => fsp.unlink(h.final));
    }
    await fsp.rename(h.tmp, h.final);
    await setTime(h.final, opts?.mtime);
    return h.bytes;
  });
  handle("bfs:abort", async (_e, id) => { await dropHandle(Number(id), true); return true; });

  handle("bfs:readFile", async (_e, kind, rel) => {
    const file = resolve(String(kind), rel);
    const s = await fsp.stat(file);
    if (!s.isFile()) throw new Error("Not a file");
    if (s.size > MAX_READ) throw new Error("That file is too large to read in one piece");
    return new Uint8Array(await fsp.readFile(file));
  });
  handle("bfs:read", async (_e, kind, rel, offset, length) => {
    const file = resolve(String(kind), rel);
    const len = Math.min(Math.max(0, Number(length) || 0), 8 * 1024 * 1024);
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, Math.max(0, Number(offset) || 0));
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally { await fh.close(); }
  });

  // The password of locked scheduled backups, when the person lets this computer remember it. Kept
  // encrypted by the system (Keychain on macOS, DPAPI on Windows, the keyring on Linux); refused
  // where the system can't encrypt, rather than stored in the clear.
  const secretFile = path.join(userData, "backup-secret.bin");
  handle("bfs:secretSet", async (_e, text) => {
    text = String(text || "");
    if (!text) { await fsp.unlink(secretFile).catch(() => {}); return true; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer can't keep a password safely, so it can't be remembered here.");
    await fsp.writeFile(secretFile, safeStorage.encryptString(text), { mode: 0o600 });
    return true;
  });
  handle("bfs:secretGet", async () => {
    try { return safeStorage.decryptString(await fsp.readFile(secretFile)); } catch { return ""; }
  });
  handle("bfs:secretHas", () => fs.existsSync(secretFile));

  // Which photos were already copied from which phone: one small JSON file per phone (by serial).
  const recordFile = (serial) => {
    serial = String(serial);
    if (!SERIAL.test(serial)) throw new Error("Invalid phone");
    return path.join(userData, "photo-backup", serial.replace(/[^\w.-]/g, "_") + ".json");
  };
  handle("bfs:recordGet", async (_e, serial) => {
    try { return JSON.parse(await fsp.readFile(recordFile(serial), "utf8")); } catch { return null; }
  });
  handle("bfs:recordSet", async (_e, serial, record) => {
    const file = recordFile(serial);
    const text = JSON.stringify(record);
    if (text.length > 64 * 1024 * 1024) throw new Error("Record too large");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file + ".tmp", text);
    await fsp.rename(file + ".tmp", file);
    return true;
  });
}

module.exports = { setupBackupFs };
