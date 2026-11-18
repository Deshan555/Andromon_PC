// App testing › API tester: build and send HTTP requests, check the answers with simple tests, keep
// them in collections, and run a whole collection as a test suite. Like a small Postman.
//
// Requests are sent by the main process (../../apiclient.js) so any server works (no CORS, no page CSP).
// {{name}} is replaced by the active environment's variable; {{$timestamp}}, {{$uuid}}, {{$randomInt}}
// are built in. A request from App testing › API calls arrives through store "apitest.pending".
// Response text is untrusted: it's only ever shown with textContent.

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const TEST_KINDS = [
  ["status", "Status is"],
  ["statusRange", "Status is 2xx"],
  ["time", "Time below (ms)"],
  ["header", "Header contains"],
  ["body", "Body contains"],
  ["jsonEq", "JSON value equals"],
  ["jsonExists", "JSON value exists"],
];
const uid = () => Math.random().toString(36).slice(2, 10);
const newRequest = (o = {}) => ({
  id: uid(), name: "New request", method: "GET", url: "", headers: [], bodyType: "none", body: "",
  auth: { type: "none", token: "", user: "", pass: "", key: "X-API-Key", value: "" },
  tests: [{ kind: "statusRange", path: "", value: "" }], extract: [], ...o,
});

// ---------- pure helpers ----------
/** Reads `data.items[0].id` (or `$.data.items[0].id`) from a parsed JSON value. */
export function jsonPath(obj, path) {
  const parts = String(path || "").replace(/^\$\.?/, "").match(/[^.[\]]+|\[\d+\]/g) || [];
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = p.startsWith("[") ? cur[Number(p.slice(1, -1))] : cur[p];
  }
  return cur;
}
export function substitute(text, vars) {
  return String(text ?? "").replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (m, name) => {
    if (name === "$timestamp") return String(Math.floor(Date.now() / 1000));
    if (name === "$uuid") return crypto.randomUUID();
    if (name === "$randomInt") return String(Math.floor(Math.random() * 1000));
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m;
  });
}
function runTests(tests, res) {
  let json; try { json = res.body != null ? JSON.parse(res.body) : undefined; } catch {}
  return tests.filter((t) => t.kind).map((t) => {
    const label = TEST_KINDS.find((k) => k[0] === t.kind)?.[1] || t.kind;
    let pass = false, got = "";
    switch (t.kind) {
      case "status": got = res.status; pass = String(res.status) === String(t.value).trim(); break;
      case "statusRange": got = res.status; pass = res.status >= 200 && res.status < 300; break;
      case "time": got = `${res.time.total} ms`; pass = res.time.total < Number(t.value); break;
      case "header": {
        const h = res.headers.filter(([k]) => k.toLowerCase() === String(t.path).toLowerCase().trim()).map(([, v]) => v).join(", ");
        got = h || "(missing)"; pass = !!h && h.includes(String(t.value)); break;
      }
      case "body": got = ""; pass = (res.body || "").includes(String(t.value)); break;
      case "jsonEq": {
        const v = jsonPath(json, t.path); got = v === undefined ? "(missing)" : JSON.stringify(v);
        pass = v !== undefined && (typeof v === "string" ? v === t.value : JSON.stringify(v) === String(t.value).trim()); break;
      }
      case "jsonExists": { const v = jsonPath(json, t.path); got = v === undefined ? "(missing)" : "found"; pass = v !== undefined; break; }
    }
    const what = t.kind === "status" || t.kind === "time" || t.kind === "body" ? `${label} ${t.value}` :
      t.kind === "header" ? `${label}: ${t.path} ⊇ ${t.value}` : t.kind === "statusRange" ? label : `${label}: ${t.path}${t.kind === "jsonEq" ? ` = ${t.value}` : ""}`;
    return { what, pass, got: String(got) };
  });
}
function curlOf(req) {
  const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
  const parts = ["curl", "-X", req.method, q(req.url)];
  for (const [k, v] of req.headers) parts.push("-H", q(`${k}: ${v}`));
  if (req.body) parts.push("--data-raw", q(req.body));
  return parts.join(" ");
}
// Postman collection v2.1 (the commonly shared format), requests only.
function fromPostman(json) {
  const out = [];
  const walk = (items) => {
    for (const it of items || []) {
      if (it.item) { walk(it.item); continue; }
      const r = it.request || {};
      const url = typeof r.url === "string" ? r.url : r.url?.raw || "";
      const bearer = r.auth?.type === "bearer" ? (r.auth.bearer || []).find((x) => x.key === "token")?.value : "";
      out.push(newRequest({
        name: String(it.name || url || "Request").slice(0, 120), method: String(r.method || "GET").toUpperCase(), url: String(url),
        headers: (r.header || []).filter((h) => !h.disabled).map((h) => [String(h.key), String(h.value ?? "")]),
        bodyType: r.body?.mode === "raw" ? (/json/i.test(r.body?.options?.raw?.language || "") || /^\s*[[{]/.test(r.body.raw || "") ? "json" : "text") :
          r.body?.mode === "urlencoded" ? "form" : "none",
        body: r.body?.mode === "raw" ? String(r.body.raw || "") :
          r.body?.mode === "urlencoded" ? (r.body.urlencoded || []).map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? "")}`).join("&") : "",
        auth: { ...newRequest().auth, ...(bearer ? { type: "bearer", token: String(bearer) } : {}) },
      }));
    }
  };
  walk(json.item);
  return { name: String(json.info?.name || "Imported"), requests: out };
}
function toPostman(col) {
  return {
    info: { name: col.name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: col.requests.map((r) => ({
      name: r.name,
      request: {
        method: r.method, url: { raw: r.url }, header: r.headers.map(([key, value]) => ({ key, value })),
        ...(r.bodyType !== "none" && r.body ? { body: { mode: "raw", raw: r.body, options: { raw: { language: r.bodyType === "json" ? "json" : "text" } } } } : {}),
        ...(r.auth?.type === "bearer" ? { auth: { type: "bearer", bearer: [{ key: "token", value: r.auth.token, type: "string" }] } } : {}),
      },
    })),
  };
}

export function mount(root, ctx) {
  const { el, store, toast, showError, clearError } = ctx;
  const api = globalThis.andromon?.api || null;

  let cols = store.get("api.collections", null) || [{ id: uid(), name: "My requests", requests: [newRequest({ name: "Example", url: "https://httpbin.org/get" })] }];
  let envs = store.get("api.envs", null) || [{ id: uid(), name: "Default", vars: [["baseUrl", "https://httpbin.org"]] }];
  let envId = store.get("api.env", envs[0]?.id);
  let history = store.get("api.history", []);
  let cur = { colId: cols[0].id, reqId: cols[0].requests[0]?.id };
  const saveCols = () => store.set("api.collections", cols);
  const saveEnvs = () => store.set("api.envs", envs);
  const env = () => envs.find((e) => e.id === envId) || envs[0];
  const vars = () => Object.fromEntries((env()?.vars || []).filter(([k]) => k));
  const findReq = () => cols.find((c) => c.id === cur.colId)?.requests.find((r) => r.id === cur.reqId);

  // ---------- layout ----------
  const side = el("div", { className: "at-side card" });
  const main = el("div", { className: "at-main" });
  root.append(el("div", { className: "at-layout" }, side, main));
  if (!api) main.append(ctx.card("API tester", null, el("p", { className: "muted", textContent: "Sending requests needs the Andromon desktop app." })));

  // ---------- sidebar: environment, collections ----------
  function renderSide() {
    const envSel = el("select", {});
    for (const e of envs) envSel.append(el("option", { value: e.id, textContent: e.name, selected: e.id === env()?.id }));
    envSel.onchange = () => { envId = envSel.value; store.set("api.env", envId); renderEnv(); };
    const envBtn = el("button", { className: "btn sm", type: "button", textContent: "Variables" });
    envBtn.onclick = () => { envBox.hidden = !envBox.hidden; };
    const list = el("div", { className: "at-cols" });
    for (const c of cols) {
      const head = el("div", { className: "at-col-h" }, el("b", { textContent: c.name }));
      const add = el("button", { className: "at-mini", type: "button", textContent: "+", title: "New request in this collection" });
      add.onclick = () => { const r = newRequest(); c.requests.push(r); cur = { colId: c.id, reqId: r.id }; saveCols(); renderAll(); };
      const run = el("button", { className: "at-mini", type: "button", textContent: "▶", title: "Run every request in this collection" });
      run.onclick = () => runCollection(c);
      const more = el("button", { className: "at-mini", type: "button", textContent: "⋯", title: "Rename, export or delete" });
      more.onclick = () => colMenu(c, head);
      head.append(el("span", { className: "at-col-act" }, add, run, more));
      list.append(head);
      for (const r of c.requests) {
        const b = el("button", { type: "button", className: "at-req" + (r.id === cur.reqId ? " on" : "") },
          el("span", { className: `at-m m-${r.method.toLowerCase()}`, textContent: r.method }), el("span", { className: "at-rn", textContent: r.name }));
        b.onclick = () => { cur = { colId: c.id, reqId: r.id }; renderAll(); };
        list.append(b);
      }
    }
    const newCol = el("button", { className: "btn sm", type: "button", textContent: "New collection" });
    newCol.onclick = () => { const c = { id: uid(), name: `Collection ${cols.length + 1}`, requests: [newRequest()] }; cols.push(c); cur = { colId: c.id, reqId: c.requests[0].id }; saveCols(); renderAll(); };
    const imp = el("button", { className: "btn sm", type: "button", textContent: "Import…", title: "A Postman collection (v2.1) or an Andromon export" });
    const impIn = el("input", { type: "file", accept: ".json,application/json", hidden: true });
    imp.onclick = () => impIn.click();
    impIn.onchange = async () => {
      const f = impIn.files[0]; impIn.value = "";
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        const c = j.info && j.item ? fromPostman(j) : j.requests ? { name: String(j.name || "Imported"), requests: j.requests.map((r) => newRequest({ ...r, id: uid() })) } : null;
        if (!c || !c.requests.length) throw new Error("No requests found in that file.");
        const col = { id: uid(), ...c };
        cols.push(col); cur = { colId: col.id, reqId: col.requests[0].id }; saveCols(); renderAll();
        toast(`Imported ${col.requests.length} request${col.requests.length > 1 ? "s" : ""}`);
      } catch (e) { showError(e instanceof SyntaxError ? new Error("That file isn't valid JSON.") : e); }
    };
    const hist = el("div", { className: "at-hist" });
    if (history.length) {
      hist.append(el("div", { className: "dev-lbl", textContent: "History" }));
      for (const h of history.slice(0, 12)) {
        const b = el("button", { type: "button", className: "at-req", title: h.url },
          el("span", { className: `at-m m-${h.method.toLowerCase()}`, textContent: h.method }),
          el("span", { className: "at-rn", textContent: h.url.replace(/^https?:\/\//, "") }),
          el("span", { className: "at-hs " + (h.status >= 400 || !h.status ? "bad" : ""), textContent: h.status || "×" }));
        b.onclick = () => openHistory(h);
        hist.append(b);
      }
    }
    side.replaceChildren(
      el("div", { className: "dev-row" }, el("span", { className: "dev-lbl", textContent: "Environment" }), envSel, envBtn),
      envBox, list, el("div", { className: "dev-row", style: "margin-top:10px" }, newCol, imp, impIn), hist);
  }
  function colMenu(c, anchor) {
    const box = el("div", { className: "at-menu" });
    const name = el("input", { type: "text", value: c.name });
    name.onchange = () => { c.name = name.value.trim() || c.name; saveCols(); renderSide(); };
    const exp = el("button", { className: "btn sm", type: "button", textContent: "Export (Postman)" });
    exp.onclick = () => ctx.download(new Blob([JSON.stringify(toPostman(c), null, 2)], { type: "application/json" }), `${c.name.replace(/[^\w-]+/g, "_")}.postman_collection.json`);
    const del = el("button", { className: "btn sm danger", type: "button", textContent: "Delete collection" });
    ctx.armedClick(del, async () => {
      cols = cols.filter((x) => x !== c);
      if (!cols.length) cols.push({ id: uid(), name: "My requests", requests: [newRequest()] });
      cur = { colId: cols[0].id, reqId: cols[0].requests[0]?.id }; saveCols(); renderAll();
    });
    box.append(name, exp, del);
    anchor.after(box);
  }

  // Environment variables editor.
  const envBox = el("div", { className: "at-env", hidden: true });
  function renderEnv() {
    const e = env();
    const rows = el("div", { className: "at-kv" });
    const draw = () => {
      rows.replaceChildren(...e.vars.map((pair, i) => kvRow(pair, () => { e.vars.splice(i, 1); saveEnvs(); draw(); }, saveEnvs)));
    };
    draw();
    const add = el("button", { className: "btn sm", type: "button", textContent: "+ Variable" });
    add.onclick = () => { e.vars.push(["", ""]); saveEnvs(); draw(); };
    const newEnv = el("button", { className: "btn sm", type: "button", textContent: "New environment" });
    newEnv.onclick = () => { const n = { id: uid(), name: `Environment ${envs.length + 1}`, vars: e.vars.map(([k]) => [k, ""]) }; envs.push(n); envId = n.id; store.set("api.env", envId); saveEnvs(); renderAll(); envBox.hidden = false; };
    const name = el("input", { type: "text", value: e.name, title: "Environment name" });
    name.onchange = () => { e.name = name.value.trim() || e.name; saveEnvs(); renderSide(); };
    envBox.replaceChildren(el("div", { className: "dev-row" }, name, newEnv), rows, add,
      el("p", { className: "dev-note", textContent: "Use them as {{name}} in the URL, headers, body or auth. Built in: {{$timestamp}}, {{$uuid}}, {{$randomInt}}." }));
  }
  function kvRow(pair, onDelete, onChange, placeholders = ["Name", "Value"]) {
    const k = el("input", { type: "text", value: pair[0], placeholder: placeholders[0], spellcheck: false });
    const v = el("input", { type: "text", value: pair[1], placeholder: placeholders[1], spellcheck: false });
    k.oninput = () => { pair[0] = k.value; onChange(); };
    v.oninput = () => { pair[1] = v.value; onChange(); };
    const x = el("button", { className: "at-mini", type: "button", textContent: "×", title: "Remove" });
    x.onclick = onDelete;
    return el("div", { className: "at-kvrow" }, k, v, x);
  }

  // ---------- editor ----------
  const methodSel = el("select", { className: "at-method" });
  for (const m of METHODS) methodSel.append(el("option", { value: m, textContent: m }));
  const urlIn = el("input", { type: "text", className: "mono at-url", placeholder: "{{baseUrl}}/users/1  or  https://api.example.com/…", spellcheck: false, autocomplete: "off" });
  const sendBtn = el("button", { className: "btn primary", type: "submit", textContent: "Send" });
  const nameIn = el("input", { type: "text", className: "at-name", placeholder: "Request name" });
  const saveNote = el("span", { className: "dev-lbl" });
  const reqTabs = el("div", { className: "seg at-tabs" });
  const reqPane = el("div", { className: "at-pane" });
  const form = el("form", { className: "at-bar" }, methodSel, urlIn, sendBtn);
  const respCard = el("div", { className: "card at-resp", hidden: true });
  const editorCard = ctx.card("Request", el("div", {}, saveNote), el("div", { className: "dev-row" }, nameIn), form, reqTabs, reqPane);
  main.append(editorCard, respCard);
  const reportCard = el("div", { className: "card", hidden: true });
  main.append(reportCard);

  let tab = "params";
  const TABS = [["params", "Params"], ["headers", "Headers"], ["body", "Body"], ["auth", "Auth"], ["tests", "Tests"], ["options", "Options"]];
  for (const [id, label] of TABS) {
    const b = el("button", { type: "button", textContent: label });
    b.dataset.t = id;
    b.onclick = () => { tab = id; renderPane(); };
    reqTabs.append(b);
  }
  let saveTimer = null;
  const changed = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveCols(); renderSide(); }, 400); saveNote.textContent = "Saved"; };

  function loadEditor() {
    const r = findReq();
    if (!r) return;
    methodSel.value = r.method; urlIn.value = r.url; nameIn.value = r.name;
    renderPane();
  }
  methodSel.onchange = () => { const r = findReq(); r.method = methodSel.value; changed(); };
  urlIn.oninput = () => { const r = findReq(); r.url = urlIn.value; changed(); if (tab === "params") renderPane(); };
  nameIn.oninput = () => { const r = findReq(); r.name = nameIn.value || "Request"; changed(); };

  function renderPane() {
    const r = findReq();
    for (const b of reqTabs.children) {
      b.classList.toggle("on", b.dataset.t === tab);
      const n = b.dataset.t === "headers" ? r.headers.length : b.dataset.t === "tests" ? r.tests.length : 0;
      b.textContent = TABS.find((t) => t[0] === b.dataset.t)[1] + (n ? ` (${n})` : "");
    }
    const box = el("div", {});
    if (tab === "params") {
      let u; try { u = new URL(substitute(r.url, vars()).replace(/^(?!https?:)/, "http://x/")); } catch {}
      const params = u ? [...u.searchParams.entries()] : [];
      const rows = el("div", { className: "at-kv" });
      const rebuild = () => {
        const qs = params.filter(([k]) => k).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
        r.url = r.url.split("?")[0] + (qs ? "?" + qs : ""); urlIn.value = r.url; changed();
      };
      const draw = () => rows.replaceChildren(...params.map((p, i) => kvRow(p, () => { params.splice(i, 1); rebuild(); draw(); }, rebuild, ["Parameter", "Value"])));
      draw();
      const add = el("button", { className: "btn sm", type: "button", textContent: "+ Parameter" });
      add.onclick = () => { params.push(["", ""]); draw(); };
      box.append(rows, add, el("p", { className: "dev-note", textContent: "Query parameters, kept in step with the URL. Values containing {{variables}} are best typed in the URL." }));
    } else if (tab === "headers") {
      const rows = el("div", { className: "at-kv" });
      const draw = () => rows.replaceChildren(...r.headers.map((p, i) => kvRow(p, () => { r.headers.splice(i, 1); changed(); draw(); renderPane(); }, changed, ["Header", "Value"])));
      draw();
      const add = el("button", { className: "btn sm", type: "button", textContent: "+ Header" });
      add.onclick = () => { r.headers.push(["", ""]); changed(); draw(); };
      const ct = el("button", { className: "btn sm", type: "button", textContent: "+ Content-Type: JSON" });
      ct.onclick = () => { r.headers.push(["Content-Type", "application/json"]); changed(); renderPane(); };
      box.append(rows, el("div", { className: "dev-row" }, add, ct));
    } else if (tab === "body") {
      const seg = el("div", { className: "seg" });
      for (const [v, label] of [["none", "None"], ["json", "JSON"], ["text", "Text"], ["form", "Form (urlencoded)"]]) {
        const b = el("button", { type: "button", textContent: label, className: r.bodyType === v ? "on" : "" });
        b.onclick = () => { r.bodyType = v; changed(); renderPane(); };
        seg.append(b);
      }
      box.append(el("div", { className: "dev-row" }, seg));
      if (r.bodyType !== "none") {
        const ta = el("textarea", { className: "at-body mono", spellcheck: false, value: r.body, placeholder: r.bodyType === "json" ? '{ "name": "{{user}}" }' : r.bodyType === "form" ? "name=value&other=2" : "" });
        ta.oninput = () => { r.body = ta.value; changed(); };
        box.append(ta);
        if (r.bodyType === "json") {
          const fmt = el("button", { className: "btn sm", type: "button", textContent: "Format JSON" });
          fmt.onclick = () => { try { ta.value = r.body = JSON.stringify(JSON.parse(r.body), null, 2); changed(); } catch { showError("The body isn't valid JSON (variables in {{…}} outside quotes can't be formatted)."); } };
          box.append(el("div", { className: "dev-row" }, fmt));
        }
      }
    } else if (tab === "auth") {
      const a = r.auth;
      const seg = el("div", { className: "seg" });
      for (const [v, label] of [["none", "None"], ["bearer", "Bearer token"], ["basic", "Basic"], ["apikey", "API key header"]]) {
        const b = el("button", { type: "button", textContent: label, className: a.type === v ? "on" : "" });
        b.onclick = () => { a.type = v; changed(); renderPane(); };
        seg.append(b);
      }
      const field = (key, ph, type = "text") => {
        const i = el("input", { type, value: a[key] || "", placeholder: ph, spellcheck: false, className: "mono" });
        i.oninput = () => { a[key] = i.value; changed(); };
        return i;
      };
      box.append(el("div", { className: "dev-row" }, seg));
      if (a.type === "bearer") box.append(el("div", { className: "dev-row at-grow" }, field("token", "Token or {{token}}")));
      if (a.type === "basic") box.append(el("div", { className: "dev-row at-grow" }, field("user", "User name"), field("pass", "Password", "password")));
      if (a.type === "apikey") box.append(el("div", { className: "dev-row at-grow" }, field("key", "Header name"), field("value", "Key or {{apiKey}}")));
      box.append(el("p", { className: "dev-note", textContent: "Saved in this computer's Andromon profile as plain text. Put secrets in an environment variable you don't export." }));
    } else if (tab === "tests") {
      const rows = el("div", { className: "at-tests" });
      const draw = () => rows.replaceChildren(...r.tests.map((t, i) => {
        const kind = el("select", {});
        for (const [v, label] of TEST_KINDS) kind.append(el("option", { value: v, textContent: label, selected: v === t.kind }));
        const path = el("input", { type: "text", value: t.path, className: "mono", placeholder: t.kind === "header" ? "Header name" : "data.items[0].id" });
        const val = el("input", { type: "text", value: t.value, className: "mono", placeholder: t.kind === "status" ? "200" : t.kind === "time" ? "500" : "Expected" });
        const sync = () => { path.hidden = !["header", "jsonEq", "jsonExists"].includes(t.kind); val.hidden = ["statusRange", "jsonExists"].includes(t.kind); };
        kind.onchange = () => { t.kind = kind.value; sync(); changed(); draw(); };
        path.oninput = () => { t.path = path.value; changed(); };
        val.oninput = () => { t.value = val.value; changed(); };
        sync();
        const x = el("button", { className: "at-mini", type: "button", textContent: "×" });
        x.onclick = () => { r.tests.splice(i, 1); changed(); draw(); renderPane(); };
        return el("div", { className: "at-kvrow at-testrow" }, kind, path, val, x);
      }));
      draw();
      const add = el("button", { className: "btn sm", type: "button", textContent: "+ Test" });
      add.onclick = () => { r.tests.push({ kind: "status", path: "", value: "200" }); changed(); draw(); renderPane(); };
      // Save a value from the response into a variable (e.g. a login token for the next request).
      const ex = el("div", { className: "at-kv" });
      const drawEx = () => ex.replaceChildren(...r.extract.map((p, i) => kvRow(p, () => { r.extract.splice(i, 1); changed(); drawEx(); }, changed, ["Variable", "JSON path, e.g. data.token"])));
      drawEx();
      const addEx = el("button", { className: "btn sm", type: "button", textContent: "+ Save to variable" });
      addEx.onclick = () => { r.extract.push(["", ""]); changed(); drawEx(); };
      box.append(rows, add, el("div", { className: "dev-lbl", style: "margin-top:14px", textContent: "After a successful answer, save values into the environment" }), ex, addEx);
    } else if (tab === "options") {
      const o = r.options || (r.options = { timeoutMs: 30000, followRedirects: true, insecure: false });
      const timeout = el("input", { type: "number", min: 1, max: 600, value: Math.round(o.timeoutMs / 1000), className: "at-num" });
      timeout.oninput = () => { o.timeoutMs = Math.max(1, Number(timeout.value) || 30) * 1000; changed(); };
      const follow = ctx.makeSwitch(o.followRedirects, async (v) => { o.followRedirects = v; changed(); return v; });
      const insecure = ctx.makeSwitch(o.insecure, async (v) => { o.insecure = v; changed(); return v; });
      box.append(
        el("div", { className: "dev-row" }, el("span", { className: "dev-lbl", textContent: "Give up after (s)" }), timeout),
        el("div", { className: "ctl" }, el("div", {}, el("div", { textContent: "Follow redirects" })), follow),
        el("div", { className: "ctl", style: "margin-top:8px" }, el("div", {}, el("div", { textContent: "Allow untrusted certificates" }),
          el("div", { className: "sub", textContent: "For test servers with self-signed certificates. Don't use it for real accounts." })), insecure));
    }
    reqPane.replaceChildren(box);
  }

  // ---------- sending ----------
  function build(r) {
    const v = vars();
    const headers = r.headers.filter(([k]) => k.trim()).map(([k, val]) => [substitute(k, v).trim(), substitute(val, v)]);
    const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
    const a = r.auth || {};
    if (a.type === "bearer" && a.token) headers.push(["Authorization", `Bearer ${substitute(a.token, v)}`]);
    if (a.type === "basic") headers.push(["Authorization", `Basic ${btoa(unescape(encodeURIComponent(`${substitute(a.user, v)}:${substitute(a.pass, v)}`)))}`]);
    if (a.type === "apikey" && a.key) headers.push([substitute(a.key, v), substitute(a.value, v)]);
    let body = null;
    if (r.bodyType !== "none" && !["GET", "HEAD"].includes(r.method)) {
      body = substitute(r.body, v);
      if (r.bodyType === "json" && !has("content-type")) headers.push(["Content-Type", "application/json"]);
      if (r.bodyType === "form" && !has("content-type")) headers.push(["Content-Type", "application/x-www-form-urlencoded"]);
    }
    let url = substitute(r.url, v).trim();
    if (url && !/^[a-z]+:\/\//i.test(url)) url = "https://" + url;
    const o = r.options || {};
    return { method: r.method, url, headers, body, timeoutMs: o.timeoutMs || 30000, followRedirects: o.followRedirects !== false, insecure: !!o.insecure };
  }
  const unresolved = (req) => [...new Set((req.url + JSON.stringify(req.headers) + (req.body || "")).match(/\{\{\s*[\w.-]+\s*\}\}/g) || [])];

  let sending = null;
  async function send(r) {
    const req = build(r);
    const missing = unresolved(req);
    if (missing.length) throw new Error(`Not set in “${env()?.name}”: ${missing.join(", ")}. Add them under Variables.`);
    if (!req.url) throw new Error("Enter a URL.");
    const id = uid();
    sending = id;
    try {
      const res = await api.send(id, req);
      const tests = runTests(r.tests || [], res);
      // Save requested values into the environment.
      if (res.status < 400 && r.extract?.length) {
        let json; try { json = JSON.parse(res.body); } catch {}
        const e = env();
        for (const [name, path] of r.extract) {
          if (!name || !path) continue;
          const val = jsonPath(json, path);
          if (val === undefined) continue;
          const s = typeof val === "string" ? val : JSON.stringify(val);
          const slot = e.vars.find(([k]) => k === name);
          if (slot) slot[1] = s; else e.vars.push([name, s]);
        }
        saveEnvs();
      }
      return { req, res, tests };
    } finally { if (sending === id) sending = null; }
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!api) return;
    const r = findReq();
    if (sending) { api.cancel(sending); return; }
    clearError();
    sendBtn.textContent = "Cancel";
    respCard.hidden = false;
    respCard.replaceChildren(el("div", { className: "empty" }, ctx.spinner(), " Waiting for the answer…"));
    try {
      const out = await send(r);
      addHistory(out.req, out.res.status);
      showResponse(out);
      if (!envBox.hidden) renderEnv();
    } catch (err) {
      addHistory(build(r), 0);
      respCard.replaceChildren(el("div", { className: "dev-head" }, el("h2", { textContent: "No answer" })),
        el("p", { className: "at-err", textContent: err.message || String(err) }));
    } finally { sendBtn.textContent = "Send"; renderSide(); }
  });

  function addHistory(req, status) {
    // Credentials aren't kept in the history.
    const headers = req.headers.filter(([k]) => !/^(authorization|cookie|proxy-authorization|x-api-key)$/i.test(k));
    history = [{ method: req.method, url: req.url, headers, body: req.body, status, at: Date.now() }, ...history].slice(0, 50);
    store.set("api.history", history);
  }
  function openHistory(h) {
    const c = cols.find((x) => x.id === cur.colId) || cols[0];
    const r = newRequest({ name: `${h.method} ${h.url.replace(/^https?:\/\/[^/]+/, "") || "/"}`.slice(0, 80), method: h.method, url: h.url,
      headers: (h.headers || []).filter(([k]) => !/^authorization$/i.test(k)), bodyType: h.body ? "text" : "none", body: h.body || "" });
    c.requests.push(r); cur = { colId: c.id, reqId: r.id }; saveCols(); renderAll();
  }

  function showResponse({ req, res, tests }) {
    const ok = res.status < 400;
    const passed = tests.filter((t) => t.pass).length;
    const chips = el("div", {},
      el("span", { className: "chip " + (ok ? "at-ok" : "at-bad"), textContent: `${res.status} ${res.statusText}` }),
      el("span", { className: "chip", textContent: `${res.time.total} ms` }),
      el("span", { className: "chip", textContent: ctx.fmtSize(res.decodedSize) + (res.truncated ? " (cut at 10 MB)" : "") }),
      tests.length ? el("span", { className: "chip " + (passed === tests.length ? "at-ok" : "at-bad"), textContent: `Tests ${passed}/${tests.length}` }) : "");
    const tabs = el("div", { className: "seg at-tabs" });
    const pane = el("div", { className: "at-pane" });
    const views = {
      body: () => bodyView(res),
      headers: () => el("div", { className: "dev-kv" }, ...res.headers.flatMap(([k, v]) => [el("span", { textContent: k }), el("span", { textContent: v })])),
      tests: () => tests.length ? el("div", { className: "at-results" }, ...tests.map((t) =>
        el("div", { className: "at-result " + (t.pass ? "pass" : "fail") }, el("b", { textContent: t.pass ? "Pass" : "Fail" }), el("span", { textContent: t.what }),
          t.pass ? "" : el("span", { className: "muted", textContent: `got ${t.got}` }))))
        : el("p", { className: "muted", textContent: "No tests. Add some under Tests to check this answer automatically." }),
      info: () => el("div", { className: "dev-kv" },
        el("span", { textContent: "URL" }), el("span", { textContent: res.url }),
        el("span", { textContent: "Server address" }), el("span", { textContent: res.remote || "–" }),
        el("span", { textContent: "HTTP" }), el("span", { textContent: res.httpVersion }),
        el("span", { textContent: "First byte" }), el("span", { textContent: `${res.time.ttfb} ms` }),
        el("span", { textContent: "Redirects" }), el("span", { textContent: res.redirects.length ? res.redirects.map((h) => `${h.status} ${h.url}`).join(" → ") : "none" }),
        ...(res.tls ? [el("span", { textContent: "TLS" }), el("span", { textContent: `${res.tls.protocol} · ${res.tls.subject} · issued by ${res.tls.issuer} · until ${res.tls.validTo}` })] : [])),
    };
    let which = tests.some((t) => !t.pass) ? "tests" : "body";
    const draw = () => { for (const b of tabs.children) b.classList.toggle("on", b.dataset.t === which); pane.replaceChildren(views[which]()); };
    for (const [id, label] of [["body", "Body"], ["headers", `Headers (${res.headers.length})`], ["tests", "Tests"], ["info", "Details"]]) {
      const b = el("button", { type: "button", textContent: label }); b.dataset.t = id;
      b.onclick = () => { which = id; draw(); };
      tabs.append(b);
    }
    const curl = el("button", { className: "btn sm", type: "button", textContent: "Copy as cURL" });
    curl.onclick = () => navigator.clipboard.writeText(curlOf(req)).then(() => toast("Copied"), () => {});
    const copy = el("button", { className: "btn sm", type: "button", textContent: "Copy body" });
    copy.onclick = () => navigator.clipboard.writeText(res.body ?? "").then(() => toast("Copied"), () => {});
    respCard.replaceChildren(ctx.card("Response", el("div", {}, copy, curl)).firstChild, chips, tabs, pane);
    draw();
  }
  function bodyView(res) {
    if (res.body == null) {
      if (/^image\//i.test(res.type) && res.bodyBase64) {
        const bytes = Uint8Array.from(atob(res.bodyBase64), (c) => c.charCodeAt(0));
        return el("img", { className: "at-img", src: URL.createObjectURL(new Blob([bytes], { type: res.type })), alt: "Image in the answer" });
      }
      return el("p", { className: "muted", textContent: `Binary answer (${res.type || "unknown type"}, ${ctx.fmtSize(res.decodedSize)}).` });
    }
    let text = res.body;
    if (/json/i.test(res.type) || /^\s*[[{]/.test(text)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    if (text.length > 400_000) text = text.slice(0, 400_000) + "\n… (shortened for display)";
    return el("pre", { className: "out at-out", textContent: text || "(empty)" });
  }

  // ---------- run a collection ----------
  let running = false;
  async function runCollection(c) {
    if (running || !api) return;
    running = true; clearError();
    reportCard.hidden = false;
    const rows = el("div", { className: "at-results" });
    const stop = el("button", { className: "btn sm", type: "button", textContent: "Stop" });
    let stopped = false;
    stop.onclick = () => { stopped = true; if (sending) api.cancel(sending); };
    const sum = el("div", { className: "dev-lbl" });
    reportCard.replaceChildren(ctx.card(`Run: ${c.name}`, stop).firstChild, sum, rows);
    reportCard.scrollIntoView({ behavior: "smooth", block: "start" });
    const results = [];
    for (const [i, r] of c.requests.entries()) {
      if (stopped) break;
      sum.textContent = `Request ${i + 1} of ${c.requests.length}…`;
      let out = null, error = "";
      try { out = await send(r); } catch (e) { error = e.message || String(e); }
      const pass = !error && out.tests.every((t) => t.pass);
      results.push({ name: r.name, method: r.method, url: out?.req.url || r.url, status: out?.res.status || 0, ms: out?.res.time.total || 0, pass, error, tests: out?.tests || [] });
      rows.append(el("div", { className: "at-result " + (pass ? "pass" : "fail") },
        el("b", { textContent: pass ? "Pass" : "Fail" }), el("span", { textContent: `${r.method} ${r.name}` }),
        el("span", { className: "muted", textContent: error || `${out.res.status} · ${out.res.time.total} ms · tests ${out.tests.filter((t) => t.pass).length}/${out.tests.length}` })));
    }
    const passed = results.filter((x) => x.pass).length;
    sum.textContent = `${passed} of ${results.length} passed${stopped ? " (stopped)" : ""} · ${env()?.name}`;
    const save = el("button", { className: "btn sm", type: "button", textContent: "Save report (JSON)" });
    save.onclick = () => ctx.download(new Blob([JSON.stringify({ collection: c.name, environment: env()?.name, at: new Date().toISOString(), passed, total: results.length, results }, null, 2)], { type: "application/json" }),
      `api-run-${c.name.replace(/[^\w-]+/g, "_")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
    stop.replaceWith(save);
    running = false;
    renderSide();
  }

  function renderAll() { renderSide(); renderEnv(); loadEditor(); }

  // A request handed over from App testing › API calls.
  function takePending() {
    const p = store.get("apitest.pending", null);
    if (!p || !p.url) return;
    store.set("apitest.pending", null);
    const c = cols.find((x) => x.id === cur.colId) || cols[0];
    let path = p.url; try { path = new URL(p.url).pathname; } catch {}
    const r = newRequest({
      name: `${p.method || "GET"} ${path}`.slice(0, 80), method: METHODS.includes(p.method) ? p.method : "GET", url: String(p.url),
      headers: (p.headers || []).filter(([k]) => !/^(host|content-length|connection|proxy-connection|accept-encoding)$/i.test(k)).map(([k, v]) => [String(k), String(v)]),
      bodyType: p.body ? (/^\s*[[{]/.test(p.body) ? "json" : "text") : "none", body: p.body || "",
    });
    c.requests.push(r); cur = { colId: c.id, reqId: r.id }; saveCols(); renderAll();
    toast("Request copied from API calls");
  }

  renderAll();
  takePending();
  return { show: takePending };
}
