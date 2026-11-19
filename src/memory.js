// Andromon — Memory: how much of the phone's RAM is in use, which apps hold it, and stopping them.
//
// Everything here is read over ADB, whose shell may see every process and stop apps without root or
// Shizuku (the companion's Memory screen needs one of those, because Android hides other apps from it):
//   /proc/meminfo    the totals; quick, so it's read again every few seconds while the page is open
//   dumpsys meminfo  each process's memory (PSS, the figure Android itself uses) and how important
//                    Android rates it (its OOM group). Takes a second or two, so it's read when the page
//                    opens, on Refresh, and after Stop or Free memory.
// Stop is `am force-stop` (the same as Settings › Apps › Force stop). Free memory is `am kill-all`,
// which only ends background processes Android itself would end first; nothing in use is touched.

// dumpsys meminfo's OOM groups -> what the page calls them, most important first. `stop` is false for
// what can't or shouldn't be stopped from here (Android restarts it at once, or the phone needs it).
const GROUPS = [
  [/^Native$/i, "System", false], [/^System$/i, "System", false], [/^Persistent/i, "System", false],
  [/^Foreground$/i, "In use", true], [/^Visible$/i, "Visible", true], [/^Perceptible/i, "Visible", true],
  [/^Home$/i, "Home screen", false], [/^(Backup|Heavy Weight|A Services|B Services|Service)/i, "Running", true],
  [/^Previous$/i, "Recent", true], [/^Cached$/i, "Cached", true],
];
const RANK = ["System", "In use", "Visible", "Home screen", "Running", "Recent", "Cached", "Other"];
const BADGE = { "In use": "on", Visible: "on", Running: "neutral", Recent: "neutral", Cached: "neutral", "Home screen": "neutral", System: "neutral", Other: "neutral" };
// Never offered a Stop button: the companion (other pages use it), Android's own shell, and Google Play
// services (notifications, sign-in and location stop until it starts again).
const KEEP = /^(dev\.andromon\.|com\.android\.shell$|com\.google\.android\.(gms|gsf)$)/;
// A process name is a package name, optionally with ":something" for its extra processes.
const PKG = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

const kb = (s) => Number(String(s).replace(/,/g, "")) * 1024;

/** /proc/meminfo -> bytes. */
export function parseProcMeminfo(text) {
  const get = (k) => { const m = text.match(new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, "m")); return m ? Number(m[1]) * 1024 : null; };
  const total = get("MemTotal"), free = get("MemFree");
  // MemAvailable is there since Linux 3.14 (every phone with Android 5 or newer); estimate it otherwise.
  const avail = get("MemAvailable") ?? (free != null ? free + (get("Cached") || 0) + (get("Buffers") || 0) : null);
  return { total, avail, used: total != null && avail != null ? total - avail : null, swapTotal: get("SwapTotal") || 0, swapFree: get("SwapFree") || 0 };
}

/**
 * dumpsys meminfo -> [{ name, pid, bytes, group }] from its "Total PSS by OOM adjustment" part
 * (or the RSS one, on phones that skip PSS). Lines look like
 *     1,234,567K: Foreground
 *         245,678K: com.example.app (pid 1234 / activities)
 */
export function parseDumpsysMeminfo(text) {
  const read = (kind) => {
    const start = text.search(new RegExp(`^Total ${kind} by OOM adjustment:`, "m"));
    if (start < 0) return null;
    const out = [];
    let group = "Other";
    for (const line of text.slice(start).split("\n").slice(1)) {
      if (!line.trim()) continue;
      if (/^\S/.test(line)) break; // the next "Total … by …:" part
      const m = line.match(/^\s*([\d,]+)K:\s+(.+?)(?:\s+\(pid\s+(\d+)[^)]*\))?\s*(?:\(.*\))?\s*$/);
      if (!m) continue;
      if (m[3]) out.push({ name: m[2].trim(), pid: Number(m[3]), bytes: kb(m[1]), group });
      else group = m[2].trim();
    }
    return out.length ? out : null;
  };
  return read("PSS") || read("RSS") || [];
}

/** Processes -> apps (a package's processes added up), with the most important state among them. */
export function groupApps(procs) {
  const apps = new Map();
  let system = 0;
  for (const p of procs) {
    const g = GROUPS.find(([re]) => re.test(p.group));
    const state = g ? g[1] : "Other";
    const pkg = p.name.split(":")[0];
    if (state === "System" || !PKG.test(pkg)) { system += p.bytes; continue; }
    const a = apps.get(pkg) || { pkg, bytes: 0, procs: 0, state, stop: true };
    a.bytes += p.bytes; a.procs++;
    if (RANK.indexOf(state) < RANK.indexOf(a.state)) a.state = state;
    if (g && !g[2]) a.stop = false;
    apps.set(pkg, a);
  }
  for (const a of apps.values()) if (KEEP.test(a.pkg)) a.stop = false;
  return { apps: [...apps.values()].sort((x, y) => y.bytes - x.bytes), system };
}

export function initMemory(ctx) {
  const { $, el, sh, shQuote, fmtSize, toast, showError, spinner, actionBtn, appIdent, checkIcons, getAdb } = ctx;
  const root = $("memoryRoot");
  let gen = 0, timer = null, totals = null, list = null, filter = "apps";
  const LIVE_MS = 5000;

  const readTotals = async () => parseProcMeminfo(await sh("cat /proc/meminfo"));
  const readApps = async () => groupApps(parseDumpsysMeminfo(await sh("dumpsys meminfo 2>&1")));

  function verdict(t) {
    if (!t.total || t.avail == null) return "Unknown";
    const f = t.avail / t.total;
    return f >= 0.3 ? "Normal · plenty of free memory" : f >= 0.15 ? "Getting full · apps may reload when you switch back" : "Low · apps are being closed to make room";
  }

  // ---------- the parts of the page ----------
  const hero = el("div", { className: "hero" });
  const stats = el("div", { className: "grid mm-stats" });
  const listCard = el("div", { className: "card" });

  function ring(frac, value, label) {
    const r = el("div", { className: "ring" }, el("div", {}, el("b", { textContent: value }), el("span", { textContent: label })));
    r.style.setProperty("--p", frac != null && isFinite(frac) ? Math.min(1, Math.max(0, frac)) : 0);
    return r;
  }
  const stat = (label, value, sub) => el("div", { className: "card mm-stat" },
    el("div", { className: "muted small", textContent: label }), el("div", { className: "mm-value", textContent: value ?? "Unknown" }),
    sub ? el("div", { className: "muted small", textContent: sub }) : "");

  function renderTotals() {
    const t = totals;
    if (!t) return;
    const pct = t.total ? Math.round((t.used / t.total) * 100) : null;
    const freeBtn = actionBtn("Free memory", "Freeing…", freeMemory);
    freeBtn.classList.add("primary");
    freeBtn.title = "Ends background apps Android would close first. Apps in use are left alone.";
    hero.replaceChildren(el("div", { className: "card" },
      el("div", {},
        el("div", { className: "what", textContent: "RAM in use" }),
        el("div", { className: "big" }, pct != null ? String(pct) : "—", el("small", { textContent: pct != null ? "%" : "" })),
        el("div", { className: "sub", textContent: t.total ? `${fmtSize(t.used)} of ${fmtSize(t.total)} · ${verdict(t)}` : "Unknown" }),
        el("div", { className: "toolbar", style: "margin:14px 0 0" }, freeBtn,
          actionBtn("Refresh", "Reading…", () => load(true)))),
      ring(t.total ? t.used / t.total : null, t.avail != null ? fmtSize(t.avail) : "—", "available")));
    const swapUsed = t.swapTotal - t.swapFree;
    const cached = list ? list.apps.filter((a) => a.state === "Cached") : null;
    stats.replaceChildren(
      stat("Available", t.avail != null ? fmtSize(t.avail) : null, "Free for apps to use now"),
      stat("Compressed swap", t.swapTotal ? fmtSize(swapUsed) : "None", t.swapTotal ? `of ${fmtSize(t.swapTotal)} · less used apps squeezed to make room` : "This phone has no swap"),
      stat("Apps in memory", list ? String(list.apps.length) : "…", list ? `${list.apps.filter((a) => a.state === "In use" || a.state === "Visible").length} on screen or in use` : "Reading…"),
      stat("Cached apps", cached ? fmtSize(cached.reduce((s, a) => s + a.bytes, 0)) : "…", cached ? `${cached.length} kept ready to reopen quickly` : "Reading…"));
  }

  function renderList() {
    if (!list) { listCard.replaceChildren(el("div", { className: "empty" }, spinner(), " Reading the apps in memory…")); return; }
    const seg = el("div", { className: "seg" }, ...[["apps", "Apps"], ["background", "Background only"]].map(([k, label]) => {
      const b = el("button", { type: "button", className: filter === k ? "on" : "", textContent: label });
      b.onclick = () => { filter = k; renderList(); };
      return b;
    }));
    const shown = filter === "background" ? list.apps.filter((a) => ["Running", "Recent", "Cached"].includes(a.state)) : list.apps;
    const max = Math.max(1, ...list.apps.map((a) => a.bytes));
    const rows = shown.map((a) => el("div", { className: "mm-row" },
      appIdent(a.pkg, { badges: [el("span", { className: `badge ${BADGE[a.state] || "neutral"}`, textContent: a.state })] }),
      el("div", { className: "mm-bar", title: `${a.procs} process${a.procs === 1 ? "" : "es"}` }, el("i", { style: `width:${Math.max(2, (a.bytes / max) * 100).toFixed(1)}%` })),
      el("span", { className: "mm-size", textContent: fmtSize(a.bytes) }),
      a.stop ? actionBtn("Stop", "Stopping…", () => stopApp(a), { confirm: a.state === "In use" || a.state === "Visible" })
        : el("span", { className: "mm-nostop muted small", textContent: "Kept", title: "Android or Andromon needs this app, so it isn't offered here." })));
    listCard.replaceChildren(
      el("div", { className: "toolbar", style: "justify-content:space-between;margin-bottom:8px" },
        el("h2", { style: "margin:0", textContent: "Apps in memory" }), seg),
      el("p", { className: "muted small", style: "margin:0 0 10px", textContent:
        "Biggest first. Stop closes an app the way Settings › Force stop does: anything unsaved in it is lost, and it may start again by itself (alarms, messages, music). Cached apps cost nothing until the memory is needed; Android ends them by itself." }),
      ...(rows.length ? rows : [el("div", { className: "empty", textContent: filter === "background" ? "No background apps right now." : "No apps found." })]),
      el("div", { className: "muted small", style: "margin-top:10px", textContent: `Android and its services: ${fmtSize(list.system)} (not listed; the phone needs them).` }));
  }

  // ---------- reading ----------
  async function load(refresh) {
    const mine = ++gen, phone = getAdb();
    if (!refresh || !totals) { totals = null; list = null; root.replaceChildren(el("div", { className: "card" }, spinner(), " Reading the phone's memory…")); }
    try {
      totals = await readTotals();
      if (mine !== gen) return;
      root.replaceChildren(hero, stats, listCard);
      renderTotals(); renderList();
      const [l] = await Promise.all([readApps(), checkIcons().catch(() => {})]);
      if (mine !== gen || getAdb() !== phone) return;
      list = l; renderTotals(); renderList();
      startLive();
    } catch (e) { if (mine === gen) { root.replaceChildren(); showError(e); } }
  }

  // While the page is open, the totals follow the phone (the app list doesn't: it's the slow part).
  function startLive() {
    stopLive();
    const phone = getAdb();
    timer = setInterval(async () => {
      if (getAdb() !== phone || document.hidden) return;
      try { const t = await readTotals(); if (getAdb() === phone && timer) { totals = t; renderTotals(); } } catch {}
    }, LIVE_MS);
  }
  function stopLive() { clearInterval(timer); timer = null; }

  // ---------- actions ----------
  async function stopApp(a) {
    const out = (await sh(`am force-stop ${shQuote(a.pkg)} 2>&1`)).trim();
    if (/exception|error|denied/i.test(out)) throw new Error(`Couldn't stop ${a.pkg}: ${out.split("\n")[0]}`);
    toast(`Stopped ${a.pkg}`);
    await load(true);
  }
  async function freeMemory() {
    const before = (await readTotals()).avail;
    const out = (await sh("am kill-all 2>&1")).trim();
    if (/exception|error|denied/i.test(out)) throw new Error("Couldn't free memory: " + out.split("\n")[0]);
    await new Promise((r) => setTimeout(r, 800)); // the processes take a moment to go
    const after = (await readTotals()).avail;
    const gained = after != null && before != null ? after - before : 0;
    toast(gained > 8 * 1024 * 1024 ? `Freed ${fmtSize(gained)}` : "Background apps closed. Little was freed: Android had already made room.");
    await load(true);
  }

  return {
    load: () => load(false),
    onShow(view) { if (view !== "memory") { stopLive(); gen++; } },
    onDisconnected() { stopLive(); gen++; totals = null; list = null; root.replaceChildren(); },
  };
}
