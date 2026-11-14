// Shizuku on the Overview: when the connected phone has the Shizuku app installed but not running,
// offer to start it over adb; when it runs, say so. Shizuku lends apps on the phone the rights of
// adb, and the companion uses it for its Freezer, RAM manager and Battery saver (ShizukuAccess.kt)
// without this computer. On phones that aren't rooted it has to be started again after every
// restart, which is what this button does.
//
// The start command is the one Shizuku documents (https://shizuku.rikka.app/guide/setup/):
//   adb shell sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh
// The Shizuku app writes that script when it is opened. If it isn't there yet, the starter binary
// next to Shizuku's APK (libshizuku.so, what the script itself runs) is started directly.
//
// Everything read from the phone is untrusted: it goes in with textContent, never innerHTML.

const SHIZUKU_PKG = "moe.shizuku.privileged.api";
const START_SCRIPT = `/sdcard/Android/data/${SHIZUKU_PKG}/start.sh`;

export function initShizuku(base) {
  const { $, el, toast, sh, shQuote, actionBtn, getAdb } = base;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function apkPath() {
    const line = (await sh(`pm path ${SHIZUKU_PKG}`).catch(() => "")).trim().split("\n")[0] || "";
    return line.startsWith("package:") ? line.slice(8).trim() : null;
  }
  // The server shows up as "shizuku_server" in the process list (uid shell, or root).
  async function running() {
    const m = (await sh("ps -A -o USER,NAME 2>/dev/null").catch(() => "")).match(/^(\S+)\s+shizuku_server\s*$/m);
    return m ? (m[1] === "root" ? "root" : "adb") : null;
  }

  async function start() {
    const apk = await apkPath();
    if (!apk) throw new Error("Shizuku isn't installed on this phone.");
    let out = "";
    if ((await sh(`[ -f ${START_SCRIPT} ] && echo yes`).catch(() => "")).trim() === "yes") {
      out = await sh(`sh ${START_SCRIPT} 2>&1`);
    } else {
      // No script yet (Shizuku was never opened): run its starter directly.
      const libDir = apk.replace(/\/[^/]+$/, "") + "/lib";
      const abi = (await sh(`ls ${shQuote(libDir)} 2>/dev/null`).catch(() => "")).trim().split(/\s+/)[0];
      if (!abi) throw new Error("Open the Shizuku app on the phone once, then try again.");
      out = await sh(`${shQuote(`${libDir}/${abi}/libshizuku.so`)} 2>&1`);
    }
    for (let i = 0; i < 20; i++) { if (await running()) return; await wait(250); }
    const last = out.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300);
    throw new Error("Shizuku didn't start on the phone." + (last ? " It said: " + last : ""));
  }

  async function render() {
    const box = $("szCard");
    if (!box) return;
    if (!getAdb()) { box.hidden = true; return; }
    const [apk, how] = await Promise.all([apkPath(), running()]);
    // Shown only for phones that have Shizuku (running as root without the app counts too).
    if (!apk && !how) { box.hidden = true; return; }
    box.hidden = false;
    const state = how ? [`Running (${how === "root" ? "root" : "adb rights"})`, "on"] : ["Not running", "neutral"];
    const row = el("div", { className: "toolbar", style: "margin:0" });
    if (!how) {
      const btn = actionBtn("Start Shizuku", "Starting…", async () => {
        await start(); toast("Shizuku is running on the phone"); await render();
      });
      btn.classList.add("primary");
      row.append(btn);
    }
    row.append(el("span", { className: "muted small", textContent: how
      ? "In the companion app: Settings › Privileged access › Grant permission, if you haven't yet."
      : "Runs Shizuku's own start script over adb. It keeps running after you unplug, until the phone restarts." }));
    box.replaceChildren(
      el("div", { className: "toolbar", style: "justify-content:space-between;margin-bottom:8px" },
        el("h2", { style: "margin:0", textContent: "Shizuku" }),
        el("span", { className: `badge ${state[1]}`, textContent: state[0] })),
      el("p", { className: "muted", style: "margin:0 0 12px", textContent:
        "Shizuku lends apps on the phone the rights of adb. The companion app uses it for its Freezer, RAM manager and " +
        "Battery saver without this computer. It has to be started again after every restart of the phone." }),
      row,
    );
  }

  return { render };
}
