// Droid Desk — what this computer has of the tools Droid Desk can use (Settings › This computer).
// Nothing here is required to connect a phone: Droid Desk speaks ADB itself. Java is needed only for
// ReVanced patching; the rest explains itself in `why`. On Windows a missing tool can be installed with
// the system's package manager (winget); elsewhere the official download page is opened.
const { shell } = require("electron");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const PAGES = {
  java: "https://adoptium.net/temurin/releases/?version=17",
  adb: "https://developer.android.com/tools/releases/platform-tools",
  driver: "https://developer.android.com/studio/run/oem-usb",
  udev: "https://developer.android.com/studio/run/device#setting-up",
};
// winget package ids (Windows 10 1809 and newer, Windows 11)
const WINGET = { java: "EclipseAdoptium.Temurin.17.JRE", adb: "Google.PlatformTools" };

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => execFile(cmd, args, { timeout, windowsHide: true },
  (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || "") + String(stderr || "") })));

function setupRequirements(handle, { findJava, adbCandidates, minJava = 17 }) {
  let wingetOk = null;
  const hasWinget = async () => (wingetOk ??= process.platform === "win32" && (await run("winget", ["--version"])).ok);

  async function list(force) {
    const [java, winget] = await Promise.all([findJava(force), hasWinget()]);
    const items = [];
    items.push({
      id: "java", name: `Java ${minJava} or newer`, why: "Needed only to patch apps on the ReVanced page",
      state: !java ? "missing" : java.ok ? "ok" : "old",
      detail: !java ? "Not found on this computer" : `Version ${java.version}${java.ok ? "" : `, too old (needs ${minJava})`} · ${java.path}`,
      install: winget && !(java && java.ok),
    });
    const adbs = adbCandidates();
    let adbVersion = "";
    if (adbs[0]) adbVersion = ((await run(adbs[0], ["version"])).out.match(/Version ([\w.-]+)/) || [])[1] || "";
    items.push({
      id: "adb", name: "Android platform tools (adb)", why: "Not needed by Droid Desk, which talks to the phone itself. Handy if you also use adb in a terminal",
      state: adbs[0] ? "ok" : "optional",
      detail: adbs[0] ? `${adbVersion ? `Version ${adbVersion} · ` : ""}${adbs[0]}` : "Not installed (that's fine)",
      install: winget && !adbs[0],
    });
    if (process.platform === "win32") items.push({
      id: "driver", name: "The phone's USB driver", why: "Lets Windows hand the phone to Droid Desk over the cable. Most phones work with Windows' own driver",
      state: "unknown", detail: "Can't be checked from here. If the phone isn't found over USB, install its maker's driver", install: false,
    });
    if (process.platform === "linux") {
      const dirs = ["/etc/udev/rules.d", "/lib/udev/rules.d", "/usr/lib/udev/rules.d"];
      const rule = dirs.flatMap((d) => { try { return fs.readdirSync(d).filter((f) => /android|adb/i.test(f)).map((f) => `${d}/${f}`); } catch { return []; } })[0];
      items.push({
        id: "udev", name: "USB access rules for Android (udev)", why: "Lets Droid Desk open the phone over the cable without running as root",
        state: rule ? "ok" : "missing", detail: rule || "Not found. Install the android-sdk-platform-tools-common or android-udev-rules package", install: false,
      });
    }
    items.push({
      id: "builtin", name: "Included with Droid Desk", why: "Nothing to install",
      state: "ok", detail: `Chromium ${process.versions.chrome} · Electron ${process.versions.electron} · Node.js ${process.versions.node}`, install: false,
    });
    return { platform: process.platform, items: items.map((i) => ({ ...i, page: !!PAGES[i.id] })) };
  }

  handle("sys:requirements", (_e, force) => list(!!force));
  handle("sys:openPage", (_e, id) => { if (PAGES[id]) shell.openExternal(PAGES[id]); return !!PAGES[id]; });
  // Windows only: install with winget. Windows itself asks for permission (UAC) when the package needs it.
  handle("sys:install", async (_e, id) => {
    if (!WINGET[id] || !(await hasWinget())) throw new Error("This can't be installed automatically here. Use the download page.");
    const r = await run("winget", ["install", "-e", "--id", WINGET[id], "--silent", "--accept-package-agreements", "--accept-source-agreements"], 15 * 60 * 1000);
    if (!r.ok && !/already installed/i.test(r.out)) throw new Error("The installation didn't finish:\n" + r.out.trim().split("\n").slice(-3).join("\n"));
    return list(true);
  });
}

module.exports = { setupRequirements };
