// Andromon — Repair › Check-in report: what the phone says about itself when it comes in, and again
// when it goes back. Both are saved to the job in hand; side by side, changes stand out (a new
// battery's health, a full storage now emptied, a phone left rooted…). Printed for the customer.

import { saveJob, statusName } from "./store.js";
import { factRows } from "./facts.js";

const TEST_NAMES = (r) => Object.entries(r || {});

export function mount(root, ctx) {
  const { el, toast, showError, fmtSize, busy } = ctx;
  let now = null; // facts read just now, not saved yet
  const body = el("div");

  async function read(btn) {
    if (!ctx.getAdb()) return toast("Connect the phone first");
    busy(btn, true, "Reading the phone…");
    try { now = await ctx.facts(); draw(); } catch (e) { showError(e); } finally { if (btn.isConnected) busy(btn, false); }
  }
  async function keep(kind) {
    const job = ctx.job();
    if (!job) return toast("Pick the job in hand first (at the top), or make one on the Jobs tab");
    if (!now) return toast("Read the phone first");
    job.reports = { ...(job.reports || {}), [kind]: { at: Date.now(), facts: now } };
    if (kind === "checkin" && !job.device?.model) job.device = { ...job.device, model: now.name || now.model, serial: now.serial, imei: now.imei || job.device?.imei || "" };
    await saveJob(job, kind === "checkin" ? "Check-in report saved" : "Check-out report saved");
    toast(`Saved as the ${kind === "checkin" ? "check-in" : "check-out"} report of ${job.number}`);
    ctx.refreshJobs(); draw();
  }

  function compare(a, b) {
    const ra = new Map(factRows(a, fmtSize)), rb = new Map(factRows(b, fmtSize));
    const keys = [...new Set([...ra.keys(), ...rb.keys()])].filter((k) => k !== "Up for");
    return el("table", { className: "rp-cmp" },
      el("thead", {}, el("tr", {}, el("th", {}), el("th", { textContent: a ? `Came in · ${new Date(a.at).toLocaleString()}` : "Came in" }), b !== undefined ? el("th", { textContent: b ? `Going back · ${new Date(b.at).toLocaleString()}` : "Going back" }) : "")),
      el("tbody", {}, ...keys.map((k) => {
        const va = ra.get(k) || "", vb = rb.get(k) || "";
        return el("tr", { className: b && a && va !== vb ? "diff" : "" }, el("th", { textContent: k }), el("td", { textContent: va || "—" }), b !== undefined ? el("td", { textContent: vb || "—" }) : "");
      })));
  }

  function draw() {
    const job = ctx.job();
    const readBtn = el("button", { className: "btn primary", type: "button", textContent: now ? "Read the phone again" : "Read the phone" });
    readBtn.onclick = () => read(readBtn);
    const inBtn = el("button", { className: "btn", type: "button", textContent: "Save as check-in report", disabled: !now || !job });
    inBtn.onclick = () => keep("checkin").catch(showError);
    const outBtn = el("button", { className: "btn", type: "button", textContent: "Save as check-out report", disabled: !now || !job });
    outBtn.onclick = () => keep("checkout").catch(showError);
    const printBtn = el("button", { className: "btn", type: "button", textContent: "Print report", disabled: !job?.reports?.checkin && !job?.reports?.checkout });
    printBtn.onclick = () => printReport(job);
    const cin = job?.reports?.checkin?.facts || null, cout = job?.reports?.checkout?.facts || null;
    const warn = [];
    const f = now || cout || cin;
    if (f?.googleAccount) warn.push("A Google account is still on this phone. If it is reset without removing the account first, it will ask for that account's password (Factory Reset Protection).");
    if (f?.rooted) warn.push("This phone shows signs of root.");
    if (f?.bootloader === "Unlocked") warn.push("The bootloader is unlocked: the phone's software can be changed and banking apps may refuse to run.");
    body.replaceChildren(
      el("div", { className: "card" },
        el("p", { className: "muted", style: "margin-top:0", textContent: job ? `Saved to ${job.number} (${job.customer?.name || "no name"} · ${statusName(job.status)}).` : "No job picked: pick the job in hand at the top to save reports to it." }),
        el("div", { className: "toolbar", style: "margin:0" }, readBtn, inBtn, outBtn, printBtn),
        ...warn.map((w) => el("div", { className: "notice", style: "margin:12px 0 0", textContent: w }))),
      now ? el("div", { className: "card" }, el("h2", { textContent: "Read just now" }), compare(now)) : "",
      cin || cout ? el("div", { className: "card" }, el("h2", { textContent: "Before and after" }), compare(cin, cout),
        el("div", { className: "muted small", style: "margin-top:8px", textContent: "Highlighted rows changed between check-in and check-out." })) : "");
  }

  function printReport(job) {
    const cin = job.reports?.checkin?.facts || null, cout = job.reports?.checkout?.facts;
    const tests = TEST_NAMES(job.tests?.results);
    ctx.printSheet(`Phone report · ${job.number}`,
      el("p", { textContent: `${job.customer?.name || ""}${job.customer?.phone ? ` · ${job.customer.phone}` : ""} · ${job.device?.model || ""}${job.device?.imei ? ` · IMEI ${job.device.imei}` : ""}` }),
      job.fault ? el("p", { textContent: `Fault reported: ${job.fault}` }) : "",
      compare(cin, cout ?? undefined),
      tests.length ? el("div", {}, el("h2", { textContent: `Hardware test · ${new Date(job.tests.at).toLocaleString()}` }),
        el("table", { className: "pr-table" }, ...tests.map(([, r]) => el("tr", {}, el("th", { textContent: r.name }), el("td", { textContent: { pass: "Works", fail: "Faulty", skip: "Not tested", na: "Not on this phone" }[r.state] || "Not tested" }), el("td", { textContent: r.note || "" }))))) : "",
      el("div", { className: "pr-sign" }, el("div", { textContent: "Technician" }), el("div", { textContent: "Customer" })));
  }

  root.append(body);
  draw();
  return { show: draw, jobChanged: draw, connected: () => { now = null; draw(); }, disconnected: () => { now = null; draw(); } };
}
