// Andromon — Repair › Wipe: before a phone is sold on or recycled, check that nothing still ties it
// to its owner, reset it, and print a certificate that it was wiped.
//
// The reset itself is done by the phone (Settings › Reset, or recovery): adb isn't allowed to start
// it, and the phone's own reset is the right one anyway. On today's phones storage is encrypted with
// a key the reset destroys, so the data can't be read back afterwards.
// A Google account left on the phone turns on Factory Reset Protection: after the reset the phone
// asks for that account's password. This tab says so before the reset, and never works around it.

import { saveJob } from "./store.js";
import { maskAccount } from "./facts.js";

const OWNER_TYPES = { "com.google": "Google", "com.osp.app.signin": "Samsung", "com.xiaomi": "Xiaomi", "com.huawei.hwid": "Huawei", "com.oplus.account": "OPPO / realme / OnePlus", "com.oppo.usercenter": "OPPO" };

export function mount(root, ctx) {
  const { el, sh, toast, showError, busy, armedClick } = ctx;
  let facts = null, lock = "";
  const body = el("div");

  async function check(btn) {
    if (!ctx.getAdb()) return toast("Connect the phone first");
    busy(btn, true, "Checking…");
    try {
      facts = await ctx.facts();
      lock = (await sh("locksettings get-disabled 2>/dev/null").catch(() => "")).trim();
      draw();
    } catch (e) { showError(e); } finally { if (btn.isConnected) busy(btn, false); }
  }

  function draw() {
    const job = ctx.job();
    const checkBtn = el("button", { className: "btn primary", type: "button", textContent: facts ? "Check again" : "Check the phone" });
    checkBtn.onclick = () => check(checkBtn);
    const owners = (facts?.accounts || []).filter((a) => OWNER_TYPES[a.type]);
    const steps = [];
    if (facts) {
      steps.push(el("div", { className: owners.length ? "notice" : "rp-ok" }, owners.length
        ? `Still signed in: ${owners.map((a) => `${OWNER_TYPES[a.type]} (${maskAccount(a.name)})`).join(", ")}. Ask the owner to remove ${owners.length === 1 ? "it" : "them"} on the phone (Settings › Accounts) before the reset. Otherwise the phone will ask for the account's password after the reset, and only the owner can give it.`
        : "No Google, Samsung or other maker account is signed in. The phone won't be locked to anyone after the reset."));
      if (facts.accounts.length > owners.length) steps.push(el("div", { className: "muted small", textContent: `Other accounts on the phone (app accounts, removed by the reset): ${facts.accounts.length - owners.length}.` }));
      steps.push(el("div", { className: "muted small", textContent: `${facts.encrypted ? "Storage is encrypted: the reset destroys its key, so the old data can't be read back." : "The phone didn't report encryption. Its reset still erases the data, but recovery tools might find traces."}${lock === "true" ? " The phone has no screen lock." : ""}` }));
    }
    const openAcc = el("button", { className: "btn sm", type: "button", textContent: "Open accounts on the phone", disabled: !ctx.getAdb() });
    openAcc.onclick = () => sh("am start -a android.settings.SYNC_SETTINGS").catch(showError);
    const openReset = el("button", { className: "btn sm", type: "button", textContent: "Open Settings on the phone", disabled: !ctx.getAdb() });
    openReset.onclick = () => sh("am start -a android.settings.SETTINGS").then(() => toast("On the phone: System (or General management) › Reset › Erase all data / Factory data reset"), showError);
    const recovery = el("button", { className: "btn sm danger", type: "button", textContent: "Restart into recovery", disabled: !ctx.getAdb() });
    armedClick(recovery, () => sh("reboot recovery").then(() => toast("Restarting into recovery. Choose “Wipe data / factory reset” with the volume and power buttons."), showError));

    // The certificate: filled in once the reset is done.
    const tech = el("input", { className: "rp-in", placeholder: "Technician's name", value: localStorage.getItem("andromon.repair.tech") || "" });
    tech.onchange = () => { try { localStorage.setItem("andromon.repair.tech", tech.value); } catch {} };
    const method = el("select", {}, el("option", { value: "settings", textContent: "The phone's own reset (Settings)" }), el("option", { value: "recovery", textContent: "Wipe data in recovery" }));
    const seen = el("input", { type: "checkbox" });
    const print = el("button", { className: "btn", type: "button", textContent: "Print the certificate" });
    print.onclick = async () => {
      if (!facts) return toast("Check the phone before the reset, so its details are on the certificate");
      if (!seen.checked) return toast("Tick that the phone showed its welcome screen after the reset");
      const row = (k, v) => el("tr", {}, el("th", { textContent: k }), el("td", { textContent: v || "—" }));
      const when = new Date();
      if (job) { job.wipe = { at: when.getTime(), method: method.value, technician: tech.value, model: facts.name, serial: facts.serial, imei: facts.imei }; await saveJob(job, "Wiped; certificate printed").catch(() => {}); }
      ctx.printSheet("Certificate of data erasure",
        el("table", { className: "pr-table" },
          row("Phone", facts.name), row("Serial number", facts.serial), row("IMEI", facts.imei), row("Android", facts.android ? `${facts.android} (security update ${facts.patch})` : ""),
          row("Storage", facts.encrypted ? "Encrypted; key destroyed by the reset" : "Erased by the reset"),
          row("Owner accounts at the check", owners.length ? `${owners.length} (${owners.map((a) => OWNER_TYPES[a.type]).join(", ")})` : "None"),
          row("Method", method.value === "recovery" ? "Wipe data / factory reset in recovery" : "Factory data reset from the phone's settings"),
          row("Checked", "The phone restarted to its welcome (setup) screen"),
          row("Date", when.toLocaleString()), row("Technician", tech.value), job ? row("Job", job.number) : ""),
        el("p", { className: "pr-terms", textContent: "All user data, accounts and settings were erased by the phone's factory reset. This certificate records the check made before the reset and the result seen after it." }),
        el("div", { className: "pr-sign" }, el("div", { textContent: "Technician" }), el("div", { textContent: "Customer" })));
    };
    body.replaceChildren(
      el("div", { className: "card" }, el("h2", { textContent: "1. Before the reset" }),
        el("p", { className: "muted", style: "margin-top:0", textContent: "Check what still ties the phone to its owner. Make sure the owner has a backup: the reset can't be undone." }),
        el("div", { className: "toolbar", style: "margin:0 0 10px" }, checkBtn, openAcc), ...steps),
      el("div", { className: "card" }, el("h2", { textContent: "2. Reset" }),
        el("p", { className: "muted", style: "margin-top:0", textContent: "Start the reset on the phone. If it doesn't start normally, restart it into recovery and wipe there. The connection ends when the phone resets." }),
        el("div", { className: "toolbar", style: "margin:0" }, openReset, recovery)),
      el("div", { className: "card" }, el("h2", { textContent: "3. Certificate" }),
        el("div", { className: "rp-form" }, el("label", { className: "rp-field" }, el("span", { className: "muted small", textContent: "Technician" }), tech),
          el("label", { className: "rp-field" }, el("span", { className: "muted small", textContent: "How it was wiped" }), method)),
        el("label", { className: "bk-part", style: "margin-top:10px" }, seen, el("span", {}, el("b", { textContent: "The phone showed its welcome (setup) screen after the reset" }))),
        el("div", { className: "toolbar", style: "margin:12px 0 0" }, print)));
  }
  root.append(body);
  draw();
  return { show: draw, jobChanged: draw, connected: () => { facts = null; draw(); } };
}
