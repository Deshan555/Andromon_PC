// App testing › Traces: record what the phone and an app were doing, to find slow frames, slow startup
// and memory problems.
//
// - System trace: Perfetto (Android 9+, on by default from 11). The config is sent as text and fed to
//   `perfetto --txt -c -`; the trace is written to /data/misc/perfetto-traces, copied to this computer
//   and deleted. "Open in Perfetto" serves it once to ui.perfetto.dev in the browser (../../traceview.js).
// - Method trace: `am profile start/stop` (debuggable apps), for Android Studio's profiler.
// - Heap dump: `am dumpheap` (debuggable apps), an .hprof for Android Studio or MAT.

const OUT_DIR = "/data/misc/perfetto-traces";
const CFG = "/data/local/tmp/dd-trace.cfg";
const PKG_RE = /^[A-Za-z0-9_.]+$/;
const PRESETS = [
  { id: "ui", label: "App & UI", note: "CPU scheduling, frames and your app's own trace sections. The usual start for jank." },
  { id: "startup", label: "App startup", note: "Same as App & UI, and Droid Desk cold-starts the app a second after recording begins." },
  { id: "cpu", label: "CPU & battery", note: "CPU frequency and idle states, battery counters and power rails where the phone has them." },
  { id: "memory", label: "Memory", note: "Memory of every process once a second, low-memory kills and system memory." },
];
const DURATIONS = [[5, "5 s"], [10, "10 s"], [20, "20 s"], [30, "30 s"], [60, "1 min"]];

/** Perfetto text config for a preset. Exported for tests. */
export function traceConfig({ preset, seconds, pkg, logcat }) {
  const ftrace = ["sched/sched_switch", "sched/sched_wakeup", "sched/sched_waking", "sched/sched_process_exit", "sched/sched_process_free",
    "task/task_newtask", "task/task_rename", "power/cpu_frequency", "power/cpu_idle", "power/suspend_resume"];
  const atrace = ["gfx", "view", "wm", "am", "input", "dalvik", "binder_driver", "hal", "res", "sched", "freq", "ss", "aidl"];
  const ds = [];
  const q = (s) => JSON.stringify(s);
  if (preset !== "memory") {
    ds.push(`data_sources: { config { name: "linux.ftrace" ftrace_config {
${ftrace.map((e) => `  ftrace_events: ${q(e)}`).join("\n")}
${preset === "cpu" ? "" : atrace.map((c) => `  atrace_categories: ${q(c)}`).join("\n")}
${preset !== "cpu" ? `  atrace_apps: ${q(pkg && PKG_RE.test(pkg) ? pkg : "*")}` : ""}
  buffer_size_kb: 8192 drain_period_ms: 250 } } }`);
    if (preset !== "cpu") ds.push('data_sources: { config { name: "android.surfaceflinger.frametimeline" } }');
  } else {
    ds.push(`data_sources: { config { name: "linux.ftrace" ftrace_config {
  ftrace_events: "lowmemorykiller/lowmemory_kill"
  ftrace_events: "oom/oom_score_adj_update"
  ftrace_events: "sched/sched_process_exit"
  ftrace_events: "task/task_newtask"
  atrace_categories: "am" atrace_categories: "dalvik" } } }`);
  }
  ds.push(`data_sources: { config { name: "linux.process_stats" target_buffer: 1 process_stats_config {
  scan_all_processes_on_start: true${preset === "memory" ? " proc_stats_poll_ms: 1000" : ""} } } }`);
  if (preset === "memory" || preset === "cpu") {
    ds.push(`data_sources: { config { name: "linux.sys_stats" target_buffer: 1 sys_stats_config {
  meminfo_period_ms: 1000 vmstat_period_ms: 1000${preset === "cpu" ? " stat_period_ms: 1000 stat_counters: STAT_CPU_TIMES" : ""} } } }`);
  }
  if (preset === "cpu") {
    ds.push(`data_sources: { config { name: "android.power" target_buffer: 1 android_power_config {
  battery_poll_ms: 1000 collect_power_rails: true
  battery_counters: BATTERY_COUNTER_CAPACITY_PERCENT battery_counters: BATTERY_COUNTER_CHARGE battery_counters: BATTERY_COUNTER_CURRENT } } }`);
  }
  if (logcat) ds.push('data_sources: { config { name: "android.log" target_buffer: 1 android_log_config { log_ids: LID_DEFAULT log_ids: LID_SYSTEM log_ids: LID_CRASH } } }');
  return `buffers: { size_kb: 65536 fill_policy: RING_BUFFER }
buffers: { size_kb: 8192 fill_policy: RING_BUFFER }
${ds.join("\n")}
duration_ms: ${Math.round(seconds * 1000)}
write_into_file: true
file_write_period_ms: 2500
flush_period_ms: 10000
`;
}

export function mount(root, ctx) {
  const { el, sh, shQuote, toast, showError, clearError, store } = ctx;
  const viewer = globalThis.droidDesk?.trace || null;
  const recordings = []; // { name, blob, kind, at, info }
  const stamp = () => {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };
  const sdk = async () => Number((await sh("getprop ro.build.version.sdk")).trim()) || 0;
  const checkPkg = (p) => { if (!PKG_RE.test(p)) throw new Error("Pick an app first."); return p; };

  async function pull(path) {
    const st = await ctx.withSync((s) => s.stat(path)).catch(() => null);
    if (!st || !Number(st.size)) throw new Error("The phone didn't write the file.");
    return await ctx.withSync(async (s) => ctx.readAll(s.read(path)));
  }

  // ---------- system trace ----------
  let preset = store.get("trace.preset", "ui"), seconds = store.get("trace.seconds", 10), withLog = store.get("trace.logcat", true);
  const presetSeg = el("div", { className: "seg" });
  const presetNote = el("p", { className: "dev-note" });
  for (const p of PRESETS) {
    const b = el("button", { type: "button", textContent: p.label });
    b.dataset.v = p.id;
    b.onclick = () => { preset = p.id; store.set("trace.preset", preset); markSegs(); };
    presetSeg.append(b);
  }
  const durSeg = el("div", { className: "seg" });
  for (const [v, label] of DURATIONS) {
    const b = el("button", { type: "button", textContent: label });
    b.dataset.v = v;
    b.onclick = () => { seconds = v; store.set("trace.seconds", v); markSegs(); };
    durSeg.append(b);
  }
  const logSw = ctx.makeSwitch(withLog, async (v) => { withLog = v; store.set("trace.logcat", v); return v; });
  function markSegs() {
    for (const b of presetSeg.children) b.classList.toggle("on", b.dataset.v === preset);
    for (const b of durSeg.children) b.classList.toggle("on", Number(b.dataset.v) === seconds);
    presetNote.textContent = PRESETS.find((p) => p.id === preset)?.note || "";
  }
  markSegs();

  const recBtn = el("button", { className: "btn primary", type: "button", textContent: "● Record trace" });
  const stopBtn = el("button", { className: "btn", type: "button", textContent: "Stop now", hidden: true });
  const progress = el("div", { className: "tr-progress", hidden: true }, el("div", { className: "bar" }, el("i", {})), el("span", { className: "dev-lbl" }));
  let rec = null; // { proc, timer, stopped }

  async function launcherOf(pkg) {
    const out = await sh(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shQuote(pkg)}`);
    const last = out.trim().split("\n").pop().trim();
    return /\//.test(last) ? last : "";
  }

  async function recordTrace() {
    clearError();
    const v = await sdk();
    if (v && v < 28) throw new Error("System traces need Android 9 or later.");
    if (v === 28 || v === 29) await sh("setprop persist.traced.enable 1");
    const pkg = ctx.app.get();
    if (preset === "startup") checkPkg(pkg);
    const out = `${OUT_DIR}/dd-${stamp()}.perfetto-trace`;
    const cfg = traceConfig({ preset, seconds, pkg, logcat: withLog });
    const b64 = btoa(unescape(encodeURIComponent(cfg)));
    await sh(`echo ${b64} | base64 -d > ${CFG}`);
    const proc = await ctx.spawn(`cat ${CFG} | perfetto --txt -c - -o ${out} 2>&1; echo DD_EXIT=$?`);
    const started = Date.now();
    rec = { proc, stopped: false };
    recBtn.hidden = true; stopBtn.hidden = false; progress.hidden = false;
    const bar = progress.querySelector("i"), lbl = progress.querySelector("span");
    rec.timer = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      bar.style.width = Math.min(100, (s / seconds) * 100) + "%";
      lbl.textContent = rec.stopped ? "Saving…" : `Recording ${Math.min(seconds, Math.floor(s))} of ${seconds} s…`;
    }, 250);
    const lines = [];
    const reading = ctx.readLines(proc, (l) => lines.push(l));
    if (preset === "startup") {
      setTimeout(async () => {
        try {
          const act = await launcherOf(pkg);
          await sh(`am force-stop ${shQuote(pkg)}; ${act ? `am start -W -n ${shQuote(act)}` : `monkey -p ${shQuote(pkg)} -c android.intent.category.LAUNCHER 1`} >/dev/null 2>&1`);
        } catch {}
      }, 1500);
    }
    try {
      await reading;
      const code = Number((lines.find((l) => l.startsWith("DD_EXIT=")) || "DD_EXIT=0").slice(8));
      const err = lines.filter((l) => /error|failed|cannot|could not/i.test(l)).join("\n");
      if (code !== 0 && !rec.stopped) throw new Error(`Perfetto stopped with an error.${err ? " " + err.replace(/\[[\d.]+\]\s*\S+:\d+\s*/g, "") : ""}`);
      const bytes = await pull(out);
      const name = `trace-${preset}-${(pkg || "phone").replace(/[^\w.-]/g, "_")}-${stamp()}.perfetto-trace`;
      add({ name, blob: new Blob([bytes]), kind: "perfetto", info: `${PRESETS.find((p) => p.id === preset).label} · ${Math.round((Date.now() - started) / 1000)} s${pkg ? ` · ${pkg}` : ""}` });
      toast("Trace recorded");
    } finally {
      clearInterval(rec.timer); rec = null;
      sh(`rm -f ${out} ${CFG}`).catch(() => {});
      recBtn.hidden = false; stopBtn.hidden = true; progress.hidden = true;
    }
  }
  recBtn.onclick = () => recordTrace().catch((e) => showError(e));
  stopBtn.onclick = async () => {
    if (!rec) return;
    rec.stopped = true;
    // Perfetto ends the trace and writes everything it has on SIGTERM.
    await sh("pkill -TERM -x perfetto").catch(() => {});
  };

  root.append(ctx.card("System trace", null,
    ctx.app.picker({ label: "App" }),
    el("div", { className: "dev-row" }, el("span", { className: "dev-lbl tr-w", textContent: "What to record" }), presetSeg), presetNote,
    el("div", { className: "dev-row", style: "margin-top:10px" }, el("span", { className: "dev-lbl tr-w", textContent: "How long" }), durSeg),
    el("div", { className: "ctl", style: "margin:10px 0 14px" }, el("div", {}, el("div", { textContent: "Include the log (logcat)" }),
      el("div", { className: "sub", textContent: "Log lines appear on the same timeline" })), logSw),
    el("div", { className: "dev-row" }, recBtn, stopBtn), progress,
    el("p", { className: "dev-note", textContent: "Use the app on the phone while it records. Open the result in Perfetto to see each thread, frame and trace section on a timeline. Add your own sections in code with android.os.Trace.beginSection() / endSection()." })));

  // ---------- method trace ----------
  const METHOD_PATH = "/data/local/tmp/dd-method.trace";
  let methodOn = null; // pkg being profiled
  let sampling = store.get("trace.sampling", true);
  const modeSeg = el("div", { className: "seg" });
  for (const [v, label] of [[true, "Sampled (fast)"], [false, "Every method call (slow)"]]) {
    const b = el("button", { type: "button", textContent: label });
    b.onclick = () => { sampling = v; store.set("trace.sampling", v); for (const x of modeSeg.children) x.classList.toggle("on", x === b); };
    if (v === sampling) b.classList.add("on");
    modeSeg.append(b);
  }
  const mStart = el("button", { className: "btn primary sm", type: "button", textContent: "Start method trace" });
  const mStop = el("button", { className: "btn sm", type: "button", textContent: "Stop & save", hidden: true });
  const mState = el("span", { className: "dev-lbl" });
  mStart.onclick = async () => {
    clearError();
    try {
      const pkg = checkPkg(ctx.app.get());
      const pid = (await sh(`pidof ${shQuote(pkg)}`)).trim();
      if (!pid) throw new Error("Start the app first: method tracing attaches to the running app.");
      const out = (await sh(`rm -f ${METHOD_PATH}; am profile start ${sampling ? "--sampling 1000 " : ""}${shQuote(pkg)} ${METHOD_PATH} 2>&1`)).trim();
      if (/exception|error|not debuggable/i.test(out)) throw new Error(/debuggable|SecurityException/i.test(out) ? "Only debuggable apps (debug builds) can be method-traced." : out.split("\n")[0]);
      methodOn = pkg; mStart.hidden = true; mStop.hidden = false; mState.textContent = `Tracing ${pkg}… use the app, then stop.`;
    } catch (e) { showError(e); }
  };
  async function stopMethod(save = true) {
    const pkg = methodOn; if (!pkg) return;
    methodOn = null; mStart.hidden = false; mStop.hidden = true; mState.textContent = save ? "Saving…" : "";
    try {
      await sh(`am profile stop ${shQuote(pkg)}`);
      if (!save) return;
      await new Promise((r) => setTimeout(r, 1500));
      const bytes = await pull(METHOD_PATH);
      add({ name: `method-${pkg}-${stamp()}.trace`, blob: new Blob([bytes]), kind: "method", info: `Method trace · ${pkg}` });
      mState.textContent = "";
      toast("Method trace ready below: click Save to keep it");
    } catch (e) { mState.textContent = ""; showError(e); }
    finally { sh(`rm -f ${METHOD_PATH}`).catch(() => {}); }
  }
  mStop.onclick = () => stopMethod(true);

  // ---------- heap dump ----------
  const hBtn = el("button", { className: "btn sm", type: "button", textContent: "Take heap dump" });
  hBtn.onclick = async () => {
    clearError();
    const path = "/data/local/tmp/dd-heap.hprof";
    ctx.busy(hBtn, true, "Dumping…");
    try {
      const pkg = checkPkg(ctx.app.get());
      if (!(await sh(`pidof ${shQuote(pkg)}`)).trim()) throw new Error("Start the app first.");
      const out = (await sh(`rm -f ${path}; am dumpheap ${shQuote(pkg)} ${path} 2>&1`)).trim();
      if (/exception|error/i.test(out)) throw new Error(/SecurityException|debuggable/i.test(out) ? "Only debuggable apps (debug builds) can be heap-dumped." : out.split("\n").pop());
      const bytes = await pull(path);
      add({ name: `heap-${pkg}-${stamp()}.hprof`, blob: new Blob([bytes]), kind: "hprof", info: `Java heap dump · ${pkg}` });
      toast("Heap dump ready below: click Save to keep it");
    } catch (e) { showError(e); }
    finally { ctx.busy(hBtn, false); sh(`rm -f ${path}`).catch(() => {}); }
  };

  root.append(ctx.card("Method trace & heap dump", null,
    el("p", { className: "muted tr-intro", textContent: "For debug builds of your app (android:debuggable). Uses the app chosen above." }),
    el("div", { className: "dev-row" }, modeSeg),
    el("div", { className: "dev-row" }, mStart, mStop, mState),
    el("div", { className: "dev-row", style: "margin-top:10px" }, hBtn,
      el("span", { className: "dev-lbl", textContent: "Every object in the app's memory, to find leaks. Open the .hprof in Android Studio (File › Open), or convert it with hprof-conv for Eclipse MAT." })),
    el("p", { className: "dev-note", textContent: "Open method traces (.trace) in Android Studio (File › Open) to see which methods took the time." })));

  // ---------- recordings ----------
  const list = el("div", { className: "tr-list" });
  const listCard = ctx.card("Recorded", null, list);
  root.append(listCard);
  function add(r) { recordings.unshift({ ...r, at: new Date() }); renderList(); }
  function renderList() {
    if (!recordings.length) {
      list.replaceChildren(el("div", { className: "empty", textContent: "Traces you record appear here until you close Droid Desk. Save the ones you want to keep." }));
      return;
    }
    list.replaceChildren(...recordings.map((r, i) => {
      const save = el("button", { className: "btn sm", type: "button", textContent: "Save" });
      save.onclick = () => ctx.download(r.blob, r.name);
      const acts = el("div", { className: "tr-acts" });
      if (r.kind === "perfetto") {
        const open = el("button", { className: "btn sm primary", type: "button", textContent: "Open in Perfetto" });
        open.onclick = async () => {
          if (!viewer) { showError("Opening Perfetto needs the Droid Desk desktop app. Save the trace and open it at ui.perfetto.dev."); return; }
          ctx.busy(open, true, "Opening…");
          try { await viewer.openPerfetto(new Uint8Array(await r.blob.arrayBuffer()), r.name); toast("Opened in your browser"); }
          catch (e) { showError(e); } finally { ctx.busy(open, false); }
        };
        acts.append(open);
      }
      const del = el("button", { className: "btn sm", type: "button", textContent: "Remove" });
      del.onclick = () => { recordings.splice(i, 1); renderList(); };
      acts.append(save, del);
      return el("div", { className: "tr-item" },
        el("div", { className: "tr-txt" }, el("div", { className: "tr-name", textContent: r.name }),
          el("div", { className: "sub", textContent: `${r.info} · ${ctx.fmtSize(r.blob.size)} · ${r.at.toLocaleTimeString()}` })),
        acts);
    }));
  }
  renderList();
  root.append(el("p", { className: "dev-note tr-foot", textContent: "“Open in Perfetto” opens ui.perfetto.dev in your browser and hands it the trace from this computer (127.0.0.1:9001), the same way Android's record_android_trace script does. The page reads the file in the browser; it isn't uploaded." }));

  const stopAll = async () => {
    if (rec) { rec.stopped = true; await sh("pkill -TERM -x perfetto").catch(() => {}); }
    if (methodOn) await stopMethod(false);
  };
  return {
    beforeDisconnect: stopAll,
    disconnected: () => { methodOn = null; mStart.hidden = false; mStop.hidden = true; mState.textContent = ""; },
  };
}
