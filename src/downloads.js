// Download manager: one list of everything Andromon downloads to this computer (ReVanced's tools,
// F-Droid's catalogue and apps, the debloat list), with progress, speed, cancel and a short history.
// The downloads themselves run in the main process (revanced.js, fdroid.js), which announce
// { kind: "download", phase: "start" | "end" } and { kind: "progress", done, total } on their event
// channels; this file only listens. The Downloads button at the top of every page opens the list.

const HISTORY_KEY = "andromon.downloads", HISTORY_MAX = 30;

export function initDownloads({ $, el, fmtSize, fmtDate, show }) {
  const api = globalThis.andromon || {};
  let items = []; // newest first: { id, src, title, from, done, total, speed, state, at, error, cancel }
  let seq = 0;
  const live = new Map(); // "<src>:<title>" -> the running item
  const listeners = new Set();
  try { items = (JSON.parse(localStorage.getItem(HISTORY_KEY)) || []).filter((i) => i && i.title).map((i) => ({ ...i, id: ++seq })); } catch {}

  const persist = () => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.filter((i) => i.state !== "active").slice(0, HISTORY_MAX).map(({ src, title, from, done, total, state, at, error }) => ({ src, title, from, done, total, state, at, error })))); } catch {}
  };
  let queued = false;
  const changed = () => {
    if (queued) return; queued = true;
    requestAnimationFrame(() => { queued = false; render(); for (const cb of listeners) { try { cb(); } catch (e) { console.warn(e); } } });
  };

  function begin(src, title, from, total, cancel) {
    const key = `${src}:${title}`;
    if (live.has(key)) finish(key, { ok: false, error: "Interrupted" });
    const it = { id: ++seq, src, title, from: from || "", done: 0, total: Number(total) || 0, speed: 0, state: "active", at: Date.now(), error: "", cancel, mark: { t: performance.now(), done: 0 } };
    live.set(key, it); items.unshift(it); changed();
    return it;
  }
  function progress(src, title, done, total, from, cancel) {
    const it = live.get(`${src}:${title}`) || begin(src, title, from, total, cancel);
    it.done = Number(done) || 0; if (Number(total) > 0) it.total = Number(total);
    const now = performance.now(), dt = now - it.mark.t;
    if (dt >= 700) { // bytes a second, smoothed so the number doesn't jump about
      const cur = ((it.done - it.mark.done) / dt) * 1000;
      it.speed = it.speed ? it.speed * 0.6 + cur * 0.4 : cur;
      it.mark = { t: now, done: it.done };
    }
    changed();
  }
  function finish(key, { ok, cancelled, error }) {
    const it = live.get(key); if (!it) return;
    live.delete(key);
    it.state = ok ? "done" : cancelled ? "cancelled" : "failed";
    it.error = ok || cancelled ? "" : String(error || "").slice(0, 200);
    it.at = Date.now(); it.speed = 0; it.cancel = null;
    if (ok && !it.total) it.total = it.done;
    persist(); changed();
  }
  const listen = (src, source, cancel, fallbackFrom) => source?.onEvent((ev) => {
    if (!ev || !ev.what) return;
    if (ev.kind === "download" && ev.phase === "start") begin(src, ev.what, ev.from || fallbackFrom, ev.total, cancel);
    else if (ev.kind === "download" && ev.phase === "end") finish(`${src}:${ev.what}`, ev);
    else if (ev.kind === "progress") progress(src, ev.what, ev.done, ev.total, fallbackFrom, cancel);
  });
  listen("rv", api.revanced, () => api.revanced.cancel(), "revanced.app");
  listen("fd", api.fdroid, () => api.fdroid.cancel(), "f-droid.org");
  listen("up", api.updates, () => api.updates.cancel(), "github.com"); // a new version of Andromon itself

  /** A download made by the page itself: fn(report) where report(done, total) moves the bar. */
  async function track(src, title, from, fn) {
    const ac = new AbortController();
    begin(src, title, from, 0, () => ac.abort());
    const key = `${src}:${title}`;
    try {
      const r = await fn((done, total) => progress(src, title, done, total), ac.signal);
      finish(key, { ok: true });
      return r;
    } catch (e) {
      finish(key, { ok: false, cancelled: ac.signal.aborted, error: e?.message || e });
      throw ac.signal.aborted ? new Error("The download was cancelled.") : e;
    }
  }

  // ---------- what a row says ----------
  const pct = (it) => (it.total > 0 ? Math.min(100, Math.floor((it.done / it.total) * 100)) : null);
  const left = (it) => {
    if (!it.speed || !it.total || it.done >= it.total) return "";
    const s = Math.ceil((it.total - it.done) / it.speed);
    return s < 60 ? `${s} s left` : s < 3600 ? `${Math.ceil(s / 60)} min left` : `${Math.ceil(s / 3600)} h left`;
  };
  const detail = (it) => {
    if (it.state === "active") {
      return [it.total ? `${fmtSize(it.done)} of ${fmtSize(it.total)}` : it.done ? fmtSize(it.done) : "Starting…", it.speed ? `${fmtSize(it.speed)}/s` : "", left(it)].filter(Boolean).join(" · ");
    }
    const when = fmtDate(it.at);
    if (it.state === "done") return [fmtSize(it.total || it.done), when].filter(Boolean).join(" · ");
    if (it.state === "cancelled") return `Cancelled · ${when}`;
    return `Failed${it.error ? ": " + it.error : ""}`;
  };
  /** The bar for one running download; `it.total` unknown shows a moving stripe instead. */
  const bar = (it) => {
    const p = pct(it);
    const b = el("div", { className: "bar dl-bar" + (p == null ? " dl-wait" : "") }, el("i", { style: p == null ? "" : `width:${p}%` }));
    b.setAttribute("role", "progressbar"); b.setAttribute("aria-label", it.title);
    if (p != null) { b.setAttribute("aria-valuemin", "0"); b.setAttribute("aria-valuemax", "100"); b.setAttribute("aria-valuenow", String(p)); }
    return b;
  };
  const cancelBtn = (it) => {
    const b = el("button", { className: "btn sm", type: "button", textContent: "Cancel" });
    b.onclick = () => { b.disabled = true; Promise.resolve(it.cancel?.()).catch(() => {}); };
    return b;
  };
  /** A running download as a block for another page (Settings): text, bar and Cancel. */
  const block = (it) => el("div", { className: "dl-inline" },
    el("div", { className: "dl-line" }, el("span", { className: "sub", textContent: [it.title, pct(it) != null ? `${pct(it)}%` : "", detail(it)].filter(Boolean).join(" · ") }), it.cancel ? cancelBtn(it) : ""),
    bar(it));

  // ---------- the header button and its panel ----------
  const btn = $("dlBtn"), badge = $("dlBadge"), panel = $("dlPanel"), list = $("dlList");
  const MARK = { done: "✓", failed: "!", cancelled: "×" };
  function render() {
    const active = items.filter((i) => i.state === "active");
    badge.hidden = !active.length; badge.textContent = String(active.length);
    const known = active.filter((i) => i.total > 0);
    const all = known.length ? Math.floor((known.reduce((n, i) => n + i.done, 0) / known.reduce((n, i) => n + i.total, 0)) * 100) : null;
    btn.title = active.length ? `Downloading ${active.length === 1 ? active[0].title : active.length + " files"}${all != null ? ` · ${all}%` : ""}` : "Downloads";
    btn.classList.toggle("dl-busy", active.length > 0);
    btn.style.setProperty("--dl", `${all ?? 0}%`);
    if (panel.hidden) return;
    $("dlClear").hidden = !items.some((i) => i.state !== "active");
    if (!items.length) { list.replaceChildren(el("div", { className: "empty", textContent: "Nothing has been downloaded yet. Downloads of ReVanced's tools, F-Droid's catalogue and apps, and the debloat list appear here." })); return; }
    list.replaceChildren(...items.map((it) => {
      const on = it.state === "active";
      return el("div", { className: "dl-item dl-" + it.state },
        el("div", { className: "dl-line" },
          on ? "" : el("i", { className: "dl-mark", textContent: MARK[it.state] || "" }),
          el("div", { className: "dl-text" },
            el("b", { textContent: it.title, title: it.title }),
            el("div", { className: "sub", textContent: [on && pct(it) != null ? `${pct(it)}%` : "", detail(it), it.from ? `from ${it.from}` : ""].filter(Boolean).join(" · ") })),
          on && it.cancel ? cancelBtn(it) : ""),
        on ? bar(it) : "");
    }));
  }
  function open(on) {
    panel.hidden = !on; btn.setAttribute("aria-expanded", String(on));
    if (!on) return;
    const r = btn.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 10)}px`;
    panel.style.right = `${Math.max(16, Math.round(innerWidth - r.right))}px`;
    render();
  }
  btn.addEventListener("click", (e) => { e.stopPropagation(); open(panel.hidden); });
  panel.addEventListener("click", (e) => e.stopPropagation());
  addEventListener("click", () => { if (!panel.hidden) open(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { open(false); btn.focus(); } });
  addEventListener("resize", () => { if (!panel.hidden) open(true); });
  $("dlClear").addEventListener("click", () => { items = items.filter((i) => i.state === "active"); persist(); changed(); });
  $("dlManage").addEventListener("click", () => { open(false); show("settings"); });
  render();

  return {
    track, block,
    /** Running downloads from one source ("rv", "fd", "uad"). */
    active: (src) => items.filter((i) => i.state === "active" && i.src === src),
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    open: () => open(true),
  };
}
