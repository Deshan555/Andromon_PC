// Developer tab › Network: port forwarding between this computer and the phone, and the phone's HTTP proxy.
//
// There's no adb server here: the page speaks ADB itself, so forwarding has two halves.
//  - PC → phone ("forward"): main.js listens on 127.0.0.1:<pc port> (preload `droidDesk.devnet`); each
//    accepted connection arrives as a MessagePort and is piped to adb.createSocket("tcp:N" | "localabstract:X").
//  - Phone → PC ("reverse"): adb.reverse.add("tcp:N", handler); each connection the phone opens is handed to
//    the handler, which asks main.js to dial 127.0.0.1:<pc port> and pipes the two together.
// The plumbing (MessagePorts <-> ADB sockets) is shared with App testing › API calls: see ./tunnel.js.
// Every string from the phone is untrusted: inserted with textContent / el() only.

import { closePort, pipe, onForwardAccept, reverseToPc } from "./tunnel.js";

const PRESETS = [
  { label: "Phone → PC 8081 · React Native Metro", dir: "reverse", pc: 8081, phone: "tcp:8081" },
  { label: "Phone → PC 3000 · web dev server", dir: "reverse", pc: 3000, phone: "tcp:3000" },
  { label: "Phone → PC 5173 · Vite", dir: "reverse", pc: 5173, phone: "tcp:5173" },
  { label: "PC 9222 → Chrome DevTools on the phone", dir: "forward", pc: 9222, phone: "localabstract:chrome_devtools_remote" },
  { label: "PC 5005 → phone 5005", dir: "forward", pc: 5005, phone: "tcp:5005" },
];
const DIR_LABEL = { forward: "PC → phone", reverse: "Phone → PC" };

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
/** "5005" | "tcp:5005" | "localabstract:name" -> canonical address, or null. */
function phoneAddr(s) {
  s = String(s || "").trim();
  if (/^\d+$/.test(s)) s = "tcp:" + s;
  let m = s.match(/^tcp:(\d+)$/);
  if (m) return validPort(Number(m[1])) ? `tcp:${Number(m[1])}` : null;
  m = s.match(/^localabstract:([\w.@:-]{1,100})$/);
  return m ? s : null;
}
const uid = () => "r" + Math.random().toString(36).slice(2, 10);

export function mount(root, ctx) {
  const { el, sh, toast, showError, busy, makeSwitch, card, store } = ctx;
  const net = ctx.net;

  // ---------------------------------------------------------------- state
  let rules = (store.get("forwards", []) || []).filter((r) => r && DIR_LABEL[r.dir] && validPort(r.pc) && phoneAddr(r.phone) && /^[\w-]{1,40}$/.test(r.id));
  const live = new Map(); // id -> { state: "on" | "off" | "error" | "starting", msg, conns, adb }
  const save = () => store.set("forwards", rules.map(({ id, dir, pc, phone }) => ({ id, dir, pc, phone })));
  const info = (id) => { if (!live.has(id)) live.set(id, { state: "off", msg: "", conns: 0, adb: null }); return live.get(id); };

  // Connections to forward rules' ports on this computer (see ./tunnel.js).
  onForwardAccept((ruleId, port) => onAccept(ruleId, port));

  async function onAccept(id, port) {
    const r = rules.find((x) => x.id === id), st = live.get(id), adb = ctx.getAdb();
    if (!r || !st || st.state !== "on" || !adb || st.adb !== adb) { closePort(port); return; }
    let socket;
    try { socket = await adb.createSocket(r.phone); }
    catch (e) {
      closePort(port);
      flash(id, `Nothing on the phone answered at ${r.phone}`);
      return;
    }
    st.conns++; render();
    pipe(port, socket, () => { st.conns = Math.max(0, st.conns - 1); render(); });
  }

  // A short-lived problem with one connection: shown on the row without turning the rule off.
  function flash(id, msg) {
    const st = info(id); st.msg = msg; render();
    clearTimeout(st.flashTimer);
    st.flashTimer = setTimeout(() => { if (st.msg === msg) { st.msg = ""; render(); } }, 8000);
  }

  async function startRule(r) {
    const adb = ctx.getAdb();
    if (!adb) throw new Error("Connect a phone first.");
    if (!net) throw new Error("Port forwarding needs the Droid Desk desktop app.");
    const st = info(r.id);
    st.state = "starting"; st.msg = ""; render();
    try {
      if (r.dir === "forward") await net.listen(r.id, r.pc);
      else {
        await reverseToPc(adb, net, Number(r.phone.slice(4)), r.pc, {
          onConn: () => { st.conns++; render(); },
          onEnd: () => { st.conns = Math.max(0, st.conns - 1); render(); },
          onError: () => flash(r.id, `Nothing on this computer answered at port ${r.pc}`),
        });
      }
      st.state = "on"; st.adb = adb;
    } catch (e) {
      st.state = "error";
      st.msg = /not ?supported/i.test(e?.name + e?.message) ? "This phone doesn't support phone → PC forwarding" : (e.message || String(e));
    }
    render();
    return st.state === "on";
  }

  async function stopRule(r, { quiet = false } = {}) {
    const st = info(r.id);
    const wasOn = st.state === "on";
    st.state = "off"; st.msg = "";
    try {
      if (r.dir === "forward") await net?.unlisten(r.id);
      else if (wasOn && st.adb && st.adb === ctx.getAdb()) await st.adb.reverse.remove(r.phone);
    } catch (e) { if (!quiet) showError(e); }
    st.adb = null;
    render();
  }

  function addRule(dir, pc, phone) {
    const a = phoneAddr(phone);
    if (!DIR_LABEL[dir]) throw new Error("Choose a direction.");
    if (!validPort(pc)) throw new Error("The computer's port must be a number from 1 to 65535.");
    if (!a) throw new Error("The phone side must be a port (1–65535) or localabstract:<name>.");
    if (dir === "reverse" && !a.startsWith("tcp:")) throw new Error("Phone → PC needs a TCP port on the phone.");
    const same = rules.find((r) => r.dir === dir && r.pc === pc && r.phone === a);
    if (same) return same;
    const clash = dir === "forward" ? rules.find((r) => r.dir === "forward" && r.pc === pc) : rules.find((r) => r.dir === "reverse" && r.phone === a);
    if (clash) throw new Error(dir === "forward" ? `Port ${pc} on this computer already has a rule.` : `${a} on the phone already has a rule.`);
    const r = { id: uid(), dir, pc, phone: a };
    rules.push(r); save(); render();
    return r;
  }

  async function removeRule(r) {
    await stopRule(r, { quiet: true });
    rules = rules.filter((x) => x !== r); live.delete(r.id); save(); render();
  }

  async function stopAll({ phoneToo = false } = {}) {
    const adb = ctx.getAdb();
    for (const r of rules) {
      const st = info(r.id);
      if (phoneToo && r.dir === "reverse" && st.state === "on" && st.adb && st.adb === adb) {
        await st.adb.reverse.remove(r.phone).catch(() => {});
      }
      st.state = "off"; st.conns = 0; st.adb = null; st.msg = "";
    }
    await net?.unlistenAll().catch(() => {});
    render();
  }

  // ---------------------------------------------------------------- UI: rules
  const restoreSw = makeSwitch(store.get("forwardsRestore", true), async (want) => { store.set("forwardsRestore", want); return want; });
  restoreSw.title = "Start these rules again whenever a phone connects";
  const tbody = el("tbody");
  const table = el("table", { className: "nw-table" },
    el("thead", {}, el("tr", {}, ...["Direction", "This computer", "Phone", "Status", "Open", ""].map((t) => el("th", { textContent: t })))),
    tbody);
  const emptyRow = () => el("tr", {}, el("td", { colSpan: 6, className: "empty", textContent: "No rules yet. Add one below or pick a preset." }));

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }
  function renderNow() {
    if (!rules.length) { tbody.replaceChildren(emptyRow()); return; }
    tbody.replaceChildren(...rules.map((r) => {
      const st = info(r.id);
      const on = st.state === "on";
      const sw = makeSwitch(on, async (want) => {
        if (want) return startRule(r);
        await stopRule(r); return false;
      });
      sw.disabled = st.state === "starting" || !ctx.getAdb();
      sw.title = on ? "Stop" : "Start";
      const rm = el("button", { type: "button", className: "btn sm", textContent: "Remove" });
      rm.onclick = () => removeRule(r).catch(showError);
      const chip = el("span", { className: "chip " + (on ? "nw-on" : st.state === "error" ? "warn" : ""), textContent: on ? "On" : st.state === "starting" ? "Starting…" : st.state === "error" ? "Didn't start" : "Off" });
      const statusCell = el("td", {}, chip);
      if (st.msg) statusCell.append(el("div", { className: "nw-msg", textContent: st.msg }));
      else if (on && r.dir === "forward") statusCell.append(el("div", { className: "nw-msg", textContent: `Connect to 127.0.0.1:${r.pc}` }));
      else if (on) statusCell.append(el("div", { className: "nw-msg", textContent: `Apps on the phone use 127.0.0.1:${r.phone.slice(4)}` }));
      return el("tr", {},
        el("td", { textContent: DIR_LABEL[r.dir] }),
        el("td", { className: "mono", textContent: `127.0.0.1:${r.pc}` }),
        el("td", { className: "mono", textContent: r.phone }),
        statusCell,
        el("td", { className: "nw-num", textContent: String(st.conns) }),
        el("td", { className: "nw-actions" }, sw, rm),
      );
    }));
  }

  // add form
  let dir = "reverse";
  const dirSeg = el("div", { className: "seg" });
  for (const d of ["reverse", "forward"]) {
    const b = el("button", { type: "button", textContent: DIR_LABEL[d] });
    b.dataset.dir = d;
    b.onclick = () => { dir = d; syncDir(); };
    dirSeg.append(b);
  }
  const pcIn = el("input", { type: "number", min: 1, max: 65535, placeholder: "8081", className: "nw-port" });
  const phoneIn = el("input", { type: "text", placeholder: "8081 or localabstract:name", className: "mono nw-phone", spellcheck: false });
  const hint = el("div", { className: "dev-note" });
  function syncDir() {
    for (const b of dirSeg.children) b.classList.toggle("on", b.dataset.dir === dir);
    hint.textContent = dir === "reverse"
      ? "Phone → PC: apps on the phone reach a server running on this computer by connecting to 127.0.0.1:<phone port> on the phone."
      : "PC → phone: programs on this computer reach something on the phone by connecting to 127.0.0.1:<computer port>.";
  }
  syncDir();
  const addBtn = el("button", { type: "submit", className: "btn sm primary", textContent: "Add & start" });
  const addForm = el("form", { className: "dev-row nw-form" },
    dirSeg,
    el("label", { className: "dev-lbl", textContent: "This computer" }), pcIn,
    el("label", { className: "dev-lbl", textContent: "Phone" }), phoneIn,
    addBtn);
  pcIn.addEventListener("input", () => { if (!phoneIn.dataset.touched && /^\d+$/.test(pcIn.value)) phoneIn.value = pcIn.value; });
  phoneIn.addEventListener("input", () => { phoneIn.dataset.touched = "1"; });
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    ctx.clearError();
    try {
      const r = addRule(dir, Number(pcIn.value), phoneIn.value || pcIn.value);
      pcIn.value = ""; phoneIn.value = ""; delete phoneIn.dataset.touched;
      if (ctx.getAdb() && info(r.id).state !== "on") await startRule(r);
    } catch (err) { showError(err); }
  });

  const presets = el("div", { className: "nw-presets" }, el("span", { className: "dev-lbl", textContent: "Presets" }),
    ...PRESETS.map((p) => {
      const b = el("button", { type: "button", className: "btn sm", textContent: p.label });
      b.onclick = async () => {
        ctx.clearError();
        try {
          const r = addRule(p.dir, p.pc, p.phone);
          if (ctx.getAdb() && info(r.id).state !== "on") { if (await startRule(r)) toast(`${DIR_LABEL[p.dir]} ${p.pc} is on`); }
        } catch (err) { showError(err); }
      };
      return b;
    }));

  const fwdCard = net
    ? card("Port forwarding", el("label", { className: "nw-restore" }, el("span", { className: "dev-lbl", textContent: "Start again when a phone connects" }), restoreSw),
      el("div", { className: "nw-scroll" }, table),
      addForm, hint, presets,
      el("p", { className: "dev-note", textContent: "Works over USB and Wi‑Fi. Only this computer's own programs (127.0.0.1) can use the ports it opens. Rules stop when the phone disconnects." }))
    : card("Port forwarding", null, el("div", { className: "empty", textContent: "Port forwarding needs the Droid Desk desktop app; a browser page can't open network ports." }));

  // ---------------------------------------------------------------- UI: proxy
  const curProxy = el("span", { className: "mono", textContent: "–" });
  const hostIn = el("input", { type: "text", placeholder: "192.168.1.20", className: "mono nw-host", spellcheck: false });
  const portIn = el("input", { type: "number", min: 1, max: 65535, placeholder: "8888", className: "nw-port" });
  const setBtn = el("button", { type: "button", className: "btn sm primary", textContent: "Set proxy" });
  const clearBtn = el("button", { type: "button", className: "btn sm", textContent: "Clear proxy" });
  const usbPortIn = el("input", { type: "number", min: 1, max: 65535, value: store.get("usbProxyPort", 0) || 8888, className: "nw-port" });
  const usbBtn = el("button", { type: "button", className: "btn sm", textContent: "Use a proxy on this computer over USB" });

  async function readProxy() {
    const v = (await sh("settings get global http_proxy")).trim();
    const none = !v || v === "null" || v === ":0";
    curProxy.textContent = none ? "None" : v;
    return none ? "" : v;
  }
  async function setProxy(host, port) {
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) && !/^\[?[0-9A-Fa-f:]{2,39}\]?$/.test(host)) throw new Error("Enter a host name or IP address.");
    if (!validPort(port)) throw new Error("The proxy port must be a number from 1 to 65535.");
    await sh(`settings put global http_proxy ${ctx.shQuote(`${host}:${port}`)}`);
    await readProxy();
  }
  setBtn.onclick = async () => {
    ctx.clearError(); busy(setBtn, true, "Setting…");
    try { await setProxy(hostIn.value.trim(), Number(portIn.value)); store.set("usbProxyPort", 0); toast("Proxy set"); }
    catch (e) { showError(e); } finally { busy(setBtn, false); }
  };
  clearBtn.onclick = async () => {
    ctx.clearError(); busy(clearBtn, true, "Clearing…");
    try { await sh("settings put global http_proxy :0"); store.set("usbProxyPort", 0); await readProxy(); toast("Proxy cleared"); }
    catch (e) { showError(e); } finally { busy(clearBtn, false); }
  };
  async function usbProxy(port) {
    if (!net) throw new Error("This needs the Droid Desk desktop app.");
    if (!validPort(port)) throw new Error("The proxy port must be a number from 1 to 65535.");
    let r = rules.find((x) => x.dir === "reverse" && x.phone === `tcp:${port}`);
    if (r && r.pc !== port) throw new Error(`tcp:${port} on the phone already goes to port ${r.pc} on this computer. Remove that rule first.`);
    if (!r) r = addRule("reverse", port, `tcp:${port}`);
    if (info(r.id).state !== "on" && !(await startRule(r))) throw new Error(info(r.id).msg || "The forwarding rule didn't start");
    await setProxy("127.0.0.1", port);
    store.set("usbProxyPort", port);
  }
  usbBtn.onclick = async () => {
    ctx.clearError(); busy(usbBtn, true, "Setting up…");
    try { await usbProxy(Number(usbPortIn.value)); toast(`Phone traffic goes to port ${usbPortIn.value} on this computer`); }
    catch (e) { showError(e); } finally { busy(usbBtn, false); }
  };

  const proxyCard = card("HTTP proxy", el("div", {}, el("span", { className: "dev-lbl", textContent: "Now" }), curProxy),
    el("div", { className: "dev-row" },
      el("label", { className: "dev-lbl", textContent: "Host" }), hostIn,
      el("label", { className: "dev-lbl", textContent: "Port" }), portIn, setBtn, clearBtn),
    net ? el("div", { className: "dev-row" }, el("label", { className: "dev-lbl", textContent: "Proxy port on this computer" }), usbPortIn, usbBtn) : "",
    el("p", { className: "dev-note", textContent: "For Charles, mitmproxy, Proxyman or Fiddler. “Over USB” forwards the phone's 127.0.0.1:<port> to this computer, so it works without Wi‑Fi. To see HTTPS, the app must trust your proxy's certificate. Clear the proxy when you're done, or the phone has no internet once it's unplugged." }),
  );

  root.append(fwdCard, proxyCard);
  renderNow();

  // ---------------------------------------------------------------- hooks
  async function onConnected() {
    for (const st of live.values()) { st.state = "off"; st.conns = 0; st.adb = null; }
    render();
    if (!ctx.getAdb()) return;
    if (net && store.get("forwardsRestore", true)) for (const r of rules) await startRule(r);
    // The proxy points at a forward that only lives while connected: bring it back so the phone has internet.
    const usbPort = store.get("usbProxyPort", 0);
    if (usbPort && net) {
      try {
        if ((await readProxy()) === `127.0.0.1:${usbPort}`) { await usbProxy(usbPort); toast(`Proxy over USB (port ${usbPort}) is on again`); }
        else store.set("usbProxyPort", 0);
      } catch (e) { showError(e); }
    }
  }

  return {
    show() { readProxy().catch(() => {}); render(); },
    connected() { onConnected().catch(showError); },
    // Clicking Disconnect: remove our phone → PC rules from the phone and close the computer's ports.
    async beforeDisconnect() {
      // A proxy that points through the cable would leave the phone without internet once unplugged.
      const usbPort = store.get("usbProxyPort", 0);
      if (usbPort) {
        store.set("usbProxyPort", 0);
        await sh(`[ "$(settings get global http_proxy)" = "127.0.0.1:${usbPort}" ] && settings put global http_proxy :0`).catch(() => {});
      }
      await stopAll({ phoneToo: true });
    },
    disconnected() { stopAll().catch(() => {}); },
  };
}
