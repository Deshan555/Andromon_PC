// Andromon — Repair › Transfer: from an old phone to a new one, both connected to this computer
// (the second one through Developer › Phones › Connect another phone). Photos, videos, music,
// downloads and documents are copied straight from phone to phone, file by file; a file already on
// the new phone with the same size is skipped, so a stopped transfer can simply run again. Nothing
// on the old phone is changed.
//
// Contacts, messages, call log, calendar and apps go through Backup & restore instead (back up the
// old phone, make the new one the phone in use, restore), which this tab walks through.

import { createProgress } from "../progress.js";

const FOLDERS = [["DCIM", "Camera photos and videos"], ["Pictures", "Pictures and screenshots"], ["Movies", "Videos"], ["Music", "Music"],
  ["Download", "Downloads"], ["Documents", "Documents"], ["Recordings", "Voice recordings"], ["WhatsApp", "WhatsApp media (old layout)"],
  ["Android/media/com.whatsapp/WhatsApp/Media", "WhatsApp media"]];
const BASE = "/storage/emulated/0";

export function mount(root, ctx) {
  const { el, toast, showError, fmtSize, shQuote, busy } = ctx;
  const body = el("div");
  let from = null, to = null, job = null;
  const run = (a, cmd) => ctx.track(() => a.subprocess.noneProtocol.spawnWaitText(cmd));

  async function sizes(a) {
    const out = await run(a, FOLDERS.map(([f]) => `du -s -k ${shQuote(`${BASE}/${f}`)} 2>/dev/null`).join("; ")).catch(() => "");
    const m = new Map();
    for (const l of out.split("\n")) { const x = l.match(/^(\d+)\s+(.+)$/); if (x) m.set(x[2].trim().slice(BASE.length + 1), Number(x[1]) * 1024); }
    return m;
  }
  async function list(a, dir) {
    const out = await run(a, `cd ${shQuote(`${BASE}/${dir}`)} 2>/dev/null && find . -type f ! -name '.nomedia' -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`).catch(() => "");
    return out.split("\n").map((l) => { const a1 = l.indexOf("|"), b1 = l.indexOf("|", a1 + 1); return a1 > 0 && b1 > 0 ? { size: Number(l.slice(0, a1)), mtime: Number(l.slice(a1 + 1, b1)), rel: `${dir}/${l.slice(b1 + 1).replace(/^\.\//, "")}` } : null; })
      .filter((f) => f && !/(^|\/)\.(thumbnails|trashed-|pending-)/.test(f.rel));
  }

  async function copy(dirs, bar) {
    const job_ = (job = { cancelled: false });
    const src = await from.sync(), dst = await to.sync();
    let copied = 0, skipped = 0, failed = 0, bytes = 0;
    try {
      bar.update("Listing the files on both phones…");
      const files = (await Promise.all(dirs.map((d) => list(from, d)))).flat();
      const there = new Map();
      for (const d of dirs) for (const f of await list(to, d)) there.set(f.rel, f.size);
      const todo = files.filter((f) => there.get(f.rel) !== f.size);
      skipped = files.length - todo.length;
      const total = todo.reduce((n, f) => n + f.size, 0);
      const made = new Set();
      bar.reset();
      for (const [i, f] of todo.entries()) {
        if (job_.cancelled) break;
        const what = `Copying ${f.rel.split("/").pop()} (${i + 1} of ${todo.length})`;
        bar.update(what, bytes, total);
        const target = `${BASE}/${f.rel}`, dir = target.slice(0, target.lastIndexOf("/"));
        try {
          if (!made.has(dir)) { await run(to, `mkdir -p ${shQuote(dir)}`); made.add(dir); }
          const stream = src.read(target).pipeThrough(new TransformStream({ transform(c, ctl) { if (job_.cancelled) throw new Error("cancelled"); bytes += c.byteLength; bar.update(what, bytes, total); ctl.enqueue(c); } }));
          await dst.write({ filename: target, file: stream, permission: 0o660, mtime: f.mtime });
          copied++;
        } catch (e) { if (job_.cancelled) break; console.warn("Transfer", f.rel, e); failed++; await run(to, `rm -f -- ${shQuote(target)}`).catch(() => {}); }
      }
      // The new phone's gallery and music apps find the files once its media library has looked.
      if (copied) await run(to, "cmd media_provider scan external_primary 2>/dev/null || content call --uri content://media --method scan_volume --arg external_primary 2>/dev/null").catch(() => {});
    } finally { await src.dispose().catch(() => {}); await dst.dispose().catch(() => {}); if (job === job_) job = null; }
    return { copied, skipped, failed, bytes, stopped: job_.cancelled };
  }

  async function draw() {
    const phones = ctx.allPhones();
    if (phones.length < 2) {
      const add = el("button", { className: "btn primary", type: "button", textContent: "Connect another phone…" });
      add.onclick = () => { ctx.showView("dev"); toast("Developer › Phones › Connect another phone"); };
      body.replaceChildren(el("div", { className: "card" }, el("h2", { textContent: "Connect both phones" }),
        el("p", { className: "muted", textContent: phones.length ? "One phone is connected. Plug in the other one and connect it in Developer › Phones, then come back here." : "Connect the old phone, then the new one (Developer › Phones › Connect another phone)." }), add));
      return;
    }
    if (!phones.includes(from)) from = phones[0];
    if (!phones.includes(to) || to === from) to = phones.find((a) => a !== from);
    const pick = (cur, set) => { const s = el("select", {}, ...phones.map((a, i) => el("option", { value: String(i), textContent: `${ctx.phoneName(a)} · ${a.serial}` }))); s.value = String(phones.indexOf(cur)); s.onchange = () => { set(phones[Number(s.value)]); draw(); }; return s; };
    const fromSel = pick(from, (a) => { from = a; if (to === a) to = phones.find((x) => x !== a); });
    const toSel = pick(to, (a) => { to = a; if (from === a) from = phones.find((x) => x !== a); });
    const boxes = new Map();
    const sz = await sizes(from);
    const rows = FOLDERS.filter(([f]) => sz.get(f) > 0).map(([f, label]) => {
      const box = el("input", { type: "checkbox", checked: true });
      boxes.set(f, box);
      return el("label", { className: "bk-part" }, box, el("span", {}, el("b", { textContent: label }), el("span", { className: "sub", textContent: `${f} · ${fmtSize(sz.get(f))}` })));
    });
    const status = el("div");
    const go = el("button", { className: "btn primary", type: "button", textContent: "Copy to the new phone" });
    go.onclick = async () => {
      const dirs = [...boxes].filter(([, b]) => b.checked).map(([f]) => f);
      if (!dirs.length) return toast("Tick what to copy");
      if (from === to) return toast("Pick two different phones");
      const bar = createProgress({ el, fmtSize });
      const stop = el("button", { className: "btn sm", type: "button", textContent: "Stop" });
      stop.onclick = () => { if (job) job.cancelled = true; stop.disabled = true; };
      status.replaceChildren(el("div", { className: "toolbar", style: "align-items:center;margin:12px 0 0" }, bar.node, stop));
      busy(go, true, "Copying…");
      try {
        const r = await copy(dirs, bar);
        status.replaceChildren(el("p", { className: "muted", textContent: `${r.stopped ? "Stopped. " : ""}${r.copied} file${r.copied === 1 ? "" : "s"} copied (${fmtSize(r.bytes)}) · ${r.skipped} already on the new phone${r.failed ? ` · ${r.failed} failed (run it again to retry)` : ""}.` }));
      } catch (e) { showError(e); status.replaceChildren(); } finally { if (go.isConnected) busy(go, false); }
    };
    const toBackup = el("button", { className: "btn", type: "button", textContent: "Open Backup & restore" });
    toBackup.onclick = () => ctx.showView("backup");
    const toPhones = el("button", { className: "btn", type: "button", textContent: "Open Developer › Phones" });
    toPhones.onclick = () => ctx.showView("dev");
    body.replaceChildren(
      el("div", { className: "card" }, el("h2", { textContent: "Photos, videos, music and files" }),
        el("div", { className: "rp-fromto" }, el("label", {}, el("span", { className: "muted small", textContent: "From (old phone)" }), fromSel), el("span", { textContent: "→" }), el("label", {}, el("span", { className: "muted small", textContent: "To (new phone)" }), toSel)),
        el("div", { className: "bk-parts", style: "margin-top:12px" }, ...(rows.length ? rows : [el("div", { className: "muted", textContent: "The old phone's folders are empty." })])),
        el("div", { className: "toolbar", style: "margin:12px 0 0" }, go), status),
      el("div", { className: "card" }, el("h2", { textContent: "Contacts, messages, calls, calendar and apps" }),
        el("ol", { className: "muted", style: "margin:0 0 12px;padding-left:18px" },
          el("li", { textContent: "With the old phone in use, open Backup & restore and back it up (tick what to move)." }),
          el("li", { textContent: "In Developer › Phones, click “Use this phone” on the new phone." }),
          el("li", { textContent: "In Backup & restore, click “Restore from a backup…” and pick the backup just made." })),
        el("div", { className: "toolbar", style: "margin:0" }, toBackup, toPhones)));
  }
  root.append(body);
  return { show: () => draw().catch(showError), connected: () => { if (ctx.isShown("transfer")) draw().catch(showError); }, disconnected: () => { if (job) job.cancelled = true; } };
}
