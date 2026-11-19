// Andromon — files dropped on the mirrored screen. An app (.apk, .xapk, .apks, .apkm) is installed
// on the phone straight away; any other file is copied to the phone's Download folder. A bar over
// the screen shows how far it is, so the mirroring can go on meanwhile.

import { createProgress, countBytes } from "./progress.js";

const APP_FILE = /\.(apk|xapk|apks|apkm)$/i;

/**
 * ctx: { $, el, toast, showError, fmtSize, sh, shQuote, withSync, cc, isMirroring(),
 *        openPackageFiles, selectSplits, getDeviceFacts, runInstall }
 */
export function initMirrorDrop(ctx) {
  const { $, el, toast, showError, fmtSize, sh, shQuote, withSync } = ctx;
  const stage = $("mirrorStage");
  const hint = el("div", { className: "mr-drop", hidden: true }, el("b"), el("span", { className: "small" }));
  const status = el("div", { className: "mr-drop-status", hidden: true });
  stage.append(hint, status);
  let busy = false, depth = 0;

  const filesIn = (dt) => [...(dt?.items || [])].some((i) => i.kind === "file");
  function showHint(dt) {
    // While dragging, only the names' types are known, not the names: the types tell apps apart.
    const items = [...dt.items].filter((i) => i.kind === "file");
    const apps = items.length > 0 && items.every((i) => /android\.package-archive|zip/.test(i.type));
    hint.firstChild.textContent = busy ? "Still busy with the last files" : apps ? "Drop to install on the phone" : "Drop to copy to the phone";
    hint.lastChild.textContent = busy ? "Wait for it to finish, then drop again" : apps ? "Apps are installed right away" : "Files go to the phone's Download folder; apps are installed";
    hint.hidden = false;
  }
  stage.addEventListener("dragenter", (e) => { if (!ctx.isMirroring() || !filesIn(e.dataTransfer)) return; e.preventDefault(); depth++; showHint(e.dataTransfer); });
  stage.addEventListener("dragover", (e) => { if (!ctx.isMirroring() || !filesIn(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = busy ? "none" : "copy"; });
  stage.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; hint.hidden = true; } });
  stage.addEventListener("drop", (e) => {
    if (!ctx.isMirroring() || !filesIn(e.dataTransfer)) return;
    e.preventDefault(); depth = 0; hint.hidden = true;
    if (busy) return toast("Still busy with the last files");
    // Folders can't be read from a drop here; they are left out and named.
    const entries = [...e.dataTransfer.items].filter((i) => i.kind === "file").map((i) => ({ entry: i.webkitGetAsEntry?.(), file: i.getAsFile() }));
    const folders = entries.filter((x) => x.entry?.isDirectory).map((x) => x.file?.name || "a folder");
    const files = entries.filter((x) => x.file && !x.entry?.isDirectory).map((x) => x.file);
    if (folders.length) toast(`Folders can't be dropped (${folders.join(", ")}). Compress them into a zip first.`);
    if (files.length) handle(files).catch(showError);
  });

  async function handle(files) {
    busy = true;
    const bar = createProgress({ el, fmtSize });
    status.replaceChildren(bar.node); status.hidden = false;
    try {
      const apps = files.filter((f) => APP_FILE.test(f.name)), others = files.filter((f) => !APP_FILE.test(f.name));
      if (others.length) await copyToDownload(others, bar);
      // Several .apk files dropped together are taken as one app split into parts; other kinds one by one.
      const plain = apps.filter((f) => /\.apk$/i.test(f.name)), bundles = apps.filter((f) => !/\.apk$/i.test(f.name));
      for (const group of [...(plain.length ? [plain] : []), ...bundles.map((f) => [f])]) await install(group, bar);
    } finally { busy = false; status.hidden = true; status.replaceChildren(); }
  }

  async function install(files, bar) {
    bar.update(`Reading ${files.length === 1 ? files[0].name : files.length + " files"}…`);
    const pkg = await ctx.openPackageFiles(files);
    const dev = await ctx.getDeviceFacts();
    const pick = ctx.selectSplits(pkg.parts, dev.abis);
    const label = pkg.info.label || pkg.info.package || files[0].name;
    bar.reset();
    await ctx.runInstall({ pkg, pick }, (t, done, total) => bar.update(t, done, total));
    toast(`Installed ${label}`);
  }

  // A name that isn't taken yet in the folder: "photo.jpg", then "photo (2).jpg"…
  async function freeName(dir, name) {
    const dot = name.lastIndexOf("."), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? name : `${base} (${i})${ext}`;
      const out = await sh(`[ -e ${shQuote(`${dir}/${candidate}`)} ] && echo taken || echo free`);
      if (out.trim() === "free") return candidate;
    }
    throw new Error(`Too many files named ${name} in ${dir}`);
  }

  async function copyToDownload(files, bar) {
    const dir = "/sdcard/Download", total = files.reduce((n, f) => n + f.size, 0), paths = [];
    let sent = 0, n = 0;
    bar.reset();
    for (const f of files) {
      const name = await freeName(dir, f.name.replace(/[/\\]/g, "_"));
      const what = files.length > 1 ? `Copying ${f.name} to the phone (${++n} of ${files.length})` : `Copying ${f.name} to the phone`;
      bar.update(what, sent, total);
      const to = `${dir}/${name}`;
      const file = countBytes(f.stream(), (b) => { sent += b; bar.update(what, sent, total); });
      try { await withSync((s) => s.write({ filename: to, file, permission: 0o660, mtime: Math.floor(f.lastModified / 1000) })); }
      catch (e) { await sh(`rm -f -- ${shQuote(to)}`).catch(() => {}); throw e; }
      paths.push(to);
    }
    // Photos, music and videos show up in the phone's apps once its media library knows them.
    bar.update("Adding to the phone's library…");
    await ctx.cc("media.scan", { paths }).catch(() => sh(paths.map((p) => `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shQuote("file://" + p)} >/dev/null`).join("; ")).catch(() => {}));
    toast(files.length === 1 ? `Copied ${files[0].name} to the phone's Download folder` : `Copied ${files.length} files (${fmtSize(total)}) to the phone's Download folder`);
  }
}
