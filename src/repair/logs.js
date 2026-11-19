// Andromon — Repair › Fault logs: for "it keeps restarting" and "apps keep closing". Shows what
// Android itself recorded (restarts, app crashes, apps not responding, low-level crashes) from its
// "dropbox" of error reports, saves the crash logs as a text file, and makes Android's full bug
// report (a zip of everything, what the phone maker's service centre would ask for). Both can be
// attached to the job in hand. Nothing on the phone is changed.

import { createProgress } from "../progress.js";
import { addFile } from "./store.js";

const KINDS = [
  [/^SYSTEM_RESTART|system_server_crash|system_server_watchdog|SYSTEM_LAST_KMSG|SYSTEM_BOOT/, "Phone restarts and system crashes"],
  [/SYSTEM_TOMBSTONE|_native_crash/, "Low-level (native) crashes"],
  [/_app_crash$/, "App crashes"],
  [/_anr$/, "Apps not responding"],
  [/_wtf$|_strictmode$/, "Warnings"],
];

export function mount(root, ctx) {
  const { el, sh, toast, showError, busy, fmtSize, download } = ctx;
  const body = el("div");
  let summary = null, lastLog = null;

  async function read() {
    const [list, boot, history, uptime] = await Promise.all([
      sh("dumpsys dropbox 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2} '").catch(() => ""),
      sh("getprop sys.boot.reason").catch(() => ""), sh("getprop persist.sys.boot.reason.history").catch(() => ""), sh("cat /proc/uptime").catch(() => ""),
    ]);
    const week = Date.now() - 7 * 864e5;
    const entries = list.split("\n").map((l) => { const m = l.match(/^(\S+ \S+) (\S+)/); return m ? { at: Date.parse(m[1].replace(" ", "T")), tag: m[2] } : null; }).filter((e) => e && e.at >= week);
    const counts = KINDS.map(([rx, name]) => ({ name, n: entries.filter((e) => rx.test(e.tag)).length }));
    const apps = new Map();
    const crashes = await sh("logcat -b crash -d -t 400 2>/dev/null").catch(() => "");
    for (const m of crashes.matchAll(/Process: ([\w.:]+)/g)) apps.set(m[1], (apps.get(m[1]) || 0) + 1);
    summary = { counts, apps: [...apps].sort((a, b) => b[1] - a[1]).slice(0, 8), boot: boot.trim(), history: history.trim().split(",").slice(0, 6).join(", "),
      uptimeH: Math.round((Number(uptime.split(/\s+/)[0]) || 0) / 360) / 10 };
    draw();
  }

  async function saveCrashLog(attach) {
    const parts = await Promise.all([
      sh("getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.fingerprint; getprop sys.boot.reason; getprop persist.sys.boot.reason.history; uptime"),
      sh("logcat -b crash -d -t 2000 2>/dev/null"), sh("dumpsys dropbox 2>/dev/null | tail -n 300"),
      sh("dumpsys dropbox --print system_server_crash system_app_crash data_app_crash system_app_anr data_app_anr SYSTEM_TOMBSTONE 2>/dev/null | tail -n 3000"),
    ].map((p) => p.catch((e) => `(couldn't read: ${e.message})`)));
    const text = ["== Phone", parts[0], "== Recent crashes (logcat crash buffer)", parts[1], "== Android's error reports (list)", parts[2], "== Android's error reports (the latest, in full)", parts[3]].join("\n\n");
    const blob = new Blob([text], { type: "text/plain" }), name = `crash-logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    if (attach) { await addFile(ctx.job(), blob, name, "log"); toast(`Attached to ${ctx.job().number}`); } else download(blob, name);
  }

  // `bugreportz -p` prints PROGRESS:done/total while it works, then OK:<path of the zip>.
  async function bugReport(bar, attach) {
    const proc = await ctx.getAdb().subprocess.noneProtocol.spawn("bugreportz -p 2>&1");
    const reader = proc.output.getReader(), dec = new TextDecoder();
    let buf = "", path = "", fail = "";
    bar.update("Android is collecting the report (this takes a few minutes)…");
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const m of buf.matchAll(/PROGRESS:(\d+)\/(\d+)/g)) bar.update("Android is collecting the report…", Number(m[1]), Number(m[2]), "items");
      path = buf.match(/OK:(\S+\.zip)/)?.[1] || path;
      fail = buf.match(/FAIL:(.*)/)?.[1] || fail;
      if (buf.length > 20000) buf = buf.slice(-2000);
    }
    if (!path) throw new Error(fail ? `The bug report failed: ${fail.trim()}` : "Android didn't make a bug report (some phones only allow it with Developer options open).");
    bar.update("Copying the report to this computer…");
    const parts = [];
    await ctx.withSync(async (s) => {
      const r = s.read(path).getReader(); let got = 0;
      for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value.slice()); got += value.length; bar.update("Copying the report to this computer…", got, 0); }
    });
    await sh(`rm -f ${ctx.shQuote(path)}`).catch(() => {});
    const blob = new Blob(parts, { type: "application/zip" }), name = path.split("/").pop();
    if (attach) { await addFile(ctx.job(), blob, name, "log"); toast(`Bug report (${fmtSize(blob.size)}) attached to ${ctx.job().number}`); }
    else { download(blob, name); toast(`Bug report saved (${fmtSize(blob.size)})`); }
  }

  function draw() {
    const job = ctx.job();
    const readBtn = el("button", { className: "btn primary", type: "button", textContent: summary ? "Read again" : "Read the phone's error records" });
    readBtn.onclick = async () => { busy(readBtn, true, "Reading…"); try { await read(); } catch (e) { showError(e); } finally { if (readBtn.isConnected) busy(readBtn, false); } };
    const attach = el("input", { type: "checkbox", checked: !!job, disabled: !job });
    const logBtn = el("button", { className: "btn", type: "button", textContent: "Save the crash logs" });
    logBtn.onclick = async () => { busy(logBtn, true, "Collecting…"); try { await saveCrashLog(attach.checked && !!ctx.job()); } catch (e) { showError(e); } finally { if (logBtn.isConnected) busy(logBtn, false); } };
    const status = el("div");
    const bugBtn = el("button", { className: "btn", type: "button", textContent: "Make a full bug report" });
    bugBtn.onclick = async () => {
      const bar = createProgress({ el, fmtSize });
      status.replaceChildren(bar.node); busy(bugBtn, true, "Working…");
      try { await bugReport(bar, attach.checked && !!ctx.job()); } catch (e) { showError(e); } finally { status.replaceChildren(); if (bugBtn.isConnected) busy(bugBtn, false); }
    };
    const s = summary;
    body.replaceChildren(
      el("div", { className: "card" },
        el("div", { className: "toolbar", style: "margin:0;align-items:center" }, readBtn, logBtn, bugBtn,
          el("label", { className: "muted small", style: "display:inline-flex;gap:6px;align-items:center" }, attach, job ? `Attach to ${job.number}` : "Attach to a job (pick one at the top)")),
        status),
      s ? el("div", { className: "card" }, el("h2", { textContent: "The last 7 days" }),
        el("div", { className: "grid bh-grid" }, ...s.counts.map((c) => el("div", { className: "card bh-stat" + (c.n ? " hero" : "") }, el("div", { className: "muted small", textContent: c.name }), el("div", { className: "bh-value", textContent: String(c.n) })))),
        el("p", { className: "muted", textContent: `Last start: ${s.boot || "reason not given"}${s.history ? ` · earlier: ${s.history}` : ""} · running for ${s.uptimeH} h` }),
        s.apps.length ? el("div", {}, el("h3", { style: "margin:10px 0 4px", textContent: "Apps that crashed recently" }),
          ...s.apps.map(([p, n]) => el("div", { className: "muted", textContent: `${p} · ${n} time${n === 1 ? "" : "s"}` }))) : "",
        el("p", { className: "muted small", textContent: "Many restarts with a short uptime point to a hardware fault (battery, power button, board); crashes of one app point to that app (clear its data or reinstall it)." })) : "");
  }
  root.append(body);
  draw();
  return { show: draw, jobChanged: draw, connected: () => { summary = null; draw(); } };
}
