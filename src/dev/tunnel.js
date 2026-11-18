// Shared plumbing for port forwarding (Developer › Network, App testing › API calls).
//
// There's no adb server: the page speaks ADB itself and main.js only does the PC end, as plain TCP on
// 127.0.0.1 (preload `andromon.devnet`). Each TCP connection reaches the page as a MessagePort:
//  - "accept": a program on this computer connected to a forward rule's port (PC → phone);
//  - "connect": the answer to dialPc(), for a connection the phone opened (phone → PC).
// One window listener dispatches both. pipe() joins a MessagePort and an ADB socket.

let listening = false;
let acceptHandler = null; // (ruleId, port) => void
const pending = new Map(); // reqId -> { resolve, reject }
const uid = () => "c" + Math.random().toString(36).slice(2, 10);

function ensureListener() {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin || e.data?.source !== "andromon-devnet" || !e.ports[0]) return;
    const port = e.ports[0], meta = e.data.meta || {};
    if (meta.kind === "connect") {
      const p = pending.get(meta.reqId);
      if (p) { pending.delete(meta.reqId); p.resolve(port); } else closePort(port);
    } else if (meta.kind === "accept" && acceptHandler) acceptHandler(String(meta.ruleId || ""), port);
    else closePort(port);
  });
}

export function closePort(port) { try { port.postMessage({ closed: true }); } catch {} port.close(); }

/** Connections to forward rules' ports on this computer go to `fn(ruleId, port)`. */
export function onForwardAccept(fn) { ensureListener(); acceptHandler = fn; }

/** Asks main.js to dial 127.0.0.1:pcPort; resolves with the MessagePort for that connection. */
export function dialPc(net, pcPort, timeoutMs = 8000) {
  ensureListener();
  const reqId = uid();
  const got = new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    setTimeout(() => { if (pending.delete(reqId)) reject(new Error("timed out")); }, timeoutMs);
  });
  Promise.resolve().then(() => net.connect(reqId, pcPort)).catch((e) => {
    const p = pending.get(reqId);
    if (p) { pending.delete(reqId); p.reject(e); }
  });
  return got;
}

// MessagePort (raw bytes to/from main.js's TCP socket) <-> ADB socket on the phone.
// `portReady` may still be pending (phone → PC: the computer side is being dialled). The phone's
// socket is read from the start anyway: a client usually sends its request at once, and bytes
// that nobody reads before the phone hangs up are lost. They're held until the port is there.
export function pipe(portReady, socket, onEnd = () => {}) {
  let done = false, port = null, readEnded = false;
  const early = [];
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const end = () => {
    if (done) return;
    done = true;
    if (port) { port.onmessage = null; closePort(port); }
    reader.cancel().catch(() => {});
    Promise.resolve(socket.close()).catch(() => {});
    onEnd();
  };
  Promise.resolve(portReady).then((p) => {
    if (done) { closePort(p); return; }
    // Writes are chained so a close that arrives right behind the last bytes (a server that answers
    // and hangs up at once) waits for them to reach the phone instead of dropping them.
    let chain = Promise.resolve();
    p.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Uint8Array || d instanceof ArrayBuffer) {
        const bytes = new Uint8Array(d);
        chain = chain.then(() => writer.write(bytes));
        chain.catch(end);
      } else if (d && d.closed) chain.then(end, end);
    };
    for (const c of early.splice(0)) p.postMessage(c);
    port = p;
    if (readEnded) end();
  }, end);
  (async () => {
    try {
      for (;;) {
        const { done: dn, value } = await reader.read();
        if (dn) break;
        const c = value.slice(); // never ship the whole underlying buffer
        if (port) port.postMessage(c); else early.push(c);
      }
    } catch {}
    readEnded = true;
    if (port) end();
  })();
}

/**
 * Phone → PC: apps on the phone that connect to 127.0.0.1:phonePort reach 127.0.0.1:pcPort here.
 * Hooks: onConn() per new connection, onEnd() when it closes, onError(e) if this computer didn't answer.
 * Returns the device address ("tcp:N"); remove it with adb.reverse.remove(address).
 */
export function reverseToPc(adb, net, phonePort, pcPort, { onConn, onEnd, onError } = {}) {
  ensureListener();
  return adb.reverse.add(`tcp:${phonePort}`, (socket) => {
    onConn?.();
    const got = dialPc(net, pcPort);
    got.catch((e) => onError?.(e));
    pipe(got, socket, () => onEnd?.());
  });
}
