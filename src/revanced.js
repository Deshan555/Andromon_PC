// ReVanced page: patch an app on this computer with ReVanced's own patcher, then install the result
// on the phone. The work is done by the main process (../revanced.js): it downloads ReVanced CLI
// and the patches, checks them, and runs the patcher with this computer's Java. This file is the
// page: what is installed, which app, which patches, progress, install.
//
// The app to patch comes from the phone (when it is installed there as one full APK) or from an
// .apk file the person drops here. Andromon never downloads the app itself.
//
// Everything read from the phone or from ReVanced's lists is untrusted: it goes in with
// textContent, never innerHTML.
import { openPackageFiles } from "./apk.js";

const GMS_PKG = "app.revanced.android.gms";
const MANAGER_PKGS = ["app.revanced.manager.flutter", "app.revanced.manager"]; // the released app, and the name its source uses
const CHUNK = 4 * 1024 * 1024;
// Names for the packages people look for most; the rest are shown by package name.
const NAMES = {
  "com.google.android.youtube": "YouTube", "com.google.android.apps.youtube.music": "YouTube Music",
  "com.google.android.apps.photos": "Google Photos", "com.google.android.apps.magazines": "Google News",
  "com.google.android.apps.recorder": "Google Recorder", "com.spotify.music": "Spotify", "com.reddit.frontpage": "Reddit",
  "com.twitter.android": "X (Twitter)", "com.instagram.android": "Instagram", "com.facebook.katana": "Facebook",
  "com.facebook.orca": "Messenger", "com.zhiliaoapp.musically": "TikTok", "com.ss.android.ugc.trill": "TikTok",
  "tv.twitch.android.app": "Twitch", "com.duolingo": "Duolingo", "com.tumblr": "Tumblr", "com.strava": "Strava",
  "com.amazon.mShop.android.shopping": "Amazon Shopping", "com.adobe.lrmobile": "Lightroom", "com.pandora.android": "Pandora",
  "com.soundcloud.android": "SoundCloud", "com.crunchyroll.crunchyroid": "Crunchyroll", "com.disney.disneyplus": "Disney+",
  "com.primevideo": "Prime Video", "com.amazon.avod.thirdpartyclient": "Prime Video", "com.myfitnesspal.android": "MyFitnessPal",
  "com.bandcamp.android": "Bandcamp", "com.letterboxd.letterboxd": "Letterboxd", "com.microsoft.office.officelens": "Microsoft Lens",
  "com.tinder": "Tinder", "com.viber.voip": "Viber", "org.telegram.messenger": "Telegram", "com.pixiv.android": "pixiv",
  "com.nytimes.android": "The New York Times", "com.openai.chatgpt": "ChatGPT", "com.proton.android.mail": "Proton Mail",
};
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });

export function initRevanced(base) {
  const { $, el, toast, showError, clearError, sh, shQuote, withSync, busy, fmtSize, spinner, actionBtn, appIdent, getAdb } = base;
  const api = globalThis.andromon?.revanced || null;
  const s = {
    status: null, patches: null, apps: [], // apps: [{ pkg, patches, versions, best }]
    phone: null,                           // { serial, installed: Map pkg -> { version, paths }, maker }
    tools: null,                           // newest Manager / GmsCore, from ReVanced
    job: null,                             // the app being patched
    q: "", q2: "", working: false,
  };
  let progressTo = null, logTo = null, optIds = 0;
  api?.onEvent((ev) => {
    if (ev.kind === "progress") progressTo?.(ev);
    else if (ev.kind === "log") logTo?.(ev.line);
  });
  const nameOf = (pkg) => NAMES[pkg] || pkg;
  const h2 = (text) => el("h2", { style: "margin:0 0 6px", textContent: text });
  const para = (text) => el("p", { className: "muted", style: "margin:0 0 12px", textContent: text });

  // ---------- what ReVanced can patch ----------
  function indexApps() {
    const map = new Map();
    for (const p of s.patches) for (const k of p.packages || []) {
      let a = map.get(k.name);
      if (!a) map.set(k.name, a = { pkg: k.name, patches: 0, count: new Map() });
      a.patches++;
      for (const v of k.versions) a.count.set(v, (a.count.get(v) || 0) + 1);
    }
    s.apps = [...map.values()].map((a) => {
      const versions = [...a.count.keys()].sort(byVersion);
      const most = Math.max(0, ...a.count.values());
      // The version most patches were made for; the newest one when several tie.
      const best = versions.filter((v) => a.count.get(v) === most).pop() || null;
      return { pkg: a.pkg, patches: a.patches, versions, best };
    }).sort((a, b) => (NAMES[b.pkg] ? 1 : 0) - (NAMES[a.pkg] ? 1 : 0) || nameOf(a.pkg).localeCompare(nameOf(b.pkg))); // the well-known ones first
  }
  // Does this patch work on this app at this version? "version" false = made for other versions.
  function fit(patch, pkg, version) {
    if (!patch.packages) return { any: true, version: true };
    const k = patch.packages.find((x) => x.name === pkg);
    if (!k) return null;
    return { any: false, version: !k.versions.length || !version || k.versions.includes(version) };
  }

  // ---------- the phone ----------
  async function readPhone() {
    const adb = getAdb();
    if (!adb) { s.phone = null; return; }
    const out = await sh("pm list packages --user 0").catch(() => "");
    const all = new Set(out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice(8)));
    const want = [...new Set([GMS_PKG, ...MANAGER_PKGS, ...s.apps.map((a) => a.pkg)])].filter((p) => all.has(p) && /^[\w.]+$/.test(p));
    const installed = new Map();
    if (want.length) {
      // One round trip: for each package its version and where its APK files are.
      const dump = await sh(`for p in ${want.join(" ")}; do echo "@@$p"; dumpsys package $p | grep -m1 versionName=; pm path --user 0 $p; done`).catch(() => "");
      let cur = null;
      for (const raw of dump.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("@@")) installed.set(line.slice(2), cur = { version: "", paths: [] });
        else if (cur && line.startsWith("versionName=")) cur.version = line.slice(12);
        else if (cur && line.startsWith("package:")) cur.paths.push(line.slice(8));
      }
    }
    const maker = (await sh("getprop ro.product.manufacturer").catch(() => "")).trim().toLowerCase();
    // Every app the person installed: any of them can be patched with the general patches.
    const mineOut = await sh("pm list packages --user 0 -3").catch(() => "");
    const user = mineOut.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice(8)).filter((p) => /^[\w.]+$/.test(p)).sort();
    s.phone = { serial: adb.serial, installed, maker, user };
  }
  // Version and APK files of one app on the phone, read when it is chosen.
  async function appOnPhone(pkg) {
    const dump = await sh(`dumpsys package ${shQuote(pkg)} | grep -m1 versionName=; pm path --user 0 ${shQuote(pkg)}`);
    const lines = dump.split("\n").map((l) => l.trim());
    return {
      version: (lines.find((l) => l.startsWith("versionName=")) || "").slice(12),
      paths: lines.filter((l) => l.startsWith("package:")).map((l) => l.slice(8)),
    };
  }

  // Sends a file kept by the main process ("out", "manager", "gmscore") to the phone and installs it.
  async function installFromPc(which, size, label, onStep) {
    const remote = `/data/local/tmp/andromon-rv-${Date.now()}.apk`;
    let off = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (off >= size) return c.close();
        const chunk = await api.read(which, off, CHUNK);
        if (!chunk.byteLength) return c.close();
        off += chunk.byteLength;
        onStep(`Copying to the phone… ${Math.round(off / size * 100)}%`);
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
  }
  function installError(out, label) {
    if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) {
      return `The phone already has ${label} from another source, signed with a different key, so Android won't replace it. ` +
        "Uninstall that copy on the phone first (this deletes its data), then install again.";
    }
    if (/CONFLICTING_PROVIDER/i.test(out)) {
      return `Android won't install this copy next to the original: both use the same content-provider name. Patch again with “Change package name” and switch on its setting “Update providers”.`;
    }
    if (/DUPLICATE_PERMISSION/i.test(out)) {
      return `Android won't install this copy next to the original: both declare the same permission. Patch again with “Change package name” and switch on its setting “Update permissions”.`;
    }
    if (/VERSION_DOWNGRADE/i.test(out)) return `The phone has a newer ${label} than this one. Android refuses downgrades: uninstall it first, or patch a newer version.`;
    if (/INSUFFICIENT_STORAGE/i.test(out)) return "The phone doesn't have enough free space.";
    if (/USER_RESTRICTED|INSTALL_FAILED_VERIFICATION|canceled by user/i.test(out)) return "The phone refused the install. Look at the phone: it may be asking to allow it (\"Install via USB\" or Play Protect).";
    return `Install failed: ${(out.match(/Failure \[(.+?)\]/)?.[1] || out.split("\n")[0] || "unknown error").slice(0, 300)}`;
  }

  // ---------- page ----------
  async function load(force = false) {
    const root = $("rvRoot");
    if (!api) {
      root.replaceChildren(el("div", { className: "card" }, h2("ReVanced"), para("Patching runs a program on this computer, so it's only available in the Andromon desktop app.")));
      return;
    }
    if (s.working) return; // a download or patch is running: keep its progress on screen
    if (!s.status || force) root.replaceChildren(el("div", { className: "empty" }, spinner(), " Checking…"));
    s.status = await api.status();
    const ready = s.status.java?.ok && s.status.cli && s.status.patches;
    if (ready && (!s.patches || force)) { s.patches = await api.patches(); indexApps(); }
    if (!ready) { s.patches = null; s.apps = []; }
    if (ready && (force || s.phone?.serial !== getAdb()?.serial)) { await readPhone(); if (s.job?.source === "phone") s.job = null; }
    render();
    if (ready && !s.tools) api.toolInfo().then((t) => { s.tools = t; if (!s.working) render(); }).catch(() => {});
  }

  function render() {
    const root = $("rvRoot");
    const ready = s.status.java?.ok && s.status.cli && s.status.patches;
    root.replaceChildren(setupCard(ready), ...(ready ? [phoneCard(), s.job ? jobCard() : appsCard()] : []));
  }

  // ----- the patcher on this computer -----
  function setupCard(ready) {
    const st = s.status;
    const card = el("div", { className: "card" });
    const progress = el("div", { className: "muted small", style: "margin-top:10px", hidden: true });
    const badge = el("span", { className: `badge ${ready ? "on" : "neutral"}`, textContent: ready ? "Ready" : "Not set up" });
    card.append(el("div", { className: "toolbar", style: "justify-content:space-between;margin-bottom:8px" }, el("h2", { style: "margin:0", textContent: "ReVanced patcher" }), badge));
    card.append(para("ReVanced changes an app by patching its APK: for example YouTube without ads and with background play. " +
      "Andromon runs ReVanced's own patcher on this computer and installs the result on the phone."));

    const rows = el("div", { className: "grid", style: "margin-bottom:14px" });
    const stat = (k, v) => el("div", { className: "stat" }, el("div", { className: "k", textContent: k }), el("div", { className: "v", textContent: v }));
    rows.append(
      stat("Java on this computer", st.java ? `${st.java.version}${st.java.ok ? "" : ` (needs ${st.minJava} or newer)`}` : "Not found"),
      stat("ReVanced CLI", st.cli ? st.cli.version : "Not downloaded"),
      stat("Patches", st.patches ? `${String(st.patches.version).replace(/^v/, "")}${st.patches.createdAt ? ` · ${String(st.patches.createdAt).slice(0, 10)}` : ""}` : "Not downloaded"),
    );
    card.append(rows);

    if (!st.java?.ok) {
      const again = actionBtn("Check again", "Checking…", async () => { s.status = await api.recheckJava(); await load(true); });
      card.append(el("div", { className: "notice" },
        `The patcher is a Java program and needs Java ${st.minJava} or newer. Install a free one, for example Eclipse Temurin from adoptium.net, then click “Check again”.`),
        el("div", { className: "toolbar", style: "margin:0" }, again));
      return card;
    }
    const get = el("button", { className: "btn" + (ready ? " sm" : " primary"), type: "button", textContent: ready ? "Check for new patches" : "Download the patcher (about 60 MB)" });
    get.onclick = async () => {
      clearError(); busy(get, true, "Downloading…"); s.working = true; progress.hidden = false;
      progressTo = (ev) => { progress.textContent = `${ev.what}: ${fmtSize(ev.done)}${ev.total ? ` of ${fmtSize(ev.total)}` : ""}`; };
      try {
        const before = s.status.patches?.version;
        s.status = await api.setup();
        s.working = false;
        toast(before && before === s.status.patches?.version ? "The patches are up to date" : "ReVanced patcher is ready");
        await load(true);
      } catch (e) { showError(e); }
      finally { s.working = false; progressTo = null; progress.hidden = true; if (get.isConnected) busy(get, false); }
    };
    const bar = el("div", { className: "toolbar", style: "margin:0" }, get);
    if (st.cli || st.patches) {
      const clear = actionBtn("Remove downloads", "Removing…", async () => { s.job = null; s.status = await api.clear(); toast("ReVanced downloads removed"); await load(true); }, { confirm: true });
      bar.append(clear);
    }
    card.append(bar, progress);
    card.append(el("p", { className: "muted small", style: "margin:14px 0 0" },
      "ReVanced is an independent open-source project (revanced.app); Andromon isn't part of it. Its tools are downloaded only from revanced.app and github.com/ReVanced, " +
      "and the patches are checked against ReVanced's signature. Andromon never downloads the apps themselves. " +
      "A patched app isn't supported by its maker and may go against that app's terms of use."));
    return card;
  }

  // ----- ReVanced's helper apps on the phone -----
  function phoneCard() {
    const card = el("div", { className: "card" }, h2("On the phone"));
    if (!s.phone) { card.append(para("Connect a phone to see what it has.")); return card; }
    const row = (which, pkgs, title, text) => {
      const have = pkgs.map((p) => s.phone.installed.get(p)).find(Boolean);
      const latest = s.tools?.[which];
      const newer = have && latest && byVersion(String(have.version).replace(/^v/, ""), latest.version) < 0;
      const state = el("span", { className: `badge ${have ? (newer ? "neutral" : "on") : "neutral"}`, textContent: have ? (newer ? `${have.version} · update to ${latest.version}` : `Installed ${have.version}`) : "Not installed" });
      const note = el("span", { className: "muted small" });
      const line = el("div", { className: "toolbar", style: "margin:0;gap:10px" });
      if (!have || newer) {
        const btn = el("button", { className: "btn sm", type: "button", textContent: `${have ? "Update" : "Install"}${latest?.size ? ` (${fmtSize(latest.size)})` : ""}` });
        btn.onclick = async () => {
          clearError(); busy(btn, true, "Downloading…"); s.working = true;
          progressTo = (ev) => { note.textContent = `${fmtSize(ev.done)}${ev.total ? ` of ${fmtSize(ev.total)}` : ""}`; };
          try {
            const got = await api.fetchTool(which, /huawei/.test(s.phone.maker));
            progressTo = null;
            await installFromPc(which, got.size, title, (t) => { note.textContent = t; });
            toast(`${title} ${got.version} installed`);
            s.working = false;
            await readPhone(); render();
          } catch (e) { showError(e); note.textContent = ""; }
          finally { s.working = false; progressTo = null; if (btn.isConnected) busy(btn, false); }
        };
        line.append(btn);
      }
      line.append(note);
      return el("div", { className: "rv-row" },
        el("div", { style: "flex:1;min-width:220px" }, el("div", {}, el("b", { textContent: title }), state), el("div", { className: "muted small", textContent: text })),
        line);
    };
    card.append(
      row("gmscore", [GMS_PKG], "GmsCore", "Needed to sign in with a Google account in patched YouTube and YouTube Music. Other patched apps don't need it."),
      row("manager", MANAGER_PKGS, "ReVanced Manager", "Optional. ReVanced's own app, for patching on the phone itself."),
    );
    return card;
  }

  // ----- choose an app -----
  function appsCard() {
    const card = el("div", { className: "card" });
    card.append(h2("Patch an app"));

    const input = el("input", { type: "file", accept: ".apk", hidden: true });
    const drop = el("div", { className: "drop", style: "margin:4px 0 16px" }, "Drop an ", el("b", { textContent: ".apk" }), " here, or click to choose one");
    const take = (file) => { if (file) openFile(file, drop).catch(showError); };
    drop.onclick = () => input.click();
    input.onchange = () => { const f = input.files[0]; input.value = ""; take(f); };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files[0]); };
    card.append(drop, input);

    const mine = s.phone ? s.apps.filter((a) => s.phone.installed.has(a.pkg)) : [];
    if (s.phone) {
      card.append(el("h3", { style: "margin:0 0 4px", textContent: "On this phone" }));
      if (!mine.length) card.append(para("None of the apps ReVanced has patches for are on this phone."));
      for (const a of mine) card.append(appRow(a, s.phone.installed.get(a.pkg)));
    }

    const search = el("input", { type: "search", placeholder: "Search apps…", value: s.q });
    const list = el("div");
    const fill = () => {
      const q = s.q.toLowerCase();
      const rest = s.apps.filter((a) => !mine.includes(a) && (a.pkg.toLowerCase().includes(q) || nameOf(a.pkg).toLowerCase().includes(q)));
      list.replaceChildren(...(rest.length ? rest.map((a) => appRow(a, null)) : [el("div", { className: "empty", textContent: "No app matches" })]));
    };
    search.oninput = () => { s.q = search.value; fill(); };
    fill();
    const all = el("details", { style: "margin-top:16px", open: !mine.length || !!s.q },
      el("summary", { textContent: `All ${s.apps.length} apps ReVanced has patches for` }),
      el("div", { className: "toolbar", style: "margin:12px 0 4px" }, search), list);
    card.append(all);

    // Any other app on the phone: ReVanced's general patches work on every app.
    const others = s.phone ? s.phone.user.filter((p) => !mine.some((a) => a.pkg === p)) : [];
    if (others.length) {
      const find = el("input", { type: "search", placeholder: "Search this phone's apps…", value: s.q2 });
      const box = el("div");
      const show = () => {
        const q = s.q2.toLowerCase();
        const hit = others.filter((p) => p.toLowerCase().includes(q));
        box.replaceChildren(...(hit.length ? hit.map(anyRow) : [el("div", { className: "empty", textContent: "No app matches" })]));
      };
      find.oninput = () => { s.q2 = find.value; show(); };
      // Rows are built when the list is opened: each one asks the phone for its icon.
      const any = el("details", { style: "margin-top:12px", open: !!s.q2 },
        el("summary", { textContent: `Any other app on this phone (${others.length})` }),
        el("p", { className: "muted small", style: "margin:10px 0 0", textContent:
          "ReVanced has no patches made for these, but its general patches work on any app: make a second copy with another package name, " +
          "allow screenshots, turn off certificate pinning, hide developer settings from the app, and more." }),
        el("div", { className: "toolbar", style: "margin:12px 0 4px" }, find), box);
      any.ontoggle = () => { if (any.open && !box.childNodes.length) show(); };
      if (any.open) show();
      card.append(any);
    }
    return card;
  }

  function anyRow(pkg) {
    const btn = actionBtn("Patch", "Reading…", async () => {
      const have = await appOnPhone(pkg);
      if (!have.paths.length) throw new Error("That app is no longer on the phone.");
      startJob({ pkg, label: nameOf(pkg), version: have.version, source: "phone", paths: have.paths });
    });
    return el("div", { className: "rv-row" }, el("div", { style: "flex:1;min-width:0" }, appIdent(pkg)), btn);
  }

  function appRow(a, have) {
    const who = have
      ? appIdent(a.pkg)
      : el("div", {}, el("div", { textContent: nameOf(a.pkg) }), NAMES[a.pkg] ? el("div", { className: "mono muted", textContent: a.pkg }) : "");
    const info = el("div", { className: "muted small", style: "text-align:right" });
    const made = a.best ? `Patches are for ${a.best}` : "Any version";
    if (have) {
      const ok = !a.versions.length || a.versions.includes(have.version);
      info.append(el("span", { className: `badge ${ok ? "on" : "neutral"}`, textContent: ok ? `${have.version} · supported` : `Phone has ${have.version}` }), el("div", { textContent: ok ? `${a.patches} patches` : made }));
    } else info.textContent = `${a.patches} patch${a.patches === 1 ? "" : "es"} · ${made}`;
    const row = el("div", { className: "rv-row" }, el("div", { style: "flex:1;min-width:0" }, who), info);
    if (have) {
      const btn = el("button", { className: "btn sm", type: "button", textContent: "Patch" });
      btn.onclick = () => { startJob({ pkg: a.pkg, label: nameOf(a.pkg), version: have.version, source: "phone", paths: have.paths }); };
      row.append(btn);
    }
    return row;
  }

  // A dropped file: read which app and version it is, hand its path to the patcher.
  async function openFile(file, drop) {
    clearError();
    if (!/\.apk$/i.test(file.name)) throw new Error("Choose a single .apk file. Split bundles (.apks, .xapk, .apkm) can't be patched: ReVanced needs the full APK.");
    const idle = [...drop.childNodes];
    drop.replaceChildren(spinner(), ` Reading ${file.name}…`);
    try {
      const { info } = await openPackageFiles([file]);
      if (!info.package) throw new Error("Couldn't read that APK.");
      const got = await api.inputFile(file);
      startJob({ pkg: info.package, label: info.label || nameOf(info.package), version: info.versionName || "", source: "file", file, fileName: got.name, size: got.size });
    } finally { if (drop.isConnected) drop.replaceChildren(...idle); }
  }

  function startJob(job) {
    // Ticked to begin with: the patches ReVanced switches on by default that fit this version.
    const list = s.patches.map((p) => ({ p, fit: fit(p, job.pkg, job.version) })).filter((x) => x.fit);
    job.list = list;
    job.ticks = new Set(list.filter((x) => !x.fit.any && x.p.enabled && x.fit.version).map((x) => x.p.name));
    job.force = false; job.log = []; job.result = null; job.opts = {}; // opts: { patch: { setting: value } }
    s.job = job;
    render();
    $("rvRoot").querySelector("#rvJob")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // ----- choose patches, patch, install -----
  function jobCard() {
    const job = s.job;
    const app = s.apps.find((a) => a.pkg === job.pkg);
    const card = el("div", { className: "card", id: "rvJob" });
    const back = el("button", { className: "btn sm", type: "button", textContent: "‹ Other app" });
    back.onclick = () => { s.job = null; render(); };
    card.append(el("div", { className: "toolbar", style: "justify-content:space-between;margin-bottom:10px" },
      el("div", { style: "min-width:0" }, el("h2", { style: "margin:0", textContent: job.label }),
        el("div", { className: "mono muted", textContent: `${job.pkg}${job.version ? ` · ${job.version}` : ""} · ${job.source === "phone" ? "from the phone" : job.fileName}` })),
      back));

    const mine = job.list.filter((x) => !x.fit.any);
    const anyApp = job.list.filter((x) => x.fit.any);
    const split = job.source === "phone" && job.paths.length !== 1;
    const wrongVersion = mine.length > 0 && !mine.some((x) => x.fit.version);

    if (split) {
      card.append(el("div", { className: "notice" },
        `The phone holds ${job.label} as ${job.paths.length} separate parts (a split install from the Play Store). ReVanced needs the app as one full APK. ` +
        `Get the full APK${app?.best ? ` of version ${app.best}` : job.version ? ` of version ${job.version}` : ""} from a source you trust, then drop it on “Patch an app”.`));
      return card;
    }
    if (!mine.length) card.append(el("div", { className: "notice" }, "ReVanced has no patches made for this app. Only the general patches below can be tried."));
    else if (wrongVersion) {
      card.append(el("div", { className: "notice" },
        `The patches are made for version ${app.versions.join(", ")}; this is ${job.version || "another version"}. ` +
        `Best: patch an APK of version ${app.best}. You can also try this version anyway; patches often fail on versions they weren't made for.`));
    }

    const count = el("span", { className: "muted small" });
    const go = el("button", { className: "btn primary", type: "button", textContent: "Patch" });
    const stop = el("button", { className: "btn", type: "button", textContent: "Cancel", hidden: true });
    const force = el("input", { type: "checkbox", checked: job.force });
    const boxes = [], optBoxes = [];
    const update = () => {
      count.textContent = `${job.ticks.size} patch${job.ticks.size === 1 ? "" : "es"} ticked`;
      go.disabled = !job.ticks.size || (wrongVersion && !job.force);
    };
    const patchRow = (x) => {
      const off = !x.fit.version && !job.force;
      const box = el("input", { type: "checkbox", checked: job.ticks.has(x.p.name) && !off, disabled: off });
      box.onchange = () => { if (box.checked) job.ticks.add(x.p.name); else job.ticks.delete(x.p.name); update(); };
      boxes.push({ box, x });
      const title = el("div", {}, x.p.name);
      if (!x.fit.version) title.append(el("span", { className: "badge neutral", textContent: "other versions" }));
      const row = el("label", { className: "rv-patch" }, box, el("div", { style: "min-width:0" }, title, el("div", { className: "muted small", textContent: x.p.description })));
      if (!x.p.options.length) return row;
      // The patch's own settings, shown while it is ticked. Untouched ones keep ReVanced's default.
      const set = el("div", { className: "rv-opts", hidden: !box.checked });
      for (const o of x.p.options) set.append(optionRow(x.p.name, o));
      box.addEventListener("change", () => { set.hidden = !box.checked; });
      optBoxes.push({ box, set });
      return el("div", {}, row, set);
    };
    const setAll = (pick) => {
      for (const { box, x } of boxes) {
        if (x.fit.any || box.disabled) continue;
        box.checked = pick(x);
        if (box.checked) job.ticks.add(x.p.name); else job.ticks.delete(x.p.name);
      }
      for (const o of optBoxes) o.set.hidden = !o.box.checked;
      update();
    };
    // One setting of a patch: a switch for yes/no, a text box for text and numbers. Lists and other
    // kinds can't be typed here and stay at ReVanced's default.
    function optionRow(patch, o) {
      const mine = (job.opts[patch] ||= {});
      const text = el("div", { style: "min-width:0;flex:1" }, o.name + (o.required && !o.default ? " (required)" : ""),
        el("div", { className: "muted small", textContent: o.description }));
      if (o.type === "Boolean") {
        const c = el("input", { type: "checkbox", checked: (mine[o.name] ?? o.default) === "true" });
        c.onchange = () => { mine[o.name] = String(c.checked); };
        return el("label", { className: "rv-patch" }, c, text);
      }
      if (!/^(String|Int|Long|Float)$/.test(o.type)) {
        return el("div", { className: "rv-patch" }, el("span", { style: "width:13px;flex:none" }), el("div", { style: "min-width:0" }, o.name, el("div", { className: "muted small", textContent: "Uses ReVanced's default." })));
      }
      const id = `rvo${++optIds}`;
      const inp = el("input", { type: "text", value: mine[o.name] ?? "", placeholder: o.default && o.default !== "Default" ? `Default: ${o.default}` : "Default", spellcheck: false });
      if (o.values.length) {
        inp.setAttribute("list", id);
        text.append(el("datalist", { id }, ...o.values.map((v) => el("option", { value: v.value, label: v.label }))));
      }
      inp.oninput = () => { const v = inp.value.trim(); if (v) mine[o.name] = v; else delete mine[o.name]; };
      return el("div", { className: "rv-patch rv-opt" }, el("span", { style: "width:13px;flex:none" }), text, inp);
    }
    const tools = el("div", { className: "toolbar", style: "margin:0 0 6px" });
    const mk = (text, pick) => { const b = el("button", { className: "btn sm", type: "button", textContent: text }); b.onclick = () => setAll(pick); return b; };
    if (mine.length) tools.append(mk("ReVanced's choice", (x) => x.p.enabled), mk("All", () => true), mk("None", () => false));
    tools.append(count);
    const listBox = el("div", { className: "rv-patches" }, ...mine.map(patchRow));
    const anyBox = el("details", { style: "margin-top:10px", open: !mine.length },
      el("summary", { textContent: `${anyApp.length} general patches that work on any app` }),
      el("div", { className: "rv-patches" }, ...anyApp.map(patchRow)));
    card.append(tools, ...(mine.length ? [listBox] : []), anyBox);

    if (wrongVersion) {
      force.onchange = () => { job.force = force.checked; if (!job.force) for (const x of mine) job.ticks.delete(x.p.name); render(); };
      card.append(el("label", { className: "rv-patch", style: "margin-top:12px" }, force,
        el("div", {}, "Try this version anyway", el("div", { className: "muted small", textContent: "Skips ReVanced's version check." }))));
    }

    const step = el("span", { className: "muted small" });
    const log = el("pre", { className: "out rv-log", hidden: !job.log.length, textContent: job.log.join("\n") });
    const result = el("div");
    card.append(el("div", { className: "toolbar", style: "margin:16px 0 0" }, go, stop, step), log, result);

    const addLog = (line) => {
      // One line per patch that wasn't ticked, and the work folder's path: noise.
      if (/" disabled\s*$/.test(line) || /^INFO: Saved to /.test(line)) return;
      job.log.push(line.replace(/^INFO:\s*/, ""));
      log.hidden = false; log.textContent = job.log.join("\n"); log.scrollTop = log.scrollHeight;
    };
    stop.onclick = () => { api.cancel().catch(() => {}); };
    go.onclick = async () => {
      clearError(); job.log = []; job.result = null; result.replaceChildren(); log.textContent = "";
      busy(go, true, "Patching…"); s.working = true;
      for (const { box } of boxes) box.disabled = true;
      try {
        if (job.source === "phone") {
          step.textContent = "Copying the app from the phone…";
          await pullFromPhone(job, (t) => { step.textContent = t; });
        } else {
          // The file may have been replaced by another choice since: name it again.
          if (job.file) await api.inputFile(job.file);
        }
        step.textContent = "Patching. This takes a few minutes for a large app.";
        stop.hidden = false; logTo = addLog;
        job.result = await api.patch({ patches: [...job.ticks], force: job.force, options: Object.fromEntries([...job.ticks].filter((n) => job.opts[n]).map((n) => [n, job.opts[n]])) });
        toast(`${job.label} patched`);
      } catch (e) { showError(e); }
      finally {
        logTo = null; s.working = false; stop.hidden = true; step.textContent = "";
        if (go.isConnected) { busy(go, false); for (const { box, x } of boxes) box.disabled = !x.fit.version && !job.force; update(); showResult(); }
      }
    };

    function showResult() {
      const r = job.result;
      if (!r) return result.replaceChildren();
      const usesGms = job.ticks.has("GmsCore support");
      const renamed = usesGms || job.ticks.has("Change package name"); // installs next to the original
      const kids = [el("div", { className: "at-summary ok", style: "margin-top:14px" }, `Patched: ${r.name} (${fmtSize(r.size)})`)];
      for (const f of r.failed || []) kids.push(el("div", { className: "notice", style: "margin-bottom:8px", textContent: f }));
      const note = el("span", { className: "muted small" });
      const bar = el("div", { className: "toolbar", style: "margin:0" });
      if (getAdb()) {
        const inst = el("button", { className: "btn primary", type: "button", textContent: "Install on the phone" });
        inst.onclick = async () => {
          clearError(); busy(inst, true, "Installing…"); s.working = true;
          try {
            await installFromPc("out", r.size, job.label, (t) => { note.textContent = t; });
            note.textContent = "";
            toast(`${job.label} (patched) installed`);
            if (usesGms && s.phone && !s.phone.installed.has(GMS_PKG)) note.textContent = "Installed. To sign in with a Google account in this app, also install GmsCore (above).";
            else note.textContent = "Installed on the phone.";
          } catch (e) { showError(e); note.textContent = ""; }
          finally { s.working = false; if (inst.isConnected) busy(inst, false); }
        };
        bar.append(inst);
      }
      bar.append(actionBtn("Save the APK…", "Saving…", async () => { const name = await api.saveOutput(); if (name) toast(`Saved ${name}`); }), note);
      kids.push(bar);
      if (!renamed) kids.push(el("p", { className: "muted small", style: "margin:12px 0 0", textContent:
        "This patched app keeps the original's package name, so it replaces the original. If the original is still on the phone, uninstall it first (Apps tab); Android won't install one over the other." }));
      result.replaceChildren(...kids);
    }
    update(); showResult();
    return card;
  }

  // Copies the app's APK from the phone to the patcher's work folder, in pieces.
  async function pullFromPhone(job, onStep) {
    const path = job.paths[0];
    const size = Number((await sh(`stat -c %s ${shQuote(path)}`).catch(() => "")).trim()) || 0;
    await api.inputOpen(`${job.pkg}.apk`);
    let ok = false;
    try {
      await withSync(async (sync) => {
        const reader = sync.read(path).getReader();
        let parts = [], held = 0, done = 0;
        const flush = async () => {
          if (!held) return;
          const buf = new Uint8Array(held); let o = 0;
          for (const p of parts) { buf.set(p, o); o += p.length; }
          parts = []; held = 0;
          done = await api.inputWrite(buf);
          onStep(`Copying the app from the phone… ${size ? Math.round(done / size * 100) + "%" : fmtSize(done)}`);
        };
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          parts.push(value.slice()); held += value.length;
          if (held >= CHUNK) await flush();
        }
        await flush();
      });
      ok = true;
    } finally {
      const got = await api.inputClose(ok);
      if (ok && !got) throw new Error("Couldn't copy the app from the phone.");
    }
  }

  return { load, _debug: { startJob, state: s } };
}
