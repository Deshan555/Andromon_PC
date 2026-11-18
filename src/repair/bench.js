// Andromon — Repair › Bench: many phones at once, for shops that refurbish in batches. Every phone
// connected (the one in use and those added in Developer › Phones) is read in one go into a table:
// model, serial, IMEI, Android, battery, storage, root, accounts. From there a job (with its
// check-in report) can be opened for each, and the table saved as a spreadsheet (CSV).

import { newJob } from "./store.js";

export function mount(root, ctx) {
  const { el, toast, showError, busy, fmtSize, download } = ctx;
  const body = el("div");
  let rows = []; // { adb, facts | error }

  async function checkAll(btn) {
    const phones = ctx.allPhones();
    if (!phones.length) return toast("Connect a phone first");
    busy(btn, true, `Reading ${phones.length} phone${phones.length === 1 ? "" : "s"}…`);
    try {
      rows = await Promise.all(phones.map(async (a) => {
        try { return { adb: a, facts: await ctx.facts(a) }; } catch (e) { return { adb: a, error: e.message || String(e) }; }
      }));
      draw();
    } finally { if (btn.isConnected) busy(btn, false); }
  }
  const cells = (f) => {
    const b = f.battery || {};
    return [f.name || f.model, f.serial, f.imei, f.android ? `${f.android} (${f.patch})` : "", b.level != null ? `${b.level}%` : "",
      b.healthPct != null ? `${b.healthPct}%` : "", b.cycles ?? "", f.storage ? `${fmtSize(f.storage.used)} / ${fmtSize(f.storage.total)}` : "",
      f.rooted ? "Yes" : "No", f.bootloader || "", f.googleAccount ? "Google account on" : f.accounts.length ? `${f.accounts.length} other` : "None"];
  };
  const HEAD = ["Phone", "Serial", "IMEI", "Android (security update)", "Charge", "Battery health", "Cycles", "Storage", "Rooted", "Bootloader", "Accounts"];

  function draw() {
    const n = ctx.allPhones().length;
    const go = el("button", { className: "btn primary", type: "button", textContent: `Check ${n === 1 ? "the phone" : `all ${n} phones`}`, disabled: !n });
    go.onclick = () => checkAll(go).catch(showError);
    const ok = rows.filter((r) => r.facts);
    const jobs = el("button", { className: "btn", type: "button", textContent: "Open a job for each", disabled: !ok.length });
    jobs.onclick = async () => {
      busy(jobs, true, "Opening jobs…");
      try {
        for (const r of ok) {
          const f = r.facts;
          await newJob({ device: { model: f.name || f.model, serial: f.serial, imei: f.imei, color: "", lockNote: "" }, reports: { checkin: { at: f.at, facts: f } },
            history: [{ at: Date.now(), text: "Job opened on the bench, with its check-in report" }] });
        }
        await ctx.refreshJobs(); toast(`${ok.length} job${ok.length === 1 ? "" : "s"} opened. See the Jobs tab.`);
      } catch (e) { showError(e); } finally { if (jobs.isConnected) busy(jobs, false); }
    };
    const csv = el("button", { className: "btn", type: "button", textContent: "Save as a spreadsheet (CSV)", disabled: !ok.length });
    csv.onclick = () => {
      const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const text = "﻿" + [HEAD, ...ok.map((r) => cells(r.facts))].map((row) => row.map(q).join(",")).join("\r\n");
      download(new Blob([text], { type: "text/csv" }), `bench-${new Date().toISOString().slice(0, 10)}.csv`);
    };
    body.replaceChildren(
      el("div", { className: "card" },
        el("p", { className: "muted", style: "margin-top:0", textContent: `${n} phone${n === 1 ? "" : "s"} connected. Connect more in Developer › Phones › Connect another phone; each is read at the same time.` }),
        el("div", { className: "toolbar", style: "margin:0" }, go, jobs, csv)),
      rows.length ? el("div", { className: "card", style: "overflow-x:auto" }, el("table", { className: "rp-cmp rp-bench" },
        el("thead", {}, el("tr", {}, ...HEAD.map((h) => el("th", { textContent: h })))),
        el("tbody", {}, ...rows.map((r) => r.facts
          ? el("tr", { className: r.facts.googleAccount || r.facts.rooted ? "diff" : "" }, ...cells(r.facts).map((c) => el("td", { textContent: String(c) })))
          : el("tr", {}, el("td", { textContent: r.adb.serial }), el("td", { colSpan: HEAD.length - 1, textContent: `Couldn't read it: ${r.error}` })))))) : "");
  }
  root.append(body);
  draw();
  return { show: draw, connected: draw, disconnected: () => { rows = []; draw(); } };
}
