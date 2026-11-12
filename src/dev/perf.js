// Developer tab › Performance: live CPU / memory / frame charts for one app, plus battery, Doze and
// app-standby switches for testing how an app behaves on battery and in the background.
//
// Sampling (only while this sub-tab is on screen and the monitor is started):
//   every 1 s  one shell call: /proc/stat (whole phone) + /proc/<pid>/stat and VmRSS for each of the app's processes
//   every 2 s  dumpsys gfxinfo <pkg>   -> frames drawn since the last sample, janky share, frame-time percentiles
//   every 3 s  dumpsys meminfo <pkg>   -> PSS (the memory figure Android itself uses)
// Every string from the phone is untrusted: inserted with textContent / el() only.

const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const WINDOW_MS = 120_000;
const BUCKETS = [
  ["active", "Active", 10], ["working_set", "Working set", 20], ["frequent", "Frequent", 30],
  ["rare", "Rare", 40], ["restricted", "Restricted", 45],
];
const BUCKET_NAMES = { 5: "Exempted", 10: "Active", 20: "Working set", 30: "Frequent", 40: "Rare", 45: "Restricted", 50: "Never" };

export function mount(root, ctx) {
  const { el, sh, shQuote, toast, showError, busy, makeSwitch, armedClick, download, app, card } = ctx;
  const validPkg = (p) => PKG_RE.test(p || "");
  const needPkg = () => {
    const p = app.get();
    if (!validPkg(p)) throw new Error("Choose an app first (type its package name or click “Current app”).");
    return p;
  };
  const act = (btn, label, fn) => async () => {
    ctx.clearError(); if (btn) busy(btn, true, label);
    try { await fn(); } catch (e) { showError(e); } finally { if (btn) busy(btn, false); }
  };
  const button = (text, cls = "btn sm") => el("button", { type: "button", className: cls, textContent: text });

  // ---------------------------------------------------------------- live monitor
  const startBtn = button("Start", "btn sm primary");
  const resetFramesBtn = button("Reset frame stats");
  const status = el("div", { className: "perf-status muted", textContent: "Pick an app, then click Start." });

  const tile = (label) => {
    const v = el("div", { className: "perf-val", textContent: "–" });
    const s = el("div", { className: "perf-sub", textContent: "" });
    return { node: el("div", { className: "perf-tile" }, el("div", { className: "perf-lbl", textContent: label }), v, s), v, s };
  };
  const tiles = {
    cpu: tile("CPU"), mem: tile("Memory (PSS)"), fps: tile("Frames per second"), jank: tile("Janky frames"), times: tile("Frame time"),
  };

  const charts = {
    cpu: lineChart("CPU", "% of the whole phone", (v) => `${v.toFixed(1)}%`, 10),
    mem: lineChart("Memory", "PSS, MB", (v) => `${v.toFixed(0)} MB`, 50),
    fps: lineChart("Frames per second", "frames drawn", (v) => v.toFixed(0), 10),
  };

  root.append(card("Live monitor", el("div", {}, resetFramesBtn, startBtn),
    app.picker({ label: "App" }),
    status,
    el("div", { className: "perf-tiles" }, ...Object.values(tiles).map((t) => t.node)),
    el("div", { className: "perf-charts" }, ...Object.values(charts).map((c) => c.node)),
    el("p", { className: "dev-note", textContent: "CPU is the app's share of all cores together; “of one core” is the same figure as in top. Frames count only while the app draws: a still screen shows 0." }),
  ));

  let wanted = false, timer = null, tickNo = 0, running = false;
  // What Droid Desk changed on the phone, so Disconnect can put it back.
  let changedBattery = false, forcedDoze = false, enabledDoze = false;
  let prev = null; // { total, procs: Map(pid -> ticks) }
  let gfxPrev = null; // { t, frames, janky }
  let cores = 0;

  function resetData() {
    prev = null; gfxPrev = null; tickNo = 0;
    for (const c of Object.values(charts)) c.clear();
    for (const t of Object.values(tiles)) { t.v.textContent = "–"; t.s.textContent = ""; }
  }

  function setStatus(text) { status.textContent = text; }

  async function sampleCpu(pkg) {
    const out = await sh(`head -1 /proc/stat; for p in $(ps -A -o PID=,NAME= | awk -v p=${pkg} '$2==p || index($2,p":")==1 {print $1}'); do echo "P $p"; cat /proc/$p/stat 2>/dev/null; grep VmRSS /proc/$p/status 2>/dev/null; done`);
    const lines = out.split("\n");
    const cpuLine = lines.find((l) => l.startsWith("cpu "));
    if (!cpuLine) return;
    const total = cpuLine.trim().split(/\s+/).slice(1).reduce((a, b) => a + (Number(b) || 0), 0);
    const procs = new Map(); let rssKb = 0, pid = null;
    for (const l of lines) {
      if (l.startsWith("P ")) { pid = l.slice(2).trim(); continue; }
      if (!pid) continue;
      const close = l.lastIndexOf(")");
      if (close > 0 && l.startsWith(pid + " ")) {
        const f = l.slice(close + 2).trim().split(/\s+/); // f[0] is field 3 (state)
        procs.set(pid, (Number(f[11]) || 0) + (Number(f[12]) || 0)); // utime + stime
      } else if (l.startsWith("VmRSS:")) rssKb += Number(l.replace(/\D+/g, "")) || 0;
    }
    const now = Date.now();
    if (!procs.size) {
      setStatus("App isn't running. Open it on the phone; the charts start as soon as it runs.");
      charts.cpu.push(now, null); tiles.cpu.v.textContent = "–"; tiles.cpu.s.textContent = "not running";
      prev = { total, procs }; return;
    }
    setStatus(`Watching ${pkg} · ${procs.size} process${procs.size > 1 ? "es" : ""} (${[...procs.keys()].join(", ")})`);
    if (prev && total > prev.total) {
      let d = 0;
      for (const [p, ticks] of procs) { const before = prev.procs.get(p); if (before != null && ticks >= before) d += ticks - before; }
      const pct = Math.max(0, Math.min(100, (d / (total - prev.total)) * 100));
      charts.cpu.push(now, pct);
      tiles.cpu.v.textContent = `${pct.toFixed(1)}%`;
      tiles.cpu.s.textContent = cores ? `${(pct * cores).toFixed(0)}% of one core · ${cores} cores` : "";
    }
    prev = { total, procs };
    tiles.mem.s.textContent = rssKb ? `RSS ${(rssKb / 1024).toFixed(0)} MB` : "";
  }

  async function sampleMem(pkg) {
    const out = await sh(`dumpsys meminfo ${pkg} | grep -E 'TOTAL PSS:|TOTAL:|^ *TOTAL '`);
    let kb = 0;
    const pss = [...out.matchAll(/TOTAL PSS:\s*(\d+)/g)];
    if (pss.length) kb = pss.reduce((a, m) => a + Number(m[1]), 0);
    else {
      const alt = [...out.matchAll(/TOTAL:\s*(\d+)/g)];
      const rows = alt.length ? alt : [...out.matchAll(/^\s*TOTAL\s+(\d+)/gm)];
      kb = rows.reduce((a, m) => a + Number(m[1]), 0);
    }
    if (!kb) { charts.mem.push(Date.now(), null); tiles.mem.v.textContent = "–"; return; }
    const mb = kb / 1024;
    charts.mem.push(Date.now(), mb);
    tiles.mem.v.textContent = `${mb.toFixed(0)} MB`;
  }

  async function sampleGfx(pkg) {
    const out = await sh(`dumpsys gfxinfo ${pkg} | grep -E '^(Total frames rendered|Janky frames:|50th percentile|90th percentile|99th percentile)'`);
    const sum = (re) => [...out.matchAll(re)].reduce((a, m) => a + Number(m[1]), 0);
    const has = /Total frames rendered/.test(out);
    const now = Date.now();
    if (!has) { charts.fps.push(now, null); gfxPrev = null; tiles.fps.v.textContent = "–"; return; }
    const frames = sum(/Total frames rendered:\s*(\d+)/g), janky = sum(/Janky frames:\s*(\d+)/g);
    const pctl = (n) => { const m = out.match(new RegExp(`${n}th percentile:\\s*(\\d+)ms`)); return m ? Number(m[1]) : null; };
    const p50 = pctl(50), p90 = pctl(90), p99 = pctl(99);
    if (gfxPrev && frames >= gfxPrev.frames) {
      const df = frames - gfxPrev.frames, dj = Math.max(0, janky - gfxPrev.janky), dt = (now - gfxPrev.t) / 1000;
      const fps = dt > 0 ? df / dt : 0;
      charts.fps.push(now, fps);
      tiles.fps.v.textContent = fps.toFixed(0);
      tiles.fps.s.textContent = `${df} frame${df === 1 ? "" : "s"} in the last ${dt.toFixed(0)} s`;
      tiles.jank.v.textContent = df ? `${((dj / df) * 100).toFixed(0)}%` : "–";
    }
    tiles.jank.s.textContent = frames ? `${janky} of ${frames} since reset (${((janky / frames) * 100).toFixed(1)}%)` : "no frames yet";
    tiles.times.v.textContent = p50 != null ? `${p50} ms` : "–";
    tiles.times.s.textContent = p90 != null ? `median · 90th ${p90} ms · 99th ${p99} ms` : "";
    gfxPrev = { t: now, frames, janky };
  }

  async function tick() {
    timer = null;
    if (!wanted || !ctx.isShown("perf") || !ctx.getAdb()) { running = false; return; }
    running = true;
    const pkg = app.get();
    const started = Date.now();
    if (!validPkg(pkg)) { setStatus("Pick an app to watch."); }
    else {
      const jobs = [sampleCpu(pkg)];
      if (tickNo % 2 === 0) jobs.push(sampleGfx(pkg));
      if (tickNo % 3 === 0) jobs.push(sampleMem(pkg));
      tickNo++;
      const res = await Promise.allSettled(jobs);
      const failed = res.find((r) => r.status === "rejected");
      if (failed && ctx.getAdb()) setStatus(`Couldn't read the numbers: ${failed.reason?.message || failed.reason}`);
    }
    if (wanted && ctx.isShown("perf") && ctx.getAdb()) timer = setTimeout(tick, Math.max(100, 1000 - (Date.now() - started)));
    else running = false;
  }

  async function startMonitor() {
    if (!ctx.getAdb()) return;
    if (!cores) cores = Number((await sh("nproc").catch(() => "")).trim()) || 0;
    if (!running && !timer) tick();
  }
  function stopTimer() { clearTimeout(timer); timer = null; }
  function setWanted(on) {
    wanted = on;
    startBtn.textContent = on ? "Stop" : "Start";
    startBtn.classList.toggle("primary", !on);
    if (on) { if (!validPkg(app.get())) setStatus("Pick an app to watch."); startMonitor().catch(showError); }
    else { stopTimer(); setStatus("Stopped."); }
  }
  startBtn.onclick = () => {
    if (!wanted && !validPkg(app.get())) { showError("Choose an app first (type its package name or click “Current app”)."); return; }
    setWanted(!wanted);
  };
  resetFramesBtn.onclick = act(resetFramesBtn, "Resetting…", async () => {
    const pkg = needPkg();
    await sh(`dumpsys gfxinfo ${pkg} reset >/dev/null`);
    gfxPrev = null; charts.fps.clear();
    toast("Frame stats reset");
  });
  app.onChange(() => { resetData(); refreshStandby(); });

  // ---------------------------------------------------------------- battery & power
  const batInfo = el("div", { className: "dev-kv" });
  const unplugSw = makeSwitch(false, async (want) => {
    await sh(want ? "dumpsys battery unplug" : "dumpsys battery reset");
    changedBattery = want;
    await refreshBattery();
    return want;
  });
  const level = el("input", { type: "range", min: 0, max: 100, value: 50, className: "perf-range" });
  const levelNum = el("span", { className: "mono", textContent: "50%" });
  level.oninput = () => { levelNum.textContent = `${level.value}%`; };
  const setLevelBtn = button("Set level");
  const resetBatBtn = button("Back to real battery");
  const resetStatsBtn = button("Reset battery stats", "btn sm danger");
  const saveStatsBtn = button("Save battery stats for this app");
  setLevelBtn.onclick = act(setLevelBtn, "Setting…", async () => {
    const n = Math.max(0, Math.min(100, Math.round(Number(level.value))));
    await sh(`dumpsys battery set level ${n}`); changedBattery = true; await refreshBattery(); toast(`Battery shows ${n}%`);
  });
  resetBatBtn.onclick = act(resetBatBtn, "Resetting…", async () => { await sh("dumpsys battery reset"); changedBattery = false; await refreshBattery(); toast("Battery back to normal"); });
  armedClick(resetStatsBtn, act(null, "", async () => { await sh("dumpsys batterystats --reset"); toast("Battery stats cleared"); }));
  saveStatsBtn.onclick = act(saveStatsBtn, "Collecting…", async () => {
    const pkg = needPkg();
    const text = await sh(`dumpsys batterystats --charged ${pkg}`);
    download(new Blob([text], { type: "text/plain" }), `batterystats-${pkg}-${stamp()}.txt`);
  });

  async function refreshBattery() {
    const out = await sh("dumpsys battery");
    const get = (k) => (out.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, "m")) || [])[1]?.trim() ?? "";
    const plugged = ["AC powered", "USB powered", "Wireless powered", "Dock powered"].filter((k) => get(k) === "true");
    unplugSw.set(!plugged.length);
    const lv = get("level");
    if (lv && document.activeElement !== level) { level.value = lv; levelNum.textContent = `${lv}%`; }
    const STATUS = { 1: "Unknown", 2: "Charging", 3: "Discharging", 4: "Not charging", 5: "Full" };
    batInfo.replaceChildren(
      el("span", { textContent: "Level" }), el("span", { textContent: lv ? `${lv}%` : "–" }),
      el("span", { textContent: "Power source" }), el("span", { textContent: plugged.length ? plugged.map((k) => k.replace(" powered", "")).join(", ") : "none (on battery)" }),
      el("span", { textContent: "Status" }), el("span", { textContent: STATUS[get("status")] || get("status") || "–" }),
    );
  }

  const batCard = card("Battery & power", button("Refresh"),
    batInfo,
    el("div", { className: "ctl perf-ctl" }, el("div", {}, el("div", { textContent: "Pretend unplugged" }), el("div", { className: "sub", textContent: "The phone acts as if it's on battery, even on the cable" })), unplugSw),
    el("div", { className: "dev-row" }, el("span", { className: "dev-lbl", textContent: "Battery level" }), level, levelNum, setLevelBtn),
    el("div", { className: "dev-row" }, resetBatBtn, saveStatsBtn, resetStatsBtn),
    el("p", { className: "dev-note", textContent: "These only change what Android reports; the real battery isn't touched. “Back to real battery” undoes all of them." }),
  );
  batCard.querySelector(".dev-head button").onclick = () => refreshBattery().catch(showError);

  // ---------------------------------------------------------------- Doze
  const dozeState = el("div", { className: "dev-kv" });
  const forceBtn = button("Force deep Doze", "btn sm primary");
  const stepBtn = button("Next step");
  const exitBtn = button("Leave Doze");
  async function refreshDoze() {
    const out = await sh("dumpsys deviceidle get deep; echo ---; dumpsys deviceidle get light");
    const [deep, light] = out.split("---").map((s) => s.trim() || "–");
    dozeState.replaceChildren(
      el("span", { textContent: "Deep Doze" }), el("span", { textContent: deep }),
      el("span", { textContent: "Light Doze" }), el("span", { textContent: light }),
    );
  }
  forceBtn.onclick = act(forceBtn, "Dozing…", async () => {
    let out = await sh("dumpsys battery unplug; dumpsys deviceidle force-idle"); changedBattery = true;
    if (/not enabled/i.test(out)) { // Doze is switched off on this phone (emulators): turn it on for the test
      await sh("dumpsys deviceidle enable deep"); enabledDoze = true;
      out = await sh("dumpsys deviceidle force-idle");
    }
    if (/unable/i.test(out)) throw new Error(out.trim());
    forcedDoze = true; await refreshDoze(); refreshBattery().catch(() => {}); toast("Phone is in deep Doze");
  });
  stepBtn.onclick = act(stepBtn, "Stepping…", async () => { const o = await sh("dumpsys deviceidle step"); await refreshDoze(); toast(o.trim().split("\n").pop() || "Stepped"); });
  exitBtn.onclick = act(exitBtn, "Waking…", async () => {
    await sh(`dumpsys deviceidle unforce; dumpsys battery reset${enabledDoze ? "; dumpsys deviceidle disable deep" : ""}`);
    changedBattery = false; forcedDoze = false; enabledDoze = false; await refreshDoze(); refreshBattery().catch(() => {}); toast("Doze off, battery back to normal");
  });
  const dozeCard = card("Doze", button("Refresh"),
    dozeState,
    el("div", { className: "dev-row" }, forceBtn, stepBtn, exitBtn),
    el("p", { className: "dev-note", textContent: "Doze delays jobs, alarms and network for apps while the phone sits idle. Force it to test what your app does; “Leave Doze” also plugs the battery back in." }),
  );
  dozeCard.querySelector(".dev-head button").onclick = () => refreshDoze().catch(showError);

  // ---------------------------------------------------------------- app standby
  const sbState = el("div", { className: "dev-kv" });
  const seg = el("div", { className: "seg" });
  for (const [key, label] of BUCKETS) {
    const b = el("button", { type: "button", textContent: label });
    b.dataset.bucket = key;
    b.onclick = act(null, "", async () => {
      const pkg = needPkg();
      const out = await sh(`am set-standby-bucket ${pkg} ${key}`);
      if (/error|exception|unknown/i.test(out)) throw new Error(out.trim());
      const now = await refreshStandby();
      if (now !== BUCKETS.find((x) => x[0] === key)[2]) toast(`Android kept ${pkg} in ${BUCKET_NAMES[now] || now} (the app may be exempt, or app standby is off on this phone)`);
      else toast(`${pkg}: ${label}`);
    });
    seg.append(b);
  }
  const inactiveBtn = button("Make inactive");
  const activeBtn = button("Make active");
  inactiveBtn.onclick = act(inactiveBtn, "…", async () => { const pkg = needPkg(); await sh(`am set-inactive ${pkg} true`); await refreshStandby(); });
  activeBtn.onclick = act(activeBtn, "…", async () => { const pkg = needPkg(); await sh(`am set-inactive ${pkg} false`); await refreshStandby(); });
  async function refreshStandby() {
    const pkg = app.get();
    if (!validPkg(pkg) || !ctx.getAdb()) {
      sbState.replaceChildren(el("span", { textContent: "App" }), el("span", { textContent: "pick one above" }));
      for (const b of seg.children) b.classList.remove("on");
      return;
    }
    const out = await sh(`am get-standby-bucket ${pkg}; echo ---; am get-inactive ${pkg}`);
    const [bucketRaw, inactiveRaw] = out.split("---").map((s) => s.trim());
    const n = Number(bucketRaw);
    const name = BUCKET_NAMES[n] || bucketRaw || "–";
    for (const b of seg.children) b.classList.toggle("on", BUCKETS.find((x) => x[0] === b.dataset.bucket)?.[2] === n);
    sbState.replaceChildren(
      el("span", { textContent: "App" }), el("span", { textContent: pkg }),
      el("span", { textContent: "Standby bucket" }), el("span", { textContent: Number.isFinite(n) ? `${name} (${n})` : name }),
      el("span", { textContent: "Idle" }), el("span", { textContent: /true/.test(inactiveRaw) ? "yes (inactive)" : /false/.test(inactiveRaw) ? "no (active)" : inactiveRaw || "–" }),
    );
    return n;
  }
  const sbCard = card("App standby", button("Refresh"),
    sbState,
    el("div", { className: "dev-row" }, seg),
    el("div", { className: "dev-row" }, inactiveBtn, activeBtn),
    el("p", { className: "dev-note", textContent: "The bucket decides how often Android lets the app run jobs and alarms. Rarer buckets get fewer chances; Restricted is the strictest." }),
  );
  sbCard.querySelector(".dev-head button").onclick = () => refreshStandby().catch(showError);

  root.append(el("div", { className: "perf-grid" }, batCard, el("div", {}, dozeCard, sbCard)));

  // ---------------------------------------------------------------- hooks
  const themeMq = matchMedia("(prefers-color-scheme: dark)");
  themeMq.addEventListener("change", () => { for (const c of Object.values(charts)) c.draw(); });

  return {
    show() {
      Promise.all([refreshBattery(), refreshDoze(), refreshStandby()]).catch(showError);
      for (const c of Object.values(charts)) c.draw();
      if (wanted) startMonitor().catch(showError);
    },
    hide() { stopTimer(); running = false; },
    connected() { cores = 0; changedBattery = false; forcedDoze = false; enabledDoze = false; },
    // Clicking Disconnect: put back what Droid Desk faked, while the phone can still hear us.
    async beforeDisconnect() {
      wanted = false; stopTimer();
      const cmds = [];
      if (forcedDoze) cmds.push("dumpsys deviceidle unforce");
      if (enabledDoze) cmds.push("dumpsys deviceidle disable deep");
      if (changedBattery || forcedDoze) cmds.push("dumpsys battery reset");
      changedBattery = false; forcedDoze = false; enabledDoze = false;
      if (cmds.length) await sh(cmds.join("; ")).catch(() => {});
    },
    disconnected() { wanted = false; stopTimer(); running = false; startBtn.textContent = "Start"; startBtn.classList.add("primary"); resetData(); setStatus("Phone disconnected."); },
  };
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");

// ---------------------------------------------------------------- one small line chart
// One series, last two minutes. 2px line, hairline grid, the newest value labelled at the line end,
// and a crosshair + tooltip on hover. Colours come from CSS variables, so light and dark both work.
function lineChart(title, unit, fmt, minMax) {
  const canvas = document.createElement("canvas");
  const tip = document.createElement("div"); tip.className = "perf-tip"; tip.hidden = true;
  const now = document.createElement("span"); now.className = "perf-now";
  const head = document.createElement("div"); head.className = "perf-chart-head";
  const t = document.createElement("span"); t.className = "perf-chart-title"; t.textContent = title;
  const u = document.createElement("span"); u.className = "perf-chart-unit"; u.textContent = unit;
  head.append(t, u, now);
  const wrap = document.createElement("div"); wrap.className = "perf-plot"; wrap.append(canvas, tip);
  const node = document.createElement("div"); node.className = "perf-chart"; node.append(head, wrap);
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `${title} chart`);

  let pts = []; // { t, v } (v null = gap)
  let hoverX = null;
  const PAD = { l: 40, r: 12, t: 10, b: 20 };

  const css = (name, fb) => getComputedStyle(node).getPropertyValue(name).trim() || fb;
  const niceMax = (v) => {
    const m = Math.max(v, minMax);
    const p = 10 ** Math.floor(Math.log10(m));
    for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= m) return k * p;
    return 10 * p;
  };

  function geometry() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const end = Date.now(), start = end - WINDOW_MS;
    const vals = pts.filter((p) => p.v != null && p.t >= start).map((p) => p.v);
    const max = niceMax(vals.length ? Math.max(...vals) * 1.1 : 0);
    const x = (tt) => PAD.l + ((tt - start) / WINDOW_MS) * (w - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - v / max) * (h - PAD.t - PAD.b);
    return { w, h, start, end, max, x, y };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const G = geometry();
    const line = css("--perf-series", "#2a78d6"), grid = css("--perf-grid", "rgba(0,0,0,.08)"), muted = css("--muted", "#6e6e78"), surface = css("--perf-surface", "#fff");
    g.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    g.textBaseline = "middle";
    // hairline grid + y labels at 0, half, max
    for (const f of [0, 0.5, 1]) {
      const v = G.max * f, yy = Math.round(G.y(v)) + 0.5;
      g.strokeStyle = grid; g.lineWidth = 1; g.beginPath(); g.moveTo(PAD.l, yy); g.lineTo(w - PAD.r, yy); g.stroke();
      g.fillStyle = muted; g.textAlign = "right"; g.fillText(shortNum(v), PAD.l - 6, yy);
    }
    g.textAlign = "left"; g.fillText("2 min ago", PAD.l, h - 8);
    g.textAlign = "right"; g.fillText("now", w - PAD.r, h - 8);
    // the line, broken where the app wasn't running
    const vis = pts.filter((p) => p.t >= G.start - 3000);
    g.strokeStyle = line; g.lineWidth = 2; g.lineJoin = "round"; g.lineCap = "round";
    g.beginPath(); let pen = false;
    for (const p of vis) {
      if (p.v == null) { pen = false; continue; }
      const xx = Math.max(PAD.l, G.x(p.t)), yy = G.y(p.v);
      if (pen) g.lineTo(xx, yy); else { g.moveTo(xx, yy); pen = true; }
    }
    g.stroke();
    // newest point: marker with a surface ring
    const last = [...vis].reverse().find((p) => p.v != null);
    const lastIsNow = vis.length && vis[vis.length - 1].v != null;
    if (last && lastIsNow) {
      g.fillStyle = surface; g.beginPath(); g.arc(G.x(last.t), G.y(last.v), 5.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = line; g.beginPath(); g.arc(G.x(last.t), G.y(last.v), 4, 0, Math.PI * 2); g.fill();
    }
    now.textContent = lastIsNow ? fmt(last.v) : (vis.length ? "–" : "");
    // crosshair
    if (hoverX != null) {
      const cand = vis.filter((p) => p.v != null);
      if (cand.length) {
        let best = cand[0];
        for (const p of cand) if (Math.abs(G.x(p.t) - hoverX) < Math.abs(G.x(best.t) - hoverX)) best = p;
        const xx = Math.round(G.x(best.t)) + 0.5;
        g.strokeStyle = muted; g.lineWidth = 1; g.beginPath(); g.moveTo(xx, PAD.t); g.lineTo(xx, h - PAD.b); g.stroke();
        g.fillStyle = surface; g.beginPath(); g.arc(xx, G.y(best.v), 5.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = line; g.beginPath(); g.arc(xx, G.y(best.v), 4, 0, Math.PI * 2); g.fill();
        const ago = Math.round((Date.now() - best.t) / 1000);
        tip.replaceChildren();
        const key = document.createElement("i"); key.className = "perf-key";
        const val = document.createElement("b"); val.textContent = fmt(best.v);
        const when = document.createElement("span"); when.textContent = ago <= 1 ? "now" : `${ago} s ago`;
        tip.append(key, val, when);
        tip.hidden = false;
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(xx - tw / 2, 0), w - tw)}px`;
        tip.style.top = `${Math.max(0, G.y(best.v) - 38)}px`;
      } else tip.hidden = true;
    } else tip.hidden = true;
  }

  canvas.addEventListener("pointermove", (e) => { hoverX = e.offsetX; draw(); });
  canvas.addEventListener("pointerleave", () => { hoverX = null; draw(); });
  new ResizeObserver(() => draw()).observe(canvas);

  return {
    node,
    push(tt, v) {
      pts.push({ t: tt, v: v == null || !isFinite(v) ? null : v });
      const cut = tt - WINDOW_MS - 5000;
      while (pts.length && pts[0].t < cut) pts.shift();
      draw();
    },
    clear() { pts = []; draw(); },
    draw,
  };
}

function shortNum(v) {
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  if (v >= 10 || v === 0) return v.toFixed(0);
  return v.toFixed(1);
}
