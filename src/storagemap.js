// Andromon — Storage map: what fills the phone. The top shows Android's own count by kind (apps,
// photos, videos…, from `dumpsys diskstats`); under it, the shared storage as boxes sized by how
// much each folder or file takes (a treemap). A click on a folder goes into it. The biggest files
// below the open folder are listed with a delete button.
//
// Sizes come from `du` and `find` run as the shell user, which can read all of /sdcard (also
// Android/data). Nothing is deleted without a second click.

const ROOT = "/storage/emulated/0";
const KINDS = [["App", "Apps"], ["App Data", "App data"], ["App Cache", "App caches"], ["Photos", "Photos"], ["Videos", "Videos"],
  ["Audio", "Music and audio"], ["Downloads", "Downloads"], ["System", "System"], ["Other", "Other files"]];
// Folders that apps and Android need; they can be opened but not deleted as a whole.
const KEEP = new Set(["Android", "DCIM", "Download", "Pictures", "Movies", "Music", "Documents", "Alarms", "Notifications", "Podcasts", "Ringtones", "Recordings", "Audiobooks"]);

export function initStorageMap(ctx) {
  const { $, el, sh, shQuote, fmtSize, toast, showError, armedClick, spinner } = ctx;
  const root = $("storageRoot");
  const st = { path: ROOT, cache: new Map(), gen: 0, kinds: null, df: null, big: new Map() };

  // ---------- reading the phone ----------
  async function readKinds() {
    const [stats, df] = await Promise.all([sh("dumpsys diskstats").catch(() => ""), sh("df -k /data").catch(() => "")]);
    const kinds = KINDS.map(([key, name]) => ({ name, bytes: Number(stats.match(new RegExp(`^${key} Size: (\\d+)`, "m"))?.[1] || 0) })).filter((k) => k.bytes > 0);
    const line = df.trim().split("\n").pop()?.trim().split(/\s+/) || [];
    const total = Number(line[1]) * 1024, used = Number(line[2]) * 1024, free = Number(line[3]) * 1024;
    return { kinds, df: total > 0 ? { total, used, free } : null };
  }
  // One folder's children with their sizes: [{ name, path, bytes, dir }], biggest first.
  async function readFolder(path) {
    if (st.cache.has(path)) return st.cache.get(path);
    const [du, dirs] = await Promise.all([
      sh(`du -a -k -d 1 ${shQuote(path)} 2>/dev/null`),
      sh(`find ${shQuote(path)} -mindepth 1 -maxdepth 1 -type d 2>/dev/null`),
    ]);
    const isDir = new Set(dirs.split("\n").map((l) => l.trim()).filter(Boolean));
    const items = [];
    for (const l of du.split("\n")) {
      const m = l.match(/^(\d+)\s+(.+)$/); if (!m) continue;
      const p = m[2].trim(); if (p === path || p === path + "/") continue;
      items.push({ name: p.slice(p.lastIndexOf("/") + 1), path: p, bytes: Number(m[1]) * 1024, dir: isDir.has(p) });
    }
    items.sort((a, b) => b.bytes - a.bytes);
    st.cache.set(path, items);
    return items;
  }
  // The biggest files anywhere below a folder (10 MB and up), biggest first.
  async function readBig(path) {
    if (st.big.has(path)) return st.big.get(path);
    const out = await sh(`find ${shQuote(path)} -type f -size +10240k -exec stat -c '%s|%n' {} + 2>/dev/null`).catch(() => "");
    const files = out.split("\n").map((l) => { const i = l.indexOf("|"); return i > 0 ? { bytes: Number(l.slice(0, i)), path: l.slice(i + 1) } : null; })
      .filter((f) => f && f.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 40);
    st.big.set(path, files);
    return files;
  }
  // After a delete, everything that contained it has changed size.
  function forget(path) {
    for (const k of [...st.cache.keys()]) if (path === k || path.startsWith(k + "/") || k.startsWith(path + "/")) st.cache.delete(k);
    for (const k of [...st.big.keys()]) if (path.startsWith(k + "/") || k.startsWith(path + "/") || k === path) st.big.delete(k);
  }

  // ---------- the treemap (squarified: boxes as close to squares as the sizes allow) ----------
  function squarify(items, x, y, w, h) {
    const total = items.reduce((n, it) => n + it.bytes, 0), out = [];
    if (!total || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total;
    let rest = items.map((it) => ({ it, area: it.bytes * scale }));
    while (rest.length) {
      const short = Math.min(w, h);
      let row = [], best = Infinity;
      for (const r of rest) {
        const next = [...row, r], sum = next.reduce((n, q) => n + q.area, 0);
        const max = Math.max(...next.map((q) => q.area)), min = Math.min(...next.map((q) => q.area));
        const worst = Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
        if (worst > best) break;
        row = next; best = worst;
      }
      const sum = row.reduce((n, q) => n + q.area, 0), thick = sum / short;
      let at = 0;
      for (const q of row) {
        const len = q.area / thick;
        out.push(w >= h ? { it: q.it, x, y: y + at, w: thick, h: len } : { it: q.it, x: x + at, y, w: len, h: thick });
        at += len;
      }
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
      rest = rest.slice(row.length);
    }
    return out;
  }
  const kindOf = (it) => it.dir ? "dir" : /\.(jpe?g|png|heic|webp|gif|dng)$/i.test(it.name) ? "img" : /\.(mp4|mkv|mov|3gp|webm)$/i.test(it.name) ? "vid"
    : /\.(mp3|m4a|flac|ogg|opus|wav|aac)$/i.test(it.name) ? "aud" : /\.(apk|xapk|zip|7z|rar|obb|tar|gz)$/i.test(it.name) ? "pkg" : "file";

  // ---------- the page ----------
  const crumbs = el("div", { className: "sm-crumbs" });
  const map = el("div", { className: "sm-map", role: "list" });
  const side = el("div", { className: "sm-side" });
  const top = el("div");
  root.replaceChildren(top, el("div", { className: "card" }, crumbs, map, el("div", { className: "muted small", style: "margin-top:8px", textContent: "Click a folder to open it. Boxes are sized by what each folder or file takes." })), side);
  new ResizeObserver(() => { if (st.items) drawMap(st.items); }).observe(map);

  function drawTop() {
    const { kinds, df } = st;
    const kids = [el("h2", { textContent: "What fills the phone" })];
    if (df) {
      const used = el("div", { className: "sm-total" }, el("b", { textContent: fmtSize(df.used) }), ` used of ${fmtSize(df.total)} · ${fmtSize(df.free)} free`);
      kids.push(used);
    }
    if (kinds?.length) {
      const sum = df?.total || kinds.reduce((n, k) => n + k.bytes, 0);
      const bar = el("div", { className: "sm-kinds" }, ...kinds.map((k, i) => el("span", { className: `sm-k sm-k${i}`, title: `${k.name}: ${fmtSize(k.bytes)}`, style: `width:${(k.bytes / sum) * 100}%` })));
      const legend = el("div", { className: "sm-legend" }, ...kinds.map((k, i) => el("span", {}, el("i", { className: `sm-k${i}` }), `${k.name} `, el("b", { textContent: fmtSize(k.bytes) }))));
      kids.push(bar, legend);
    } else kids.push(el("div", { className: "muted small", textContent: "This phone doesn't report its storage by kind." }));
    top.replaceChildren(el("div", { className: "card" }, ...kids));
  }

  function drawCrumbs() {
    const parts = st.path.slice(ROOT.length).split("/").filter(Boolean);
    const go = (p) => { const b = el("button", { className: "btn sm", type: "button", textContent: p === ROOT ? "Phone storage" : p.slice(p.lastIndexOf("/") + 1) }); b.onclick = () => open(p); return b; };
    const kids = [go(ROOT)];
    parts.forEach((_, i) => kids.push(el("span", { className: "muted", textContent: "›" }), go(ROOT + "/" + parts.slice(0, i + 1).join("/"))));
    const refresh = el("button", { className: "btn sm", type: "button", textContent: "Measure again", style: "margin-left:auto" });
    refresh.onclick = () => { st.cache.clear(); st.big.clear(); load(); };
    crumbs.replaceChildren(...kids, refresh);
  }

  function drawMap(items) {
    const w = map.clientWidth, h = map.clientHeight;
    // Very small items would be slivers: they are gathered in one "N smaller items" box.
    const total = items.reduce((n, it) => n + it.bytes, 0);
    let shown = items.filter((it) => it.bytes > 0 && it.bytes / total >= 0.004).slice(0, 80);
    const rest = items.filter((it) => !shown.includes(it) && it.bytes > 0);
    if (rest.length) shown = [...shown, { name: `${rest.length} smaller item${rest.length === 1 ? "" : "s"}`, bytes: rest.reduce((n, it) => n + it.bytes, 0), rest: true }];
    if (!shown.length) { map.replaceChildren(el("div", { className: "sm-empty muted", textContent: "This folder is empty." })); return; }
    map.replaceChildren(...squarify(shown, 0, 0, w, h).map(({ it, x, y, w: bw, h: bh }) => {
      const box = el(it.dir ? "button" : "div", { className: `sm-box sm-${it.rest ? "rest" : kindOf(it)}`, title: `${it.name} · ${fmtSize(it.bytes)}` });
      box.setAttribute("role", "listitem");
      box.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(0, bw - 3)}px;height:${Math.max(0, bh - 3)}px`;
      if (bw > 56 && bh > 30) box.append(el("b", { textContent: it.name }), el("span", { textContent: fmtSize(it.bytes) }));
      if (it.dir) { box.type = "button"; box.onclick = () => open(it.path); }
      return box;
    }));
  }

  function drawSide(items, big) {
    const del = (it, label) => {
      const b = el("button", { className: "btn sm danger", type: "button", textContent: "Delete" });
      if (it.dir && st.path === ROOT && KEEP.has(it.name)) { b.disabled = true; b.title = "Android and apps need this folder; open it to delete what's inside"; return b; }
      armedClick(b, async () => {
        try {
          await sh(`rm -rf -- ${shQuote(it.path)}`);
          forget(it.path); toast(`Deleted ${label} (${fmtSize(it.bytes)})`); load();
        } catch (e) { showError(e); }
      });
      return b;
    };
    const row = (it, sub) => el("div", { className: "sm-row" },
      el("div", { className: "sm-row-text" }, el("b", { textContent: it.name, title: it.path }), el("div", { className: "muted small", textContent: sub })),
      el("b", { className: "sm-size", textContent: fmtSize(it.bytes) }), del(it, it.name));
    const here = items.slice(0, 15).map((it) => row(it, it.dir ? "Folder" : "File"));
    const bigRows = big.map((f) => row({ ...f, name: f.path.slice(f.path.lastIndexOf("/") + 1) }, f.path.slice(ROOT.length + 1, f.path.lastIndexOf("/")) || "Phone storage"));
    side.replaceChildren(el("div", { className: "grid sm-lists" },
      el("div", { className: "card" }, el("h2", { textContent: "In this folder" }), ...(here.length ? here : [el("div", { className: "muted", textContent: "Nothing here." })])),
      el("div", { className: "card" }, el("h2", { textContent: "Biggest files below it" }), el("div", { className: "muted small", style: "margin-bottom:6px", textContent: "10 MB and up, in this folder and all folders inside it." }),
        ...(bigRows.length ? bigRows : [el("div", { className: "muted", textContent: "No file of 10 MB or more." })]))));
  }

  async function load() {
    const mine = ++st.gen, path = st.path;
    drawCrumbs();
    map.replaceChildren(el("div", { className: "sm-empty" }, spinner(), " Measuring…"));
    try {
      if (!st.kinds) Object.assign(st, await readKinds());
      drawTop();
      const items = await readFolder(path);
      if (mine !== st.gen) return;
      st.items = items; drawMap(items); drawSide(items, []);
      const big = await readBig(path);
      if (mine !== st.gen) return;
      drawSide(items, big);
    } catch (e) { if (mine === st.gen) { map.replaceChildren(); showError(e); } }
  }
  function open(path) { st.path = path; load(); }

  return {
    load: () => { st.kinds = null; return load(); },
    reset: () => { st.path = ROOT; st.cache.clear(); st.big.clear(); st.kinds = null; st.items = null; },
  };
}
