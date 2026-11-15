// Settings tab: appearance (light/dark mode, colour theme, sidebar width) and a few switches that
// otherwise live inside their own tabs. Appearance is stored in localStorage and applied before
// paint by renderer/theme.js; the colours themselves are CSS (see "themes" in index.html).

import pkg from "../package.json";

export const THEMES = [
  { id: "lime", label: "Lime", colors: ["#e3f786", "#9cd237"] },
  { id: "ocean", label: "Ocean", colors: ["#bfe0fb", "#3d9be9"] },
  { id: "sunset", label: "Sunset", colors: ["#ffd2b8", "#f5824a"] },
  { id: "violet", label: "Violet", colors: ["#dcd3fb", "#8b6ff0"] },
  { id: "graphite", label: "Graphite", colors: ["#dcdcd8", "#6c6d70"] },
];
const MODES = [["system", "Same as computer"], ["light", "Light"], ["dark", "Dark"]];

export function initSettings(ctx) {
  const { $, el, makeSwitch, fmtSize, fmtDate, busy, showError, toast, armedClick } = ctx;
  const api = globalThis.droidDesk || {};
  const root = document.documentElement;
  const app = document.querySelector(".app");
  const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  const mode = () => (["light", "dark"].includes(get("dd.theme")) ? get("dd.theme") : "system");
  const accent = () => (THEMES.some((t) => t.id === get("dd.accent")) ? get("dd.accent") : "lime");
  function setMode(m) {
    if (m === "light" || m === "dark") root.dataset.theme = m; else delete root.dataset.theme;
    set("dd.theme", m); render();
  }
  function setAccent(a) {
    if (a !== "lime") root.dataset.accent = a; else delete root.dataset.accent;
    set("dd.accent", a); render();
  }

  // ---------- sidebar: full, or a narrow rail of icons ----------
  const railBtn = $("railBtn");
  const panel = document.querySelector('[data-panel="settings"]');
  let ready = false; // render() uses helpers defined further down
  const isRail = () => app.classList.contains("rail");
  function setRail(on) {
    app.classList.toggle("rail", on);
    set("dd.sidebar", on ? "rail" : "full");
    railBtn.title = on ? "Expand the sidebar" : "Collapse the sidebar";
    railBtn.setAttribute("aria-pressed", String(on));
    railBtn.querySelector("span").textContent = on ? "Expand" : "Collapse";
    if (ready && !panel.hidden) render();
  }
  railBtn.addEventListener("click", () => setRail(!isRail()));
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
      e.preventDefault(); setRail(!isRail());
    }
  });
  // In the rail the labels are hidden, so every tool gets its name as a tooltip.
  for (const b of $("nav").querySelectorAll("button[data-view]")) b.title = b.querySelector("span")?.textContent || "";

  // ---------- the page ----------
  const row = (title, sub, control) => el("div", { className: "set-row" },
    el("div", { className: "set-text" }, el("b", { textContent: title }), sub ? el("div", { className: "sub", textContent: sub }) : ""), control);
  const section = (title, ...rows) => el("div", { className: "card" }, el("h2", { textContent: title }), ...rows);


  // ---------- what the sections below show; filled in by refresh() ----------
  const data = { info: null, wifi: null, rv: null, fd: null, uad: undefined, upd: null, photo: null, sys: null };
  let gen = 0;
  async function refresh() {
    const mine = ++gen;
    const [info, wifi, rv, fd, uad, upd, photo, sys] = await Promise.all([
      api.app?.info().catch(() => null), api.wifi?.status().catch(() => null),
      api.revanced?.status().catch(() => null), api.fdroid?.status().catch(() => null),
      ctx.uad.read().catch(() => null), api.updates?.status().catch(() => null),
      (async () => { const p = ctx.photoCopy(); return p ? { on: await p.get(), folder: await p.folder() } : null; })().catch(() => null),
      api.system?.requirements(false).catch(() => null),
    ]);
    if (mine !== gen) return;
    Object.assign(data, { info, wifi, rv, fd, uad, upd, photo, sys });
    if (!panel.hidden) render();
  }

  const select = (options, value, onChange) => {
    const s = el("select", {}, ...options.map(([v, label]) => el("option", { value: v, textContent: label })));
    s.value = value; s.onchange = () => onChange(s.value);
    return s;
  };
  const btn = (text, cls = "") => el("button", { className: "btn sm" + (cls ? " " + cls : ""), type: "button", textContent: text });
  const group = (...kids) => el("div", { className: "set-seg" }, ...kids.filter(Boolean));
  // A button that runs `fn`, shows it is working, then reloads the numbers on this page.
  const action = (text, working, fn, cls) => {
    const b = btn(text, cls);
    b.onclick = async () => {
      busy(b, true, working);
      try { await fn(); } catch (e) { if (!/was cancelled/.test(e?.message || "")) showError(e); }
      await refresh(); render();
    };
    return b;
  };
  const armed = (text, fn) => {
    const b = btn(text, "danger");
    armedClick(b, async () => { try { await fn(); } catch (e) { showError(e); } await refresh(); render(); });
    return b;
  };
  const folder = (dir) => el("div", { className: "sub set-path", textContent: dir || "", title: dir || "" });
  const source = (label, href) => el("a", { textContent: label, href, target: "_blank", rel: "noreferrer" });
  // A download row: name, where it comes from, what is here now, and its buttons.
  const dlRow = (src, title, from, state, ...buttons) => {
    const live = el("div", { className: "set-dl" }); live.dataset.dl = src || "";
    return el("div", { className: "set-row" },
      el("div", { className: "set-text" }, el("b", { textContent: title }),
        el("div", { className: "sub" }, state),
        el("div", { className: "sub set-from" }, "From ", ...from.flatMap((f, i) => (i ? [", ", f] : [f]))),
        live),
      group(...buttons));
  };
  // Running downloads show under their row: progress bar, speed and Cancel (see ./downloads.js).
  const showLive = () => {
    for (const box of panel.querySelectorAll(".set-dl")) box.replaceChildren(...(box.dataset.dl ? ctx.downloads.active(box.dataset.dl).map(ctx.downloads.block) : []));
  };
  // When a download starts or ends, the rows' text and buttons are out of date: load them again.
  const SOURCES = ["rv", "fd", "uad", "up"];
  let running = 0;
  ctx.downloads.onChange(() => {
    if (panel.hidden) return;
    const n = SOURCES.reduce((sum, src) => sum + ctx.downloads.active(src).length, 0);
    if (n !== running) { running = n; refresh(); } else showLive();
  });
  // A row's Download/Update button; it stays "Downloading…" for as long as that source is downloading.
  const dlAction = (src, text, fn) => {
    const b = action(text, "Downloading…", fn);
    if (ctx.downloads.active(src).length) busy(b, true, "Downloading…");
    return b;
  };

  function phoneLinkSection() {
    const rows = [row("Call alerts", "Incoming calls pop up on this computer while a phone is connected",
      makeSwitch(ctx.callAlerts.get(), (on) => { ctx.callAlerts.set(on); return on; }))];
    if (ctx.wifiAuto) rows.push(row("Connect over Wi‑Fi automatically", "Connect to a phone you've paired as soon as it appears on the network",
      makeSwitch(ctx.wifiAuto.get(), (on) => ctx.wifiAuto.set(on))));
    rows.push(row("Turn on the phone RAM manager automatically", "Starts its helper on the phone each time a phone connects (see the Shizuku page)",
      makeSwitch(ctx.ramAuto.get(), (on) => ctx.ramAuto.set(on))));
    const copy = ctx.photoCopy(), ph = data.photo;
    if (copy) {
      rows.push(row("Copy new photos to this computer when the phone connects", "Over USB or Wi‑Fi. Only photos and videos that aren't in the folder yet are copied; nothing is ever deleted",
        makeSwitch(!!ph?.on, async (on) => { const now = await copy.set(on); await refresh(); return now; })));
      rows.push(el("div", { className: "set-row" },
        el("div", { className: "set-text" }, el("b", { textContent: "Photo copy folder" }),
          ph?.folder ? folder(ph.folder.path + (ph.folder.exists ? "" : "  (not found)")) : el("div", { className: "sub", textContent: "No folder chosen yet" })),
        group(action(ph?.folder ? "Change…" : "Choose folder…", "Choosing…", () => copy.choose()))));
    }
    return section("Phone link", ...rows);
  }

  function notificationsSection() {
    const n = ctx.notifs, muted = n.muted();
    const rows = [
      row("Phone notifications on this computer", "WhatsApp, SMS, email and the rest appear on the Notifications page, where you can answer them. Gives Droid Desk Companion “Notification access” on the phone",
        makeSwitch(n.get(), (on) => { n.set(on); return on; })),
      row("Notification pop-ups", "Show each new notification in the corner of this window, and as a system notification when Droid Desk is in the background",
        makeSwitch(ctx.notifPopups.get(), (on) => { ctx.notifPopups.set(on); return on; })),
    ];
    if (muted.length) {
      rows.push(row("Muted apps", "Still listed on the Notifications page, but they don't pop up. Click one to unmute it",
        el("div", { className: "set-chips" }, ...muted.map((m) => {
          const c = el("button", { className: "chip", type: "button", title: "Unmute", textContent: `${m.label} ✕` });
          c.onclick = () => { n.unmute(m.pkg); render(); };
          return c;
        }))));
    }
    const ta = el("textarea", { value: n.quick().join("\n"), spellcheck: false });
    ta.setAttribute("aria-label", "Quick replies, one per line");
    ta.onchange = () => { ta.value = n.setQuick(ta.value.split("\n")).join("\n"); toast("Quick replies saved"); };
    rows.push(row("Quick replies", "Ready-made answers offered under a notification. One per line, up to 12", ta));
    return section("Notifications", ...rows);
  }

  function screenshotSection() {
    const t = ctx.shot, p = t.get();
    return section("Screenshot",
      row("Picture format", "PNG keeps every pixel; JPEG and WebP make smaller files", select(t.FORMAT, p.format, (v) => t.set({ format: v }))),
      row("Picture size", "A smaller picture is quicker to share", select(t.SCALE, String(p.scale), (v) => t.set({ scale: Number(v) }))),
      row("Clean status bar", "For the capture only, the phone shows 12:00, a full battery and no notification icons", makeSwitch(p.clean, (on) => { t.set({ clean: on }); return on; })),
      row("Copy each screenshot", "Puts the picture on this computer's clipboard as soon as it is taken", makeSwitch(p.copy, (on) => { t.set({ copy: on }); return on; })),
      row("Save each screenshot", "Saves the file as soon as it is taken (see Saving files for where)", makeSwitch(p.save, (on) => { t.set({ save: on }); return on; })));
  }

  function shellSection() {
    const t = ctx.shell, p = t.get();
    return section("ADB shell",
      row("Wrap long lines", "Off keeps each line on one row and scrolls sideways", makeSwitch(p.wrap, (on) => { t.set({ wrap: on }); return on; })),
      row("Text size", "The size of the output text", select(t.SIZE, p.size, (v) => t.set({ size: v }))),
      row("Show the time of each command", "Next to how long it took", makeSwitch(p.times, (on) => { t.set({ times: on }); return on; })),
      row("Follow new output", "Scroll to the newest command's answer by itself", makeSwitch(p.follow, (on) => { t.set({ follow: on }); return on; })));
  }

  function wifiSection() {
    const w = data.wifi, m = ctx.wifiMethod, method = w?.method || "auto";
    return section("Wi‑Fi transfer",
      row("Transfer method", m.NOTES[method] || "", select(m.NAMES, method, async (v) => { await api.wifi.setMethod(v); await refresh(); })),
      el("div", { className: "set-row" },
        el("div", { className: "set-text" }, el("b", { textContent: "Received files go to" }), folder(w?.saveDir)),
        group(action("Open", "Opening…", () => api.wifi.openFolder()), action("Change…", "Choosing…", () => api.wifi.chooseFolder()))));
  }

  function mirrorSection() {
    const m = ctx.mirror, p = m.get();
    return section("Screen mirror",
      row("Picture quality", "Used each time mirroring starts. Lower quality is smoother on a slow link", select(m.QUALITY, p.quality, (v) => m.set({ quality: v }))),
      row("Show", "The phone's screen, or one of its cameras (Android 12 and newer)", select(m.SOURCE, p.source, (v) => m.set({ source: v }))),
      row("Play the phone's sound here", "Android 11 and newer. With a camera, the microphone is used", makeSwitch(p.audio, (on) => { m.set({ audio: on }); return on; })),
      row("Turn the phone's screen off while mirroring", "The phone keeps working; only its display goes dark", makeSwitch(p.screenOff, (on) => { m.set({ screenOff: on }); return on; })),
      row("Frame rate", "A lower limit saves the phone's battery", select(m.FPS, String(p.fps), (v) => m.set({ fps: Number(v) }))),
      row("Video format", "H.265 needs a phone and a computer that both support it; otherwise H.264 is used", select(m.CODEC, p.codec, (v) => m.set({ codec: v }))),
      row("Show touches on the phone", "Draws a dot on the phone's screen wherever it is touched while mirroring", makeSwitch(p.touches, (on) => { m.set({ touches: on }); return on; })),
      row("Keep the phone awake", "The phone's screen doesn't time out while mirroring", makeSwitch(p.awake, (on) => { m.set({ awake: on }); return on; })),
      row("Lock the phone when mirroring stops", "Turns the phone's screen off as soon as mirroring ends", makeSwitch(p.lockOnStop, (on) => { m.set({ lockOnStop: on }); return on; })),
      row("Copy from the phone automatically", "Text copied on the phone lands in this computer's clipboard", makeSwitch(p.clipboard, (on) => { m.set({ clipboard: on }); return on; })));
  }

  function savingSection() {
    const s = data.info?.save;
    const rows = [
      row("Ask where to save each file", "Screenshots, recordings and exports. When off, they go straight into the folder below",
        makeSwitch(s ? s.ask : true, async (on) => { data.info.save = await api.app.saveAsk(on); render(); return data.info.save.ask; })),
      el("div", { className: "set-row" },
        el("div", { className: "set-text" }, el("b", { textContent: "Save folder" }), folder(s?.dir), s?.ask ? el("div", { className: "sub", textContent: "Used when asking is switched off" }) : ""),
        group(action("Open", "Opening…", () => api.app.saveOpen()), action("Change…", "Choosing…", () => api.app.saveChoose()))),
    ];
    return section("Saving files", ...rows);
  }

  // ---------- updates: is a newer Droid Desk published, and get its installer ----------
  let updNote = ""; // what the last "Check now" found, until the page is left
  function updateRows() {
    const u = data.upd, last = u?.last;
    const mine = u ? `Version ${u.current.version}${u.current.build ? ` (build ${u.current.build})` : ""}` : `Version ${pkg.version}`;
    const live = el("div", { className: "set-dl" }); live.dataset.dl = "up";
    const text = [el("b", { textContent: last?.available ? `Droid Desk ${last.version} is available` : "Updates" })];
    const buttons = [];
    if (last?.available) {
      const size = last.installer ? ` · ${fmtSize(last.installer.size)}` : "";
      text.push(el("div", { className: "sub", textContent: `${mine} is installed. New: version ${last.version}${last.build ? ` (build ${last.build})` : ""}${last.date ? `, built ${fmtDate(Date.parse(last.date), true)}` : ""}${size}` }));
      if (last.changes.length) {
        text.push(el("details", { className: "set-changes" }, el("summary", { textContent: `What's new (${last.changes.length})` }),
          el("ul", {}, ...last.changes.map((c) => el("li", { textContent: c })))));
      }
      if (u.downloaded) {
        text.push(el("div", { className: "sub", textContent: `Downloaded to your Downloads folder as ${u.downloaded.name}. Opening it starts the installer; close Droid Desk when it asks.` }));
        buttons.push(action("Open installer", "Opening…", () => api.updates.install(), "primary"));
      } else if (last.installer) {
        const b = action("Download update", "Downloading…", () => api.updates.download(), "primary");
        if (ctx.downloads.active("up").length) busy(b, true, "Downloading…");
        buttons.push(b);
      } else {
        text.push(el("div", { className: "sub", textContent: "There is no installer for this kind of computer in that build. See the releases page." }));
      }
      buttons.push(action("Releases page", "Opening…", () => api.updates.openReleases()));
    } else {
      const when = u?.checkedAt ? `Last checked ${fmtDate(u.checkedAt, true)}` : "Not checked yet";
      text.push(el("div", { className: "sub", textContent: updNote || `${mine}. ${when}` }));
      buttons.push(action("Check now", "Checking…", async () => {
        const s = await api.updates.check();
        updNote = s.last?.available ? "" : `${mine} is the newest. Checked just now`;
      }));
    }
    text.push(live);
    return [
      el("div", { className: "set-row" }, el("div", { className: "set-text" }, ...text), group(...buttons)),
      row("Check for updates automatically", "Once a day when Droid Desk starts. Only asks GitHub for the newest version; nothing is installed by itself",
        makeSwitch(u ? u.auto : true, async (on) => { data.upd = await api.updates.setAuto(on); return data.upd.auto; })),
    ];
  }

  // ---------- this computer: the tools Droid Desk can use, and whether they are installed ----------
  function computerSection() {
    const sys = data.sys;
    const BADGE = { ok: ["Installed", "on"], old: ["Too old", "warn"], missing: ["Not installed", "warn"], optional: ["Optional", "neutral"], unknown: ["Can't tell", "neutral"] };
    const rows = !sys ? [row("Checking this computer…", "", "")] : sys.items.map((it) => {
      const [label, cls] = BADGE[it.state] || BADGE.unknown;
      const buttons = [];
      if (it.install) buttons.push(action("Install", "Installing…", async () => { data.sys = await api.system.install(it.id); toast(`${it.name} is installed`); }, "primary"));
      if (it.page && it.state !== "ok") buttons.push(action(it.install ? "Download page" : "Get it", "Opening…", () => api.system.openPage(it.id)));
      return el("div", { className: "set-row" },
        el("div", { className: "set-text" }, el("b", {}, it.name, " ", el("span", { className: `badge ${cls}`, textContent: label })),
          el("div", { className: "sub", textContent: it.why }), el("div", { className: "sub set-path", textContent: it.detail, title: it.detail })),
        group(...buttons));
    });
    rows.push(row("Check again", "After installing something, look for it again", group(action("Check again", "Checking…", async () => { data.sys = await api.system.requirements(true); }))));
    return section("This computer", ...rows);
  }

  function downloadsSection() {
    const { rv, fd, uad, info } = data;
    const size = (n) => (n ? ` · ${fmtSize(n)} on this computer` : "");
    const rows = [];
    if (api.revanced) {
      const have = rv && (rv.cli || rv.patches);
      const state = !rv ? "Checking…" : !have ? "Not downloaded"
        : [rv.cli ? `Patcher ${rv.cli.version}` : "", rv.patches ? `patches ${rv.patches.version}, fetched ${fmtDate(rv.patches.fetchedAt, true)}` : "patches missing"].filter(Boolean).join(" · ") + size(info?.sizes.revanced);
      rows.push(dlRow("rv", "ReVanced patcher and patches", [source("api.revanced.app", "https://api.revanced.app"), source("github.com/ReVanced", "https://github.com/ReVanced")], state,
        dlAction("rv", have ? "Update" : "Download", () => api.revanced.setup()),
        have ? armed("Remove", () => api.revanced.clear()) : null));
    }
    if (api.fdroid) {
      const c = fd?.catalog;
      const state = !fd ? "Checking…" : !c ? "Not downloaded" : `${c.apps.toLocaleString()} apps · fetched ${fmtDate(c.fetchedAt, true)}` + size(info?.sizes.fdroid);
      rows.push(dlRow("fd", "F-Droid app catalogue", [source("f-droid.org", "https://f-droid.org")], state,
        dlAction("fd", c ? "Update" : "Download", async () => { const r = await api.fdroid.update(); if (c && r && r.changed === false) toast("The catalogue is already up to date"); }),
        c ? armed("Remove", () => api.fdroid.clear()) : null));
    }
    rows.push(dlRow("uad", "Debloat list", [source("Universal Android Debloater", "https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation")],
      uad === undefined ? "Checking…" : !uad ? "Not downloaded" : `${Object.keys(uad.list || {}).length.toLocaleString()} apps described` + (uad.fetchedAt ? ` · fetched ${fmtDate(uad.fetchedAt, true)}` : ""),
      dlAction("uad", uad ? "Update" : "Download", () => ctx.uad.update())));
    rows.push(dlRow("", "Built into Droid Desk", [source("scrcpy", "https://github.com/Genymobile/scrcpy"), source("Droid Desk Companion", "https://github.com/Deshan555/Andromon-android")],
      `Screen mirroring helper ${ctx.scrcpyVersion} · companion app ${ctx.companionVersion}. Nothing to download`));
    if (api.app) rows.push(row("Droid Desk's data folder", "Settings, paired phones and everything listed above", group(action("Open folder", "Opening…", () => api.app.openData()))));
    return section("Downloads and sources", ...rows);
  }

  function render() {
    const modes = el("div", { className: "set-seg" }, ...MODES.map(([id, label]) => {
      const b = el("button", { className: "btn sm" + (mode() === id ? " primary" : ""), type: "button", textContent: label });
      b.setAttribute("aria-pressed", String(mode() === id));
      b.onclick = () => setMode(id);
      return b;
    }));
    const swatches = el("div", { className: "set-themes" }, ...THEMES.map((t) => {
      const b = el("button", { className: "set-theme" + (accent() === t.id ? " on" : ""), type: "button", title: t.label },
        el("i", { style: `background: linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})` }), el("span", { textContent: t.label }));
      b.setAttribute("aria-pressed", String(accent() === t.id));
      b.onclick = () => setAccent(t.id);
      return b;
    }));
    const parts = [
      section("Appearance",
        row("Mode", "Light, dark, or the same as this computer", modes),
        row("Colour theme", "The accent colour of cards, highlights and the logo", swatches),
        row("Collapse the sidebar", "Show only icons. Shortcut: Ctrl/⌘ + B", makeSwitch(isRail(), (on) => { setRail(on); return on; }))),
    ];
    parts.push(phoneLinkSection(), notificationsSection());
    parts.push(mirrorSection());
    parts.push(screenshotSection());
    parts.push(shellSection());
    if (api.wifi) parts.push(wifiSection());
    if (api.app) parts.push(savingSection());
    if (api.system) parts.push(computerSection());
    parts.push(downloadsSection());
    const a = (text, href) => el("a", { textContent: text, href, target: "_blank", rel: "noreferrer" });
    parts.push(section("About",
      row("Droid Desk", `Version ${pkg.version}${data.upd?.current.build ? ` (build ${data.upd.current.build})` : ""} · bundles companion app version ${ctx.companionVersion}` + (data.info ? ` · Electron ${data.info.versions.electron}` : ""), ""),
      ...(api.updates ? updateRows() : []),
      row("Source code", "", el("div", { className: "set-links" }, a("PC app", "https://github.com/Deshan555/Andromon_PC"), a("Android companion", "https://github.com/Deshan555/Andromon-android"))),
      row("Credits", "ADB by Tango (ya-webadb) · screen mirroring by scrcpy · Wi‑Fi transfer speaks the LocalSend protocol · icons by Lucide · Poppins type", "")));
    $("settingsRoot").replaceChildren(...parts);
    showLive();
  }

  setRail(get("dd.sidebar") === "rail");
  ready = true;
  return { load: () => { render(); refresh(); }, setRail, isRail };
}
