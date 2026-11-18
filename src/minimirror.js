// Andromon — a second phone's screen in a small floating window (Developer › Phones › Mirror), so two
// phones can be watched and used side by side: the main one on the Screen mirror page, others here.
// Each window is its own scrcpy session on its own phone: click is a tap, drag a swipe, the wheel
// scrolls, right-click is Back, typing goes to that phone. No sound and no recording: those stay
// with the Screen mirror page. The window can be dragged by its title and resized from its corner.

import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, ScrcpyPointerId, AndroidMotionEventAction, AndroidKeyCode, AndroidKeyEventAction } from "@yume-chan/scrcpy";
import { WebCodecsVideoDecoder, WebGLVideoFrameRenderer, BitmapVideoFrameRenderer } from "@yume-chan/scrcpy-decoder-webcodecs";
import { icon } from "./fileicons.js";

const SCRCPY_VERSION = "3.3.3"; // the version of renderer/scrcpy-server.jar (as in app.js)

const open = new Map(); // Adb -> window
let stack = 0;

/** Opens (or brings forward) the floating mirror of `adb`. */
export async function openMiniMirror(adb, { el, toast, name }) {
  if (open.has(adb)) { open.get(adb).front(); return; }
  if (!WebCodecsVideoDecoder.isSupported) throw new Error("This computer's browser engine can't decode video (WebCodecs missing).");
  const res = await fetch("scrcpy-server.jar");
  if (!res.ok) throw new Error("scrcpy-server.jar is missing from this build of Andromon.");
  await AdbScrcpyClient.pushServer(adb, (await res.blob()).stream(), DefaultServerPath);
  const client = await AdbScrcpyClient.start(adb, DefaultServerPath, new AdbScrcpyOptions3_3_3({
    maxSize: 1280, videoBitRate: 4_000_000, maxFps: 30, videoCodec: "h264", audio: false, control: true, stayAwake: true, logLevel: "info",
  }, { version: SCRCPY_VERSION }));
  client.output.pipeTo(new WritableStream({ write() {} })).catch(() => {}); // must be read, or the connection stalls

  // ---------- the window ----------
  const canvas = el("canvas", { className: "mm-canvas", tabIndex: 0, ariaLabel: `${name}'s screen. Click to tap, type to send keys.` });
  const title = el("div", { className: "mm-title" }, el("b", { textContent: name }), el("span", { className: "muted small", textContent: "Starting…" }));
  const btn = (label, ic, fn) => { const b = el("button", { className: "mm-btn", type: "button", title: label, ariaLabel: label }, icon(ic)); b.onclick = () => { fn(); canvas.focus(); }; return b; };
  const close = el("button", { className: "mm-btn", type: "button", title: "Stop mirroring this phone", ariaLabel: "Close" }, icon("x"));
  const win = el("div", { className: "mm-win", role: "dialog", ariaLabel: `${name}, mirrored` },
    el("div", { className: "mm-head" }, title, close), el("div", { className: "mm-stage" }, canvas),
    el("div", { className: "mm-foot" },
      btn("Back", "arrow-left", () => key(AndroidKeyCode.AndroidBack)), btn("Home", "circle", () => key(AndroidKeyCode.AndroidHome)),
      btn("Recent apps", "square", () => key(AndroidKeyCode.AndroidAppSwitch))),
    el("div", { className: "mm-grip", ariaHidden: "true" }));
  const n = open.size;
  win.style.cssText = `right:${24 + n * 28}px;top:${90 + n * 28}px;width:300px`;
  const front = () => { win.style.zIndex = String(60 + ++stack); };
  front(); win.addEventListener("pointerdown", front, true);
  document.body.append(win);

  const renderer = WebGLVideoFrameRenderer.isSupported ? new WebGLVideoFrameRenderer(canvas) : new BitmapVideoFrameRenderer(canvas);
  const video = await client.videoStream;
  const decoder = new WebCodecsVideoDecoder({ codec: video.metadata.codec, renderer });
  video.stream.pipeTo(decoder.writable).catch(() => {});
  const controller = client.controller;
  let shown = false;
  const sizeTimer = setInterval(() => {
    if (!decoder.width) return;
    title.lastChild.textContent = `${decoder.width}×${decoder.height}`;
    if (!shown) { shown = true; win.style.width = `${Math.round(Math.min(360, (decoder.width / decoder.height) * 560) + 20)}px`; }
  }, 500);

  // ---------- input ----------
  const point = (e) => {
    const r = canvas.getBoundingClientRect(), w = decoder.width || canvas.width, h = decoder.height || canvas.height;
    return { pointerX: Math.max(0, Math.min(w, ((e.clientX - r.left) / r.width) * w)), pointerY: Math.max(0, Math.min(h, ((e.clientY - r.top) / r.height) * h)), videoWidth: w, videoHeight: h };
  };
  const touch = (e, action) => controller?.injectTouch({ action, pointerId: e.pointerType === "mouse" ? ScrcpyPointerId.Finger : BigInt(e.pointerId), ...point(e),
    pressure: action === AndroidMotionEventAction.Up ? 0 : 1, actionButton: 0, buttons: 0 }).catch(() => {});
  async function key(code) {
    await controller?.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode: code, repeat: 0, metaState: 0 }).catch(() => {});
    await controller?.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode: code, repeat: 0, metaState: 0 }).catch(() => {});
  }
  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus();
    if (e.pointerType === "mouse" && e.button === 2) { key(AndroidKeyCode.AndroidBack); return; }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault(); canvas.setPointerCapture(e.pointerId); touch(e, AndroidMotionEventAction.Down);
  });
  canvas.addEventListener("pointermove", (e) => { if (canvas.hasPointerCapture(e.pointerId)) touch(e, AndroidMotionEventAction.Move); });
  for (const t of ["pointerup", "pointercancel"]) canvas.addEventListener(t, (e) => { if (!canvas.hasPointerCapture(e.pointerId)) return; touch(e, AndroidMotionEventAction.Up); canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100, clamp = (v) => Math.max(-1, Math.min(1, v));
    controller?.injectScroll({ ...point(e), scrollX: clamp(-e.deltaX / unit), scrollY: clamp(-e.deltaY / unit), buttons: 0 }).catch(() => {});
  }, { passive: false });
  canvas.addEventListener("keydown", (e) => {
    if (e.metaKey || e.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); key(AndroidKeyCode.AndroidBack); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { e.preventDefault(); controller?.injectText(e.key).catch(() => {}); return; }
    const code = AndroidKeyCode[e.code]; if (code === undefined) return;
    e.preventDefault(); key(code);
  });

  // ---------- moving and resizing ----------
  const drag = (handle, onMove) => handle.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    const r = win.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
    const move = (ev) => onMove(r, ev.clientX - x0, ev.clientY - y0);
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
  });
  drag(win.querySelector(".mm-head"), (r, dx, dy) => {
    win.style.left = `${Math.max(0, Math.min(innerWidth - 80, r.left + dx))}px`; win.style.top = `${Math.max(0, Math.min(innerHeight - 40, r.top + dy))}px`; win.style.right = "auto";
  });
  drag(win.querySelector(".mm-grip"), (r, dx) => { win.style.width = `${Math.max(200, Math.min(innerWidth - 20, r.width + dx))}px`; });

  // ---------- closing ----------
  let closed = false;
  function stop(reason) {
    if (closed) return; closed = true;
    open.delete(adb); clearInterval(sizeTimer);
    client.close().catch(() => {}); try { decoder.dispose(); } catch {}
    win.remove();
    if (reason) toast(reason);
  }
  close.onclick = () => stop();
  adb.disconnected.then(() => stop(`${name} disconnected`), () => stop());
  client.exited?.then?.(() => stop(`${name}'s mirroring stopped`)).catch?.(() => {});
  open.set(adb, { front, stop });
  canvas.focus();
}

export function closeMiniMirror(adb) { open.get(adb)?.stop(); }
