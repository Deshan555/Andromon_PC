// App testing › Performance tests: repeatable, measured tests for one app, with pass/fail limits and a
// history to compare builds against. (The live monitor is in Developer › Performance.)
//
// - Startup time: `am start -W` reports TotalTime / WaitTime / LaunchState for each launch.
//     Cold = process stopped first (-S). Warm = process alive, screen re-created (HOME, then
//     --activity-clear-task). Hot = screen brought back from the background (HOME, then start).
//     Android may answer a warm launch as hot (apps that keep their task): the real LaunchState is kept.
//     "Fully drawn" comes from logcat when the app calls reportFullyDrawn().
// - Smoothness: `dumpsys gfxinfo <pkg> reset`, N swipes with `input swipe`, then the frame stats.
//     Several processes are added up; percentiles come from the merged frame-time histograms.
// - Memory: launch → leave (Back or Home) K times, `dumpsys meminfo <pkg>` after each round. Growth
//     is measured from round 2 (round 1 warms caches) to the last, and a rising Activities count is
//     the classic sign of a leaked screen.
//
// Every string from the phone is untrusted: inserted with textContent / el() only, and escaped in reports.

const STORE_RUNS = "perftests";
const STORE_LIMITS = "perfLimits";
const MAX_RUNS = 100;
const DEFAULT_LIMITS = { cold: 1000, warm: 500, hot: 300, jank: 5, p90: 20, growth: 10 };
const LIMIT_INFO = [
  ["cold", "Cold start median", "ms"], ["warm", "Warm start median", "ms"], ["hot", "Hot start median", "ms"],
  ["jank", "Janky frames", "%"], ["p90", "90th percentile frame time", "ms"], ["growth", "Memory growth", "%"],
];
const TYPE_LABEL = { startup: "Startup", jank: "Smoothness", memory: "Memory" };
const MODE_LABEL = { cold: "Cold", warm: "Warm", hot: "Hot" };
const PKG_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
const round = (v, d = 0) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const fmt = (v, unit = "", d = 0) => (v == null || !Number.isFinite(v) ? "–" : `${v.toFixed(d)}${unit ? " " + unit : ""}`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
class Stopped extends Error { constructor() { super("Stopped"); } }

// ---------- parsers (exported for tests) ----------

/** `am start -W` output -> { total, wait, state, warning } (times in ms, null when missing). */
export function parseAmStart(out) {
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  if (/^Error:|Exception/m.test(out) && !/TotalTime/.test(out)) throw new Error((out.match(/^Error:.*$/m) || [out.trim().split("\n").pop()])[0]);
  const state = (out.match(/^LaunchState:\s*(\w+)/m) || [])[1] || "";
  return { total: num(/^TotalTime:\s*(\d+)/m), wait: num(/^WaitTime:\s*(\d+)/m), state: state.toUpperCase(), warning: (out.match(/^Warning:\s*(.*)$/m) || [])[1] || "" };
}

/** "+1s234ms" / "+234ms" -> ms */
export function parseDrawnTime(s) {
  const m = String(s).match(/\+(?:(\d+)s)?(?:(\d+)ms)?/);
  if (!m || (m[1] == null && m[2] == null)) return null;
  return Number(m[1] || 0) * 1000 + Number(m[2] || 0);
}

/** `dumpsys gfxinfo <pkg>` (one or more processes) -> merged frame stats. */
export function parseGfxinfo(out) {
  const sections = out.split(/\*\* Graphics info for pid \d+ \[[^\]]*\] \*\*/).slice(1);
  const r = { processes: sections.length, frames: 0, janky: 0, jankyLegacy: 0, missedVsync: 0, inputLatency: 0, slowUi: 0, slowBitmap: 0, slowDraw: 0, deadlineMissed: 0, hist: new Map() };
  const num = (sec, re) => { const m = sec.match(re); return m ? Number(m[1]) : 0; };
  for (const sec of sections) {
    r.frames += num(sec, /Total frames rendered:\s*(\d+)/);
    r.janky += num(sec, /^Janky frames:\s*(\d+)/m);
    r.jankyLegacy += num(sec, /^Janky frames \(legacy\):\s*(\d+)/m);
    r.missedVsync += num(sec, /Number Missed Vsync:\s*(\d+)/);
    r.inputLatency += num(sec, /Number High input latency:\s*(\d+)/);
    r.slowUi += num(sec, /Number Slow UI thread:\s*(\d+)/);
    r.slowBitmap += num(sec, /Number Slow bitmap uploads:\s*(\d+)/);
    r.slowDraw += num(sec, /Number Slow issue draw commands:\s*(\d+)/);
    r.deadlineMissed += num(sec, /^Number Frame deadline missed:\s*(\d+)/m);
    const h = sec.match(/^HISTOGRAM:(.*)$/m);
    if (h) for (const m of h[1].matchAll(/(\d+)ms=(\d+)/g)) r.hist.set(Number(m[1]), (r.hist.get(Number(m[1])) || 0) + Number(m[2]));
  }
  // Older Android versions only have the legacy count.
  if (!/^Janky frames:/m.test(out.replace(/^Janky frames \(legacy\).*$/gm, ""))) r.janky = r.jankyLegacy;
  const total = [...r.hist.values()].reduce((a, b) => a + b, 0);
  const histPct = (p) => {
    if (!total) return null;
    let acc = 0;
    for (const [ms, n] of [...r.hist].sort((a, b) => a[0] - b[0])) { acc += n; if (acc >= p * total) return ms; }
    return null;
  };
  r.p50 = histPct(0.5); r.p90 = histPct(0.9); r.p95 = histPct(0.95); r.p99 = histPct(0.99);
  r.jankPct = r.frames ? (r.janky / r.frames) * 100 : null;
  delete r.hist;
  return r;
}

/** `dumpsys meminfo <pkg>` -> sizes in KB and object counts. */
export function parseMeminfo(out) {
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  return {
    pss: num(/TOTAL PSS:\s+(\d+)/) ?? num(/^\s*TOTAL\s+(\d+)/m),
    rss: num(/TOTAL RSS:\s+(\d+)/),
    java: num(/Java Heap:\s+(\d+)/),
    native: num(/Native Heap:\s+(\d+)/),
    views: num(/Views:\s+(\d+)/),
    activities: num(/Activities:\s+(\d+)/),
    contexts: num(/AppContexts:\s+(\d+)/),
  };
}

export function mount(root, ctx) {
  const { el, sh, shQuote, toast, showError, clearError, store } = ctx;

  // ---------- state ----------
  let limits = { ...DEFAULT_LIMITS, ...store.get(STORE_LIMITS, {}) };
  let runs = store.get(STORE_RUNS, []);
  let job = null; // { stop, type }
  let baselineId = null;
  const checkStop = () => { if (!job || job.stop) throw new Stopped(); };
  const wait = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { checkStop(); await sleep(Math.min(200, end - Date.now())); } };

  function pkgOrThrow() {
    const p = ctx.app.get();
    if (!PKG_RE.test(p)) throw new Error("Pick an app first (type its package or click “Current app”).");
    return p;
  }
  async function launcherOf(pkg) {
    const out = await sh(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shQuote(pkg)} 2>&1`);
    const last = out.trim().split("\n").pop().trim();
    if (!/^[\w.]+\/[\w.$]+$/.test(last)) throw new Error(`${pkg} has no launcher screen, or isn't installed.`);
    return last;
  }
  async function appMeta(pkg) {
    const out = await sh(`dumpsys package ${shQuote(pkg)} | grep -m1 versionName; getprop ro.product.model`).catch(() => "");
    const lines = out.split("\n");
    return { version: ((lines[0] || "").match(/versionName=(\S+)/) || [])[1] || "", device: (lines[1] || "").trim() };
  }
  const phoneTime = async () => (await sh(`date +"%m-%d %H:%M:%S.000"`)).trim();

  // ---------- UI helpers ----------
  const seg = (items, value, onPick) => {
    const s = el("div", { className: "seg" });
    for (const [v, label] of items) {
      const b = el("button", { type: "button", textContent: label });
      b.dataset.v = v;
      b.onclick = () => { s.value = v; for (const x of s.children) x.classList.toggle("on", x === b); onPick?.(v); };
      s.append(b);
    }
    s.value = value;
    for (const x of s.children) x.classList.toggle("on", x.dataset.v === String(value));
    return s;
  };
  const tile = (label, value, sub, state) => el("div", { className: "pt-tile" + (state ? " " + state : "") },
    el("div", { className: "pt-lbl", textContent: label }), el("div", { className: "pt-val", textContent: value }),
    el("div", { className: "pt-sub", textContent: sub || "" }));
  const verdict = (ok, text) => el("span", { className: "chip " + (ok == null ? "" : ok ? "pt-pass" : "pt-fail") }, (ok == null ? "" : ok ? "✓ Pass · " : "✕ Fail · ") + text);
  const row = (...kids) => el("div", { className: "dev-row" }, ...kids);
  const lbl = (t) => el("span", { className: "dev-lbl pt-w", textContent: t });

  // A test card: its controls, a Run/Stop pair, a progress line and a results area.
  function testCard(title, intro, controls, runFn) {
    const runBtn = el("button", { className: "btn primary sm", type: "button", textContent: "Run test" });
    const stopBtn = el("button", { className: "btn sm", type: "button", textContent: "Stop", hidden: true });
    const progress = el("div", { className: "pt-progress muted" });
    const results = el("div", { className: "pt-results" });
    runBtn.onclick = async () => {
      if (job) return;
      clearError();
      job = { stop: false };
      setRunning(true, stopBtn);
      try { await runFn({ progress: (t) => { progress.textContent = t; }, results }); progress.textContent = ""; }
      catch (e) {
        if (e instanceof Stopped) { progress.textContent = "Stopped."; }
        else { progress.textContent = ""; showError(e); }
      } finally { job = null; setRunning(false, stopBtn); }
    };
    stopBtn.onclick = () => { if (job) { job.stop = true; progress.textContent = "Stopping after this step…"; } };
    runButtons.push(runBtn);
    return ctx.card(title, el("div", {}, stopBtn, runBtn),
      el("p", { className: "dev-note pt-intro", textContent: intro }), ...controls, progress, results);
  }
  const runButtons = [];
  function setRunning(on, stopBtn) {
    for (const b of runButtons) b.disabled = on;
    stopBtn.hidden = !on;
  }

  // ---------- bar chart (canvas, one series) ----------
  // values: [{ label, value, note }], limit: optional reference line. Hover shows the exact value.
  function barChart({ title, unit, values, limit, digits = 0 }) {
    const canvas = el("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${title}: ` + values.map((v) => `${v.label} ${fmt(v.value, unit, digits)}`).join(", "));
    const tip = el("div", { className: "pt-tip", hidden: true });
    const wrap = el("div", { className: "pt-plot" }, canvas, tip);
    const box = el("div", { className: "pt-chart" },
      el("div", { className: "pt-chart-head" }, el("span", { className: "pt-chart-title", textContent: title }), el("span", { className: "pt-chart-unit", textContent: unit })),
      wrap);
    let hover = -1, geom = null;
    const css = (n, fb) => getComputedStyle(box).getPropertyValue(n).trim() || fb;
    function draw() {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const series = css("--pt-series", "#2a78d6"), seriesHi = css("--pt-series-hi", "#1c5fae"), grid = css("--pt-grid", "rgba(0,0,0,.08)"), muted = css("--muted", "#6e6e78"), ref = css("--pt-ref", "#8a8a94");
      const font = `11px ${css("--mono", "monospace")}`;
      const vals = values.map((v) => (Number.isFinite(v.value) ? v.value : 0));
      let max = Math.max(1, ...vals, Number.isFinite(limit) ? limit : 0) * 1.12;
      const step = niceStep(max / 3); max = Math.ceil(max / step) * step;
      g.font = font;
      const left = Math.max(...[0, step, 2 * step, 3 * step].map((t) => g.measureText(String(round(t, 1))).width)) + 10, right = 6, top = 8, bottom = 18;
      const pw = w - left - right, ph = h - top - bottom;
      const y = (v) => top + ph - (v / max) * ph;
      g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = muted; g.textAlign = "right"; g.textBaseline = "middle";
      for (let t = 0; t <= max + 1e-9; t += step) {
        const yy = Math.round(y(t)) + 0.5;
        g.beginPath(); g.moveTo(left, yy); g.lineTo(w - right, yy); g.stroke();
        g.fillText(String(round(t, 1)), left - 6, yy);
      }
      const n = values.length, slot = pw / Math.max(1, n), bw = Math.max(4, Math.min(36, slot - 2 - slot * 0.25));
      geom = { left, slot, n };
      g.textAlign = "center"; g.textBaseline = "top";
      values.forEach((v, i) => {
        const cx = left + slot * (i + 0.5), x0 = cx - bw / 2;
        if (Number.isFinite(v.value) && v.value > 0) {
          const yy = y(v.value), r = Math.min(4, bw / 2, (top + ph - yy));
          g.fillStyle = i === hover ? seriesHi : series;
          g.beginPath();
          g.moveTo(x0, top + ph); g.lineTo(x0, yy + r); g.quadraticCurveTo(x0, yy, x0 + r, yy);
          g.lineTo(x0 + bw - r, yy); g.quadraticCurveTo(x0 + bw, yy, x0 + bw, yy + r); g.lineTo(x0 + bw, top + ph); g.closePath(); g.fill();
        }
        if (n <= 24 || i % Math.ceil(n / 24) === 0) { g.fillStyle = muted; g.fillText(v.label, cx, top + ph + 4); }
      });
      if (Number.isFinite(limit)) {
        const yy = Math.round(y(limit)) + 0.5;
        g.strokeStyle = ref; g.setLineDash([4, 4]); g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(left, yy); g.lineTo(w - right, yy); g.stroke(); g.setLineDash([]);
        g.fillStyle = muted; g.textAlign = "right"; g.textBaseline = "bottom";
        g.fillText(`limit ${round(limit, 1)}`, w - right, yy - 2);
      }
    }
    canvas.addEventListener("pointermove", (e) => {
      if (!geom) return;
      const i = Math.floor((e.offsetX - geom.left) / geom.slot);
      const nh = i >= 0 && i < geom.n ? i : -1;
      if (nh !== hover) { hover = nh; draw(); }
      if (hover < 0) { tip.hidden = true; return; }
      const v = values[hover];
      tip.replaceChildren(el("span", { textContent: v.label }), el("b", { textContent: fmt(v.value, unit, digits) }), v.note ? el("span", { textContent: v.note }) : "");
      tip.hidden = false;
      const x = geom.left + geom.slot * (hover + 0.5);
      tip.style.left = Math.min(Math.max(0, x - tip.offsetWidth / 2), canvas.clientWidth - tip.offsetWidth) + "px";
      tip.style.top = "0px";
    });
    canvas.addEventListener("pointerleave", () => { hover = -1; tip.hidden = true; draw(); });
    new ResizeObserver(() => draw()).observe(canvas);
    return box;
  }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  // The same numbers as a table, so nothing depends on the chart alone.
  function numbersTable(head, rows) {
    const t = el("table", { className: "pt-table" });
    t.append(el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { textContent: h })))));
    t.append(el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) => el("td", { textContent: c }))))));
    return el("details", { className: "pt-details" }, el("summary", { textContent: "Show the numbers" }), t);
  }

  // ---------- saving runs ----------
  function saveRun(rec) {
    runs = [rec, ...runs].slice(0, MAX_RUNS);
    store.set(STORE_RUNS, runs);
    renderHistory();
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- 1. startup time ----------
  const modeSeg = seg([["cold", "Cold"], ["warm", "Warm"], ["hot", "Hot"]], store.get("ptMode", "cold"), (v) => store.set("ptMode", v));
  const runsSeg = seg([["3", "3"], ["5", "5"], ["10", "10"]], String(store.get("ptRuns", 5)), (v) => store.set("ptRuns", Number(v)));
  const startupCard = testCard("Startup time",
    "Opens the app several times and measures how long its first screen takes. Cold: the app isn't running. Warm: running, but its screen is re-created. Hot: brought back from the background.",
    [row(lbl("Kind"), modeSeg), row(lbl("Runs"), runsSeg)],
    async ({ progress, results }) => {
      const pkg = pkgOrThrow(), mode = modeSeg.value, count = Number(runsSeg.value);
      progress("Getting ready…");
      const comp = await launcherOf(pkg);
      const meta = await appMeta(pkg);
      const since = await phoneTime();
      const list = [];
      // Warm and hot need the app running first.
      if (mode !== "cold") { await sh(`am start -W -n ${shQuote(comp)} >/dev/null 2>&1`); await wait(2000); }
      for (let i = 1; i <= count; i++) {
        checkStop();
        progress(`Run ${i} of ${count}…`);
        let cmd;
        if (mode === "cold") cmd = `am start -W -S -n ${shQuote(comp)} 2>&1`;
        else if (mode === "warm") cmd = `input keyevent KEYCODE_HOME; sleep 1; am start -W --activity-clear-task -n ${shQuote(comp)} 2>&1`;
        else cmd = `input keyevent KEYCODE_HOME; sleep 1; am start -W -n ${shQuote(comp)} 2>&1`;
        const r = parseAmStart(await sh(cmd));
        if (r.total == null && r.wait == null) throw new Error("The phone didn't report a launch time.");
        list.push({ i, total: r.total, wait: r.wait, state: r.state });
        renderStartup(results, { mode, list, pkg, running: true });
        await wait(1500);
      }
      // reportFullyDrawn() times, if the app calls it.
      const drawnOut = await sh(`logcat -d -b main,system -T ${shQuote(since)} 2>/dev/null | grep -F ${shQuote("Fully drawn " + pkg + "/")}`).catch(() => "");
      const drawn = drawnOut.split("\n").map((l) => parseDrawnTime((l.match(/Fully drawn \S+?:\s*(\+\S+)/) || [])[1] || "")).filter((v) => v != null);
      const totals = list.map((x) => x.total).filter(Number.isFinite);
      const metrics = {
        median: median(totals), min: Math.min(...totals), max: Math.max(...totals), p90: pctl(totals, 0.9),
        waitMedian: median(list.map((x) => x.wait).filter(Number.isFinite)),
        drawnMedian: drawn.length ? median(drawn) : null,
        states: [...new Set(list.map((x) => x.state).filter(Boolean))],
      };
      const lim = limits[mode];
      const rec = { id: newId(), type: "startup", mode, pkg, ...meta, date: Date.now(), runs: list, metrics, drawn,
        pass: { median: metrics.median <= lim }, limit: lim };
      saveRun(rec);
      renderStartup(results, { mode, list, pkg, rec });
      toast(`Startup test done: median ${fmt(metrics.median, "ms")}`);
    });

  function renderStartup(results, { mode, list, rec }) {
    const totals = list.map((x) => x.total).filter(Number.isFinite);
    const m = rec?.metrics;
    const lim = limits[mode];
    const states = [...new Set(list.map((x) => x.state).filter(Boolean))];
    const kids = [];
    if (m) {
      kids.push(el("div", { className: "pt-verdict" }, verdict(rec.pass.median, `median ${fmt(m.median, "ms")} (limit ${lim} ms)`),
        mode === "warm" && states.length && !states.includes("WARM")
          ? el("span", { className: "chip warn", textContent: `Android reported these launches as ${states.join("/").toLowerCase()}: the app keeps its screen, so it can't be warm-started this way` }) : ""));
      kids.push(el("div", { className: "pt-tiles" },
        tile("Median", fmt(m.median, "ms"), `${MODE_LABEL[mode]} start · ${list.length} runs`, rec.pass.median ? "" : "bad"),
        tile("Fastest", fmt(m.min, "ms")), tile("90th percentile", fmt(m.p90, "ms")), tile("Slowest", fmt(m.max, "ms")),
        tile("Fully drawn", m.drawnMedian != null ? fmt(m.drawnMedian, "ms") : "–", m.drawnMedian != null ? "median, from reportFullyDrawn()" : "the app doesn't call reportFullyDrawn()")));
    } else if (totals.length) {
      kids.push(el("div", { className: "pt-tiles" }, tile("So far", fmt(median(totals), "ms"), `median of ${totals.length}`)));
    }
    kids.push(barChart({ title: "Time to first screen", unit: "ms", limit: lim,
      values: list.map((x) => ({ label: `#${x.i}`, value: x.total, note: x.state ? x.state.toLowerCase() : "" })) }));
    kids.push(numbersTable(["Run", "Total time (ms)", "Wait time (ms)", "Android said"], list.map((x) => [String(x.i), String(x.total ?? "–"), String(x.wait ?? "–"), x.state || "–"])));
    results.replaceChildren(...kids);
  }

  // ---------- 2. smoothness ----------
  const swipeSeg = seg([["10", "10"], ["20", "20"], ["40", "40"]], String(store.get("ptSwipes", 20)), (v) => store.set("ptSwipes", Number(v)));
  const dirSeg = seg([["v", "Up & down"], ["h", "Left & right"]], store.get("ptDir", "v"), (v) => store.set("ptDir", v));
  const jankCard = testCard("Smoothness",
    "Open the screen you want to test in the app first (a list or feed). Droid Desk swipes it and counts frames that took too long to draw.",
    [row(lbl("Swipes"), swipeSeg), row(lbl("Direction"), dirSeg)],
    async ({ progress, results }) => {
      const pkg = pkgOrThrow(), count = Number(swipeSeg.value), dir = dirSeg.value;
      progress("Checking the screen…");
      const fg = await ctx.app.foreground();
      if (fg !== pkg) throw new Error(`${pkg} isn't on the phone's screen${fg ? ` (${fg} is)` : ""}. Open the screen you want to test, then run again.`);
      const meta = await appMeta(pkg);
      const size = await sh("wm size");
      const pick = (re) => (size.match(re) || [])[1];
      const [w, h] = (pick(/Override size: (\d+x\d+)/) || pick(/Physical size: (\d+x\d+)/) || "1080x2400").split("x").map(Number);
      const a = dir === "v"
        ? [[w / 2, h * 0.75, w / 2, h * 0.3], [w / 2, h * 0.3, w / 2, h * 0.75]]
        : [[w * 0.8, h / 2, w * 0.2, h / 2], [w * 0.2, h / 2, w * 0.8, h / 2]];
      await sh(`dumpsys gfxinfo ${shQuote(pkg)} reset >/dev/null`);
      for (let i = 0; i < count; i += 5) {
        checkStop();
        progress(`Swipe ${Math.min(count, i + 5)} of ${count}…`);
        const cmds = [];
        for (let k = i; k < Math.min(count, i + 5); k++) {
          const [x1, y1, x2, y2] = a[k % 2].map(Math.round);
          cmds.push(`input swipe ${x1} ${y1} ${x2} ${y2} 300; sleep 0.35`);
        }
        await sh(cmds.join("; "));
      }
      await wait(800);
      progress("Reading frame stats…");
      const g = parseGfxinfo(await sh(`dumpsys gfxinfo ${shQuote(pkg)}`));
      if (!g.frames) throw new Error("The app drew no frames during the test. Was the screen scrollable, and is the phone unlocked?");
      const rec = { id: newId(), type: "jank", pkg, ...meta, date: Date.now(), params: { count, dir }, metrics: g,
        pass: { jank: g.jankPct <= limits.jank, p90: g.p90 != null && g.p90 <= limits.p90 }, limit: { jank: limits.jank, p90: limits.p90 } };
      saveRun(rec);
      renderJank(results, rec);
      toast(`Smoothness test done: ${fmt(g.jankPct, "%", 1)} janky`);
    });

  function renderJank(results, rec) {
    const g = rec.metrics;
    results.replaceChildren(
      el("div", { className: "pt-verdict" },
        verdict(rec.pass.jank, `${fmt(g.jankPct, "%", 1)} janky frames (limit ${rec.limit.jank} %)`),
        verdict(rec.pass.p90, `90th percentile ${fmt(g.p90, "ms")} (limit ${rec.limit.p90} ms)`)),
      el("div", { className: "pt-tiles" },
        tile("Frames drawn", String(g.frames), `${g.processes} process${g.processes === 1 ? "" : "es"}`),
        tile("Janky frames", fmt(g.jankPct, "%", 1), `${g.janky} of ${g.frames}`, rec.pass.jank ? "" : "bad"),
        tile("50th percentile", fmt(g.p50, "ms")), tile("90th percentile", fmt(g.p90, "ms"), "", rec.pass.p90 ? "" : "bad"),
        tile("95th percentile", fmt(g.p95, "ms")), tile("99th percentile", fmt(g.p99, "ms"))),
      el("div", { className: "dev-kv pt-kv" },
        el("span", { textContent: "Missed vsync" }), el("span", { textContent: String(g.missedVsync) }),
        el("span", { textContent: "Slow UI thread" }), el("span", { textContent: String(g.slowUi) }),
        el("span", { textContent: "Slow bitmap uploads" }), el("span", { textContent: String(g.slowBitmap) }),
        el("span", { textContent: "Slow draw commands" }), el("span", { textContent: String(g.slowDraw) }),
        el("span", { textContent: "Frame deadline missed" }), el("span", { textContent: String(g.deadlineMissed) }),
        el("span", { textContent: "High input latency" }), el("span", { textContent: String(g.inputLatency) })),
      el("p", { className: "dev-note", textContent: "Slow UI thread means work on the main thread (layout, inflation, disk or network) held frames up. The emulator's GPU is slower than a real phone's, so test on real hardware before trusting the numbers." }));
  }

  // ---------- 3. memory over repetitions ----------
  const repsSeg = seg([["5", "5"], ["10", "10"], ["20", "20"]], String(store.get("ptReps", 10)), (v) => store.set("ptReps", Number(v)));
  const leaveSeg = seg([["back", "Back"], ["home", "Home"]], store.get("ptLeave", "back"), (v) => store.set("ptLeave", v));
  const memCard = testCard("Memory over repetitions",
    "Opens and leaves the app again and again, measuring its memory each time. Memory that keeps climbing, or a growing number of screens (activities), hints at a leak.",
    [row(lbl("Rounds"), repsSeg), row(lbl("Leave with"), leaveSeg)],
    async ({ progress, results }) => {
      const pkg = pkgOrThrow(), count = Number(repsSeg.value), leave = leaveSeg.value;
      progress("Getting ready…");
      const comp = await launcherOf(pkg);
      const meta = await appMeta(pkg);
      const list = [];
      for (let i = 1; i <= count; i++) {
        checkStop();
        progress(`Round ${i} of ${count}…`);
        await sh(`am start -W -n ${shQuote(comp)} >/dev/null 2>&1`);
        await wait(2000);
        await sh(`input keyevent ${leave === "home" ? "KEYCODE_HOME" : "KEYCODE_BACK"}`);
        await wait(1500);
        const m = parseMeminfo(await sh(`dumpsys meminfo ${shQuote(pkg)}`));
        if (m.pss == null) throw new Error(`${pkg} stopped running during the test, so its memory couldn't be read.`);
        list.push({ i, ...m });
        renderMemory(results, { list });
      }
      const from = list[Math.min(1, list.length - 1)], to = list[list.length - 1];
      const growth = from.pss ? ((to.pss - from.pss) / from.pss) * 100 : 0;
      const actFrom = from.activities, actTo = to.activities;
      const activitiesGrow = actFrom != null && actTo != null && actTo > actFrom && list.slice(1).every((x, k, arr) => k === 0 || x.activities >= arr[k - 1].activities);
      const metrics = { first: list[0].pss, start: from.pss, last: to.pss, growth, activitiesFrom: actFrom, activitiesTo: actTo, activitiesGrow, viewsFrom: from.views, viewsTo: to.views };
      const rec = { id: newId(), type: "memory", pkg, ...meta, date: Date.now(), params: { count, leave }, runs: list, metrics,
        pass: { growth: growth <= limits.growth && !activitiesGrow }, limit: { growth: limits.growth } };
      saveRun(rec);
      renderMemory(results, { list, rec });
      toast(`Memory test done: ${growth >= 0 ? "+" : ""}${fmt(growth, "%", 1)}`);
    });

  function renderMemory(results, { list, rec }) {
    const kids = [];
    if (rec) {
      const m = rec.metrics;
      kids.push(el("div", { className: "pt-verdict" },
        verdict(rec.pass.growth, `memory ${m.growth >= 0 ? "+" : ""}${fmt(m.growth, "%", 1)} from round 2 to ${list.length} (limit ${rec.limit.growth} %)`),
        m.activitiesGrow ? el("span", { className: "chip pt-fail", textContent: `Possible leak: open screens went from ${m.activitiesFrom} to ${m.activitiesTo}` }) : ""));
      kids.push(el("div", { className: "pt-tiles" },
        tile("Memory at start", fmt(m.start / 1024, "MB", 1), "PSS after round 2"),
        tile("Memory at end", fmt(m.last / 1024, "MB", 1), `PSS after round ${list.length}`, rec.pass.growth ? "" : "bad"),
        tile("Growth", `${m.growth >= 0 ? "+" : ""}${fmt(m.growth, "%", 1)}`),
        tile("Activities alive", m.activitiesTo != null ? String(m.activitiesTo) : "–", m.activitiesFrom != null ? `was ${m.activitiesFrom}` : ""),
        tile("Views alive", m.viewsTo != null ? String(m.viewsTo) : "–", m.viewsFrom != null ? `was ${m.viewsFrom}` : "")));
    }
    kids.push(barChart({ title: "Memory after each round", unit: "MB", digits: 1,
      values: list.map((x) => ({ label: `#${x.i}`, value: x.pss / 1024, note: x.activities != null ? `${x.activities} activities` : "" })) }));
    kids.push(numbersTable(["Round", "PSS (MB)", "Java heap (MB)", "Native heap (MB)", "Activities", "Views"],
      list.map((x) => [String(x.i), fmt(x.pss / 1024, "", 1), fmt(x.java / 1024, "", 1), fmt(x.native / 1024, "", 1), String(x.activities ?? "–"), String(x.views ?? "–")])));
    results.replaceChildren(...kids);
  }

  // ---------- limits ----------
  const limitGrid = el("div", { className: "pt-limits" });
  for (const [key, label, unit] of LIMIT_INFO) {
    const input = el("input", { type: "number", min: 0, step: "any", value: limits[key], className: "pt-limit" });
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!(v >= 0)) { input.value = limits[key]; return; }
      limits = { ...limits, [key]: v }; store.set(STORE_LIMITS, limits);
    });
    limitGrid.append(el("label", { className: "pt-limit-row" }, el("span", { textContent: label }), el("span", { className: "pt-limit-in" }, "≤ ", input, ` ${unit}`)));
  }
  const resetLimits = el("button", { className: "btn sm", type: "button", textContent: "Defaults" });
  resetLimits.onclick = () => {
    limits = { ...DEFAULT_LIMITS }; store.set(STORE_LIMITS, limits);
    LIMIT_INFO.forEach(([key], i) => { limitGrid.children[i].querySelector("input").value = limits[key]; });
  };
  const limitsCard = ctx.card("Pass / fail limits", resetLimits, limitGrid,
    el("p", { className: "dev-note", textContent: "A test passes when its result is at or below the limit. New limits apply to the next runs." }));

  // ---------- history ----------
  const histBody = el("div", { className: "pt-history" });
  const allApps = el("input", { type: "checkbox" });
  allApps.onchange = () => renderHistory();
  const exportJson = el("button", { className: "btn sm", type: "button", textContent: "Export JSON" });
  const exportHtml = el("button", { className: "btn sm", type: "button", textContent: "Export report" });
  exportJson.onclick = () => { const list = shownRuns(); if (list.length) ctx.download(new Blob([JSON.stringify(list, null, 2)], { type: "application/json" }), `perf-tests-${stamp()}.json`); };
  exportHtml.onclick = () => { const list = shownRuns(); if (list.length) ctx.download(new Blob([reportHtml(list)], { type: "text/html" }), `perf-report-${stamp()}.html`); };
  const historyCard = ctx.card("History", el("div", {}, el("label", { className: "dev-check pt-check" }, allApps, " All apps"), exportJson, exportHtml), histBody,
    el("p", { className: "dev-note", textContent: "Pick a run as the baseline to see how later runs of the same test compare (green is better, red is worse). The last 100 runs are kept on this computer." }));

  const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const shownRuns = () => (allApps.checked ? runs : runs.filter((r) => r.pkg === ctx.app.get()));
  // The number a run is judged by, and whether lower is better (it always is here).
  function keyMetric(r) {
    if (r.type === "startup") return { v: r.metrics.median, unit: "ms", d: 0, text: `median ${fmt(r.metrics.median, "ms")}` };
    if (r.type === "jank") return { v: r.metrics.jankPct, unit: "%", d: 1, text: `${fmt(r.metrics.jankPct, "%", 1)} janky · p90 ${fmt(r.metrics.p90, "ms")}` };
    return { v: r.metrics.growth, unit: "%", d: 1, text: `${r.metrics.growth >= 0 ? "+" : ""}${fmt(r.metrics.growth, "%", 1)} memory` };
  }
  const sameTest = (a, b) => a.type === b.type && a.pkg === b.pkg && (a.type !== "startup" || a.mode === b.mode);
  const testName = (r) => (r.type === "startup" ? `${MODE_LABEL[r.mode]} start` : TYPE_LABEL[r.type]);
  const passed = (r) => Object.values(r.pass || {}).every(Boolean);

  function renderHistory() {
    const list = shownRuns();
    exportJson.disabled = exportHtml.disabled = !list.length;
    if (!list.length) {
      histBody.replaceChildren(el("div", { className: "empty", textContent: allApps.checked || !ctx.app.get() ? "No test runs yet." : `No test runs for ${ctx.app.get()} yet.` }));
      return;
    }
    const base = runs.find((r) => r.id === baselineId);
    const t = el("table", { className: "pt-table pt-hist" });
    t.append(el("thead", {}, el("tr", {}, ...["Baseline", "When", "Test", ...(allApps.checked ? ["App"] : []), "Version", "Phone", "Result", "Change", ""].map((h) => el("th", { textContent: h })))));
    const tb = el("tbody");
    for (const r of list) {
      const radio = el("input", { type: "radio", name: "ptBase", checked: r.id === baselineId, title: "Compare other runs of this test with this one" });
      radio.onchange = () => { baselineId = r.id; renderHistory(); };
      const k = keyMetric(r);
      let change = "";
      if (base && base.id !== r.id && sameTest(base, r)) {
        const bk = keyMetric(base), diff = k.v - bk.v;
        const rel = r.type === "startup" && bk.v ? ` (${diff >= 0 ? "+" : ""}${fmt((diff / bk.v) * 100, "%", 0)})` : "";
        change = el("span", { className: "pt-delta " + (Math.abs(diff) < 1e-9 ? "" : diff < 0 ? "better" : "worse"),
          textContent: `${diff >= 0 ? "+" : ""}${fmt(diff, k.unit, k.d)}${rel}` });
      } else if (base && base.id === r.id) change = el("span", { className: "muted", textContent: "baseline" });
      const del = el("button", { className: "btn sm danger", type: "button", textContent: "Delete" });
      ctx.armedClick(del, async () => { runs = runs.filter((x) => x.id !== r.id); if (baselineId === r.id) baselineId = null; store.set(STORE_RUNS, runs); renderHistory(); });
      const dl = el("button", { className: "btn sm", type: "button", textContent: "Report" });
      dl.onclick = () => ctx.download(new Blob([reportHtml([r])], { type: "text/html" }), `perf-${r.type}-${r.pkg}-${new Date(r.date).toISOString().slice(0, 10)}.html`);
      tb.append(el("tr", {},
        el("td", {}, radio),
        el("td", { textContent: new Date(r.date).toLocaleString() }),
        el("td", { textContent: testName(r) }),
        ...(allApps.checked ? [el("td", { className: "mono", textContent: r.pkg })] : []),
        el("td", { textContent: r.version || "–" }),
        el("td", { textContent: r.device || "–" }),
        el("td", {}, el("span", { className: "chip " + (passed(r) ? "pt-pass" : "pt-fail"), textContent: passed(r) ? "Pass" : "Fail" }), " ", k.text),
        el("td", {}, change),
        el("td", { className: "pt-act" }, dl, del)));
    }
    t.append(tb);
    histBody.replaceChildren(el("div", { className: "pt-scroll" }, t));
  }

  // A self-contained HTML report (no scripts, everything escaped).
  function reportHtml(list) {
    const rowsFor = (r) => {
      const m = r.metrics, lines = [];
      if (r.type === "startup") {
        lines.push(["Median", fmt(m.median, "ms")], ["Fastest", fmt(m.min, "ms")], ["90th percentile", fmt(m.p90, "ms")], ["Slowest", fmt(m.max, "ms")],
          ["Fully drawn (median)", m.drawnMedian != null ? fmt(m.drawnMedian, "ms") : "not reported"], ["Limit", `${r.limit} ms`],
          ["Runs", r.runs.map((x) => `${x.total} ms${x.state ? " (" + x.state.toLowerCase() + ")" : ""}`).join(", ")]);
      } else if (r.type === "jank") {
        lines.push(["Frames", String(m.frames)], ["Janky frames", `${fmt(m.jankPct, "%", 1)} (${m.janky})`], ["Percentiles 50/90/95/99", `${m.p50}/${m.p90}/${m.p95}/${m.p99} ms`],
          ["Slow UI thread", String(m.slowUi)], ["Missed vsync", String(m.missedVsync)], ["Limits", `${r.limit.jank} % janky, p90 ${r.limit.p90} ms`],
          ["Swipes", `${r.params.count} (${r.params.dir === "h" ? "left & right" : "up & down"})`]);
      } else {
        lines.push(["Memory at start (round 2)", fmt(m.start / 1024, "MB", 1)], ["Memory at end", fmt(m.last / 1024, "MB", 1)], ["Growth", fmt(m.growth, "%", 1)],
          ["Activities", `${m.activitiesFrom ?? "–"} → ${m.activitiesTo ?? "–"}${m.activitiesGrow ? " (possible leak)" : ""}`], ["Limit", `${r.limit.growth} %`],
          ["Rounds (PSS MB)", r.runs.map((x) => fmt(x.pss / 1024, "", 1)).join(", ")]);
      }
      return lines.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join("");
    };
    const sections = list.map((r) => `<section><h2>${esc(testName(r))} — ${esc(r.pkg)} <span class="${passed(r) ? "pass" : "fail"}">${passed(r) ? "Pass" : "Fail"}</span></h2>
<p class="meta">${esc(new Date(r.date).toLocaleString())} · version ${esc(r.version || "?")} · ${esc(r.device || "?")}</p><table>${rowsFor(r)}</table></section>`).join("\n");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Performance tests</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1b1b1f;background:#fff}h1{font-weight:400}h2{font-size:17px;font-weight:500;margin:28px 0 4px}
.meta{color:#6e6e78;margin:0 0 8px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 10px;border-bottom:1px solid #e6e6ec;vertical-align:top}th{font-weight:500;width:230px;color:#444}
.pass,.fail{font-size:12px;padding:2px 9px;border-radius:999px;margin-left:6px}.pass{background:#d5efea;color:#1f6e55}.fail{background:#fbe1df;color:#b3312c}
@media (prefers-color-scheme: dark){body{background:#121216;color:#f1f1f5}th{color:#c8c8d0}th,td{border-color:#2c2c34}.meta{color:#a2a2ad}.pass{background:#22403a;color:#7fdcc0}.fail{background:#4a2f2d;color:#f08a86}}</style></head>
<body><h1>Performance tests</h1><p class="meta">Made with Droid Desk on ${esc(new Date().toLocaleString())}</p>${sections}</body></html>`;
  }

  // ---------- layout ----------
  const picker = ctx.app.picker();
  ctx.app.onChange(() => renderHistory());
  root.append(
    el("div", { className: "card pt-pickcard" }, picker,
      el("p", { className: "dev-note", textContent: "Keep the phone unlocked and its screen on while tests run. Results vary between runs: compare medians, and test on a real phone for numbers that matter." })),
    startupCard, jankCard, memCard, limitsCard, historyCard);
  renderHistory();

  const stopJob = () => { if (job) job.stop = true; };
  return {
    show: () => renderHistory(),
    beforeDisconnect: stopJob,
    disconnected: stopJob,
  };
}
