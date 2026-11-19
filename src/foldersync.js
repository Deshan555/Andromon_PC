// Andromon — Folder sync: keeps a folder on this computer and a folder on the phone the same.
// Each pair goes one way (computer → phone, or phone → computer) or both ways.
//
// How a sync decides (per file, by its path inside the two folders):
//  - one way: a file that is new or different (size, or time by more than 2 s) on the source side
//    is copied over. With "Remove what was removed", a file only on the target side is removed.
//  - both ways: the newer copy wins. A file that was there at the last sync and is now gone from
//    one side was removed there, so it is removed on the other side too; a file never seen before
//    is copied. What was there at the last sync is kept per pair and per phone.
// On this computer a replaced or removed file goes to the Trash (main process, backupfs.js), so
// nothing is lost to a wrong choice of direction. On the phone it is gone. As a guard, a sync that
// would remove more than half of a side's files (an unmounted card, a folder moved away) stops
// and says so instead.

import { createProgress } from "./progress.js";

const PAIRS_KEY = "andromon.syncPairs";
const SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.ddpart|\.thumbnails)(\/|$)|\.ddpart$/i;
const BAD_ON_PC = /[\u0000-\u001f<>:"|?*\\]|[. ]$/; // names Windows (and so this folder's checks) can't take
const MODES = [["toPhone", "Computer → phone"], ["toComputer", "Phone → computer"], ["both", "Both ways"]];
const CHUNK = 4 * 1024 * 1024;

export function initFolderSync(ctx) {
  const { $, el, sh, shQuote, withSync, getSerial, fmtSize, toast, showError, armedClick, makeSwitch, fmtDate } = ctx;
  const bfs = globalThis.andromon?.backupFs;
  const root = $("syncRoot");
  const running = new Map(); // pair id -> { cancelled }
  const bars = new Map();    // pair id -> its progress bar while it runs

  const loadPairs = () => { try { const v = JSON.parse(localStorage.getItem(PAIRS_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const savePairs = (pairs) => { try { localStorage.setItem(PAIRS_KEY, JSON.stringify(pairs)); } catch {} };
  const kindOf = (p) => `sync:${p.id}`;
  // What was in both folders after the last sync, per phone: kept in this computer's app data.
  const snapKey = (p) => `sync-${p.id}-${getSerial()}`.replace(/[^\w.:-]/g, "_").slice(0, 64);
  const loadSnap = async (p) => (await bfs.recordGet(snapKey(p)).catch(() => null))?.files || null;
  const saveSnap = (p, files) => bfs.recordSet(snapKey(p), { files, at: Date.now() });

  // ---------- listing both sides ----------
  async function listPhone(dir) {
    const ok = (await sh(`[ -d ${shQuote(dir)} ] && echo yes || echo no`)).trim() === "yes";
    if (!ok) throw new Error(`The phone has no folder ${dir}`);
    const out = await sh(`cd ${shQuote(dir)} && find . -type f -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`);
    const files = new Map();
    for (const l of out.split("\n")) {
      const a = l.indexOf("|"), b = l.indexOf("|", a + 1); if (a < 0 || b < 0) continue;
      const rel = l.slice(b + 1).replace(/^\.\//, "");
      if (!rel || SKIP.test(rel)) continue;
      files.set(rel, { size: Number(l.slice(0, a)), mtime: Number(l.slice(a + 1, b)) });
    }
    return files;
  }
  async function listComputer(p) {
    const files = new Map();
    for (const f of await bfs.list(kindOf(p), "", true)) if (!SKIP.test(f.rel)) files.set(f.rel, { size: f.size, mtime: Math.floor(f.mtime / 1000) });
    return files;
  }
  const same = (a, b) => a && b && a.size === b.size && Math.abs(a.mtime - b.mtime) <= 2;
  const changedSince = (now, then) => !then || now.size !== then.size || Math.abs(now.mtime - then.mtime) > 2;

  // ---------- deciding ----------
  function plan(p, phone, pc, snap) {
    const toPhone = [], toPc = [], rmPhone = [], rmPc = [], skipped = [];
    const all = new Set([...phone.keys(), ...pc.keys()]);
    for (const rel of all) {
      const P = phone.get(rel), C = pc.get(rel), S = snap?.[rel];
      if (P && C && same(P, C)) continue;
      if (p.mode === "toPhone") {
        if (C) toPhone.push(rel); else if (p.mirror) rmPhone.push(rel);
      } else if (p.mode === "toComputer") {
        if (P) (BAD_ON_PC.test(rel.split("/").pop()) ? skipped : toPc).push(rel); else if (p.mirror) rmPc.push(rel);
      } else {
        if (P && C) {
          // Both changed since the last sync, or no record: the newer one wins (the other is kept in the Trash when it's here).
          const phoneNewer = P.mtime > C.mtime || (P.mtime === C.mtime && changedSince(P, S) && !changedSince(C, S));
          if (phoneNewer) (BAD_ON_PC.test(rel.split("/").pop()) ? skipped : toPc).push(rel); else toPhone.push(rel);
        } else if (C) { if (S && !changedSince(C, S)) rmPc.push(rel); else toPhone.push(rel); }
        else if (P) { if (S && !changedSince(P, S)) rmPhone.push(rel); else (BAD_ON_PC.test(rel.split("/").pop()) ? skipped : toPc).push(rel); }
      }
    }
    return { toPhone, toPc, rmPhone, rmPc, skipped };
  }

  // ---------- copying ----------
  function computerStream(p, rel, size) {
    let at = 0;
    return new ReadableStream({
      async pull(ctl) {
        if (at >= size) { ctl.close(); return; }
        const chunk = await bfs.read(kindOf(p), rel, at, Math.min(CHUNK, size - at));
        if (!chunk.byteLength) { ctl.close(); return; }
        at += chunk.byteLength; ctl.enqueue(new Uint8Array(chunk));
      },
    });
  }
  async function copyToPhone(p, rel, f, onBytes, job) {
    const to = `${p.phoneDir}/${rel}`;
    await sh(`mkdir -p ${shQuote(to.slice(0, to.lastIndexOf("/")))}`);
    const src = computerStream(p, rel, f.size).pipeThrough(new TransformStream({ transform(c, ctl) { if (job.cancelled) throw new Error("cancelled"); onBytes(c.byteLength); ctl.enqueue(c); } }));
    await withSync((s) => s.write({ filename: to, file: src, permission: 0o660, mtime: f.mtime }));
  }
  async function copyToComputer(p, rel, f, onBytes, job) {
    const id = await bfs.open(kindOf(p), rel, { replace: true });
    try {
      await withSync(async (s) => {
        const reader = s.read(`${p.phoneDir}/${rel}`).getReader();
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          if (job.cancelled) { reader.cancel().catch(() => {}); throw new Error("cancelled"); }
          await bfs.write(id, value); onBytes(value.byteLength);
        }
      });
      await bfs.close(id, { mtime: f.mtime * 1000 });
    } catch (e) { await bfs.abort(id).catch(() => {}); throw e; }
  }

  // One sync of a pair. `auto`: started by the phone connecting (no questions, a stop on doubt).
  async function run(p, { auto = false } = {}) {
    if (running.has(p.id)) return null;
    const job = { cancelled: false }, bar = createProgress({ el, fmtSize });
    running.set(p.id, job); bars.set(p.id, bar); draw();
    const result = { copied: 0, removed: 0, bytes: 0, skipped: 0, error: null };
    try {
      bar.update("Listing both folders…");
      const [phone, pc, snap] = await Promise.all([listPhone(p.phoneDir), listComputer(p), loadSnap(p)]);
      const todo = plan(p, phone, pc, snap);
      // The guard: removing most of a side is far more likely a mistake than a wish.
      for (const [rm, side, n] of [[todo.rmPhone, "the phone", phone.size], [todo.rmPc, "this computer", pc.size]]) {
        if (rm.length > 5 && rm.length > n / 2) throw new Error(`This sync would remove ${rm.length} of the ${n} files on ${side}, so it stopped. If that's right, remove them there yourself, or change the direction.`);
      }
      result.skipped = todo.skipped.length;
      const total = todo.toPhone.reduce((n, r) => n + pc.get(r).size, 0) + todo.toPc.reduce((n, r) => n + phone.get(r).size, 0);
      let done = 0, n = 0; const count = todo.toPhone.length + todo.toPc.length;
      bar.reset();
      const step = (rel) => bar.update(`Copying ${rel.split("/").pop()} (${++n} of ${count})`, done, total);
      for (const rel of todo.toPhone) {
        if (job.cancelled) throw new Error("cancelled");
        step(rel); await copyToPhone(p, rel, pc.get(rel), (b) => { done += b; bar.update(`Copying ${rel.split("/").pop()} (${n} of ${count})`, done, total); }, job);
        phone.set(rel, { ...pc.get(rel) }); result.copied++;
      }
      for (const rel of todo.toPc) {
        if (job.cancelled) throw new Error("cancelled");
        step(rel); await copyToComputer(p, rel, phone.get(rel), (b) => { done += b; bar.update(`Copying ${rel.split("/").pop()} (${n} of ${count})`, done, total); }, job);
        pc.set(rel, { ...phone.get(rel) }); result.copied++;
      }
      result.bytes = total;
      if (todo.rmPhone.length) {
        bar.update(`Removing ${todo.rmPhone.length} file${todo.rmPhone.length === 1 ? "" : "s"} on the phone…`);
        for (let i = 0; i < todo.rmPhone.length; i += 50) await sh(`cd ${shQuote(p.phoneDir)} && rm -f -- ${todo.rmPhone.slice(i, i + 50).map(shQuote).join(" ")}`);
        for (const rel of todo.rmPhone) phone.delete(rel);
        result.removed += todo.rmPhone.length;
      }
      for (const rel of todo.rmPc) { bar.update(`Moving ${rel.split("/").pop()} to the Trash…`); await bfs.trash(kindOf(p), rel); pc.delete(rel); result.removed++; }
      // What both sides hold now is what the next sync compares against.
      const files = {};
      for (const [rel, f] of phone) { const c = pc.get(rel); if (c && same(f, c)) files[rel] = { size: f.size, mtime: f.mtime }; }
      await saveSnap(p, files);
    } catch (e) {
      result.error = job.cancelled ? "Stopped" : e.message || String(e);
      if (!auto && !job.cancelled) showError(e);
    } finally {
      running.delete(p.id); bars.delete(p.id);
      update(p.id, { last: { at: Date.now(), ...result } });
      draw();
    }
    return result;
  }

  // ---------- the page ----------
  const summary = (l) => !l ? "Not synced yet" : l.error ? `${l.error === "Stopped" ? "Stopped" : "Didn't finish: " + l.error} · ${fmtDate(l.at, true)}`
    : `${fmtDate(l.at, true)} · ${l.copied ? `${l.copied} copied (${fmtSize(l.bytes)})` : "nothing to copy"}${l.removed ? ` · ${l.removed} removed` : ""}${l.skipped ? ` · ${l.skipped} skipped (names this computer can't use)` : ""}`;
  function update(id, patch) { savePairs(loadPairs().map((p) => (p.id === id ? { ...p, ...patch } : p))); }

  async function draw() {
    if (!bfs) { root.replaceChildren(el("div", { className: "card" }, el("h2", { textContent: "Folder sync" }), el("p", { className: "muted", textContent: "Folder sync needs the Andromon desktop app (it writes to a folder on this computer)." }))); return; }
    const pairs = loadPairs();
    const cards = await Promise.all(pairs.map(async (p) => {
      const where = await bfs.get(kindOf(p)).catch(() => null);
      const job = running.get(p.id);
      const pcBtn = el("button", { className: "btn sm", type: "button", textContent: where ? where.name : "Choose…", title: where?.path || "" });
      pcBtn.onclick = async () => { try { await bfs.choose(kindOf(p)); draw(); } catch (e) { showError(e); } };
      const phoneIn = el("input", { type: "text", value: p.phoneDir, className: "fs-path", ariaLabel: "Folder on the phone", spellcheck: false });
      phoneIn.onchange = () => { const v = phoneIn.value.trim().replace(/\/+$/, ""); if (v.startsWith("/")) update(p.id, { phoneDir: v }); else { phoneIn.value = p.phoneDir; toast("A phone folder starts with /, like /sdcard/Documents"); } };
      const mode = el("select", {}, ...MODES.map(([v, t]) => el("option", { value: v, textContent: t }))); mode.value = p.mode;
      mode.onchange = () => { update(p.id, { mode: mode.value }); draw(); };
      const rows = [
        el("div", { className: "fs-ends" },
          el("div", {}, el("div", { className: "muted small", textContent: "On this computer" }), pcBtn, where && !where.exists ? el("div", { className: "small", style: "color:var(--danger)", textContent: "This folder is gone. Choose it again." }) : ""),
          el("div", { className: "fs-dir" }, mode),
          el("div", {}, el("div", { className: "muted small", textContent: "On the phone" }), phoneIn)),
      ];
      if (p.mode !== "both") rows.push(el("div", { className: "set-row" }, el("div", { className: "set-text" }, el("b", { textContent: "Remove what was removed" }),
        el("div", { className: "sub", textContent: p.mode === "toPhone" ? "Files that aren't on this computer are removed from the phone folder" : "Files that aren't on the phone go to this computer's Trash" })),
        makeSwitch(!!p.mirror, (on) => { update(p.id, { mirror: on }); return on; })));
      rows.push(el("div", { className: "set-row" }, el("div", { className: "set-text" }, el("b", { textContent: "Sync when the phone connects" }),
        el("div", { className: "sub", textContent: "Runs by itself each time this phone connects" })), makeSwitch(!!p.auto, (on) => { update(p.id, { auto: on }); return on; })));
      const status = el("div", { className: "muted small", textContent: summary(p.last) });
      const go = el("button", { className: "btn sm primary", type: "button", textContent: job ? "Stop" : "Sync now" });
      go.onclick = () => {
        if (running.get(p.id)) { running.get(p.id).cancelled = true; go.disabled = true; return; }
        if (!where?.exists) return toast("Choose the folder on this computer first");
        run(loadPairs().find((x) => x.id === p.id));
      };
      const remove = el("button", { className: "btn sm danger", type: "button", textContent: "Remove pair", disabled: !!job });
      armedClick(remove, async () => { savePairs(loadPairs().filter((x) => x.id !== p.id)); await bfs.forget(kindOf(p)).catch(() => {}); draw(); });
      return el("div", { className: "card fs-pair" }, ...rows, el("div", { className: "toolbar", style: "margin-top:12px;align-items:center" }, go, remove, job && bars.get(p.id) ? bars.get(p.id).node : status));
    }));
    const add = el("button", { className: "btn primary", type: "button", textContent: "Add a folder pair…" });
    add.onclick = async () => {
      const id = Math.random().toString(36).slice(2, 10);
      const picked = await bfs.choose(`sync:${id}`).catch((e) => { showError(e); return null; });
      if (!picked) return;
      savePairs([...loadPairs(), { id, phoneDir: `/sdcard/${picked.name}`, mode: "toPhone", mirror: false, auto: false }]);
      toast(`Now set the phone folder; it is /sdcard/${picked.name} for a start`);
      draw();
    };
    root.replaceChildren(
      el("div", { className: "card" }, el("h2", { textContent: "Folder sync" }),
        el("p", { className: "muted", style: "margin-top:0", textContent: "Keep a folder on this computer and one on the phone the same: one way, or both ways (the newer copy wins). Files replaced or removed here go to this computer's Trash; on the phone they are gone." }),
        add),
      ...cards);
  }

  return {
    load: draw,
    // When a phone connects, the pairs set to sync by themselves run one after another.
    async onConnected() {
      if (!bfs) return;
      for (const p of loadPairs().filter((x) => x.auto)) {
        const where = await bfs.get(kindOf(p)).catch(() => null);
        if (!where?.exists) continue;
        const r = await run(p, { auto: true });
        if (r?.error) toast(`Folder sync (${where.name}) didn't finish: ${r.error}`);
        else if (r?.copied || r?.removed) toast(`Folder sync (${where.name}): ${r.copied} copied${r.removed ? `, ${r.removed} removed` : ""}`);
      }
    },
    onDisconnected() { for (const j of running.values()) j.cancelled = true; },
  };
}
