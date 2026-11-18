// Andromon — Repair › Jobs: one record per phone brought in. Customer, phone, fault, quote and status,
// with photos, the check-in and check-out reports and the test results attached. A job prints as a
// receipt for the customer (with a QR code holding its number) or as a small label for the phone.

import { listJobs, newJob, saveJob, deleteJob, addFile, getFile, removeFile, STATUSES, statusName } from "./store.js";
import { factRows } from "./facts.js";

const TERMS = "The shop isn't responsible for data on the phone: back it up first. Phones not collected within 90 days may be disposed of.";

export function mount(root, ctx) {
  const { el, toast, showError, armedClick, fmtSize, busy } = ctx;
  const list = el("div", { className: "rp-jobs" });
  const editor = el("div");
  const search = el("input", { type: "search", className: "rp-search", placeholder: "Search name, phone, IMEI or job number", spellcheck: false });
  const filter = el("select", {}, el("option", { value: "open", textContent: "Open jobs" }), el("option", { value: "all", textContent: "All jobs" }),
    ...STATUSES.map(([k, t]) => el("option", { value: k, textContent: t })));
  const add = el("button", { className: "btn primary", type: "button", textContent: "New job" });
  let open = null; // the job shown in the editor

  add.onclick = async () => {
    try { const j = await newJob(); await ctx.setJob(j.id); edit(j); renderList(); } catch (e) { showError(e); }
  };
  search.oninput = () => renderList();
  filter.onchange = () => renderList();

  async function renderList() {
    const q = search.value.trim().toLowerCase();
    const all = await listJobs().catch((e) => { showError(e); return []; });
    const shown = all.filter((j) => (filter.value === "all" ? true : filter.value === "open" ? !["collected", "cancelled"].includes(j.status) : j.status === filter.value))
      .filter((j) => !q || [j.number, j.customer?.name, j.customer?.phone, j.device?.imei, j.device?.serial, j.device?.model].some((v) => String(v || "").toLowerCase().includes(q)));
    list.replaceChildren(...(shown.length ? shown.map((j) => {
      const row = el("button", { className: "rp-jobrow" + (open?.id === j.id ? " on" : "") + (ctx.job()?.id === j.id ? " inhand" : ""), type: "button" },
        el("b", { textContent: j.number }), el("span", { textContent: j.customer?.name || "No name" }), el("span", { className: "muted", textContent: j.device?.model || "" }),
        el("span", { className: `chip rp-st rp-st-${j.status}`, textContent: statusName(j.status) }), el("span", { className: "muted small", textContent: new Date(j.updated).toLocaleDateString() }));
      row.onclick = () => edit(j);
      return row;
    }) : [el("div", { className: "muted", style: "padding:10px 4px", textContent: all.length ? "No job matches." : "No jobs yet. Click New job when a phone comes in." })]));
  }

  // ---------- one job ----------
  function field(label, value, onInput, { area = false, type = "text", wide = false } = {}) {
    const input = el(area ? "textarea" : "input", { className: "rp-in", value: value ?? "", ...(area ? { rows: 3 } : { type }) });
    input.oninput = () => onInput(input.value);
    return el("label", { className: "rp-field" + (wide || area ? " wide" : "") }, el("span", { className: "muted small", textContent: label }), input);
  }
  async function edit(j) {
    open = j; renderList();
    const dirty = { v: false };
    const set = (path, v) => { const [a, b] = path.split("."); if (b) j[a] = { ...(j[a] || {}), [b]: v }; else j[a] = v; dirty.v = true; save.disabled = false; };
    const status = el("select", {}, ...STATUSES.map(([k, t]) => el("option", { value: k, textContent: t }))); status.value = j.status;
    status.onchange = async () => { const was = statusName(j.status); j.status = status.value; await saveJob(j, `Status: ${was} → ${statusName(j.status)}`); toast(`${j.number}: ${statusName(j.status)}`); renderList(); ctx.refreshJobs(); edit(j); };
    const save = el("button", { className: "btn primary sm", type: "button", textContent: "Save", disabled: true });
    save.onclick = async () => { await saveJob(j, "Details changed"); save.disabled = true; dirty.v = false; toast("Saved"); renderList(); ctx.refreshJobs(); };
    const fill = el("button", { className: "btn sm", type: "button", textContent: "Fill in from the connected phone" });
    fill.onclick = async () => {
      if (!ctx.getAdb()) return toast("Connect the phone first");
      busy(fill, true, "Reading…");
      try {
        const f = await ctx.facts();
        j.device = { ...j.device, model: f.name || f.model, serial: f.serial, imei: f.imei || j.device?.imei || "" };
        await saveJob(j, "Phone details read from the phone"); edit(j); renderList(); ctx.refreshJobs();
        if (!f.imei) toast("The IMEI can't be read over adb on this phone: dial *#06# on it and type it in");
      } catch (e) { showError(e); } finally { if (fill.isConnected) busy(fill, false); }
    };
    const inHand = el("button", { className: "btn sm", type: "button", textContent: ctx.job()?.id === j.id ? "This is the job in hand" : "Make it the job in hand", disabled: ctx.job()?.id === j.id });
    inHand.onclick = async () => { await ctx.setJob(j.id); edit(j); renderList(); };
    const receipt = el("button", { className: "btn sm", type: "button", textContent: "Print receipt" });
    receipt.onclick = () => printReceipt(j);
    const label = el("button", { className: "btn sm", type: "button", textContent: "Print label" });
    label.onclick = () => ctx.printSheet(j.number, el("div", { className: "pr-label" }, ctx.qrImage(`andromon-job:${j.number}`),
      el("div", {}, el("b", { textContent: j.number }), el("div", { textContent: j.customer?.name || "" }), el("div", { textContent: j.device?.model || "" }), el("div", { textContent: j.fault?.slice(0, 80) || "" }))));
    const del = el("button", { className: "btn sm danger", type: "button", textContent: "Delete job" });
    armedClick(del, async () => { await deleteJob(j); if (ctx.job()?.id === j.id) await ctx.setJob(""); open = null; editor.replaceChildren(); renderList(); toast(`${j.number} deleted`); });

    // Photos and other files: the phone's state when it came in, damage, the receipt signed…
    const files = el("div", { className: "rp-files" });
    const pick = el("input", { type: "file", accept: "image/*,application/pdf,.txt,.zip", multiple: true, hidden: true });
    pick.onchange = async () => { for (const f of pick.files) await addFile(j, f, f.name, f.type.startsWith("image/") ? "photo" : "file").catch(showError); pick.value = ""; drawFiles(); };
    const addPhotos = el("button", { className: "btn sm", type: "button", textContent: "Add photos or files…" });
    addPhotos.onclick = () => pick.click();
    async function drawFiles() {
      const items = (await Promise.all((j.files || []).map((id) => getFile(id).catch(() => null)))).filter(Boolean);
      files.replaceChildren(...items.map((f) => {
        const url = URL.createObjectURL(f.blob);
        const open = el("a", { href: url, download: f.name, className: "rp-file", title: `${f.name} · ${fmtSize(f.size)}` },
          f.type.startsWith("image/") ? el("img", { src: url, alt: f.name }) : el("span", { textContent: f.name }));
        const x = el("button", { className: "rp-file-x", type: "button", textContent: "×", title: "Remove", ariaLabel: `Remove ${f.name}` });
        armedClick(x, async () => { await removeFile(j, f.id); URL.revokeObjectURL(url); drawFiles(); });
        return el("div", { className: "rp-file-wrap" }, open, x);
      }), addPhotos, pick);
    }
    drawFiles();

    const reports = el("div", { className: "muted small" }, ...["checkin", "checkout"].map((k) => el("div", { textContent: j.reports?.[k] ? `${k === "checkin" ? "Check-in" : "Check-out"} report: ${new Date(j.reports[k].at).toLocaleString()}` : `No ${k === "checkin" ? "check-in" : "check-out"} report yet` })),
      el("div", { textContent: j.tests ? `Hardware test: ${new Date(j.tests.at).toLocaleString()} · ${Object.values(j.tests.results || {}).filter((r) => r.state === "pass").length} passed, ${Object.values(j.tests.results || {}).filter((r) => r.state === "fail").length} failed` : "No hardware test yet" }));
    const toReport = el("button", { className: "btn sm", type: "button", textContent: "Open the reports" });
    toReport.onclick = async () => { await ctx.setJob(j.id); ctx.openTab("report"); };

    editor.replaceChildren(el("div", { className: "card rp-editor" },
      el("div", { className: "toolbar", style: "align-items:center;margin:0 0 12px" }, el("h2", { style: "margin:0;flex:1", textContent: `${j.number} · opened ${new Date(j.created).toLocaleDateString()}` }), status),
      el("div", { className: "rp-form" },
        field("Customer", j.customer?.name, (v) => set("customer.name", v)), field("Phone number", j.customer?.phone, (v) => set("customer.phone", v), { type: "tel" }),
        field("Email", j.customer?.email, (v) => set("customer.email", v), { type: "email" }),
        field("Phone (model)", j.device?.model, (v) => set("device.model", v)), field("Serial number", j.device?.serial, (v) => set("device.serial", v)),
        field("IMEI", j.device?.imei, (v) => set("device.imei", v)), field("Colour", j.device?.color, (v) => set("device.color", v)),
        field("Screen lock (how to unlock, if the customer left it)", j.device?.lockNote, (v) => set("device.lockNote", v)),
        field("Fault, as the customer describes it", j.fault, (v) => set("fault", v), { area: true }),
        field("Quote", j.quote, (v) => set("quote", v)), field("Deposit paid", j.deposit, (v) => set("deposit", v)),
        field("Notes (not printed)", j.notes, (v) => set("notes", v), { area: true })),
      el("div", { className: "toolbar", style: "margin:12px 0 0" }, save, fill, inHand, receipt, label, del),
      el("h3", { style: "margin:18px 0 6px", textContent: "Photos and files" }), files,
      el("h3", { style: "margin:18px 0 6px", textContent: "Reports and tests" }), reports, el("div", { style: "margin-top:8px" }, toReport),
      el("details", { style: "margin-top:14px" }, el("summary", { textContent: `History (${(j.history || []).length})` }),
        el("div", { className: "muted small rp-hist" }, ...[...(j.history || [])].reverse().map((h) => el("div", { textContent: `${new Date(h.at).toLocaleString()} · ${h.text}` }))))));
  }

  function printReceipt(j) {
    const row = (k, v) => (v ? el("tr", {}, el("th", { textContent: k }), el("td", { textContent: v })) : "");
    const checkin = j.reports?.checkin?.facts;
    ctx.printSheet(`Repair receipt ${j.number}`,
      el("div", { className: "pr-cols" },
        el("table", { className: "pr-table" },
          row("Date", new Date(j.created).toLocaleString()), row("Customer", j.customer?.name), row("Phone number", j.customer?.phone), row("Email", j.customer?.email),
          row("Phone", j.device?.model), row("Serial number", j.device?.serial), row("IMEI", j.device?.imei), row("Colour", j.device?.color),
          row("Fault", j.fault), row("Quote", j.quote), row("Deposit paid", j.deposit), row("Status", statusName(j.status))),
        el("div", { className: "pr-qr" }, ctx.qrImage(`andromon-job:${j.number}`), el("div", { className: "small", textContent: j.number }))),
      checkin ? el("div", {}, el("h2", { textContent: "Condition when it came in" }),
        el("table", { className: "pr-table" }, ...factRows(checkin, fmtSize).filter(([k]) => ["Battery", "Storage", "Rooted", "Bootloader"].includes(k)).map(([k, v]) => row(k, v)))) : "",
      el("p", { className: "pr-terms", textContent: TERMS }),
      el("div", { className: "pr-sign" }, el("div", { textContent: "Customer's signature" }), el("div", { textContent: "Shop's signature" })));
  }

  root.replaceChildren(el("div", { className: "card" }, el("div", { className: "toolbar", style: "margin:0 0 10px;align-items:center" }, add, search, filter), list), editor);
  renderList();
  return {
    show: () => { renderList(); if (open) getJobFresh(); },
    jobChanged: () => renderList(),
  };
  async function getJobFresh() { const all = await listJobs().catch(() => []); const j = all.find((x) => x.id === open?.id); if (j) edit(j); }
}
