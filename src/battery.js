// Andromon — Battery health: how worn the battery is (capacity now against new), charge cycles,
// condition, temperature, and a chart of the charge level over the last days.
//
// Read three ways, each filling what the others can't: `dumpsys battery`, the kernel's battery
// files under /sys/class/power_supply (readable by the shell user on many phones, not all), and
// the companion's "battery.health" (Android's own numbers, and the history it samples while the
// phone is in use). Anything a phone doesn't tell is shown as unknown, never guessed.

const HEALTH = { 1: "Unknown", 2: "Good", 3: "Overheated", 4: "Worn out", 5: "Overvoltage", 6: "Failure", 7: "Too cold" };
const STATUS = { 2: "Charging", 3: "Discharging", 4: "Not charging", 5: "Full" };
const num = (v) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));


async function sysfs(sh) {
  // fg_asoc: Samsung's own wear figure (% of new); state_of_health: the same on some other makers.
  const names = ["cycle_count", "battery_cycle", "charge_full", "charge_full_design", "fg_asoc", "state_of_health", "capacity", "health", "charge_counter", "voltage_now", "temp"];
  // One read per file; a file that isn't there or can't be read prints nothing.
  const out = await sh(names.map((n) => `printf '${n}='; cat /sys/class/power_supply/battery/${n} 2>/dev/null || echo`).join("; ")).catch(() => "");
  return Object.fromEntries(out.split("\n").map((l) => l.split("=")).filter(([k, v]) => k && v != null && v.trim() !== "").map(([k, v]) => [k.trim(), v.trim()]));
}
function parseDumpsys(text) {
  const get = (k) => text.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const plugged = [["AC powered", "charger"], ["USB powered", "USB"], ["Wireless powered", "wireless"], ["Dock powered", "dock"]].filter(([k]) => get(k) === "true").map(([, n]) => n);
  return {
    level: num(get("level")), status: STATUS[get("status")] || "", health: HEALTH[get("health")] || "",
    tempC: num(get("temperature")) != null ? num(get("temperature")) / 10 : null, voltageMv: num(get("voltage")),
    technology: get("technology") || "", cycleCount: num(get("Charge cycle count") ?? get("cycle count")),
    chargeCounterUah: num(get("Charge counter")), plugged,
  };
}

// Capacity in µAh; kernels report µAh, a few report mAh: anything under 100 000 is taken as mAh.
const uah = (v) => (v == null ? null : v < 100000 ? v * 1000 : v);

/** Everything known about the battery of the phone `sh` runs on. Used by this page and by Repair. */
export async function readBattery({ sh, cc, companionReady }) {
  const [dump, sys, comp, stats] = await Promise.all([
    sh("dumpsys battery").catch(() => ""), sysfs(sh),
    companionReady().then((ok) => (ok ? cc("battery.health") : null)).catch((e) => { console.warn("battery.health:", e); return null; }),
    // Android's own record of what the battery last held when charged full (in mAh).
    sh("dumpsys batterystats 2>/dev/null | grep -m 4 -E 'learned battery capacity|Estimated battery capacity'").catch(() => ""),
  ]);
  const d = parseDumpsys(dump);
  const design = uah(num(comp?.chargeFullDesignUah) ?? num(sys.charge_full_design));
  const learnedMah = num(stats.match(/Last learned battery capacity:\s*(\d+)/i)?.[1]);
  // The companion's "full" is an estimate (charge counter ÷ level) unless it says otherwise: the kernel's own comes first.
  const compFull = num(comp?.chargeFullUah), compEstimated = comp?.chargeFullEstimated !== false;
  const full = uah(compFull != null && !compEstimated ? compFull : null) ?? uah(num(sys.charge_full)) ?? (learnedMah ? learnedMah * 1000 : null);
  // Where the wear figure comes from, best first. Many phones (Samsung among them) report their
  // design capacity as the "full" capacity too, so the two being exactly equal means the phone
  // doesn't measure it: that is shown as unknown, not as a perfect 100%.
  const pct = (v) => (v != null && v > 0 && v <= 110 ? Math.min(100, Math.round(v)) : null);
  let healthPct = null, source = "", unmeasured = false;
  const vendor = pct(num(sys.fg_asoc)) ?? pct(num(sys.state_of_health));
  const ratio = (f) => (f && design ? f / design : null);
  const learned = learnedMah ? learnedMah * 1000 : null;
  if (comp?.healthPercentFrom === "android" && pct(num(comp.healthPercent)) != null) { healthPct = pct(num(comp.healthPercent)); source = "Android's own battery measure"; }
  else if (vendor != null && vendor < 100) { healthPct = vendor; source = "the phone maker's own battery measure"; }
  else if (full && design && full !== design && Math.abs(full - design) > design * 0.001) { healthPct = pct(ratio(full) * 100); source = "what the battery holds now against new"; }
  else if (learned && design && Math.abs(learned - design) > design * 0.001) { healthPct = pct(ratio(learned) * 100); source = "Android's last measured capacity against new"; }
  else if (vendor != null) { healthPct = vendor; source = "the phone maker's own battery measure"; }
  else if (comp?.healthPercentFrom === "estimate" && pct(num(comp.healthPercent)) != null) { healthPct = pct(num(comp.healthPercent)); source = "an estimate from the charge counter (rough)"; }
  else unmeasured = !!(full && design);
  return {
    ...d,
    level: d.level ?? num(comp?.level), tempC: d.tempC ?? num(comp?.tempC), voltageMv: d.voltageMv ?? num(comp?.voltageMv),
    health: d.health || comp?.health || "", technology: d.technology || comp?.technology || "",
    cycleCount: num(comp?.cycleCount) ?? d.cycleCount ?? num(sys.cycle_count) ?? num(sys.battery_cycle),
    fullMah: healthPct != null && full && full !== design ? Math.round(full / 1000) : null, designMah: design ? Math.round(design / 1000) : null, healthPct, source, unmeasured,
    history: Array.isArray(comp?.history) ? comp.history : null, companion: !!comp,
  };
}

export function initBattery(ctx) {
  const { $, el, sh, cc, companionReady, showError, spinner } = ctx;
  const root = $("batteryRoot");
  let gen = 0;
  const read = () => readBattery({ sh, cc, companionReady });

  // ---------- the page ----------
  const stat = (label, value, sub, hero) => el("div", { className: "card bh-stat" + (hero ? " hero" : "") },
    el("div", { className: "muted small", textContent: label }), el("div", { className: "bh-value", textContent: value ?? "Unknown" }),
    sub ? el("div", { className: "muted small", textContent: sub }) : "");

  function verdict(b) {
    if (b.healthPct == null) return ["Unknown", b.unmeasured
      ? "This phone reports its battery's size when new as its size now, so it doesn't measure wear. The phone maker's own app (like Samsung Members › Diagnostics) may show it."
      : "This phone doesn't tell how much its battery has worn."];
    const p = b.healthPct;
    if (p >= 90) return [`${p}%`, "Like new. It holds about as much charge as when it was made."];
    if (p >= 80) return [`${p}%`, "Normal wear. A battery usually stays above 80% for its first two or three years."];
    if (p >= 70) return [`${p}%`, "Worn. The phone runs noticeably shorter on a charge than when new."];
    return [`${p}%`, "Very worn. A new battery would make the phone last much longer."];
  }

  // The charge level over time, with charging stretches shaded. Samples are {t|time|at, level, charging}.
  function chart(history) {
    const pts = history.map((s) => ({ t: num(s.t ?? s.time ?? s.at ?? s.timestamp), level: num(s.level), charging: !!(s.charging ?? s.plugged) }))
      .filter((s) => s.t != null && s.level != null).map((s) => ({ ...s, t: s.t < 1e12 ? s.t * 1000 : s.t })).sort((a, b) => a.t - b.t);
    if (pts.length < 2) return el("div", { className: "muted", textContent: "Not enough samples yet. Andromon Companion records the charge while the phone is in use; look again in a few hours." });
    const W = 900, H = 220, P = 28, t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(1, t1 - t0);
    const X = (t) => P + ((t - t0) / span) * (W - 2 * P), Y = (l) => H - P - (l / 100) * (H - 2 * P);
    const NS = "http://www.w3.org/2000/svg", mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const svg = mk("svg", { viewBox: `0 0 ${W} ${H}`, class: "bh-chart", role: "img", "aria-label": "Charge level over time" });
    for (const l of [0, 50, 100]) {
      svg.append(mk("line", { x1: P, x2: W - P, y1: Y(l), y2: Y(l), class: "bh-grid" }));
      const t = mk("text", { x: 2, y: Y(l) + 4, class: "bh-axis" }); t.textContent = `${l}%`; svg.append(t);
    }
    // Shaded where it was charging.
    for (let i = 0; i < pts.length - 1; i++) if (pts[i].charging) svg.append(mk("rect", { x: X(pts[i].t), y: P, width: Math.max(1, X(pts[i + 1].t) - X(pts[i].t)), height: H - 2 * P, class: "bh-charging" }));
    // A gap of more than 3 hours between samples breaks the line instead of drawing a slope across it.
    let d = "";
    pts.forEach((p, i) => { d += `${i && p.t - pts[i - 1].t < 3 * 3600e3 ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.level).toFixed(1)}`; });
    svg.append(mk("path", { d, class: "bh-line" }));
    const days = Math.round(span / 864e5);
    const fmt = (t) => new Date(t).toLocaleString([], span > 2 * 864e5 ? { weekday: "short", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
    for (const [t, anchor] of [[t0, "start"], [t1, "end"]]) { const n = mk("text", { x: X(t), y: H - 6, class: "bh-axis", "text-anchor": anchor }); n.textContent = fmt(t); svg.append(n); }
    return el("div", {}, svg, el("div", { className: "muted small", textContent: `${days >= 1 ? `Last ${days} day${days === 1 ? "" : "s"}` : "Today"} · shaded: charging` }));
  }

  function render(b) {
    const [pct, words] = verdict(b);
    const cap = b.fullMah && b.designMah ? `${b.fullMah.toLocaleString()} of ${b.designMah.toLocaleString()} mAh when new` : b.designMah ? `${b.designMah.toLocaleString()} mAh when new` : "";
    const now = [b.level != null ? `${b.level}%` : null, b.status, b.plugged.length ? `on ${b.plugged.join(" and ")}` : null].filter(Boolean).join(" · ");
    const tips = [];
    if (b.tempC != null && b.tempC >= 40) tips.push("The battery is warm. Heat wears it fastest: avoid charging under a pillow, in the sun or while gaming.");
    if (b.cycleCount != null && b.cycleCount > 500) tips.push("More than 500 charge cycles: most phone batteries are made to keep about 80% after 500 to 800.");
    tips.push("Keeping the charge between about 20% and 80%, and away from heat, makes a battery last longest. Many phones have a setting that stops charging at 80% or 85%.");
    root.replaceChildren(
      el("div", { className: "grid bh-grid" },
        stat("Battery health", pct, b.healthPct == null ? [words, cap].filter(Boolean).join(" · ") : [cap, b.source ? `From ${b.source}` : ""].filter(Boolean).join(" · "), true),
        stat("Charge cycles", b.cycleCount != null ? b.cycleCount.toLocaleString() : null, b.cycleCount != null ? "Full charges' worth used so far" : "Android tells this from version 14 on some phones"),
        stat("Condition", b.health || null, "As the battery reports it"),
        stat("Now", now || null, [b.tempC != null ? `${b.tempC.toFixed(1)} °C` : "", b.voltageMv ? `${(b.voltageMv / 1000).toFixed(2)} V` : "", b.technology].filter(Boolean).join(" · "))),
      b.healthPct != null ? el("div", { className: "card" }, el("b", { textContent: words })) : "",
      el("div", { className: "card" }, el("h2", { textContent: "Charge over the last days" }),
        b.history ? chart(b.history) : el("div", { className: "muted", textContent: b.companion ? "The companion has no charge history yet." : "The charge history comes from Andromon Companion, which didn't answer just now. If it isn't installed yet, open Messages, Contacts or Photos once; then open this page again." })),
      el("div", { className: "card" }, el("h2", { textContent: "Make it last" }), el("ul", { className: "muted", style: "margin:0;padding-left:18px" }, ...tips.map((t) => el("li", { textContent: t })))));
  }

  async function load() {
    const mine = ++gen;
    root.replaceChildren(el("div", { className: "card" }, spinner(), " Reading the battery…"));
    try { const b = await read(); if (mine === gen) render(b); }
    catch (e) { if (mine === gen) { root.replaceChildren(); showError(e); } }
  }
  return { load };
}
