// Screenshot page: capture the phone's screen now or after a countdown, then copy, save, rotate or delete
// the picture; the captures of this session stay in a strip below. How a capture is made (format, size,
// clean status bar, copy or save by itself, blur personal data) is set in Settings › Screenshot and kept in
// localStorage. Blurring is done by ./shotblur.js, which the mirror's Save frame / Copy frame use too.
// Full screen (the button, or a click on the picture) shows a capture over the whole computer screen,
// where it can be zoomed to its real size and dragged around, stepped through, copied, saved, turned or deleted.
import { icon } from "./fileicons.js";

const KEY = "andromon.shot";
export const shotPrefs = {
  FORMAT: [["png", "PNG (exact)"], ["jpeg", "JPEG (smaller)"], ["webp", "WebP (smallest)"]],
  SCALE: [["100", "Full size"], ["75", "75%"], ["50", "Half size"]],
  get() {
    let p = {}; try { p = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    const one = (list, v, d) => (list.some(([id]) => id === String(v)) ? String(v) : d);
    return { format: one(this.FORMAT, p.format, "png"), scale: Number(one(this.SCALE, p.scale, "100")), clean: p.clean === true, copy: p.copy === true, save: p.save === true, blur: p.blur === true };
  },
  set(patch) {
    try { localStorage.setItem(KEY, JSON.stringify({ ...this.get(), ...patch })); } catch {}
    this.changed?.();
    globalThis.dispatchEvent?.(new Event("andromon:shotprefs")); // the Blur buttons here, on the mirror and in Settings
  },
  changed: null,
};

const HISTORY_MAX = 12;
// A tidy status bar for the capture: Android's "demo mode" (12:00, full battery and signal, no notification icons).
const DEMO_ON = [
  "settings put global sysui_demo_allowed 1",
  "am broadcast -a com.android.systemui.demo -e command enter",
  "am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1200",
  "am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false",
  "am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4",
  "am broadcast -a com.android.systemui.demo -e command notifications -e visible false",
].join(" >/dev/null 2>&1; ") + " >/dev/null 2>&1";
const DEMO_OFF = "am broadcast -a com.android.systemui.demo -e command exit >/dev/null 2>&1";

export function initScreenshot({ $, el, toast, showError, clearError, sh, shBytes, fmtSize, download, show, getAdb, shotBlur }) {
  const root = $("shotRoot");
  const shots = []; // newest first: { blob, url, w, h, at, name }
  let current = null, busyNow = false, countdown = 0;

  const stamp = (d) => new Date(d).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- page ----------
  const gbtn = (name, title, onClick, cls = "") => {
    const b = el("button", { className: "fx-gb" + (cls ? " " + cls : ""), type: "button", title }, icon(name));
    b.setAttribute("aria-label", title);
    b.onclick = () => Promise.resolve(onClick(b)).catch(showError);
    return b;
  };
  const group = (...buttons) => { const g = el("div", { className: "fx-group" }, ...buttons); g.setAttribute("role", "group"); return g; };
  const capture = el("button", { className: "btn primary sh-main", type: "button" }, icon("camera"), el("span", { textContent: "Take screenshot" }));
  capture.onclick = () => take(0).catch(showError);
  const timers = el("div", { className: "sh-timers" }, el("span", { className: "muted small", textContent: "or in" }),
    ...[3, 5, 10].map((s) => { const b = el("button", { className: "btn sm", type: "button", textContent: `${s} s`, title: `Take it ${s} seconds from now` }); b.onclick = () => take(s).catch(showError); return b; }));
  const acts = group(
    gbtn("maximize", "Full screen (click the picture too)", () => openFull(current)),
    gbtn("copy", "Copy the picture", () => copy(current)),
    gbtn("download", "Save the picture", () => save(current)),
    gbtn("rotate-ccw", "Rotate left", () => rotate(-90)),
    gbtn("rotate-cw", "Rotate right", () => rotate(90)),
    gbtn("trash-2", "Delete this picture", () => remove(current), "danger"));
  const info = el("span", { className: "muted small sh-info" });
  const summary = el("span", { className: "muted small" });
  const settings = el("button", { className: "btn sm", type: "button", textContent: "Change in Settings" });
  // Blur personal data (./shotblur.js), on or off with one click; the same setting as in Settings › Screenshot.
  const blurBtn = el("button", { className: "btn sm sh-blur", type: "button" }, icon("eye-off"), el("span"));
  const renderBlur = () => {
    const on = shotPrefs.get().blur;
    blurBtn.classList.toggle("on", on); blurBtn.setAttribute("aria-pressed", String(on));
    blurBtn.lastChild.textContent = on ? "Blur personal data: on" : "Blur personal data: off";
    blurBtn.title = on ? "Phone numbers, IMEI, messages, names, emails, addresses and Wi‑Fi names are blurred in new screenshots. Click to turn off"
      : "Click to blur phone numbers, IMEI, messages, names, emails, addresses and Wi‑Fi names in new screenshots";
  };
  blurBtn.onclick = () => { shotPrefs.set({ blur: !shotPrefs.get().blur }); toast?.(shotPrefs.get().blur ? "New screenshots will be blurred" : "New screenshots won't be blurred"); };
  addEventListener("andromon:shotprefs", renderBlur);
  renderBlur();
  settings.onclick = () => show("settings");
  const stage = el("div", { className: "sh-stage" });
  const strip = el("div", { className: "sh-strip", hidden: true });
  root.replaceChildren(el("div", { className: "card sh" },
    el("div", { className: "sh-bar" }, capture, timers, el("span", { className: "sp" }), acts),
    el("div", { className: "sh-bar sh-sub" }, info, el("span", { className: "sp" }), summary, blurBtn, settings),
    stage, strip));

  function renderSummary() {
    const p = shotPrefs.get(), label = (list, v) => list.find(([id]) => id === String(v))?.[1] || "";
    summary.textContent = [label(shotPrefs.FORMAT, p.format).replace(/ \(.*/, ""), p.scale === 100 ? "full size" : `${p.scale}%`, p.clean ? "clean status bar" : "", p.blur ? "personal data blurred" : "", p.copy ? "copies itself" : "", p.save ? "saves itself" : ""].filter(Boolean).join(" · ");
  }
  shotPrefs.changed = renderSummary;

  function render() {
    for (const b of acts.querySelectorAll("button")) b.disabled = !current;
    if (countdown) stage.replaceChildren(el("div", { className: "sh-count" }, el("b", { textContent: String(countdown) }), el("div", { className: "muted", textContent: "Get the phone's screen ready…" })));
    else if (current) {
      const img = el("img", { src: current.url, alt: "Phone screenshot", className: "shot sh-open", title: "Click to see it full screen" });
      img.onclick = () => openFull(current);
      stage.replaceChildren(img);
    } else stage.replaceChildren(el("div", { className: "sh-empty" }, icon("image"), el("b", { textContent: "No screenshot yet" }),
      el("div", { className: "muted small", textContent: "Take one now, or use a countdown to open a menu on the phone first." })));
    const blurNote = !current ? "" : current.blurred > 0 ? ` · ${current.blurred} area${current.blurred > 1 ? "s" : ""} blurred` : current.blurred < 0 ? " · not blurred" : "";
    info.textContent = current ? `${current.w}×${current.h} · ${fmtSize(current.blob.size)} · ${new Date(current.at).toLocaleTimeString()}${blurNote}` : "";
    strip.hidden = shots.length < 2;
    strip.replaceChildren(...shots.map((s) => {
      const t = el("button", { className: "sh-thumb" + (s === current ? " on" : ""), type: "button", title: new Date(s.at).toLocaleTimeString() }, el("img", { src: s.thumb || "", alt: "" }));
      t.onclick = () => { current = s; render(); };
      t.ondblclick = () => openFull(s);
      return t;
    }));
  }

  // ---------- capture ----------
  /** PNG bytes from the phone -> a blob in the chosen format and size, plus its pixel size. */
  async function convert(png, { format, scale }, turn = 0) {
    const bmp = await createImageBitmap(png);
    try {
      const k = scale / 100, side = turn % 180 !== 0;
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      if (format === "png" && scale === 100 && !turn) return { blob: png, w, h };
      const c = new OffscreenCanvas(side ? h : w, side ? w : h), g = c.getContext("2d");
      g.translate(c.width / 2, c.height / 2); g.rotate((turn * Math.PI) / 180);
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, -w / 2, -h / 2, w, h);
      return { blob: await c.convertToBlob({ type: `image/${format}`, quality: 0.9 }), w: c.width, h: c.height };
    } finally { bmp.close(); } // the full-size picture, decoded: let it go now rather than at the next clean-up
  }
  // A small picture for the history strip: the full-size ones there would each take ~10 MB once shown.
  async function thumbOf(s) {
    try {
      const bmp = await createImageBitmap(s.blob, { resizeWidth: 160, resizeQuality: "medium" });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext("2d").drawImage(bmp, 0, 0); bmp.close();
      const url = URL.createObjectURL(await c.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
      if (s.thumb) URL.revokeObjectURL(s.thumb);
      if (!shots.includes(s)) { URL.revokeObjectURL(url); return; } // removed meanwhile
      s.thumb = url; render();
    } catch (e) { console.warn("Screenshot thumbnail:", e); }
  }
  const forget = (s) => { URL.revokeObjectURL(s.url); if (s.thumb) URL.revokeObjectURL(s.thumb); s.thumb = ""; };
  const add = (blob, w, h, format) => {
    const s = { blob, w, h, at: Date.now(), url: URL.createObjectURL(blob), name: `screenshot-${stamp(Date.now())}.${format === "jpeg" ? "jpg" : format}`, format };
    shots.unshift(s); current = s;
    for (const old of shots.splice(HISTORY_MAX)) forget(old);
    thumbOf(s);
    return s;
  };

  async function take(delay) {
    if (busyNow || !getAdb()) return;
    busyNow = true; clearError();
    capture.disabled = true; for (const b of timers.querySelectorAll("button")) b.disabled = true;
    const prefs = shotPrefs.get();
    try {
      for (countdown = delay; countdown > 0; countdown--) { render(); await wait(1000); }
      countdown = 0; capture.querySelector("span").textContent = "Capturing…";
      const grab = async () => {
        if (prefs.clean) { await sh(DEMO_ON); await wait(500); }
        let bytes;
        try { bytes = await shBytes("screencap -p"); }
        finally { if (prefs.clean) await sh(DEMO_OFF).catch(() => {}); }
        if (!bytes?.length) throw new Error("The phone sent no picture. Its screen may be showing protected content.");
        return new Blob([bytes], { type: "image/png" });
      };
      // Blur personal data: on the full-size picture, before it is resized or converted (./shotblur.js).
      const got = prefs.blur ? await shotBlur.capture(grab, { verb: "Keep" }) : { blob: await grab(), blurred: 0 };
      if (!got) return;
      const { blob, w, h } = await convert(got.blob, prefs);
      const s = add(blob, w, h, prefs.format);
      s.blurred = got.blurred;
      if (prefs.copy) await copy(s, true);
      if (prefs.save) save(s);
    } finally {
      countdown = 0; busyNow = false;
      capture.disabled = false; capture.querySelector("span").textContent = "Take screenshot";
      for (const b of timers.querySelectorAll("button")) b.disabled = false;
      render();
    }
  }

  // ---------- what can be done with a capture ----------
  async function copy(s, quiet, say = toast) {
    if (!s) return;
    // The clipboard takes PNG, whatever the capture's own format.
    const png = s.format === "png" ? s.blob : (await convert(s.blob, { format: "png", scale: 100 })).blob;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    say(quiet ? "Screenshot taken and copied" : "Picture copied");
  }
  const save = (s) => { if (s) download(s.blob, s.name); };
  async function rotate(deg) {
    const s = current; if (!s) return;
    const { blob, w, h } = await convert(s.blob, { format: s.format, scale: 100 }, deg);
    URL.revokeObjectURL(s.url);
    Object.assign(s, { blob, w, h, url: URL.createObjectURL(blob) });
    render(); thumbOf(s);
  }
  function remove(s) {
    if (!s) return;
    shots.splice(shots.indexOf(s), 1); forget(s);
    current = shots[0] || null; render();
  }

  // ---------- full screen ----------
  // The page's toasts and error box are hidden behind a full-screen element, so the viewer says things itself.
  let full = null;
  function openFull(start) {
    if (!start || full) return;
    const opener = document.activeElement;
    let zoomed = false, entered = false, idleTimer = 0, noteTimer = 0;
    const img = el("img", { alt: "Phone screenshot", draggable: false });
    const pane = el("div", { className: "sf-pane" }, img);
    const title = el("b"), meta = el("span", { className: "sf-meta" });
    const note = el("div", { className: "sf-note", role: "status" });
    const say = (text) => { note.textContent = text; note.classList.add("show"); clearTimeout(noteTimer); noteTimer = setTimeout(() => note.classList.remove("show"), 2200); };
    const fail = (e) => { console.error(e); say(e?.message || String(e)); };
    const fbtn = (name, label, fn, cls = "") => {
      const b = el("button", { className: "sf-b" + (cls ? " " + cls : ""), type: "button", title: label }, icon(name));
      b.setAttribute("aria-label", label);
      b.onclick = (e) => { e.stopPropagation(); Promise.resolve(fn()).catch(fail); };
      return b;
    };
    const zoomBtn = fbtn("zoom-in", "Real size (Z)", () => setZoom(!zoomed));
    const prev = fbtn("chevron-left", "Previous (←)", () => step(-1), "sf-nav sf-prev");
    const next = fbtn("chevron-right", "Next (→)", () => step(1), "sf-nav sf-next");
    const bar = el("div", { className: "sf-bar" },
      el("div", { className: "sf-title" }, title, meta), el("span", { className: "sp" }),
      fbtn("copy", "Copy (C)", () => copy(current, false, say)),
      fbtn("download", "Save (S)", () => { save(current); say("Saving the picture"); }),
      fbtn("rotate-ccw", "Rotate left (Shift+R)", () => turn(-90)),
      fbtn("rotate-cw", "Rotate right (R)", () => turn(90)),
      fbtn("trash-2", "Delete this picture", () => drop(), "danger"),
      el("span", { className: "sf-sep" }), zoomBtn,
      fbtn("minimize", "Exit full screen (Esc)", close));
    const box = el("div", { className: "sf", role: "dialog", ariaModal: "true", ariaLabel: "Screenshot, full screen" }, pane, bar, prev, next, note);

    // The picture as big as fits (bigger than real size too), or at its real size: one picture pixel on one
    // screen pixel, whatever the app zoom in Settings › Accessibility.
    const rootZoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    function layout() {
      const s = current; if (!s) return;
      const pw = pane.clientWidth, ph = pane.clientHeight;
      let w, h;
      if (zoomed) { const k = 1 / (devicePixelRatio || 1) / rootZoom(); w = s.w * k; h = s.h * k; }
      else { const k = Math.min(pw / s.w, ph / s.h); w = s.w * k; h = s.h * k; }
      img.style.width = `${Math.round(w)}px`; img.style.height = `${Math.round(h)}px`;
      pane.classList.toggle("zoomed", zoomed);
      pane.classList.toggle("bigger", zoomed && (w > pw || h > ph));
    }
    function setZoom(on, at) {
      const r = img.getBoundingClientRect(), pr = pane.getBoundingClientRect();
      const fx = at ? (at.x - r.left) / r.width : 0.5, fy = at ? (at.y - r.top) / r.height : 0.5;
      zoomed = on; layout();
      // Keep the spot that was clicked under the pointer.
      const nr = img.getBoundingClientRect();
      pane.scrollLeft += nr.left + fx * nr.width - (at ? at.x : pr.left + pr.width / 2);
      pane.scrollTop += nr.top + fy * nr.height - (at ? at.y : pr.top + pr.height / 2);
      zoomBtn.replaceChildren(icon(on ? "zoom-out" : "zoom-in"));
      zoomBtn.title = on ? "Fit to screen (Z)" : "Real size (Z)"; zoomBtn.setAttribute("aria-label", zoomBtn.title);
    }
    function show() {
      const s = current, i = shots.indexOf(s);
      img.src = s.url;
      title.textContent = s.name;
      meta.textContent = [`${s.w}×${s.h}`, fmtSize(s.blob.size), new Date(s.at).toLocaleTimeString(), shots.length > 1 ? `${i + 1} of ${shots.length}` : ""].filter(Boolean).join(" · ");
      prev.hidden = next.hidden = shots.length < 2;
      prev.disabled = i <= 0; next.disabled = i >= shots.length - 1;
      zoomed = false; setZoom(false);
      render(); // the page behind follows along
    }
    function step(d) {
      const i = shots.indexOf(current) + d;
      if (i < 0 || i >= shots.length) return;
      current = shots[i]; show();
    }
    async function turn(deg) { await rotate(deg); show(); }
    function drop() {
      remove(current);
      if (!current) return close();
      say("Picture deleted"); show();
    }

    // Drag to move a real-size picture around; a click (no drag) zooms in at that spot, or back out.
    let drag = null;
    pane.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, sl: pane.scrollLeft, st: pane.scrollTop, moved: false, onImg: e.target === img };
      pane.setPointerCapture(e.pointerId);
    });
    pane.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; pane.classList.add("dragging");
      pane.scrollLeft = drag.sl - dx; pane.scrollTop = drag.st - dy;
    });
    const endDrag = (e) => {
      const d = drag; drag = null; pane.classList.remove("dragging");
      if (d && !d.moved && e.type === "pointerup" && (d.onImg || zoomed)) setZoom(!zoomed, { x: e.clientX, y: e.clientY });
    };
    pane.addEventListener("pointerup", endDrag);
    pane.addEventListener("pointercancel", endDrag);

    // The buttons fade away while the mouse rests, and come back when it moves.
    const wake = () => { box.classList.remove("idle"); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!bar.matches(":hover")) box.classList.add("idle"); }, 2500); };
    box.addEventListener("pointermove", wake);

    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
      else if (e.key === "ArrowRight" || e.key === "PageDown") step(1);
      else if (e.key === "Home") { current = shots[0]; show(); }
      else if (e.key === "End") { current = shots[shots.length - 1]; show(); }
      else if (k === "z" || k === "0" || k === "1") setZoom(k === "z" ? !zoomed : k === "1");
      else if (k === "c") copy(current, false, say).catch(fail);
      else if (k === "s") { save(current); say("Saving the picture"); }
      else if (k === "r") turn(e.shiftKey ? -90 : 90).catch(fail);
      else if (k === "f") close();
      else if (e.key === "Tab") { // keep the keyboard inside the viewer
        const stops = [...box.querySelectorAll("button")].filter((b) => !b.disabled && !b.hidden);
        const to = stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length];
        to?.focus();
      } else return;
      e.preventDefault(); e.stopPropagation(); wake();
    };
    const onFull = () => {
      if (document.fullscreenElement === box) entered = true;
      else if (entered) close(); // the system's own Esc or the window's green button left full screen
    };
    const onResize = () => layout();

    function close() {
      if (!full) return;
      full = null;
      clearTimeout(idleTimer); clearTimeout(noteTimer);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onFull);
      removeEventListener("resize", onResize);
      if (document.fullscreenElement === box) document.exitFullscreen().catch(() => {});
      box.remove();
      if (opener?.isConnected) opener.focus?.();
    }

    full = { close };
    current = start;
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onFull);
    addEventListener("resize", onResize);
    document.body.append(box);
    // Fill the computer's screen; if the system says no, the viewer still covers the whole window.
    box.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
    show(); wake();
    bar.querySelector(".sf-b:last-child").focus({ preventScroll: true });
  }

  renderSummary(); render();
  return {
    reset() { full?.close(); for (const s of shots.splice(0)) forget(s); current = null; render(); },
  };
}
