// Developer tab › Fake location: pick a place on a map (or search for it, or type its coordinates)
// and make the phone report that position. The map can also show where the phone says it is now.
//
// The map is Leaflet with OpenStreetMap's tiles; search and "what is at this point" use OpenStreetMap's
// Nominatim. Both are free services with rules this file keeps: the "© OpenStreetMap" credit stays on
// the map, a search only runs when asked for (never while typing), and Nominatim gets at most one
// request a second. Nothing is asked of either before this tab is opened.
//
// Faking uses Android's own test providers (`cmd location providers`, Android 12+), after allowing
// mock locations for the shell (uid 2000). Stopping removes the test providers again.
//
// Text from Nominatim and from the phone is untrusted: it goes in with textContent, never innerHTML.

import * as L from "leaflet";

const PLACES = [
  ["London", 51.5072, -0.1276], ["New York", 40.7128, -74.006], ["San Francisco", 37.7749, -122.4194],
  ["Paris", 48.8584, 2.2945], ["Tokyo", 35.6812, 139.7671], ["Sydney", -33.8568, 151.2153],
  ["Colombo", 6.9271, 79.8612], ["Dubai", 25.1972, 55.2744], ["São Paulo", -23.5505, -46.6333],
];
const PROVIDERS = ["gps", "network", "fused"];
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const CREDIT = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const PIN_SVG = '<svg viewBox="0 0 30 40" aria-hidden="true"><path d="M15 1C7.3 1 1 7.2 1 14.9 1 25.3 15 39 15 39s14-13.7 14-24.1C29 7.2 22.7 1 15 1z"/><circle cx="15" cy="15" r="5.5"/></svg>';

const COORDS = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/;
const valid = (la, ln) => Number.isFinite(la) && Number.isFinite(ln) && la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
const fmt = (n) => String(Math.round(n * 1e6) / 1e6);

/** "+1d2h3m4s567ms" (how Android prints a time since boot) in seconds. */
function elapsedSeconds(s) {
  let t = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)(ms|[dhms])/g)) t += Number(n) * { d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 }[unit];
  return t;
}

/**
 * The newest position in `dumpsys location`, or null. Lines look like
 * "last location=Location[fused 6.927100,79.861200 hAcc=12.5 et=+3h2m1s5ms alt=…]".
 */
export function parseLastLocation(dump, uptime = 0) {
  let best = null;
  for (const m of dump.matchAll(/last location=Location\[(\w+) (-?\d+[.,]\d+),(-?\d+[.,]\d+)([^\]\n]*)/g)) {
    const lat = Number(m[2].replace(",", ".")), lng = Number(m[3].replace(",", "."));
    if (!valid(lat, lng)) continue;
    const rest = m[4];
    // "et" is the time since boot when the fix was made. One later than now can't be right (emulators
    // print such fixes), so that fix counts as the oldest.
    let et = elapsedSeconds(rest.match(/\bet=(\S+)/)?.[1] || "");
    if (uptime && et > uptime + 60) et = 0;
    const acc = Number((rest.match(/\bhAcc=([\d.,]+)/)?.[1] || "").replace(",", "."));
    if (!best || et > best.et) best = { lat, lng, et, provider: m[1], acc: acc > 0 ? acc : 0, mock: /\bmock\b/i.test(rest), age: uptime > et && et > 0 ? uptime - et : null };
  }
  return best;
}

function ago(sec) {
  if (sec == null) return "";
  if (sec < 90) return "just now";
  if (sec < 5400) return `${Math.round(sec / 60)} minutes ago`;
  if (sec < 129600) return `${Math.round(sec / 3600)} hours ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

export function mount(root, ctx) {
  const { el, sh, toast, showError, clearError, store } = ctx;

  const lat = el("input", { type: "text", className: "mono loc-coord", placeholder: "Latitude, e.g. 51.5072", ariaLabel: "Latitude" });
  const lng = el("input", { type: "text", className: "mono loc-coord", placeholder: "Longitude, e.g. -0.1276", ariaLabel: "Longitude" });
  const acc = el("input", { type: "number", className: "loc-acc", value: 5, min: 1, max: 5000, title: "Accuracy in metres", ariaLabel: "Accuracy in metres" });
  const setBtn = el("button", { className: "btn primary sm", type: "button", textContent: "Set location" });
  const stopBtn = el("button", { className: "btn sm", type: "button", textContent: "Stop faking" });
  const gpsState = el("div", { className: "loc-state" });
  const pinLabel = el("div", { className: "loc-pinlabel" });
  const phoneLabel = el("div", { className: "loc-phonelabel", hidden: true });
  const mapNote = el("div", { className: "loc-mapnote", hidden: true, textContent: "The map couldn't load. Check this computer's internet connection; typing coordinates still works." });
  const mapBox = el("div", { className: "loc-map" });

  let faking = null; // { lat, lng, acc, timer }
  let map = null, pin = null, phoneDot = null, phoneRing = null;
  let chosen = null; // { lat, lng } the pin
  const last = store.get("gps", null);
  if (last && valid(Number(last.lat), Number(last.lng))) { chosen = { lat: Number(last.lat), lng: Number(last.lng) }; lat.value = fmt(chosen.lat); lng.value = fmt(chosen.lng); acc.value = last.acc || 5; }

  // ---------- Nominatim: one request a second at most, and the newest question wins ----------
  let lastAsk = 0, lookupSeq = 0, lookupTimer = null;
  async function nominatim(path, params) {
    const wait = lastAsk + 1100 - Date.now();
    lastAsk = Math.max(Date.now(), lastAsk + 1100);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const url = `${NOMINATIM}/${path}?${new URLSearchParams({ format: "jsonv2", "accept-language": navigator.language || "en", ...params })}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`OpenStreetMap's search answered with error ${res.status}. Try again in a moment.`);
    return res.json();
  }
  // The name of what's under the pin, asked a moment after the pin stops moving.
  function lookupPin() {
    clearTimeout(lookupTimer);
    const seq = ++lookupSeq, at = chosen;
    lookupTimer = setTimeout(async () => {
      try {
        const r = await nominatim("reverse", { lat: at.lat, lon: at.lng, zoom: 17 });
        if (seq === lookupSeq && r?.display_name) pinLabel.textContent = String(r.display_name);
      } catch { /* the coordinates are label enough */ }
    }, 700);
  }

  // ---------- the pin ----------
  function setPin(la, ln, { name = "", pan = false, zoom = 0, lookup = true } = {}) {
    chosen = { lat: la, lng: ln };
    lat.value = fmt(la); lng.value = fmt(ln);
    pinLabel.textContent = name || `${fmt(la)}, ${fmt(ln)}`;
    lookupSeq++; clearTimeout(lookupTimer);
    if (!name && lookup) lookupPin();
    if (map) {
      if (!pin) {
        pin = L.marker([la, ln], { draggable: true, keyboard: false, title: "Drag to move",
          icon: L.divIcon({ className: "loc-pin", html: PIN_SVG, iconSize: [30, 40], iconAnchor: [15, 39] }) }).addTo(map);
        pin.on("dragend", () => { const p = pin.getLatLng().wrap(); setPin(p.lat, p.lng); });
      } else pin.setLatLng([la, ln]);
      if (pan) map.setView([la, ln], zoom || Math.max(map.getZoom(), 13));
    }
    renderGps();
  }
  const typed = () => {
    const la = Number(lat.value.trim()), ln = Number(lng.value.trim());
    if (lat.value.trim() !== "" && lng.value.trim() !== "" && valid(la, ln)) setPin(la, ln, { pan: true });
  };
  lat.addEventListener("change", typed); lng.addEventListener("change", typed);
  // "51.5, -0.12" or a maps link pasted into either box fills both.
  const splitPaste = (e) => {
    const t = e.clipboardData?.getData("text") || "";
    const m = t.match(COORDS) || t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m && valid(Number(m[1]), Number(m[2]))) { e.preventDefault(); setPin(Number(m[1]), Number(m[2]), { pan: true }); }
  };
  lat.addEventListener("paste", splitPaste); lng.addEventListener("paste", splitPaste);
  for (const box of [lat, lng]) box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); typed(); setBtn.click(); } });

  // ---------- the map: made the first time it is on screen, so nothing is loaded before then ----------
  function makeMap() {
    map = L.map(mapBox, { worldCopyJump: true, zoomControl: true, attributionControl: true });
    map.attributionControl.setPrefix(false);
    const tiles = L.tileLayer(TILES, { maxZoom: 19, attribution: CREDIT }).addTo(map);
    let loaded = false;
    tiles.on("tileload", () => { loaded = true; mapNote.hidden = true; });
    tiles.on("tileerror", () => { if (!loaded) mapNote.hidden = false; });
    if (chosen) { map.setView([chosen.lat, chosen.lng], 13); setPin(chosen.lat, chosen.lng, { lookup: false }); }
    else map.setView([20, 10], 2);
    map.on("click", (e) => { const p = e.latlng.wrap(); setPin(p.lat, p.lng); });
  }
  new ResizeObserver(() => {
    if (!mapBox.clientWidth) return;
    if (!map) makeMap(); else map.invalidateSize();
  }).observe(mapBox);

  // ---------- search ----------
  const q = el("input", { type: "search", className: "loc-q", placeholder: "Search for a place or an address", spellcheck: false, autocomplete: "off", ariaLabel: "Search for a place" });
  const searchBtn = el("button", { className: "btn sm", type: "submit", textContent: "Search" });
  const results = el("div", { className: "loc-results", hidden: true });
  const closeResults = () => { results.hidden = true; results.replaceChildren(); };
  function pick(r) {
    closeResults();
    const la = Number(r.lat), ln = Number(r.lon);
    if (!valid(la, ln)) return;
    setPin(la, ln, { name: String(r.display_name || "") });
    const b = (r.boundingbox || []).map(Number);
    if (map) {
      if (b.length === 4 && b.every(Number.isFinite) && (b[1] - b[0] > 0.002 || b[3] - b[2] > 0.002)) map.fitBounds([[b[0], b[2]], [b[1], b[3]]], { maxZoom: 16 });
      else map.setView([la, ln], 16);
    }
  }
  async function search() {
    const text = q.value.trim();
    if (!text) { q.focus(); return; }
    const m = text.match(new RegExp(`^\\s*${COORDS.source}\\s*$`));
    if (m && valid(Number(m[1]), Number(m[2]))) { closeResults(); setPin(Number(m[1]), Number(m[2]), { pan: true }); return; }
    ctx.busy(searchBtn, true, "Searching…");
    try {
      const list = await nominatim("search", { q: text, limit: 6 });
      clearError();
      results.replaceChildren();
      if (!Array.isArray(list) || !list.length) results.append(el("div", { className: "loc-none", textContent: `Nothing found for “${text}”. Try a city, a street with its town, or a postcode.` }));
      else for (const r of list) {
        const full = String(r.display_name || ""), cut = full.indexOf(",");
        const b = el("button", { type: "button", className: "loc-result" },
          el("strong", { textContent: String(r.name || "") || (cut > 0 ? full.slice(0, cut) : full) }),
          el("span", { textContent: full }));
        b.onclick = () => pick(r);
        results.append(b);
      }
      results.hidden = false;
      if (Array.isArray(list) && list.length === 1) pick(list[0]);
    } catch (e) {
      showError(e instanceof TypeError ? "Couldn't reach OpenStreetMap's search. Check this computer's internet connection." : e);
    } finally { ctx.busy(searchBtn, false); }
  }
  const form = el("form", { className: "loc-search" }, q, searchBtn, results);
  form.addEventListener("submit", (e) => { e.preventDefault(); search(); });
  q.addEventListener("keydown", (e) => { if (e.key === "Escape") closeResults(); });
  document.addEventListener("click", (e) => { if (!results.hidden && !form.contains(e.target)) closeResults(); });

  // ---------- where the phone says it is ----------
  const phoneBtn = el("button", { className: "btn sm", type: "button", textContent: "Show the phone's location", title: "Read the phone's last known position and show it on the map" });
  async function showPhone() {
    const out = await sh("dumpsys location 2>/dev/null | grep 'last location='; echo; echo UPTIME $(cat /proc/uptime)");
    const here = parseLastLocation(out, Number(out.match(/UPTIME (\d+(?:\.\d+)?)/)?.[1]) || 0);
    if (!here) throw new Error("The phone has no position yet. Turn on Location on the phone, open a maps app for a moment, then try again.");
    if (map) {
      phoneRing?.remove(); phoneDot?.remove();
      phoneRing = here.acc ? L.circle([here.lat, here.lng], { radius: here.acc, className: "loc-phone-ring", interactive: false }).addTo(map) : null;
      phoneDot = L.circleMarker([here.lat, here.lng], { radius: 8, className: "loc-phone-dot" }).addTo(map);
      phoneDot.bindTooltip("The phone is here");
      map.setView([here.lat, here.lng], Math.max(map.getZoom(), 15));
    }
    const fake = here.mock;
    phoneLabel.replaceChildren(
      el("span", { className: "loc-dot" }),
      el("span", { textContent: `${fake ? "The phone reports the fake position" : "The phone is at"} ${fmt(here.lat)}, ${fmt(here.lng)}` +
        (here.acc ? ` (within ${Math.round(here.acc)} m${here.age != null ? ", " + ago(here.age) : ""})` : here.age != null ? ` (${ago(here.age)})` : "") }));
    const use = el("button", { className: "btn sm", type: "button", textContent: "Put the pin here" });
    use.onclick = () => setPin(here.lat, here.lng, { pan: true });
    phoneLabel.append(use);
    phoneLabel.hidden = false;
  }
  phoneBtn.onclick = async () => {
    ctx.busy(phoneBtn, true, "Looking…");
    try { await showPhone(); clearError(); } catch (e) { showError(e); } finally { ctx.busy(phoneBtn, false); }
  };
  function clearPhone() { phoneRing?.remove(); phoneDot?.remove(); phoneRing = phoneDot = null; phoneLabel.hidden = true; }

  // ---------- faking ----------
  async function setLocation() {
    const la = Number(lat.value.trim()), ln = Number(lng.value.trim()), ac = Math.max(1, Math.min(5000, Number(acc.value) || 5));
    if (lat.value.trim() === "" || lng.value.trim() === "" || !valid(la, ln))
      throw new Error("Click a place on the map, or enter a latitude between -90 and 90 and a longitude between -180 and 180.");
    if (!chosen || chosen.lat !== la || chosen.lng !== ln) setPin(la, ln, { pan: true });
    const sdk = Number((await sh("getprop ro.build.version.sdk")).trim());
    if (sdk && sdk < 31) throw new Error("Faking the location from the computer needs Android 12 or later.");
    if (!faking) {
      const out = await sh(["appops set 2000 android:mock_location allow",
        ...PROVIDERS.map((p) => `cmd location providers add-test-provider ${p} 2>&1; cmd location providers set-test-provider-enabled ${p} true 2>&1`)].join("; "));
      if (/SecurityException|not allowed/i.test(out)) throw new Error("The phone didn't allow a fake location: " + out.trim().split("\n")[0]);
    }
    const sendFix = () => sh(PROVIDERS.map((p) => `cmd location providers set-test-provider-location ${p} --location ${la},${ln} --accuracy ${ac} 2>&1`).join("; "));
    const out = await sendFix();
    if (/Exception|error/i.test(out)) throw new Error(out.trim().split("\n")[0]);
    clearInterval(faking?.timer);
    // Apps ignore fixes that get old, so the same position is sent again every few seconds.
    faking = { lat: la, lng: ln, acc: ac, timer: setInterval(() => { if (ctx.getAdb()) sendFix().catch(() => {}); }, 4000) };
    store.set("gps", { lat: la, lng: ln, acc: ac }); store.set("gpsOn", true);
    clearPhone(); // what it showed is no longer where the phone says it is
    renderGps();
  }
  async function stopFaking(quiet) {
    clearInterval(faking?.timer); faking = null; store.set("gpsOn", false);
    if (ctx.getAdb()) await sh([...PROVIDERS.map((p) => `cmd location providers remove-test-provider ${p} 2>/dev/null`),
      "appops set 2000 android:mock_location default"].join("; ")).catch(() => {});
    clearPhone();
    renderGps();
    if (!quiet) toast("The phone uses its real location again");
  }
  function renderGps() {
    const first = gpsState.firstChild, text = faking ? `Faking ${faking.lat.toFixed(5)}, ${faking.lng.toFixed(5)}` : "Real location";
    if (!first || first.textContent !== text) gpsState.replaceChildren(el("span", { className: faking ? "chip loc-on" : "chip" }, text));
    stopBtn.disabled = !faking;
    // The pin is filled while the phone is at that very spot.
    pin?.getElement()?.classList.toggle("live", !!faking && !!chosen && faking.lat === chosen.lat && faking.lng === chosen.lng);
  }
  setBtn.onclick = async () => {
    ctx.busy(setBtn, true, "Setting…");
    try { await setLocation(); clearError(); toast("Location set"); } catch (e) { showError(e); } finally { ctx.busy(setBtn, false); }
  };
  stopBtn.onclick = () => stopFaking(false);

  const placeRow = el("div", { className: "dev-row" });
  for (const [name, la, ln] of PLACES) {
    const b = el("button", { className: "chip loc-chip", type: "button", textContent: name });
    b.onclick = () => { setPin(la, ln, { name, pan: true, zoom: 12 }); setBtn.click(); };
    placeRow.append(b);
  }
  if (chosen) pinLabel.textContent = `${fmt(chosen.lat)}, ${fmt(chosen.lng)}`;
  else pinLabel.textContent = "Click the map to drop a pin";
  renderGps();

  root.append(ctx.card("Fake location", gpsState,
    el("div", { className: "loc-top" }, form, phoneBtn),
    el("div", { className: "loc-mapwrap" }, mapBox, mapNote),
    el("div", { className: "loc-under" }, el("span", { className: "dev-lbl", textContent: "Pin" }), pinLabel),
    phoneLabel,
    el("div", { className: "dev-row" }, lat, lng, el("span", { className: "dev-lbl", textContent: "± m" }), acc, setBtn, stopBtn),
    placeRow,
    el("p", { className: "dev-note", textContent: "Click the map, drag the pin, search, or type coordinates, then click “Set location”. Every app on the phone sees that position (GPS, network and fused location) until you click “Stop faking” or Disconnect. Needs Android 12 or later and Location turned on." }),
    el("p", { className: "dev-note", textContent: "The map and the search come from OpenStreetMap: what you search for and the part of the map you look at are sent to openstreetmap.org." })));

  return {
    // Leave the phone as it was: Disconnect stops faking first. If the cable was pulled instead,
    // the test providers are removed the next time a phone connects.
    beforeDisconnect: () => (faking ? stopFaking(true) : null),
    disconnected: () => { clearInterval(faking?.timer); faking = null; clearPhone(); renderGps(); },
    connected: () => { if (store.get("gpsOn", false)) stopFaking(true); },
  };
}
