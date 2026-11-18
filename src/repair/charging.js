// Andromon — Repair › Charging: the current going into (or out of) the battery, live, to tell a
// worn charging port or cable from a worn battery; and a drain test, % per hour.
//
// The current comes from the kernel's battery file (current_now, in µA on most phones; a few use
// mA, and the sign differs by maker), read once a second while this tab is open. Where the phone
// doesn't let adb read it, only the level and the charger type are shown.

export function mount(root, ctx) {
  const { el, sh, showError, toast } = ctx;
  const W = 900, H = 200, KEEP = 120; // two minutes of samples
  let samples = [], timer = null, drain = null, unitDiv = null;
  const live = el("div", { className: "grid rp-live" });
  const chartBox = el("div");
  const verdict = el("div", { className: "notice", hidden: true, style: "margin-top:12px" });
  const drainBox = el("div");

  async function sample() {
    const out = await sh("cat /sys/class/power_supply/battery/current_now /sys/class/power_supply/battery/voltage_now 2>/dev/null; echo '~'; dumpsys battery").catch(() => "");
    const [raw, dump = ""] = out.split("~");
    const [cur, volt] = raw.trim().split(/\s+/).map(Number);
    const get = (k) => dump.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "mi"))?.[1]?.trim();
    const status = Number(get("status")); // 2 charging, 3 discharging, 4 not charging, 5 full
    const via = ["AC", "USB", "Wireless"].filter((k) => get(`${k} powered`) === "true");
    // µA on most phones; a value under 20 000 is taken as mA already.
    if (isFinite(cur) && cur !== 0 && unitDiv == null) unitDiv = Math.abs(cur) > 20000 ? 1000 : 1;
    const mA = isFinite(cur) && unitDiv ? Math.abs(cur) / unitDiv : null;
    const v = isFinite(volt) && volt > 0 ? (volt > 100000 ? volt / 1e6 : volt / 1000) : (Number(get("voltage")) || 0) / 1000;
    return { t: Date.now(), mA, v, level: Number(get("level")), status, via, tempC: Number(get("temperature")) / 10 };
  }

  function draw() {
    const s = samples[samples.length - 1];
    if (!s) return;
    const charging = s.status === 2 || s.status === 5;
    const stat = (label, value, sub) => el("div", { className: "card bh-stat" }, el("div", { className: "muted small", textContent: label }), el("div", { className: "bh-value", textContent: value }), sub ? el("div", { className: "muted small", textContent: sub }) : "");
    live.replaceChildren(
      stat(charging ? "Charging current" : "Current drawn", s.mA != null ? `${Math.round(s.mA)} mA` : "Not readable", s.mA != null && s.v ? `${((s.mA * s.v) / 1000).toFixed(1)} W` : "This phone doesn't let adb read it"),
      stat("Charger", s.via.length ? s.via.join(", ") : "Not plugged in", { 2: "Charging", 3: "Discharging", 4: "Plugged in, not charging", 5: "Full" }[s.status] || ""),
      stat("Battery", `${s.level}%`, [s.v ? `${s.v.toFixed(2)} V` : "", isFinite(s.tempC) ? `${s.tempC.toFixed(1)} °C` : ""].filter(Boolean).join(" · ")));
    // The chart: current over the last two minutes.
    const pts = samples.filter((x) => x.mA != null);
    if (pts.length > 1) {
      const max = Math.max(500, ...pts.map((x) => x.mA)) * 1.1, t0 = pts[0].t, span = Math.max(1, pts[pts.length - 1].t - t0);
      const X = (t) => 40 + ((t - t0) / span) * (W - 50), Y = (m) => H - 20 - (m / max) * (H - 30);
      const NS = "http://www.w3.org/2000/svg", mk = (tag, a) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) n.setAttribute(k, v); return n; };
      const svg = mk("svg", { viewBox: `0 0 ${W} ${H}`, class: "bh-chart", role: "img", "aria-label": "Current over the last two minutes" });
      for (const m of [0, Math.round(max / 2 / 100) * 100, Math.round((max * 0.9) / 100) * 100]) {
        svg.append(mk("line", { x1: 40, x2: W - 10, y1: Y(m), y2: Y(m), class: "bh-grid" }));
        const tx = mk("text", { x: 0, y: Y(m) + 4, class: "bh-axis" }); tx.textContent = `${m} mA`; svg.append(tx);
      }
      svg.append(mk("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.mA).toFixed(1)}`).join(""), class: "bh-line" }));
      chartBox.replaceChildren(svg);
    } else chartBox.replaceChildren(el("div", { className: "muted", textContent: s.mA == null ? "The current can't be read on this phone, so there is no chart." : "Collecting…" }));
    // A hint once there are 20 seconds of charging to go on.
    const recent = samples.slice(-20).filter((x) => x.mA != null && x.status === 2);
    verdict.hidden = recent.length < 15;
    if (!verdict.hidden) {
      const avg = recent.reduce((n, x) => n + x.mA, 0) / recent.length;
      verdict.textContent = s.level >= 85 ? `About ${Math.round(avg)} mA. Above 85% every phone slows charging down on purpose, so test with the battery lower.`
        : avg < 300 ? `Only about ${Math.round(avg)} mA: very slow. Try another cable and charger; if it stays this low, the charging port (dirt, a loose or worn connector) or the charging circuit is the likely cause.`
        : avg < 900 ? `About ${Math.round(avg)} mA: normal for a USB port or a basic charger, slow for a fast charger. With a fast charger, try another cable.`
        : `About ${Math.round(avg)} mA: charging well. The port and cable are fine.`;
    }
    drawDrain();
  }

  function drawDrain() {
    const s = samples[samples.length - 1];
    const startBtn = el("button", { className: "btn sm", type: "button", textContent: drain ? "Stop the test" : "Start a drain test" });
    startBtn.onclick = () => {
      if (drain) { drain = null; drawDrain(); return; }
      if (!s) return toast("Wait a moment for the first reading");
      drain = { t: s.t, level: s.level }; drawDrain();
    };
    let text = "Unplug the charger, set the screen as it will be used, and start. Leave it 15 minutes or more for a useful number.";
    if (drain && s) {
      const mins = (s.t - drain.t) / 60000, used = drain.level - s.level;
      text = mins < 1 ? "Running… keep this tab open."
        : `${mins.toFixed(0)} min: ${used}% used${used > 0 ? ` · about ${((used / mins) * 60).toFixed(1)}% per hour, so ${Math.round((s.level / used) * mins / 60 * 10) / 10} h left at this rate` : " so far (wait for the level to drop)"}.`;
      if (s.via.length) text = "The charger is plugged in, so this isn't measuring the drain. Unplug it.";
    }
    drainBox.replaceChildren(el("p", { className: "muted", style: "margin-top:0", textContent: text }), startBtn);
  }

  function start() {
    if (timer || !ctx.getAdb()) return;
    const tick = async () => {
      try { samples.push(await sample()); if (samples.length > KEEP) samples.shift(); draw(); } catch (e) { console.warn(e); }
      if (timer) timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 0);
  }
  function stop() { clearTimeout(timer); timer = null; }

  root.append(
    el("div", { className: "card" }, el("p", { className: "muted", style: "margin-top:0", textContent: "Plug the charger and cable to test into the phone. The numbers update every second while this tab is open." }), live, chartBox, verdict),
    el("div", { className: "card" }, el("h2", { textContent: "Drain test" }), drainBox));
  drawDrain();
  return {
    show: start, hide: stop,
    connected() { samples = []; unitDiv = null; drain = null; if (ctx.isShown("charging")) start(); },
    disconnected() { stop(); samples = []; live.replaceChildren(); chartBox.replaceChildren(); },
  };
}
