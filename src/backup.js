// "Back up this phone", "Restore from a backup…" and the automatic photo copy.
//
// A backup is a dated folder on this computer:
//   Droid Desk backup <model> <yyyy-mm-dd HHmm>/
//     backup.json     what is inside, counts, phone and app details
//     contacts.vcf    vCard 3.0 with photos
//     messages.xml    SMS and MMS ("SMS Backup & Restore" layout), mms/ holds the attachments
//     calls.csv, calls.xml
//     calendar.ics
//     apps.csv        installed user apps; apps/<package>/*.apk when installers are included
//     photos/<album>/…  original photo and video files, photos.json says where each one was
// Files are written by the main process (../backupfs.js) inside a folder the person picked; this
// file only sends relative paths made of sanitised names. Everything read back from a backup is
// treated like data from a stranger: parsed, validated, never run and never used as a path as is.
import { version as APP_VERSION } from "../package.json";
import {
  safeName, safeRelPath, attachmentName, buildSmsXml, parseSmsXml, buildCallsCsv, buildCallsXml, parseCallsFile, parseCsv, toCsv,
  parseVcf, makeContactMatcher, base64ToBytes, folderStamp,
} from "./pdata.js";
import { parseIcs } from "./ics.js";
import { createProgress } from "./progress.js";

const FORMAT = "droiddesk-backup";
const AUTO_KEY = "dd.autoPhotoBackup";
const OPTS_KEY = "dd.backupParts";
const NOT_INCLUDED = "Not included: what apps keep inside themselves (chats, game progress, logins), phone settings, Wi‑Fi passwords and music. MMS are saved with their pictures but can't be put back onto a phone.";
const PARTS = [
  ["contacts", "Contacts", "with photos", true],
  ["messages", "Messages", "SMS, and MMS with their attachments", true],
  ["calls", "Call log", "", true],
  ["calendar", "Calendar", "", true],
  ["apps", "List of apps", "name, package, version, where it was installed from", true],
  ["apks", "App installers (APK files)", "lets Restore put the apps back, without their data", false],
  ["photos", "Photos and videos", "original files, one folder per album", false],
];
class Cancelled extends Error { constructor() { super("Cancelled"); } }

export function initBackup(h) {
  const { $, el, toast, showError, clearError, busy, armedClick, makeSwitch, cc, sh, shQuote, withSync, fmtSize, spinner } = h;
  const fsApi = globalThis.droidDesk?.backupFs || null;
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const n = (x) => Number(x || 0).toLocaleString();
  const errText = (e) => String(e?.message || e || "failed").slice(0, 300);
  const count = (x, word, plural = word + "s") => `${n(x)} ${Number(x) === 1 ? word : plural}`;
  let job = null;       // a running backup or restore
  let autoJob = null;   // a running automatic photo copy
  let estimate = null;  // { count, bytes } of the phone's photos and videos, once known
  let lastAuto = "";

  // ---------- small helpers ----------
  async function phoneFacts() {
    const out = await sh("getprop ro.product.model; getprop ro.product.manufacturer; getprop ro.build.version.release; getprop ro.build.version.sdk");
    const [model, manufacturer, android, sdk] = out.split("\n").map((s) => s.trim());
    return { model: model || "Android phone", manufacturer: manufacturer || "", android: android || "", sdk: Number(sdk) || 0, serial: String(h.getAdb()?.serial || "") };
  }
  const enc = new TextEncoder();
  const writeText = (kind, rel, text, opts) => fsApi.writeFile(kind, rel, enc.encode(text), opts);
  const readText = async (kind, rel) => new TextDecoder().decode(await fsApi.readFile(kind, rel));
  /** Different names for files that would land on the same path (case-insensitive, as on Windows/macOS). */
  function uniqueRel(used, dir, name) {
    const base = safeName(name);
    let rel = dir ? `${dir}/${base}` : base;
    for (let i = 1; used.has(rel.toLowerCase()); i++) rel = (dir ? dir + "/" : "") + base.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(rel.toLowerCase());
    return rel;
  }
  /** Copies one file from the phone to disk in 1 MB pieces. The file only gets its name once complete. */
  async function pullToFile(remote, kind, rel, { mtime = 0, onBytes = null, task = null } = {}) {
    const id = await fsApi.open(kind, rel);
    try {
      const total = await withSync(async (s) => {
        const reader = s.read(remote).getReader();
        let parts = [], held = 0, sum = 0;
        const flush = async () => {
          if (!held) return;
          const out = new Uint8Array(held); let o = 0;
          for (const p of parts) { out.set(p, o); o += p.length; }
          parts = []; held = 0;
          await fsApi.write(id, out);
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (task?.cancelled) { reader.cancel().catch(() => {}); throw new Cancelled(); }
          parts.push(value.slice()); held += value.length; sum += value.length;
          onBytes?.(value.length);
          if (held >= 1 << 20) await flush();
        }
        await flush();
        return sum;
      });
      await fsApi.close(id, { mtime });
      return total;
    } catch (e) { await fsApi.abort(id).catch(() => {}); throw e; }
  }
  /** A file on disk as a stream for adb push, read in 4 MB pieces. */
  function diskStream(kind, rel, size, onBytes) {
    let off = 0;
    return new ReadableStream({
      async pull(ctrl) {
        if (off >= size) return ctrl.close();
        const chunk = await fsApi.read(kind, rel, off, 4 << 20);
        if (!chunk.length) return ctrl.close();
        off += chunk.length; onBytes?.(chunk.length);
        ctrl.enqueue(chunk);
      },
    }, { highWaterMark: 1 });
  }
  async function needCompanion() {
    if (await h.companionAvailable()) return;
    throw new Error("This needs the Droid Desk Companion on the phone. Open Messages, Contacts or Photos once to install it, then try again.");
  }
  async function listMedia() {
    const p = h.companionInfo()?.permissions || {};
    if (p.MEDIA_IMAGES === false || p.MEDIA_VIDEO === false) throw new Error("The companion doesn't have access to photos and videos (Settings › Apps › Droid Desk Companion › Permissions on the phone).");
    const [images, videos] = await Promise.all([cc("media.list", { kind: "image" }), cc("media.list", { kind: "video" })]);
    return [...images.map((x) => ({ ...x, kind: "image" })), ...videos.map((x) => ({ ...x, kind: "video" }))].filter((it) => it.path);
  }
  /** Installed user apps: [{pkg, name, version, versionCode, installer}]. */
  async function listApps() {
    const lines = (await sh("pm list packages --user 0 -3 -i --show-versioncode")).split("\n");
    const apps = [];
    for (const l of lines) {
      const m = l.trim().match(/^package:(\S+)(?:\s+versionCode:(\d+))?(?:\s+installer=(\S+))?/);
      if (m && /^[\w.]+$/.test(m[1])) apps.push({ pkg: m[1], name: "", version: "", versionCode: m[2] || "", installer: m[3] && m[3] !== "null" ? m[3] : "" });
    }
    // Version names: one dump of all packages instead of a command per app.
    try {
      const dump = await sh("dumpsys package packages");
      const byPkg = new Map(apps.map((a) => [a.pkg, a]));
      let cur = null;
      for (const line of dump.split("\n")) {
        const p = line.match(/^\s*Package \[([\w.]+)\]/);
        if (p) { cur = byPkg.get(p[1]) || null; continue; }
        const v = cur && line.match(/^\s*versionName=(.*)$/);
        if (v && !cur.version) cur.version = v[1].trim();
      }
    } catch (e) { console.warn("App versions:", e); }
    // Names as the phone shows them, from the companion when it's there.
    try {
      if (await h.companionAvailable()) {
        for (let i = 0; i < apps.length; i += 40) {
          const got = await cc("apps.icons", { pkgs: apps.slice(i, i + 40).map((a) => a.pkg), size: 32 });
          for (const a of apps.slice(i, i + 40)) a.name = String(got?.[a.pkg]?.label || "");
        }
      }
    } catch (e) { console.warn("App names:", e); }
    return apps.sort((a, b) => (a.name || a.pkg).localeCompare(b.name || b.pkg));
  }

  // ---------- progress list (shared by backup and restore) ----------
  function progressList(items) {
    const rows = new Map();
    const box = el("div", { className: "bk-steps" });
    for (const [key, label] of items) {
      const state = el("span", { className: "bk-state", textContent: "·" });
      const text = el("span", { className: "muted small", textContent: "waiting" });
      const row = el("div", { className: "bk-step" }, state, el("b", { textContent: label }), text);
      rows.set(key, { state, text, row, bar: null, kind: "" });
      box.append(row);
    }
    // While a step copies files with a known size, a bar under it shows how far (and the speed).
    const set = (key, kind, text, done, total) => {
      const r = rows.get(key); if (!r) return;
      if (r.kind !== kind) {
        r.kind = kind;
        r.state.className = "bk-state " + kind;
        r.state.replaceChildren(kind === "run" ? spinner() : kind === "ok" ? "✓" : kind === "fail" ? "✕" : kind === "warn" ? "!" : kind === "skip" ? "–" : "·");
      }
      r.text.textContent = text;
      if (kind === "run" && total > 0) {
        if (!r.bar) { r.bar = createProgress({ el, fmtSize }); r.row.append(r.bar.node); }
        r.bar.update("", done, total);
      } else if (r.bar && kind !== "run") { r.bar.node.remove(); r.bar = null; }
    };
    return { box, set };
  }
  /** Runs steps one after another; a failing step is reported and the rest still run. */
  async function runSteps(task, steps, ui) {
    const results = {};
    for (const [key, fn] of steps) {
      if (task.cancelled) { ui.set(key, "skip", "cancelled"); continue; }
      ui.set(key, "run", "working…");
      try {
        const r = await fn((text, done, total) => ui.set(key, "run", text, done, total));
        results[key] = { ok: true, ...r };
        ui.set(key, r?.warn ? "warn" : "ok", r?.summary || "done"); // "warn": done, but not everything made it
      } catch (e) {
        if (e instanceof Cancelled || task.cancelled) { ui.set(key, "skip", "cancelled"); results[key] = { ok: false, error: "cancelled" }; continue; }
        console.warn(`${key}:`, e);
        results[key] = { ok: false, error: errText(e) };
        ui.set(key, "fail", errText(e));
      }
    }
    return results;
  }
  const check = (task) => { if (task.cancelled) throw new Cancelled(); if (h.getAdb() !== task.phone) throw new Error("The phone was disconnected"); };

  // ---------- backup ----------
  const backupSteps = (task, root, facts) => ({
    contacts: async (say) => {
      const list = await cc("contacts.list");
      const { text, photos } = await h.contactsVcf(list, (i, total) => { check(task); say(`photos ${i} of ${total}…`); });
      await writeText("backup", `${root}/contacts.vcf`, text);
      return { file: "contacts.vcf", count: list.length, photos, summary: `${count(list.length, "contact")}${photos ? `, ${n(photos)} with a photo` : ""}` };
    },
    messages: async (say) => {
      const sms = await cc("sms.list");
      let mms = [], mmsError = "";
      try { mms = await cc("mms.list"); } catch (e) { mmsError = /Unknown method/.test(e?.message) ? "MMS need a newer companion" : `MMS couldn't be read (${errText(e)})`; }
      const used = new Set(), files = new Map(); // partId -> relative file
      let saved = 0, failed = 0, bytes = 0;
      const parts = mms.flatMap((m) => (m.parts || []).map((p) => [m, p]));
      for (const [i, [m, p]] of parts.entries()) {
        check(task);
        say(`attachment ${i + 1} of ${parts.length}…`);
        try {
          const r = await cc("mms.part", { partId: p.partId });
          const data = base64ToBytes(r.data);
          const rel = uniqueRel(used, "mms", attachmentName(p, m.id));
          await fsApi.writeFile("backup", `${root}/${rel}`, data, { mtime: m.date });
          files.set(p.partId, rel); saved++; bytes += data.length;
        } catch (e) { console.warn("MMS attachment", p.partId, e); failed++; }
      }
      const xml = buildSmsXml({ sms, mms, nameFor: h.nameFor, fmtDate: (d) => h.fmtDate(d, true), partRef: (_m, p) => (files.has(p.partId) ? { file: files.get(p.partId) } : null) });
      await writeText("backup", `${root}/messages.xml`, xml);
      const warn = failed || mmsError;
      return { file: "messages.xml", sms: sms.length, mms: mms.length, attachments: saved, attachmentsFailed: failed, attachmentBytes: bytes, warn: !!warn,
        summary: `${n(sms.length)} SMS, ${n(mms.length)} MMS, ${count(saved, "attachment")}${failed ? ` (${failed} more couldn't be saved)` : ""}${mmsError ? ` · ${mmsError}` : ""}` };
    },
    calls: async () => {
      const calls = await cc("calls.list");
      await writeText("backup", `${root}/calls.csv`, buildCallsCsv(calls, h.nameFor));
      await writeText("backup", `${root}/calls.xml`, buildCallsXml(calls, h.nameFor, (d) => h.fmtDate(d, true)));
      return { file: "calls.csv", xml: "calls.xml", count: calls.length, summary: count(calls.length, "call") };
    },
    calendar: async () => {
      const { text, count: events, calendars } = await h.calendar().exportIcs({ name: facts.model });
      await writeText("backup", `${root}/calendar.ics`, text);
      return { file: "calendar.ics", count: events, calendars: calendars.length, summary: `${count(events, "event")} in ${count(calendars.length, "calendar")}` };
    },
    apps: async (say) => {
      const apps = await listApps();
      await writeText("backup", `${root}/apps.csv`, "﻿" + toCsv(["Name", "Package", "Version", "Version code", "Installed from"], apps.map((a) => [a.name || a.pkg, a.pkg, a.version, a.versionCode, a.installer])));
      const out = { file: "apps.csv", count: apps.length, apks: 0, apkBytes: 0, summary: `${count(apps.length, "app")} listed` };
      if (!task.opts.apks) return out;
      let failed = 0;
      for (const [i, a] of apps.entries()) {
        check(task);
        say(`installer ${i + 1} of ${apps.length} · ${a.name || a.pkg}`);
        try {
          const paths = (await sh(`pm path --user 0 ${shQuote(a.pkg)}`)).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("package:")).map((l) => l.slice(8));
          if (!paths.length) throw new Error("no APK path");
          const used = new Set();
          for (const p of paths) out.apkBytes += await pullToFile(p, "backup", `${root}/${uniqueRel(used, `apps/${safeName(a.pkg)}`, p.split("/").pop() || "base.apk")}`, { task });
          out.apks++;
        } catch (e) { if (e instanceof Cancelled) throw e; console.warn("APK", a.pkg, e); failed++; }
      }
      out.summary = `${count(apps.length, "app")} listed, ${count(out.apks, "installer")} saved (${fmtSize(out.apkBytes)})${failed ? ` · ${failed} couldn't be copied` : ""}`;
      out.warn = failed > 0;
      return out;
    },
    photos: async (say) => {
      const items = await listMedia();
      const total = items.reduce((s, it) => s + (Number(it.size) || 0), 0);
      const used = new Set(), index = [];
      let done = 0, bytes = 0, failed = 0;
      for (const it of items) {
        check(task);
        const rel = uniqueRel(used, `photos/${safeName(it.album || "No album", "No album")}`, it.name || `${it.kind}-${it.id}`);
        try {
          await pullToFile(it.path, "backup", `${root}/${rel}`, { mtime: it.date, task, onBytes: (b) => { bytes += b; say(`${n(done + 1)} of ${n(items.length)} files`, bytes, total); } });
          index.push({ file: rel, path: it.path, size: it.size, date: it.date, kind: it.kind });
        } catch (e) { if (e instanceof Cancelled) throw e; check(task); console.warn(it.path, e); failed++; }
        done++;
      }
      await writeText("backup", `${root}/photos.json`, JSON.stringify(index));
      return { folder: "photos", index: "photos.json", count: index.length, bytes, failed, warn: failed > 0, summary: `${count(index.length, "file")}, ${fmtSize(bytes)}${failed ? ` · ${failed} couldn't be copied` : ""}` };
    },
  });

  async function runBackup(opts, ui, task) {
    const facts = await phoneFacts();
    let root = safeName(`Droid Desk backup ${facts.model} ${folderStamp()}`);
    for (let i = 2; await fsApi.stat("backup", root); i++) root = safeName(`Droid Desk backup ${facts.model} ${folderStamp()} (${i})`);
    await fsApi.mkdir("backup", root);
    task.root = root;
    const all = backupSteps(task, root, facts);
    const keys = ["contacts", "messages", "calls", "calendar", "apps", "photos"].filter((k) => opts[k] || (k === "apps" && opts.apks));
    const results = await runSteps(task, keys.map((k) => [k, all[k]]), ui);
    const manifest = {
      format: FORMAT, version: 1, createdAt: new Date().toISOString(), complete: !task.cancelled && Object.values(results).every((r) => r.ok),
      cancelled: !!task.cancelled, app: { name: "Droid Desk", version: APP_VERSION, companion: h.companionInfo()?.version ?? null },
      phone: facts, items: Object.fromEntries(Object.entries(results).map(([k, r]) => { const { summary, warn, ...rest } = r; return [k, rest]; })),
      notIncluded: ["app data", "settings", "music", "MMS can't be restored"],
    };
    await writeText("backup", `${root}/backup.json`, JSON.stringify(manifest, null, 2));
    return { root, results, manifest };
  }

  // ---------- restore ----------
  const SD = /^\/(?:sdcard|storage\/emulated\/0)\//;
  /** Where a backed-up photo goes on the phone: its old place when that is on shared storage, else Pictures/Restored. */
  function photoTarget(entry, rel) {
    const p = String(entry?.path || "");
    if (SD.test(p) && p.length < 512 && !p.split("/").some((s) => s === ".." || s === ".") && !/[\u0000-\u001f]/.test(p) && !/\/Android\/(data|obb)\//i.test(p)) return p.replace(/^\/sdcard\//, "/storage/emulated/0/");
    const parts = rel.split("/").slice(1); // drop "photos"
    return `/storage/emulated/0/Pictures/Restored/${parts.join("/")}`;
  }
  const restoreSteps = (task, found) => ({
    contacts: async (say) => {
      const list = parseVcf(await readText("restore", "contacts.vcf"));
      const isKnown = makeContactMatcher(await cc("contacts.list"));
      const fresh = list.filter((c) => !isKnown(c));
      const added = fresh.length ? await h.addContacts(fresh, (i, total) => { say(`${n(i)} of ${n(total)}…`); }) : 0;
      h.contactsChanged();
      return { summary: `${count(added, "contact")} added · ${n(list.length - fresh.length)} already on the phone` };
    },
    messages: async (say) => {
      const { sms, mmsCount, bad } = parseSmsXml(await readText("restore", "messages.xml"));
      if (!sms.length) return { summary: `no text messages in the backup${mmsCount ? ` · ${n(mmsCount)} MMS skipped` : ""}` };
      const r = await h.restoreSms(sms, (i, total) => { say(`${n(i)} of ${n(total)}…`); });
      return { warn: r.failed > 0, summary: `${count(r.added, "message")} added · ${n(r.skipped)} already there${r.failed ? ` · ${n(r.failed)} couldn't be stored` : ""}${mmsCount ? ` · ${n(mmsCount)} MMS skipped` : ""}${bad ? ` · ${n(bad)} unreadable` : ""}` };
    },
    calls: async (say) => {
      const file = found.has("calls.csv") ? "calls.csv" : "calls.xml";
      const { calls, bad } = parseCallsFile(await readText("restore", file));
      if (!calls.length) return { summary: "no calls in the backup" };
      const r = await h.restoreCalls(calls, (i, total) => { say(`${n(i)} of ${n(total)}…`); });
      return { warn: r.failed > 0, summary: `${count(r.added, "call")} added · ${n(r.skipped)} already there${r.failed ? ` · ${n(r.failed)} couldn't be stored` : ""}${bad ? ` · ${n(bad)} unreadable` : ""}` };
    },
    calendar: async (say) => {
      const parsed = parseIcs(await readText("restore", "calendar.ics"));
      if (!parsed.events.length) return { summary: "no events in the backup" };
      const cal = h.calendar();
      const writable = await cal.writableCalendars();
      let fallback = task.opts.calendarId;
      if (fallback === "new" || fallback == null) fallback = null;
      const byName = new Map(writable.map((c) => [String(c.name || "").trim().toLowerCase(), c.id]));
      const groups = new Map(); // calendar id -> events
      for (const ev of parsed.events) {
        let id = byName.get(String(ev.calendarName || "").trim().toLowerCase());
        if (id == null) { if (fallback == null) fallback = await cal.createLocal(); id = Number(fallback); }
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(ev);
      }
      const total = { added: 0, skipped: 0, failed: 0 };
      for (const [id, events] of groups) {
        check(task);
        const r = await cal.addEvents(id, events, (i, t) => say(`${n(i)} of ${n(t)}…`));
        for (const k of Object.keys(total)) total[k] += r[k];
      }
      return { warn: total.failed > 0, summary: `${count(total.added, "event")} added · ${n(total.skipped)} already there${total.failed ? ` · ${n(total.failed)} couldn't be added` : ""}` };
    },
    photos: async (say) => {
      let index = [];
      if (found.has("photos.json")) { try { index = JSON.parse(await readText("restore", "photos.json")); } catch {} }
      const onDisk = await fsApi.list("restore", "photos", true);
      const byRel = new Map(onDisk.map((f) => [`photos/${f.rel}`, f]));
      const entries = new Map();
      if (Array.isArray(index)) for (const e of index) { const rel = safeRelPath(e?.file || ""); if (rel.startsWith("photos/") && byRel.has(rel)) entries.set(rel, e); }
      for (const rel of byRel.keys()) if (!entries.has(rel)) entries.set(rel, null); // files without an index entry
      const total = [...entries.keys()].reduce((s, rel) => s + byRel.get(rel).size, 0);
      let done = 0, bytes = 0, skipped = 0, failed = 0;
      const pushed = [], dirs = new Set();
      for (const [rel, entry] of entries) {
        check(task);
        const f = byRel.get(rel), target = photoTarget(entry, rel);
        done++;
        try {
          const dir = target.replace(/\/[^/]*$/, "");
          if (!dirs.has(dir)) { await sh(`mkdir -p ${shQuote(dir)}`); dirs.add(dir); }
          const there = await withSync((s) => s.stat(target)).catch(() => null);
          if (there && Number(there.size) === f.size) { skipped++; bytes += f.size; continue; }
          if (there) { failed++; continue; } // a different file has that name: never overwrite
          const mtime = Math.floor((Number(entry?.date) || f.mtime || Date.now()) / 1000);
          await withSync((s) => s.write({ filename: target, file: diskStream("restore", rel, f.size, (b) => { bytes += b; say(`${n(done)} of ${n(entries.size)} files`, bytes, total); }), permission: 0o660, mtime }));
          pushed.push(target);
        } catch (e) { check(task); console.warn(rel, e); failed++; }
      }
      say("adding to the phone's gallery…");
      for (let i = 0; i < pushed.length; i += 200) await cc("media.scan", { paths: pushed.slice(i, i + 200) }).catch((e) => console.warn("media.scan:", e));
      return { warn: failed > 0, summary: `${count(pushed.length, "file")} copied to the phone · ${n(skipped)} already there${failed ? ` · ${n(failed)} not copied (a different file has that name, or the copy failed)` : ""}` };
    },
    apps: async (say) => {
      const dirs = (await fsApi.list("restore", "apps", false)).filter((d) => d.dir && /^[\w.]+$/.test(d.rel));
      const installed = new Set((await sh("pm list packages --user 0")).split("\n").map((l) => l.trim().replace(/^package:/, "")));
      const names = new Map(found.apps.map((a) => [a.pkg, a.name]));
      let ok = 0, skipped = 0, failed = 0;
      for (const [i, d] of dirs.entries()) {
        check(task);
        const pkg = d.rel, label = names.get(pkg) || pkg;
        if (installed.has(pkg)) { skipped++; continue; }
        say(`${i + 1} of ${dirs.length} · ${label}`);
        try {
          const files = (await fsApi.list("restore", `apps/${pkg}`, false)).filter((f) => !f.dir && /\.apk$/i.test(f.rel));
          if (!files.length) throw new Error("no APK files");
          const parts = [];
          for (const f of files.sort((a, b) => (a.rel === "base.apk" ? -1 : b.rel === "base.apk" ? 1 : a.rel.localeCompare(b.rel)))) {
            const bytes = await fsApi.readFile("restore", `apps/${pkg}/${f.rel}`);
            parts.push({ bytes, size: bytes.length, split: f.rel.replace(/\.apk$/i, "") });
          }
          await h.installApk(parts, label, pkg, (t, d, tot) => say(`${i + 1} of ${dirs.length} · ${t}`, d, tot));
          ok++;
        } catch (e) { check(task); console.warn("Install", pkg, e); failed++; }
      }
      return { warn: failed > 0, summary: `${count(ok, "app")} installed · ${n(skipped)} already on the phone${failed ? ` · ${n(failed)} couldn't be installed` : ""} (without their data)` };
    },
  });

  // ---------- dialogs ----------
  function dialog(title) {
    const body = el("div", {});
    const modal = el("div", { className: "modal" }, el("div", { className: "card pd-dialog wide" }, el("h2", { textContent: title }), body));
    document.body.append(modal);
    return { modal, body, close: () => modal.remove() };
  }

  async function openRestore() {
    if (!fsApi) return showError("Restoring a backup needs the Droid Desk desktop app.");
    if (job) return toast("A backup or restore is already running");
    clearError();
    const picked = await fsApi.pickBackup();
    if (!picked) return;
    let m;
    try { m = JSON.parse(picked.manifest); } catch { m = null; }
    if (!m || m.format !== FORMAT || typeof m.items !== "object" || !m.items) throw new Error("That file isn't a Droid Desk backup (choose the backup.json inside a backup folder).");
    const files = await fsApi.list("restore", "", false);
    const found = new Set(files.map((f) => f.rel));
    found.apps = [];
    if (found.has("apps.csv")) {
      try {
        found.apps = parseCsv(await readText("restore", "apps.csv")).slice(1).map((r) => ({ name: String(r[0] || ""), pkg: String(r[1] || ""), version: String(r[2] || ""), installer: String(r[4] || "") })).filter((a) => /^[\w.]+$/.test(a.pkg));
      } catch (e) { console.warn("apps.csv:", e); }
    }
    const apkDirs = found.has("apps") ? (await fsApi.list("restore", "apps", false)).filter((d) => d.dir).length : 0;
    const it = m.items, num = (v) => (isFinite(Number(v)) ? n(v) : "?");
    const rows = [
      ["contacts", "Contacts", found.has("contacts.vcf"), `${num(it.contacts?.count)} contacts · ones already on the phone are skipped`],
      ["messages", "Text messages (SMS)", found.has("messages.xml"), `${num(it.messages?.sms)} SMS · ones already on the phone are skipped${Number(it.messages?.mms) ? ` · the ${num(it.messages.mms)} MMS stay in the backup only` : ""}`],
      ["calls", "Call log", found.has("calls.csv") || found.has("calls.xml"), `${num(it.calls?.count)} calls · ones already on the phone are skipped`],
      ["calendar", "Calendar", found.has("calendar.ics"), `${num(it.calendar?.count)} events · added to the calendar with the same name, or to the one chosen below`],
      ["photos", "Photos and videos", found.has("photos"), `${num(it.photos?.count)} files${isFinite(Number(it.photos?.bytes)) ? `, ${fmtSize(it.photos.bytes)}` : ""} · copied back to where they were, then added to the gallery`],
      ["apps", "Apps", apkDirs > 0, `${n(apkDirs)} saved installers · apps already on the phone are skipped · apps come back empty (no data, no logins)`],
    ];
    const d = dialog("Restore from a backup");
    const boxes = new Map();
    const partRows = rows.map(([key, label, present, note]) => {
      const box = el("input", { type: "checkbox", checked: false, disabled: !present });
      boxes.set(key, box);
      return el("label", { className: "bk-part" + (present ? "" : " off") }, box, el("span", {}, el("b", { textContent: label }), el("span", { className: "sub", textContent: present ? note : "not in this backup" })));
    });
    const when = new Date(m.createdAt);
    const phone = m.phone && typeof m.phone === "object" ? m.phone : {};
    const calPick = el("select", {}, el("option", { value: "new", textContent: "A new calendar kept only on the phone (“Droid Desk”)" }));
    const calRow = el("div", { className: "bk-part", hidden: true }, el("span", {}), el("span", {}, el("span", { className: "sub", textContent: "Events whose calendar isn't on this phone go to " }), calPick));
    boxes.get("calendar").onchange = async () => {
      calRow.hidden = !boxes.get("calendar").checked;
      if (calRow.hidden || calPick.dataset.loaded) return;
      calPick.dataset.loaded = "1";
      try {
        if (!(await h.companionAvailable())) return;
        const cals = await h.calendar().writableCalendars();
        for (const c of cals) calPick.append(el("option", { value: String(c.id), textContent: `${c.name || "Calendar"}${c.account ? ` (${c.account})` : ""}` }));
        const pref = cals.find((c) => c.primary) || cals[0];
        if (pref) calPick.value = String(pref.id);
      } catch (e) { console.warn("Calendars:", e); }
    };
    const status = el("div", {});
    const go = el("button", { className: "btn primary", type: "button", textContent: "Restore the ticked parts" });
    const cancel = el("button", { className: "btn", type: "button", textContent: "Close" });
    cancel.onclick = () => { if (job) { job.cancelled = true; cancel.disabled = true; cancel.textContent = "Stopping…"; } else d.close(); };
    const appList = found.apps.length ? el("details", { className: "bk-apps" }, el("summary", { textContent: `Apps that were installed (${found.apps.length})${apkDirs ? "" : " — installers weren't saved, so this is a list to reinstall from"}` }),
      el("div", { className: "bk-applist" }, ...found.apps.slice(0, 500).map((a) => el("div", {}, el("span", { textContent: a.name || a.pkg }), el("span", { className: "sub mono", textContent: `${a.pkg}${a.version ? ` · ${a.version}` : ""}${a.installer === "com.android.vending" ? " · Play Store" : ""}` }))))) : "";
    go.onclick = async () => {
      const chosen = rows.map((r) => r[0]).filter((k) => boxes.get(k).checked);
      if (!chosen.length) return toast("Tick what to restore first");
      if (!h.getAdb()) return showError("Connect the phone first.");
      clearError();
      const task = (job = { cancelled: false, phone: h.getAdb(), opts: { calendarId: calPick.value === "new" ? "new" : Number(calPick.value) } });
      for (const b of boxes.values()) b.disabled = true;
      go.hidden = true; cancel.textContent = "Cancel"; calPick.disabled = true;
      const ui = progressList(rows.filter((r) => chosen.includes(r[0])).map((r) => [r[0], r[1]]));
      status.replaceChildren(ui.box);
      try {
        if (chosen.some((k) => k !== "apps")) await needCompanion();
        const steps = restoreSteps(task, found);
        const results = await runSteps(task, chosen.map((k) => [k, steps[k]]), ui);
        const bad = Object.values(results).filter((r) => !r.ok || r.warn).length;
        status.append(el("p", { className: "muted", textContent: task.cancelled ? "Stopped. What was already restored stays on the phone." : bad ? "Finished, with problems in the parts marked ! or ✕. Running the restore again is safe: what is already on the phone is skipped." : "Everything ticked was restored." }));
      } catch (e) { showError(e); status.append(el("p", { className: "muted", textContent: errText(e) })); }
      finally { job = null; cancel.disabled = false; cancel.textContent = "Close"; }
    };
    d.body.append(
      el("p", { className: "muted", textContent: `Backup of ${String(phone.model || "a phone").slice(0, 80)}${phone.android ? ` (Android ${String(phone.android).slice(0, 20)})` : ""}, made ${isFinite(when) ? when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "at an unknown time"}${m.cancelled ? " — this backup was cancelled before it finished" : m.complete === false ? " — some parts of this backup failed" : ""}. Folder: ${picked.name}` }),
      el("p", { className: "muted", textContent: "Tick what to put on the phone that is connected now. Nothing on the phone is deleted or replaced." }),
      ...partRows.slice(0, 4), calRow, ...partRows.slice(4), appList,
      el("p", { className: "muted small", textContent: "A backup can't bring back: what apps keep inside themselves (chats, game progress, logins), MMS, or phone settings." }),
      status, el("div", { className: "toolbar", style: "margin:12px 0 0" }, go, cancel));
  }

  // ---------- the card on the Overview ----------
  const partOpts = () => ({ ...Object.fromEntries(PARTS.map((p) => [p[0], p[3]])), ...lsGet(OPTS_KEY, {}) });
  async function renderCard() {
    const card = $("backupCard"); if (!card) return;
    if (!h.getAdb()) { card.hidden = true; return; }
    card.hidden = false;
    if (job?.card) return; // a backup is showing its progress here
    if (!fsApi) {
      card.replaceChildren(el("div", { className: "card" }, el("h2", { textContent: "Back up this phone" }), el("p", { className: "muted", style: "margin:0", textContent: "Backups, restore and the automatic photo copy need the Droid Desk desktop app (they write to a folder on this computer)." })));
      return;
    }
    const [folder, photoFolder] = await Promise.all([fsApi.get("backup").catch(() => null), fsApi.get("photos").catch(() => null)]);
    const opts = partOpts();
    const boxes = new Map();
    const est = el("span", { className: "sub" });
    const showEstimate = async () => {
      if (!boxes.get("photos").checked) { est.textContent = ""; return; }
      if (estimate) { est.textContent = `${n(estimate.count)} files, about ${fmtSize(estimate.bytes)} on this computer`; return; }
      est.textContent = "working out the size…";
      try {
        if (!(await h.companionAvailable())) { est.textContent = "size unknown until the companion is installed (open Photos once)"; return; }
        const items = await listMedia();
        estimate = { count: items.length, bytes: items.reduce((s, it) => s + (Number(it.size) || 0), 0) };
        if (boxes.get("photos")?.checked) est.textContent = `${n(estimate.count)} files, about ${fmtSize(estimate.bytes)} on this computer`;
      } catch (e) { est.textContent = errText(e); }
    };
    const parts = PARTS.map(([key, label, note]) => {
      const box = el("input", { type: "checkbox", checked: !!opts[key] });
      boxes.set(key, box);
      box.onchange = () => {
        if (key === "apks" && box.checked) boxes.get("apps").checked = true;
        if (key === "apps" && !box.checked) boxes.get("apks").checked = false;
        lsSet(OPTS_KEY, Object.fromEntries([...boxes].map(([k, b]) => [k, b.checked])));
        if (key === "photos") showEstimate();
      };
      return el("label", { className: "bk-part" }, box, el("span", {}, el("b", { textContent: label }), note ? el("span", { className: "sub", textContent: note }) : "", key === "photos" ? est : ""));
    });
    const folderText = el("span", { className: "bk-path", textContent: folder ? folder.path + (folder.exists ? "" : "  (not found: choose it again)") : "No folder chosen yet" });
    const choose = el("button", { className: "btn sm", type: "button", textContent: folder ? "Change…" : "Choose folder…" });
    choose.onclick = async () => { try { if (await fsApi.choose("backup")) renderCard(); } catch (e) { showError(e); } };
    const openBtn = el("button", { className: "btn sm", type: "button", textContent: "Open", hidden: !folder?.exists });
    openBtn.onclick = () => fsApi.reveal("backup", "").catch(showError);
    const start = el("button", { className: "btn primary", type: "button", textContent: "Back up now" });
    const restore = el("button", { className: "btn", type: "button", textContent: "Restore from a backup…" });
    restore.onclick = () => openRestore().catch(showError);
    const status = el("div", {});
    start.onclick = async () => {
      if (job) return toast("A backup or restore is already running");
      if (autoJob) return toast("New photos are being copied right now. Try again when that has finished.");
      clearError();
      const chosen = Object.fromEntries([...boxes].map(([k, b]) => [k, b.checked]));
      if (!Object.values(chosen).some(Boolean)) return toast("Tick what to back up first");
      try {
        let f = await fsApi.get("backup");
        if (!f?.exists) f = await fsApi.choose("backup");
        if (!f) return;
        folderText.textContent = f.path; openBtn.hidden = false;
        if (Object.entries(chosen).some(([k, v]) => v && k !== "apps" && k !== "apks")) await needCompanion();
      } catch (e) { return showError(e); }
      const task = (job = { cancelled: false, phone: h.getAdb(), opts: chosen, card: true });
      const labels = { contacts: "Contacts", messages: "Messages", calls: "Call log", calendar: "Calendar", apps: chosen.apks ? "Apps and installers" : "List of apps", photos: "Photos and videos" };
      const ui = progressList(["contacts", "messages", "calls", "calendar", "apps", "photos"].filter((k) => chosen[k] || (k === "apps" && chosen.apks)).map((k) => [k, labels[k]]));
      const stop = el("button", { className: "btn sm", type: "button", textContent: "Cancel" });
      stop.onclick = () => { task.cancelled = true; stop.disabled = true; stop.textContent = "Stopping…"; };
      status.replaceChildren(ui.box, el("div", { className: "toolbar", style: "margin:10px 0 0" }, stop));
      start.disabled = restore.disabled = choose.disabled = true;
      for (const b of boxes.values()) b.disabled = true;
      try {
        const { root, results } = await runBackup(chosen, ui, task);
        const bad = Object.values(results).filter((r) => !r.ok || r.warn).length;
        const show = el("button", { className: "btn sm", type: "button", textContent: "Show the backup folder" });
        show.onclick = () => fsApi.reveal("backup", root).catch(showError);
        status.append(el("p", { className: "muted", textContent: task.cancelled ? `Cancelled. What was saved so far is in “${root}”.` : bad ? `Finished, but ${bad} part${bad === 1 ? "" : "s"} had problems (marked ! or ✕ above). The rest is in “${root}”.` : `Done. Saved in “${root}”.` }), show);
        stop.remove();
        toast(task.cancelled ? "Backup cancelled" : bad ? "Backup finished with problems" : "Backup finished");
      } catch (e) { showError(e); status.append(el("p", { className: "muted", textContent: `The backup stopped: ${errText(e)}` })); stop.remove(); }
      finally {
        job = null;
        if (start.isConnected) { start.disabled = restore.disabled = choose.disabled = false; for (const b of boxes.values()) b.disabled = false; }
      }
    };

    const autoNote = el("div", { className: "sub", id: "bkAutoNote", textContent: lastAuto });

    // The page is three cards: back up, restore, and what the automatic photo copy last did.
    card.replaceChildren(
      el("div", { className: "card" },
        el("h2", { textContent: "Back up this phone" }),
        el("p", { className: "muted", textContent: "Saves a copy of what's ticked into a new dated folder on this computer. Nothing on the phone is changed." }),
        el("div", { className: "bk-row" }, el("span", { className: "muted small", textContent: "Folder" }), folderText, choose, openBtn),
        el("div", { className: "bk-parts" }, ...parts),
        el("div", { className: "toolbar", style: "margin:14px 0 0" }, start),
        status,
        el("p", { className: "muted small", style: "margin:12px 0 0", textContent: NOT_INCLUDED })),
      el("div", { className: "card" },
        el("h2", { textContent: "Restore from a backup" }),
        el("p", { className: "muted", textContent: "Choose a backup folder, see what it holds and pick the parts to put back on this phone. Only what isn't on the phone yet is added; nothing is deleted or replaced." }),
        el("div", { className: "toolbar", style: "margin:0" }, restore)),
      // The switch and its folder are in Settings › Phone link; this card says what the last copy did.
      el("div", { className: "card" },
        el("h2", { textContent: "Automatic photo copy" }),
        el("p", { className: "muted", textContent: "Copies new photos and videos to this computer each time the phone connects." }),
        el("div", { className: "bk-row" }, el("span", { className: "pd-grow" }, el("b", { textContent: lsGet(AUTO_KEY, false) && photoFolder ? "On" : "Off" }),
          el("span", { className: "sub", textContent: photoFolder ? ` Folder: ${photoFolder.path}` : " Switch it on in Settings." })), settingsBtn()), autoNote));
    if (boxes.get("photos").checked) showEstimate();
  }

  // ---------- automatic photo copy ----------
  function autoToast() {
    let box = $("bkAutoToast");
    if (!box) { box = el("div", { className: "bk-toast", id: "bkAutoToast", hidden: true }); document.body.append(box); }
    return box;
  }
  const setAutoNote = (text) => { lastAuto = text; const note = $("bkAutoNote"); if (note) note.textContent = text; };

  async function autoPhotos({ manual = false } = {}) {
    if (!fsApi || autoJob || !lsGet(AUTO_KEY, false)) return;
    const phone = h.getAdb(); if (!phone) return;
    if (job) return; // a full backup is running; the next connection catches up
    const task = (autoJob = { cancelled: false, phone });
    const box = autoToast();
    const alive = () => !task.cancelled && h.getAdb() === phone;
    try {
      const folder = await fsApi.get("photos");
      if (!folder?.exists) { setAutoNote("Automatic photo copy is on, but its folder wasn't found. Choose the folder again."); return; }
      if (!(await h.companionAvailable())) { setAutoNote("Automatic photo copy is waiting for the Droid Desk Companion (open Photos once to install it)."); return; }
      const facts = await phoneFacts();
      const serial = /^[\w.:-]{1,64}$/.test(facts.serial) ? facts.serial : "";
      if (!serial) { setAutoNote("Automatic photo copy: this phone has no usable serial number."); return; }
      const items = await listMedia();
      if (!alive()) return;
      // One folder per phone. The record says what was copied; the folder says what is really there.
      const root = safeName(`${facts.model} (${serial.replace(/[^\w.-]/g, "_")})`);
      const record = (await fsApi.recordGet(serial)) || {};
      const known = record.items && typeof record.items === "object" ? record.items : {};
      const disk = new Map((await fsApi.list("photos", root, true)).map((f) => [f.rel.toLowerCase(), f.size]));
      const used = new Set(disk.keys());
      const next = {}, todo = [];
      for (const it of items) {
        const key = `${it.kind}:${it.id}`, rec = known[key];
        if (rec && rec.size === it.size && rec.date === it.date && typeof rec.rel === "string" && disk.get(rec.rel.toLowerCase()) === it.size) { next[key] = rec; continue; }
        // Not in the record (or the record is gone): a file with this album, name and size counts as copied.
        const plain = `${safeName(it.album || "No album", "No album")}/${safeName(it.name || `${it.kind}-${it.id}`)}`;
        if (disk.get(plain.toLowerCase()) === it.size) { next[key] = { size: it.size, date: it.date, rel: plain }; continue; }
        todo.push(it);
      }
      const save = () => fsApi.recordSet(serial, { v: 1, model: facts.model, folder: root, updatedAt: Date.now(), items: next }).catch((e) => console.warn("Photo record:", e));
      if (!todo.length) { await save(); setAutoNote(`Photos are up to date (${n(items.length)} on the phone, checked ${new Date().toLocaleTimeString([], { timeStyle: "short" })}).`); if (manual) toast("No new photos to copy"); return; }
      const total = todo.reduce((s, it) => s + (Number(it.size) || 0), 0);
      let done = 0, bytes = 0, failed = 0;
      const bar = createProgress({ el, fmtSize });
      const stop = el("button", { className: "btn sm", type: "button", textContent: "Stop" });
      stop.onclick = () => { task.cancelled = true; stop.disabled = true; };
      box.replaceChildren(bar.node, stop); box.hidden = false;
      const draw = () => bar.update(`Copying new photos… ${n(Math.min(done + 1, todo.length))} of ${n(todo.length)}`, bytes, total);
      draw();
      for (const it of todo) {
        if (!alive()) break;
        const rel = uniqueRel(used, safeName(it.album || "No album", "No album"), it.name || `${it.kind}-${it.id}`);
        try {
          await pullToFile(it.path, "photos", `${root}/${rel}`, { mtime: it.date, task, onBytes: (b) => { bytes += b; draw(); } });
          next[`${it.kind}:${it.id}`] = { size: it.size, date: it.date, rel };
        } catch (e) { if (!alive()) break; console.warn("Photo copy:", it.path, e); failed++; }
        done++; draw();
        if (done % 25 === 0) await save();
      }
      await save();
      const copied = done - failed;
      const summary = `${copied === 1 ? "1 new photo or video" : `${n(copied)} new photos and videos`} copied to “${folder.name}”${failed ? ` · ${n(failed)} failed (they'll be tried again next time)` : ""}${!alive() ? " · stopped early" : ""}`;
      setAutoNote(`${summary} · ${new Date().toLocaleTimeString([], { timeStyle: "short" })}`);
      const shut = el("button", { className: "btn sm", type: "button", textContent: "OK" });
      const showBtn = el("button", { className: "btn sm", type: "button", textContent: "Show" });
      showBtn.onclick = () => fsApi.reveal("photos", root).catch(showError);
      shut.onclick = () => { box.hidden = true; };
      box.replaceChildren(el("span", { textContent: summary }), showBtn, shut);
      setTimeout(() => { if (box.contains(shut)) box.hidden = true; }, 12000);
    } catch (e) {
      console.warn("Automatic photo copy:", e);
      setAutoNote(`Automatic photo copy didn't run: ${errText(e)}`);
      box.hidden = true;
    } finally { autoJob = null; }
  }

  const settingsBtn = () => { const b = el("button", { className: "btn sm", type: "button", textContent: "Change in Settings" }); b.onclick = () => h.showSettings(); return b; };
  return {
    // Settings › Phone link: copy new photos to this computer whenever the phone connects.
    auto: {
      folder: () => fsApi.get("photos").catch(() => null),
      choose: () => fsApi.choose("photos"),
      get: async () => lsGet(AUTO_KEY, false) && !!(await fsApi.get("photos").catch(() => null)),
      async set(want) {
        if (want && !(await fsApi.get("photos"))?.exists && !(await fsApi.choose("photos"))) return false;
        lsSet(AUTO_KEY, !!want);
        if (want && h.getAdb()) autoPhotos({ manual: true });
        return !!want;
      },
    },
    renderCard: () => renderCard().catch((e) => console.warn("Backup card:", e)),
    onConnected() {
      estimate = null; lastAuto = "";
      const phone = h.getAdb();
      // A moment after connecting, so the first screen isn't competing with it.
      setTimeout(() => { if (h.getAdb() === phone) autoPhotos(); }, 4000);
    },
    onDisconnected() {
      if (job) job.cancelled = true;
      if (autoJob) autoJob.cancelled = true;
      const box = $("bkAutoToast"); if (box) box.hidden = true;
      const card = $("backupCard"); if (card) card.hidden = true;
      estimate = null;
    },
    openRestore,
  };
}
