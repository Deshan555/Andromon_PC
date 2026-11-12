// Developer tab › Input & GPS: type on the phone from the PC keyboard, paste the PC clipboard,
// press system keys, and fake the phone's location.
//
// Typing uses `input text`, which only handles plain ASCII; other characters are reported, not dropped
// silently. Fake location uses Android's own test providers (`cmd location providers`, Android 12+),
// after allowing mock locations for the shell (uid 2000). Stopping removes the test providers again.

const KEYS = [
  ["Back", "KEYCODE_BACK"], ["Home", "KEYCODE_HOME"], ["Recents", "KEYCODE_APP_SWITCH"], ["Menu", "KEYCODE_MENU"],
  ["Enter", "KEYCODE_ENTER"], ["Tab", "KEYCODE_TAB"], ["Backspace", "KEYCODE_DEL"], ["Delete", "KEYCODE_FORWARD_DEL"],
  ["↑", "KEYCODE_DPAD_UP"], ["↓", "KEYCODE_DPAD_DOWN"], ["←", "KEYCODE_DPAD_LEFT"], ["→", "KEYCODE_DPAD_RIGHT"],
  ["Volume +", "KEYCODE_VOLUME_UP"], ["Volume −", "KEYCODE_VOLUME_DOWN"], ["Power", "KEYCODE_POWER"], ["Wake", "KEYCODE_WAKEUP"],
];
const PANELS = [
  ["Notifications", "cmd statusbar expand-notifications"],
  ["Quick settings", "cmd statusbar expand-settings"],
  ["Close panels", "cmd statusbar collapse"],
];
// Live typing: keys that become key events instead of text.
const LIVE_KEYS = {
  Enter: "KEYCODE_ENTER", Backspace: "KEYCODE_DEL", Delete: "KEYCODE_FORWARD_DEL", Tab: "KEYCODE_TAB", Escape: "KEYCODE_BACK",
  ArrowUp: "KEYCODE_DPAD_UP", ArrowDown: "KEYCODE_DPAD_DOWN", ArrowLeft: "KEYCODE_DPAD_LEFT", ArrowRight: "KEYCODE_DPAD_RIGHT",
  Home: "KEYCODE_MOVE_HOME", End: "KEYCODE_MOVE_END",
};
const PLACES = [
  ["London", 51.5072, -0.1276], ["New York", 40.7128, -74.006], ["San Francisco", 37.7749, -122.4194],
  ["Paris", 48.8584, 2.2945], ["Tokyo", 35.6812, 139.7671], ["Sydney", -33.8568, 151.2153],
  ["Colombo", 6.9271, 79.8612], ["Dubai", 25.1972, 55.2744], ["São Paulo", -23.5505, -46.6333],
];
const PROVIDERS = ["gps", "network", "fused"];

export function mount(root, ctx) {
  const { el, sh, shQuote, toast, showError, clearError } = ctx;

  // ---------- typing ----------
  const isAscii = (s) => /^[\x20-\x7e\n\t]*$/.test(s);
  // `input text` turns "%s" into a space, so spaces are sent as %s; a literal "%s" can't be typed.
  const textCmd = (s) => `input text ${shQuote(s.replace(/ /g, "%s"))}`;
  async function typeText(text) {
    if (!text) return;
    const bad = [...new Set(text.replace(/[\x20-\x7e\n\t]/g, ""))];
    if (bad.length) throw new Error(`Android's typing command only handles plain letters, numbers and symbols. Remove: ${bad.slice(0, 8).join(" ")}${bad.length > 8 ? " …" : ""} (Screen mirror can paste any text).`);
    const cmds = [];
    for (const part of text.split(/(\n|\t)/)) {
      if (part === "\n") cmds.push("input keyevent KEYCODE_ENTER");
      else if (part === "\t") cmds.push("input keyevent KEYCODE_TAB");
      else for (let i = 0; i < part.length; i += 200) cmds.push(textCmd(part.slice(i, i + 200)));
    }
    // Several short commands per shell call keep it fast without making one huge command line.
    for (let i = 0; i < cmds.length; i += 8) await sh(cmds.slice(i, i + 8).join("; "));
  }

  const area = el("textarea", { className: "dev-type", rows: 3, placeholder: "Text to type into the focused field on the phone", spellcheck: false });
  const sendBtn = el("button", { className: "btn primary sm", type: "button", textContent: "Type on phone" });
  const pasteBtn = el("button", { className: "btn sm", type: "button", textContent: "Type PC clipboard" });
  const clearAfter = el("input", { type: "checkbox", checked: true });
  sendBtn.onclick = async () => {
    ctx.busy(sendBtn, true, "Typing…");
    try { await typeText(area.value); clearError(); toast("Typed on the phone"); if (clearAfter.checked) area.value = ""; }
    catch (e) { showError(e); } finally { ctx.busy(sendBtn, false); }
  };
  area.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBtn.click(); } });
  pasteBtn.onclick = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { showError("Couldn't read this computer's clipboard."); return; }
    if (!text) { toast("The clipboard is empty"); return; }
    ctx.busy(pasteBtn, true, "Typing…");
    try { await typeText(text); clearError(); toast(`Typed ${text.length} characters`); }
    catch (e) { showError(e); } finally { ctx.busy(pasteBtn, false); }
  };

  // Live typing: a box that forwards each key as you press it.
  const live = el("input", { type: "text", className: "dev-live", placeholder: "Click here and type: keys go straight to the phone", spellcheck: false, autocomplete: "off" });
  const liveState = el("span", { className: "dev-lbl" });
  let pending = "", queue = Promise.resolve(), flushTimer = null;
  const enqueue = (cmd) => { queue = queue.then(() => sh(cmd)).catch((e) => showError(e)); };
  const flush = () => { clearTimeout(flushTimer); if (pending) { enqueue(textCmd(pending)); pending = ""; } };
  live.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || (e.ctrlKey && e.key !== "Backspace")) return;
    e.preventDefault();
    if (LIVE_KEYS[e.key]) { flush(); enqueue(`input keyevent ${LIVE_KEYS[e.key]}`); return; }
    if (e.key.length !== 1) return;
    if (!isAscii(e.key)) { liveState.textContent = "That character can't be typed this way"; return; }
    liveState.textContent = "";
    pending += e.key;
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 120);
  });
  live.addEventListener("paste", (e) => {
    e.preventDefault(); flush();
    const t = e.clipboardData?.getData("text") || "";
    queue = queue.then(() => typeText(t)).catch((err) => showError(err));
  });
  live.addEventListener("blur", flush);

  const keyRow = el("div", { className: "dev-keys" });
  for (const [label, code] of KEYS) {
    const b = el("button", { className: "btn sm", type: "button", textContent: label });
    b.onclick = () => sh(`input keyevent ${code}`).catch(showError);
    keyRow.append(b);
  }
  const panelRow = el("div", { className: "dev-keys" });
  for (const [label, cmd] of PANELS) {
    const b = el("button", { className: "btn sm", type: "button", textContent: label });
    b.onclick = () => sh(cmd).catch(showError);
    panelRow.append(b);
  }

  root.append(
    ctx.card("Type on the phone", null,
      el("div", { className: "dev-row" }, live), liveState,
      el("div", { className: "dev-row", style: "margin-top:12px" }, area),
      el("div", { className: "dev-row" }, sendBtn, pasteBtn,
        el("label", { className: "dev-check" }, clearAfter, " Clear after typing")),
      el("p", { className: "dev-note", textContent: "Tap a text field on the phone first. Ctrl/⌘ + Enter types the box. Only plain English letters, numbers and symbols work this way." })),
    ctx.card("Keys & panels", null, keyRow, panelRow));

  // ---------- fake location ----------
  const lat = el("input", { type: "text", className: "mono dev-coord", placeholder: "Latitude, e.g. 51.5072" });
  const lng = el("input", { type: "text", className: "mono dev-coord", placeholder: "Longitude, e.g. -0.1276" });
  const acc = el("input", { type: "number", className: "dev-acc", value: 5, min: 1, max: 5000, title: "Accuracy in metres" });
  const setBtn = el("button", { className: "btn primary sm", type: "button", textContent: "Set location" });
  const stopBtn = el("button", { className: "btn sm", type: "button", textContent: "Stop faking" });
  const gpsState = el("div", { className: "dev-gps-state" });
  const placeRow = el("div", { className: "dev-row" });
  for (const [name, la, ln] of PLACES) {
    const b = el("button", { className: "chip dev-chip", type: "button", textContent: name });
    b.onclick = () => { lat.value = la; lng.value = ln; setBtn.click(); };
    placeRow.append(b);
  }
  // "51.5, -0.12" or a maps link pasted into either box fills both.
  const splitPaste = (e) => {
    const t = e.clipboardData?.getData("text") || "";
    const m = t.match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/) || t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) { e.preventDefault(); lat.value = m[1]; lng.value = m[2]; }
  };
  lat.addEventListener("paste", splitPaste); lng.addEventListener("paste", splitPaste);

  let faking = null; // { lat, lng, acc, timer }
  const store = ctx.store;
  const last = store.get("gps", null);
  if (last) { lat.value = last.lat; lng.value = last.lng; acc.value = last.acc || 5; }

  async function setLocation() {
    const la = Number(String(lat.value).trim()), ln = Number(String(lng.value).trim()), ac = Math.max(1, Math.min(5000, Number(acc.value) || 5));
    if (!(la >= -90 && la <= 90) || !(ln >= -180 && ln <= 180) || String(lat.value).trim() === "" || String(lng.value).trim() === "")
      throw new Error("Enter a latitude between -90 and 90 and a longitude between -180 and 180.");
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
    renderGps();
  }
  async function stopFaking(quiet) {
    clearInterval(faking?.timer); faking = null; store.set("gpsOn", false);
    if (ctx.getAdb()) await sh([...PROVIDERS.map((p) => `cmd location providers remove-test-provider ${p} 2>/dev/null`),
      "appops set 2000 android:mock_location default"].join("; ")).catch(() => {});
    renderGps();
    if (!quiet) toast("The phone uses its real location again");
  }
  function renderGps() {
    gpsState.replaceChildren(faking
      ? el("span", { className: "chip dev-on" }, `Faking ${faking.lat.toFixed(5)}, ${faking.lng.toFixed(5)}`)
      : el("span", { className: "chip" }, "Real location"));
    stopBtn.disabled = !faking;
  }
  setBtn.onclick = async () => {
    ctx.busy(setBtn, true, "Setting…");
    try { await setLocation(); clearError(); toast("Location set"); } catch (e) { showError(e); } finally { ctx.busy(setBtn, false); }
  };
  stopBtn.onclick = () => stopFaking(false);
  renderGps();

  root.append(ctx.card("Fake location", gpsState,
    el("div", { className: "dev-row" }, lat, lng, el("span", { className: "dev-lbl", textContent: "± m" }), acc, setBtn, stopBtn),
    placeRow,
    el("p", { className: "dev-note", textContent: "Every app on the phone sees this position (GPS, network and fused location) until you click “Stop faking” or Disconnect. Paste “lat, long” from a map into either box. Needs Android 12 or later and Location turned on." })));

  return {
    hide: flush,
    // Leave the phone as it was: Disconnect stops faking first. If the cable was pulled instead,
    // the test providers are removed the next time a phone connects.
    beforeDisconnect: () => (faking ? stopFaking(true) : null),
    disconnected: () => { clearInterval(faking?.timer); faking = null; renderGps(); pending = ""; },
    connected: () => { if (store.get("gpsOn", false)) stopFaking(true); },
  };
}
