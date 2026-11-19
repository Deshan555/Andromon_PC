// Andromon — the clipboard shared both ways while a phone is connected (Settings › Phone link).
// Text copied on this computer can be pasted on the phone, and text copied on the phone lands in
// this computer's clipboard, with no button to press.
//
// Android 10 and later only let the app in front (or the keyboard) read the clipboard, so an app
// can't watch it. The shell user can, so Andromon runs a small watcher from the companion's own
// APK as the shell user (ClipWatch.kt, started with app_process like scrcpy's server). It prints
// one JSON line per change and takes {"set": text} lines to change the phone's clipboard. This
// computer's clipboard is read through the main process (Electron's clipboard), every 0.8 s.
// Only text is shared, up to 1 MB. Nothing is stored or logged.

const PKG = "dev.andromon.companion";
const POLL_MS = 800;
const MAX = 1024 * 1024;

export function initClipSync({ getAdb, toast, isOn }) {
  const api = globalThis.andromon?.clip || null;
  let cur = null; // { adb, proc, writer, timer, stopped }
  let retry = null, failures = 0;

  function stop() {
    clearTimeout(retry); retry = null;
    const c = cur; cur = null;
    if (!c) return;
    c.stopped = true; clearInterval(c.timer);
    c.writer?.close().catch(() => {});
    try { c.proc.kill(); } catch {}
  }

  async function start(adb) {
    const proc = await adb.subprocess.noneProtocol.spawn(`CLASSPATH=$(pm path ${PKG} | head -n1 | cut -d: -f2) exec app_process / ${PKG}.ClipWatch 2>/dev/null`);
    const c = { adb, proc, writer: proc.stdin.getWriter(), timer: null, stopped: false, pc: null, ready: false };
    cur = c;
    const send = (obj) => c.writer.write(new TextEncoder().encode(JSON.stringify(obj) + "\n")).catch(() => {});
    // This computer → phone: whatever is new in the clipboard here, and wasn't just sent from the phone.
    const poll = async () => {
      if (c.stopped || !c.ready) return;
      const text = await api.read().catch(() => null);
      if (typeof text !== "string" || !text || text === c.pc || text.length > MAX) return;
      c.pc = text; send({ set: text });
    };
    (async () => {
      const reader = proc.output.getReader(), dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.ready) {
              c.ready = true; failures = 0;
              // What is in this computer's clipboard now counts as seen: only later copies go over.
              c.pc = await api.read().catch(() => "");
              c.timer = setInterval(poll, POLL_MS);
            } else if (typeof msg.text === "string" && !msg.initial && msg.text && msg.text !== c.pc) {
              // Phone → this computer. Remembered as seen, so the next poll doesn't send it back.
              c.pc = msg.text; await api.write(msg.text).catch(() => {});
            }
          }
        }
      } catch {}
      if (cur === c && !c.stopped) {
        // The watcher ended by itself: an old companion without it, or the phone went away.
        const wasReady = c.ready;
        stop();
        if (!wasReady && ++failures >= 2) { toast("The shared clipboard needs a newer Andromon Companion. Open Messages, Contacts or Photos to update it."); return; }
        retry = setTimeout(() => sync(), Math.min(60_000, 3000 * 2 ** failures));
      }
    })();
  }

  /** Starts or stops the watcher to match the switch and the connection. */
  function sync() {
    const adb = getAdb();
    const want = !!api && isOn() && !!adb;
    if (!want) { stop(); return; }
    if (cur?.adb === adb) return;
    stop();
    start(adb).catch((e) => { console.warn("Shared clipboard:", e); stop(); });
  }
  return { sync, stop, available: !!api };
}
