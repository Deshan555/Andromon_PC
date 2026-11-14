// F-Droid page: browse F-Droid's catalogue of free and open-source apps and install one on the phone.
// The work with the internet is done by the main process (../fdroid.js): it downloads F-Droid's
// signed index and an app's APK, and checks both. This file is the page: search, the list, an
// app's details, and the install over adb.
//
// Browsing and "Save the APK" work without a phone. With a phone connected, the page offers the
// version that fits it (Android version, processor) and shows which apps it has and which have a
// newer version on F-Droid.
//
// Everything read from the phone or from F-Droid's index is untrusted: it goes in with
// textContent, never innerHTML.

const CHUNK = 4 * 1024 * 1024;
const PAGE = 40;
const PLAY = "com.android.vending";

export function initFdroid(base) {
  const { $, el, toast, showError, clearError, sh, shQuote, withSync, busy, fmtSize, spinner, actionBtn, getAdb } = base;
  const api = globalThis.droidDesk?.fdroid || null;
  const s = {
    status: null,
    q: "", category: "", sort: "updated", view: "all", // view: "all" | "phone" | "updates"
    items: [], total: 0,                               // the catalogue rows on screen (view "all")
    phone: null,                                       // { serial, sdk, abis, installed: Map pkg -> { code, installer }, rows: Map pkg -> row }
    detail: null,                                      // the app that is open: what main's "fd:app" returns
    working: false,                                    // a download or install is running
  };
  let progressTo = null, seq = 0, listBox = null, tabsBox = null, typing = null;
  api?.onEvent((ev) => { if (ev.kind === "progress") progressTo?.(ev); });

  const h2 = (text) => el("h2", { style: "margin:0 0 6px", textContent: text });
  const para = (text) => el("p", { className: "muted", style: "margin:0 0 12px", textContent: text });
  const day = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  const phoneArg = () => (s.phone ? { sdk: s.phone.sdk, abis: s.phone.abis } : null);
  const cancelled = (e) => /was cancelled/.test(e?.message || "");
  const fail = (e) => { if (cancelled(e)) toast("Download cancelled"); else showError(e); };

  // ---------- icons: fetched and checked by the main process, a few at a time, when a row scrolls into view ----------
  const icons = new Map(); // pkg -> Promise<object URL | null>
  const waiting = [];
  let fetching = 0;
  function pump() {
    while (fetching < 6 && waiting.length) {
      const job = waiting.shift();
      fetching++;
      api.icon(job.pkg).then((r) => (r ? URL.createObjectURL(new Blob([r.data], { type: r.type })) : null), () => null)
        .then((url) => { fetching--; job.done(url); pump(); });
    }
  }
  const iconUrl = (pkg) => {
    if (!icons.has(pkg)) icons.set(pkg, new Promise((done) => { waiting.push({ pkg, done }); pump(); }));
    return icons.get(pkg);
  };
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      const box = e.target;
      iconUrl(box.dataset.pkg).then((url) => { if (url && box.isConnected) box.replaceChildren(el("img", { src: url, alt: "", draggable: false })); });
    }
  }, { rootMargin: "300px" });
  function iconBox(a, large = false) {
    const box = el("div", { className: "fd-icon" + (large ? " lg" : ""), textContent: (a.name.trim()[0] || "?").toUpperCase() });
    if (a.icon) { box.dataset.pkg = a.pkg; seen.observe(box); }
    return box;
  }

  // ---------- the phone ----------
  const pkgOk = (p) => /^[\w.]+$/.test(p);
  async function readPhone() {
    const adb = getAdb();
    if (!adb) { s.phone = null; return; }
    // Newer phones list each app's version and where it was installed from in one go.
    let out = await sh("pm list packages --user 0 --show-versioncode -i 2>&1").catch(() => "");
    if (!/^package:\S+.*versionCode:\d+/m.test(out)) out = await sh("pm list packages --user 0").catch(() => "");
    const installed = new Map();
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      const pkg = line.match(/^package:(\S+)/)?.[1];
      if (!pkg || !pkgOk(pkg)) continue;
      const code = line.match(/\bversionCode:(\d+)/)?.[1];
      const from = line.match(/\binstaller=(\S+)/)?.[1];
      installed.set(pkg, { code: code ? Number(code) : null, installer: from && from !== "null" ? from : "" });
    }
    const props = (await sh("getprop ro.build.version.sdk; getprop ro.product.cpu.abilist; getprop ro.product.cpu.abi").catch(() => "")).split("\n").map((l) => l.trim());
    const abis = (props[1] || props[2] || "").split(",").map((a) => a.trim()).filter(Boolean);
    s.phone = { serial: adb.serial, sdk: Number(props[0]) || 0, abis, installed, rows: new Map() };
    await matchPhone();
  }
  // Which of the phone's apps F-Droid has.
  async function matchPhone() {
    if (!s.phone || !s.status?.catalog) return;
    const rows = await api.lookup([...s.phone.installed.keys()], phoneArg());
    s.phone.rows = new Map(rows.map((r) => [r.pkg, r]));
  }
  const hasUpdate = (r) => {
    const have = s.phone?.installed.get(r.pkg);
    return !!(have && have.code != null && r.v && r.v.code > have.code);
  };
  const phoneRows = () => (s.phone ? [...s.phone.rows.values()].sort((a, b) => a.name.localeCompare(b.name)) : []);
  const updateRows = () => phoneRows().filter(hasUpdate);

  // ---------- download, copy to the phone, install ----------
  // onStep(text) shows where it is. Returns what was installed: { pkg, code, version, label }.
  async function install(pkg, code, label, onStep) {
    if (!getAdb()) throw new Error("Connect a phone first.");
    onStep("Downloading…");
    progressTo = (ev) => { if (ev.pkg === pkg) onStep(`Downloading… ${fmtSize(ev.done)}${ev.total ? ` of ${fmtSize(ev.total)}` : ""}`); };
    let got;
    try { got = await api.fetch(pkg, code); } finally { progressTo = null; }
    const remote = `/data/local/tmp/droiddesk-fd-${Date.now()}.apk`;
    let off = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (off >= got.size) return c.close();
        const chunk = await api.read(off, CHUNK);
        if (!chunk.byteLength) return c.close();
        off += chunk.byteLength;
        onStep(`Copying to the phone… ${Math.round(off / got.size * 100)}%`);
        c.enqueue(chunk);
      },
    });
    try {
      await withSync((sync) => sync.write({ filename: remote, file: stream, permission: 0o644 }));
      onStep("Installing…");
      const out = (await sh(`pm install -r ${shQuote(remote)}`)).trim();
      if (!/Success/.test(out)) throw new Error(installError(out, label));
    } finally {
      sh(`rm -f ${shQuote(remote)}`).catch(() => {});
    }
    const had = s.phone?.installed.get(pkg);
    s.phone?.installed.set(pkg, { code: got.code, installer: had?.installer || "" });
    if (s.phone && !s.phone.rows.has(pkg)) await matchPhone().catch(() => {});
    return got;
  }
  function installError(out, label) {
    if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) {
      return `The phone already has ${label} from another source (for example the Play Store), signed with a different key, so Android won't replace it with F-Droid's build. ` +
        "To switch to F-Droid's build, uninstall the app on the phone first (this deletes its data), then install again.";
    }
    if (/VERSION_DOWNGRADE/i.test(out)) return `The phone has a newer ${label} than this one. Android refuses downgrades: uninstall it first to go back to an older version.`;
    if (/INSUFFICIENT_STORAGE/i.test(out)) return "The phone doesn't have enough free space.";
    if (/OLDER_SDK/i.test(out)) return `This version of ${label} needs a newer Android than the phone has.`;
    if (/NO_MATCHING_ABIS/i.test(out)) return `This version of ${label} isn't made for the phone's processor.`;
    if (/USER_RESTRICTED|INSTALL_FAILED_VERIFICATION|canceled by user/i.test(out)) return "The phone refused the install. Look at the phone: it may be asking to allow it (\"Install via USB\" or Play Protect).";
    return `Install failed: ${(out.match(/Failure \[(.+?)\]/)?.[1] || out.split("\n")[0] || "unknown error").slice(0, 300)}`;
  }
  // A button that installs one version. One download or install runs at a time.
  function installBtn(a, v, text, note, primary = false) {
    const btn = el("button", { className: "btn" + (primary ? " primary" : " sm"), type: "button", textContent: text });
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (s.working) return toast("Wait for the running download to finish");
      clearError(); busy(btn, true, "Installing…"); s.working = true;
      try {
        const got = await install(a.pkg, v.code, a.name, (t) => { if (note) note.textContent = t; else if (btn.isConnected) btn.replaceChildren(spinner(), t.split("…")[0] + "…"); });
        toast(`${a.name} ${got.version} installed`);
      } catch (err) { fail(err); }
      finally { s.working = false; if (note) note.textContent = ""; refresh(); }
    };
    return btn;
  }

  // ---------- page ----------
  async function load() {
    const root = $("fdRoot");
    if (!api) {
      root.replaceChildren(el("div", { className: "card" }, h2("F-Droid"), para("The catalogue is downloaded and checked by a program on this computer, so it's only available in the Droid Desk desktop app.")));
      return;
    }
    if (s.working) return; // keep the running download's progress on screen
    const first = !s.status;
    if (first) root.replaceChildren(el("div", { className: "empty" }, spinner(), " Checking…"));
    s.status = await api.status();
    if (!s.status.catalog) { s.phone = null; s.detail = null; return renderIntro(); }
    const adb = getAdb();
    const phoneChanged = (adb?.serial || null) !== (s.phone?.serial || null);
    if (phoneChanged) {
      await readPhone();
      if (!s.phone && s.view !== "all") s.view = "all";
      if (s.detail) s.detail = await api.app(s.detail.pkg, phoneArg());
    }
    if (first || phoneChanged || !s.items.length) await runSearch();
    render();
  }

  function renderIntro() {
    const progress = el("div", { className: "muted small", style: "margin-top:10px", hidden: true });
    const get = el("button", { className: "btn primary", type: "button", textContent: "Download the catalogue (about 25 MB)" });
    get.onclick = () => refreshCatalog(get, progress);
    $("fdRoot").replaceChildren(el("div", { className: "card" },
      h2("Free and open-source apps"),
      para("F-Droid is a catalogue of several thousand free and open-source Android apps: no ads from the store, no account, and every app is built from its public source code. " +
        "Droid Desk downloads F-Droid's catalogue to this computer, lets you search it, and installs the apps you choose on the phone over the cable or Wi‑Fi."),
      el("div", { className: "toolbar", style: "margin:0" }, get), progress,
      el("p", { className: "muted small", style: "margin:14px 0 0" },
        "F-Droid is an independent community project (f-droid.org); Droid Desk isn't part of it. The catalogue and the apps are downloaded only from f-droid.org. " +
        "The catalogue is checked against F-Droid's signature, and every app against the catalogue, before anything is used.")));
  }

  async function refreshCatalog(btn, progress) {
    if (s.working) return toast("Wait for the running download to finish");
    clearError(); busy(btn, true, "Downloading…"); s.working = true; progress.hidden = false; progress.textContent = "Checking f-droid.org…";
    progressTo = (ev) => { progress.textContent = `${ev.what}: ${fmtSize(ev.done)}${ev.total ? ` of ${fmtSize(ev.total)}` : ""}`; };
    try {
      const st = await api.update();
      s.status = st;
      toast(st.changed ? "F-Droid catalogue updated" : "The catalogue is up to date");
      if (st.changed) { s.items = []; if (s.phone) await matchPhone(); if (s.detail) s.detail = await api.app(s.detail.pkg, phoneArg()); }
      s.working = false;
      await load();
    } catch (e) { fail(e); }
    finally { s.working = false; progressTo = null; if (progress.isConnected) progress.hidden = true; if (btn.isConnected) busy(btn, false); }
  }

  // Asks the main process for the first page of the list (view "all").
  async function runSearch() {
    const mine = ++seq;
    const r = await api.search({ q: s.q, category: s.category, sort: s.sort, offset: 0, limit: PAGE, phone: phoneArg() });
    if (mine !== seq) return false;
    s.items = r.items; s.total = r.total;
    return true;
  }
  async function more(btn) {
    busy(btn, true, "Loading…");
    const mine = seq;
    try {
      const r = await api.search({ q: s.q, category: s.category, sort: s.sort, offset: s.items.length, limit: PAGE, phone: phoneArg() });
      if (mine !== seq) return;
      s.items.push(...r.items); s.total = r.total;
      fillList();
    } catch (e) { showError(e); if (btn.isConnected) busy(btn, false); }
  }

  // Draws again what is on screen, after an install or a change on the phone.
  function refresh() {
    if (!$("fdRoot").isConnected || !s.status?.catalog) return;
    if (s.detail) render(); else { fillTabs(); fillList(); }
  }
  function render() {
    if (s.detail) return renderDetail();
    const cat = s.status.catalog;
    const search = el("input", { type: "search", placeholder: `Search ${cat.apps.toLocaleString()} apps…`, value: s.q });
    const category = el("select", { ariaLabel: "Category" }, el("option", { value: "", textContent: "All categories" }), ...cat.categories.map((c) => el("option", { value: c.id, textContent: c.name })));
    category.value = s.category;
    const sort = el("select", { ariaLabel: "Sort" }, ...[["updated", "Recently updated"], ["added", "Newest"], ["name", "A to Z"]].map(([v, t]) => el("option", { value: v, textContent: t })));
    sort.value = s.sort;
    const again = async () => { try { if (await runSearch()) fillList(); } catch (e) { showError(e); } };
    search.oninput = () => {
      s.q = search.value;
      clearTimeout(typing);
      if (s.view !== "all") return fillList();
      typing = setTimeout(again, 140);
    };
    category.onchange = () => { s.category = category.value; again(); };
    sort.onchange = () => { s.sort = sort.value; again(); };

    tabsBox = el("div", { className: "toolbar", style: "margin-bottom:6px" });
    listBox = el("div");
    const sync = () => { category.disabled = sort.disabled = s.view !== "all"; };
    tabsBox.addEventListener("fd-view", sync);
    sync();
    $("fdRoot").replaceChildren(el("div", { className: "card" },
      el("div", { className: "toolbar" }, search, category, sort), tabsBox, listBox));
    fillTabs(); fillList();
  }

  // All apps / On this phone / Updates, and the catalogue's date.
  function fillTabs() {
    if (!tabsBox?.isConnected) return;
    const cat = s.status.catalog;
    const kids = [];
    if (s.phone) {
      const seg = el("div", { className: "seg" });
      const tabs = [["all", "All apps"], ["phone", `On this phone (${s.phone.rows.size})`], ["updates", `Updates (${updateRows().length})`]];
      for (const [v, t] of tabs) {
        const b = el("button", { type: "button", textContent: t, className: s.view === v ? "on" : "" });
        b.onclick = () => { s.view = v; tabsBox.dispatchEvent(new Event("fd-view")); fillTabs(); fillList(); };
        seg.append(b);
      }
      kids.push(seg);
    } else kids.push(el("span", { className: "muted small", textContent: "Connect a phone to install apps and see updates." }));
    const progress = el("span", { className: "muted small", hidden: true });
    const old = Date.now() - cat.fetchedAt > 7 * 864e5;
    const check = el("button", { className: "btn sm", type: "button", textContent: "Check for new apps" });
    check.onclick = () => refreshCatalog(check, progress);
    kids.push(el("span", { style: "flex:1" }), progress,
      el("span", { className: "muted small", textContent: `Catalogue from ${day(cat.timestamp)}${old ? " · checked more than a week ago" : ""}` }), check);
    tabsBox.replaceChildren(...kids);
  }

  function fillList() {
    if (!listBox?.isConnected) return;
    const kids = [];
    if (s.view === "all") {
      if (!s.items.length) kids.push(el("div", { className: "empty", textContent: s.q || s.category ? "No app matches" : "The catalogue is empty" }));
      for (const r of s.items) kids.push(appRow(r));
      if (s.items.length < s.total) {
        const btn = el("button", { className: "btn sm", type: "button", textContent: `Show more (${(s.total - s.items.length).toLocaleString()} left)` });
        btn.onclick = () => more(btn);
        kids.push(el("div", { className: "toolbar", style: "justify-content:center;margin:14px 0 0" }, btn));
      }
    } else {
      const words = s.q.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = (s.view === "updates" ? updateRows() : phoneRows())
        .filter((r) => words.every((w) => `${r.name}\n${r.summary}\n${r.pkg}`.toLowerCase().includes(w)));
      if (s.view === "updates" && rows.length > 1 && !words.length) kids.push(updateAllBar(rows));
      if (!rows.length) {
        kids.push(el("div", { className: "empty", textContent: words.length ? "No app matches"
          : s.view === "updates" ? "Every app on this phone that F-Droid has is up to date" : "None of this phone's apps are in F-Droid's catalogue" }));
      }
      for (const r of rows) kids.push(appRow(r));
      if (s.view === "updates" && rows.some((r) => s.phone.installed.get(r.pkg)?.installer === PLAY)) {
        kids.push(el("p", { className: "muted small", style: "margin:14px 0 0", textContent:
          "Apps marked “from Play Store” are usually signed with their maker's own key. Android only accepts F-Droid's build over them when the keys match; otherwise the update is refused and nothing changes." }));
      }
    }
    listBox.replaceChildren(...kids);
  }

  function updateAllBar(rows) {
    const note = el("span", { className: "muted small" });
    const stop = el("button", { className: "btn sm", type: "button", textContent: "Stop", hidden: true });
    const go = el("button", { className: "btn sm", type: "button", textContent: `Update all ${rows.length}` });
    let stopped = false;
    stop.onclick = () => { stopped = true; api.cancel().catch(() => {}); };
    go.onclick = async () => {
      if (s.working) return toast("Wait for the running download to finish");
      clearError(); busy(go, true, "Updating…"); s.working = true; stop.hidden = false;
      const failed = []; let done = 0;
      for (const [i, r] of rows.entries()) {
        if (stopped || !getAdb()) break;
        try { await install(r.pkg, r.v.code, r.name, (t) => { note.textContent = `${r.name} (${i + 1} of ${rows.length}): ${t}`; }); done++; }
        catch (e) { if (!cancelled(e)) failed.push(`${r.name}: ${e.message}`); }
      }
      s.working = false;
      toast(`${done} app${done === 1 ? "" : "s"} updated`);
      refresh();
      if (failed.length) showError(`${failed.length} app${failed.length === 1 ? " wasn't" : "s weren't"} updated. ${failed.join(" ")}`);
    };
    return el("div", { className: "toolbar", style: "margin:8px 0 4px" }, go, stop, note);
  }

  // One app in a list.
  function appRow(r) {
    const have = s.phone?.installed.get(r.pkg);
    const side = el("div", { className: "fd-side" });
    if (have) {
      if (have.installer === PLAY && hasUpdate(r)) side.append(el("span", { className: "badge neutral", textContent: "from Play Store" }));
      if (hasUpdate(r)) side.append(installBtn(r, r.v, `Update to ${r.v.name}`.slice(0, 28)));
      else side.append(el("span", { className: "badge on", textContent: "Installed" }));
    } else if (s.phone) {
      if (r.v) side.append(installBtn(r, r.v, "Install"));
      else side.append(el("span", { className: "badge neutral", textContent: "Not for this phone", title: r.why }));
    }
    const facts = [r.v ? `${r.v.name} · ${fmtSize(r.v.size)}` : "", r.lastUpdated ? `updated ${day(r.lastUpdated)}` : "", r.license].filter(Boolean).join(" · ");
    const line = el("div", { className: "muted small fd-sum", textContent: facts });
    const row = el("div", { className: "fd-row", tabIndex: 0, role: "button" }, iconBox(r),
      el("div", { className: "fd-main" },
        el("div", { className: "fd-name", textContent: r.name }),
        el("div", { className: "fd-sum", textContent: r.summary }), line),
      side);
    const open = () => openDetail(r.pkg).catch(showError);
    row.onclick = open;
    row.onkeydown = (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } };
    return row;
  }

  // ---------- one app ----------
  let listScroll = 0;
  const scroller = () => document.scrollingElement || document.documentElement;
  async function openDetail(pkg) {
    clearError();
    const d = await api.app(pkg, phoneArg());
    if (!d) return toast("F-Droid no longer has that app");
    listScroll = scroller().scrollTop;
    s.detail = d;
    render();
    scroller().scrollTop = 0;
  }

  function renderDetail() {
    const d = s.detail;
    const have = s.phone?.installed.get(d.pkg);
    const best = d.versions.find((v) => v.code === d.suggested) || null;
    const shown = best || d.versions[0];
    const anti = s.status.catalog.antiFeatures || {};
    const card = el("div", { className: "card" });

    const back = el("button", { className: "btn sm", type: "button", textContent: "‹ Back to the list" });
    back.onclick = () => { s.detail = null; render(); scroller().scrollTop = listScroll; };
    card.append(back);
    card.append(el("div", { className: "fd-head" }, iconBox(d, true),
      el("div", { style: "flex:1;min-width:220px" },
        el("h2", { style: "margin:0", textContent: d.name }),
        el("div", { textContent: d.summary }),
        el("div", { className: "mono muted", textContent: d.pkg }))));

    // ----- install, open, save -----
    const note = el("span", { className: "muted small" });
    const bar = el("div", { className: "toolbar", style: "margin:0 0 16px" });
    const newer = !!(have && have.code != null && best && best.code > have.code);
    if (have) {
      bar.append(el("span", { className: `badge ${newer ? "neutral" : "on"}`, style: "margin-left:0", textContent: newer ? "An older version is on this phone" : "On this phone" }));
      if (newer) bar.append(installBtn(d, best, `Update to ${best.name}`, note, true));
      bar.append(actionBtn("Open on the phone", "Opening…", async () => {
        const out = await sh(`monkey -p ${shQuote(d.pkg)} -c android.intent.category.LAUNCHER 1`);
        if (/No activities found|monkey aborted/i.test(out)) throw new Error(`${d.name} has no screen to open.`);
        toast(`Opened ${d.name} on the phone`);
      }));
    } else if (s.phone && best) bar.append(installBtn(d, best, `Install ${best.name} (${fmtSize(best.size)})`, note, true));
    const stop = el("button", { className: "btn sm", type: "button", textContent: "Cancel", hidden: true });
    stop.onclick = () => { api.cancel().catch(() => {}); };
    if (shown) {
      const save = el("button", { className: "btn sm", type: "button", textContent: "Save the APK…" });
      save.onclick = async () => {
        if (s.working) return toast("Wait for the running download to finish");
        clearError(); busy(save, true, "Downloading…"); s.working = true; stop.hidden = false;
        progressTo = (ev) => { if (ev.pkg === d.pkg) note.textContent = `${fmtSize(ev.done)}${ev.total ? ` of ${fmtSize(ev.total)}` : ""}`; };
        try {
          await api.fetch(d.pkg, shown.code);
          note.textContent = "";
          const name = await api.save();
          if (name) toast(`Saved ${name}`);
        } catch (e) { fail(e); }
        finally { s.working = false; progressTo = null; note.textContent = ""; stop.hidden = true; if (save.isConnected) busy(save, false); }
      };
      bar.append(save);
    }
    bar.append(stop, note);
    card.append(bar);

    if (!s.phone) card.append(para("Connect a phone to install this app. Without one, you can save its APK to this computer."));
    else if (!best) card.append(el("div", { className: "notice", textContent: `No version of ${d.name} fits this phone. ${d.versions[0]?.why || ""}.` }));
    if (newer && have.installer === PLAY) {
      card.append(el("div", { className: "notice", textContent:
        `The copy on the phone was installed from the Play Store. If its maker signs it with a different key than F-Droid's build, Android refuses the update and nothing changes. ` +
        "To switch to F-Droid's build then, uninstall the app first (this deletes its data)." }));
    }
    const flags = (shown?.anti || []).map((id) => anti[id] || { name: id, description: "" });
    if (flags.length) {
      card.append(el("div", { className: "notice" },
        el("b", { textContent: "F-Droid notes about this app" }),
        ...flags.map((f) => el("div", { textContent: f.description ? `${f.name}: ${f.description}` : f.name }))));
    }

    // ----- facts -----
    const stat = (k, v) => (v ? el("div", { className: "stat" }, el("div", { className: "k", textContent: k }), el("div", { className: "v", textContent: v })) : "");
    if (shown) {
      card.append(el("div", { className: "grid", style: "margin-bottom:16px" },
        stat("Version", shown.name + (shown.beta ? " (beta)" : "")), stat("Size", fmtSize(shown.size)), stat("Updated", day(d.lastUpdated)),
        stat("Needs", `Android ${shown.minAndroid} or newer`), stat("Licence", d.license), stat("Made by", d.author), stat("Category", d.categories.join(", "))));
    }
    if (shown?.whatsNew) card.append(el("h3", { style: "margin:0 0 4px", textContent: `New in ${shown.name}` }), el("div", { className: "fd-text muted", style: "margin-bottom:16px", textContent: shown.whatsNew }));
    if (d.description) card.append(el("h3", { style: "margin:0 0 4px", textContent: "About this app" }), el("div", { className: "fd-text", textContent: d.description }));

    if (shown?.perms.length) {
      card.append(el("details", { style: "margin-top:16px" },
        el("summary", { textContent: `${shown.perms.length} permission${shown.perms.length === 1 ? "" : "s"} it can ask for` }),
        el("div", { className: "chips" }, ...shown.perms.map((p) => el("span", { className: "chip", title: p, textContent: p.replace(/^android\.permission\./, "").replace(/_/g, " ").toLowerCase() })))));
    } else if (shown) card.append(el("p", { className: "muted small", style: "margin:16px 0 0", textContent: "This app asks for no permissions." }));

    if (d.versions.length > 1 || (d.versions.length === 1 && !best)) {
      const box = el("div");
      for (const v of d.versions) {
        const marks = [];
        if (v.code === d.suggested) marks.push(el("span", { className: "badge on", textContent: "Suggested" }));
        if (v.beta) marks.push(el("span", { className: "badge neutral", textContent: "Beta" }));
        if (have?.code === v.code) marks.push(el("span", { className: "badge neutral", textContent: "On this phone" }));
        const line = el("div", { className: "rv-row" },
          el("div", { style: "flex:1;min-width:200px" }, el("div", {}, v.name, ...marks),
            el("div", { className: "muted small", textContent: [fmtSize(v.size), day(v.added), v.abis.length ? v.abis.join(", ") : "", v.why].filter(Boolean).join(" · ") })));
        if (s.phone && !v.why && have?.code !== v.code) line.append(installBtn(d, v, "Install", note));
        box.append(line);
      }
      card.append(el("details", { style: "margin-top:12px" }, el("summary", { textContent: `All ${d.versions.length} versions on F-Droid` }), box));
    }

    const a = (text, href) => (href ? el("a", { href, target: "_blank", rel: "noopener", textContent: text }) : "");
    card.append(el("div", { className: "fd-links small" },
      a("Website", d.webSite), a("Source code", d.sourceCode), a("Report a problem", d.issueTracker), a("Changelog", d.changelog),
      a("Page on f-droid.org", `https://f-droid.org/packages/${encodeURIComponent(d.pkg)}/`)));
    $("fdRoot").replaceChildren(card);
  }

  return { load, _debug: { state: s } };
}
