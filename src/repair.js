// Andromon — Repair: tools for phone repair shops. Each tab lives in ./repair/<name>.js and is
// mounted the first time it's opened; a tab exports `mount(root, ctx)` and may return hooks
// { show(), hide(), connected(), disconnected(), jobChanged() }.
//
// Across the tabs there is one "job in hand" (picked at the top): check-in/check-out reports, test
// results and logs are saved to it. Technician mode hides the customer's personal pages (messages,
// contacts, calls, photos…) from the sidebar while a phone is in for repair.
//
// Every string from the phone is untrusted: tabs insert it with textContent / el(), never innerHTML.

import * as jobs from "./repair/jobs.js";
import * as report from "./repair/report.js";
import * as tests from "./repair/tests.js";
import * as charging from "./repair/charging.js";
import * as parts from "./repair/parts.js";
import * as transfer from "./repair/transfer.js";
import * as wipe from "./repair/wipe.js";
import * as logs from "./repair/logs.js";
import * as bench from "./repair/bench.js";
import { listJobs, getJob, statusName } from "./repair/store.js";
import { readFacts } from "./repair/facts.js";

const PARTS = [
  { id: "jobs", label: "Jobs", mod: jobs },
  { id: "report", label: "Check-in report", mod: report },
  { id: "tests", label: "Hardware test", mod: tests },
  { id: "charging", label: "Charging", mod: charging },
  { id: "parts", label: "Parts", mod: parts },
  { id: "transfer", label: "Transfer", mod: transfer },
  { id: "wipe", label: "Wipe", mod: wipe },
  { id: "logs", label: "Fault logs", mod: logs },
  { id: "bench", label: "Bench", mod: bench },
];
const TAB_KEY = "andromon.repair.tab", JOB_KEY = "andromon.repair.job";

export function initRepair(base) {
  const { $, el, makeSwitch } = base;
  const root = $("repairRoot"), tabs = $("repairTabs"), head = $("repairHead");
  const mounted = new Map();
  let currentPart = null, visible = false, job = null;

  // ---------- printing: a sheet is put in #printArea and printed alone (see the print styles) ----------
  function printSheet(title, ...kids) {
    let area = $("printArea");
    if (!area) { area = el("div", { id: "printArea" }); document.body.append(area); }
    area.replaceChildren(el("div", { className: "pr-sheet" }, el("div", { className: "pr-brand", textContent: base.shopName() || "Andromon" }), el("h1", { textContent: title }), ...kids));
    document.body.classList.add("printing");
    const done = () => { document.body.classList.remove("printing"); area.replaceChildren(); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done);
    setTimeout(() => window.print(), 50);
  }

  // ---------- the job in hand ----------
  const jobPick = el("select", { ariaLabel: "Job in hand" });
  async function refreshJobs() {
    const all = await listJobs().catch(() => []);
    const open = all.filter((j) => !["collected", "cancelled"].includes(j.status) || j.id === job?.id);
    jobPick.replaceChildren(el("option", { value: "", textContent: "No job picked" }),
      ...open.map((j) => el("option", { value: j.id, textContent: `${j.number} · ${j.customer?.name || "No name"} · ${j.device?.model || "Phone"} · ${statusName(j.status)}` })));
    jobPick.value = job?.id || "";
  }
  async function setJob(id) {
    job = id ? (await getJob(id).catch(() => null)) || null : null;
    try { localStorage.setItem(JOB_KEY, job?.id || ""); } catch {}
    await refreshJobs();
    for (const h of mounted.values()) h.jobChanged?.(job);
  }
  jobPick.onchange = () => setJob(jobPick.value);

  const privacy = makeSwitch(base.privacy.get(), (on) => base.privacy.set(on));
  // The shop's name goes at the top of every printout.
  const shop = el("input", { className: "rp-in", placeholder: "Shop name, for printouts", value: base.shopName(), style: "max-width:260px" });
  shop.onchange = () => { try { localStorage.setItem("andromon.repair.shop", shop.value.trim()); } catch {} };
  head.replaceChildren(el("div", { className: "card rp-head" },
    el("label", { className: "rp-job" }, el("span", { className: "muted small", textContent: "Job in hand" }), jobPick),
    el("label", { className: "rp-job", style: "flex:0 1 260px" }, el("span", { className: "muted small", textContent: "Shop name" }), shop),
    el("div", { className: "rp-priv" }, el("div", {}, el("b", { textContent: "Technician mode" }),
      el("div", { className: "sub", textContent: "Hides messages, contacts, calls, photos, music, files and calendar from the sidebar" })), privacy)));

  const ctx = {
    ...base,
    printSheet,
    job: () => job,
    setJob, refreshJobs,
    isShown: (id) => visible && currentPart === id,
    openTab: (id) => openPart(id),
    // What a phone says about itself (./repair/facts.js), for the main phone or any other connected one.
    facts: (a = base.getAdb()) => readFacts({ sh: (cmd) => base.track(() => a.subprocess.noneProtocol.spawnWaitText(cmd)), serial: a?.serial || "",
      ...(a === base.getAdb() ? { cc: base.cc, companionReady: base.companionReady } : {}) }),
  };

  for (const p of PARTS) {
    const b = el("button", { type: "button", textContent: p.label });
    b.dataset.part = p.id; b.onclick = () => openPart(p.id);
    tabs.append(b);
    const pane = el("div", { className: "dev-pane", hidden: true });
    pane.dataset.rp = p.id;
    root.append(pane);
  }
  function ensureMounted(id) {
    if (mounted.has(id)) return mounted.get(id);
    const pane = root.querySelector(`[data-rp="${id}"]`);
    try { mounted.set(id, PARTS.find((p) => p.id === id).mod.mount(pane, ctx) || {}); }
    catch (e) { mounted.set(id, {}); base.showError(e); }
    return mounted.get(id);
  }
  function openPart(id) {
    if (!PARTS.some((p) => p.id === id)) id = PARTS[0].id;
    if (currentPart && currentPart !== id) mounted.get(currentPart)?.hide?.();
    currentPart = id;
    try { localStorage.setItem(TAB_KEY, id); } catch {}
    for (const b of tabs.children) b.classList.toggle("on", b.dataset.part === id);
    for (const pane of root.children) pane.hidden = pane.dataset.rp !== id;
    ensureMounted(id);
    if (visible) mounted.get(id).show?.();
  }

  let ready = null;
  return {
    async load() {
      visible = true;
      ready ??= (async () => { let saved = ""; try { saved = localStorage.getItem(JOB_KEY) || ""; } catch {} await setJob(saved); })();
      await ready;
      let tab = PARTS[0].id; try { tab = localStorage.getItem(TAB_KEY) || tab; } catch {}
      openPart(currentPart || tab);
    },
    onShow(v) {
      if (v === "repair" || !visible) return;
      visible = false;
      if (currentPart) mounted.get(currentPart)?.hide?.();
    },
    onConnected() { for (const h of mounted.values()) h.connected?.(); },
    onDisconnected() { for (const h of mounted.values()) h.disconnected?.(); },
  };
}
