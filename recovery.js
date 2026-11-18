// Andromon — SD card recovery (main process).
//
// Recovers deleted photos, videos and other files from a memory card (or USB stick) in this
// computer's card reader, or from an image file of one, by running PhotoRec (GPL v2+, by Christophe
// Grenier, https://www.cgsecurity.org). PhotoRec is not part of Andromon: it is downloaded from its
// author's site the first time (checked against a pinned SHA-256), or a copy already installed on
// the computer (e.g. `brew install testdisk`, the testdisk package on Linux) is used.
//
// What the user should know, and what the code keeps to:
//  - PhotoRec only reads the card. Recovered files are written to a folder the user picks, which
//    must be on another disk (writing to the card would overwrite what is being recovered).
//  - Reading a whole drive needs administrator rights, so the system asks for the password
//    (macOS: its own dialog, Linux: pkexec, Windows: the UAC prompt). An image file needs none.
//  - Only removable/external drives are offered, and the drive to read is always taken from a fresh
//    list made here, never from a path the page sends. The output folder and the image file come
//    from the system's own pickers.
"use strict";
const { dialog, net, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const VERSION = "7.2";
const HOST = "https://www.cgsecurity.org/";
// Official builds. The macOS build is for Intel; on Apple silicon it runs through Rosetta.
const BUILDS = {
  darwin: { file: "testdisk-7.2.mac_intel_x86_64.tar.bz2", sha256: "05cfe47e4d0c5667ba218af83b81aa18ad1e4cbbedfcab334e6f770d53d59386", exe: "photorec", size: 1.6e6 },
  linux: { file: "testdisk-7.2.linux26-x86_64.tar.bz2", sha256: "19669b6d36314d6e531efdf836c768574e8a556d1e9db3c8f3c4e93a5092cb1c", exe: "photorec_static", size: 3.2e6 },
  win32: { file: "testdisk-7.2.win64.zip", sha256: "e97e203ce77b6b1a3a37d01beccf069dc6c4632b579ffbb82ae739cdda229f38", exe: "photorec_win.exe", size: 27.4e6 },
};
const MAX_DOWNLOAD = 60e6;
// What to look for: PhotoRec's "fileopt" list. Empty = every type it knows (480+).
const SETS = {
  everything: [],
  photos: ["jpg", "png", "gif", "bmp", "tif", "raw", "crw", "cr2", "dng", "heic", "webp"],
  media: ["jpg", "png", "gif", "bmp", "tif", "raw", "crw", "cr2", "dng", "heic", "webp", "mov", "mp4", "avi", "mkv", "mpg", "mp3", "ogg", "wav", "flac"],
  documents: ["doc", "pdf", "zip", "txt", "rtf", "ods", "odt", "xls", "ppt"],
};

const run = (cmd, args, { timeout = 15000, input } = {}) => new Promise((resolve) => {
  const p = execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || "") }));
  if (input != null) { p.stdin?.end(input); }
});
const exists = (p) => fsp.access(p).then(() => true, () => false);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX shell quoting

function setupRecovery(handle, { userData, getWindow }) {
  const build = BUILDS[process.platform] || null;
  const toolDir = path.join(userData, "tools", `photorec-${VERSION}`);
  const emit = (ev) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send("rc:event", ev); };

  // ---------- PhotoRec itself ----------
  async function findTool() {
    if (build) {
      const own = path.join(toolDir, `testdisk-${VERSION}`, build.exe);
      if (await exists(own)) return { path: own, source: "downloaded", version: VERSION };
    }
    if (process.platform !== "win32") {
      const dirs = [...new Set([...(process.env.PATH || "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/usr/sbin", "/sbin"])];
      for (const d of dirs) {
        if (!d) continue;
        const p = path.join(d, "photorec");
        if (await exists(p)) return { path: p, source: "system", version: "" };
      }
    }
    return null;
  }

  let installing = null;
  async function install() {
    if (!build) throw new Error("PhotoRec has no build for this system. Install the “testdisk” package and try again.");
    if (installing) return installing;
    installing = (async () => {
      await fsp.mkdir(toolDir, { recursive: true });
      const archive = path.join(toolDir, build.file);
      const part = archive + ".part";
      const res = await net.fetch(HOST + build.file, { headers: { "user-agent": "Andromon" } });
      if (!res.ok || !res.body) throw new Error(`Couldn't download PhotoRec (HTTP ${res.status}).`);
      const total = Number(res.headers.get("content-length")) || build.size;
      const fh = await fsp.open(part, "w");
      const hash = crypto.createHash("sha256");
      let done = 0, last = 0;
      try {
        for await (const chunk of res.body) {
          done += chunk.length;
          if (done > MAX_DOWNLOAD) throw new Error("The download is larger than expected.");
          hash.update(chunk);
          await fh.write(chunk);
          if (Date.now() - last > 200) { last = Date.now(); emit({ kind: "download", done, total }); }
        }
      } catch (e) { await fh.close(); await fsp.rm(part, { force: true }); throw e; }
      await fh.close();
      if (hash.digest("hex") !== build.sha256) {
        await fsp.rm(part, { force: true });
        throw new Error("The downloaded file isn't the PhotoRec build Andromon expects (checksum mismatch). Nothing was installed.");
      }
      await fsp.rename(part, archive);
      emit({ kind: "download", done, total: done, unpacking: true });
      // bsdtar (macOS, Windows 10+) and GNU tar both pick the format themselves.
      const r = await run("tar", ["-xf", archive, "-C", toolDir], { timeout: 120000 });
      await fsp.rm(archive, { force: true });
      if (!r.ok) throw new Error(`Couldn't unpack PhotoRec: ${r.err.trim().split("\n").pop() || "tar failed"}`);
      const tool = await findTool();
      if (!tool || tool.source !== "downloaded") throw new Error("PhotoRec was unpacked but its program wasn't found.");
      if (process.platform !== "win32") await fsp.chmod(tool.path, 0o755).catch(() => {});
      return true;
    })().finally(() => { installing = null; });
    return installing;
  }

  // ---------- removable drives ----------
  const plistValue = (xml, key, type) => (xml.match(new RegExp(`<key>${key}</key>\\s*<${type}>([^<]*)</${type}>`)) || [])[1];
  async function drives() {
    const list = [];
    if (process.platform === "darwin") {
      const r = await run("diskutil", ["list", "-plist", "external", "physical"]);
      const whole = (r.out.match(/<key>WholeDisks<\/key>\s*<array>([\s\S]*?)<\/array>/) || [])[1] || "";
      for (const m of whole.matchAll(/<string>(disk\d+)<\/string>/g)) {
        const info = (await run("diskutil", ["info", "-plist", m[1]])).out;
        if (/<key>Internal<\/key>\s*<true\/>/.test(info)) continue;
        list.push({
          id: m[1], device: `/dev/r${m[1]}`, size: Number(plistValue(info, "TotalSize", "integer")) || 0,
          name: (plistValue(info, "MediaName", "string") || plistValue(info, "IORegistryEntryName", "string") || "Removable drive").trim(),
          bus: plistValue(info, "BusProtocol", "string") || "",
        });
      }
    } else if (process.platform === "linux") {
      const r = await run("lsblk", ["-J", "-b", "-d", "-o", "NAME,SIZE,RM,HOTPLUG,TRAN,MODEL,TYPE"]);
      let rows = [];
      try { rows = JSON.parse(r.out).blockdevices || []; } catch { }
      const yes = (v) => v === true || v === "1" || v === 1;
      for (const d of rows) {
        if (d.type !== "disk" || !/^[a-z0-9]+$/.test(d.name)) continue;
        if (!(yes(d.rm) || yes(d.hotplug) || d.tran === "usb" || /^mmcblk/.test(d.name))) continue;
        if (!Number(d.size)) continue; // an empty card-reader slot
        list.push({ id: d.name, device: `/dev/${d.name}`, size: Number(d.size), name: (d.model || "Removable drive").trim(), bus: d.tran || (/^mmcblk/.test(d.name) ? "SD" : "") });
      }
    } else if (process.platform === "win32") {
      const ps = "Get-Disk | Where-Object { $_.BusType -in 'USB','SD','MMC' } | Select-Object Number,FriendlyName,Size,BusType | ConvertTo-Json -Compress";
      const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000 });
      let rows = [];
      try { const j = JSON.parse(r.out || "[]"); rows = Array.isArray(j) ? j : [j]; } catch { }
      for (const d of rows) {
        if (!Number.isInteger(d.Number)) continue;
        list.push({ id: String(d.Number), device: `\\\\.\\PhysicalDrive${d.Number}`, size: Number(d.Size) || 0, name: String(d.FriendlyName || "Removable drive").trim(), bus: String(d.BusType || "") });
      }
    }
    return list;
  }

  // ---------- one recovery at a time ----------
  let source = null; // { type: "image", path } chosen with the picker
  let outDir = null; // chosen with the picker
  let job = null;    // { child, dir, timer, elevated, startedAt, stopped }

  async function countRecovered(dir) {
    let files = 0, bytes = 0;
    let subs = [];
    try { subs = (await fsp.readdir(dir)).filter((n) => /^recup_dir\.\d+$/.test(n)); } catch { return { files, bytes }; }
    for (const s of subs) {
      let names = [];
      try { names = await fsp.readdir(path.join(dir, s)); } catch { continue; }
      for (const n of names) {
        if (n === "report.xml") continue;
        try { bytes += (await fsp.stat(path.join(dir, s, n))).size; files++; } catch { }
      }
    }
    return { files, bytes };
  }

  function status() {
    return { running: !!job, elevated: !!job?.elevated, dir: job?.dir || null, startedAt: job?.startedAt || 0 };
  }

  async function start(opts) {
    if (job) throw new Error("A recovery is already running.");
    const tool = await findTool();
    if (!tool) throw new Error("PhotoRec isn't installed yet.");
    if (!outDir || !(await exists(outDir))) throw new Error("Choose a folder for the recovered files first.");
    const set = SETS[opts?.what] ? opts.what : "everything";
    let target, elevated = false, label;
    if (opts?.source === "image") {
      if (!source?.path || !(await exists(source.path))) throw new Error("Choose the image file first.");
      target = source.path; label = path.basename(source.path);
    } else {
      const d = (await drives()).find((x) => x.id === String(opts?.drive || ""));
      if (!d) throw new Error("That drive isn't connected any more. Refresh the list.");
      target = d.device; elevated = true; label = d.name;
      if (process.platform === "darwin") {
        // The folder must not be on the card itself.
        const vol = (await run("diskutil", ["info", "-plist", outDir])).out;
        if ((plistValue(vol, "ParentWholeDisk", "string") || "") === d.id) throw new Error("That folder is on the card itself. Choose a folder on this computer, or the recovery would overwrite the deleted files.");
      }
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const dir = path.join(outDir, `Recovered ${stamp}`);
    await fsp.mkdir(dir, { recursive: true });
    // PhotoRec's scripted mode: read the whole device (no partition table needed, so damaged or
    // reformatted cards work too), look for the chosen file types, write to <dir>/recup_dir.N.
    const types = SETS[set];
    const fileopt = types.length ? ["fileopt", "everything", "disable", ...types.flatMap((t) => [t, "enable"])] : ["fileopt", "everything", "enable"];
    const cmd = ["partition_none", "options", "keep_corrupted_file_no", ...fileopt, "wholespace", "search"].join(",");
    const args = ["/log", "/d", path.join(dir, "recup_dir"), "/cmd", target, cmd];
    const env = { ...process.env, TERM: process.env.TERM || "xterm" };
    let child;
    if (process.platform === "win32") {
      // PhotoRec opens its own console window, where its progress shows. Start-Process -Verb RunAs
      // raises the UAC prompt for a drive; -Wait keeps this process alive until it ends.
      const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
      const argList = args.map((a) => q(`"${a}"`)).join(",");
      const ps = `Start-Process -FilePath ${q(tool.path)} -ArgumentList ${argList} -WorkingDirectory ${q(dir)} -Wait${elevated ? " -Verb RunAs" : ""}`;
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { cwd: dir, windowsHide: true });
    } else {
      // PhotoRec draws its screen with curses and wants a terminal even when scripted: `script`
      // gives it one. Its files then belong to root when elevated, so they are handed back after.
      const inner = [tool.path, ...args].map(shq).join(" ");
      const withTty = process.platform === "darwin"
        ? `cd ${shq(dir)} && TERM=xterm /usr/bin/script -q /dev/null ${inner} >/dev/null 2>&1`
        : `cd ${shq(dir)} && TERM=xterm script -qefc ${shq(inner)} /dev/null >/dev/null 2>&1`;
      const giveBack = `chown -R ${os.userInfo().uid}:${os.userInfo().gid} ${shq(dir)}`;
      if (!elevated) child = spawn("/bin/sh", ["-c", withTty], { cwd: dir, env, detached: true });
      else if (process.platform === "darwin") {
        const sh = `${withTty}; ${giveBack}`;
        const as = `do shell script "${sh.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" with prompt "Andromon needs your password to read the memory card. PhotoRec only reads it; nothing on the card is changed." with administrator privileges`;
        child = spawn("/usr/bin/osascript", ["-e", as], { cwd: dir, env });
      } else {
        child = spawn("pkexec", ["/bin/sh", "-c", `${withTty}; ${giveBack}`], { cwd: dir, env });
      }
    }
    let errText = "";
    child.stderr?.on("data", (b) => { errText = (errText + b).slice(-2000); });
    const j = job = { child, dir, elevated, startedAt: Date.now(), stopped: false, label };
    j.timer = setInterval(async () => { if (job === j) emit({ kind: "progress", ...(await countRecovered(dir)), startedAt: j.startedAt }); }, 2000);
    const finish = async (code, error) => {
      if (job !== j) return;
      clearInterval(j.timer);
      job = null;
      const got = await countRecovered(dir);
      let problem = null;
      if (error?.code === "ENOENT") problem = process.platform === "linux" ? "This system has no “pkexec” (or “script”) program to ask for administrator rights. Install polkit, or recover from an image file instead." : "The program needed to start PhotoRec wasn't found.";
      else if (j.stopped) problem = null;
      else if (/User canceled|-128|dismissed|Not authorized|canceled by the user/i.test(errText) || code === 126 || code === 127) problem = "The password prompt was cancelled, so the card wasn't read.";
      else if (code && !got.files) problem = `PhotoRec stopped without recovering anything (exit code ${code}). ${errText.trim().split("\n").pop() || ""}`.trim();
      if (!got.files) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); // no empty folders left behind
      emit({ kind: "done", ...got, dir: got.files ? dir : null, stopped: j.stopped, problem, seconds: Math.round((Date.now() - j.startedAt) / 1000) });
    };
    child.on("error", (e) => finish(null, e));
    child.on("exit", (code) => finish(code, null));
    return { ...status(), label };
  }

  async function stop() {
    const j = job;
    if (!j) return false;
    j.stopped = true;
    if (process.platform === "win32") {
      // The elevated window belongs to the user: closing it stops PhotoRec. Try for them as well.
      await run("taskkill", ["/IM", BUILDS.win32.exe, "/T", "/F"]);
      return true;
    }
    if (!j.elevated) { try { process.kill(-j.child.pid, "SIGTERM"); } catch { j.child.kill("SIGTERM"); } return true; }
    // A root process can only be stopped by root: this asks for the password once more.
    const kill = "pkill -TERM -x photorec; pkill -TERM -x photorec_static; true";
    if (process.platform === "darwin") await run("/usr/bin/osascript", ["-e", `do shell script "${kill}" with prompt "Andromon needs your password to stop the recovery." with administrator privileges`], { timeout: 120000 });
    else await run("pkexec", ["/bin/sh", "-c", kill], { timeout: 120000 });
    return true;
  }

  handle("rc:status", async () => {
    const tool = await findTool();
    return {
      platform: process.platform, arch: process.arch, canInstall: !!build, downloadMb: build ? Math.round(build.size / 1e6) : 0,
      tool: tool ? { source: tool.source, version: tool.version, path: tool.path } : null,
      rosetta: process.platform === "darwin" && process.arch === "arm64",
      outDir, image: source?.path || null, sets: Object.keys(SETS), ...status(),
    };
  });
  handle("rc:install", () => install());
  handle("rc:drives", () => drives());
  handle("rc:chooseOut", async () => {
    const r = await dialog.showOpenDialog(getWindow(), { title: "Where to put the recovered files", properties: ["openDirectory", "createDirectory"], buttonLabel: "Use this folder" });
    if (!r.canceled && r.filePaths[0]) outDir = r.filePaths[0];
    return outDir;
  });
  handle("rc:chooseImage", async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: "Image of a memory card or drive", properties: ["openFile"],
      filters: [{ name: "Disk images", extensions: ["img", "dd", "bin", "raw", "iso", "dmg", "001", "e01"] }, { name: "All files", extensions: ["*"] }],
    });
    if (!r.canceled && r.filePaths[0]) source = { type: "image", path: r.filePaths[0] };
    return source?.path || null;
  });
  handle("rc:start", (_e, opts) => start({ source: opts?.source === "image" ? "image" : "drive", drive: String(opts?.drive || ""), what: String(opts?.what || "everything") }));
  handle("rc:stop", () => stop());
  handle("rc:open", async (_e, dir) => {
    // Only folders this module made: "<chosen folder>/Recovered <stamp>".
    const d = String(dir || "");
    if (!outDir || path.dirname(d) !== outDir || !/^Recovered \d{8}T\d{6}$/.test(path.basename(d))) return false;
    return (await shell.openPath(d)) === "";
  });
  handle("rc:openSite", () => shell.openExternal("https://www.cgsecurity.org/wiki/PhotoRec"));

  return { stop: () => { if (job && !job.elevated) { try { process.kill(-job.child.pid, "SIGTERM"); } catch { } } } };
}

module.exports = { setupRecovery };
