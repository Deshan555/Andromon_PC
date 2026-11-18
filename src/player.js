// Andromon — the media player. Three parts, one look:
//  - videoPlayer(): a video with its own controls (Photos viewer, Files preview): play/pause, ±10 s,
//    a seek bar that shows the time under the pointer, volume, speed, loop, picture-in-picture and
//    full screen; the controls fade while it plays. Keys work while it has focus (it takes it).
//  - audioPlayer(): the same controls in one row for a single sound file (Files preview).
//  - initMusicDock(): the music player docked at the bottom of the window, on every page: artwork,
//    title, shuffle, previous / play / next, repeat (off, all, one), seek, volume, the queue, and the
//    computer's media keys and Now Playing (Media Session). Songs come over USB one at a time; the
//    next one is fetched while the current one plays.
// Volume, mute, speed, shuffle and repeat are remembered (localStorage "andromon.player").
// Starting any player pauses the others.

const SVG = {
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" class="fill"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1.2" class="fill"/><rect x="14" y="4" width="4" height="16" rx="1.2" class="fill"/>',
  prev: '<path d="M18 19.5V4.5a1 1 0 0 0-1.53-.85L6.5 10.9a1.3 1.3 0 0 0 0 2.2l9.97 7.25A1 1 0 0 0 18 19.5z" class="fill"/><path d="M5 4v16"/>',
  next: '<path d="M6 4.5v15a1 1 0 0 0 1.53.85l9.97-7.25a1.3 1.3 0 0 0 0-2.2L7.53 3.65A1 1 0 0 0 6 4.5z" class="fill"/><path d="M19 4v16"/>',
  back10: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><text x="12.5" y="15.6" text-anchor="middle" font-size="7.5" font-weight="700" class="fill" stroke="none">10</text>',
  fwd10: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><text x="11.5" y="15.6" text-anchor="middle" font-size="7.5" font-weight="700" class="fill" stroke="none">10</text>',
  vol2: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.36 18.36a9 9 0 0 0 0-12.73"/>',
  vol1: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/>',
  mute: '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  repeat1: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v4"/>',
  shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.97a4 4 0 0 0 3.3-1.7l5.45-7.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.97a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.04a4 4 0 0 1-3.3-1.8l-.36-.45"/>',
  queue: '<path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  unfull: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  pip: '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>',
  loop: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};
const svg = (name) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.innerHTML = SVG[name];
  return s;
};
function ibtn(name, label, cls = "") {
  const b = document.createElement("button");
  b.type = "button"; b.className = "pl-b" + (cls ? " " + cls : ""); b.title = label;
  b.setAttribute("aria-label", label); b.append(svg(name));
  return b;
}
const setIcon = (b, name, label) => { b.replaceChildren(svg(name)); if (label) { b.title = label; b.setAttribute("aria-label", label); } };
const div = (cls, ...kids) => { const d = document.createElement("div"); d.className = cls; d.append(...kids); return d; };
const span = (cls, text = "") => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// ---------- remembered settings ----------
const KEY = "andromon.player";
const prefs = (() => { try { return { volume: 1, muted: false, speed: 1, shuffle: false, repeat: "off", ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { volume: 1, muted: false, speed: 1, shuffle: false, repeat: "off" }; } })();
const savePrefs = (patch) => { Object.assign(prefs, patch); try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {} };

// Starting one player pauses the others (a video in Photos pauses the music, and back).
document.addEventListener("play", (e) => {
  for (const m of document.querySelectorAll("audio, video")) if (m !== e.target && !m.paused && m.dataset.player) m.pause();
}, true);

// ---------- a slider: seek bar and volume ----------
/** A horizontal slider (0..1) with a filled part, an optional loaded part and a hover label. */
function slider({ label, onSeek, onPreview, hoverText }) {
  const fill = span("pl-fill"), loaded = span("pl-loaded"), knob = span("pl-knob"), tip = span("pl-tip");
  tip.hidden = true;
  const node = div("pl-slider", div("pl-track", loaded, fill), knob, tip);
  node.tabIndex = 0; node.setAttribute("role", "slider"); node.setAttribute("aria-label", label);
  node.setAttribute("aria-valuemin", "0"); node.setAttribute("aria-valuemax", "100");
  let value = 0, dragging = false;
  const set = (v) => {
    value = Math.max(0, Math.min(1, v || 0));
    fill.style.width = knob.style.left = value * 100 + "%";
    node.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  };
  const at = (e) => { const r = node.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  node.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true; node.setPointerCapture(e.pointerId); node.classList.add("drag");
    set(at(e)); onPreview?.(value);
  });
  node.addEventListener("pointermove", (e) => {
    const v = at(e);
    if (hoverText) { tip.hidden = false; tip.textContent = hoverText(v); tip.style.left = v * 100 + "%"; }
    if (dragging) { set(v); onPreview?.(value); }
  });
  const end = () => { if (!dragging) return; dragging = false; node.classList.remove("drag"); onSeek(value); };
  node.addEventListener("pointerup", end); node.addEventListener("pointercancel", end);
  node.addEventListener("pointerleave", () => { tip.hidden = true; });
  node.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -0.05, ArrowDown: -0.05, ArrowRight: 0.05, ArrowUp: 0.05, PageDown: -0.1, PageUp: 0.1 }[e.key];
    if (step === undefined && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault(); e.stopPropagation();
    set(e.key === "Home" ? 0 : e.key === "End" ? 1 : value + step); onSeek(value);
  });
  return { node, set, get: () => value, dragging: () => dragging, setLoaded: (v) => { loaded.style.width = Math.max(0, Math.min(1, v)) * 100 + "%"; }, setText: (t) => node.setAttribute("aria-valuetext", t) };
}

/** Volume: the speaker button (mute) and a slider. Applies to `media()` and remembers the level. */
function volumeControl(media) {
  const btn = ibtn("vol2", "Mute (M)");
  const bar = slider({ label: "Volume", onSeek: (v) => apply(v, false), onPreview: (v) => apply(v, false) });
  bar.node.classList.add("pl-vol");
  function render() {
    const m = media(), muted = prefs.muted || prefs.volume === 0;
    setIcon(btn, muted ? "mute" : prefs.volume < 0.5 ? "vol1" : "vol2", muted ? "Unmute (M)" : "Mute (M)");
    bar.set(prefs.muted ? 0 : prefs.volume); bar.setText(`${Math.round((prefs.muted ? 0 : prefs.volume) * 100)}%`);
    if (m) { m.volume = prefs.volume; m.muted = prefs.muted; }
  }
  function apply(v, muted) { savePrefs({ volume: v > 0 ? v : prefs.volume, muted: muted ?? v === 0 }); if (v === 0) savePrefs({ muted: true }); render(); }
  btn.onclick = () => { savePrefs({ muted: !prefs.muted }); if (!prefs.muted && prefs.volume === 0) savePrefs({ volume: 0.5 }); render(); };
  render();
  return { node: div("pl-volbox", btn, bar.node), render, step: (d) => apply(Math.max(0, Math.min(1, (prefs.muted ? 0 : prefs.volume) + d)), false), toggle: () => btn.click() };
}

// Keys shared by the video and single-file players while they have focus.
function mediaKeys(e, m, { vol, fullscreen, pip }) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const seek = (d) => { m.currentTime = Math.max(0, Math.min(m.duration || 0, m.currentTime + d)); };
  switch (k) {
    case " ": case "k": m.paused ? m.play().catch(() => {}) : m.pause(); break;
    case "j": seek(-10); break;
    case "l": seek(10); break;
    case "ArrowLeft": seek(-5); break;
    case "ArrowRight": seek(5); break;
    case "ArrowUp": vol.step(0.1); break;
    case "ArrowDown": vol.step(-0.1); break;
    case "m": vol.toggle(); break;
    case "f": if (!fullscreen) return false; fullscreen(); break;
    case "p": if (!pip) return false; pip(); break;
    case "Home": m.currentTime = 0; break;
    case "End": if (isFinite(m.duration)) m.currentTime = m.duration; break;
    default:
      if (/^[0-9]$/.test(k) && isFinite(m.duration)) { m.currentTime = (m.duration * Number(k)) / 10; break; }
      return false;
  }
  e.preventDefault(); e.stopPropagation(); // e.g. the photo viewer's arrows move between items otherwise
  return true;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** A video with Andromon's controls. `compact` for the Files preview. Returns { node, video }. */
export function videoPlayer({ src, title = "", autoplay = true, compact = false } = {}) {
  const video = document.createElement("video");
  video.src = src; video.playsInline = true; video.preload = "metadata"; video.dataset.player = "video";
  video.playbackRate = prefs.speed; video.autoplay = autoplay;
  const big = ibtn("play", "Play (Space)", "pl-big");
  const spinner = span("spin pl-wait"); spinner.hidden = true;
  const play = ibtn("play", "Play (K)"), back = ibtn("back10", "Back 10 seconds (J)"), fwd = ibtn("fwd10", "Forward 10 seconds (L)");
  const time = span("pl-time", "0:00 / 0:00");
  const seek = slider({ label: "Seek", onSeek: (v) => { if (isFinite(video.duration)) video.currentTime = v * video.duration; }, hoverText: (v) => fmtTime(v * (video.duration || 0)) });
  const vol = volumeControl(() => video);
  const speed = document.createElement("button"); speed.type = "button"; speed.className = "pl-b pl-speed"; speed.title = "Playback speed";
  const loop = ibtn("loop", "Loop", "pl-toggle");
  const pipBtn = ibtn("pip", "Picture in picture (P)");
  const fullBtn = ibtn("full", "Full screen (F)");
  pipBtn.hidden = !document.pictureInPictureEnabled;
  const bar = div("pl-bar", seek.node, div("pl-row", play, back, fwd, time, span("pl-sp"), vol.node, speed, loop, pipBtn, fullBtn));
  const node = div("vplayer" + (compact ? " compact" : ""), video, big, spinner, bar);
  node.tabIndex = 0;
  if (title) node.setAttribute("aria-label", title);

  const renderSpeed = () => { speed.textContent = `${video.playbackRate}×`; };
  speed.onclick = () => {
    const i = SPEEDS.indexOf(video.playbackRate);
    video.playbackRate = SPEEDS[(i + 1) % SPEEDS.length]; savePrefs({ speed: video.playbackRate }); renderSpeed(); poke();
  };
  speed.oncontextmenu = (e) => { e.preventDefault(); video.playbackRate = 1; savePrefs({ speed: 1 }); renderSpeed(); };
  loop.onclick = () => { video.loop = !video.loop; loop.classList.toggle("on", video.loop); loop.setAttribute("aria-pressed", String(video.loop)); };
  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  play.onclick = big.onclick = toggle;
  back.onclick = () => { video.currentTime = Math.max(0, video.currentTime - 10); };
  fwd.onclick = () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); };
  const fullscreen = () => (document.fullscreenElement === node ? document.exitFullscreen() : node.requestFullscreen()).catch(() => {});
  const pip = () => (document.pictureInPictureElement === video ? document.exitPictureInPicture() : video.requestPictureInPicture()).catch(() => {});
  fullBtn.onclick = fullscreen; pipBtn.onclick = pip;
  video.addEventListener("click", toggle);
  video.addEventListener("dblclick", fullscreen);
  node.addEventListener("fullscreenchange", () => setIcon(fullBtn, document.fullscreenElement === node ? "unfull" : "full", document.fullscreenElement === node ? "Exit full screen (F)" : "Full screen (F)"));
  node.addEventListener("keydown", (e) => { if (mediaKeys(e, video, { vol, fullscreen, pip })) poke(); });

  const renderPlay = () => {
    setIcon(play, video.paused ? "play" : "pause", video.paused ? "Play (K)" : "Pause (K)");
    big.hidden = !video.paused; node.classList.toggle("playing", !video.paused);
  };
  const renderTime = () => {
    const d = video.duration;
    if (!seek.dragging()) seek.set(d ? video.currentTime / d : 0);
    time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
    seek.setText(`${fmtTime(video.currentTime)} of ${fmtTime(d)}`);
    if (d && video.buffered.length) seek.setLoaded(video.buffered.end(video.buffered.length - 1) / d);
  };
  for (const ev of ["play", "pause", "ended"]) video.addEventListener(ev, () => { renderPlay(); poke(); });
  for (const ev of ["timeupdate", "durationchange", "progress", "loadedmetadata"]) video.addEventListener(ev, renderTime);
  video.addEventListener("waiting", () => { spinner.hidden = false; });
  for (const ev of ["playing", "canplay", "pause"]) video.addEventListener(ev, () => { spinner.hidden = true; });

  // The controls (and the pointer) fade after 2.5 s without movement while playing.
  let idle = 0;
  function poke() {
    node.classList.remove("idle"); clearTimeout(idle);
    idle = setTimeout(() => { if (!video.paused && !node.matches(":focus-within .pl-bar *:focus-visible, .pl-bar:hover")) node.classList.add("idle"); }, 2500);
  }
  node.addEventListener("pointermove", poke); node.addEventListener("focusin", poke);
  node.addEventListener("pointerleave", () => { if (!video.paused) node.classList.add("idle"); });

  renderSpeed(); renderPlay(); renderTime(); vol.render();
  queueMicrotask(() => { if (node.isConnected && !compact) node.focus({ preventScroll: true }); });
  return { node, video };
}

/** One sound file in a row of controls (Files preview). Returns { node, audio }. */
export function audioPlayer({ src, title = "" } = {}) {
  const audio = document.createElement("audio");
  audio.src = src; audio.preload = "metadata"; audio.dataset.player = "audio";
  const play = ibtn("play", "Play (K)", "pl-main");
  const time = span("pl-time", "0:00 / 0:00");
  const seek = slider({ label: "Seek", onSeek: (v) => { if (isFinite(audio.duration)) audio.currentTime = v * audio.duration; }, hoverText: (v) => fmtTime(v * (audio.duration || 0)) });
  const vol = volumeControl(() => audio);
  const node = div("aplayer", audio, div("pl-art", svg("music")), div("pl-col", span("pl-title", title), div("pl-row", play, seek.node, time, vol.node)));
  node.tabIndex = 0;
  play.onclick = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());
  node.addEventListener("keydown", (e) => mediaKeys(e, audio, { vol }));
  const renderPlay = () => setIcon(play, audio.paused ? "play" : "pause", audio.paused ? "Play (K)" : "Pause (K)");
  for (const ev of ["play", "pause", "ended"]) audio.addEventListener(ev, renderPlay);
  for (const ev of ["timeupdate", "durationchange", "loadedmetadata"]) audio.addEventListener(ev, () => {
    if (!seek.dragging()) seek.set(audio.duration ? audio.currentTime / audio.duration : 0);
    time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
  });
  vol.render();
  return { node, audio };
}

// ---------- the music dock ----------
/**
 * The music player docked at the bottom of the window. play(list, index, how) starts `list` at
 * `index`; `how` says how to get a song: { key(it), source(it, onBytes) -> Promise<url>,
 * meta(it) -> { title, artist, album, duration (seconds) }, art(it, img), onChange(it | null), onOpen() }.
 */
export function initMusicDock({ fmtSize, toast }) {
  const audio = document.createElement("audio");
  audio.dataset.player = "music"; audio.preload = "auto";
  const art = document.createElement("img"); art.alt = "";
  const artBox = div("pl-art", svg("music"), art);
  const title = span("pl-title"), sub = span("pl-sub");
  const info = document.createElement("button"); info.type = "button"; info.className = "pl-info"; info.title = "Show in Music";
  info.append(artBox, div("pl-col", title, sub));
  const shuffle = ibtn("shuffle", "Shuffle", "pl-toggle"), prev = ibtn("prev", "Previous"), play = ibtn("play", "Play", "pl-main"), next = ibtn("next", "Next");
  const repeat = ibtn("repeat", "Repeat: off", "pl-toggle");
  const cur = span("pl-time"), dur = span("pl-time");
  const seek = slider({ label: "Seek", onSeek: (v) => { if (isFinite(audio.duration)) audio.currentTime = v * audio.duration; }, onPreview: (v) => { cur.textContent = fmtTime(v * (audio.duration || 0)); }, hoverText: (v) => fmtTime(v * (audio.duration || 0)) });
  const vol = volumeControl(() => audio);
  const queueBtn = ibtn("queue", "Queue", "pl-toggle"), close = ibtn("x", "Stop and close");
  const queueBox = div("pl-queue"); queueBox.hidden = true;
  const dock = div("mdock",
    info,
    div("pl-center", div("pl-row pl-btns", shuffle, prev, play, next, repeat), div("pl-row pl-seek", cur, seek.node, dur)),
    div("pl-row pl-right", queueBtn, vol.node, close),
    queueBox, audio);
  dock.hidden = true; dock.setAttribute("role", "region"); dock.setAttribute("aria-label", "Music player");
  document.body.append(dock);

  let how = null, list = [], order = [], pos = 0, token = 0, item = null;

  // Order of play: the list as it is, or shuffled with the chosen song first.
  function makeOrder(start) {
    order = list.map((_, i) => i);
    if (prefs.shuffle) {
      order.splice(order.indexOf(start), 1);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      order.unshift(start);
      pos = 0;
    } else pos = start;
  }
  const at = (p) => list[order[p]];

  async function load(p, autoplay = true) {
    pos = p; item = at(p); const t = ++token;
    if (!item) return stop();
    const m = how.meta(item);
    title.textContent = m.title; sub.textContent = [m.artist, m.album].filter(Boolean).join(" · ");
    art.hidden = true; art.removeAttribute("src"); art.onload = () => { art.hidden = false; }; how.art?.(item, art);
    dock.hidden = false; document.documentElement.classList.add("has-mdock"); place();
    audio.pause(); audio.removeAttribute("src");
    seek.set(0); seek.setLoaded(0); cur.textContent = "0:00"; dur.textContent = m.duration ? fmtTime(m.duration) : "";
    dock.classList.add("loading"); renderButtons(); renderQueue();
    how.onChange?.(item);
    session(m);
    try {
      const url = await how.source(item, (n) => { if (t === token) { seek.setLoaded(item.size ? n / item.size : 0); cur.textContent = item.size ? `${Math.round((n / item.size) * 100)}%` : fmtSize(n); } });
      if (t !== token) return;
      dock.classList.remove("loading");
      audio.src = url; audio.playbackRate = 1; vol.render();
      seek.setLoaded(1);
      if (autoplay) await audio.play().catch(() => {});
      prefetch();
    } catch (e) {
      if (t !== token) return;
      dock.classList.remove("loading");
      cur.textContent = ""; sub.textContent = `Couldn't play: ${e?.message || e}`;
    }
  }
  // While one song plays, the next one comes over USB, so it starts at once.
  function prefetch() {
    const n = nextPos(false); if (n === null || n === pos) return;
    const it = at(n), t = token;
    setTimeout(() => { if (t === token && !audio.paused) how.source(it, () => {}).catch(() => {}); }, 1500);
  }
  function nextPos(user) {
    if (prefs.repeat === "one" && !user) return pos;
    if (pos + 1 < order.length) return pos + 1;
    return prefs.repeat === "all" ? 0 : null; // the end of the list
  }
  const goNext = (user = true) => { const n = nextPos(user); if (n === null) { audio.pause(); audio.currentTime = 0; return; } if (n === pos) { audio.currentTime = 0; audio.play().catch(() => {}); } else load(n); };
  const goPrev = () => { if (audio.currentTime > 3 || pos === 0) { audio.currentTime = 0; return; } load(pos - 1); };

  function stop() {
    token++; item = null;
    audio.pause(); audio.removeAttribute("src"); audio.load();
    dock.hidden = true; queueBox.hidden = true; queueBtn.classList.remove("on");
    document.documentElement.classList.remove("has-mdock");
    if ("mediaSession" in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; }
    how?.onChange?.(null);
  }

  function renderButtons() {
    shuffle.classList.toggle("on", prefs.shuffle); shuffle.setAttribute("aria-pressed", String(prefs.shuffle));
    shuffle.title = prefs.shuffle ? "Shuffle: on" : "Shuffle: off";
    setIcon(repeat, prefs.repeat === "one" ? "repeat1" : "repeat", { off: "Repeat: off", all: "Repeat: all", one: "Repeat: this song" }[prefs.repeat]);
    repeat.classList.toggle("on", prefs.repeat !== "off");
    prev.disabled = !item; next.disabled = !item || (nextPos(true) === null);
  }
  const renderPlay = () => {
    setIcon(play, audio.paused ? "play" : "pause", audio.paused ? "Play" : "Pause");
    dock.classList.toggle("playing", !audio.paused);
    if ("mediaSession" in navigator && item) navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  };
  function renderQueue() {
    if (queueBox.hidden) return;
    const rows = [];
    const row = (p, label) => {
      const it = at(p), m = how.meta(it);
      const b = document.createElement("button"); b.type = "button"; b.className = "pl-qi" + (p === pos ? " on" : "");
      b.append(span("pl-qn", label), div("pl-col", span("pl-title", m.title), span("pl-sub", m.artist || "")), span("pl-qd", m.duration ? fmtTime(m.duration) : ""));
      b.onclick = () => load(p);
      return b;
    };
    rows.push(span("pl-qh", "Now playing"), row(pos, "▶"));
    const upcoming = [];
    for (let p = pos + 1; p < order.length && upcoming.length < 200; p++) upcoming.push(p);
    if (prefs.repeat === "all") for (let p = 0; p < pos && upcoming.length < 200; p++) upcoming.push(p);
    if (upcoming.length) rows.push(span("pl-qh", `Up next · ${upcoming.length} song${upcoming.length === 1 ? "" : "s"}`), ...upcoming.map((p, i) => row(p, String(i + 1))));
    queueBox.replaceChildren(...rows);
  }

  // The computer's media keys and its Now Playing (macOS Control Centre, Windows media flyout).
  function session(m) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: m.title || "", artist: m.artist || "", album: m.album || "", artwork: art.src ? [{ src: art.src }] : [] });
  }
  art.addEventListener("load", () => { if (item) session(how.meta(item)); });
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession, h = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
    h("play", () => audio.play().catch(() => {})); h("pause", () => audio.pause());
    h("previoustrack", goPrev); h("nexttrack", () => goNext(true));
    h("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    h("seekforward", () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); });
    h("seekto", (d) => { audio.currentTime = d.seekTime; });
    h("stop", stop);
  }

  play.onclick = () => (audio.paused ? audio.play().catch(() => {}) : audio.pause());
  prev.onclick = goPrev; next.onclick = () => goNext(true); close.onclick = stop;
  shuffle.onclick = () => {
    savePrefs({ shuffle: !prefs.shuffle });
    const keep = order[pos]; makeOrder(keep); renderButtons(); renderQueue();
    toast?.(prefs.shuffle ? "Shuffle on" : "Shuffle off");
  };
  repeat.onclick = () => { savePrefs({ repeat: { off: "all", all: "one", one: "off" }[prefs.repeat] }); renderButtons(); renderQueue(); };
  queueBtn.onclick = () => { queueBox.hidden = !queueBox.hidden; queueBtn.classList.toggle("on", !queueBox.hidden); renderQueue(); queueBox.querySelector(".on")?.scrollIntoView({ block: "nearest" }); };
  info.onclick = () => how?.onOpen?.();
  dock.addEventListener("keydown", (e) => {
    if (e.target.closest(".pl-slider")) return;
    if (e.key === "Escape" && !queueBox.hidden) { queueBtn.click(); e.preventDefault(); return; }
    if (e.key === "MediaTrackNext") return goNext(true);
    mediaKeys(e, audio, { vol });
  });
  for (const ev of ["play", "pause", "ended"]) audio.addEventListener(ev, renderPlay);
  audio.addEventListener("ended", () => goNext(false));
  for (const ev of ["timeupdate", "durationchange", "loadedmetadata"]) audio.addEventListener(ev, () => {
    if (dock.classList.contains("loading")) return;
    const d = audio.duration;
    if (!seek.dragging()) { seek.set(d ? audio.currentTime / d : 0); cur.textContent = fmtTime(audio.currentTime); }
    dur.textContent = fmtTime(d); seek.setText(`${fmtTime(audio.currentTime)} of ${fmtTime(d)}`);
    if ("mediaSession" in navigator && isFinite(d) && d > 0) try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 }); } catch {}
  });

  // Fixed under the page column, whatever the sidebar's width.
  function place() {
    const main = document.querySelector("main"); if (!main || dock.hidden) return;
    const z = document.documentElement.currentCSSZoom || 1, r = main.getBoundingClientRect();
    dock.style.left = (r.left / z + 12) + "px"; dock.style.width = Math.max(320, r.width / z - 24) + "px";
  }
  addEventListener("resize", place);
  new ResizeObserver(place).observe(document.querySelector("main") || document.body);
  renderButtons(); renderPlay();

  return {
    play(newList, index, newHow) {
      how = newHow; list = newList.slice(); makeOrder(index); load(pos);
    },
    stop,
    current: () => item,
    /** Songs deleted from the phone: drop them from the queue (stop if the playing one went). */
    remove(keys) {
      if (!how || !item) return;
      if (keys.has(how.key(item))) return stop();
      const keep = at(pos); list = list.filter((it) => !keys.has(how.key(it)));
      makeOrder(list.indexOf(keep)); // shuffled again, with the playing song first
      renderButtons(); renderQueue();
    },
  };
}
