// The Shizuku page: says whether the connected phone has the Shizuku app and whether it is running,
// starts it over adb, and opens it on the phone. Shizuku lends apps on the phone the rights of adb,
// and the companion uses it for its Freezer, RAM manager and Battery saver (ShizukuAccess.kt)
// without this computer. On phones that aren't rooted it has to be started again after every
// restart, which is what the Start button does.
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

  async function version() {
    const m = (await sh(`dumpsys package ${SHIZUKU_PKG} | grep -m1 versionName`).catch(() => "")).match(/versionName=(\S+)/);
    return m ? m[1] : "";
  }
  async function openOnPhone() {
    const out = await sh(`monkey -p ${SHIZUKU_PKG} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|monkey aborted/i.test(out)) throw new Error("Shizuku couldn't be opened on the phone.");
    toast("Shizuku is open on the phone");
  }

  let turn = 0;
  async function render() {
    const box = $("szCard");
    if (!box || !getAdb()) return;
    const mine = ++turn;
    const [apk, how] = await Promise.all([apkPath(), running()]);
    const ver = apk ? await version() : "";
    if (mine !== turn) return; // a newer check is on its way
    const state = how ? [`Running (${how === "root" ? "root" : "adb rights"})`, "on"] : apk ? ["Not running", "neutral"] : ["Not installed", "neutral"];
    const again = actionBtn("Check again", "Checking…", render);
    const open = actionBtn("Open Shizuku on the phone", "Opening…", openOnPhone);
    const row = el("div", { className: "toolbar", style: "margin:0" });
    let note;
    if (how) {
      if (apk) row.append(open);
      note = "Shizuku is running. If the companion app doesn't have its permission yet: in the companion, Settings › Privileged access › Grant permission.";
    } else if (apk) {
      const btn = actionBtn("Start Shizuku", "Starting…", async () => {
        await start(); toast("Shizuku is running on the phone"); await render();
      });
      btn.classList.add("primary");
      row.append(btn, open);
      note = "Start runs Shizuku's own start script over adb. It keeps running after you unplug, until the phone restarts.";
    } else {
      row.append(el("a", { className: "btn sm primary", href: "https://shizuku.rikka.app/download/", target: "_blank", rel: "noopener", textContent: "Get Shizuku" }));
      note = "Install the Shizuku app on the phone (the link opens its download page in your browser), then press Check again.";
    }
    row.append(again);
    const facts = [["Shizuku app", apk ? (ver ? `Installed, version ${ver}` : "Installed") : "Not on this phone"],
      ["Service", how ? (how === "root" ? "Running with root rights" : "Running with adb rights") : "Stopped"],
      ["After a restart", how === "root" ? "Starts by itself on rooted phones" : "Has to be started again"]];
    const li = (bold, text) => el("li", {}, el("b", { textContent: bold }), text);
    box.replaceChildren(
      el("div", { className: "card" },
        el("div", { className: "toolbar", style: "justify-content:space-between;margin:0 0 10px" },
          el("h2", { style: "margin:0", textContent: "Shizuku" }),
          el("span", { className: `badge ${state[1]}`, textContent: state[0] })),
        el("dl", { className: "sz-kv" }, ...facts.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])),
        row,
        el("p", { className: "muted small", style: "margin:12px 0 0", textContent: note })),
      el("div", { className: "card" },
        el("h2", { textContent: "What it is for" }),
        el("p", { className: "muted", textContent: "Shizuku lends apps on the phone the rights of adb. With it, the companion app can do these on its own, without this computer:" }),
        el("ul", { className: "sz-list" },
          li("Freezer: ", "stops unused apps silently, also when the screen turns off."),
          li("Memory: ", "lists the running apps and stops them."),
          li("Battery saver: ", "deep sleep, app limits and per-app battery use."))),
      el("div", { className: "card" },
        el("h2", { textContent: "How to set it up" }),
        el("ol", { className: "sz-list" },
          li("Install Shizuku ", "on the phone and open it once."),
          li("Start it ", "with the button above (or from the Shizuku app itself)."),
          li("Give the companion its permission: ", "in the companion app, Settings › Privileged access › Grant permission."),
          li("After every restart ", "of a phone that isn't rooted, start it again here."))),
    );
  }

  return { render };
}
