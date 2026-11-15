// The radar on the Wi‑Fi transfer page: this computer in the middle, a beam sweeping round while it
// looks for devices, and every device found as a round button on the rings. Click a device (or drop
// files on it) to send. While files move, dots flow along a line between the two (outwards when
// sending, inwards when receiving) and a ring round the device fills up with the progress.
//
// The radar is built once and then only updated, so its animations never restart when the device
// list is refreshed. Names come from the network: they go in with textContent, never innerHTML.

const SVG = "http://www.w3.org/2000/svg";
const ICONS = {
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  laptop: '<path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"/><path d="M20.054 15.987H3.946"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};
function svgIcon(name) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name];
  return s;
}

// Where devices sit: [angle in degrees (0 = right, clockwise), distance from the middle (0..1)].
// Spread so neighbours don't touch and no label runs under the computer in the middle.
const SLOTS = [[-42, 0.66], [142, 0.66], [22, 0.72], [205, 0.7], [-108, 0.7], [78, 0.74], [-160, 0.74], [-72, 0.4], [112, 0.42], [-8, 0.42]];
const place = (slot) => {
  const [deg, r] = SLOTS[slot % SLOTS.length];
  const a = (deg + Math.floor(slot / SLOTS.length) * 17) * Math.PI / 180;
  return { x: 50 + r * 50 * Math.cos(a), y: 50 + r * 50 * Math.sin(a) };
};

export function initWifiRadar({ el, onPick, onDrop, selfIsMac = false }) {
  const sweep = el("div", { className: "wr-sweep" });
  const links = document.createElementNS(SVG, "svg");
  links.setAttribute("viewBox", "0 0 100 100"); links.setAttribute("class", "wr-links"); links.setAttribute("aria-hidden", "true");
  const meName = el("span", { className: "wr-name", textContent: selfIsMac ? "This Mac" : "This PC" });
  const me = el("div", { className: "wr-me" }, el("span", { className: "wr-av" }, svgIcon("laptop")), meName);
  const stage = el("div", { className: "wr-stage" },
    el("div", { className: "wr-rings" }), sweep, el("div", { className: "wr-ping" }), el("div", { className: "wr-ping wr-ping2" }), links, me);
  const caption = el("div", { className: "wr-cap" });
  caption.setAttribute("aria-live", "polite");
  const node = el("div", { className: "wr off" }, stage, caption);

  const shown = new Map(); // fingerprint -> { btn, ring, pos, slot, device }
  let active = null;       // { fp, dir, link } while files move
  let idleText = "";
  const setCaption = (t) => { if (caption.textContent !== t) caption.textContent = t; };

  function freeSlot() {
    const used = new Set([...shown.values()].map((v) => v.slot));
    let i = 0; while (used.has(i)) i++;
    return i;
  }

  function addDevice(d) {
    const slot = freeSlot(), pos = place(slot);
    const ring = document.createElementNS(SVG, "svg");
    ring.setAttribute("viewBox", "0 0 100 100"); ring.setAttribute("class", "wr-ring"); ring.setAttribute("aria-hidden", "true");
    ring.innerHTML = '<circle cx="50" cy="50" r="47" pathLength="100"/>';
    const name = el("span", { className: "wr-name" });
    const btn = el("button", { className: "wr-dev", type: "button" },
      el("span", { className: "wr-av" }, svgIcon(d.deviceType === "mobile" ? "phone" : d.deviceType === "desktop" ? "laptop" : "server"), ring,
        el("span", { className: "wr-done" }, svgIcon("check"))), name);
    btn.style.left = pos.x + "%"; btn.style.top = pos.y + "%";
    const entry = { btn, ring: ring.firstChild, name, pos, slot, device: d };
    btn.onclick = () => onPick(entry.device);
    btn.addEventListener("dragover", (e) => { e.preventDefault(); btn.classList.add("over"); });
    btn.addEventListener("dragleave", () => btn.classList.remove("over"));
    btn.addEventListener("drop", (e) => {
      e.preventDefault(); btn.classList.remove("over");
      if (e.dataTransfer.files.length) onDrop(entry.device, e.dataTransfer.files);
    });
    stage.append(btn);
    shown.set(d.fingerprint, entry);
    return entry;
  }

  /** Called with the page's state whenever it changes: on or off, and the devices in reach. */
  function update({ running, devices = [], alias }) {
    node.classList.toggle("off", !running);
    node.classList.toggle("searching", !!running && !devices.length);
    if (alias) meName.title = `Other devices see this computer as “${alias}”`;
    const now = new Set(devices.map((d) => d.fingerprint));
    for (const [fp, v] of shown) {
      if (now.has(fp) && running) continue;
      if (active?.fp === fp) continue; // keep it on screen until its transfer ends
      shown.delete(fp);
      v.btn.classList.add("gone"); v.btn.disabled = true;
      setTimeout(() => v.btn.remove(), 350);
    }
    if (running) for (const d of devices) {
      const v = shown.get(d.fingerprint) || addDevice(d);
      v.device = d;
      if (v.name.textContent !== d.alias) v.name.textContent = d.alias;
      const label = `Send files to ${d.alias}`;
      if (v.btn.title !== label) { v.btn.title = label; v.btn.setAttribute("aria-label", label); }
    }
    idleText = !running ? "Off" : !devices.length ? "Looking for devices…" : "Click a device to send files, or drop files on it";
    if (!active) setCaption(idleText);
  }

  function setRing(v, frac) { v.ring.style.strokeDasharray = `${Math.max(0, Math.min(1, frac)) * 100} 100`; }

  /** A transfer with this device is on its way. dir: "out" (sending) or "in" (receiving). */
  function progress(fp, dir, { frac = 0, waiting = false, text = "" } = {}) {
    const v = shown.get(fp);
    if (!v) { if (text) setCaption(text); return; }
    if (!active || active.fp !== fp || active.dir !== dir) {
      end(active?.fp, false, true);
      const link = document.createElementNS(SVG, "line");
      link.setAttribute("x1", 50); link.setAttribute("y1", 50); link.setAttribute("x2", v.pos.x); link.setAttribute("y2", v.pos.y);
      link.setAttribute("class", `wr-link ${dir}`);
      links.append(link);
      active = { fp, dir, link };
      v.btn.classList.remove("done");
      v.btn.classList.add("busy");
      node.classList.add("moving");
    }
    v.btn.classList.toggle("waiting", waiting);
    active.link.classList.toggle("waiting", waiting);
    setRing(v, waiting ? 0 : frac);
    if (text) setCaption(text);
  }

  /** The transfer with this device is over. ok: it finished (a tick shows for a moment). */
  function end(fp, ok = false, quiet = false) {
    if (!active || (fp && active.fp !== fp)) return;
    const v = shown.get(active.fp);
    active.link.remove();
    active = null;
    node.classList.remove("moving");
    if (v) {
      v.btn.classList.remove("busy", "waiting");
      if (ok) {
        setRing(v, 1);
        v.btn.classList.add("done");
        setTimeout(() => { v.btn.classList.remove("done"); setRing(v, 0); }, 1800);
      } else setRing(v, 0);
    }
    if (!quiet) setCaption(idleText);
  }

  return { node, update, progress, end, activeFp: () => active?.fp || null };
}
