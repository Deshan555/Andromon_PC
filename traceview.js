// SPDX-License-Identifier: GPL-3.0-only
// Opens a trace from App testing › Traces in the Perfetto UI (ui.perfetto.dev) in the default browser,
// the same way Android's own `record_android_trace` script does: the file is served once from
// http://127.0.0.1:9001 (the address the Perfetto UI accepts traces from) with a CORS header for
// ui.perfetto.dev. The UI runs in the browser and reads the file locally; nothing is uploaded.
"use strict";

const http = require("node:http");

const PORT = 9001;
const UI = "https://ui.perfetto.dev";
let current = null; // { server, timer }

function stop() {
  if (!current) return;
  clearTimeout(current.timer);
  try { current.server.close(); } catch {}
  current = null;
}

function serveOnce(bytes, name) {
  stop();
  const file = encodeURIComponent(String(name || "trace").replace(/[^\w.-]+/g, "_"));
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", UI);
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "GET" }); res.end(); return; }
      if (req.method !== "GET" || req.url !== `/${file}`) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
      res.end(bytes);
      // Give the UI a moment in case it asks twice, then stop serving.
      clearTimeout(current?.timer);
      if (current) current.timer = setTimeout(stop, 15_000);
    });
    server.once("error", (e) => reject(e.code === "EADDRINUSE"
      ? new Error("Port 9001 on this computer is in use (another trace viewer?). Save the trace and open it at ui.perfetto.dev instead.")
      : e));
    server.listen(PORT, "127.0.0.1", () => {
      current = { server, timer: setTimeout(stop, 120_000) };
      resolve(`${UI}/#!/?url=http://127.0.0.1:${PORT}/${file}&referrer=droid_desk`);
    });
  });
}

/** `handle` wraps ipcMain.handle with main.js's sender check; `openExternal` is shell.openExternal. */
function setupTraceView(handle, openExternal) {
  handle("trace:openPerfetto", async (_e, bytes, name) => {
    const buf = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []));
    if (!buf.length) throw new Error("The trace is empty.");
    const url = await serveOnce(buf, name);
    await openExternal(url);
    return true;
  });
}

module.exports = { setupTraceView, stopTraceView: stop };
