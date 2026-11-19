// Andromon — Settings › Accessibility › Icon buttons. While <html data-icons> is set, every .btn
// whose words have a matching icon shows only that icon; its words stay in the button (hidden, so
// screen readers still read them) and appear as a tooltip on hover or keyboard focus. Buttons
// with no matching icon, symbols (+, ✕, ▶) and buttons that already hold an icon keep their look.
// The page's own code is never touched: a MutationObserver re-reads a button whenever its words
// change (Start → Stop, busy "Saving…", "Confirm?"), and only data-ico is written.

const P = (...d) => d.map((x) => (x.startsWith("<") ? x : `<path d="${x}"/>`)).join("");
// Lucide-style 24×24 stroke icons (the same family as the sidebar's).
const ICONS = {
  save: P("M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7", "M7 3v4a1 1 0 0 0 1 1h7"),
  open: P("M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"),
  folder: P("m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"),
  copy: P('<rect width="14" height="14" x="8" y="8" rx="2"/>', "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"),
  x: P("M18 6 6 18", "m6 6 12 12"),
  stop: P('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  upload: P("M12 3v12", "m17 8-5-5-5 5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"),
  download: P("M12 15V3", "m7 10 5 5 5-5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"),
  eraser: P("m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21", "M22 21H7", "m5 11 9 9"),
  eye: P("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", '<circle cx="12" cy="12" r="3"/>'),
  eyeoff: P("M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "M14.084 14.158a3 3 0 0 1-4.242-4.242", "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "m2 2 20 20"),
  trash: P("M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"),
  send: P("M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z", "m21.854 2.147-10.94 10.939"),
  refresh: P("M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"),
  plus: P("M5 12h14", "M12 5v14"),
  back: P("m12 19-7-7 7-7", "M19 12H5"),
  next: P("M5 12h14", "m12 5 7 7-7 7"),
  play: P("M6 3l14 9-14 9z"),
  pause: P('<rect x="6" y="4" width="4" height="16" rx="1"/>', '<rect x="14" y="4" width="4" height="16" rx="1"/>'),
  restore: P("M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"),
  edit: P("M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "m15 5 4 4"),
  print: P("M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2", "M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6", '<rect x="6" y="14" width="12" height="8" rx="1"/>'),
  search: P('<circle cx="11" cy="11" r="8"/>', "m21 21-4.3-4.3"),
  link: P("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
  unlink: P("m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71", "m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71", "M8 2v3", "M2 8h3", "M16 22v-3", "M22 16h-3"),
  select: P('<rect x="3" y="3" width="18" height="18" rx="2"/>', "m9 12 2 2 4-4"),
  check: P("M20 6 9 17l-5-5"),
  ban: P('<circle cx="12" cy="12" r="10"/>', "m4.9 4.9 14.2 14.2"),
  keyboard: P("M10 8h.01", "M12 12h.01", "M14 8h.01", "M16 12h.01", "M18 8h.01", "M6 8h.01", "M7 16h10", "M8 12h.01", '<rect width="20" height="16" x="2" y="4" rx="2"/>'),
  sliders: P("M21 4h-7", "M10 4H3", "M21 12h-9", "M8 12H3", "M21 20h-5", "M12 20H3", "M14 2v4", "M8 10v4", "M16 18v4"),
  wrench: P("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"),
  update: P('<circle cx="12" cy="12" r="10"/>', "m16 12-4-4-4 4", "M12 16V8"),
  info: P('<circle cx="12" cy="12" r="10"/>', "M12 16v-4", "M12 8h.01"),
  phone: P("M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"),
  phoneoff: P("M10.1 13.9a14 14 0 0 0 3.732 2.668 1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2 18 18 0 0 1-12.728-5.272", "M22 2 2 22", "M4.76 13.582A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 .244.473"),
  bell: P("M10.268 21a2 2 0 0 0 3.464 0", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"),
  mute: P("M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z", "m22 9-6 6", "m16 9 6 6"),
  message: P("M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"),
  camera: P("M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z", '<circle cx="12" cy="13" r="3"/>'),
  home: P("M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8", "M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),
  calendar: P("M8 2v4", "M16 2v4", '<rect x="3" y="4" width="18" height="18" rx="2"/>', "M3 10h18"),
  merge: P('<circle cx="18" cy="18" r="3"/>', '<circle cx="6" cy="6" r="3"/>', "M6 21V9a9 9 0 0 0 9 9"),
  swap: P("M8 3 4 7l4 4", "M4 7h16", "m16 21 4-4-4-4", "M20 17H4"),
  cast: P("M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6", "M2 12a9 9 0 0 1 8 8", "M2 16a5 5 0 0 1 4 4", "M2 20h.01"),
};

// Phrases checked first (whole-label prefixes), then the label's first word.
const PHRASES = [
  [/^(open|show|choose) .*folder/, "folder"], [/^hang up/, "phoneoff"], [/^force stop/, "stop"], [/^check for update/, "refresh"],
  [/^try again/, "refresh"], [/^(take|save) (a )?screenshot/, "camera"], [/^(back to defaults|reset)/, "restore"],
];
const WORDS = {
  save: "save", open: "open", copy: "copy", cancel: "x", close: "x", dismiss: "x", stop: "stop", end: "stop",
  export: "upload", share: "upload", put: "upload", upload: "upload",
  import: "download", download: "download", install: "download", get: "download", pull: "download", fetch: "download",
  clear: "eraser", empty: "eraser", show: "eye", view: "eye", preview: "eye", hide: "eyeoff",
  delete: "trash", remove: "trash", uninstall: "trash", send: "send",
  reload: "refresh", refresh: "refresh", restart: "refresh", retry: "refresh", check: "refresh", rescan: "refresh",
  add: "plus", new: "plus", create: "plus", make: "plus", back: "back", previous: "back", next: "next", continue: "next",
  start: "play", run: "play", play: "play", launch: "play", resume: "play", pause: "pause",
  restore: "restore", undo: "restore", reset: "restore",
  change: "edit", edit: "edit", rename: "edit", print: "print", find: "search", search: "search", scan: "search",
  connect: "link", pair: "link", disconnect: "unlink", forget: "unlink", unpair: "unlink",
  select: "select", choose: "select", ok: "check", done: "check", accept: "check", apply: "check", allow: "check", grant: "check", use: "check",
  decline: "ban", revoke: "ban", disable: "ban", deny: "ban", block: "ban", type: "keyboard", set: "sliders", manage: "sliders", settings: "sliders",
  patch: "wrench", fix: "wrench", repair: "wrench", update: "update", upgrade: "update", about: "info", details: "info",
  call: "phone", answer: "phone", ring: "bell", silence: "mute", mute: "mute", message: "message", reply: "message",
  screenshot: "camera", take: "camera", home: "home", today: "calendar", merge: "merge", switch: "swap", mirror: "cast",
};

const labelOf = (b) => (b.getAttribute("aria-busy") === "true" && b.dataset.label ? b.dataset.label : b.textContent).replace(/\s+/g, " ").trim();
function iconFor(label) {
  const t = label.toLowerCase().replace(/[…?.!:]+$/, "");
  if (t.length < 3) return ""; // "+", "✕", "▶": already a symbol
  for (const [re, ico] of PHRASES) if (re.test(t)) return ico;
  return WORDS[t.split(" ")[0]] || "";
}

let observer = null, tip = null, styled = false, tipFor = null;

function addStyles() {
  if (styled) return;
  styled = true;
  const url = (body) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`)}")`;
  const css = Object.entries(ICONS).map(([k, body]) => `:root[data-icons] .btn[data-ico="${k}"]{--ico:${url(body)}}`).join("\n");
  document.head.append(Object.assign(document.createElement("style"), { id: "iconButtonIcons", textContent: css }));
}

function mark(b) {
  if (!b.classList?.contains("btn")) return;
  // Buttons that already show an icon (or an image) of their own are left alone.
  const ico = b.querySelector("svg, img") && !b.querySelector(".spin") ? "" : iconFor(labelOf(b));
  if (ico) { if (b.dataset.ico !== ico) b.dataset.ico = ico; }
  else if (b.dataset.ico) delete b.dataset.ico;
}
const markAll = (root) => { if (root.matches?.(".btn")) mark(root); root.querySelectorAll?.(".btn").forEach(mark); };

// ---------- tooltip: the button's words, plus its longer description if it has one ----------
function showTip(b) {
  if (!tip) {
    tip = Object.assign(document.createElement("div"), { className: "ico-tip", role: "tooltip", id: "icoTip" });
    tip.append(document.createElement("b"), document.createElement("span"));
    document.body.append(tip);
  }
  if (tipFor && tipFor !== b) hideTip();
  tipFor = b;
  // Our tooltip replaces the native one while it is up, so the two don't stack.
  if (b.title) { b.dataset.icoTitle = b.title; b.removeAttribute("title"); }
  tip.firstChild.textContent = labelOf(b).replace(/…$/, "");
  tip.lastChild.textContent = b.dataset.icoTitle || "";
  tip.lastChild.hidden = !b.dataset.icoTitle;
  b.setAttribute("aria-describedby", "icoTip");
  tip.hidden = false;
  // getBoundingClientRect is in zoomed pixels; the tooltip's own left/top get zoomed again.
  const z = document.documentElement.currentCSSZoom || 1;
  const r = b.getBoundingClientRect(), w = tip.offsetWidth * z, h = tip.offsetHeight * z;
  let x = r.left + r.width / 2 - w / 2, y = r.bottom + 8;
  if (y + h > innerHeight * z - 4) y = r.top - h - 8;
  x = Math.max(6, Math.min(x, innerWidth * z - w - 6));
  tip.style.left = x / z + "px"; tip.style.top = y / z + "px";
}
function hideTip() {
  const b = tipFor;
  tipFor = null;
  if (tip) tip.hidden = true;
  if (!b) return;
  if (b.dataset.icoTitle) { if (!b.title) b.title = b.dataset.icoTitle; delete b.dataset.icoTitle; }
  if (b.getAttribute("aria-describedby") === "icoTip") b.removeAttribute("aria-describedby");
}
const target = (e) => e.target?.closest?.(".btn[data-ico]");
const onOver = (e) => { const b = target(e); if (b) showTip(b); else if (tipFor && !tipFor.contains(e.target)) hideTip(); };
const onFocus = (e) => { const b = target(e); if (b && b.matches(":focus-visible")) showTip(b); };
const onOut = (e) => { if (tipFor && (!e.relatedTarget || !tipFor.contains(e.relatedTarget))) hideTip(); };

/** Turns icon buttons on or off. Called by renderer/theme.js's apply() through globalThis.ddIconButtons. */
export function setIconButtons(on) {
  if (on && !observer) {
    addStyles();
    markAll(document.body);
    observer = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") { const b = m.target.parentElement?.closest(".btn"); if (b) mark(b); continue; }
        const b = m.target.closest?.(".btn");
        if (b) mark(b);
        for (const n of m.addedNodes) if (n.nodeType === 1) markAll(n);
        if (tipFor && !tipFor.isConnected) hideTip();
        else if (tipFor === b) showTip(b); // its words changed while the tooltip was up
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-busy"] });
    addEventListener("mouseover", onOver, true); addEventListener("mouseout", onOut, true);
    addEventListener("focusin", onFocus, true); addEventListener("focusout", onOut, true);
    addEventListener("scroll", hideTip, true); addEventListener("pointerdown", hideTip, true);
  } else if (!on && observer) {
    observer.disconnect(); observer = null;
    hideTip();
    removeEventListener("mouseover", onOver, true); removeEventListener("mouseout", onOut, true);
    removeEventListener("focusin", onFocus, true); removeEventListener("focusout", onOut, true);
    removeEventListener("scroll", hideTip, true); removeEventListener("pointerdown", hideTip, true);
    document.querySelectorAll(".btn[data-ico]").forEach((b) => delete b.dataset.ico);
  }
}
