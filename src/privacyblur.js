// Andromon — "Blur personal data" for the PC window (Settings › Accessibility, or Ctrl/⌘ + Shift + P),
// so the window is safe to screenshot or share. While it is on,
// <html data-pii-blur> is set and:
//  - fixed places that hold personal data are blurred by CSS (message threads and bubbles,
//    contact and call-log names and numbers, calendar events, notifications, call alerts, the
//    location map...; see "privacy blur" at the end of index.html), plus anything marked data-pii;
//  - everywhere else, text that src/pii.js recognises (IMEI, phone numbers, emails, IP and MAC
//    addresses, coordinates, the phone's serial and Wi‑Fi name...) is blurred where it appears: a
//    short label gets class pii-auto, a match inside a longer text is wrapped in <span class="pii-span">.
// Pointing at a blurred item (or moving to it with Tab) shows it. Form fields (inputs, textareas)
// are left to CSS, so typing is never disturbed.

import { findPii } from "./pii.js";

const KEY = "andromon.privacy.blur";
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "CANVAS", "SVG", "VIDEO"]);
const SHORT = 80; // a label this short is blurred whole

let observer = null, queued = new Set(), timer = 0;

export const privacyBlurOn = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };

function scanText(node) {
  const p = node.parentElement;
  if (!p || SKIP.has(p.tagName) || p.closest(".pii-span, .pii-auto, .ico-tip, .set-text, [data-pii-ignore]")) return;
  const text = node.nodeValue;
  const hits = findPii(text);
  if (!hits.length) return;
  if ((p.textContent || "").length <= SHORT) { p.classList.add("pii-auto"); return; }
  // A longer text: wrap just the matches, from the end so earlier offsets stay right.
  for (const h of hits.reverse()) {
    const mid = node.splitText(h.start); mid.splitText(h.end - h.start);
    const span = document.createElement("span"); span.className = "pii-span"; span.tabIndex = 0;
    mid.replaceWith(span); span.append(mid);
  }
}
function scan(root) {
  if (root.nodeType === 3) return scanText(root);
  if (root.nodeType !== 1 || SKIP.has(root.tagName)) return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; for (let n; (n = walk.nextNode()); ) if (n.nodeValue.length >= 4) nodes.push(n);
  nodes.forEach(scanText);
}
function flush() {
  timer = 0;
  const list = [...queued]; queued.clear();
  for (const n of list) if (n.isConnected) scan(n);
}
function queue(n) { queued.add(n); if (!timer) timer = requestAnimationFrame(flush); }

// A label whose text changed may no longer hold personal data (or newly does).
function recheck(el) {
  if (el?.classList?.contains("pii-auto") && !findPii(el.textContent).length) el.classList.remove("pii-auto");
}

function start() {
  if (observer) return;
  scan(document.body);
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") { recheck(m.target.parentElement); queue(m.target); continue; }
      recheck(m.target);
      for (const n of m.addedNodes) if (!(n.nodeType === 1 && n.classList.contains("pii-span"))) queue(n);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
function stop() {
  observer?.disconnect(); observer = null; queued.clear();
  document.querySelectorAll(".pii-auto").forEach((e) => e.classList.remove("pii-auto"));
  for (const s of document.querySelectorAll(".pii-span")) { const p = s.parentNode; s.replaceWith(...s.childNodes); p?.normalize(); }
}

/** Turns the blur on or off and saves it. Returns the new state. */
export function setPrivacyBlur(on) {
  on = !!on;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch {}
  document.documentElement.toggleAttribute("data-pii-blur", on);
  if (on) start(); else stop();
  globalThis.dispatchEvent?.(new Event("andromon:piiblur")); // Settings › Accessibility redraws its switch
  return on;
}

/** Wires the shortcut and applies the saved state. */
export function initPrivacyBlur({ toast } = {}) {
  const flip = () => { const on = setPrivacyBlur(!privacyBlurOn()); toast?.(on ? "Personal data is blurred" : "Personal data is shown"); return on; };
  addEventListener("andromon:pii-known", () => { if (observer) queue(document.body); }); // the phone's serial, Wi‑Fi name... just arrived
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyP") { e.preventDefault(); flip(); }
  });
  setPrivacyBlur(privacyBlurOn());
  return { get: privacyBlurOn, set: setPrivacyBlur };
}
