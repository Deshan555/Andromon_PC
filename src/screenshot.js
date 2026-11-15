// Screenshot page: capture the phone's screen now or after a countdown, then copy, save, rotate or delete
// the picture; the captures of this session stay in a strip below. How a capture is made (format, size,
// clean status bar, copy or save by itself) is set in Settings › Screenshot and kept in localStorage.
import { icon } from "./fileicons.js";

const KEY = "dd.shot";
export const shotPrefs = {
  FORMAT: [["png", "PNG (exact)"], ["jpeg", "JPEG (smaller)"], ["webp", "WebP (smallest)"]],
  SCALE: [["100", "Full size"], ["75", "75%"], ["50", "Half size"]],
  get() {
    let p = {}; try { p = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
    const one = (list, v, d) => (list.some(([id]) => id === String(v)) ? String(v) : d);
    return { format: one(this.FORMAT, p.format, "png"), scale: Number(one(this.SCALE, p.scale, "100")), clean: p.clean === true, copy: p.copy === true, save: p.save === true };
  },
  set(patch) { try { localStorage.setItem(KEY, JSON.stringify({ ...this.get(), ...patch })); } catch {} this.changed?.(); },
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

export function initScreenshot({ $, el, toast, showError, clearError, sh, shBytes, fmtSize, download, show, getAdb }) {
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
    gbtn("copy", "Copy the picture", () => copy(current)),
    gbtn("download", "Save the picture", () => save(current)),
    gbtn("rotate-ccw", "Rotate left", () => rotate(-90)),
    gbtn("rotate-cw", "Rotate right", () => rotate(90)),
    gbtn("trash-2", "Delete this picture", () => remove(current), "danger"));
  const info = el("span", { className: "muted small sh-info" });
  const summary = el("span", { className: "muted small" });
  const settings = el("button", { className: "btn sm", type: "button", textContent: "Change in Settings" });
  settings.onclick = () => show("settings");
  const stage = el("div", { className: "sh-stage" });
  const strip = el("div", { className: "sh-strip", hidden: true });
  root.replaceChildren(el("div", { className: "card sh" },
    el("div", { className: "sh-bar" }, capture, timers, el("span", { className: "sp" }), acts),
    el("div", { className: "sh-bar sh-sub" }, info, el("span", { className: "sp" }), summary, settings),
    stage, strip));

  function renderSummary() {
    const p = shotPrefs.get(), label = (list, v) => list.find(([id]) => id === String(v))?.[1] || "";
    summary.textContent = [label(shotPrefs.FORMAT, p.format).replace(/ \(.*/, ""), p.scale === 100 ? "full size" : `${p.scale}%`, p.clean ? "clean status bar" : "", p.copy ? "copies itself" : "", p.save ? "saves itself" : ""].filter(Boolean).join(" · ");
  }
  shotPrefs.changed = renderSummary;

  function render() {
    for (const b of acts.querySelectorAll("button")) b.disabled = !current;
    if (countdown) stage.replaceChildren(el("div", { className: "sh-count" }, el("b", { textContent: String(countdown) }), el("div", { className: "muted", textContent: "Get the phone's screen ready…" })));
    else if (current) {
      const img = el("img", { src: current.url, alt: "Phone screenshot", className: "shot" });
      stage.replaceChildren(img);
    } else stage.replaceChildren(el("div", { className: "sh-empty" }, icon("image"), el("b", { textContent: "No screenshot yet" }),
      el("div", { className: "muted small", textContent: "Take one now, or use a countdown to open a menu on the phone first." })));
    info.textContent = current ? `${current.w}×${current.h} · ${fmtSize(current.blob.size)} · ${new Date(current.at).toLocaleTimeString()}` : "";
    strip.hidden = shots.length < 2;
    strip.replaceChildren(...shots.map((s) => {
      const t = el("button", { className: "sh-thumb" + (s === current ? " on" : ""), type: "button", title: new Date(s.at).toLocaleTimeString() }, el("img", { src: s.url, alt: "" }));
      t.onclick = () => { current = s; render(); };
      return t;
    }));
  }

  // ---------- capture ----------
  /** PNG bytes from the phone -> a blob in the chosen format and size, plus its pixel size. */
  async function convert(png, { format, scale }, turn = 0) {
    const bmp = await createImageBitmap(png);
    const k = scale / 100, side = turn % 180 !== 0;
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    if (format === "png" && scale === 100 && !turn) return { blob: png, w, h };
    const c = new OffscreenCanvas(side ? h : w, side ? w : h), g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2); g.rotate((turn * Math.PI) / 180);
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, -w / 2, -h / 2, w, h);
    return { blob: await c.convertToBlob({ type: `image/${format}`, quality: 0.9 }), w: c.width, h: c.height };
  }
  const add = (blob, w, h, format) => {
    const s = { blob, w, h, at: Date.now(), url: URL.createObjectURL(blob), name: `screenshot-${stamp(Date.now())}.${format === "jpeg" ? "jpg" : format}`, format };
    shots.unshift(s); current = s;
    for (const old of shots.splice(HISTORY_MAX)) URL.revokeObjectURL(old.url);
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
      if (prefs.clean) { await sh(DEMO_ON); await wait(500); }
      let bytes;
      try { bytes = await shBytes("screencap -p"); }
      finally { if (prefs.clean) await sh(DEMO_OFF).catch(() => {}); }
      if (!bytes?.length) throw new Error("The phone sent no picture. Its screen may be showing protected content.");
      const { blob, w, h } = await convert(new Blob([bytes], { type: "image/png" }), prefs);
      const s = add(blob, w, h, prefs.format);
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
  async function copy(s, quiet) {
    if (!s) return;
    // The clipboard takes PNG, whatever the capture's own format.
    const png = s.format === "png" ? s.blob : (await convert(s.blob, { format: "png", scale: 100 })).blob;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast(quiet ? "Screenshot taken and copied" : "Picture copied");
  }
  const save = (s) => { if (s) download(s.blob, s.name); };
  async function rotate(deg) {
    const s = current; if (!s) return;
    const { blob, w, h } = await convert(s.blob, { format: s.format, scale: 100 }, deg);
    URL.revokeObjectURL(s.url);
    Object.assign(s, { blob, w, h, url: URL.createObjectURL(blob) });
    render();
  }
  function remove(s) {
    if (!s) return;
    shots.splice(shots.indexOf(s), 1); URL.revokeObjectURL(s.url);
    current = shots[0] || null; render();
  }

  renderSummary(); render();
  return {
    reset() { for (const s of shots.splice(0)) URL.revokeObjectURL(s.url); current = null; render(); },
  };
}
