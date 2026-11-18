// SD card recovery page: brings back deleted photos, videos and files from a memory card (or USB
// stick) in this computer's card reader, or from an image file of one. The work is done by
// PhotoRec, started by the main process (../recovery.js); this file is the page.
//
// It works without a phone. Drive names come from the system and are untrusted: textContent only.

const WHAT = [
  ["everything", "Everything PhotoRec knows (480+ file types)"],
  ["photos", "Photos only"],
  ["media", "Photos, videos and music"],
  ["documents", "Documents and archives"],
];

export function initRecovery({ $, el, toast, showError, clearError, fmtSize }) {
  const api = globalThis.andromon?.recovery || null;
  const s = { status: null, drives: [], pick: null, source: "drive", what: "media", dl: null, progress: null, done: null, starting: false };
  const root = $("recoveryRoot");

  api?.onEvent((ev) => {
    if (ev.kind === "download") s.dl = ev;
    else if (ev.kind === "progress") s.progress = ev;
    else if (ev.kind === "done") {
      s.done = ev; s.progress = null;
      if (s.status) s.status.running = false;
      if (ev.problem) toast(ev.problem);
    }
    render();
  });

  const duration = (sec) => sec < 90 ? `${sec} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;
  const ctl = (title, sub, ...right) => el("div", { className: "ctl", style: "margin-bottom:12px;align-items:flex-start" },
    el("div", {}, el("div", {}, el("b", { textContent: title })), el("div", { className: "sub", textContent: sub })), ...right);
  const btn = (label, onClick, cls = "btn sm") => { const b = el("button", { className: cls, type: "button", textContent: label }); b.addEventListener("click", onClick); return b; };
  const guard = (fn) => async () => { clearError(); try { await fn(); } catch (e) { showError(e); } finally { render(); } };

  async function refreshDrives() {
    s.drives = await api.drives();
    if (!s.drives.some((d) => d.id === s.pick)) s.pick = s.drives[0]?.id || null;
  }

  async function load() {
    if (!api) { root.replaceChildren(el("div", { className: "card", textContent: "SD card recovery is only available in the Andromon desktop app." })); return; }
    s.status = await api.status();
    await refreshDrives();
    render();
  }

  function toolCard() {
    const st = s.status, t = st.tool;
    const card = el("div", { className: "card" });
    if (t) {
      card.append(ctl("PhotoRec is ready", t.source === "system" ? `Using the copy installed on this computer · ${t.path}` : `Version ${t.version}, downloaded from cgsecurity.org`,
        btn("About PhotoRec", () => api.openSite())));
      return card;
    }
    const busy = !!s.dl && !s.dl.error;
    const install = btn(busy ? (s.dl.unpacking ? "Unpacking…" : `Downloading… ${s.dl.total ? Math.round(100 * s.dl.done / s.dl.total) : 0}%`) : `Download PhotoRec (${st.downloadMb} MB)`,
      guard(async () => {
        s.dl = { done: 0, total: 0 }; render();
        try { await api.install(); s.status = await api.status(); toast("PhotoRec is ready."); } finally { s.dl = null; }
      }), "btn sm primary");
    install.disabled = busy || !st.canInstall;
    card.append(ctl("PhotoRec is needed", "The free, open-source recovery program by Christophe Grenier (GPL). Andromon downloads it from its author's site, cgsecurity.org, and checks the file before using it." +
      (st.rosetta ? " On this Mac it runs through Rosetta." : "") +
      (st.platform === "linux" ? " Or install your system's “testdisk” package." : st.platform === "darwin" ? " Or install it with Homebrew: brew install testdisk." : ""),
      install, btn("About PhotoRec", () => api.openSite())));
    return card;
  }

  function sourceCard() {
    const st = s.status;
    const card = el("div", { className: "card" });
    card.append(el("h2", { style: "margin-top:0", textContent: "1. What to recover from" }));
    const tabs = el("div", { className: "toolbar", style: "margin:0 0 12px" });
    for (const [id, label] of [["drive", "A card or USB drive"], ["image", "An image file"]]) {
      const b = btn(label, () => { s.source = id; render(); }, "btn sm" + (s.source === id ? " primary" : ""));
      b.disabled = st.running;
      tabs.append(b);
    }
    card.append(tabs);
    if (s.source === "drive") {
      const head = el("div", { className: "toolbar", style: "margin:0 0 8px;justify-content:space-between" },
        el("span", { className: "muted small", textContent: "Removable drives connected to this computer" }), btn("Refresh", guard(refreshDrives)));
      card.append(head);
      if (!s.drives.length) card.append(el("div", { className: "empty", textContent: "No memory card or USB drive found. Put the card in the card reader, wait a few seconds and click Refresh." }));
      for (const d of s.drives) {
        const row = el("label", { className: "ctl", style: "margin-bottom:8px;cursor:pointer;justify-content:flex-start" });
        const radio = el("input", { type: "radio", name: "rcDrive", checked: s.pick === d.id, disabled: st.running });
        radio.addEventListener("change", () => { s.pick = d.id; });
        row.append(radio, el("div", {}, el("div", {}, el("b", { textContent: d.name })),
          el("div", { className: "sub", textContent: [fmtSize(d.size), d.bus, d.device].filter(Boolean).join(" · ") })));
        card.append(row);
      }
      card.append(el("div", { className: "sub", textContent: "Reading a whole drive needs administrator rights, so your computer asks for your password when the recovery starts. The card is only read; nothing on it is changed." }));
    } else {
      const pick = btn(st.image ? "Choose another" : "Choose file", guard(async () => { s.status.image = await api.chooseImage(); }));
      pick.disabled = st.running;
      card.append(ctl(st.image ? st.image.split(/[\\/]/).pop() : "No image file chosen", st.image || "A copy of a whole card or drive (.img, .dd, .bin…), for example made with ddrescue. No password is needed.", pick));
    }
    return card;
  }

  function optionsCard() {
    const st = s.status;
    const card = el("div", { className: "card" });
    card.append(el("h2", { style: "margin-top:0", textContent: "2. What to look for, and where to put it" }));
    const sel = el("select", { id: "rcWhat", disabled: st.running });
    for (const [id, label] of WHAT) sel.append(el("option", { value: id, textContent: label, selected: s.what === id }));
    sel.addEventListener("change", () => { s.what = sel.value; });
    card.append(ctl("File types", "Fewer types is faster and leaves less to sort through", sel));
    const out = btn(st.outDir ? "Change" : "Choose folder", guard(async () => { s.status.outDir = await api.chooseOut(); }));
    out.disabled = st.running;
    card.append(ctl(st.outDir ? st.outDir : "No folder chosen", "Must be on this computer, not on the card: writing to the card would overwrite the deleted files. Needs about as much free space as the card holds.", out));
    return card;
  }

  function runCard() {
    const st = s.status;
    const card = el("div", { className: "card" });
    card.append(el("h2", { style: "margin-top:0", textContent: "3. Recover" }));
    const ready = !!st.tool && !!st.outDir && (s.source === "image" ? !!st.image : !!s.pick);
    if (st.running) {
      const p = s.progress;
      const sec = Math.round((Date.now() - (p?.startedAt || st.startedAt || Date.now())) / 1000);
      card.append(ctl(p?.files ? `${p.files.toLocaleString()} files recovered so far · ${fmtSize(p.bytes)}` : "Reading the card…",
        `Running for ${duration(sec)}. A large card can take an hour or more; you can keep using Andromon.` + (st.platform === "win32" ? " PhotoRec shows its progress in its own window." : ""),
        btn("Stop", guard(async () => { await api.stop(); }))));
      card.append(el("div", { className: "bar" }, el("i", { style: "display:block;height:100%;width:35%;background:var(--ink);border-radius:3px;animation:rc-slide 1.6s ease-in-out infinite alternate" })));
    } else {
      const go = btn(s.starting ? "Starting…" : "Start recovery", guard(async () => {
        s.starting = true; s.done = null; s.progress = null; render();
        try { Object.assign(s.status, await api.start({ source: s.source, drive: s.pick, what: s.what })); } finally { s.starting = false; }
      }), "btn primary");
      go.disabled = !ready || s.starting;
      card.append(ctl(ready ? "Ready" : "Not ready yet", !st.tool ? "Download PhotoRec first." : !st.outDir ? "Choose a folder for the recovered files." : s.source === "image" && !st.image ? "Choose the image file." : !ready ? "Choose a drive." : "Recovered files get new names (PhotoRec can't bring back the old ones) and are sorted into numbered folders.", go));
    }
    const d = s.done;
    if (d && !st.running) {
      const text = d.problem ? d.problem
        : d.files ? `${d.stopped ? "Stopped. " : "Finished. "}${d.files.toLocaleString()} files recovered (${fmtSize(d.bytes)}) in ${duration(d.seconds)}.`
        : d.stopped ? "Stopped before anything was recovered." : "Finished, but nothing recoverable was found.";
      const right = d.dir ? [btn("Open folder", guard(async () => { await api.open(d.dir); }), "btn sm primary")] : [];
      card.append(ctl(d.problem ? "The recovery didn't run" : "Result", text, ...right));
    }
    return card;
  }

  function render() {
    if (!api || !s.status) return;
    const intro = el("div", { className: "card" },
      el("div", { className: "sub", style: "line-height:1.6" },
        "Deleted photos and files usually stay on a memory card until something new is saved over them. Take the card out of the phone or camera, put it in this computer's card reader and recover what is left. ",
        el("b", { textContent: "Stop using the card until you have: every new photo can overwrite an old one. " }),
        "This can't recover from a phone's built-in storage, which is encrypted and wipes deleted files; for that, see Recover in Andromon Companion on the phone."));
    root.replaceChildren(intro, toolCard(), sourceCard(), optionsCard(), runCard());
  }

  return { load };
}
