// ADB shell page: run a command on the phone, keep each command's output as its own block (copy, run again,
// filter, save), and a searchable guide of useful commands in a drawer that slides in from the right. Commands run as Android's "shell"
// user over the ADB link, the same as `adb shell` in a terminal. How the output looks is set in
// Settings › ADB shell and kept in localStorage.
import { icon } from "./fileicons.js";

const KEY = "andromon.shell";
export const shellPrefs = {
  SIZE: [["s", "Small"], ["m", "Medium"], ["l", "Large"]],
  get() {
    let p = {}; try { p = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    return { wrap: p.wrap !== false, times: p.times === true, size: ["s", "m", "l"].includes(p.size) ? p.size : "m", follow: p.follow !== false };
  },
  set(patch) {
    try { localStorage.setItem(KEY, JSON.stringify({ ...this.get(), ...patch })); } catch {}
    this.changed?.();
  },
  changed: null,
};

// The guide. [command, what it does, changes the phone?]. <words in brackets> are for you to replace.
const GUIDE = [
  ["Phone", [
    ["getprop ro.product.model", "The phone's model name"],
    ["getprop ro.build.version.release", "Android version"],
    ["getprop ro.build.version.sdk", "Android API level"],
    ["getprop | grep -i <word>", "Search all system properties"],
    ["uname -a", "Kernel version"],
    ["uptime", "How long the phone has been on"],
    ["date", "The phone's date and time"],
    ["id", "Who the shell runs as"],
    ["cat /proc/cpuinfo", "Processor details"],
    ["cat /proc/meminfo", "Memory figures"],
    ["df -h", "Free space on each storage area"],
  ]],
  ["Apps", [
    ["pm list packages", "Every installed package"],
    ["pm list packages -3", "Only the apps you installed"],
    ["pm list packages -d", "Disabled apps"],
    ["pm list packages | grep -i <word>", "Find a package by part of its name"],
    ["pm path <package>", "Where an app's APK file is"],
    ["dumpsys package <package> | grep -E 'versionName|versionCode'", "An app's version"],
    ["dumpsys package <package> | grep permission", "An app's permissions"],
    ["monkey -p <package> 1", "Open an app", true],
    ["am force-stop <package>", "Close an app completely", true],
    ["pm clear <package>", "Erase an app's data and cache", true],
    ["pm disable-user --user 0 <package>", "Disable an app", true],
    ["pm enable <package>", "Enable it again", true],
    ["pm uninstall --user 0 <package>", "Remove an app for the main user", true],
  ]],
  ["Files", [
    ["ls -la /sdcard", "List a folder with sizes and dates"],
    ["du -sh /sdcard/*", "Size of each folder in storage"],
    ["find /sdcard -iname '*<word>*'", "Find files by name"],
    ["find /sdcard -type f -size +100M", "Files larger than 100 MB"],
    ["stat <path>", "Details of one file"],
    ["cat <path>", "Show a text file"],
    ["head -n 40 <path>", "The first 40 lines of a file"],
    ["mkdir -p /sdcard/<folder>", "Make a folder", true],
    ["mv <from> <to>", "Move or rename", true],
    ["rm <path>", "Delete a file", true],
  ]],
  ["Network", [
    ["ip addr show wlan0", "The phone's Wi‑Fi address"],
    ["ip route", "Routes and the gateway"],
    ["ping -c 4 8.8.8.8", "Test the internet link"],
    ["cmd wifi status", "Wi‑Fi state and the network joined"],
    ["dumpsys connectivity | grep -i 'NetworkAgentInfo'", "Active networks"],
    ["settings get global http_proxy", "The proxy in use, if any"],
    ["getprop net.hostname", "The phone's network name"],
    ["svc wifi enable", "Turn Wi‑Fi on", true],
    ["svc wifi disable", "Turn Wi‑Fi off", true],
    ["svc data disable", "Turn mobile data off", true],
  ]],
  ["Battery and power", [
    ["dumpsys battery", "Level, temperature, voltage, charging"],
    ["dumpsys batterystats --charged | head -n 60", "Use since the last full charge"],
    ["dumpsys power | grep -E 'mWakefulness|mStayOn'", "Awake or asleep"],
    ["dumpsys deviceidle | head -n 30", "Doze state"],
    ["cmd battery unplug", "Pretend the charger is unplugged (for tests)", true],
    ["cmd battery reset", "Back to the real battery state", true],
  ]],
  ["Screen and input", [
    ["wm size", "Screen resolution"],
    ["wm density", "Screen density"],
    ["dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", "The app on screen now"],
    ["input keyevent 26", "Press the power button", true],
    ["input keyevent 3", "Press Home", true],
    ["input tap <x> <y>", "Tap a point", true],
    ["input swipe <x1> <y1> <x2> <y2> 300", "Swipe between two points", true],
    ["input text '<text>'", "Type plain text", true],
    ["screencap -p /sdcard/shot.png", "Save a screenshot on the phone", true],
    ["screenrecord --time-limit 10 /sdcard/rec.mp4", "Record the screen for 10 seconds", true],
    ["cmd uimode night yes", "Dark theme on", true],
    ["settings put system screen_brightness 120", "Set the brightness (0–255)", true],
  ]],
  ["Running apps and speed", [
    ["top -n 1 -m 10", "The 10 busiest processes right now"],
    ["ps -A | head -n 40", "Running processes"],
    ["dumpsys meminfo | head -n 40", "Memory use by app"],
    ["dumpsys meminfo <package>", "One app's memory"],
    ["dumpsys cpuinfo | head -n 20", "Processor use by app"],
    ["dumpsys activity activities | grep -E 'ResumedActivity'", "The screen (activity) in front"],
    ["dumpsys gfxinfo <package> | head -n 40", "Frame times of an app"],
  ]],
  ["Logs", [
    ["logcat -d -t 100", "The last 100 log lines"],
    ["logcat -d -t 200 '*:E'", "Recent errors only"],
    ["logcat -d -t 200 | grep -i <word>", "Search the recent log"],
    ["logcat -d -b crash -t 50", "Recent app crashes"],
    ["dumpsys dropbox --print | tail -n 60", "System crash and ANR records"],
    ["logcat -c", "Empty the log", true],
  ]],
  ["Settings", [
    ["settings list global", "All global settings"],
    ["settings list system", "All system settings"],
    ["settings list secure", "All secure settings"],
    ["settings get global <name>", "Read one setting"],
    ["settings put global <name> <value>", "Change one setting", true],
    ["settings get secure android_id", "The phone's Android ID"],
  ]],
  ["System", [
    ["service list | head -n 40", "System services"],
    ["cmd -l", "Services that take commands"],
    ["dumpsys -l", "Everything dumpsys can report"],
    ["cmd statusbar expand-notifications", "Open the notification shade", true],
    ["cmd statusbar collapse", "Close it", true],
    ["reboot", "Restart the phone", true],
  ]],
];
const TIPS = [
  "Commands run as Android's “shell” user: no root, so some folders and tools answer “Permission denied”.",
  "Pipes work: add | grep word, | head -n 20 or | sort to cut a long answer down.",
  "A command must finish by itself. Use logcat -d and top -n 1; plain logcat or top never end here.",
  "Press ↑ and ↓ in the command box to go through earlier commands. Enter runs. Ctrl+L clears the output.",
  "Rows marked “changes” do something on the phone. Clicking a row only fills the box; nothing runs until you press Run.",
];

export function initShell({ $, el, toast, showError, sh, download, getAdb }) {
  const root = $("shellRoot");
  const entries = []; // { cmd, at, ms, text, error, running }

  const gbtn = (name, title, onClick) => {
    const b = el("button", { className: "fx-gb", type: "button", title }, icon(name));
    b.setAttribute("aria-label", title);
    b.onclick = () => Promise.resolve(onClick(b)).catch(showError);
    return b;
  };

  // ---------- page ----------
  // The form and its box keep the ids the saved snippets and the ↑/↓ history (src/devtools.js) attach to.
  const input = el("input", { type: "text", id: "shellCmd", className: "mono tm-cmd", placeholder: "Type a command, e.g. dumpsys battery", autocomplete: "off", spellcheck: false });
  input.setAttribute("aria-label", "Command");
  const runBtn = el("button", { className: "btn primary", type: "submit", textContent: "Run" });
  const form = el("form", { className: "tm-form", id: "shellForm" }, el("span", { className: "tm-prompt", textContent: "$" }), input, runBtn);
  const filter = el("input", { type: "search", className: "tm-filter", placeholder: "Filter the output…" });
  filter.setAttribute("aria-label", "Show only output lines that contain");
  filter.oninput = () => renderOut();
  const tools = el("div", { className: "fx-group" },
    gbtn("copy", "Copy all the output", () => copy(allText(), "Output copied")),
    gbtn("download", "Save the output as a text file", () => download(new Blob([allText()], { type: "text/plain" }), `adb-shell-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`)),
    gbtn("trash-2", "Clear the output", () => { entries.length = 0; renderOut(); }));
  tools.setAttribute("role", "group");
  const summary = el("span", { className: "muted small" });
  const out = el("div", { className: "tm-out" });
  out.setAttribute("role", "log");
  const search = el("input", { type: "search", className: "tm-gsearch", placeholder: "Search the guide…" });
  search.setAttribute("aria-label", "Search the guide");
  search.oninput = () => renderGuide();
  const guide = el("div", { className: "tm-guide" });
  // The guide is shown inside the page's knowledge drawer (src/knowledge.js), under "How it works".
  const guidePanel = el("div", { className: "tm-gpanel" }, search, guide);
  let onPick = null; // closes that drawer when a command is picked
  root.replaceChildren(el("div", { className: "tm" },
    el("div", { className: "card tm-main" }, form,
      el("div", { className: "tm-bar" }, filter, tools, el("span", { className: "sp" }), summary), out)));

  // ---------- output ----------
  const stamp = (d) => new Date(d).toLocaleTimeString();
  const blockText = (e) => `$ ${e.cmd}\n${e.error ? "error: " + e.error : e.text || "(no output)"}`;
  const allText = () => entries.map(blockText).join("\n\n") + "\n";
  const copy = (text, done) => navigator.clipboard.writeText(text).then(() => toast(done), () => toast("Couldn't copy"));

  function renderSummary() {
    const p = shellPrefs.get();
    summary.textContent = [p.wrap ? "wraps lines" : "no wrapping", `${shellPrefs.SIZE.find(([id]) => id === p.size)[1].toLowerCase()} text`, p.times ? "shows times" : "", p.follow ? "follows new output" : ""].filter(Boolean).join(" · ");
    out.className = `tm-out tm-${p.size}` + (p.wrap ? " tm-wrap" : "");
  }
  shellPrefs.changed = () => { renderSummary(); renderOut(); };

  function renderOut() {
    const p = shellPrefs.get(), q = filter.value.trim().toLowerCase();
    if (!entries.length) {
      out.replaceChildren(el("div", { className: "tm-empty" }, el("b", { textContent: "Nothing run yet" }),
        el("div", { textContent: "Type a command above, or open the command guide with the book button at the top." })));
      return;
    }
    out.replaceChildren(...entries.map((e) => {
      const body = e.running ? "…" : e.error ? `error: ${e.error}` : e.text || "(no output)";
      const lines = q && !e.running ? body.split("\n").filter((l) => l.toLowerCase().includes(q)) : null;
      const meta = [p.times ? stamp(e.at) : "", e.running ? "running" : `${e.ms} ms`, lines ? `${lines.length} matching line${lines.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
      const acts = el("span", { className: "tm-acts" },
        gbtn("copy", "Copy this output", () => copy(e.error ? `error: ${e.error}` : e.text, "Copied")),
        gbtn("refresh-cw", "Run this command again", () => run(e.cmd)),
        gbtn("pencil", "Put this command back in the box", () => { input.value = e.cmd; input.focus(); }));
      return el("div", { className: "tm-block" + (e.error ? " tm-err" : "") },
        el("div", { className: "tm-head" }, el("span", { className: "tm-prompt", textContent: "$" }), el("code", { textContent: e.cmd }), el("span", { className: "tm-meta", textContent: meta }), acts),
        el("pre", { textContent: lines ? lines.join("\n") || "(no matching lines)" : body }));
    }));
    if (p.follow) out.scrollTop = out.scrollHeight;
  }

  async function run(cmd) {
    cmd = String(cmd || "").trim();
    if (!cmd) return;
    if (!getAdb()) return toast("Connect a phone first");
    const e = { cmd, at: Date.now(), ms: 0, text: "", error: "", running: true };
    entries.push(e); if (entries.length > 200) entries.shift();
    renderOut();
    const t0 = performance.now();
    try { e.text = String(await sh(cmd)).replace(/\s+$/, ""); }
    catch (err) { e.error = err?.message || String(err); }
    e.ms = Math.round(performance.now() - t0); e.running = false;
    renderOut();
  }
  form.addEventListener("submit", (ev) => { ev.preventDefault(); const cmd = input.value; input.select(); run(cmd); });
  input.addEventListener("keydown", (ev) => { if (ev.key.toLowerCase() === "l" && ev.ctrlKey) { ev.preventDefault(); entries.length = 0; renderOut(); } });

  // ---------- guide ----------
  /** Puts a guide command in the box and selects its first <placeholder>, ready to be typed over. */
  function pick(cmd) {
    onPick?.();
    input.value = cmd; input.focus();
    const m = /<[^>]+>/.exec(cmd);
    if (m) input.setSelectionRange(m.index, m.index + m[0].length); else input.setSelectionRange(cmd.length, cmd.length);
  }
  function renderGuide() {
    const q = search.value.trim().toLowerCase();
    const kids = [];
    for (const [group, rows] of GUIDE) {
      const hits = rows.filter(([cmd, what]) => !q || cmd.toLowerCase().includes(q) || what.toLowerCase().includes(q) || group.toLowerCase().includes(q));
      if (!hits.length) continue;
      const d = el("details", { className: "tm-grp", open: !!q || group === "Phone" }, el("summary", { textContent: `${group} (${hits.length})` }),
        ...hits.map(([cmd, what, changes]) => {
          const b = el("button", { className: "tm-row", type: "button", title: "Put this command in the box" },
            el("span", { className: "tm-what" }, what, changes ? el("i", { className: "tm-chg", textContent: "changes" }) : ""), el("code", { textContent: cmd }));
          b.onclick = () => pick(cmd);
          return b;
        }));
      kids.push(d);
    }
    if (!kids.length) kids.push(el("div", { className: "muted small", style: "padding:10px 2px", textContent: "No command in the guide matches." }));
    if (!q) kids.push(el("details", { className: "tm-grp" }, el("summary", { textContent: "Good to know" }), el("ul", { className: "tm-tips" }, ...TIPS.map((t) => el("li", { textContent: t })))));
    guide.replaceChildren(...kids);
  }

  renderSummary(); renderOut(); renderGuide();
  return { run, guidePanel, setOnPick: (fn) => { onPick = fn; } };
}
