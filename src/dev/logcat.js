// Developer tab › Logcat: the phone's live log, filtered by level, app and text, with crashes
// picked out so their stack traces can be copied in one click.
//
// The log streams from `logcat -v threadtime` while this sub-tab is open. Lines are kept in a ring
// buffer (MAX_LINES); only the newest DOM_ROWS matching lines are in the page at once.
// Every string from the phone is untrusted: rows are built with textContent only.

const MAX_LINES = 20_000;
const DOM_ROWS = 3000;
const LEVELS = ["V", "D", "I", "W", "E"];
const RANK = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5 };
const LINE_RE = /^(\d\d-\d\d) (\d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+) ([VDIWEFA]) (.*?)\s*: ?(.*)$/;
const BASE_CMD = "logcat -v threadtime";

const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function mount(root, ctx) {
  const { el, sh, store } = ctx;

  // ---------- state ----------
  let buf = [];            // { n, date, time, pid, tid, lvl, tag, msg, raw, crash }
  let seq = 0;
  let crashes = [];        // { id, kind, pid, pkg, date, time, first, lines[], entry }
  const openJava = new Map(); // pid -> crash being collected
  let openNative = null;
  let proc = null, gen = 0, running = false;
  let paused = false, auto = true;
  let minLevel = store.get("logcat.level", "V");
  let onlyApp = store.get("logcat.onlyApp", false);
  let query = "";
  let pidSet = new Set();  // every pid seen for the selected app this session
  let pidTimer = null;
  let pending = [], rebuildNeeded = false, frame = 0;
  let resumeFrom = null;   // { key, raws:Set } to skip lines already buffered when restarting

  // ---------- UI ----------
  const levelSeg = el("div", { className: "seg" });
  for (const l of LEVELS) {
    const b = el("button", { type: "button", textContent: l, title: { V: "Verbose and up", D: "Debug and up", I: "Info and up", W: "Warnings and errors", E: "Errors only" }[l] });
    b.dataset.lvl = l;
    b.onclick = () => { minLevel = l; store.set("logcat.level", l); syncLevel(); rebuild(); };
    levelSeg.append(b);
  }
  const syncLevel = () => { for (const b of levelSeg.children) b.classList.toggle("on", b.dataset.lvl === minLevel); };
  syncLevel();

  const search = el("input", { type: "search", placeholder: "Search…  (tag:MyTag to filter by tag)", spellcheck: false });
  let searchTimer = 0;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { query = search.value.trim(); rebuild(); }, 150); });

  const pauseBtn = el("button", { className: "btn sm", type: "button", textContent: "Pause" });
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (!paused) rebuild();
    updateStatus();
  };
  const clearBtn = el("button", { className: "btn sm", type: "button", textContent: "Clear", title: "Clear the log here and on the phone" });
  clearBtn.onclick = async () => {
    buf = []; crashes = []; openJava.clear(); openNative = null; pending = [];
    view.replaceChildren(); renderCrashes(); updateStatus();
    if (ctx.getAdb()) await sh("logcat -c").catch(() => {});
  };
  const saveBtn = el("button", { className: "btn sm", type: "button", textContent: "Save" , title: "Save the lines that match the filters as a text file" });
  saveBtn.onclick = () => {
    const lines = buf.filter(matches).map((e) => e.raw);
    if (!lines.length) { ctx.toast("Nothing to save"); return; }
    const p = onlyApp && ctx.app.get() ? ctx.app.get() : "all";
    ctx.download(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }), `logcat-${p}-${stamp()}.txt`);
  };

  const autoSw = ctx.makeSwitch(auto, async (want) => { auto = want; if (want) scrollEnd(); return want; });
  const wrapSw = ctx.makeSwitch(store.get("logcat.wrap", false), async (want) => {
    store.set("logcat.wrap", want); view.classList.toggle("wrap", want); return want;
  });
  const appSw = ctx.makeSwitch(onlyApp, async (want) => {
    if (want && !ctx.app.get()) { ctx.toast("Pick an app first"); return false; }
    onlyApp = want; store.set("logcat.onlyApp", want);
    if (want) await refreshPids();
    schedulePids(); rebuild();
    return want;
  });
  const labeled = (text, sw) => el("label", { className: "lc-sw" }, sw, el("span", { textContent: text }));

  const crashBtn = el("button", { className: "btn sm lc-crashbtn", type: "button", hidden: true });
  crashBtn.onclick = () => { crashPanel.hidden = !crashPanel.hidden; renderCrashes(); };
  const status = el("span", { className: "lc-status muted" });

  const picker = ctx.app.picker({ label: "App" });
  picker.append(labeled("Only this app", appSw));
  ctx.app.onChange(async () => {
    pidSet = new Set();
    if (onlyApp) { if (!ctx.app.get()) { onlyApp = false; appSw.set(false); } else await refreshPids(); }
    rebuild();
  });

  const crashPanel = el("div", { className: "lc-crashes", hidden: true });
  const view = el("div", { className: "lc-view", tabIndex: 0 });
  view.classList.toggle("wrap", store.get("logcat.wrap", false));
  // Scrolling up turns auto-scroll off; scrolling back to the end turns it on again.
  let lastTop = 0, progTop = -1;
  view.addEventListener("scroll", () => {
    const top = view.scrollTop, atEnd = view.scrollHeight - top - view.clientHeight < 24;
    const ours = Math.abs(top - progTop) < 2;
    if (auto && !atEnd && !ours && top < lastTop - 2) { auto = false; autoSw.set(false); }
    else if (!auto && atEnd && !ours) { auto = true; autoSw.set(true); }
    lastTop = top;
  });

  root.append(ctx.card("Logcat", el("div", {}, crashBtn, status),
    picker,
    el("div", { className: "toolbar lc-bar" }, levelSeg, search, pauseBtn, clearBtn, saveBtn,
      labeled("Auto-scroll", autoSw), labeled("Wrap", wrapSw)),
    crashPanel, view));

  // ---------- filtering ----------
  function parseQuery() {
    const tags = [], words = [];
    for (const t of query.split(/\s+/).filter(Boolean)) {
      if (/^tag:/i.test(t) && t.length > 4) tags.push(t.slice(4).toLowerCase());
      else words.push(t);
    }
    return { tags, text: words.join(" ").toLowerCase() };
  }
  let q = parseQuery(), qFor = query;
  function matches(e) {
    if (RANK[e.lvl] < RANK[minLevel]) return false;
    if (onlyApp) {
      const p = ctx.app.get();
      if (!pidSet.has(e.pid) && !(e.crash && e.crash.pkg === p) && !(e.tag === "AndroidRuntime" && p && e.msg.includes(p))) return false;
    }
    if (qFor !== query) { q = parseQuery(); qFor = query; }
    if (q.tags.length && !q.tags.some((t) => e.tag.toLowerCase().includes(t))) return false;
    if (q.text && !e.raw.toLowerCase().includes(q.text)) return false;
    return true;
  }

  async function refreshPids() {
    const p = ctx.app.get();
    if (!p || !ctx.getAdb()) return;
    const out = await sh(`pidof ${ctx.shQuote(p)}`).catch(() => "");
    const before = pidSet.size;
    for (const id of out.trim().split(/\s+/).filter((x) => /^\d+$/.test(x))) pidSet.add(id);
    // New pids found: earlier lines from the new process are already buffered, so redraw.
    if (pidSet.size !== before && onlyApp && !paused) rebuild();
  }
  function schedulePids() {
    clearInterval(pidTimer); pidTimer = null;
    if (running && onlyApp && ctx.app.get()) pidTimer = setInterval(() => refreshPids(), 3000);
  }

  // ---------- rows ----------
  function row(e) {
    const r = el("div", { className: `lc-row l-${e.lvl}` + (e.crash ? " crash" : "") });
    r.dataset.n = e.n;
    if (e.date === undefined) { r.append(el("span", { className: "lc-m", textContent: e.raw })); return r; }
    r.title = `${e.date} ${e.time}  pid ${e.pid}  tid ${e.tid}`;
    r.append(
      el("span", { className: "lc-t", textContent: e.time }),
      el("span", { className: "lc-p", textContent: e.pid }),
      el("span", { className: "lc-l", textContent: e.lvl }),
      el("span", { className: "lc-g", textContent: e.tag }),
      el("span", { className: "lc-m", textContent: e.msg }),
    );
    return r;
  }
  function scrollEnd() { view.scrollTop = view.scrollHeight; progTop = view.scrollTop; lastTop = progTop; }

  function rebuild() {
    rebuildNeeded = true; pending = [];
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function flush() {
    frame = 0;
    if (rebuildNeeded) {
      rebuildNeeded = false;
      const out = [];
      for (let i = buf.length - 1; i >= 0 && out.length < DOM_ROWS; i--) if (matches(buf[i])) out.push(buf[i]);
      const frag = document.createDocumentFragment();
      for (let i = out.length - 1; i >= 0; i--) frag.append(row(out[i]));
      view.replaceChildren(frag);
      if (!out.length) view.append(el("div", { className: "empty", textContent: buf.length ? "No lines match the filters." : running ? "Waiting for log lines…" : "The log appears here while this tab is open." }));
      if (auto) scrollEnd();
      updateStatus();
      return;
    }
    if (!pending.length) return;
    const items = pending.length > DOM_ROWS ? pending.slice(-DOM_ROWS) : pending;
    pending = [];
    if (view.firstChild?.classList?.contains("empty")) view.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const e of items) frag.append(row(e));
    view.append(frag);
    let extra = view.childElementCount - DOM_ROWS;
    if (extra > 0) {
      const h = view.scrollHeight;
      while (extra-- > 0) view.firstChild.remove();
      if (!auto) { view.scrollTop -= h - view.scrollHeight; progTop = lastTop = view.scrollTop; }
    }
    if (auto) scrollEnd();
    updateStatus();
  }

  function updateStatus() {
    const state = !ctx.getAdb() ? "Not connected" : paused ? "Paused" : running ? "Live" : "Stopped";
    status.textContent = `${state} · ${buf.length.toLocaleString()} lines`;
    status.classList.toggle("live", running && !paused);
  }

  // ---------- crashes ----------
  function newCrash(kind, e, pkg) {
    const c = { id: crashes.length + 1, kind, pid: e.pid, pkg: pkg || "", date: e.date, time: e.time, first: "", lines: [], entry: e, at: Date.now() };
    crashes.push(c);
    return c;
  }
  function trackCrash(e) {
    if (e.date === undefined) return;
    // Java: "FATAL EXCEPTION: main", "Process: com.x, PID: 123", then the exception and stack.
    if (e.tag === "AndroidRuntime") {
      let c = openJava.get(e.pid);
      if (/^FATAL EXCEPTION/.test(e.msg)) { c = newCrash("Java crash", e); openJava.set(e.pid, c); }
      if (!c || e.lvl !== "E") return;
      const m = e.msg.match(/^Process: ([^,\s]+), PID: (\d+)/);
      if (m) c.pkg = m[1];
      else if (!c.first && c.lines.length && !/^FATAL EXCEPTION/.test(e.msg)) c.first = e.msg.trim();
      c.lines.push(e.raw); e.crash = c;
      crashChanged();
      return;
    }
    if (openJava.has(e.pid) && e.tag !== "AndroidRuntime") openJava.delete(e.pid);
    // Native: libc "Fatal signal 11 (SIGSEGV) ... pid 123 (com.x)", then crash_dump's DEBUG lines.
    if (e.tag === "libc" && /^Fatal signal/.test(e.msg)) {
      const m = e.msg.match(/pid (\d+) \(([^)]*)\)\s*$/);
      openNative = newCrash("Native crash", e, m ? m[2] : "");
      openNative.first = e.msg.trim(); openNative.lines.push(e.raw); e.crash = openNative;
      crashChanged();
      return;
    }
    if (e.tag === "DEBUG" && (e.lvl === "F" || e.lvl === "E" || e.lvl === "A")) {
      if (!openNative || Date.now() - openNative.at > 15_000) {
        if (!/\*\*\* \*\*\*|Build fingerprint|pid: \d+/.test(e.msg)) return;
        openNative = newCrash("Native crash", e);
      }
      const m = e.msg.match(/>>> (\S+) <<</);
      if (m && !openNative.pkg) openNative.pkg = m[1];
      if (!openNative.first && /^signal \d+/.test(e.msg.trim())) openNative.first = e.msg.trim();
      openNative.lines.push(e.raw); e.crash = openNative;
      crashChanged();
    }
  }
  let crashTimer = 0;
  function crashChanged() {
    if (crashTimer) return;
    crashTimer = setTimeout(() => { crashTimer = 0; renderCrashes(); }, 200);
  }
  function renderCrashes() {
    crashBtn.hidden = !crashes.length;
    crashBtn.textContent = `Crashes (${crashes.length})`;
    if (crashPanel.hidden) return;
    const list = crashes.slice().reverse().map((c) => {
      const copy = el("button", { className: "btn sm", type: "button", textContent: "Copy stack trace" });
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(c.lines.join("\n") + "\n"); ctx.toast("Stack trace copied"); }
        catch (e) { ctx.showError(e); }
      };
      const goto = el("button", { className: "btn sm", type: "button", textContent: "Show in log" });
      goto.onclick = () => showEntry(c.entry);
      return el("div", { className: "lc-crash" },
        el("div", { className: "lc-crash-main" },
          el("div", {}, el("b", { textContent: c.pkg || `pid ${c.pid}` }), el("span", { className: "muted", textContent: ` · ${c.kind} · ${c.date} ${c.time}` })),
          el("div", { className: "mono lc-crash-first", textContent: c.first || c.lines[0] || "" })),
        el("div", { className: "lc-crash-btns" }, copy, goto));
    });
    const close = el("button", { className: "btn sm", type: "button", textContent: "Hide" });
    close.onclick = () => { crashPanel.hidden = true; };
    crashPanel.replaceChildren(el("div", { className: "dev-head" }, el("b", { textContent: "Crashes this session" }), close), ...list);
  }
  function showEntry(e) {
    const idx = buf.indexOf(e);
    if (idx < 0) { ctx.toast("That part of the log is no longer kept"); return; }
    if (!matches(e)) {
      minLevel = "V"; syncLevel(); query = ""; search.value = "";
      if (onlyApp) { onlyApp = false; appSw.set(false); store.set("logcat.onlyApp", false); }
    }
    auto = false; autoSw.set(false);
    if (paused === false) { paused = true; pauseBtn.textContent = "Resume"; }
    // Draw the lines around the crash, then scroll to it.
    const out = [];
    for (let i = idx; i >= 0 && out.length < DOM_ROWS / 2; i--) if (matches(buf[i])) out.unshift(buf[i]);
    for (let i = idx + 1; i < buf.length && out.length < DOM_ROWS; i++) if (matches(buf[i])) out.push(buf[i]);
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    rebuildNeeded = false; pending = [];
    const frag = document.createDocumentFragment();
    for (const x of out) frag.append(row(x));
    view.replaceChildren(frag);
    const target = view.querySelector(`[data-n="${e.n}"]`);
    if (target) {
      view.scrollTop = target.offsetTop - view.offsetTop - 60;
      progTop = lastTop = view.scrollTop;
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 2400);
    }
    updateStatus();
  }

  // ---------- stream ----------
  function onLine(line) {
    if (!line || line.startsWith("--------- ")) return;
    const m = LINE_RE.exec(line);
    let e;
    if (m) e = { n: ++seq, date: m[1], time: m[2], pid: m[3], tid: m[4], lvl: m[5], tag: m[6], msg: m[7], raw: line, crash: null };
    else {
      const prev = buf[buf.length - 1];
      e = { n: ++seq, date: undefined, lvl: prev?.lvl || "I", tag: prev?.tag || "", pid: prev?.pid || "", msg: line, raw: line, crash: null };
    }
    // After a restart the log is replayed from the last line we had: skip what's already here.
    if (resumeFrom && e.date !== undefined) {
      const key = `${e.date} ${e.time}`;
      if (key < resumeFrom.key || (key === resumeFrom.key && resumeFrom.raws.has(line))) return;
      resumeFrom = null;
    }
    trackCrash(e);
    if (e.tag === "AndroidRuntime" && onlyApp) {
      const pm = e.msg.match(/^Process: ([^,\s]+), PID: (\d+)/);
      if (pm && pm[1] === ctx.app.get()) pidSet.add(pm[2]);
    }
    buf.push(e);
    if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES + 2000);
    if (paused || rebuildNeeded) return;
    if (matches(e)) {
      pending.push(e);
      if (pending.length > DOM_ROWS * 2) pending = pending.slice(-DOM_ROWS);
      if (!frame) frame = requestAnimationFrame(flush);
    } else if (!frame) frame = requestAnimationFrame(updateStatusFrame);
  }
  const updateStatusFrame = () => { frame = 0; updateStatus(); };

  async function start() {
    if (running || !ctx.getAdb()) return;
    const my = ++gen;
    running = true;
    let since = "-T 500";
    const last = [...buf].reverse().find((e) => e.date !== undefined);
    if (last) {
      const key = `${last.date} ${last.time}`;
      resumeFrom = { key, raws: new Set(buf.filter((e) => e.date === last.date && e.time === last.time).map((e) => e.raw)) };
      since = `-T ${ctx.shQuote(key)}`;
    }
    // Older phones lack the crash buffer or -T; fall back step by step.
    const cmd = `${BASE_CMD} -b main,system,crash ${since} 2>/dev/null || ${BASE_CMD} ${since} 2>/dev/null || ${BASE_CMD}`;
    try {
      const p = await ctx.spawn(cmd);
      if (my !== gen) { try { await p.kill(); } catch {} return; }
      proc = p;
      schedulePids();
      if (onlyApp) refreshPids();
      updateStatus();
      if (!buf.length) rebuild();
      await ctx.readLines(p, (l) => { if (my === gen) onLine(l); });
    } catch (e) {
      if (my === gen) ctx.showError(e);
    } finally {
      if (my === gen) { running = false; proc = null; clearInterval(pidTimer); pidTimer = null; resumeFrom = null; updateStatus(); }
    }
  }
  function stop() {
    gen++;
    running = false;
    clearInterval(pidTimer); pidTimer = null;
    const p = proc; proc = null;
    if (p) Promise.resolve().then(() => p.kill()).catch(() => {});
    updateStatus();
  }

  rebuild();
  return {
    show() { start(); },
    hide() { stop(); },
    connected() {
      // A new connection may be another phone: start over.
      stop();
      buf = []; crashes = []; openJava.clear(); openNative = null; pidSet = new Set(); pending = [];
      renderCrashes(); rebuild();
      if (ctx.isShown("logcat")) start();
    },
    beforeDisconnect() { stop(); },
    disconnected() { stop(); },
  };
}
