// Files page: browse the phone's storage, preview a file in a side panel, and download, upload, rename,
// delete, compress (zip) and extract. Everything goes over ADB: listing and transfers through the sync
// service, the rest (mkdir, mv, rm, unzip, tar) as shell commands on the phone.
// Icons come from ./fileicons.js, the same ones every other file list uses.
import { Zip, ZipDeflate, ZipPassThrough, unzipSync, strFromU8 } from "fflate";
import { fileIcon, fileKind, icon, extOf, KIND_NAMES } from "./fileicons.js";
import { createProgress, countBytes } from "./progress.js";

const TEXT_PREVIEW = 256 * 1024;      // how much of a text file is read for its preview
const MEDIA_LIMIT = 400 * 1024 ** 2;  // pictures, sound and video above this aren't pulled for a preview
const ZIP_LIMIT = 300 * 1024 ** 2;    // archives above this aren't opened on this computer
// Already compressed: stored in a zip as they are, which is much faster and no bigger.
const STORED = new Set("jpg jpeg png gif webp heic avif mp4 m4v mkv webm mov 3gp mp3 m4a aac ogg opus flac zip rar 7z gz tgz bz2 xz zst apk apks jar aab obb docx xlsx pptx epub".split(" "));
const TEXT_KINDS = new Set(["text", "code", "data", "script"]);

export function initFiles(ctx) {
  const { $, el, toast, showError, clearError, busy, sh, shQuote, withSync, fmtSize, fmtDate, download, getAdb, LinuxFileType } = ctx;
  const root = $("filesRoot");
  const join = (dir, name) => (dir.endsWith("/") ? dir : dir + "/") + name;
  const parent = (p) => p.replace(/\/[^/]+\/?$/, "") || "/";
  const q = shQuote;

  let cwd = "/sdcard", entries = [], filter = "", sort = { key: "name", dir: 1 };
  const sel = new Set();   // names ticked in this folder
  let open = null;         // the entry shown in the side panel
  let token = 0, blobUrl = null, job = null;

  // ---------- small pieces ----------
  const iconBtn = (name, title, onClick, cls = "") => {
    const b = el("button", { className: "fx-ib" + (cls ? " " + cls : ""), type: "button", title }, icon(name));
    b.setAttribute("aria-label", title);
    b.onclick = (e) => { e.stopPropagation(); Promise.resolve(onClick(b)).catch(showError); };
    return b;
  };
  const textBtn = (name, label, onClick, cls = "") => {
    const b = el("button", { className: "btn sm fx-tb" + (cls ? " " + cls : ""), type: "button" }, icon(name), el("span", { textContent: label }));
    b.onclick = () => Promise.resolve(onClick(b)).catch(showError);
    return b;
  };
  // One button of an action group: an icon only, its name in the tooltip.
  const groupBtn = (name, title, onClick, cls = "") => {
    const b = el("button", { className: "fx-gb" + (cls ? " " + cls : ""), type: "button", title }, icon(name));
    b.setAttribute("aria-label", title);
    b.onclick = () => Promise.resolve(onClick(b)).catch(showError);
    return b;
  };
  const group = (...buttons) => { const g = el("div", { className: "fx-group" }, ...buttons.filter(Boolean)); g.setAttribute("role", "group"); return g; };
  // Two clicks for anything that deletes: the first turns the button red, the second does it.
  const armed = (b, title, action) => {
    let timer = 0;
    const rest = () => { clearTimeout(timer); b.classList.remove("armed"); b.title = title; b.setAttribute("aria-label", title); };
    b.onclick = () => {
      if (!b.classList.contains("armed")) { b.classList.add("armed"); b.title = "Click again to delete"; b.setAttribute("aria-label", b.title); timer = setTimeout(rest, 3000); return; }
      rest();
      Promise.resolve(action()).catch(showError);
    };
    return b;
  };
  const typeOf = (e) => (e.type === LinuxFileType.Directory ? "dir" : e.type === LinuxFileType.Link ? "link" : "file");
  const when = (e) => { const d = Number(e.mtime) * 1000; return d > 0 ? fmtDate(d, true) : ""; };
  /** Runs a shell command on the phone; throws with its output when it fails. */
  async function run(cmd) {
    const out = await sh(`${cmd} 2>&1; echo "__exit:$?"`);
    const m = /__exit:(\d+)\s*$/.exec(out), text = out.replace(/__exit:\d+\s*$/, "").trim();
    if (!m || m[1] !== "0") throw new Error(text || "The phone refused.");
    return text;
  }
  async function readBytes(path, limit = Infinity, onBytes = null, job = null) {
    return withSync(async (s) => {
      const reader = s.read(path).getReader(); const parts = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (job?.cancelled) { reader.cancel().catch(() => {}); throw new Error("cancelled"); }
        parts.push(value.slice()); got += value.length; onBytes?.(got);
        if (got >= limit) { reader.cancel().catch(() => {}); break; }
      }
      const all = new Uint8Array(Math.min(got, limit)); let at = 0;
      for (const p of parts) { const take = Math.min(p.length, all.length - at); all.set(p.subarray(0, take), at); at += take; if (at >= all.length) break; }
      return all;
    });
  }

  // ---------- page skeleton ----------
  const crumbs = el("div", { className: "fx-crumbs" });
  const search = el("input", { type: "search", placeholder: "Filter this folder…", className: "fx-search" });
  search.setAttribute("aria-label", "Filter this folder");
  search.oninput = () => { filter = search.value.trim().toLowerCase(); renderList(); };
  const upload = el("input", { type: "file", multiple: true, hidden: true });
  const newBox = el("div", { className: "fx-new", hidden: true });
  const selBar = el("div", { className: "fx-selbar", hidden: true });
  const status = el("div", { className: "fx-status", hidden: true });
  const head = el("div", { className: "fx-head" });
  const list = el("div", { className: "fx-list" });
  const side = el("aside", { className: "card fx-side", hidden: true });
  const tools = el("div", { className: "fx-tools" },
    iconBtn("arrow-up", "Up one folder", () => { if (cwd !== "/") return load(parent(cwd)); }),
    iconBtn("refresh-cw", "Reload this folder", () => load(cwd)),
    iconBtn("folder-plus", "New folder", () => showNewFolder()),
    textBtn("upload", "Upload", () => upload.click(), "primary"));
  // The toolbar, the selection bar and the column headings stay in place while the list scrolls.
  const top = el("div", { className: "fx-top" }, el("div", { className: "fx-bar" }, crumbs, search, tools, upload), newBox, selBar, status, head);
  const main = el("div", { className: "card fx-main" }, top, list);
  const wrap = el("div", { className: "fx" }, main, side);
  root.replaceChildren(wrap);

  upload.onchange = async () => {
    const files = [...upload.files]; upload.value = ""; if (!files.length) return;
    await work(`Uploading ${files.length} file${files.length > 1 ? "s" : ""}…`, async (say, j) => {
      const total = files.reduce((t, f) => t + f.size, 0);
      let n = 0, sent = 0;
      for (const f of files) {
        stopIf(j);
        const what = files.length > 1 ? `Uploading ${f.name} (${++n} of ${files.length})` : `Uploading ${f.name}`;
        say(what, sent, total);
        const to = join(cwd, f.name);
        const file = countBytes(f.stream(), (b) => { sent += b; say(what, sent, total); }, () => stopIf(j));
        try { await withSync((s) => s.write({ filename: to, file, permission: 0o660, mtime: Math.floor(f.lastModified / 1000) })); }
        catch (e) { if (j.cancelled) await sh(`rm -f -- ${q(to)}`).catch(() => {}); throw e; } // no half-uploaded file is left
      }
      toast(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""}`);
    });
    await load(cwd);
  };

  /** One long job at a time, with its progress under the toolbar and a Cancel button. */
  async function work(title, fn) {
    if (job) { toast("Wait for the running job to finish"); return false; }
    const mine = job = { cancelled: false };
    const bar = createProgress({ el, fmtSize });
    bar.update(title);
    const cancel = el("button", { className: "btn sm", type: "button", textContent: "Cancel" });
    cancel.onclick = () => { mine.cancelled = true; cancel.disabled = true; bar.update("Stopping…"); };
    status.replaceChildren(bar.node, cancel); status.hidden = false;
    // say(text) for a step without a known size; say(text, done, total[, "items"]) moves the bar.
    try { clearError(); await fn((t, done, total, unit) => { if (!mine.cancelled) bar.update(t, done, total, unit); }, mine); return true; }
    catch (e) { if (mine.cancelled) toast("Cancelled"); else showError(e); return false; }
    finally { job = null; status.hidden = true; }
  }
  const stopIf = (j) => { if (j.cancelled) throw new Error("cancelled"); };

  // ---------- listing ----------
  async function load(path) {
    if (!getAdb()) return;
    clearError();
    const got = await withSync((s) => s.readdir(path));
    cwd = path; sel.clear();
    entries = got.filter((e) => e.name !== "." && e.name !== "..");
    if (open && !(parent(open.path) === cwd && entries.some((e) => e.name === open.name))) closeSide();
    renderCrumbs(); renderList();
  }
  function renderCrumbs() {
    const parts = cwd.split("/").filter(Boolean);
    const mk = (label, target, last) => { const b = el("button", { type: "button", textContent: label, className: last ? "on" : "" }); b.onclick = () => load(target).catch(showError); return b; };
    crumbs.replaceChildren(mk("Phone", "/", !parts.length), ...parts.flatMap((p, i) => [el("i", { textContent: "›" }), mk(p, "/" + parts.slice(0, i + 1).join("/"), i === parts.length - 1)]));
  }
  const shown = () => {
    const rows = entries.filter((e) => !filter || e.name.toLowerCase().includes(filter));
    const val = { name: (e) => e.name.toLowerCase(), size: (e) => Number(e.size) || 0, date: (e) => Number(e.mtime) || 0 }[sort.key];
    return rows.sort((a, b) => {
      const da = typeOf(a) === "dir", db = typeOf(b) === "dir";
      if (da !== db) return da ? -1 : 1; // folders first, always
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * sort.dir;
    });
  };
  function renderList() {
    const rows = shown();
    const all = el("input", { type: "checkbox", title: "Select all" });
    all.checked = rows.length > 0 && rows.every((e) => sel.has(e.name));
    all.onchange = () => { for (const e of rows) all.checked ? sel.add(e.name) : sel.delete(e.name); renderList(); };
    const col = (key, label, cls) => {
      const b = el("button", { type: "button", className: "fx-col " + cls, textContent: label + (sort.key === key ? (sort.dir > 0 ? " ↑" : " ↓") : "") });
      b.onclick = () => { sort = { key, dir: sort.key === key ? -sort.dir : 1 }; renderList(); };
      return b;
    };
    head.replaceChildren(all, el("span", {}), col("name", "Name", ""), col("size", "Size", "num hide-sm"), col("date", "Modified", "hide-sm"), el("span", {}));
    list.replaceChildren(...(rows.length ? rows.map(row) : [el("div", { className: "empty", textContent: filter ? "Nothing in this folder matches" : "Empty folder (or no permission to list it)" })]));
    renderSelBar();
  }
  function row(e) {
    const type = typeOf(e), path = join(cwd, e.name);
    const box = el("input", { type: "checkbox", checked: sel.has(e.name), title: "Select" });
    box.onclick = (ev) => ev.stopPropagation();
    box.onchange = () => { box.checked ? sel.add(e.name) : sel.delete(e.name); r.classList.toggle("sel", box.checked); renderSelBar(); };
    const acts = el("span", { className: "fx-acts" });
    if (type === "file") acts.append(iconBtn("download", `Download ${e.name}`, (b) => pull([{ path, name: e.name, size: e.size }], b)));
    const r = el("div", { className: "fx-row" + (sel.has(e.name) ? " sel" : "") + (open?.path === path ? " open" : ""), tabIndex: 0 },
      box, fileIcon(e.name, type),
      el("span", { className: "fx-name", textContent: e.name, title: e.name }),
      el("span", { className: "num hide-sm muted", textContent: type === "file" ? fmtSize(e.size) : "" }),
      el("span", { className: "hide-sm muted", textContent: when(e) }),
      acts);
    const go = () => (type === "file" ? showSide({ ...e, path, kind: fileKind(e.name), type }) : load(path)).catch(showError);
    r.onclick = go;
    r.onkeydown = (ev) => { if (ev.key === "Enter" && ev.target === r) go(); };
    return r;
  }
  const picked = () => entries.filter((e) => sel.has(e.name));
  function renderSelBar() {
    const items = picked();
    selBar.hidden = !items.length;
    if (!items.length) return;
    const files = items.filter((e) => typeOf(e) === "file");
    selBar.replaceChildren(
      el("b", { textContent: `${items.length} selected` }),
      group(
        groupBtn("download", "Download", async () => { if (!files.length) return toast("Folders can't be downloaded directly: compress them first"); await pull(files.map((f) => ({ path: join(cwd, f.name), name: f.name, size: f.size }))); }),
        groupBtn("archive", "Compress into a zip", () => compress(items)),
        armed(groupBtn("trash-2", "Delete", () => {}, "danger"), "Delete", () => remove(items)),
        groupBtn("x", "Clear the selection", () => { sel.clear(); renderList(); })));
  }

  // ---------- actions ----------
  /** Downloads files from the phone to this computer: [{ path, name, size }]. */
  async function pull(list, btn) {
    if (btn) btn.disabled = true;
    try {
      await work(list.length === 1 ? `Downloading ${list[0].name}…` : `Downloading ${list.length} files…`, async (say, j) => {
        const total = list.reduce((t, f) => t + (Number(f.size) || 0), 0);
        let before = 0, n = 0;
        for (const f of list) {
          stopIf(j);
          const what = list.length > 1 ? `Downloading ${f.name} (${++n} of ${list.length})` : `Downloading ${f.name}`;
          say(what, before, total);
          const bytes = await readBytes(f.path, Infinity, (got) => say(what, before + got, total), j);
          before += Number(f.size) || bytes.length;
          download(new Blob([bytes]), f.name);
        }
      });
    } finally { if (btn) btn.disabled = false; }
  }
  async function remove(items) {
    await run(`rm -rf -- ${items.map((e) => q(join(cwd, e.name))).join(" ")}`);
    toast(items.length === 1 ? `Deleted ${items[0].name}` : `Deleted ${items.length} items`);
    await load(cwd);
  }
  function showNewFolder() {
    const input = el("input", { type: "text", placeholder: "Folder name" });
    const done = () => { newBox.hidden = true; newBox.replaceChildren(); };
    const make = async () => {
      const name = input.value.trim();
      if (!name || /[/\0]/.test(name) || name === "." || name === "..") return toast("Type a folder name without “/”");
      await run(`mkdir -- ${q(join(cwd, name))}`);
      done(); toast(`Created ${name}`); await load(cwd);
    };
    input.onkeydown = (e) => { if (e.key === "Enter") make().catch(showError); else if (e.key === "Escape") done(); };
    newBox.replaceChildren(fileIcon("", "dir"), input, textBtn("folder-plus", "Create", make, "primary"), textBtn("x", "Cancel", done));
    newBox.hidden = false; input.focus();
  }
  async function rename(entry, to) {
    const name = to.trim();
    if (!name || name === entry.name) return;
    if (/[/\0]/.test(name)) return toast("A name can't contain “/”");
    if (entries.some((e) => e.name === name)) return toast("Something with that name is already here");
    await run(`mv -- ${q(entry.path)} ${q(join(cwd, name))}`);
    toast(`Renamed to ${name}`); closeSide(); await load(cwd);
  }

  // A name that isn't taken in this folder: "Photos.zip", then "Photos (2).zip".
  const freeName = (stem, ext) => { let n = stem + ext; for (let i = 2; entries.some((e) => e.name === n); i++) n = `${stem} (${i})${ext}`; return n; };

  /** Zips files and folders into this folder. The data passes through this computer: read, zipped, written back. */
  async function compress(items) {
    const name = freeName(items.length === 1 ? items[0].name.replace(/\.[^.]+$/, "") || items[0].name : cwd.split("/").filter(Boolean).pop() || "Archive", ".zip");
    const dest = join(cwd, name);
    const ok = await work(`Compressing into ${name}…`, async (say, j) => {
      const files = [];
      const walk = async (path, rel, e) => {
        stopIf(j);
        if (typeOf(e) === "dir") {
          for (const c of await withSync((s) => s.readdir(path))) if (c.name !== "." && c.name !== "..") await walk(join(path, c.name), `${rel}/${c.name}`, c);
        } else if (typeOf(e) === "file") files.push({ path, rel, size: Number(e.size) || 0, mtime: Number(e.mtime) || 0 });
      };
      say("Listing what to compress…");
      for (const e of items) await walk(join(cwd, e.name), e.name, e);
      if (!files.length) throw new Error("There are no files in what you selected.");
      const total = files.reduce((n, f) => n + f.size, 0); let done = 0, failed = null, ctl;
      const out = new ReadableStream({ start(c) { ctl = c; } }, new ByteLengthQueuingStrategy({ highWaterMark: 8 << 20 }));
      const zip = new Zip((err, chunk, final) => { if (err) { failed = err; ctl.error(err); return; } ctl.enqueue(chunk); if (final) ctl.close(); });
      const writing = withSync((s) => s.write({ filename: dest, file: out, permission: 0o660 }));
      writing.catch(() => {});
      try {
        for (const f of files) {
          const part = STORED.has(extOf(f.rel)) ? new ZipPassThrough(f.rel) : new ZipDeflate(f.rel, { level: 6 });
          if (f.mtime) part.mtime = new Date(f.mtime * 1000);
          zip.add(part);
          await withSync(async (s) => {
            const reader = s.read(f.path).getReader();
            for (;;) {
              const { done: end, value } = await reader.read(); if (end) break;
              if (j.cancelled || failed) { reader.cancel().catch(() => {}); throw failed || new Error("cancelled"); }
              part.push(value.slice(), false); done += value.length;
              say(`Compressing ${f.rel.split("/").pop()}`, done, total);
              while (ctl.desiredSize <= 0 && !j.cancelled) await new Promise((r) => setTimeout(r, 20)); // the phone is still writing
            }
          });
          part.push(new Uint8Array(0), true);
        }
        zip.end();
        await writing;
      } catch (e) {
        try { ctl.error(e); } catch {}
        await writing.catch(() => {});
        await sh(`rm -f -- ${q(dest)}`).catch(() => {}); // no half-written archive is left behind
        throw e;
      }
      toast(`Created ${name}`);
    });
    sel.clear();
    await load(cwd);
    return ok;
  }

  const ARCHIVE = /\.(zip|jar|tar|tgz|tar\.gz|tar\.bz2|tar\.xz|gz)$/i;
  const canExtract = (name) => ARCHIVE.test(name);
  /** Unpacks an archive into a new folder beside it, on the phone itself (unzip / tar); zip falls back to this computer. */
  async function extract(entry) {
    const lower = entry.name.toLowerCase();
    const stem = entry.name.replace(/\.(tar\.(gz|bz2|xz)|tgz|zip|jar|tar|gz)$/i, "") || "Extracted";
    const folder = freeName(stem, ""), dest = join(cwd, folder), src = q(entry.path), d = q(dest);
    await work(`Extracting ${entry.name}…`, async (say, j) => {
      if (/\.(zip|jar)$/.test(lower)) {
        try { await run(`mkdir -p -- ${d} && unzip -o -q ${src} -d ${d}`); }
        catch (e) {
          if (!/not found|inaccessible|applet/i.test(e.message)) { await sh(`rmdir -- ${d}`).catch(() => {}); throw e; }
          // No unzip on this phone: unpack on this computer and send the files back.
          if (Number(entry.size) > ZIP_LIMIT) throw new Error(`This phone has no unzip tool, and the archive is too large (${fmtSize(entry.size)}) to unpack on this computer.`);
          say("Reading the archive…");
          const files = unzipSync(await readBytes(entry.path));
          const names = Object.keys(files).filter((n) => !n.endsWith("/") && !n.split("/").includes(".."));
          let n = 0;
          for (const name of names) {
            stopIf(j); say(`Extracting ${name.split("/").pop()}`, ++n, names.length, "items");
            const to = join(dest, name);
            await run(`mkdir -p -- ${q(parent(to))}`);
            await withSync((s) => s.write({ filename: to, file: new Blob([files[name]]).stream(), permission: 0o660 }));
          }
        }
      } else if (/\.gz$/.test(lower) && !/\.tar\.gz$/.test(lower)) {
        await run(`mkdir -p -- ${d} && gzip -dc ${src} > ${q(join(dest, entry.name.replace(/\.gz$/i, "")))}`);
      } else {
        const flag = /\.(tar\.gz|tgz)$/.test(lower) ? "z" : /\.tar\.bz2$/.test(lower) ? "j" : /\.tar\.xz$/.test(lower) ? "J" : "";
        await run(`mkdir -p -- ${d} && tar -x${flag}f ${src} -C ${d}`);
      }
      toast(`Extracted into ${folder}`);
    });
    await load(cwd);
  }

  // ---------- side panel: preview and details ----------
  function closeSide() {
    token++; open = null;
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    side.hidden = true; side.replaceChildren(); wrap.classList.remove("with-side");
    for (const r of list.querySelectorAll(".fx-row.open")) r.classList.remove("open");
  }
  async function showSide(entry) {
    closeSide();
    open = entry; const mine = ++token;
    wrap.classList.add("with-side"); side.hidden = false;
    renderList();
    const body = el("div", { className: "fx-prev" }, el("div", { className: "fx-wait" }, el("span", { className: "spin" }), " Loading the preview…"));
    const nameInput = el("input", { type: "text", value: entry.name, className: "fx-rename", hidden: true });
    nameInput.setAttribute("aria-label", "New name");
    const title = el("b", { className: "fx-title", textContent: entry.name, title: entry.name });
    nameInput.onkeydown = (e) => { if (e.key === "Enter") rename(entry, nameInput.value).catch(showError); else if (e.key === "Escape") { nameInput.hidden = true; title.hidden = false; } };
    const kindName = KIND_NAMES[entry.kind] || "File", ext = extOf(entry.name);
    const meta = el("dl", { className: "fx-meta" },
      ...[["Type", ext ? `${kindName} (.${ext})` : kindName], ["Size", `${fmtSize(entry.size)} (${Number(entry.size).toLocaleString()} bytes)`], ["Modified", when(entry)], ["Folder", cwd]]
        .flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v, title: v })]));
    const acts = el("div", { className: "fx-actions" }, group(
      groupBtn("download", "Download", (b) => pull([{ path: entry.path, name: entry.name, size: entry.size }], b)),
      canExtract(entry.name) ? groupBtn("archive-restore", "Extract here", () => extract(entry)) : null,
      groupBtn("archive", "Compress into a zip", () => compress([entry])),
      groupBtn("pencil", "Rename", () => { title.hidden = true; nameInput.hidden = false; nameInput.focus(); nameInput.setSelectionRange(0, entry.name.replace(/\.[^.]+$/, "").length); }),
      armed(groupBtn("trash-2", "Delete", () => {}, "danger"), "Delete", async () => { closeSide(); await remove([entry]); })));
    side.replaceChildren(
      el("div", { className: "fx-sidehead" }, fileIcon(entry.name), el("div", { className: "fx-sidename" }, title, nameInput), iconBtn("x", "Close the preview", closeSide)),
      body, meta, acts);
    try {
      const view = await preview(entry, () => mine === token);
      if (mine === token) body.replaceChildren(view);
    } catch (e) {
      if (mine === token) body.replaceChildren(note(`Couldn't open this file: ${e?.message || e}`));
    }
  }
  const note = (text) => el("div", { className: "fx-none" }, icon("eye"), el("div", { textContent: text }));
  const hexDump = (bytes) => {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const part = bytes.subarray(i, i + 16);
      lines.push(i.toString(16).padStart(6, "0") + "  " + [...part].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(48) + " " + [...part].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "·")).join(""));
    }
    return lines.join("\n");
  };
  const looksBinary = (bytes) => { let odd = 0; const n = Math.min(bytes.length, 4096); for (let i = 0; i < n; i++) if (bytes[i] === 0 || (bytes[i] < 9)) odd++; return n > 0 && odd / n > 0.02; };
  const MIME = { svg: "image/svg+xml", mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4", webm: "video/webm", mkv: "video/webm", "3gp": "video/3gpp", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac" };

  /** Builds the preview for one file. `live()` says whether the panel still shows this file. */
  async function preview(entry, live) {
    const size = Number(entry.size) || 0, ext = extOf(entry.name), kind = entry.kind;
    if (!size) return note("This file is empty.");
    const media = (tag) => new Promise((resolve) => {
      (async () => {
        if (size > MEDIA_LIMIT) return resolve(note(`Too large to preview (${fmtSize(size)}). Download it to open it.`));
        const blob = new Blob([await readBytes(entry.path)], { type: MIME[ext] || "" });
        if (!live()) return resolve(el("div"));
        blobUrl = URL.createObjectURL(blob);
        const m = el(tag, { src: blobUrl, className: "fx-media" });
        if (tag !== "img") m.controls = true;
        m.onerror = () => resolve(note(tag === "img" ? "This picture format can't be shown here. Download it to open it." : "This format can't be played here. Download it to open it."));
        if (tag === "img") { m.alt = entry.name; m.onload = () => resolve(m); } else { m.onloadedmetadata = () => resolve(m); }
      })().catch((e) => resolve(note(`Couldn't open this file: ${e?.message || e}`)));
    });
    if (kind === "image") return media("img");
    if (kind === "video") return media("video");
    if (kind === "audio") return media("audio");

    const zipLike = kind === "apk" || ["zip", "jar", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub"].includes(ext);
    if (zipLike) {
      if (size > ZIP_LIMIT) return note(`Too large to look inside (${fmtSize(size)}).`);
      const data = await readBytes(entry.path);
      if (ext === "docx" || ext === "odt") { // the text of the document, without its layout
        const inner = ext === "docx" ? "word/document.xml" : "content.xml";
        const got = unzipSync(data, { filter: (f) => f.name === inner })[inner];
        if (got) {
          const text = strFromU8(got).replace(/<\/(w:p|text:p|text:h)>/g, "\n").replace(/<(w:tab|text:tab)[^>]*>/g, "\t").replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
          return el("div", {}, el("div", { className: "fx-hint", textContent: "Text only; pictures and layout aren't shown." }), el("pre", { className: "fx-text fx-wraptext", textContent: text.slice(0, 200000) || "(no text)" }));
        }
      }
      const inside = [];
      unzipSync(data, { filter: (f) => { inside.push({ name: f.name, size: f.originalSize }); return false; } });
      const files = inside.filter((f) => !f.name.endsWith("/"));
      return el("div", {},
        el("div", { className: "fx-hint", textContent: `${files.length.toLocaleString()} file${files.length === 1 ? "" : "s"} inside · ${fmtSize(files.reduce((n, f) => n + f.size, 0))} unpacked` }),
        el("div", { className: "fx-zip" }, ...files.slice(0, 500).map((f) => el("div", { className: "fx-zrow" }, fileIcon(f.name), el("span", { textContent: f.name, title: f.name }), el("span", { className: "muted", textContent: fmtSize(f.size) }))),
          files.length > 500 ? el("div", { className: "muted small", textContent: `…and ${(files.length - 500).toLocaleString()} more` }) : ""));
    }
    if (kind === "archive") return note("Extract this archive to see what is inside.");
    if (kind === "pdf" || kind === "sheet" && ext !== "csv" && ext !== "tsv" || kind === "slides" || kind === "doc")
      return note("This kind of document can't be shown here. Download it to open it on this computer.");

    const bytes = await readBytes(entry.path, TEXT_PREVIEW);
    const cut = size > bytes.length ? el("div", { className: "fx-hint", textContent: `Showing the first ${fmtSize(bytes.length)} of ${fmtSize(size)}.` }) : "";
    if (!TEXT_KINDS.has(kind) && ext !== "csv" && ext !== "tsv" && looksBinary(bytes)) {
      return el("div", {}, el("div", { className: "fx-hint", textContent: "No preview for this type. These are its first bytes." }), el("pre", { className: "fx-text fx-hex", textContent: hexDump(bytes.subarray(0, 512)) }));
    }
    let text = new TextDecoder("utf-8").decode(bytes);
    if ((ext === "csv" || ext === "tsv") && text.trim()) {
      const sep = ext === "tsv" ? "\t" : (text.split("\n")[0].split(";").length > text.split("\n")[0].split(",").length ? ";" : ",");
      const rows = text.split(/\r?\n/).filter(Boolean).slice(0, 200).map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, "")));
      return el("div", {}, cut, el("div", { className: "fx-tablewrap" }, el("table", { className: "fx-table" }, ...rows.map((r, i) => el("tr", {}, ...r.map((c) => el(i ? "td" : "th", { textContent: c })))))));
    }
    if (ext === "json" && size <= bytes.length) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    return el("div", {}, cut, el("pre", { className: "fx-text", textContent: text }));
  }

  return {
    load: () => load(cwd),
    reset() { closeSide(); cwd = "/sdcard"; entries = []; sel.clear(); filter = ""; search.value = ""; list.replaceChildren(); },
  };
}
