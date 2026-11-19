// Andromon — update check (main process). Releases are published in their own repository
// (Deshan555/Andromon_Releases, published by .github/workflows/automation.yml from the "automation" branch),
// which keeps a manifest of the newest build at MANIFEST_URL (latest.json, written by
// scripts/release-manifest.js). This file
// reads it, decides whether it is newer than the running app, picks the installer for this computer,
// and can download that installer into the Downloads folder (SHA-256 checked) and open it.
// Nothing is installed silently: the person runs the installer themselves.
const { app, net, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");

const REPO = "Deshan555/Andromon_Releases";
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/HEAD/latest.json`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const MAX_SIZE = 600 * 1024 ** 2;
const DAY = 24 * 3600 * 1000;

/** -1, 0 or 1 for two versions like "0.10.2" (numbers compared part by part; anything after "-" ignored). */
function compareVersions(a, b) {
  const parts = (v) => String(v || "").replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

/**
 * Is the build in `manifest` newer than the running one? A higher version always is. With the same
 * version, a higher build number is, but only when this copy knows its own build number (copies built
 * on a developer's computer have build 0 and are only offered a higher version).
 */
function isNewer(manifest, current) {
  const v = compareVersions(manifest?.version, current.version);
  if (v !== 0) return v > 0;
  return current.build > 0 && Number(manifest?.build) > current.build;
}

/** The installer in `files` for this computer, or null. `appImage`: the app is running as an AppImage. */
function pickInstaller(files, { platform, arch, appImage }) {
  const os = { darwin: "mac", win32: "windows", linux: "linux" }[platform];
  const mine = (Array.isArray(files) ? files : []).filter((f) => f && f.platform === os && typeof f.name === "string");
  const kind = os === "linux" ? (appImage ? "AppImage" : "deb") : os === "mac" ? "dmg" : "exe";
  const ofKind = mine.filter((f) => f.kind === kind);
  const cpu = arch === "arm64" ? "arm64" : arch === "ia32" ? "ia32" : "x64"; // ia32: the 32-bit Windows build
  // Exact CPU type first; then a file for every CPU type (the combined Windows setup); on a Mac with
  // Apple Silicon the Intel build also runs.
  return ofKind.find((f) => f.arch === cpu) || ofKind.find((f) => !f.arch)
    || (os === "mac" && cpu === "arm64" ? ofKind.find((f) => f.arch === "x64") : null) || null;
}

function setupUpdater(handle, { readSettings, writeSettings, getWindow }) {
  let info = { build: 0, commit: "", date: "" };
  try { info = { ...info, ...JSON.parse(fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8")) }; } catch {}
  const current = { version: app.getVersion(), build: Number(info.build) || 0, commit: String(info.commit || "") };
  const here = { platform: process.platform, arch: process.arch, appImage: !!process.env.APPIMAGE };
  const emit = (ev) => { const w = getWindow(); if (w && !w.isDestroyed()) w.webContents.send("upd:event", ev); };

  let last = null;      // result of the newest check this run
  let checking = null;  // the check in flight, shared by callers
  let abort = null, downloaded = null; // downloaded: { name, file }

  const auto = () => readSettings().updateAuto !== false;
  const status = () => ({ current, auto: auto(), last, checkedAt: readSettings().updateCheckedAt || 0, downloaded: downloaded ? { name: downloaded.name } : null });

  async function fetchManifest() {
    const res = await net.fetch(MANIFEST_URL, { headers: { "user-agent": "Andromon", accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) throw new Error("No release has been built yet.");
    if (!res.ok) throw new Error(`Couldn't reach GitHub to check for updates (HTTP ${res.status}).`);
    const text = await res.text();
    if (text.length > 1024 ** 2) throw new Error("The update information is larger than expected.");
    const m = JSON.parse(text);
    if (!m || typeof m.version !== "string" || !Array.isArray(m.files)) throw new Error("The update information has an unexpected format.");
    return m;
  }

  const check = () => (checking ||= (async () => {
    try {
      const m = await fetchManifest();
      const f = pickInstaller(m.files, here);
      // Only an address inside this project's GitHub releases is ever downloaded.
      const ok = f && typeof f.url === "string" && f.url.startsWith(DOWNLOAD_PREFIX) && /^[0-9a-f]{64}$/.test(f.sha256 || "") && Number(f.size) > 0 && Number(f.size) <= MAX_SIZE;
      last = {
        available: isNewer(m, current),
        version: m.version, build: Number(m.build) || 0, date: String(m.date || ""),
        changes: (Array.isArray(m.changes) ? m.changes : []).slice(0, 40).map((c) => String(c).slice(0, 200)),
        installer: ok ? { name: path.basename(f.name), size: Number(f.size) } : null,
      };
      file = ok ? f : null;
      writeSettings({ updateCheckedAt: Date.now() });
      return status();
    } finally { checking = null; }
  })());
  let file = null; // the manifest entry behind last.installer

  async function download() {
    if (abort) throw new Error("The update is already downloading.");
    if (!last?.available || !file) throw new Error("There is no update to download for this computer.");
    const f = file, name = path.basename(f.name), what = `Andromon ${last.version}`;
    const dir = app.getPath("downloads"), dest = path.join(dir, name), part = dest + ".part";
    const ac = abort = new AbortController();
    emit({ kind: "download", phase: "start", what, from: "github.com", total: f.size });
    try {
      const res = await net.fetch(f.url, { headers: { "user-agent": "Andromon" }, signal: ac.signal });
      if (res.status === 404) throw new Error("This version isn't published on GitHub yet. Try again later, or open the releases page.");
      if (!res.ok || !res.body) throw new Error(`Couldn't download the update (HTTP ${res.status}).`);
      await fsp.mkdir(dir, { recursive: true });
      const fh = await fsp.open(part, "w");
      const hash = crypto.createHash("sha256");
      let done = 0, tick = 0;
      try {
        for await (const chunk of res.body) {
          done += chunk.length;
          if (done > f.size) throw new Error("The update is larger than expected.");
          hash.update(chunk);
          await fh.write(chunk);
          if (Date.now() - tick > 200) { tick = Date.now(); emit({ kind: "progress", what, done, total: f.size }); }
        }
      } finally { await fh.close(); }
      if (done !== f.size || hash.digest("hex") !== f.sha256) throw new Error("The downloaded update doesn't match the published file. Nothing was kept.");
      await fsp.rename(part, dest);
      if (process.platform === "linux" && f.kind === "AppImage") await fsp.chmod(dest, 0o755);
      downloaded = { name, file: dest };
      emit({ kind: "download", phase: "end", what, ok: true });
      return status();
    } catch (e) {
      await fsp.rm(part, { force: true });
      emit({ kind: "download", phase: "end", what, ok: false, cancelled: ac.signal.aborted, error: String(e?.message || e) });
      throw ac.signal.aborted ? new Error("The download was cancelled.") : e;
    } finally { abort = null; }
  }

  /** Opens the downloaded installer (the disk image, the setup wizard, the package installer), or its folder for an AppImage. */
  async function install() {
    if (!downloaded || !fs.existsSync(downloaded.file)) { downloaded = null; throw new Error("Download the update first."); }
    if (downloaded.file.toLowerCase().endsWith(".appimage")) { shell.showItemInFolder(downloaded.file); return true; }
    const err = await shell.openPath(downloaded.file);
    if (err) throw new Error(err);
    return true;
  }

  handle("upd:status", () => status());
  handle("upd:check", () => check());
  handle("upd:setAuto", (_e, on) => { writeSettings({ updateAuto: !!on }); return status(); });
  handle("upd:download", () => download());
  handle("upd:cancel", () => { abort?.abort(); return true; });
  handle("upd:install", () => install());
  handle("upd:openReleases", () => { shell.openExternal(RELEASES_URL); return true; });

  // Automatic check: shortly after the window opens, at most once a day.
  if (auto() && Date.now() - (readSettings().updateCheckedAt || 0) > DAY) {
    setTimeout(() => check().then((s) => { if (s.last?.available) emit({ kind: "available", status: s }); }).catch((e) => console.warn("[update]", e?.message || e)), 8000).unref?.();
  }
  return { stop: () => abort?.abort() };
}

module.exports = { setupUpdater, compareVersions, isNewer, pickInstaller };
