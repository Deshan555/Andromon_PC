// Andromon — Repair › Parts: what the phone's software says about its parts (screen, battery,
// cameras, touch panel, fingerprint reader). Saved before and after a repair, the two lists show
// which parts the phone sees as changed: a new battery has a new serial number, a new screen often
// another panel id. How much a phone tells differs a lot by maker (Samsung and Pixel tell most);
// it is a help to spot a swapped or non-original part, not proof.

import { saveJob } from "./store.js";

// [label, command]. Each prints one value or nothing; files that aren't there are skipped.
const PROBES = [
  ["Screen", "Panel type (Samsung)", "cat /sys/class/lcd/panel/lcd_type 2>/dev/null"],
  ["Screen", "Panel window (Samsung)", "cat /sys/class/lcd/panel/window_type 2>/dev/null"],
  ["Screen", "Panel name", "cat /sys/class/drm/card0-DSI-1/panel_name /sys/class/graphics/fb0/panel_name 2>/dev/null | head -n1"],
  ["Screen", "Display", "dumpsys display 2>/dev/null | grep -m1 -o 'DisplayDeviceInfo{\"[^\"]*\": uniqueId=\"[^\"]*\", [0-9]* x [0-9]*'"],
  ["Battery", "Maker", "cat /sys/class/power_supply/battery/manufacturer 2>/dev/null"],
  ["Battery", "Model", "cat /sys/class/power_supply/battery/model_name /sys/class/power_supply/battery/battery_type /sys/class/power_supply/battery/batt_type 2>/dev/null | head -n1"],
  ["Battery", "Serial number", "cat /sys/class/power_supply/battery/serial_number /sys/class/power_supply/battery/battery_serial 2>/dev/null | head -n1"],
  ["Battery", "Made", "cat /sys/class/power_supply/battery/manufacturing_date /sys/class/power_supply/battery/manufacture_date 2>/dev/null | head -n1"],
  ["Battery", "Size when new", "cat /sys/class/power_supply/battery/charge_full_design 2>/dev/null"],
  ["Cameras", "Rear camera module (Samsung)", "cat /sys/class/camera/rear/rear_camfw /sys/class/camera/rear/rear_sensorid 2>/dev/null | tr '\\n' ' '"],
  ["Cameras", "Front camera module (Samsung)", "cat /sys/class/camera/front/front_camfw /sys/class/camera/front/front_sensorid 2>/dev/null | tr '\\n' ' '"],
  ["Cameras", "Cameras Android sees", "dumpsys media.camera 2>/dev/null | grep -c -E '^\\s*Camera [0-9]+ information'"],
  ["Touch", "Touch panel", "getevent -pl 2>/dev/null | grep -i -E 'name:.*(touch|_ts|tsp|fts|goodix|synaptics|himax|novatek|focal)' | head -n2 | sed 's/.*name: *//' | tr '\\n' ' '"],
  ["Touch", "Touch firmware (Samsung)", "cat /sys/class/sec/tsp/fw_version 2>/dev/null"],
  ["Fingerprint", "Fingerprint sensor", "dumpsys fingerprint 2>/dev/null | grep -m1 -i -E 'sensorType|sensor_type|location'"],
];

export function mount(root, ctx) {
  const { el, sh, toast, showError, busy } = ctx;
  let now = null;
  const body = el("div");

  async function read(btn) {
    if (!ctx.getAdb()) return toast("Connect the phone first");
    busy(btn, true, "Reading…");
    try {
      const vals = await Promise.all(PROBES.map(([, , cmd]) => sh(cmd).then((o) => o.trim().replace(/\s+/g, " ").slice(0, 200), () => "")));
      now = { at: Date.now(), values: Object.fromEntries(PROBES.map(([g, k], i) => [`${g} · ${k}`, vals[i]])) };
      if (now.values["Cameras · Cameras Android sees"] === "0") now.values["Cameras · Cameras Android sees"] = "";
      draw();
    } catch (e) { showError(e); } finally { if (btn.isConnected) busy(btn, false); }
  }

  function table(before, after) {
    const keys = PROBES.map(([g, k]) => `${g} · ${k}`).filter((k) => (before?.values[k] || after?.values[k]));
    if (!keys.length) return el("div", { className: "muted", textContent: "This phone doesn't tell adb anything about its parts." });
    return el("table", { className: "rp-cmp" },
      el("thead", {}, el("tr", {}, el("th"), el("th", { textContent: after !== undefined ? "Before the repair" : "Now" }), after !== undefined ? el("th", { textContent: "After the repair" }) : "")),
      el("tbody", {}, ...keys.map((k) => {
        const a = before?.values[k] || "", b = after?.values[k] || "";
        return el("tr", { className: after && a && b && a !== b ? "diff" : "" }, el("th", { textContent: k }), el("td", { textContent: a || "—" }), after !== undefined ? el("td", { textContent: b || "—" }) : "");
      })));
  }

  async function keep(which) {
    const job = ctx.job();
    if (!job) return toast("Pick the job in hand first (at the top)");
    job.parts = { ...(job.parts || {}), [which]: now };
    await saveJob(job, which === "before" ? "Parts saved before the repair" : "Parts saved after the repair");
    toast("Saved"); draw();
  }

  function draw() {
    const job = ctx.job();
    const readBtn = el("button", { className: "btn primary", type: "button", textContent: "Read the parts" });
    readBtn.onclick = () => read(readBtn);
    const b1 = el("button", { className: "btn", type: "button", textContent: "Save as before the repair", disabled: !now || !job });
    b1.onclick = () => keep("before").catch(showError);
    const b2 = el("button", { className: "btn", type: "button", textContent: "Save as after the repair", disabled: !now || !job });
    b2.onclick = () => keep("after").catch(showError);
    const before = job?.parts?.before || null, after = job?.parts?.after || null;
    body.replaceChildren(
      el("div", { className: "card" },
        el("p", { className: "muted", style: "margin-top:0", textContent: "Read before you open the phone and again after the repair: rows that changed are highlighted. A part that reports nothing, or the same as before after it was replaced, may be non-original or reused." }),
        el("div", { className: "toolbar", style: "margin:0" }, readBtn, b1, b2)),
      now ? el("div", { className: "card" }, el("h2", { textContent: "Read just now" }), table(now)) : "",
      before || after ? el("div", { className: "card" }, el("h2", { textContent: `Saved to ${job.number}` }), table(before, after)) : "");
  }
  root.append(body);
  draw();
  return { show: draw, jobChanged: draw, connected: () => { now = null; draw(); }, disconnected: () => { now = null; draw(); } };
}
