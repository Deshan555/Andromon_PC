// Andromon — Repair › Hardware test: a checklist of the phone's parts. Each one is checked by the
// technician (Works / Faulty / Skip), helped by the computer:
//  - "found" checks: whether the phone has the part at all (sensors, NFC, fingerprint…), read once;
//  - live checks: SIM, Wi‑Fi, Bluetooth, charging, read again on demand;
//  - buttons: pressing Power or a volume key on the phone marks it as working by itself (getevent);
//  - actions: a button that makes the phone do something to look or listen for (vibrate, play a
//    sound, open the camera, show touches).
// Results are saved to the job in hand and printed with its report.

import { saveJob } from "./store.js";

// [id, name, group, how]
const ITEMS = [
  ["touch", "Touch screen", "Screen", "Touch every part of the screen. “Show touches” draws a trail where the screen feels a finger."],
  ["multitouch", "Several fingers at once", "Screen", "Put 2 to 5 fingers on the screen: each should leave its own trail."],
  ["display", "Display (dead pixels, lines, colours)", "Screen", "Open Andromon Companion › Hardware › Screen on the phone, or look at a white and a dark picture."],
  ["power", "Power button", "Buttons", "Press it once: it is marked by itself."],
  ["volup", "Volume up", "Buttons", "Press it once: it is marked by itself."],
  ["voldown", "Volume down", "Buttons", "Press it once: it is marked by itself."],
  ["vibrate", "Vibration", "Sound", "Click Vibrate and feel it."],
  ["speaker", "Loudspeaker", "Sound", "Click Play a sound (turn the volume up first)."],
  ["earpiece", "Earpiece", "Sound", "Make a call, or use the phone maker's test menu (Samsung: dial *#0*#)."],
  ["mic", "Microphone", "Sound", "Record a voice note and play it back."],
  ["rearcam", "Rear camera", "Camera", "Click Open the camera; take a photo, check focus."],
  ["frontcam", "Front camera", "Camera", "Switch to the front camera and take a photo."],
  ["flash", "Flashlight", "Camera", "Switch the torch on in quick settings."],
  ["proximity", "Proximity sensor", "Sensors", "In a call, cover the top of the screen: it should go dark."],
  ["light", "Light sensor", "Sensors", "With auto brightness on, cover the top of the phone."],
  ["motion", "Accelerometer and gyroscope", "Sensors", "Turn the phone: the screen should rotate."],
  ["compass", "Compass", "Sensors", "Open a map and turn around."],
  ["fingerprint", "Fingerprint reader", "Security", "Add or use a fingerprint."],
  ["face", "Face unlock", "Security", "Use face unlock, where the phone has it."],
  ["sim", "SIM and mobile network", "Connections", "A SIM should be found, and show signal."],
  ["wifi", "Wi‑Fi", "Connections", "Connect to a network."],
  ["bt", "Bluetooth", "Connections", "Turn it on and find a device."],
  ["gps", "GPS", "Connections", "Open a map outdoors: the location should settle."],
  ["nfc", "NFC", "Connections", "Hold a card or another phone to the back."],
  ["charging", "Charging port", "Power", "Plug in a charger: the phone should say it is charging. See the Charging tab for the current."],
  ["jack", "Headphone jack", "Power", "Plug in headphones and play a sound."],
];
const FEATURES = { nfc: "android.hardware.nfc", fingerprint: "android.hardware.fingerprint", face: "android.hardware.biometrics.face", jack: "android.hardware.audio.output",
  gps: "android.hardware.location.gps", flash: "android.hardware.camera.flash", frontcam: "android.hardware.camera.front", rearcam: "android.hardware.camera", bt: "android.hardware.bluetooth" };
const SENSORS = { proximity: /proximity/i, light: /\blight\b/i, motion: /accelerometer|gyroscope/i, compass: /magnetic|orientation/i };

export function mount(root, ctx) {
  const { el, toast, showError, busy, sh } = ctx;
  let results = {}; // id -> { state: "pass"|"fail"|"skip"|"na", note, auto }
  let found = {};   // id -> true (the phone has it) | false (it doesn't) | text (live state)
  let keys = null;  // the running getevent
  let touchesOn = false;
  const list = el("div", { className: "rp-tests" });
  const top = el("div");

  function loadFromJob() { const j = ctx.job(); results = structuredClone(j?.tests?.results || {}); }

  async function detect() {
    if (!ctx.getAdb()) return;
    const [features, sensors, sim, wifi, bt, batt] = await Promise.all([
      sh("pm list features").catch(() => ""), sh("dumpsys sensorservice 2>/dev/null | head -n 120").catch(() => ""),
      sh("getprop gsm.sim.state; getprop gsm.operator.alpha").catch(() => ""), sh("cmd wifi status 2>/dev/null | head -n 3").catch(() => ""),
      sh("settings get global bluetooth_on").catch(() => ""), sh("dumpsys battery").catch(() => ""),
    ]);
    const has = (f) => new RegExp(`feature:${f.replace(/\./g, "\\.")}$`, "m").test(features);
    found = {};
    for (const [id, f] of Object.entries(FEATURES)) found[id] = has(f);
    for (const [id, rx] of Object.entries(SENSORS)) found[id] = rx.test(sensors);
    const [simState, op] = sim.split("\n").map((s) => s.trim());
    found.sim = /READY|LOADED/.test(simState) ? `SIM ready${op ? ` · ${op.replace(/,+$/, "")}` : ""}` : simState ? `SIM: ${simState.toLowerCase().replace(/_/g, " ")}` : "No SIM found";
    found.wifi = /enabled/i.test(wifi) ? (/connected to "?([^"\n]+)/i.exec(wifi) ? "On · connected" : "On") : wifi ? "Off" : "";
    found.bt = bt.trim() === "1" ? "On" : bt.trim() === "0" ? "Off" : found.bt;
    const plugged = ["AC", "USB", "Wireless"].filter((k) => new RegExp(`${k} powered: true`).test(batt));
    found.charging = plugged.length ? `Powered by ${plugged.join(", ")}` : "Not plugged in";
    // Parts this phone doesn't have count as "not on this phone", unless already marked by hand.
    for (const [id, v] of Object.entries(found)) if (v === false && !results[id]) results[id] = { state: "na", auto: true };
    draw();
  }

  // Power and volume keys pressed on the phone, as the kernel reports them.
  async function watchKeys() {
    if (keys || !ctx.getAdb()) return;
    const proc = await ctx.getAdb().subprocess.noneProtocol.spawn("getevent -lq 2>/dev/null");
    keys = proc;
    (async () => {
      const reader = proc.output.getReader(), dec = new TextDecoder(); let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            const m = line.match(/KEY_(POWER|VOLUMEUP|VOLUMEDOWN)\s+DOWN/);
            if (!m) continue;
            const id = { POWER: "power", VOLUMEUP: "volup", VOLUMEDOWN: "voldown" }[m[1]];
            if (results[id]?.state !== "pass") { results[id] = { state: "pass", auto: true, note: "Pressed on the phone" }; toast(`${ITEMS.find((x) => x[0] === id)[1]} works`); draw(); }
          }
        }
      } catch {}
      if (keys === proc) keys = null;
    })();
  }
  function stopKeys() { const k = keys; keys = null; try { k?.kill(); } catch {} }
  async function setTouches(on) {
    touchesOn = on;
    await sh(`settings put system pointer_location ${on ? 1 : 0}`).catch(showError);
  }

  const ACTIONS = {
    touch: ["Show touches", async () => { await setTouches(!touchesOn); draw(); }],
    multitouch: ["Show touches", async () => { await setTouches(!touchesOn); draw(); }],
    vibrate: ["Vibrate", () => sh("cmd vibrator_manager synced oneshot 800 2>/dev/null || cmd vibrator vibrate 800 andromon 2>/dev/null")],
    speaker: ["Play a sound", () => sh("cmd notification post -S bigtext -t 'Andromon' andromon-speaker 'Speaker test' 2>/dev/null; sleep 4; cmd notification cancel andromon-speaker 2>/dev/null")],
    rearcam: ["Open the camera", () => sh("am start -a android.media.action.STILL_IMAGE_CAMERA")],
    frontcam: ["Open the camera", () => sh("am start -a android.media.action.STILL_IMAGE_CAMERA")],
    flash: ["Open quick settings", () => sh("cmd statusbar expand-settings")],
    gps: ["Open location settings", () => sh("am start -a android.settings.LOCATION_SOURCE_SETTINGS")],
    nfc: ["Open NFC settings", () => sh("am start -a android.settings.NFC_SETTINGS")],
    bt: ["Open Bluetooth settings", () => sh("am start -a android.settings.BLUETOOTH_SETTINGS")],
    wifi: ["Open Wi‑Fi settings", () => sh("am start -a android.settings.WIFI_SETTINGS")],
    mic: ["Open the voice recorder", () => sh("am start -a android.provider.MediaStore.RECORD_SOUND")],
    charging: ["Open the Charging tab", () => ctx.openTab("charging")],
  };

  function draw() {
    const job = ctx.job();
    const counts = { pass: 0, fail: 0 };
    for (const r of Object.values(results)) if (counts[r.state] != null) counts[r.state]++;
    const save = el("button", { className: "btn primary", type: "button", textContent: "Save results to the job", disabled: !job });
    save.onclick = async () => {
      const named = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { ...r, name: ITEMS.find((x) => x[0] === id)?.[1] || id }]));
      job.tests = { at: Date.now(), results: named };
      await saveJob(job, `Hardware test: ${counts.pass} working, ${counts.fail} faulty`); ctx.refreshJobs(); toast(`Saved to ${job.number}`);
    };
    const check = el("button", { className: "btn", type: "button", textContent: "Check the phone again" });
    check.onclick = async () => { busy(check, true, "Checking…"); try { await detect(); } catch (e) { showError(e); } finally { if (check.isConnected) busy(check, false); } };
    const clear = el("button", { className: "btn", type: "button", textContent: "Start over" });
    clear.onclick = () => { results = {}; detect().catch(showError); draw(); };
    top.replaceChildren(el("div", { className: "card" },
      el("p", { className: "muted", style: "margin-top:0", textContent: `${counts.pass} working · ${counts.fail} faulty · ${ITEMS.length - counts.pass - counts.fail} to go. Press the phone's Power and volume buttons and they are ticked by themselves.${job ? ` Saved to ${job.number}.` : " Pick the job in hand at the top to save the results."}` }),
      el("div", { className: "toolbar", style: "margin:0" }, save, check, clear),
      touchesOn ? el("div", { className: "notice", style: "margin:12px 0 0", textContent: "Touch trails are on. They are switched off again when you leave this tab." }) : ""));
    let group = "";
    const rows = [];
    for (const [id, name, g, how] of ITEMS) {
      if (g !== group) { group = g; rows.push(el("div", { className: "rp-tgroup", textContent: g })); }
      const r = results[id] || {};
      const mark = (state) => {
        const b = el("button", { className: "btn sm rp-mark" + (r.state === state ? ` on ${state}` : ""), type: "button", textContent: { pass: "Works", fail: "Faulty", skip: "Skip" }[state] });
        b.onclick = () => { results[id] = r.state === state ? undefined : { state, note: results[id]?.note || "" }; if (!results[id]) delete results[id]; draw(); };
        return b;
      };
      const f = found[id];
      const info = f === true ? "Found on this phone" : f === false ? "This phone doesn't have it" : typeof f === "string" ? f : "";
      const act = ACTIONS[id];
      // Rows without an action keep an empty cell, so the marks line up down the list.
      const actBtn = act ? el("button", { className: "btn sm", type: "button", textContent: id.endsWith("touch") && touchesOn ? "Hide touches" : act[0], disabled: !ctx.getAdb() }) : el("span");
      if (act) actBtn.onclick = () => Promise.resolve(act[1]()).catch(showError);
      const note = el("input", { className: "rp-note", placeholder: "Note", value: r.note || "" });
      note.onchange = () => { results[id] = { ...(results[id] || { state: "" }), note: note.value }; };
      rows.push(el("div", { className: `rp-test ${r.state || ""}` },
        el("div", { className: "rp-test-txt" }, el("b", { textContent: name }), el("div", { className: "muted small", textContent: [info, how].filter(Boolean).join(" · ") })),
        actBtn, note, el("div", { className: "rp-marks" }, mark("pass"), mark("fail"), mark("skip"))));
    }
    list.replaceChildren(...rows);
  }

  root.append(top, el("div", { className: "card" }, list));
  loadFromJob(); draw();
  return {
    show() { loadFromJob(); draw(); watchKeys().catch(console.warn); if (!Object.keys(found).length) detect().catch(console.warn); },
    hide() { stopKeys(); if (touchesOn) setTouches(false); },
    jobChanged() { loadFromJob(); draw(); },
    connected() { found = {}; results = {}; loadFromJob(); if (ctx.isShown("tests")) { watchKeys().catch(console.warn); detect().catch(console.warn); } },
    disconnected() { stopKeys(); touchesOn = false; found = {}; draw(); },
  };
}
