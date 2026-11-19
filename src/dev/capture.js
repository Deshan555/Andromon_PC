// Developer tab › Capture: screen recording, bug reports and a copyable summary of the phone for
// bug tickets. Every string from the phone is untrusted: inserted with textContent / el() only.

const pad = (n) => String(n).padStart(2, "0");
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
const clock = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
const safeName = (s) => String(s || "phone").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "phone";

export function mount(root, ctx) {
  const { el, sh, shQuote } = ctx;

  // Choice pills; returns { node, get() }.
  function seg(options, key, def) {
    let val = ctx.store.get(key, def);
    if (!options.some(([v]) => v === val)) val = def;
    const node = el("div", { className: "seg" });
    for (const [v, label] of options) {
      const b = el("button", { type: "button", textContent: label });
      b.onclick = () => { val = v; ctx.store.set(key, v); sync(); };
      b.dataset.v = String(v);
      node.append(b);
    }
    const sync = () => { for (const b of node.children) b.classList.toggle("on", b.dataset.v === String(val)); };
    sync();
    return { node, get: () => val, disable(on) { for (const b of node.children) b.disabled = on; } };
  }
  const field = (label, control) => el("div", { className: "cap-field" }, el("span", { className: "dev-lbl", textContent: label }), control);

  /** Reads a phone file with a progress callback (bytes, total). */
  function pull(path, onProgress) {
    return ctx.withSync(async (sync) => {
      let total = 0;
      try { total = Number((await sync.stat(path)).size) || 0; } catch {}
      const reader = sync.read(path).getReader(), parts = [];
      let got = 0, held = 0, blob = new Blob([]);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value.slice()); got += value.length; held += value.length;
        onProgress?.(got, total);
        // Folded into a Blob every 16 MB so a long recording isn't held whole in the page's memory.
        if (held >= 16 * 1024 * 1024) { blob = new Blob([blob, ...parts]); parts.length = 0; held = 0; }
      }
      return new Blob([blob, ...parts]);
    });
  }

  // ======================= 1. screen recording =======================
  const recSize = seg([["full", "Full"], ["720", "720p"]], "cap.size", "full");
  const recRate = seg([[4, "4 Mbps"], [8, "8 Mbps"], [16, "16 Mbps"]], "cap.rate", 8);
  const recLen = seg([[30, "30 s"], [60, "1 min"], [180, "3 min"]], "cap.len", 180);
  let showTaps = ctx.store.get("cap.taps", false);
  const tapsSw = ctx.makeSwitch(showTaps, async (want) => { showTaps = want; ctx.store.set("cap.taps", want); return want; });
  const recBtn = el("button", { className: "btn primary", type: "button", textContent: "Start recording" });
  const recTimer = el("span", { className: "cap-timer", hidden: true });
  const recOut = el("div", { className: "cap-result" });

  let rec = null; // { proc, path, started, timer, stopping, taps, out[] }
  let lastVideo = null; // { url, blob, name }

  recBtn.onclick = () => (rec ? stopRec() : startRec().catch((e) => { ctx.showError(e); resetRecUi(); }));

  async function screenSizeArg() {
    if (recSize.get() !== "720") return "";
    const out = await sh("wm size");
    const m = out.match(/Override size: (\d+)x(\d+)/) || out.match(/Physical size: (\d+)x(\d+)/);
    if (!m) return "";
    let w = +m[1], h = +m[2];
    const short = Math.min(w, h);
    if (short <= 720) return "";
    const k = 720 / short;
    w = Math.round((w * k) / 2) * 2; h = Math.round((h * k) / 2) * 2;
    return `--size ${w}x${h}`;
  }

  async function startRec() {
    if (!ctx.getAdb()) return;
    ctx.clearError();
    const path = `/sdcard/dd-rec-${stamp()}.mp4`;
    const limit = recLen.get(), rate = recRate.get() * 1_000_000;
    const sizeArg = await screenSizeArg();
    let taps = null;
    if (showTaps) {
      taps = (await sh("settings get system show_touches").catch(() => "0")).trim();
      await sh("settings put system show_touches 1").catch(() => {});
    }
    const proc = await ctx.spawn(`screenrecord --bit-rate ${rate} ${sizeArg} --time-limit ${limit} ${shQuote(path)} 2>&1`);
    const r = { proc, path, started: Date.now(), limit, taps, out: [], stopping: false, timer: 0 };
    rec = r;
    ctx.readLines(proc, (l) => { if (l.trim()) r.out.push(l.trim()); });
    for (const s of [recSize, recRate, recLen]) s.disable(true);
    tapsSw.disabled = true;
    recBtn.textContent = "Stop and save";
    recBtn.classList.add("danger-fill");
    recTimer.hidden = false;
    const tick = () => { recTimer.textContent = `● ${clock((Date.now() - r.started) / 1000)} / ${clock(limit)}`; };
    tick(); r.timer = setInterval(tick, 500);
    // Ends by itself at the time limit, or when Stop sends it Ctrl+C.
    proc.exited.catch(() => {}).then(() => finishRec(r));
  }

  async function stopRec() {
    const r = rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    ctx.busy(recBtn, true, "Saving…");
    // screenrecord only finishes the MP4 cleanly on SIGINT.
    await sh("pkill -INT screenrecord 2>/dev/null || kill -2 $(pidof screenrecord) 2>/dev/null").catch(() => {});
    await Promise.race([r.proc.exited.catch(() => {}), new Promise((res) => setTimeout(res, 6000))]);
    await finishRec(r);
  }

  async function finishRec(r) {
    if (r.done) return;
    r.done = true;
    clearInterval(r.timer);
    try {
      if (!ctx.getAdb()) return;
      await new Promise((res) => setTimeout(res, 1000)); // let the file be closed
      if (r.taps !== null) await sh(`settings put system show_touches ${shQuote(r.taps === "1" ? "1" : "0")}`).catch(() => {});
      const exists = (await sh(`ls ${shQuote(r.path)} 2>/dev/null`).catch(() => "")).trim();
      if (!exists) throw new Error(`The recording didn't start.${r.out.length ? " Phone said: " + r.out.slice(-2).join(" ") : ""}`);
      const blob = new Blob([await pull(r.path)], { type: "video/mp4" });
      await sh(`rm -f ${shQuote(r.path)}`).catch(() => {});
      if (!blob.size) throw new Error("The recording came back empty.");
      const name = `screen-${stamp()}.mp4`;
      if (lastVideo) URL.revokeObjectURL(lastVideo.url);
      lastVideo = { url: URL.createObjectURL(blob), blob, name };
      ctx.download(blob, name);
      showVideo();
      ctx.toast("Recording saved");
    } catch (e) {
      ctx.showError(e);
    } finally {
      if (rec === r) { rec = null; resetRecUi(); }
    }
  }

  function resetRecUi() {
    if (recBtn.getAttribute("aria-busy")) ctx.busy(recBtn, false);
    recBtn.textContent = "Start recording";
    recBtn.classList.remove("danger-fill");
    recBtn.disabled = false;
    recTimer.hidden = true;
    for (const s of [recSize, recRate, recLen]) s.disable(false);
    tapsSw.disabled = false;
  }

  function showVideo() {
    if (!lastVideo) { recOut.replaceChildren(); return; }
    const video = el("video", { src: lastVideo.url, controls: true, className: "cap-video" });
    const save = el("button", { className: "btn sm", type: "button", textContent: "Save again" });
    save.onclick = () => ctx.download(lastVideo.blob, lastVideo.name);
    const drop = el("button", { className: "btn sm", type: "button", textContent: "Close preview" });
    drop.onclick = () => { URL.revokeObjectURL(lastVideo.url); lastVideo = null; showVideo(); };
    recOut.replaceChildren(video, el("div", { className: "dev-row" },
      el("span", { className: "muted", textContent: `${lastVideo.name} · ${ctx.fmtSize(lastVideo.blob.size)}` }), save, drop));
  }

  root.append(ctx.card("Screen recording", recTimer,
    el("div", { className: "cap-opts" },
      field("Size", recSize.node), field("Quality", recRate.node), field("Longest", recLen.node),
      field("Show taps", tapsSw)),
    el("div", { className: "dev-row" }, recBtn),
    el("p", { className: "dev-note", textContent: "Records the phone's screen to an MP4 on this computer. Android stops a recording after 3 minutes. Sound isn't recorded." }),
    recOut));

  // ======================= 2. bug report =======================
  const bugBtn = el("button", { className: "btn primary", type: "button", textContent: "Create bug report" });
  const bugCancel = el("button", { className: "btn", type: "button", textContent: "Cancel", hidden: true });
  const bugBar = el("i", { style: "width:0%" });
  const bugProg = el("div", { className: "bar cap-bar", hidden: true }, bugBar);
  const bugStatus = el("div", { className: "muted cap-status" });
  let bug = null; // { proc, cancelled }

  bugBtn.onclick = () => makeBugreport().catch((e) => ctx.showError(e));
  bugCancel.onclick = () => {
    if (!bug) return;
    bug.cancelled = true;
    Promise.resolve().then(() => bug.proc.kill()).catch(() => {});
    bugStatus.textContent = "Cancelled.";
  };

  async function makeBugreport() {
    if (!ctx.getAdb() || bug) return;
    ctx.clearError();
    const model = (await sh("getprop ro.product.model").catch(() => "")).trim();
    const proc = await ctx.spawn("bugreportz -p 2>&1");
    const b = bug = { proc, cancelled: false };
    bugBtn.disabled = true; bugCancel.hidden = false; bugProg.hidden = false; bugBar.style.width = "0%";
    bugStatus.textContent = "Collecting logs and system state. This takes 1–3 minutes…";
    let okPath = "", fail = "", other = [];
    try {
      await ctx.readLines(proc, (l) => {
        for (const part of l.split("\r")) {
          const line = part.trim();
          let m;
          if ((m = line.match(/^PROGRESS:(\d+)\/(\d+)/))) {
            const pct = Math.min(100, (100 * +m[1]) / Math.max(1, +m[2]));
            bugBar.style.width = pct.toFixed(1) + "%";
            bugStatus.textContent = `Collecting logs and system state… ${Math.floor(pct)}%`;
          } else if ((m = line.match(/^OK:(.+)$/))) okPath = m[1].trim();
          else if ((m = line.match(/^FAIL:(.*)$/))) fail = m[1].trim();
          else if ((m = line.match(/^BEGIN:(.+)$/))) b.path = m[1].trim();
          else if (line) other.push(line);
        }
      });
      if (b.cancelled) return;
      if (!okPath) {
        const why = fail || other.slice(-2).join(" ");
        throw new Error(/not found|inaccessible/i.test(why)
          ? "This phone can't make bug reports over USB (needs Android 7 or later)."
          : `The bug report failed.${why ? " Phone said: " + why : ""}`);
      }
      bugStatus.textContent = "Copying the report to this computer…";
      bugBar.style.width = "0%";
      const blob = await pull(okPath, (got, total) => {
        if (total) bugBar.style.width = ((100 * got) / total).toFixed(1) + "%";
        bugStatus.textContent = `Copying the report to this computer… ${ctx.fmtSize(got)}${total ? " of " + ctx.fmtSize(total) : ""}`;
      });
      const base = okPath.replace(/\.zip$/, "");
      await sh(`rm -f ${shQuote(okPath)} ${shQuote(base)}-dumpstate_log-*.txt`).catch(() => {});
      const d = new Date();
      const name = `bugreport-${safeName(model)}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
      ctx.download(new Blob([blob], { type: "application/zip" }), name);
      bugBar.style.width = "100%";
      bugStatus.textContent = `Saved ${name} (${ctx.fmtSize(blob.size)}).`;
    } catch (e) {
      if (!b.cancelled) { bugStatus.textContent = ""; ctx.showError(e); }
    } finally {
      if (bug === b) bug = null;
      bugBtn.disabled = false; bugCancel.hidden = true;
      if (b.cancelled || !okPath) bugProg.hidden = true;
    }
  }

  root.append(ctx.card("Bug report", null,
    el("div", { className: "dev-row" }, bugBtn, bugCancel),
    bugProg, bugStatus,
    el("p", { className: "dev-note", textContent: "Saves Android's full bug report (a .zip with logs, system state and recent crashes) to this computer. It can contain personal information from the phone, so check before sharing it." })));

  // ======================= 3. device details =======================
  const PROPS = [
    ["Manufacturer", "ro.product.manufacturer"], ["Model", "ro.product.model"], ["Device", "ro.product.device"],
    ["Android version", "ro.build.version.release"], ["API level", "ro.build.version.sdk"], ["Build ID", "ro.build.id"],
    ["Build type", "ro.build.type"], ["Security patch", "ro.build.version.security_patch"], ["ABIs", "ro.product.cpu.abilist"],
    ["Fingerprint", "ro.build.fingerprint"], ["locale1", "persist.sys.locale"], ["locale2", "ro.product.locale"],
  ];
  const detKv = el("div", { className: "dev-kv" });
  let details = null; // [[label, value]]
  const copyMd = el("button", { className: "btn sm", type: "button", textContent: "Copy as Markdown" });
  const copyTxt = el("button", { className: "btn sm", type: "button", textContent: "Copy as text" });
  const refreshDet = el("button", { className: "btn sm", type: "button", textContent: "Refresh" });
  refreshDet.onclick = () => loadDetails().catch((e) => ctx.showError(e));
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); ctx.toast(`${what} copied`); } catch (e) { ctx.showError(e); }
  };
  copyMd.onclick = () => {
    if (!details) return;
    const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
    copy(["| Field | Value |", "| --- | --- |", ...details.map(([k, v]) => `| ${esc(k)} | ${esc(v)} |`)].join("\n") + "\n", "Details");
  };
  copyTxt.onclick = () => { if (details) copy(details.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n", "Details"); };

  async function loadDetails() {
    if (!ctx.getAdb()) return;
    detKv.replaceChildren(el("div", { className: "muted" }, ctx.spinner(), " Reading…"), el("div"));
    const script = PROPS.map(([, p]) => `echo "${p}=$(getprop ${p})"`).join("; ")
      + `; echo "wm_size=$(wm size | tr '\\n' ';')"; echo "wm_density=$(wm density | tr '\\n' ';')"`
      + `; echo "kernel=$(uname -r)"; echo "mem=$(grep MemTotal /proc/meminfo)"`;
    const out = await sh(script);
    const v = {};
    for (const line of out.split("\n")) { const i = line.indexOf("="); if (i > 0) v[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const pair = (s, kind) => {
      const phys = (s.match(new RegExp(`Physical ${kind}: ([^;]+)`)) || [])[1];
      const over = (s.match(new RegExp(`Override ${kind}: ([^;]+)`)) || [])[1];
      return phys ? (over ? `${over.trim()} (physical ${phys.trim()})` : phys.trim()) : "";
    };
    const kb = +(v.mem || "").replace(/\D+/g, "");
    const rows = [];
    for (const [label, p] of PROPS) if (!label.startsWith("locale") && v[p]) rows.push([label, v[p]]);
    const locale = v["persist.sys.locale"] || v["ro.product.locale"];
    if (locale) rows.splice(rows.findIndex(([k]) => k === "ABIs") + 1, 0, ["Locale", locale]);
    const size = pair(v.wm_size || "", "size"), dens = pair(v.wm_density || "", "density");
    if (size) rows.push(["Screen", size]);
    if (dens) rows.push(["Density", dens + " dpi"]);
    if (v.kernel) rows.push(["Kernel", v.kernel]);
    if (kb) rows.push(["RAM", `${(kb / 1024 / 1024).toFixed(1)} GB`]);
    details = rows;
    detKv.replaceChildren(...rows.flatMap(([k, val]) => [el("div", { textContent: k }), el("div", { textContent: val })]));
  }

  root.append(ctx.card("Device details", el("div", {}, refreshDet, copyMd, copyTxt),
    el("p", { className: "dev-note cap-top", textContent: "Everything a bug ticket usually asks for. Copy it as a Markdown table or as plain text." }),
    detKv));

  let detailsFor = null; // the Adb the details were read from
  return {
    show() {
      const a = ctx.getAdb();
      if (a && detailsFor !== a) { detailsFor = a; loadDetails().catch((e) => ctx.showError(e)); }
    },
    connected() { detailsFor = null; details = null; detKv.replaceChildren(); if (ctx.isShown("capture")) this.show(); },
    // The user clicked Disconnect: stop what's running and leave no files behind on the phone.
    async beforeDisconnect() {
      const r = rec;
      if (r) {
        r.done = true; clearInterval(r.timer); rec = null; resetRecUi();
        await sh("pkill -INT screenrecord 2>/dev/null").catch(() => {});
        await Promise.race([r.proc.exited.catch(() => {}), new Promise((res) => setTimeout(res, 800))]);
        const restore = r.taps !== null ? `settings put system show_touches ${r.taps === "1" ? "1" : "0"}; ` : "";
        await sh(`${restore}rm -f ${shQuote(r.path)}`).catch(() => {});
      }
      const b = bug;
      if (b) {
        b.cancelled = true;
        Promise.resolve().then(() => b.proc.kill()).catch(() => {});
        // Only this report's files (dumpstate may still be finishing it).
        if (b.path) {
          const base = b.path.replace(/\.zip$/, "");
          await sh(`rm -f ${shQuote(b.path)} ${shQuote(base)}-dumpstate_log-*.txt ${shQuote(base)}.tmp 2>/dev/null`).catch(() => {});
        }
      }
    },
    disconnected() {
      if (rec) { clearInterval(rec.timer); rec.done = true; rec = null; resetRecUi(); }
      if (bug) { bug.cancelled = true; bug = null; bugBtn.disabled = false; bugCancel.hidden = true; bugProg.hidden = true; bugStatus.textContent = ""; }
    },
  };
}
