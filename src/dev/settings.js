// Developer tab › Dev settings: the developer options people flip most, as switches, plus animation
// speed, screen size & density, font size, a clean status bar for screenshots, and "wait for debugger".
//
// debug.* properties are read by apps' UI threads; `service call activity 1599295570` (SYSPROPS_TRANSACTION)
// makes running apps pick a change up at once, the same poke the Settings app sends.

const POKE = "service call activity 1599295570 >/dev/null 2>&1";
const ANIM = [["0", "Off"], ["0.5", "0.5×"], ["1", "1×"], ["1.5", "1.5×"], ["2", "2×"], ["5", "5×"], ["10", "10×"]];
const FONTS = [["0.85", "Small"], ["1.0", "Default"], ["1.15", "Large"], ["1.3", "Larger"], ["1.5", "1.5×"], ["1.8", "1.8×"], ["2.0", "2×"]];
const SCREENS = [
  ["Small phone", 720, 1280, 320],
  ["Phone", 1080, 2400, 420],
  ["Large phone", 1440, 3120, 560],
  ["Foldable (open)", 1768, 2208, 420],
  ["7″ tablet", 1200, 1920, 240],
  ["10″ tablet", 1600, 2560, 320],
];

export function mount(root, ctx) {
  const { el, sh, shQuote, makeSwitch, toast, showError, clearError } = ctx;
  const prop = async (k) => (await sh(`getprop ${k}`)).trim();
  const setting = async (ns, k) => (await sh(`settings get ${ns} ${k}`)).trim();
  const on01 = (v) => v !== "" && v !== "0" && v !== "null" && v !== "false";

  // Each switch: read() -> bool, set(bool).
  const TOGGLES = [
    { label: "Show layout bounds", sub: "Outlines every view, its margins and padding",
      read: async () => (await prop("debug.layout")) === "true",
      set: (on) => sh(`setprop debug.layout ${on}; ${POKE}`) },
    { label: "Show GPU overdraw", sub: "Tints pixels drawn more than once",
      read: async () => (await prop("debug.hwui.overdraw")) === "show",
      set: (on) => sh(`setprop debug.hwui.overdraw ${on ? "show" : "false"}; ${POKE}`) },
    { label: "Profile GPU rendering", sub: "Bars for each frame; the green line is 16 ms",
      read: async () => (await prop("debug.hwui.profile")) === "visual_bars",
      set: (on) => sh(`setprop debug.hwui.profile ${on ? "visual_bars" : "false"}; ${POKE}`) },
    { label: "Pointer location", sub: "Shows touch coordinates and traces",
      read: async () => on01(await setting("system", "pointer_location")),
      set: (on) => sh(`settings put system pointer_location ${on ? 1 : 0}`) },
    { label: "Show taps", sub: "Draws a dot where you touch",
      read: async () => on01(await setting("system", "show_touches")),
      set: (on) => sh(`settings put system show_touches ${on ? 1 : 0}`) },
    // Android applies this only when it's switched in its own Developer options (ActivityManager.setAlwaysFinish);
    // writing the setting from the shell changes nothing until a reboot. So the switch opens that screen.
    { label: "Don't keep activities", sub: "Destroys each screen as soon as you leave it, to test state restore. Android only allows this from its own Developer options: the switch opens them on the phone",
      read: async () => on01(await setting("global", "always_finish_activities")),
      opensPhone: true,
      set: () => sh("am start -a android.settings.APPLICATION_DEVELOPMENT_SETTINGS >/dev/null 2>&1") },
    { label: "Show all “not responding” dialogs", sub: "Also for apps in the background",
      read: async () => on01(await setting("secure", "anr_show_background")),
      set: (on) => sh(`settings put secure anr_show_background ${on ? 1 : 0}`) },
    { label: "Right-to-left layout", sub: "Mirrors layouts like Arabic or Hebrew; apps pick it up when restarted",
      read: async () => on01(await setting("global", "debug.force_rtl")),
      set: (on) => sh(`settings put global debug.force_rtl ${on ? 1 : 0}; setprop debug.force_rtl ${on ? 1 : 0}; ${POKE}`) },
    { label: "Clean status bar", sub: "Demo mode: 12:00, full battery and signal, no notification icons. For screenshots",
      read: async () => on01(await setting("global", "sysui_tuner_demo_on")) || demoOn,
      set: (on) => setDemo(on) },
  ];

  let demoOn = false;
  async function setDemo(on) {
    const b = (args) => `am broadcast -a com.android.systemui.demo ${args} >/dev/null`;
    if (on) {
      await sh([
        "settings put global sysui_demo_allowed 1",
        b("-e command enter"), b("-e command clock -e hhmm 1200"),
        b("-e command battery -e level 100 -e plugged false"),
        b("-e command network -e wifi show -e level 4"),
        b("-e command network -e mobile show -e datatype none -e level 4"),
        b("-e command notifications -e visible false"),
        "settings put global sysui_tuner_demo_on 1",
      ].join("; "));
    } else {
      await sh(`${b("-e command exit")}; settings put global sysui_tuner_demo_on 0`);
    }
    demoOn = on;
  }

  // ---------- switches ----------
  const grid = el("div", { className: "ctl-grid" });
  const switches = TOGGLES.map((t) => {
    const sw = makeSwitch(false, async (want) => {
      if (t.opensPhone) {
        await t.set(want);
        toast(`On the phone: Developer options › “${t.label}”`);
        return t.read();
      }
      await t.set(want);
      let actual = want;
      try { actual = await t.read(); } catch {}
      if (actual !== want) showError(`${t.label} didn't change on this phone.`);
      else { clearError(); toast(`${t.label} ${want ? "on" : "off"}`); }
      return actual;
    });
    grid.append(el("div", { className: "ctl" },
      el("div", {}, el("div", { textContent: t.label }), el("div", { className: "sub", textContent: t.sub })), sw));
    return { t, sw };
  });
  const refreshBtn = el("button", { className: "btn sm", type: "button", textContent: "Refresh" });
  refreshBtn.onclick = () => refresh().catch(showError);
  root.append(ctx.card("Developer options", refreshBtn, grid,
    el("p", { className: "dev-note", textContent: "These are the switches from the phone's Developer options. They stay on until you turn them off here or on the phone." })));

  // ---------- animation speed & font size ----------
  const seg = (items, onPick) => {
    const s = el("div", { className: "seg" });
    for (const [v, label] of items) {
      const b = el("button", { type: "button", textContent: label });
      b.dataset.v = v;
      b.onclick = async () => {
        try { await onPick(v); mark(s, v); toast(`Set to ${label}`); } catch (e) { showError(e); }
      };
      s.append(b);
    }
    return s;
  };
  const mark = (s, v) => { for (const b of s.children) b.classList.toggle("on", Number(b.dataset.v) === Number(v)); };
  const animSeg = seg(ANIM, (v) => sh(["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]
    .map((k) => `settings put global ${k} ${v}`).join("; ")));
  const fontSeg = seg(FONTS, (v) => sh(`settings put system font_scale ${v}`));
  root.append(ctx.card("Speed & text size", null,
    el("div", { className: "dev-row" }, el("span", { className: "dev-lbl dev-w", textContent: "Animation speed" }), animSeg),
    el("p", { className: "dev-note", textContent: "Slower animations (5×, 10×) make transitions easy to inspect. Off makes UI tests steadier." }),
    el("div", { className: "dev-row", style: "margin-top:12px" }, el("span", { className: "dev-lbl dev-w", textContent: "Font size" }), fontSeg),
    el("p", { className: "dev-note", textContent: "Check that layouts still fit with large text. Android 14 and later go up to 2×." })));

  // ---------- screen size & density ----------
  const wIn = el("input", { type: "number", min: 200, max: 8000, placeholder: "Width" });
  const hIn = el("input", { type: "number", min: 200, max: 8000, placeholder: "Height" });
  const dIn = el("input", { type: "number", min: 72, max: 1000, placeholder: "dpi" });
  for (const i of [wIn, hIn, dIn]) i.className = "dev-num";
  const cur = el("div", { className: "dev-kv" });
  const apply = el("button", { className: "btn primary sm", type: "button", textContent: "Apply" });
  const reset = el("button", { className: "btn sm", type: "button", textContent: "Back to normal" });
  const presets = el("div", { className: "dev-row" });
  for (const [name, w, h, d] of SCREENS) {
    const b = el("button", { className: "chip dev-chip", type: "button", textContent: `${name} · ${w}×${h} · ${d} dpi` });
    b.onclick = () => { wIn.value = w; hIn.value = h; dIn.value = d; applyScreen().catch(showError); };
    presets.append(b);
  }
  async function applyScreen() {
    const w = Math.round(+wIn.value), h = Math.round(+hIn.value), d = Math.round(+dIn.value);
    const cmds = [];
    if (w || h) {
      if (!(w >= 200 && w <= 8000 && h >= 200 && h <= 8000)) throw new Error("Enter a width and height between 200 and 8000 pixels.");
      cmds.push(`wm size ${w}x${h}`);
    }
    if (d) {
      if (!(d >= 72 && d <= 1000)) throw new Error("Enter a density between 72 and 1000 dpi.");
      cmds.push(`wm density ${d}`);
    }
    if (!cmds.length) return;
    busyRun(apply, cmds.join("; "), "Screen changed. If the phone looks wrong, click “Back to normal”.");
  }
  async function busyRun(btn, cmd, msg) {
    ctx.busy(btn, true, "Applying…");
    try { const out = await sh(cmd); if (/error|exception/i.test(out)) throw new Error(out.trim()); toast(msg); clearError(); await readScreen(); }
    catch (e) { showError(e); } finally { ctx.busy(btn, false); }
  }
  apply.onclick = () => applyScreen().catch(showError);
  reset.onclick = () => busyRun(reset, "wm size reset; wm density reset", "Screen size and density are back to normal");
  async function readScreen() {
    const [size, dens] = await Promise.all([sh("wm size"), sh("wm density")]);
    const pick = (s, re) => (s.match(re) || [])[1] || "";
    const ps = pick(size, /Physical size: (\S+)/), os = pick(size, /Override size: (\S+)/);
    const pd = pick(dens, /Physical density: (\d+)/), od = pick(dens, /Override density: (\d+)/);
    cur.replaceChildren(
      el("span", { textContent: "Screen" }), el("span", { textContent: os ? `${os} (normally ${ps})` : ps }),
      el("span", { textContent: "Density" }), el("span", { textContent: od ? `${od} dpi (normally ${pd})` : `${pd} dpi` }));
    const [w, h] = (os || ps).split("x");
    if (!wIn.value) { wIn.value = w || ""; hIn.value = h || ""; dIn.value = od || pd; }
    reset.disabled = !os && !od;
  }
  root.append(ctx.card("Screen size & density", null, cur,
    el("div", { className: "dev-row", style: "margin-top:12px" }, wIn, el("span", { className: "muted", textContent: "×" }), hIn, dIn,
      el("span", { className: "dev-lbl", textContent: "dpi" }), apply, reset),
    presets,
    el("p", { className: "dev-note", textContent: "Pretends the phone has a different screen, to see how your layouts adapt. Screen mirroring restarts with the new size." })));

  // ---------- wait for debugger ----------
  const dbgSw = makeSwitch(false, async (want) => {
    const p = ctx.app.get();
    if (want) {
      if (!/^[A-Za-z0-9_.]+$/.test(p)) throw new Error("Pick an app first.");
      await sh(`am set-debug-app -w --persistent ${shQuote(p)}`);
    } else await sh("am clear-debug-app");
    await readDebug();
    return dbgState.on;
  });
  const dbgInfo = el("div", { className: "sub" });
  const dbgState = { on: false };
  async function readDebug() {
    const [app, wait] = await Promise.all([setting("global", "debug_app"), setting("global", "wait_for_debugger")]);
    const p = ctx.app.get();
    dbgState.on = !!p && app === p && on01(wait);
    dbgSw.set(dbgState.on);
    dbgInfo.textContent = app && app !== "null" ? `Now set for ${app}${on01(wait) ? ", waits for the debugger" : ""}.` : "Not set for any app.";
  }
  ctx.app.onChange(() => { if (ctx.getAdb()) readDebug().catch(() => {}); });
  root.append(ctx.card("Debugging", null, ctx.app.picker(),
    el("div", { className: "ctl" },
      el("div", {}, el("div", { textContent: "Wait for debugger when this app starts" }),
        el("div", { className: "sub", textContent: "The app pauses on launch until Android Studio attaches its debugger" }), dbgInfo),
      dbgSw)));

  async function refresh() {
    if (!ctx.getAdb()) return;
    await Promise.all([
      ...switches.map(async ({ t, sw }) => { try { sw.set(await t.read()); } catch {} }),
      setting("global", "animator_duration_scale").then((v) => mark(animSeg, v === "null" || v === "" ? 1 : v)),
      setting("system", "font_scale").then((v) => mark(fontSeg, v === "null" || v === "" ? 1 : v)),
      readScreen(), readDebug(),
    ]);
  }

  return {
    show: () => refresh().catch(showError),
    connected: () => { demoOn = false; if (ctx.isShown("settings")) refresh().catch(showError); },
    disconnected: () => { demoOn = false; wIn.value = hIn.value = dIn.value = ""; },
  };
}
