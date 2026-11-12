// Test automation: record what a tester does on the live phone screen as a list of steps, then replay
// the steps and report pass/fail.
//
// How it works
// - Reading the screen: a small helper (renderer/ui-helper.jar, source in ../uihelper) runs on the phone
//   as a shell process while tests are in use, like the scrcpy server. It keeps one UiAutomation session
//   open, so the list of on-screen elements comes back in milliseconds. If it can't start on some phone,
//   everything falls back to `uiautomator dump` and `input` (same results, a few seconds per step).
// - Recording: clicks on the mirrored screen are held back, matched to the element under the pointer
//   (resource id / text / description), stored as a step, and only then performed on the phone by the
//   same code that replays steps. What is recorded is exactly what was executed.
// - Replaying: each step waits for its element to appear (up to its timeout), then acts on it. A failed
//   step stops the test and keeps a screenshot.
//
// Every string from the phone is untrusted: it is only ever inserted with textContent / el().

const KEYS = {
  back: [4, "Back"], home: [3, "Home"], recents: [187, "Recents"], enter: [66, "Enter"], delete: [67, "Backspace"],
  tab: [61, "Tab"], search: [84, "Search"], menu: [82, "Menu"],
};
const HELPER_PATH = "/data/local/tmp/dd-ui-helper.jar";
const BADGE_PKG = "dev.droiddesk.companion";
const BADGE_TITLE = "DroidDeskRec"; // window title of the companion's recording badge (RecOverlay.kt)
const STORE_KEY = "dd.tests";
const DEFAULT_TIMEOUT = 10; // seconds a step waits for its element
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pct = (v) => Math.round(v * 100) + "%";
const short = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const shortId = (id) => id.slice(id.indexOf("/") + 1);

class StopError extends Error { constructor() { super("Stopped"); } }

// ---------- pure helpers: screen model, selectors (exported for tests) ----------

/** Helper JSON -> { w, h, nodes[], wins[], pkg } with every node flattened, topmost window first. */
export function flattenDump(res) {
  const nodes = [], wins = [], badges = [];
  (res.windows || []).forEach((w) => {
    if (!w.root) return;
    // The companion's floating "Recording" badge is ours, not part of the app under test.
    // (Its window title isn't always reported, so an overlay window owned by the companion counts too.)
    if (w.title === BADGE_TITLE || (w.root.p === BADGE_PKG && w.type !== 1)) { badges.push(w.root.b); return; }
    const pkg = w.root.p || "", wi = wins.length;
    wins.push({ pkg, active: !!w.active, type: w.type, b: w.root.b });
    const walk = (n, parent, depth) => {
      const o = { b: n.b, c: n.c || "", i: n.i || "", t: n.t || "", d: n.d || "", h: n.h || "", f: n.f || 0, parent, depth, win: wi, p: pkg };
      nodes.push(o);
      for (const k of n.k || []) walk(k, o, depth + 1);
    };
    walk(w.root, null, 0);
  });
  let { w, h } = res;
  if (!w || !h) { w = 0; h = 0; for (const n of wins) { w = Math.max(w, n.b[2]); h = Math.max(h, n.b[3]); } }
  const active = wins.find((x) => x.active && x.type === 1) || wins.find((x) => x.type === 1) || wins[0];
  return { w, h, rot: res.rot || 0, nodes, wins, badges, pkg: active?.pkg || "" };
}

/** `uiautomator dump` XML -> the same model (one window). */
export function flattenXml(xml, size) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.querySelector("hierarchy");
  if (!root || doc.querySelector("parsererror")) throw new Error("The screen can't be read right now");
  const rot = Number(root.getAttribute("rotation")) || 0;
  const nodes = [];
  const flag = (n, a, bit) => (n.getAttribute(a) === "true" ? bit : 0);
  const walk = (x, parent, depth) => {
    const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(x.getAttribute("bounds") || "");
    const cls = x.getAttribute("class") || "";
    const o = {
      b: m ? [+m[1], +m[2], +m[3], +m[4]] : [0, 0, 0, 0], c: cls, i: x.getAttribute("resource-id") || "",
      t: x.getAttribute("text") || "", d: x.getAttribute("content-desc") || "", h: "",
      f: flag(x, "clickable", 1) | flag(x, "long-clickable", 2) | flag(x, "scrollable", 4) | (/EditText$/.test(cls) ? 8 : 0)
        | flag(x, "checkable", 16) | flag(x, "checked", 32) | flag(x, "enabled", 64) | flag(x, "focused", 128)
        | flag(x, "selected", 256) | flag(x, "password", 512),
      parent, depth, win: 0, p: x.getAttribute("package") || "",
    };
    nodes.push(o);
    for (const k of x.children) if (k.tagName === "node") walk(k, o, depth + 1);
  };
  for (const k of root.children) if (k.tagName === "node") walk(k, null, 0);
  if (!nodes.length) throw new Error("The screen can't be read right now");
  let [w, h] = size || [0, 0];
  if (w && h && (rot % 2 === 1) !== (w > h)) [w, h] = [h, w];
  if (!w || !h) { w = nodes[0].b[2]; h = nodes[0].b[3]; }
  const pkg = nodes[0].p;
  return { w, h, rot, nodes, wins: [{ pkg, active: true, type: 1, b: [0, 0, w, h] }], badges: [], pkg };
}

const norm = (s) => String(s).trim().toLowerCase();
function nodeMatches(n, sel) {
  if (sel.p && n.p !== sel.p) return false;
  if (sel.i && n.i !== sel.i) return false;
  if (sel.c && n.c !== sel.c) return false;
  if (sel.d && n.d !== sel.d) return false;
  if (sel.t) {
    if (sel.mode === "contains") { const want = norm(sel.t); if (!norm(n.t).includes(want) && !norm(n.d).includes(want)) return false; }
    else if (n.t !== sel.t) return false;
  }
  return true;
}
/** All nodes matching a selector, in screen order. */
export function findAll(screen, sel) {
  if (!sel || !(sel.i || sel.t || sel.d || sel.c)) return [];
  return screen.nodes.filter((n) => nodeMatches(n, sel));
}
/** The node a selector points at (honours `nth`), or null. */
export function findOne(screen, sel) {
  return findAll(screen, sel)[sel.nth || 0] || null;
}

const area = (n) => Math.max(0, n.b[2] - n.b[0]) * Math.max(0, n.b[3] - n.b[1]);
const inside = (b, x, y) => x >= b[0] && x < b[2] && y >= b[1] && y < b[3];
const editable = (n) => !!(n.f & 8);
// Text the user typed into a field changes from run to run, so it never identifies the field.
const stableText = (n) => (n.t && !editable(n) && n.t.length <= 80 ? n.t : "");
const hasIdentity = (n) => !!(n.i || n.d || stableText(n));

/** Shortest selector that finds exactly this node on this screen (falls back to "the nth match"). */
export function buildSelector(screen, node) {
  const t = stableText(node);
  const attrs = { i: node.i, d: node.d.length <= 80 ? node.d : "", t, c: node.c };
  const tries = [["i"], ["d"], ["t"], ["i", "t"], ["i", "d"], ["c", "t"], ["c", "d"], ["i", "c"]];
  let best = null;
  for (const keys of tries) {
    if (!keys.every((k) => attrs[k])) continue;
    const sel = { p: node.p };
    for (const k of keys) sel[k] = attrs[k];
    const all = findAll(screen, sel);
    if (all.length === 1) return sel;
    if (!best || keys.length > best.keys.length) best = { keys, sel, all };
  }
  if (!best) {
    if (!node.c) return null;
    const sel = { p: node.p, c: node.c };
    best = { sel, all: findAll(screen, sel) };
  }
  const nth = best.all.indexOf(node);
  if (nth < 0) return null;
  return { ...best.sel, nth };
}

/** What a click at (x, y) pixels lands on: { node, sel, rel } or null when nothing identifiable is there. */
export function pickTarget(screen, x, y) {
  const screenArea = screen.w * screen.h;
  const hit = nodeAt(screen, x, y);
  if (!hit) return null;
  return describeHit(screen, hit, x, y, screenArea);
}
/** The innermost element at (x, y) in the topmost window that really has something there. */
export function nodeAt(screen, x, y) {
  const screenArea = screen.w * screen.h;
  let hit = null;
  for (let wi = 0; wi < screen.wins.length && !hit; wi++) {
    if (!inside(screen.wins[wi].b, x, y)) continue;
    for (const n of screen.nodes) {
      if (n.win !== wi || !inside(n.b, x, y)) continue;
      if (!hit || area(n) <= area(hit)) hit = n; // smallest wins; on a tie the later (deeper) one
    }
    // System layers (notification pop-ups, the shade) span the screen but are see-through where they
    // have no content: if all we found there is a screen-sized container, look at the window below.
    if (hit && screen.wins[wi].type !== 1 && area(hit) >= screenArea * 0.5) hit = null;
  }
  return hit;
}
function describeHit(screen, hit, x, y, screenArea) {
  let node = hit, centred = false;
  if (!hasIdentity(node)) {
    // An unlabeled row or container: name it by the first label inside it, or by a labeled parent.
    const kid = area(hit) < screenArea * 0.5 && screen.nodes.find((n) => n !== hit && hasIdentity(n) && isAncestor(hit, n));
    if (kid) { node = kid; centred = true; }
    else {
      let p = hit.parent;
      while (p && !(hasIdentity(p) && area(p) < screenArea * 0.5)) p = p.parent;
      if (p) node = p;
    }
  }
  const sel = buildSelector(screen, node);
  if (!sel) return null;
  // A selector made only from a class name ("the 3rd FrameLayout") is too fragile to be worth it.
  if (!sel.i && !sel.t && !sel.d && !editable(node)) return null;
  const bw = node.b[2] - node.b[0], bh = node.b[3] - node.b[1];
  const rel = centred || !bw || !bh ? { x: 0.5, y: 0.5 }
    : { x: clamp((x - node.b[0]) / bw, 0.05, 0.95), y: clamp((y - node.b[1]) / bh, 0.05, 0.95) };
  // What a person would call it, for the step list when the selector itself is a resource id.
  const label = short(stableText(node) || node.d || node.h || "", 40);
  return { node, sel, rel, label };
}
function isAncestor(a, n) { for (let p = n.parent; p; p = p.parent) if (p === a) return true; return false; }

export function describeSelector(sel) {
  if (!sel) return "";
  const name = sel.t ? `“${short(sel.t)}”` : sel.d ? `“${short(sel.d)}”` : sel.i ? shortId(sel.i) : sel.c ? sel.c.split(".").pop() : "element";
  return name + (sel.nth ? ` (#${sel.nth + 1})` : "");
}
export function describeStep(s) {
  const named = () => (s.label && !s.target.t && !s.target.d ? `“${s.label}”` : describeSelector(s.target));
  const where = () => (s.target && s.by !== "position" ? named() : s.at ? `at ${pct(s.at.x)}, ${pct(s.at.y)}` : "?");
  switch (s.type) {
    case "tap": return `Tap ${where()}`;
    case "long": return `Long-press ${where()}`;
    case "swipe": {
      const dx = s.to.x - s.from.x, dy = s.to.y - s.from.y;
      return `Swipe ${Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up")}`;
    }
    case "type": return s.secret && !s.text ? "Type a password (click to enter it)" : `Type “${short(s.text, 60)}”`;
    case "key": return `Press ${KEYS[s.key]?.[1] || s.key}`;
    case "wait": return `Wait ${s.ms / 1000} s`;
    case "assertVisible": return `Check ${named()} is shown`;
    case "assertGone": return `Check ${named()} is not shown`;
    case "launch": return `Open ${s.pkg || "app"}${s.clear ? " (erase its data first)" : s.fresh ? " (restart it first)" : ""}`;
    case "shot": return "Take a screenshot";
    default: return s.type;
  }
}
function selectorDetail(sel) {
  if (!sel) return "";
  const parts = [];
  if (sel.i) parts.push("id " + shortId(sel.i));
  if (sel.t) parts.push((sel.mode === "contains" ? "text contains " : "text ") + JSON.stringify(short(sel.t, 30)));
  if (sel.d) parts.push("description " + JSON.stringify(short(sel.d, 30)));
  if (sel.c && !sel.i && !sel.t && !sel.d) parts.push(sel.c.split(".").pop());
  return parts.join(" · ");
}

// ----- the phone's own touchscreen (`getevent`), so actions done on the phone are recorded too -----

/** `getevent -p` -> Map(device path -> { minX, maxX, minY, maxY }) for touchscreens. */
export function parseTouchDevices(text) {
  const out = new Map();
  for (const block of text.split(/^add device \d+: /m).slice(1)) {
    const path = block.split(/\s/, 1)[0];
    const x = /\b0035\s*:\s*value (-?\d+), min (-?\d+), max (-?\d+)/.exec(block);
    const y = /\b0036\s*:\s*value (-?\d+), min (-?\d+), max (-?\d+)/.exec(block);
    if (!x || !y || +x[3] <= +x[2] || +y[3] <= +y[2]) continue;
    if (/INPUT_PROP_POINTER/.test(block) && !/INPUT_PROP_DIRECT/.test(block)) continue; // a touchpad, not a screen
    out.set(path, { minX: +x[2], maxX: +x[3], minY: +y[2], maxY: +y[3] });
  }
  return out;
}

/**
 * Turns `getevent -lt` lines into finger gestures. Feed it lines; it calls onDown(g) when the first
 * finger lands and onUp(g) when the last one lifts (onLost() instead, for a touch whose position
 * couldn't be known). g = { dev, t0, ms, x0, y0, x1, y1, multi } with
 * positions as 0..1 of the touch panel (panel = the phone held upright, whatever the rotation).
 */
export function touchTracker(devices, { onDown, onUp, onKey, onLost }) {
  const state = new Map(); // dev -> { slot, ids: Map(slot -> id), btn, x, y, g }
  const LINE = /^\[\s*(\d+\.\d+)\]\s+(\S+):\s+(\S+)\s+(\S+)\s+(\S+)/;
  return (line) => {
    const m = LINE.exec(line); if (!m) return;
    const [, ts, dev, type, code, value] = m;
    if (type === "EV_KEY" && value === "DOWN" && onKey && /^KEY_/.test(code)) { onKey(code); return; }
    const r = devices.get(dev); if (!r) return;
    let st = state.get(dev);
    if (!st) state.set(dev, (st = { slot: 0, ids: new Map(), btn: null, x: null, y: null, g: null, blind: false }));
    if (type === "EV_ABS") {
      const v = parseInt(value, 16) | 0;
      if (code === "ABS_MT_SLOT") st.slot = v;
      else if (code === "ABS_MT_TRACKING_ID") { if (v < 0) st.ids.delete(st.slot); else st.ids.set(st.slot, v); }
      else if (code === "ABS_MT_POSITION_X" && (!st.g || st.slot === st.g.slot)) st.x = (v - r.minX) / (r.maxX - r.minX);
      else if (code === "ABS_MT_POSITION_Y" && (!st.g || st.slot === st.g.slot)) st.y = (v - r.minY) / (r.maxY - r.minY);
    } else if (type === "EV_KEY" && code === "BTN_TOUCH") st.btn = value === "DOWN";
    else if (type === "EV_SYN" && code === "SYN_REPORT") {
      const t = parseFloat(ts) * 1000;
      const fingers = st.ids.size || (st.btn ? 1 : 0);
      if (!st.g && !st.blind && fingers > 0) {
        // The kernel reports a coordinate only when it changes. Until each axis has been seen once, a
        // touch that repeats the previous one's x or y exactly can't be placed.
        if (st.x == null || st.y == null) { st.blind = true; return; }
        st.g = { dev, slot: st.slot, t0: t, ms: 0, x0: st.x, y0: st.y, x1: st.x, y1: st.y, multi: fingers > 1 };
        onDown(st.g);
      } else if (st.blind) {
        if (fingers === 0) { st.blind = false; onLost?.(); }
      } else if (st.g) {
        st.g.x1 = st.x; st.g.y1 = st.y; st.g.ms = t - st.g.t0;
        if (fingers > 1) st.g.multi = true;
        if (fingers === 0) { const g = st.g; st.g = null; onUp(g); }
      }
    }
  };
}

/** A point on the touch panel (0..1, upright phone) -> pixels on the screen as currently rotated. */
export function panelToScreen(px, py, screen) {
  const { w, h, rot } = screen;
  switch (rot) {
    case 1: return [py * w, (1 - px) * h];
    case 2: return [(1 - px) * w, (1 - py) * h];
    case 3: return [(1 - py) * w, px * h];
    default: return [px * w, py * h];
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const secs = (ms) => (ms / 1000).toFixed(1) + " s";

/** A self-contained HTML report for one or more finished runs. */
export function buildReport(runs, device) {
  const pass = runs.filter((r) => r.status === "pass").length;
  const rows = runs.map((r) => `
<section>
  <h2><span class="st ${esc(r.status)}">${r.status === "pass" ? "PASS" : r.status === "stopped" ? "STOPPED" : "FAIL"}</span> ${esc(r.name)} <small>${secs(r.ms)}</small></h2>
  <table><tr><th>#</th><th>Step</th><th>Result</th><th>Time</th></tr>
  ${r.steps.map((s, i) => `<tr class="${esc(s.status)}"><td>${i + 1}</td><td>${esc(s.label)}${s.error ? `<div class="err">${esc(s.error)}</div>` : ""}${s.shot ? `<div><img src="${esc(s.shot)}" alt="Screenshot"></div>` : ""}</td><td>${esc(s.status)}</td><td>${s.ms != null ? secs(s.ms) : ""}</td></tr>`).join("\n  ")}
  </table>
</section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test report</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:32px auto;max-width:900px;padding:0 16px;color:#1b1b1f;background:#fff}
h1{font-weight:300;font-size:28px;margin:0 0 4px}h2{font-size:17px;font-weight:500;margin:28px 0 8px}small{color:#6e6e78;font-weight:400}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e6e6ec;vertical-align:top}
.st{display:inline-block;font-size:12px;padding:2px 10px;border-radius:99px;color:#fff;background:#d9443f;vertical-align:2px}.st.pass{background:#2f8f6e}.st.stopped{background:#6e6e78}
tr.fail td{background:#fbe1df}tr.skip td{color:#a8a8b3}.err{color:#b3261e;white-space:pre-wrap}img{max-height:420px;margin-top:8px;border:1px solid #e6e6ec;border-radius:8px}
.sum{color:#6e6e78;margin-bottom:8px}
@media (prefers-color-scheme:dark){body{background:#121216;color:#f1f1f5}th,td{border-color:#2c2c34}tr.fail td{background:#4a2f2d}.err{color:#f08a86}small,.sum{color:#a2a2ad}}
</style></head><body>
<h1>Test report</h1>
<div class="sum">${esc(new Date(runs[0]?.startedAt || Date.now()).toLocaleString())} · ${esc(device || "Android phone")} · ${pass} of ${runs.length} passed</div>
${rows}
</body></html>`;
}

export function buildJUnit(runs) {
  const total = runs.reduce((a, r) => a + r.ms, 0);
  const cases = runs.map((r) => {
    const failed = r.steps.find((s) => s.status === "fail");
    const body = r.status === "pass" ? "" : r.status === "stopped" ? "<skipped/>"
      : `<failure message="${esc(failed ? `Step ${r.steps.indexOf(failed) + 1}: ${failed.label}` : "Failed")}">${esc(failed?.error || "")}</failure>`;
    return `  <testcase classname="droiddesk" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${body}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Droid Desk" tests="${runs.length}" failures="${runs.filter((r) => r.status === "fail").length}" skipped="${runs.filter((r) => r.status === "stopped").length}" time="${(total / 1000).toFixed(3)}">\n${cases.join("\n")}\n</testsuite>\n`;
}

// ---------- the feature ----------

export function initAutotest(env) {
  const { $, el, toast, showError, sh, shBytes, shQuote, withSync, download, armedClick, getAdb, getMirror, startMirror, stopMirror, openRecBadge } = env;

  // ----- saved tests -----
  let tests = [];
  try { tests = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch {}
  if (!Array.isArray(tests)) tests = [];
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(tests)); } catch (e) { showError(new Error("Couldn't save the tests: " + e.message)); } };

  const ui = {
    testId: null,        // open test, or null for the list
    recording: false, picking: null /* "assertVisible" | "assertGone" */, running: false, stop: false,
    phoneWatch: "", badge: "", badgeError: "", // while recording: is the phone's touchscreen watched, is the badge shown
    openStep: null,      // step id whose editor is open
    stepState: new Map(),// step id -> { status, ms, error }
    lastRuns: [],        // results of the last run (one test or all)
    packages: null, device: "", gen: 0, runningId: null,
  };
  const openTest = () => tests.find((t) => t.id === ui.testId) || null;

  // ----- phone link: helper process, with uiautomator/input as the fallback -----
  let helper = null, helperBroken = false, sizeCache = null;

  async function startHelper() {
    const adb = getAdb();
    const res = await fetch("ui-helper.jar");
    if (!res.ok) throw new Error("ui-helper.jar is missing from this build");
    const jar = await res.blob();
    await withSync((s) => s.write({ filename: HELPER_PATH, file: jar.stream(), permission: 0o644 }));
    const proc = await adb.subprocess.noneProtocol.spawn(`CLASSPATH=${HELPER_PATH} app_process / dev.droiddesk.uihelper.Main 2>/dev/null`);
    const h = { proc, adb, writer: proc.stdin.getWriter(), waiting: [], alive: true, chain: Promise.resolve() };
    const die = () => {
      if (!h.alive) return;
      h.alive = false; if (helper === h) helper = null;
      for (const w of h.waiting.splice(0)) w.reject(new Error("The phone helper stopped"));
      try { proc.kill(); } catch {}
    };
    h.die = die;
    (async () => {
      const reader = proc.output.getReader(); const dec = new TextDecoder(); let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
            if (/^(\{|OK$|TIMEOUT$|ERR |READY )/.test(line)) h.waiting.shift()?.resolve(line);
          }
        }
      } catch {}
      die();
    })();
    const ready = await new Promise((resolve, reject) => {
      h.waiting.push({ resolve, reject });
      setTimeout(() => reject(new Error("The phone helper didn't start")), 20000);
    }).catch((e) => { die(); throw e; });
    if (!ready.startsWith("READY")) { die(); throw new Error(ready.replace(/^ERR /, "")); }
    return h;
  }
  let helperStarting = null, helperFails = 0, helperRetryAt = 0;
  async function startHelperSafely() {
    try { return await startHelper(); }
    catch (e) {
      // Only one UiAutomation session can exist: a helper left over from an earlier connection blocks ours.
      if (!/already registered/i.test(e?.message || "")) throw e;
      await sh("pkill -f 'dev.droiddesk.uihelpe[r]'; true").catch(() => {});
      await sleep(500);
      return startHelper();
    }
  }
  async function getHelper() {
    const adb = getAdb();
    if (!adb) throw new Error("No phone is connected");
    if (helper?.alive && helper.adb === adb) return helper;
    helperBroken = helperFails >= 3 || Date.now() < helperRetryAt;
    if (helperBroken) return null;
    helperStarting ||= startHelperSafely().then((h) => { helperFails = 0; return (helper = h); }, (e) => {
      console.warn("ui helper unavailable, using uiautomator for now", e);
      helperFails++; helperRetryAt = Date.now() + 20000; helperBroken = true;
      return null;
    }).finally(() => { helperStarting = null; });
    return helperStarting;
  }
  // The helper is started before the mirror rather than at the same moment, so the two uploads to the
  // phone don't compete.
  async function showPhone() {
    await getHelper();
    if (!getMirror()) await startMirror();
  }
  /** One command to the helper -> its reply line. Commands run strictly one after another. */
  function ask(h, cmd, timeoutMs = 15000) {
    const run = () => new Promise((resolve, reject) => {
      if (!h.alive) return reject(new Error("The phone helper stopped"));
      const w = { resolve, reject };
      const timer = setTimeout(() => { h.die(); reject(new Error("The phone stopped answering")); }, timeoutMs);
      w.resolve = (v) => { clearTimeout(timer); resolve(v); };
      w.reject = (e) => { clearTimeout(timer); reject(e); };
      h.waiting.push(w);
      h.writer.write(new TextEncoder().encode(cmd + "\n")).catch((e) => { h.die(); w.reject(e); });
    }).then((line) => { if (line.startsWith("ERR ")) throw new Error(line.slice(4)); return line; });
    const p = h.chain.then(run, run);
    h.chain = p.catch(() => {});
    return p;
  }
  function stopHelper() {
    const h = helper; helper = null;
    if (h?.alive) { h.writer.write(new TextEncoder().encode("quit\n")).catch(() => {}); setTimeout(() => h.die(), 300); }
  }

  async function wmSize() {
    if (sizeCache) return sizeCache;
    const out = await sh("wm size");
    const m = /Override size: (\d+)x(\d+)/.exec(out) || /Physical size: (\d+)x(\d+)/.exec(out);
    if (!m) throw new Error("Couldn't read the phone's screen size");
    return (sizeCache = [+m[1], +m[2]]);
  }
  async function readScreen() {
    const h = await getHelper();
    if (h) return flattenDump(JSON.parse(await ask(h, "dump")));
    const out = await sh("uiautomator dump /dev/tty");
    const at = out.indexOf("<?xml"), end = out.lastIndexOf("</hierarchy>");
    if (at < 0 || end < 0) throw new Error("The screen can't be read right now" + (/idle state/.test(out) ? " (it keeps animating)" : ""));
    return flattenXml(out.slice(at, end + 12), await wmSize());
  }
  let lastSize = null;
  async function screenSize() {
    try { const s = await readScreen(); return (lastSize = [s.w, s.h]); }
    catch (e) { if (lastSize) return lastSize; if (!helper) return (lastSize = await wmSize()); throw e; }
  }
  // After an action: wait until the phone has stopped reacting to it. First for a quiet moment, then until
  // two looks at the screen 200 ms apart are the same (a new screen sliding in keeps changing). Without
  // this, the next key press or check can land in the middle of a screen change and get lost.
  async function settle() {
    const h = await getHelper();
    if (!h) { await sleep(500); return; }
    await ask(h, "idle 200 2000").catch(() => {});
    const deadline = Date.now() + 2500;
    let prev = await ask(h, "dump").catch(() => null);
    while (Date.now() < deadline && !ui.stop) {
      await sleep(200);
      const now = await ask(h, "dump").catch(() => null);
      if (now === prev) return;
      prev = now;
    }
  }
  const px = (v) => Math.round(v);
  async function doTap(x, y, holdMs = 0) {
    const h = await getHelper();
    if (h) return ask(h, `tap ${px(x)} ${px(y)} ${holdMs || 60}`, 15000 + holdMs);
    await sh(holdMs ? `input swipe ${px(x)} ${px(y)} ${px(x)} ${px(y)} ${holdMs}` : `input tap ${px(x)} ${px(y)}`);
  }
  async function doSwipe(x1, y1, x2, y2, ms) {
    const h = await getHelper();
    if (h) return ask(h, `swipe ${px(x1)} ${px(y1)} ${px(x2)} ${px(y2)} ${ms}`, 15000 + ms);
    await sh(`input swipe ${px(x1)} ${px(y1)} ${px(x2)} ${px(y2)} ${ms}`);
  }
  async function doKey(name) {
    const code = KEYS[name]?.[0]; if (!code) throw new Error("Unknown key: " + name);
    const h = await getHelper();
    if (h) return ask(h, "key " + code);
    await sh("input keyevent " + code);
  }
  async function doType(text) {
    if (!text) return;
    const h = await getHelper();
    if (h) {
      const bytes = new TextEncoder().encode(text); let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return ask(h, "text " + btoa(bin), 30000);
    }
    if (/^[\x20-\x7e]*$/.test(text)) { await sh("input text " + shQuote(text.replace(/ /g, "%s"))); return; }
    const m = getMirror();
    if (!m?.controller) throw new Error("Typing accented or non-English text on this phone needs the live screen to be on");
    await m.controller.injectText(text);
  }
  async function screenshot() {
    const bytes = await shBytes("screencap -p");
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const scale = Math.min(1, 900 / bmp.height);
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
  }

  // ----- running steps -----
  const timeoutOf = (step) => (Number(step.timeout) > 0 ? Number(step.timeout) : DEFAULT_TIMEOUT) * 1000;
  /** Poll the screen until the selector is (or is no longer) there. Returns { screen, node }. */
  async function waitFor(sel, timeoutMs, present = true) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    for (;;) {
      if (ui.stop) throw new StopError();
      try {
        const screen = await readScreen();
        const node = findOne(screen, sel);
        if (present ? node : !node) return { screen, node };
        lastErr = null;
      } catch (e) { lastErr = e; }
      if (Date.now() > deadline) {
        if (lastErr) throw lastErr;
        throw new Error(present ? `${describeSelector(sel)} didn't appear within ${timeoutMs / 1000} s` : `${describeSelector(sel)} is still on the screen after ${timeoutMs / 1000} s`);
      }
      await sleep(helper ? 200 : 50);
    }
  }
  /** Performs one step on the phone. `out` receives extras (screenshot). */
  async function runStep(step, out = {}) {
    const byElement = step.target && step.by !== "position";
    // Steps with no element to wait for keep (some of) the pause the tester made while recording.
    if (!byElement && step.gap && ["tap", "long", "swipe", "type", "key"].includes(step.type)) await sleep(Math.min(step.gap, 1500));
    switch (step.type) {
      case "tap": case "long": {
        const hold = step.type === "long" ? clamp(step.ms || 700, 500, 5000) : 0;
        if (byElement) {
          const { node } = await waitFor(step.target, timeoutOf(step));
          const rel = step.rel || { x: 0.5, y: 0.5 };
          await doTap(node.b[0] + (node.b[2] - node.b[0]) * rel.x, node.b[1] + (node.b[3] - node.b[1]) * rel.y, hold);
        } else {
          if (!step.at) throw new Error("This step has no element and no position");
          const [w, h] = await screenSize();
          await doTap(step.at.x * w, step.at.y * h, hold);
        }
        break;
      }
      case "swipe": {
        const [w, h] = await screenSize();
        await doSwipe(step.from.x * w, step.from.y * h, step.to.x * w, step.to.y * h, clamp(step.ms || 300, 80, 5000));
        break;
      }
      case "type": await doType(step.text || ""); break;
      case "key": await doKey(step.key); break;
      case "wait": {
        const end = Date.now() + (step.ms || 0);
        while (Date.now() < end) { if (ui.stop) throw new StopError(); await sleep(Math.min(200, end - Date.now())); }
        return;
      }
      case "assertVisible": await waitFor(step.target, timeoutOf(step), true); return;
      case "assertGone": await waitFor(step.target, timeoutOf(step), false); return;
      case "launch": {
        const pkg = (step.pkg || "").trim();
        if (!/^[\w.]+$/.test(pkg)) throw new Error("This step needs an app (package name)");
        if (step.clear) {
          const r = await sh("pm clear " + pkg);
          if (!/Success/.test(r)) throw new Error("Couldn't erase the app's data: " + r.trim());
        } else if (step.fresh) await sh("am force-stop " + pkg);
        const r = await sh(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 2>&1`);
        if (/No activities found|monkey aborted/.test(r)) throw new Error(`${pkg} isn't installed or has no screen to open`);
        const deadline = Date.now() + timeoutOf(step);
        for (;;) {
          if (ui.stop) throw new StopError();
          const s = await readScreen().catch(() => null);
          if (s && s.pkg === pkg) break;
          if (Date.now() > deadline) throw new Error(`${pkg} didn't come to the front within ${timeoutOf(step) / 1000} s`);
          await sleep(250);
        }
        break;
      }
      case "shot": out.shot = await screenshot(); return;
      default: throw new Error("Unknown step type: " + step.type);
    }
    await settle();
  }

  async function deviceName() {
    if (ui.device) return ui.device;
    try {
      const [model, rel] = (await sh("getprop ro.product.model; getprop ro.build.version.release")).trim().split(/\r?\n/);
      ui.device = `${model} · Android ${rel}`;
    } catch {}
    return ui.device;
  }

  /** Runs every step of a test; stops at the first failure. */
  async function runTest(test, onStep = () => {}) {
    const run = { testId: test.id, name: test.name || "Untitled test", status: "pass", startedAt: Date.now(), ms: 0,
      steps: test.steps.map((s) => ({ id: s.id, label: describeStep(s), status: "skip", ms: null, error: "", shot: "" })) };
    for (let i = 0; i < test.steps.length; i++) {
      const step = test.steps[i], r = run.steps[i];
      if (ui.stop) { run.status = "stopped"; break; }
      onStep(step, { status: "run" });
      const t0 = performance.now();
      try {
        await runStep(step, r);
        r.status = "pass";
      } catch (e) {
        if (e instanceof StopError) { run.status = "stopped"; r.status = "skip"; onStep(step, { status: "" }); break; }
        r.status = "fail"; r.error = e?.message || String(e); run.status = "fail";
        try { r.shot = await screenshot(); } catch {}
      }
      r.ms = Math.round(performance.now() - t0);
      onStep(step, { status: r.status, ms: r.ms, error: r.error });
      if (r.status === "fail") break;
    }
    run.ms = Date.now() - run.startedAt;
    test.lastRun = { status: run.status, at: run.startedAt, ms: run.ms };
    save();
    return run;
  }

  async function runTests(list) {
    if (ui.running || !list.length) return;
    if (ui.recording) stopRecording();
    cancelPick();
    ui.running = true; ui.stop = false; ui.lastRuns = []; ui.stepState.clear();
    const gen = ++ui.gen; // a disconnect ends the run from outside; then this call must not touch the UI again
    render();
    try {
      await deviceName();
      for (const t of list) {
        if (ui.stop || gen !== ui.gen) break;
        ui.runningId = t.id; render();
        const run = await runTest(t, (step, st) => { if (gen !== ui.gen) return; ui.stepState.set(step.id, st); paintStep(step.id); });
        if (gen !== ui.gen) return;
        ui.lastRuns.push(run);
      }
    } catch (e) { if (gen === ui.gen) showError(e); }
    if (gen !== ui.gen) return;
    ui.running = false; ui.runningId = null; ui.stop = false;
    render();
    const failed = ui.lastRuns.filter((r) => r.status === "fail").length;
    if (ui.lastRuns.length) toast(failed ? `${failed} of ${ui.lastRuns.length} failed` : ui.lastRuns.some((r) => r.status === "stopped") ? "Stopped" : ui.lastRuns.length > 1 ? `All ${ui.lastRuns.length} tests passed` : "Test passed");
  }

  // ----- recording -----
  // Everything the tester does is put on one queue, so a tap is fully recorded and performed before the
  // typing that follows it is looked at.
  let queue = Promise.resolve(), queued = 0, lastOpEnd = 0, gesture = null, wheelTimer = null, wheelAcc = null;
  function enqueue(fn) {
    const gap = lastOpEnd ? Math.max(0, Date.now() - lastOpEnd) : 0;
    queued++; setBusyBadge();
    queue = queue.then(() => fn(gap)).catch((e) => { if (!(e instanceof StopError)) showError(e); })
      .finally(() => { lastOpEnd = Date.now(); queued--; setBusyBadge(); });
    return queue;
  }
  function addStep(step, gap) {
    const t = openTest(); if (!t) return null;
    step.id = uid();
    if (gap > 150) step.gap = Math.round(Math.min(gap, 10000));
    t.steps.push(step); t.updated = Date.now(); save();
    renderSteps(true); badgeUpdate();
    return step;
  }
  function lastStep() { const t = openTest(); return t?.steps[t.steps.length - 1] || null; }

  async function startRecording() {
    const t = openTest(); if (!t || ui.running) return;
    await showPhone();
    cancelPick();
    ui.recording = true; ui.stepState.clear(); lastOpEnd = 0;
    render();
    getHelper().then((h) => { if (!h && ui.recording) toast("Using the phone's slower screen reader: wait a moment after each action"); });
    startPhoneWatch().catch((e) => { console.warn("phone touch watch", e); ui.phoneWatch = "off"; renderRecNote(); });
    badgeRetries = 0;
    // When the test starts by restarting the app, wait for that first: if the app is the companion
    // itself, restarting it would take the badge down again.
    if (!t.steps.length && t.app) {
      enqueue(async () => { const step = addStep({ type: "launch", pkg: t.app, fresh: true }, 0); await runStep(step); });
    }
    queue.then(() => { if (ui.recording) badgeOpen(false); });
    $("mirrorCanvas").focus();
  }
  function stopRecording() {
    if (!ui.recording) return;
    ui.recording = false; gesture = null;
    stopPhoneWatch(); badgeClose();
    render();
  }

  // ----- the floating "Recording" badge on the phone (shown by the companion app) -----
  let badge = null, badgeGen = 0, badgeRetries = 0;
  const badgeText = () => {
    const t = openTest(), last = t?.steps[t.steps.length - 1];
    return { steps: t?.steps.length || 0, last: !last ? "" : last.type === "type" ? "Type text" : describeStep(last) };
  };
  async function badgeOpen(install) {
    if (!openRecBadge || badge) return;
    const gen = ++badgeGen;
    ui.badge = "starting"; renderRecNote();
    try {
      const b = await openRecBadge({
        ...badgeText(), install,
        // The companion went away while recording (it is restarted when it is the app being tested,
        // or Android stopped it): put the badge back.
        onClose() {
          if (gen !== badgeGen || !ui.recording) return;
          badge = null; ui.badge = "";
          if (badgeRetries++ < 5) setTimeout(() => { if (ui.recording && !badge) badgeOpen(false); }, 2000);
        },
      });
      if (gen !== badgeGen || !ui.recording) { b.close?.(); return; }
      if (b.missing) { ui.badge = b.missing; }
      else { badge = b; ui.badge = "on"; badgeUpdate(); }
    } catch (e) {
      if (gen !== badgeGen) return;
      console.warn("recording badge", e); ui.badge = "error"; ui.badgeError = e?.message || String(e);
    }
    renderRecNote();
  }
  function badgeUpdate() { if (badge) { const b = badgeText(); badge.update(b.steps, b.last); } }
  function badgeClose() { badgeGen++; badge?.close(); badge = null; ui.badge = ""; }

  // ----- actions done on the phone itself -----
  // `getevent` shows the touchscreen's raw events, so a tap made on the phone is seen here the moment
  // the finger lands. The element it hit is looked up in a picture of the screen taken just before
  // (kept fresh while recording), because by the time we could ask, the app has already reacted.
  // Taps injected from this computer don't pass through the touchscreen, so nothing is recorded twice.
  let watch = null, screenCache = null, typing = null, typingTimer = null;
  async function startPhoneWatch() {
    stopPhoneWatch();
    const adb = getAdb();
    const devices = parseTouchDevices(await sh("getevent -p 2>/dev/null"));
    if (!devices.size) throw new Error("No touchscreen found");
    const proc = await adb.subprocess.noneProtocol.spawn("getevent -lt 2>/dev/null");
    const w = watch = { proc, alive: true };
    const feed = touchTracker(devices, {
      onDown(g) {
        // Freeze what was on screen before this touch.
        g.before = screenCache && Date.now() - screenCache.at < 600 ? Promise.resolve(screenCache.screen) : readScreen().catch(() => screenCache?.screen || null);
        w.touching = true;
      },
      onLost() { if (ui.recording) toast("One touch on the phone couldn't be placed and wasn't recorded. Add that step again."); },
      onUp(g) { w.touching = false; if (ui.recording && !ui.running) recordPhoneGesture(g); },
      onKey(code) {
        const key = { KEY_BACK: "back", KEY_HOME: "home", KEY_HOMEPAGE: "home", KEY_APPSELECT: "recents" }[code];
        if (key && ui.recording && !ui.running) enqueue(async (gap) => { clearTimeout(typingTimer); typing = null; addStep({ type: "key", key }, gap); await settle(); });
      },
    });
    (async () => {
      const reader = proc.output.getReader(), dec = new TextDecoder(); let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1); if (w.alive) feed(line); }
        }
      } catch {}
      if (watch === w) { watch = null; if (ui.recording) { ui.phoneWatch = "off"; renderRecNote(); } }
    })();
    ui.phoneWatch = "on"; renderRecNote();
    // Keep the "before" picture fresh while nothing else is going on.
    (async () => {
      while (w.alive && ui.recording) {
        if (!queued && !w.touching && !gesture && !ui.picking) {
          const t = Date.now();
          const screen = await readScreen().catch(() => null);
          if (screen && !queued && !w.touching) screenCache = { screen, at: t };
        }
        await sleep(helper ? 300 : 1500);
      }
    })();
  }
  function stopPhoneWatch() {
    const w = watch; watch = null; screenCache = null; typing = null; clearTimeout(typingTimer);
    ui.phoneWatch = "";
    if (w) { w.alive = false; try { w.proc.kill(); } catch {} }
  }

  function recordPhoneGesture(g) {
    enqueue(async (gap) => {
      if (!ui.recording) return;
      const screen = (await g.before) || await readScreen().catch(() => null);
      screenCache = null;
      if (!screen) { toast("Couldn't read the phone's screen for that action"); return; }
      if (g.multi) { toast("Two-finger gestures (pinch, rotate) can't be recorded"); await settle(); return; }
      const [x0, y0] = panelToScreen(g.x0, g.y0, screen), [x1, y1] = panelToScreen(g.x1, g.y1, screen);
      if (screen.badges.some((b) => inside(b, x0, y0))) return; // dragging our own badge
      const moved = Math.hypot(x1 - x0, y1 - y0) > Math.max(24, Math.min(screen.w, screen.h) * 0.03);
      const under = nodeAt(screen, x0, y0);
      if (!moved && under && screen.wins[under.win].type === 2) { phoneTyped(screen); return; } // a key on the on-screen keyboard
      // Whatever was typed before this action is in the picture taken just before it.
      if (typing) { clearTimeout(typingTimer); syncTyped(typing, screen, gap); typing = null; }
      const frac = (x, y) => ({ x: +clamp(x / screen.w, 0, 1).toFixed(4), y: +clamp(y / screen.h, 0, 1).toFixed(4) });
      if (moved) addStep({ type: "swipe", from: frac(x0, y0), to: frac(x1, y1), ms: clamp(Math.round(g.ms), 100, 3000) }, gap);
      else {
        const long = g.ms >= 500;
        const hit = pickTarget(screen, x0, y0);
        // The three-button navigation bar: store the key, not "tap the Back picture".
        const nav = hit?.sel.p === "com.android.systemui" && { back: "back", home: "home", recent_apps: "recents" }[shortId(hit.sel.i || "")];
        if (nav && !long) addStep({ type: "key", key: nav }, gap);
        else {
          const step = { type: long ? "long" : "tap", at: frac(x0, y0) };
          if (long) step.ms = clamp(Math.round(g.ms), 550, 3000);
          if (hit) { step.target = hit.sel; step.rel = { x: +hit.rel.x.toFixed(3), y: +hit.rel.y.toFixed(3) }; if (hit.label) step.label = hit.label; flash(hit.node.b, screen); }
          addStep(step, gap);
        }
      }
      await settle();
    });
  }
  // Typing on the phone's keyboard: the keys themselves aren't recorded. Instead, once the typing
  // pauses, the text that was added to the focused field becomes one "Type" step.
  const focusedField = (screen) => screen.nodes.find((n) => (n.f & 128) && (n.f & 8)) || null;
  function phoneTyped(before) {
    if (!typing) { const f = focusedField(before); typing = { base: f && !(f.f & 512) ? f.t : "", stepId: null }; }
    const session = typing;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => enqueue(async (gap) => {
      if (!ui.recording || typing !== session) return;
      syncTyped(session, await readScreen().catch(() => null), gap);
    }), 700);
  }
  function syncTyped(session, screen, gap) {
    {
      const field = screen && focusedField(screen);
      const t = openTest(), last = lastStep();
      const mine = session.stepId && last?.id === session.stepId ? last : null;
      const put = (props) => {
        if (mine) { Object.assign(mine, props); t.updated = Date.now(); save(); renderSteps(true); badgeUpdate(); }
        else session.stepId = addStep({ type: "type", ...props }, gap)?.id;
      };
      if (!field) { if (!mine && !phoneTyped.warned) { phoneTyped.warned = true; toast("Text typed on the phone's keyboard can't be read on this screen. Type it on this computer's keyboard instead."); } return; }
      if (field.f & 512) { if (!mine) put({ text: "", secret: true }); return; } // passwords are hidden from us
      const text = field.t.startsWith(session.base) ? field.t.slice(session.base.length) : field.t;
      if (text) put({ text });
      else if (mine) { t.steps.pop(); session.stepId = null; save(); renderSteps(true); badgeUpdate(); }
    }
  }

  /** Records one finished pointer gesture (fractions of the screen) and performs it. */
  function recordGesture(g) {
    enqueue(async (gap) => {
      if (!ui.recording) return;
      const moved = Math.hypot(g.cx1 - g.cx0, g.cy1 - g.cy0) > 12;
      if (moved) {
        const step = addStep({ type: "swipe", from: { x: g.x0, y: g.y0 }, to: { x: g.x1, y: g.y1 }, ms: clamp(Math.round(g.ms), 100, 3000) }, gap);
        const [w, h] = await screenSize();
        await doSwipe(step.from.x * w, step.from.y * h, step.to.x * w, step.to.y * h, step.ms);
      } else {
        const long = g.ms >= 550;
        const screen = await readScreen().catch(() => null);
        const [w, h] = screen ? [screen.w, screen.h] : await screenSize();
        const step = { type: long ? "long" : "tap", at: { x: +g.x0.toFixed(4), y: +g.y0.toFixed(4) } };
        if (long) step.ms = clamp(Math.round(g.ms), 550, 3000);
        const hit = screen && pickTarget(screen, g.x0 * w, g.y0 * h);
        if (hit) { step.target = hit.sel; step.rel = { x: +hit.rel.x.toFixed(3), y: +hit.rel.y.toFixed(3) }; if (hit.label) step.label = hit.label; flash(hit.node.b, screen); }
        addStep(step, gap);
        await doTap(g.x0 * w, g.y0 * h, long ? step.ms : 0);
      }
      await settle();
    });
  }
  function recordKey(name) {
    enqueue(async (gap) => { addStep({ type: "key", key: name }, gap); await doKey(name); await settle(); });
  }
  function recordText(text) {
    enqueue(async (gap) => {
      const last = lastStep();
      if (last?.type === "type") { last.text += text; openTest().updated = Date.now(); save(); renderSteps(true); }
      else addStep({ type: "type", text }, gap);
      await doType(text);
    });
  }
  function recordBackspace() {
    enqueue(async (gap) => {
      const t = openTest(), last = lastStep();
      if (last?.type === "type" && last.text) {
        last.text = Array.from(last.text).slice(0, -1).join("");
        if (!last.text) t.steps.pop();
        save(); renderSteps(true);
      } else addStep({ type: "key", key: "delete" }, gap);
      await doKey("delete");
    });
  }

  // ----- "check" picking: the next click on the phone screen chooses an element instead of tapping it -----
  let pickScreen = null;
  async function startPick(kind) {
    if (!openTest()) return;
    await showPhone();
    ui.picking = kind; pickScreen = null; render();
    pickScreen = await readScreen().catch((e) => { showError(e); return null; });
    if (!pickScreen) cancelPick();
  }
  function cancelPick() {
    if (!ui.picking) return;
    ui.picking = null; pickScreen = null; hideBox(); render();
  }
  function pickAt(x, y) {
    const kind = ui.picking, screen = pickScreen;
    if (!screen) return;
    const hit = pickTarget(screen, x * screen.w, y * screen.h);
    if (!hit) { toast("Nothing recognisable there. Try the text or button itself, or use “Check text”."); return; }
    cancelPick();
    const add = () => addStep({ type: kind, target: hit.sel, ...(hit.label ? { label: hit.label } : {}) }, 0);
    if (ui.recording) enqueue(async () => { add(); }); else add();
  }

  // ----- hooks called by the mirror's input handlers (see app.js). Return true = handled here. -----
  const capturing = () => ui.recording || !!ui.picking;
  function capturePointer(phase, e, at) {
    if (!capturing() || ui.running) return false;
    if (ui.picking) {
      if (phase === "move" && pickScreen) { const hit = pickTarget(pickScreen, at.x * pickScreen.w, at.y * pickScreen.h); if (hit) showBox(hit.node.b, pickScreen); else hideBox(); }
      if (phase === "up") pickAt(at.x, at.y);
      return true;
    }
    if (phase === "down") {
      if (e.pointerType === "mouse" && e.button === 2) { recordKey("back"); gesture = null; return true; }
      if (e.pointerType === "mouse" && e.button !== 0) return true;
      gesture = { id: e.pointerId, x0: at.x, y0: at.y, x1: at.x, y1: at.y, cx0: e.clientX, cy0: e.clientY, cx1: e.clientX, cy1: e.clientY, t0: performance.now() };
    } else if (gesture && gesture.id === e.pointerId) {
      gesture.x1 = at.x; gesture.y1 = at.y; gesture.cx1 = e.clientX; gesture.cy1 = e.clientY;
      if (phase === "up") { const g = gesture; gesture = null; g.ms = performance.now() - g.t0; recordGesture(g); }
      else if (phase === "cancel") gesture = null;
    }
    return true;
  }
  function captureKey(e) {
    if (!ui.recording || ui.running || e.metaKey || (e.ctrlKey && e.key.length === 1)) return false;
    if (e.key === "Escape") { if (!e.repeat) recordKey("back"); }
    else if (e.key.length === 1 && !e.altKey) recordText(e.key);
    else if (e.key === "Enter") recordKey("enter");
    else if (e.key === "Tab") recordKey("tab");
    else if (e.key === "Backspace") recordBackspace();
    else return false;
    e.preventDefault();
    return true;
  }
  function capturePaste(text) {
    if (!ui.recording || ui.running) return false;
    recordText(text);
    return true;
  }
  // The scroll wheel becomes one swipe per burst of wheel movement.
  function captureWheel(e, at) {
    if (!capturing() || ui.running) return false;
    if (ui.picking) return true;
    wheelAcc ||= { x: at.x, y: at.y, dx: 0, dy: 0 };
    wheelAcc.dx += e.deltaX; wheelAcc.dy += e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      const a = wheelAcc; wheelAcc = null;
      if (!ui.recording || (!a.dx && !a.dy)) return;
      const vertical = Math.abs(a.dy) >= Math.abs(a.dx);
      const dist = 0.35 * (vertical ? -Math.sign(a.dy) : -Math.sign(a.dx));
      const from = { x: clamp(a.x, 0.1, 0.9), y: clamp(a.y, 0.2, 0.8) };
      const to = vertical ? { x: from.x, y: clamp(from.y + dist, 0.05, 0.95) } : { x: clamp(from.x + dist, 0.05, 0.95), y: from.y };
      enqueue(async (gap) => {
        const step = addStep({ type: "swipe", from, to, ms: 350 }, gap);
        const [w, h] = await screenSize();
        await doSwipe(from.x * w, from.y * h, to.x * w, to.y * h, step.ms);
        await settle();
      });
    }, 220);
    return true;
  }

  // ----- element outline over the mirrored screen -----
  const box = el("div", { className: "at-box", hidden: true });
  function showBox(b, screen) {
    const stage = $("mirrorStage"), canvas = $("mirrorCanvas");
    if (box.parentNode !== stage) stage.append(box);
    const c = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const fx = c.width / screen.w, fy = c.height / screen.h;
    Object.assign(box.style, { left: c.left - s.left + b[0] * fx + "px", top: c.top - s.top + b[1] * fy + "px", width: (b[2] - b[0]) * fx + "px", height: (b[3] - b[1]) * fy + "px" });
    box.hidden = false;
  }
  function hideBox() { box.hidden = true; }
  function flash(b, screen) { showBox(b, screen); clearTimeout(flash.timer); flash.timer = setTimeout(hideBox, 450); }

  // ----- UI -----
  const root = $("atRoot");
  const btn = (label, cls, onClick, props = {}) => {
    const b = el("button", { className: "btn " + cls, type: "button", textContent: label, ...props });
    if (onClick) b.addEventListener("click", () => Promise.resolve(onClick(b)).catch(showError));
    return b;
  };
  const chipFor = (status) => el("span", { className: "chip at-" + status, textContent: { pass: "Passed", fail: "Failed", stopped: "Stopped" }[status] || status });
  const saveText = (text, name, type) => download(new Blob([text], { type }), name);
  const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  function renderRecNote() {
    const box = $("atRecNote"); if (!box) return;
    const parts = [el("div", { textContent: ui.phoneWatch === "off"
      ? "Use the phone screen on the left: click to tap, hold to long-press, drag to swipe, type on your keyboard. (Actions done on the phone itself can't be seen on this phone.)"
      : "Use the app on the phone itself, or on the phone screen on the left: tap, long-press, swipe, type. Every action is added below as a step." })];
    if (ui.badge === "missing" || ui.badge === "outdated") {
      parts.push(el("div", { className: "at-badge" },
        el("span", { textContent: `To show a floating “Recording” badge on the phone, ${ui.badge === "outdated" ? "update" : "install"} the Droid Desk Companion app. ` }),
        btn(ui.badge === "outdated" ? "Update it" : "Install it", "sm", () => badgeOpen(true))));
    } else if (ui.badge === "error") parts.push(el("div", { className: "small", textContent: "The recording badge couldn't be shown on the phone: " + (ui.badgeError || "") }));
    else if (ui.badge === "on") parts.push(el("div", { className: "small", textContent: "The phone shows a floating “Recording” badge. Drag it if it's in the way; it isn't recorded." }));
    box.replaceChildren(...parts);
  }

  function setBusyBadge() {
    const b = $("atBusy"); if (b) b.hidden = !(queued > 0 && ui.recording);
  }

  function renderPhone() {
    const on = !!getMirror();
    $("atIdle").hidden = on;
    $("atNav").hidden = !on;
    const state = $("atState");
    state.className = "chip" + (ui.recording ? " at-rec" : ui.picking ? " warn" : "");
    state.textContent = ui.recording ? "● Recording" : ui.picking ? "Click an element to check" : ui.running ? "Running…" : "";
    state.hidden = !state.textContent;
    $("mirrorStage").classList.toggle("at-pick", !!ui.picking);
  }

  function render() {
    renderPhone();
    const t = openTest();
    root.replaceChildren(t ? renderEditor(t) : renderList());
    if (t) { renderSteps(); renderRecNote(); }
  }

  function reportButtons() {
    if (!ui.lastRuns.length || ui.running) return [];
    return [
      btn("Save report", "sm", () => saveText(buildReport(ui.lastRuns, ui.device), `test-report-${stamp()}.html`, "text/html")),
      btn("JUnit XML", "sm", () => saveText(buildJUnit(ui.lastRuns), `test-results-${stamp()}.xml`, "application/xml"), { title: "For CI systems and test dashboards" }),
    ];
  }

  function newTest() {
    const t = { id: uid(), name: "", app: "", created: Date.now(), updated: Date.now(), steps: [] };
    tests.push(t); save();
    ui.testId = t.id; ui.stepState.clear(); ui.lastRuns = []; ui.openStep = null;
    render();
    // Start with the app that's on the phone's screen right now, unless it's the home screen.
    readScreen().then((s) => {
      if (t.app || !s.pkg || /launcher|systemui|^android$|\.home$/i.test(s.pkg)) return;
      t.app = s.pkg; save();
      const input = $("atApp"); if (input && ui.testId === t.id && !input.value) input.value = t.app;
    }).catch(() => {});
    $("atName")?.focus();
  }

  function importTests(file) {
    file.text().then((text) => {
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : Array.isArray(data.tests) ? data.tests : data.steps ? [data] : [];
      let n = 0;
      for (const t of list) {
        if (!t || !Array.isArray(t.steps)) continue;
        tests.push({
          id: uid(), name: String(t.name || "Imported test"), app: String(t.app || ""), created: Date.now(), updated: Date.now(),
          steps: t.steps.filter((s) => s && typeof s.type === "string").map((s) => ({ ...s, id: uid() })),
        });
        n++;
      }
      if (!n) throw new Error("No tests found in that file");
      save(); render(); toast(`Imported ${n} test${n === 1 ? "" : "s"}`);
    }).catch((e) => showError(new Error("Couldn't import: " + e.message)));
  }
  const exportable = (t) => ({ name: t.name, app: t.app, steps: t.steps.map(({ id, ...s }) => s) });

  function renderList() {
    const card = el("div", { className: "card" });
    const file = el("input", { type: "file", accept: ".json,application/json", hidden: true });
    file.addEventListener("change", () => { if (file.files[0]) importTests(file.files[0]); file.value = ""; });
    const bar = el("div", { className: "toolbar" },
      btn("New test", "primary", newTest, { disabled: ui.running }),
      ui.running ? btn("■ Stop", "", () => { ui.stop = true; }) : btn("▶ Run all", "", () => runTests(tests.filter((t) => t.steps.length)), { disabled: !tests.some((t) => t.steps.length) }),
      btn("Import…", "sm", () => file.click()), file,
      btn("Export all", "sm", () => saveText(JSON.stringify({ droidDeskTests: 1, tests: tests.map(exportable) }, null, 2), `tests-${stamp()}.json`, "application/json"), { disabled: !tests.length }),
    );
    card.append(bar);
    if (ui.lastRuns.length && !ui.running) {
      const pass = ui.lastRuns.filter((r) => r.status === "pass").length;
      card.append(el("div", { className: "at-summary " + (pass === ui.lastRuns.length ? "ok" : "bad") },
        el("b", { textContent: `${pass} of ${ui.lastRuns.length} passed` }),
        el("span", { className: "small", textContent: " · " + secs(ui.lastRuns.reduce((a, r) => a + r.ms, 0)) }),
        el("span", { className: "at-grow" }), ...reportButtons()));
    }
    if (!tests.length) {
      card.append(el("div", { className: "at-empty" },
        el("p", {}, el("b", { textContent: "Record a test once, then run it whenever the app changes." })),
        el("ul", { className: "muted" },
          el("li", { textContent: "Click New test, then Record, and use the app on the phone screen shown here: tap, swipe, type." }),
          el("li", { textContent: "Each action becomes a step. Buttons and fields are remembered by their name, not their position, so tests keep working on other screen sizes." }),
          el("li", { textContent: "Add checks (“this text is shown”) where the app must show something. Run plays the steps back and tells you which one failed, with a screenshot." }),
        )));
      return card;
    }
    const rows = el("tbody");
    for (const t of tests) {
      const live = ui.lastRuns.find((r) => r.testId === t.id);
      const status = ui.runningId === t.id ? el("span", { className: "chip warn", textContent: "Running…" })
        : live ? chipFor(live.status) : t.lastRun ? chipFor(t.lastRun.status) : el("span", { className: "muted small", textContent: "Not run yet" });
      if (!live && t.lastRun && ui.runningId !== t.id) status.title = "Last run " + new Date(t.lastRun.at).toLocaleString();
      const open = () => { if (ui.running) return; ui.testId = t.id; ui.stepState.clear(); ui.openStep = null; render(); };
      const name = el("td", { className: "at-name" }, el("div", { className: "appname", textContent: t.name || "Untitled test" }),
        el("div", { className: "muted small", textContent: `${t.steps.length} step${t.steps.length === 1 ? "" : "s"}${t.app ? " · " + t.app : ""}` }));
      name.addEventListener("click", open);
      const del = btn("Delete", "sm danger", null, { disabled: ui.running });
      armedClick(del, () => { tests = tests.filter((x) => x !== t); ui.lastRuns = ui.lastRuns.filter((r) => r.testId !== t.id); save(); render(); });
      rows.append(el("tr", {}, name, el("td", {}, status), el("td", { className: "act" },
        btn("▶ Run", "sm", () => runTests([t]), { disabled: ui.running || !t.steps.length }),
        btn("Open", "sm", open, { disabled: ui.running }), del)));
    }
    card.append(el("table", {}, rows));
    return card;
  }

  async function loadPackages() {
    if (ui.packages) return ui.packages;
    let out = await sh("pm list packages -3 --user 0 2>/dev/null");
    if (!/package:/.test(out)) out = await sh("pm list packages -3");
    ui.packages = out.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean).sort();
    return ui.packages;
  }

  function renderEditor(t) {
    const wrap = el("div");
    const card = el("div", { className: "card" });
    const locked = ui.running;
    const name = el("input", { type: "text", id: "atName", value: t.name, placeholder: "Test name, e.g. Log in with a wrong password", disabled: locked });
    name.addEventListener("input", () => { t.name = name.value; t.updated = Date.now(); save(); });
    card.append(el("div", { className: "toolbar" },
      btn("← All tests", "sm", () => { stopRecording(); cancelPick(); ui.testId = null; render(); }, { disabled: locked }), name));

    const list = el("datalist", { id: "atPkgs" });
    const app = el("input", { type: "text", id: "atApp", className: "mono", value: t.app, placeholder: "App to test (package name)", disabled: locked, spellcheck: false });
    app.setAttribute("list", "atPkgs");
    app.addEventListener("input", () => { t.app = app.value.trim(); save(); });
    app.addEventListener("focus", () => loadPackages().then((p) => { if (!list.children.length) list.append(...p.map((x) => el("option", { value: x }))); }).catch(() => {}), { once: true });
    card.append(el("div", { className: "toolbar" }, el("span", { className: "muted small", textContent: "App" }), app, list,
      btn("Use the app on screen", "sm", async () => {
        const s = await readScreen();
        if (!s.pkg) throw new Error("Couldn't tell which app is on the screen");
        t.app = app.value = s.pkg; save();
      }, { disabled: locked })));

    const main = el("div", { className: "toolbar" });
    if (ui.recording) main.append(btn("■ Stop recording", "rec-on", stopRecording), el("span", { className: "chip warn", id: "atBusy", hidden: true, textContent: "Working on the phone…" }));
    else main.append(btn("● Record", "primary", startRecording, { disabled: locked, title: t.steps.length ? "New steps are added after the last one" : "" }));
    if (ui.running) main.append(btn("■ Stop", "", () => { ui.stop = true; }));
    else main.append(btn("▶ Run", "", () => runTests([t]), { disabled: !t.steps.length || ui.recording }));
    main.append(el("span", { className: "at-grow" }),
      btn("Export", "sm", () => saveText(JSON.stringify(exportable(t), null, 2), `${(t.name || "test").replace(/[^\w-]+/g, "_").slice(0, 40)}.json`, "application/json"), { disabled: !t.steps.length }));
    card.append(main);

    const add = (label, title, fn) => btn(label, "sm", fn, { disabled: locked, title });
    const addHere = async (step, open = false) => {
      const put = () => { const s = addStep(step, 0); ui.openStep = open && s ? s.id : null; renderSteps(true); };
      if (ui.recording) await enqueue(async () => put()); else put();
    };
    card.append(el("div", { className: "toolbar at-add" }, el("span", { className: "muted small", textContent: "Add" }),
      ui.picking ? btn("Cancel check", "sm", cancelPick)
        : add("Check element…", "Then click something on the phone screen: the test fails if it isn't shown", () => startPick("assertVisible")),
      add("Check text", "The test fails if this text isn't on the screen", () => addHere({ type: "assertVisible", target: { t: "", mode: "contains" } }, true)),
      add("Wait", "Pause for a fixed time", () => addHere({ type: "wait", ms: 2000 })),
      add("Screenshot", "Saved into the report", () => addHere({ type: "shot" })),
      add("Open app", "Start (or restart) an app", () => addHere({ type: "launch", pkg: t.app, fresh: true })),
      add("Back", "", () => (ui.recording ? recordKey("back") : addHere({ type: "key", key: "back" }))),
      add("Enter", "The keyboard's Enter / Search / Done key", () => (ui.recording ? recordKey("enter") : addHere({ type: "key", key: "enter" }))),
    ));
    if (ui.recording) card.append(el("div", { className: "notice at-hint", id: "atRecNote" }));

    const run = ui.lastRuns.find((r) => r.testId === t.id);
    if (run && !ui.running) {
      const failed = run.steps.find((s) => s.status === "fail");
      card.append(el("div", { className: "at-summary " + (run.status === "pass" ? "ok" : "bad") },
        el("b", { textContent: run.status === "pass" ? "Passed" : run.status === "stopped" ? "Stopped" : `Failed at step ${run.steps.indexOf(failed) + 1}` }),
        el("span", { className: "small", textContent: " · " + secs(run.ms) }), el("span", { className: "at-grow" }), ...reportButtons()));
      if (failed?.shot) {
        const img = el("img", { className: "at-shot", src: failed.shot, alt: "The phone screen when the step failed" });
        card.append(el("details", { className: "at-fail" }, el("summary", { textContent: "Screen when it failed" }), img));
      }
    }
    card.append(el("ol", { className: "at-steps", id: "atSteps" }));
    wrap.append(card);
    return wrap;
  }

  const ICON = { tap: "●", long: "◉", swipe: "⇅", type: "⌨", key: "⏎", wait: "⏱", assertVisible: "✓", assertGone: "✕", launch: "▶", shot: "▣" };
  function stepStatus(li, id) {
    const st = ui.stepState.get(id) || {};
    li.dataset.status = st.status || "";
    const badge = li.querySelector(".at-st");
    badge.textContent = st.status === "run" ? "…" : st.status === "pass" ? "✓ " + secs(st.ms) : st.status === "fail" ? "✗ failed" : "";
    const err = li.querySelector(".at-err");
    err.textContent = st.error || ""; err.hidden = !st.error;
  }
  function paintStep(id) {
    const li = $("atSteps")?.querySelector(`[data-id="${id}"]`);
    if (!li) return;
    stepStatus(li, id);
    if (ui.stepState.get(id)?.status === "run") li.scrollIntoView({ block: "nearest" });
  }

  function renderSteps(scrollToEnd = false) {
    const t = openTest(), ol = $("atSteps");
    if (!t || !ol) return;
    const locked = ui.running;
    ol.replaceChildren();
    if (!t.steps.length) {
      ol.append(el("li", { className: "at-none muted", textContent: ui.recording ? "Waiting for your first action on the phone screen…" : "No steps yet. Click ● Record and use the app, or add steps with the buttons above." }));
      return;
    }
    t.steps.forEach((s, i) => {
      const li = el("li", { className: "at-step" });
      li.dataset.id = s.id;
      const detail = s.target && s.by !== "position" ? selectorDetail(s.target) : s.type === "tap" || s.type === "long" ? "by position on the screen" : "";
      const head = el("div", { className: "at-head" },
        el("span", { className: "at-n", textContent: i + 1 }),
        el("span", { className: "at-ic", textContent: ICON[s.type] || "•" }),
        el("div", { className: "at-txt" }, el("div", { textContent: describeStep(s) }), detail ? el("div", { className: "muted small", textContent: detail }) : ""),
        el("span", { className: "at-st small" }));
      if (!locked) {
        const move = (d) => { const j = i + d; if (j < 0 || j >= t.steps.length) return; [t.steps[i], t.steps[j]] = [t.steps[j], t.steps[i]]; save(); renderSteps(); };
        const tools = el("span", { className: "at-tools" },
          btn("↑", "sm", () => move(-1), { title: "Move up", disabled: i === 0 }),
          btn("↓", "sm", () => move(1), { title: "Move down", disabled: i === t.steps.length - 1 }),
          btn("✕", "sm", () => { t.steps.splice(i, 1); ui.stepState.delete(s.id); save(); renderSteps(); }, { title: "Delete this step" }));
        tools.addEventListener("click", (e) => e.stopPropagation());
        head.append(tools);
        head.addEventListener("click", () => { ui.openStep = ui.openStep === s.id ? null : s.id; renderSteps(); });
      }
      li.append(head, el("div", { className: "at-err small", hidden: true }));
      if (ui.openStep === s.id && !locked) li.append(stepEditor(t, s));
      stepStatus(li, s.id);
      ol.append(li);
    });
    if (scrollToEnd) ol.lastElementChild?.scrollIntoView({ block: "nearest" });
  }

  function stepEditor(t, s) {
    const box = el("div", { className: "at-edit" });
    box.addEventListener("click", (e) => e.stopPropagation());
    const changed = () => { t.updated = Date.now(); save(); const li = box.closest("li"); if (li) li.querySelector(".at-txt").firstChild.textContent = describeStep(s); };
    const field = (label, input) => el("label", { className: "at-f" }, el("span", { className: "muted small", textContent: label }), input);
    const text = (label, get, set, props = {}) => {
      const i = el("input", { type: "text", value: get() ?? "", spellcheck: false, ...props });
      i.addEventListener("input", () => { set(i.value); changed(); });
      return field(label, i);
    };
    const number = (label, get, set, props = {}) => {
      const i = el("input", { type: "number", value: get(), min: 0, step: "any", ...props });
      i.addEventListener("input", () => { const v = Number(i.value); if (isFinite(v) && v >= 0) { set(v); changed(); } });
      return field(label, i);
    };
    const check = (label, get, set) => {
      const i = el("input", { type: "checkbox", checked: !!get() });
      i.addEventListener("change", () => { set(i.checked); changed(); });
      return el("label", { className: "at-c small" }, i, " " + label);
    };
    const select = (label, options, get, set) => {
      const i = el("select", {}, ...options.map(([v, l]) => el("option", { value: v, textContent: l })));
      i.value = get();
      i.addEventListener("change", () => { set(i.value); changed(); renderSteps(); });
      return field(label, i);
    };
    const selectorFields = () => {
      const sel = (s.target ||= {});
      const put = (k) => (v) => { if (v) sel[k] = v; else delete sel[k]; };
      return [
        text("Text", () => sel.t, put("t")),
        select("Text must", [["", "match exactly"], ["contains", "be contained (any case)"]], () => sel.mode || "", (v) => { if (v) sel.mode = v; else delete sel.mode; }),
        text("Resource id", () => sel.i, put("i"), { className: "mono" }),
        text("Description", () => sel.d, put("d")),
        number("Which match (1 = first)", () => (sel.nth || 0) + 1, (v) => { const n = Math.max(1, Math.round(v)) - 1; if (n) sel.nth = n; else delete sel.nth; }, { min: 1, step: 1 }),
      ];
    };
    const timeout = () => number("Wait up to (seconds)", () => s.timeout || DEFAULT_TIMEOUT, (v) => { if (v && v !== DEFAULT_TIMEOUT) s.timeout = v; else delete s.timeout; });
    switch (s.type) {
      case "tap": case "long":
        if (s.target) {
          const opts = [["element", "the element (recommended)"]];
          if (s.at) opts.push(["position", "the position on the screen"]);
          box.append(select("Find by", opts, () => (s.by === "position" ? "position" : "element"), (v) => { if (v === "position") s.by = "position"; else delete s.by; }));
        }
        if (s.target && s.by !== "position") box.append(...selectorFields(), timeout());
        else box.append(el("div", { className: "muted small", textContent: `Taps at ${pct(s.at.x)} across, ${pct(s.at.y)} down. Nothing with a name was found there when recording, so this step depends on the screen layout.` }));
        break;
      case "type": box.append(text("Text to type", () => s.text, (v) => { s.text = v; }, { className: "at-wide" }));
        if (s.secret) box.append(el("div", { className: "muted small", textContent: "This was typed into a password field on the phone, which hides what is typed. Enter the password here; it is stored in the test as plain text." }));
        break;
      case "wait": box.append(number("Seconds", () => s.ms / 1000, (v) => { s.ms = Math.round(v * 1000); })); break;
      case "key": box.append(select("Key", Object.entries(KEYS).map(([k, v]) => [k, v[1]]), () => s.key, (v) => { s.key = v; })); break;
      case "assertVisible": case "assertGone":
        box.append(select("The test fails unless it is", [["assertVisible", "shown"], ["assertGone", "not shown"]], () => s.type, (v) => { s.type = v; }), ...selectorFields(), timeout());
        break;
      case "launch":
        box.append(text("App (package name)", () => s.pkg, (v) => { s.pkg = v.trim(); }, { className: "mono at-wide" }),
          check("Close it first, so it starts from its first screen", () => s.fresh, (v) => { s.fresh = v; }),
          check("Erase the app's data first (signs out, resets everything in the app)", () => s.clear, (v) => { s.clear = v; }));
        break;
      case "swipe":
        box.append(number("Duration (seconds)", () => (s.ms || 300) / 1000, (v) => { s.ms = clamp(Math.round(v * 1000), 80, 5000); }),
          el("div", { className: "muted small", textContent: `From ${pct(s.from.x)}, ${pct(s.from.y)} to ${pct(s.to.x)}, ${pct(s.to.y)} of the screen.` }));
        break;
      default: box.append(el("div", { className: "muted small", textContent: "Nothing to change for this step." }));
    }
    return box;
  }

  // phone-side buttons
  $("atStart").addEventListener("click", () => showPhone().catch(showError));
  $("atNav").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-k]"); if (!b || ui.running) return;
    if (b.dataset.k === "stop") { stopRecording(); cancelPick(); stopMirror(); return; }
    if (ui.recording) recordKey(b.dataset.k);
    else doKey(b.dataset.k).catch(showError);
  });

  return {
    load() { render(); getHelper().catch(() => {}); },
    /** Called on every tab change: the mirror picture lives in whichever tab is open. */
    onShow(view) {
      const stage = $("mirrorStage");
      if (view === "tests") { if (stage.parentNode !== $("atSlot")) $("atSlot").append(stage); }
      else {
        if (stage.parentNode === $("atSlot")) $("mirrorIdle").after(stage);
        stopRecording(); cancelPick();
      }
    },
    onMirror(on) { if (!on) { stopRecording(); cancelPick(); } renderPhone(); },
    onDisconnected() {
      if (ui.running) { ui.stop = true; ui.gen++; ui.running = false; ui.runningId = null; }
      helper?.die(); helper = null; helperBroken = false; helperFails = 0; helperRetryAt = 0; sizeCache = null; lastSize = null;
      ui.packages = null; ui.device = ""; queue = Promise.resolve(); queued = 0;
      stopRecording(); cancelPick(); render();
    },
    stopHelper,
    capturePointer, captureKey, capturePaste, captureWheel,
    _debug: { readScreen, tests: () => tests, ui, getHelper, ask, settle, flattenXml, findOne, pickTarget, buildReport, buildJUnit, parseTouchDevices, touchTracker, panelToScreen },
  };
}
