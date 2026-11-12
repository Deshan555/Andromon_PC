// App testing › API calls: see the HTTP(S) requests apps on the phone make, like Charles or mitmproxy.
//
// Capture = the proxy in main.js (inspector.js) on 127.0.0.1:<port>, an `adb reverse` so the phone's
// 127.0.0.1:<port> reaches it (./../dev/tunnel.js), and the phone's global HTTP proxy pointed there.
// Stopping, disconnecting or the next connection after a pulled cable always clears the phone's proxy,
// so the phone never stays without internet.
//
// Everything from the phone or the network is untrusted: it's only inserted with textContent / el().

import { reverseToPc } from "../dev/tunnel.js";

const DEFAULT_PORT = 8899;
const NSC_XML = `<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <!-- Only used when the app is debuggable (debug builds). -->
    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>

<!-- AndroidManifest.xml -->
<application
    android:networkSecurityConfig="@xml/network_security_config"
    ... >`;
const STATIC_TYPE = /^(image\/|font\/|video\/|audio\/|text\/css|(text|application)\/(x-)?javascript|application\/(font|wasm))/;
const validPort = (p) => Number.isInteger(p) && p > 1023 && p < 65536;
const pad = (n) => String(n).padStart(2, "0");
const clock = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const shortType = (t) => {
  if (!t) return "";
  if (/json/.test(t)) return "json";
  if (/xml/.test(t)) return "xml";
  if (/html/.test(t)) return "html";
  if (/x-www-form-urlencoded/.test(t)) return "form";
  if (/protobuf|grpc/.test(t)) return "protobuf";
  if (/^image\//.test(t)) return t.slice(6).replace(/^svg\+xml$/, "svg");
  if (/javascript/.test(t)) return "js";
  if (/css/.test(t)) return "css";
  if (/^text\//.test(t)) return t.slice(5);
  if (/octet-stream/.test(t)) return "binary";
  return t.replace(/^application\//, "");
};
const b64bytes = (b64) => { const s = atob(b64 || ""); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const utf8OrNull = (bytes) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; } };
const sq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
const hdr = (pairs, name) => { name = name.toLowerCase(); const h = (pairs || []).find(([k]) => k.toLowerCase() === name); return h ? h[1] : ""; };

export function mount(root, ctx) {
  const { el, sh, toast, showError, clearError, busy, makeSwitch, fmtSize, store, card } = ctx;
  const insp = globalThis.droidDesk?.inspector || null;
  const net = ctx.net;

  if (!insp || !net) {
    root.append(card("API calls", null, el("div", { className: "empty", textContent: "Seeing the phone's API calls needs the Droid Desk desktop app." })));
    return {};
  }

  // ---------------------------------------------------------------- state
  const entries = new Map(); // id -> summary
  const rows = new Map(); // id -> { tr, cells }
  let running = false, capturePort = 0, captureAdb = null, selected = 0, paused = false;
  let filterText = "", onlyApi = store.get("trafficOnlyApi", true);

  // ---------------------------------------------------------------- capture on/off
  const portIn = el("input", { type: "number", min: 1024, max: 65535, value: store.get("trafficPort", DEFAULT_PORT), className: "tr-port", title: "Port of the proxy on this computer (the phone uses the same port)" });
  const decryptSw = makeSwitch(store.get("trafficDecrypt", false), async (want) => {
    store.set("trafficDecrypt", want);
    if (running) await insp.start({ port: capturePort, decrypt: want });
    renderHttps();
    return want;
  });
  const startBtn = el("button", { type: "button", className: "btn primary sm", textContent: "Start capture" });
  const stateChip = el("span", { className: "chip" });

  async function start() {
    const adb = ctx.getAdb();
    if (!adb) throw new Error("Connect a phone first.");
    const port = Number(portIn.value);
    if (!validPort(port)) throw new Error("Choose a proxy port from 1024 to 65535.");
    await insp.start({ port, decrypt: store.get("trafficDecrypt", false) });
    try {
      await reverseToPc(adb, net, port, port, {});
      await sh(`settings put global http_proxy 127.0.0.1:${port}`);
    } catch (e) {
      await adb.reverse.remove(`tcp:${port}`).catch(() => {});
      await insp.stop().catch(() => {});
      throw /not ?supported/i.test(e?.name + e?.message) ? new Error("This phone doesn't support phone → PC forwarding, which capture needs.") : e;
    }
    running = true; capturePort = port; captureAdb = adb;
    store.set("trafficPort", port); store.set("trafficOn", port);
    renderState();
  }

  // phoneToo: the phone can still be reached, so give it its internet back.
  async function stop({ phoneToo = true } = {}) {
    const port = capturePort || store.get("trafficOn", 0);
    const adb = captureAdb;
    running = false; capturePort = 0; captureAdb = null;
    // Without the phone, "trafficOn" stays set and connected() clears the proxy next time.
    if (phoneToo && port && ctx.getAdb()) {
      await sh(`[ "$(settings get global http_proxy)" = "127.0.0.1:${port}" ] && settings put global http_proxy :0; true`).catch(() => {});
      if (adb && adb === ctx.getAdb()) await adb.reverse.remove(`tcp:${port}`).catch(() => {});
      store.set("trafficOn", 0);
    }
    await insp.stop().catch(() => {});
    renderState();
  }

  startBtn.onclick = async () => {
    clearError();
    busy(startBtn, true, running ? "Stopping…" : "Starting…");
    try {
      if (running) { await stop(); toast("Capture stopped. The phone uses no proxy now."); }
      else { await start(); toast("Capturing. Use the app on the phone."); }
    } catch (e) { showError(e); } finally { busy(startBtn, false); renderState(); }
  };

  function renderState() {
    startBtn.textContent = running ? "Stop capture" : "Start capture";
    startBtn.classList.toggle("primary", !running);
    stateChip.textContent = running ? `Capturing · proxy 127.0.0.1:${capturePort}` : "Not capturing";
    stateChip.className = "chip " + (running ? "tr-live" : "");
    portIn.disabled = running;
    startBtn.disabled = !ctx.getAdb() && !running;
  }

  // ---------------------------------------------------------------- list
  const filterIn = el("input", { type: "search", placeholder: "Filter: text, host:api.example.com, status:4xx, method:post, type:json", spellcheck: false });
  filterIn.addEventListener("input", () => { filterText = filterIn.value.trim(); applyFilter(); });
  const apiSw = makeSwitch(onlyApi, async (want) => { onlyApi = want; store.set("trafficOnlyApi", want); applyFilter(); return want; });
  const pauseBtn = el("button", { type: "button", className: "btn sm", textContent: "Pause view" });
  pauseBtn.onclick = () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume view" : "Pause view";
    if (!paused) { for (const s of entries.values()) upsertRow(s); applyFilter(); }
  };
  const clearBtn = el("button", { type: "button", className: "btn sm", textContent: "Clear" });
  clearBtn.onclick = () => insp.clear().catch(showError);
  const harBtn = el("button", { type: "button", className: "btn sm", textContent: "Export HAR" });
  harBtn.title = "Save the calls shown (after filtering) as a HAR file, which browsers' DevTools, Charles and Postman can open";
  harBtn.onclick = () => exportHar().catch(showError);
  const countLbl = el("span", { className: "dev-lbl" });

  const tbody = el("tbody");
  const table = el("table", { className: "tr-table" },
    el("thead", {}, el("tr", {}, ...["Time", "Method", "Status", "Host", "Path", "Type", "Size", "ms"].map((t) => el("th", { textContent: t })))),
    tbody);
  const listBox = el("div", { className: "tr-list" }, table);
  const emptyBox = el("div", { className: "empty tr-empty" });
  const detail = el("div", { className: "tr-detail" }, el("div", { className: "empty", textContent: "Click a call to see its headers and body." }));

  function statusClass(s) {
    if (s.error) return "err";
    if (!s.done && !s.status) return "wait";
    const c = Math.floor(s.status / 100);
    return c >= 2 && c <= 5 ? `s${c}xx` : "";
  }
  function statusText(s) {
    if (s.kind === "tls-error") return "Refused";
    if (s.error) return "Failed";
    if (s.kind === "tunnel") return s.done ? "Tunnel" : "Open";
    if (!s.status) return "…";
    return String(s.status);
  }
  function upsertRow(s) {
    let r = rows.get(s.id);
    if (!r) {
      const cells = Array.from({ length: 8 }, () => el("td"));
      const tr = el("tr", {}, ...cells);
      tr.onclick = () => select(s.id);
      r = { tr, cells };
      rows.set(s.id, r);
      const atBottom = listBox.scrollTop + listBox.clientHeight >= listBox.scrollHeight - 30;
      tbody.append(tr);
      if (atBottom) requestAnimationFrame(() => { listBox.scrollTop = listBox.scrollHeight; });
    }
    const [t, m, st, host, p, ty, sz, du] = r.cells;
    t.textContent = clock(s.time);
    m.textContent = s.kind === "ws" ? "WS" : s.method;
    st.replaceChildren(el("span", { className: "tr-st " + statusClass(s), textContent: statusText(s) }));
    host.textContent = s.host + (s.port && s.port !== 443 && s.port !== 80 ? `:${s.port}` : "");
    p.textContent = s.kind === "tunnel" ? (s.done ? "(encrypted)" : "(encrypted, open)") : s.kind === "tls-error" ? "(certificate refused)" : s.path;
    p.title = s.error || s.path || "";
    ty.textContent = s.kind === "ws" ? "websocket" : shortType(s.type);
    sz.textContent = s.resSize ? fmtSize(s.resSize) : "";
    du.textContent = s.duration != null ? String(s.duration) : "";
    r.tr.classList.toggle("sel", s.id === selected);
    r.tr.classList.toggle("tr-plain", s.scheme === "http" || s.scheme === "ws");
    r.tr.hidden = !matches(s);
  }

  function matches(s) {
    if (onlyApi && STATIC_TYPE.test(s.type || "")) return false;
    if (!filterText) return true;
    for (const tok of filterText.toLowerCase().split(/\s+/)) {
      const m = tok.match(/^(host|status|method|type|path):(.+)$/);
      if (m) {
        const [, k, v] = m;
        if (k === "host" && !s.host.toLowerCase().includes(v)) return false;
        if (k === "method" && s.method.toLowerCase() !== v) return false;
        if (k === "type" && !(shortType(s.type) + " " + (s.type || "")).includes(v)) return false;
        if (k === "path" && !String(s.path || "").toLowerCase().includes(v)) return false;
        if (k === "status") {
          const code = String(s.status || "");
          if (/^\dxx$/.test(v) ? code[0] !== v[0] : v === "error" || v === "failed" ? !s.error : code !== v) return false;
        }
      } else if (!`${s.method} ${s.host} ${s.path} ${s.status}`.toLowerCase().includes(tok)) return false;
    }
    return true;
  }
  function applyFilter() {
    let shown = 0;
    for (const [id, r] of rows) { const s = entries.get(id); r.tr.hidden = !s || !matches(s); if (!r.tr.hidden) shown++; }
    countLbl.textContent = entries.size ? `${shown} of ${entries.size} calls` : "";
    emptyBox.hidden = shown > 0;
    emptyBox.textContent = entries.size
      ? "No calls match the filter."
      : running ? "Waiting for the phone… Use the app now." : "Click Start capture, then use the app on the phone.";
  }
  let filterQueued = false;
  const queueFilterCount = () => { if (filterQueued) return; filterQueued = true; requestAnimationFrame(() => { filterQueued = false; applyFilter(); }); };

  insp.onEvent((ev) => {
    if (ev.type === "cleared") {
      entries.clear(); rows.clear(); tbody.replaceChildren(); selected = 0;
      detail.replaceChildren(el("div", { className: "empty", textContent: "Click a call to see its headers and body." }));
      applyFilter();
      return;
    }
    if (ev.type !== "entries") return;
    for (const s of ev.items) {
      entries.set(s.id, s);
      if (!paused) upsertRow(s);
      if (s.id === selected && s.done && !detail.dataset.done) showDetail(s.id);
    }
    // The main process keeps the last 2000; drop rows it has forgotten.
    if (entries.size > 2000) {
      const extra = [...entries.keys()].slice(0, entries.size - 2000);
      for (const id of extra) { entries.delete(id); rows.get(id)?.tr.remove(); rows.delete(id); }
    }
    queueFilterCount();
  });

  // ---------------------------------------------------------------- detail
  async function select(id) {
    selected = id;
    for (const [rid, r] of rows) r.tr.classList.toggle("sel", rid === id);
    await showDetail(id);
  }

  let detailUrls = [];
  async function showDetail(id) {
    const e = await insp.get(id).catch(() => null);
    if (selected !== id) return;
    for (const u of detailUrls) URL.revokeObjectURL(u);
    detailUrls = [];
    if (!e) { detail.replaceChildren(el("div", { className: "empty", textContent: "This call is no longer kept." })); return; }
    detail.dataset.done = e.done ? "1" : "";
    const parts = [];
    const actions = el("div", { className: "tr-actions" });
    if (e.kind === "http") {
      const curlBtn = el("button", { type: "button", className: "btn sm", textContent: "Copy as cURL" });
      curlBtn.onclick = () => copy(toCurl(e), "cURL command copied");
      const urlBtn = el("button", { type: "button", className: "btn sm", textContent: "Copy URL" });
      urlBtn.onclick = () => copy(e.url, "URL copied");
      const apiBtn = el("button", { type: "button", className: "btn sm primary", textContent: "Open in API tester" });
      apiBtn.onclick = () => openInApiTester(e);
      actions.append(apiBtn, curlBtn, urlBtn);
      if (e.resBody?.size) {
        const save = el("button", { type: "button", className: "btn sm", textContent: "Save response body" });
        save.onclick = () => {
          const bytes = b64bytes(e.resBody.base64);
          const name = (e.path.split("?")[0].split("/").filter(Boolean).pop() || e.host).replace(/[^\w.-]+/g, "_").slice(0, 80) || "body";
          ctx.download(new Blob([bytes], { type: e.type || "application/octet-stream" }), name);
        };
        actions.append(save);
      }
    }
    const title = e.kind === "tunnel" ? `CONNECT ${e.host}:${e.port}` : e.kind === "tls-error" ? `${e.host}:${e.port}` : `${e.method} ${e.url}`;
    parts.push(el("div", { className: "tr-title mono", textContent: title }), actions);

    // general
    const kv = el("div", { className: "dev-kv" });
    const add = (k, v) => { if (v !== "" && v != null) kv.append(el("span", { textContent: k }), el("span", { textContent: String(v) })); };
    add("Status", e.error ? `Failed: ${e.error}` : e.status ? `${e.status} ${e.statusText}` : e.done ? "" : "Waiting…");
    if (e.kind === "tunnel") add("Note", store.get("trafficDecrypt", false) ? "Opened before decryption was on, or tunnelled as is." : "HTTPS is passed through encrypted. Turn on “Decrypt HTTPS” to see inside.");
    add("Started", new Date(e.timing.start).toLocaleTimeString());
    if (e.timing.end) {
      const t = e.timing, conn = t.connected ? t.connected - t.start : null, wait = t.firstByte ? t.firstByte - (t.connected || t.start) : null, dl = t.firstByte ? t.end - t.firstByte : null;
      add("Time", `${t.end - t.start} ms` + (wait != null ? ` (connect ${conn ?? 0} ms · waiting ${wait} ms · download ${dl} ms)` : ""));
    }
    if (e.kind === "tunnel" || e.kind === "ws") add("Bytes", `${fmtSize(e.bytesUp)} sent · ${fmtSize(e.bytesDown)} received`);
    else {
      if (e.reqBody?.size) add("Request size", fmtSize(e.reqBody.size));
      if (e.resBody) add("Response size", fmtSize(e.resBody.size) + (e.resBody.encoding ? ` (${e.resBody.encoding}, ${fmtSize(e.resBody.decodedSize)} unpacked)` : ""));
    }
    if (e.httpVersion) add("Phone used", `HTTP/${e.httpVersion}${e.decrypted ? " inside TLS (decrypted)" : e.scheme === "http" ? " (plain, not encrypted)" : ""}`);
    if (e.tls?.server) add("Server TLS", `${e.tls.server.protocol} · ${e.tls.server.cipher} · certificate for ${e.tls.server.subject} by ${e.tls.server.issuer}, valid to ${e.tls.server.validTo}`);
    if (e.tls?.client) add("Phone TLS", `${e.tls.client.protocol} · ${e.tls.client.cipher}${e.tls.client.sni ? ` · asked for ${e.tls.client.sni}` : ""}`);
    parts.push(section("Overview", kv, true));

    if (e.kind === "http" || e.kind === "ws") {
      if (e.url.includes("?")) {
        try {
          const qs = [...new URL(e.url).searchParams];
          if (qs.length) parts.push(section(`Query (${qs.length})`, headerTable(qs), true));
        } catch {}
      }
      parts.push(section(`Request headers (${e.reqHeaders.length})`, headerTable(e.reqHeaders), false));
      if (e.reqBody?.size) parts.push(section(`Request body · ${fmtSize(e.reqBody.size)}`, bodyView(e.reqBody, hdr(e.reqHeaders, "content-type")), true));
      if (e.resHeaders.length) parts.push(section(`Response headers (${e.resHeaders.length})`, headerTable(e.resHeaders), false));
      if (e.resBody?.size) parts.push(section(`Response body · ${fmtSize(e.resBody.size)}`, bodyView(e.resBody, hdr(e.resHeaders, "content-type")), true));
      else if (e.done && e.kind === "http" && !e.error) parts.push(el("div", { className: "dev-note", textContent: "The response has no body." }));
    }
    detail.replaceChildren(...parts);
  }

  const section = (title, body, open) => {
    const d = el("details", { className: "tr-sec", open: !!open });
    d.append(el("summary", { textContent: title }), body);
    return d;
  };
  const headerTable = (pairs) => el("table", { className: "tr-hdrs" },
    el("tbody", {}, ...pairs.map(([k, v]) => el("tr", {}, el("th", { textContent: k }), el("td", { className: "mono", textContent: v })))));

  function bodyView(b, type) {
    const bytes = b64bytes(b.base64);
    const box = el("div", { className: "tr-body" });
    if (b.truncated) box.append(el("div", { className: "dev-note", textContent: `Only the first ${fmtSize(b.kept)} of ${fmtSize(b.size)} was kept.` }));
    if (b.decodeError) box.append(el("div", { className: "dev-note", textContent: `${b.decodeError}; showing the bytes as received.` }));
    type = String(type || "").toLowerCase();
    if (/^image\//.test(type) && !/svg/.test(type)) {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      detailUrls.push(url);
      box.append(el("img", { className: "tr-img", src: url, alt: "Image from the response" }));
      return box;
    }
    const text = utf8OrNull(bytes);
    if (text == null) { box.append(el("pre", { className: "out tr-pre", textContent: hexDump(bytes.subarray(0, 4096)) + (bytes.length > 4096 ? `\n… ${fmtSize(bytes.length)} in all` : "") })); return box; }
    let json;
    if (/json/.test(type) || /^\s*[{[]/.test(text)) { try { json = JSON.parse(text); } catch {} }
    if (json !== undefined) {
      const tree = el("div", { className: "tr-json" }, jsonNode(json, null, 0));
      const raw = el("pre", { className: "out tr-pre", textContent: JSON.stringify(json, null, 2), hidden: true });
      const toggle = el("button", { type: "button", className: "btn sm", textContent: "Show as text" });
      toggle.onclick = () => { raw.hidden = !raw.hidden; tree.hidden = !raw.hidden; toggle.textContent = raw.hidden ? "Show as text" : "Show as tree"; };
      const cp = el("button", { type: "button", className: "btn sm", textContent: "Copy" });
      cp.onclick = () => copy(JSON.stringify(json, null, 2), "JSON copied");
      box.append(el("div", { className: "tr-actions" }, toggle, cp), tree, raw);
      return box;
    }
    if (/x-www-form-urlencoded/.test(type)) {
      try { box.append(headerTable([...new URLSearchParams(text)])); return box; } catch {}
    }
    box.append(el("pre", { className: "out tr-pre", textContent: text.length > 200_000 ? text.slice(0, 200_000) + "\n…" : text }));
    return box;
  }

  // Collapsible JSON: objects and arrays are <details>; deep levels start closed.
  function jsonNode(v, key, depth) {
    const keyEl = key != null ? el("span", { className: "j-key", textContent: JSON.stringify(key) + ": " }) : null;
    if (v && typeof v === "object") {
      const isArr = Array.isArray(v);
      const items = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
      const d = el("details", { open: depth < 2 });
      const sum = el("summary", {});
      if (keyEl) sum.append(keyEl);
      sum.append(el("span", { className: "j-meta", textContent: isArr ? `[${items.length}]` : `{${items.length}}` }));
      d.append(sum);
      const kids = el("div", { className: "j-kids" });
      for (const [k, x] of items.slice(0, 2000)) kids.append(jsonNode(x, isArr ? null : k, depth + 1));
      if (items.length > 2000) kids.append(el("div", { className: "j-meta", textContent: `… ${items.length - 2000} more` }));
      d.append(kids);
      return d;
    }
    const cls = v === null ? "j-null" : typeof v === "string" ? "j-str" : typeof v === "number" ? "j-num" : "j-bool";
    const row = el("div", { className: "j-row" });
    if (keyEl) row.append(keyEl);
    row.append(el("span", { className: cls, textContent: JSON.stringify(v) }));
    return row;
  }

  function hexDump(bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.subarray(i, i + 16);
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(48);
      const asc = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
      lines.push(`${i.toString(16).padStart(6, "0")}  ${hex}  ${asc}`);
    }
    return lines.join("\n");
  }

  const SKIP_CURL = new Set(["content-length", "host", "connection", "accept-encoding", "proxy-connection"]);
  function toCurl(e) {
    const out = [`curl -X ${e.method} ${sq(e.url)}`];
    for (const [k, v] of e.reqHeaders) if (!SKIP_CURL.has(k.toLowerCase())) out.push(`-H ${sq(`${k}: ${v}`)}`);
    if (e.reqBody?.size) {
      const text = utf8OrNull(b64bytes(e.reqBody.base64));
      out.push(text != null ? `--data-raw ${sq(text)}` : "--data-binary @body.bin  # binary body, not copied");
    }
    if (hdr(e.reqHeaders, "accept-encoding")) out.push("--compressed");
    return out.join(" \\\n  ");
  }

  function openInApiTester(e) {
    const text = e.reqBody?.size ? utf8OrNull(b64bytes(e.reqBody.base64)) : "";
    store.set("apitest.pending", {
      method: e.method, url: e.url,
      headers: e.reqHeaders.filter(([k]) => !["content-length", "host", "connection", "proxy-connection"].includes(k.toLowerCase())),
      body: text ?? "",
    });
    const tab = document.querySelector('#qaTabs [data-part="apitest"]');
    if (tab) tab.click(); else toast("Request saved for the API tester");
  }

  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch { showError("Couldn't copy to the clipboard."); }
  }

  // ---------------------------------------------------------------- HAR 1.2
  async function exportHar() {
    const ids = [...entries.values()].filter((s) => matches(s) && (s.kind === "http" || s.kind === "ws")).map((s) => s.id);
    if (!ids.length) { toast("No calls to export"); return; }
    busy(harBtn, true, "Exporting…");
    try {
      const harEntries = [];
      for (const id of ids) {
        const e = await insp.get(id).catch(() => null);
        if (!e) continue;
        const h = (pairs) => pairs.map(([name, value]) => ({ name, value }));
        const t = e.timing;
        const reqText = e.reqBody?.size ? utf8OrNull(b64bytes(e.reqBody.base64)) : null;
        const resBytes = e.resBody?.size ? b64bytes(e.resBody.base64) : null;
        const resText = resBytes ? utf8OrNull(resBytes) : null;
        let qs = [];
        try { qs = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value })); } catch {}
        const wait = t.firstByte ? t.firstByte - (t.connected || t.start) : -1;
        harEntries.push({
          startedDateTime: new Date(t.start).toISOString(),
          time: t.end ? t.end - t.start : -1,
          request: {
            method: e.method, url: e.url, httpVersion: `HTTP/${e.httpVersion || "1.1"}`, cookies: [], headers: h(e.reqHeaders), queryString: qs,
            ...(e.reqBody?.size ? { postData: { mimeType: hdr(e.reqHeaders, "content-type"), text: reqText ?? "" } } : {}),
            headersSize: -1, bodySize: e.reqBody?.size || 0,
          },
          response: {
            status: e.status || 0, statusText: e.statusText || (e.error ? e.error : ""), httpVersion: `HTTP/${e.httpVersion || "1.1"}`, cookies: [], headers: h(e.resHeaders),
            content: {
              size: e.resBody?.decodedSize || 0, mimeType: hdr(e.resHeaders, "content-type") || "x-unknown",
              ...(resBytes ? (resText != null ? { text: resText } : { text: e.resBody.base64, encoding: "base64" }) : {}),
            },
            redirectURL: hdr(e.resHeaders, "location"), headersSize: -1, bodySize: e.resBody?.size ?? -1,
          },
          cache: {},
          timings: { blocked: -1, dns: -1, connect: t.connected ? t.connected - t.start : -1, send: 0, wait, receive: t.end && t.firstByte ? t.end - t.firstByte : -1, ssl: -1 },
          ...(e.error ? { comment: e.error } : {}),
        });
      }
      const har = { log: { version: "1.2", creator: { name: "Droid Desk", version: "1" }, entries: harEntries } };
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
      ctx.download(new Blob([JSON.stringify(har, null, 1)], { type: "application/json" }), `api-calls-${stamp}.har`);
      toast(`Exported ${harEntries.length} calls`);
    } finally { busy(harBtn, false); }
  }

  // ---------------------------------------------------------------- HTTPS card
  const httpsState = el("div", { className: "dev-note" });
  const saveCa = el("button", { type: "button", className: "btn sm", textContent: "Save certificate" });
  saveCa.onclick = async () => {
    try { ctx.download(new Blob([await insp.caPem()], { type: "application/x-x509-ca-cert" }), "DroidDesk-CA.crt"); }
    catch (e) { showError(e); }
  };
  const pushCa = el("button", { type: "button", className: "btn sm primary", textContent: "Put certificate on phone" });
  pushCa.onclick = async () => {
    clearError();
    if (!ctx.getAdb()) { showError("Connect a phone first."); return; }
    busy(pushCa, true, "Copying…");
    try {
      const pem = await insp.caPem();
      await sh("mkdir -p /sdcard/Download");
      await ctx.withSync((s) => s.write({ filename: "/sdcard/Download/DroidDesk-CA.crt", file: new Blob([pem]).stream(), permission: 0o644 }));
      await sh("am start -a android.settings.SECURITY_SETTINGS >/dev/null 2>&1").catch(() => {});
      toast("Certificate copied to the phone's Download folder");
      steps.hidden = false;
    } catch (e) { showError(e); } finally { busy(pushCa, false); }
  };
  const steps = el("ol", { className: "steps tr-steps", hidden: true },
    el("li", { textContent: "On the phone, Settings opened. Go to Security (or Security & privacy) › More security settings › Encryption & credentials." }),
    el("li", { textContent: "Tap Install a certificate › CA certificate, then Install anyway." }),
    el("li", { textContent: "Pick DroidDesk-CA.crt from Download. The phone may ask for its screen lock." }),
    el("li", { textContent: "To remove it later: Encryption & credentials › Trusted credentials › User." }));
  const nscPre = el("pre", { className: "out tr-pre tr-nsc", textContent: NSC_XML });
  const nscCopy = el("button", { type: "button", className: "btn sm", textContent: "Copy" });
  nscCopy.onclick = () => copy(NSC_XML, "Copied");
  function renderHttps() {
    httpsState.textContent = store.get("trafficDecrypt", false)
      ? "Decryption is on: apps that trust Droid Desk's certificate show their HTTPS calls in full. Apps that don't (most release apps) fail to connect while capture is on; they show as “certificate refused”."
      : "Decryption is off: HTTPS calls show only the server name and the amount of data. Plain HTTP calls are shown in full.";
  }
  renderHttps();

  // ---------------------------------------------------------------- layout
  root.append(
    card("API calls", el("div", {}, stateChip),
      el("div", { className: "dev-row" },
        startBtn,
        el("label", { className: "dev-lbl", textContent: "Proxy port" }), portIn,
        el("label", { className: "tr-sw" }, decryptSw, el("span", { textContent: "Decrypt HTTPS" }))),
      el("p", { className: "dev-note", textContent: "While capture is on, the phone sends every app's web traffic through Droid Desk (it sets the phone's proxy to this computer, over the cable or Wi‑Fi link). Stop capture, or Disconnect, and the phone's proxy is cleared again." }),
      el("div", { className: "toolbar tr-bar" }, filterIn,
        el("label", { className: "tr-sw" }, apiSw, el("span", { textContent: "Only API calls" })),
        pauseBtn, clearBtn, harBtn, countLbl),
      el("div", { className: "tr-split" }, el("div", { className: "tr-left" }, listBox, emptyBox), detail)),
    card("Seeing inside HTTPS", null,
      httpsState,
      el("p", { className: "dev-note", textContent: "Android 7 and later only trust a certificate you install for apps that opt in. For your own app, add the file below to its debug build; Chrome on the phone trusts it as well. Apps that pin their certificate keep refusing, and that's expected." }),
      el("div", { className: "dev-row" }, pushCa, saveCa),
      steps,
      el("div", { className: "dev-head", style: "margin-top:14px" }, el("h2", { className: "tr-h3", textContent: "Debug build: trust installed certificates" }), el("div", {}, nscCopy)),
      nscPre),
  );

  // Calls already recorded (e.g. after the page was reloaded).
  insp.list().then((items) => { for (const s of items) { entries.set(s.id, s); upsertRow(s); } applyFilter(); }).catch(() => {});
  renderState(); applyFilter();

  // ---------------------------------------------------------------- hooks
  return {
    show() { renderState(); applyFilter(); },
    async connected() {
      running = false; capturePort = 0; captureAdb = null;
      renderState();
      // Capture was still on when the cable was pulled (or Droid Desk was closed): give the phone its internet back.
      const port = store.get("trafficOn", 0);
      if (port) {
        store.set("trafficOn", 0);
        insp.stop().catch(() => {});
        try {
          const cur = (await sh("settings get global http_proxy")).trim();
          if (cur === `127.0.0.1:${port}`) { await sh("settings put global http_proxy :0"); toast("Cleared the phone's proxy left from the last API capture"); }
        } catch {}
      }
    },
    beforeDisconnect: () => (running || store.get("trafficOn", 0) ? stop({ phoneToo: true }) : null),
    disconnected() {
      // The phone can't be reached any more; its proxy is cleared on the next connection (trafficOn stays set).
      if (running) { running = false; capturePort = 0; captureAdb = null; insp.stop().catch(() => {}); }
      renderState();
    },
  };
}
