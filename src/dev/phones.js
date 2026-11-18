// Developer tab › Phones: keep more than one phone connected. The main phone is the one every other
// tab works with; the others stay open here and can be made the main one with one click. Commands,
// APK installs and screenshots can go to all of them at once.

export function mount(root, ctx) {
  const { el, toast, showError, clearError, shQuote } = ctx;
  const extras = []; // open Adb objects other than the main phone
  const infoCache = new WeakMap(); // Adb -> { model, android, serial }

  const all = () => [ctx.getAdb(), ...extras].filter(Boolean);
  const run = (a, cmd) => ctx.track(() => a.subprocess.noneProtocol.spawnWaitText(cmd));
  const runBytes = (a, cmd) => ctx.track(() => a.subprocess.noneProtocol.spawnWait(cmd));
  const nameOf = (a) => infoCache.get(a)?.model || a.banner?.model || a.serial;

  function watch(a) {
    const gone = () => {
      const i = extras.indexOf(a);
      if (i < 0) return;
      extras.splice(i, 1);
      toast(`${nameOf(a)} disconnected`);
      render();
    };
    a.disconnected.then(gone, gone);
  }
  function addExtra(a) {
    if (!a || extras.includes(a) || a === ctx.getAdb()) return;
    extras.push(a); watch(a);
  }

  async function info(a) {
    if (infoCache.has(a)) return infoCache.get(a);
    const out = await run(a, "getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk");
    const [maker, model, rel, sdk] = out.split("\n").map((s) => s.trim());
    const i = { model: [maker && maker !== "unknown" && !model.toLowerCase().startsWith(maker.toLowerCase()) ? maker : "", model].filter(Boolean).join(" ") || a.serial, android: `Android ${rel} (API ${sdk})`, serial: a.serial };
    infoCache.set(a, i);
    return i;
  }

  // ---------- phone list ----------
  const list = el("div", { className: "dev-phones" });
  const addBtn = el("button", { className: "btn primary sm", type: "button", textContent: "Add another phone (USB)" });
  addBtn.onclick = async () => {
    clearError();
    if (!ctx.openExtraUsbPhone) { showError("Adding phones needs the Andromon desktop app."); return; }
    ctx.busy(addBtn, true, "Connecting…");
    try {
      const a = await ctx.openExtraUsbPhone(addBtn);
      if (!a) return;
      if (!ctx.getAdb()) { await ctx.swapMainPhone(a); toast(`Connected to ${a.banner?.model || a.serial}`); }
      else { addExtra(a); toast(`Added ${a.banner?.model || a.serial}`); }
      render();
    } catch (e) {
      showError(/already|claimed|in use|busy/i.test(String(e?.message)) ? new Error("That phone is already connected, or another program is using it.") : e);
    } finally { ctx.busy(addBtn, false); }
  };

  async function render() {
    const phones = all();
    if (!phones.length) { list.replaceChildren(el("div", { className: "empty", textContent: "No phone connected." })); return; }
    const rows = await Promise.all(phones.map(async (a) => {
      let i;
      try { i = await info(a); } catch { i = { model: a.banner?.model || a.serial, android: "", serial: a.serial }; }
      const main = a === ctx.getAdb();
      const actions = el("div", { className: "dev-phone-act" });
      if (main) actions.append(el("span", { className: "chip dev-main", textContent: "In use" }));
      else {
        const use = el("button", { className: "btn sm primary", type: "button", textContent: "Use this phone" });
        use.onclick = async () => {
          ctx.busy(use, true, "Switching…");
          try {
            extras.splice(extras.indexOf(a), 1);
            const prev = await ctx.swapMainPhone(a);
            if (prev) addExtra(prev);
            render();
          } catch (e) { showError(e); ctx.busy(use, false); }
        };
        const drop = el("button", { className: "btn sm", type: "button", textContent: "Disconnect" });
        drop.onclick = async () => {
          extras.splice(extras.indexOf(a), 1);
          try { await a.close(); } catch {}
          render();
        };
        actions.append(use, drop);
      }
      const via = ctx.phoneVia?.(a) === "wifi" ? "Wi‑Fi" : "USB";
      return el("div", { className: "dev-phone" + (main ? " main" : "") },
        el("div", { className: "dev-phone-ic", ariaHidden: "true" }),
        el("div", { className: "dev-phone-txt" },
          el("div", { className: "dev-phone-name", textContent: i.model }),
          el("div", { className: "sub", textContent: [i.android, via, i.serial].filter(Boolean).join(" · ") })),
        actions);
    }));
    list.replaceChildren(...rows);
  }

  root.append(ctx.card("Connected phones", addBtn, list,
    el("p", { className: "dev-note", textContent: "Every other tab works with the phone marked “In use”. Extra phones stay connected here until you unplug them; the Disconnect button at the top only lets go of the phone in use." })));

  // ---------- run on all ----------
  const cmdIn = el("input", { type: "text", className: "mono", placeholder: "Shell command for every phone, e.g. getprop ro.build.fingerprint", spellcheck: false, autocomplete: "off" });
  const runBtn = el("button", { className: "btn primary sm", textContent: "Run on all" });
  const results = el("div", { className: "dev-results" });
  const form = el("form", { className: "toolbar" }, cmdIn, runBtn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const cmd = cmdIn.value.trim();
    if (!cmd) return;
    const phones = all();
    if (!phones.length) return;
    ctx.busy(runBtn, true, "Running…");
    const outs = phones.map((a) => {
      const pre = el("pre", { className: "out dev-out", textContent: "…" });
      return { a, pre, box: el("div", { className: "dev-result" }, el("div", { className: "dev-result-h", textContent: nameOf(a) }), pre) };
    });
    results.replaceChildren(...outs.map((o) => o.box));
    await Promise.all(outs.map(async (o) => {
      try { o.pre.textContent = (await run(o.a, cmd)) || "(no output)"; }
      catch (err) { o.pre.textContent = `error: ${err.message}`; }
    }));
    ctx.busy(runBtn, false);
  });

  // ---------- install on all ----------
  const apkIn = el("input", { type: "file", accept: ".apk", hidden: true });
  const instBtn = el("button", { className: "btn sm", type: "button", textContent: "Install APK on all…" });
  instBtn.onclick = () => apkIn.click();
  apkIn.onchange = async () => {
    const f = apkIn.files[0]; apkIn.value = "";
    if (!f) return;
    const phones = all();
    ctx.busy(instBtn, true, "Installing…");
    const outs = phones.map((a) => {
      const pre = el("pre", { className: "out dev-out", textContent: "Uploading…" });
      return { a, pre, box: el("div", { className: "dev-result" }, el("div", { className: "dev-result-h", textContent: nameOf(a) }), pre) };
    });
    results.replaceChildren(...outs.map((o) => o.box));
    await Promise.all(outs.map(async ({ a, pre }) => {
      const path = `/data/local/tmp/dd-all-${Date.now()}.apk`;
      try {
        await ctx.track(async () => {
          const sync = await a.sync();
          try { await sync.write({ filename: path, file: f.stream(), permission: 0o644 }); } finally { await sync.dispose(); }
        });
        pre.textContent = "Installing…";
        const out = (await run(a, `pm install -r -t --user 0 ${shQuote(path)} 2>&1`)).trim();
        pre.textContent = /Success/.test(out) ? `Installed ${f.name}` : `Failed: ${out}`;
        pre.classList.toggle("bad", !/Success/.test(out));
      } catch (err) { pre.textContent = `Failed: ${err.message}`; pre.classList.add("bad"); }
      finally { run(a, `rm -f ${shQuote(path)}`).catch(() => {}); }
    }));
    ctx.busy(instBtn, false);
  };

  // ---------- screenshots of all ----------
  const shotBtn = el("button", { className: "btn sm", type: "button", textContent: "Screenshot all" });
  shotBtn.onclick = async () => {
    const phones = all();
    ctx.busy(shotBtn, true, "Capturing…");
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const tiles = await Promise.all(phones.map(async (a) => {
      const box = el("div", { className: "dev-result dev-shot" }, el("div", { className: "dev-result-h", textContent: nameOf(a) }));
      try {
        const bytes = await runBytes(a, "screencap -p");
        const blob = new Blob([bytes], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        const save = el("button", { className: "btn sm", type: "button", textContent: "Save PNG" });
        save.onclick = () => ctx.download(blob, `${nameOf(a).replace(/[^\w-]+/g, "_")}-${stamp}.png`);
        box.append(el("img", { src: url, alt: `Screen of ${nameOf(a)}` }), save);
      } catch (err) { box.append(el("pre", { className: "out dev-out bad", textContent: err.message })); }
      return box;
    }));
    results.replaceChildren(el("div", { className: "dev-shots" }, ...tiles));
    ctx.busy(shotBtn, false);
  };

  root.append(ctx.card("Do it on every phone", el("div", {}, instBtn, shotBtn, apkIn), form, results,
    el("p", { className: "dev-note", textContent: "Runs on the phone in use and every extra phone at the same time." })));

  return {
    show: () => render(),
    connected: () => { if (ctx.isShown("phones")) render(); },
    disconnected: () => { if (ctx.isShown("phones")) render(); },
  };
}
