// Andromon — Wi‑Fi link quality, and joining a phone's Direct link (main process).
//
// Link quality: reads this computer's Wi‑Fi band, rate and signal (macOS: system_profiler,
// Windows: netsh) so the UI can warn when a transfer will be slow, and estimates the speed.
//
// Direct link: Andromon Companion can start a temporary private hotspot on the phone for one
// transfer. Its name and password arrive inside the encrypted, accepted transfer. This module joins
// that network, and afterwards removes it and reconnects to the previous Wi‑Fi. Built-in OS tools
// only (macOS networksetup, Windows netsh): no admin rights, nothing to install.
"use strict";
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, timeout = 20_000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: String(stdout || ""), err: String(stderr || "") }));
});

// ---------- this computer's Wi‑Fi link ----------

let macDevice;
async function macWifiDevice() {
  if (macDevice !== undefined) return macDevice;
  const r = await run("networksetup", ["-listallhardwareports"]);
  macDevice = /Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/.exec(r.out)?.[1] || null;
  return macDevice;
}

async function macWifi() {
  const dev = await macWifiDevice();
  const [sp, route] = await Promise.all([
    run("system_profiler", ["SPAirPortDataType", "-json"], 30_000),
    run("route", ["-n", "get", "default"]),
  ]);
  const defaultIf = /interface:\s*(\S+)/.exec(route.out)?.[1] || null;
  let cur = null;
  try {
    for (const blk of JSON.parse(sp.out).SPAirPortDataType || []) {
      for (const i of blk.spairport_airport_interfaces || []) {
        if (i._name === dev && i.spairport_current_network_information) cur = i.spairport_current_network_information;
      }
    }
  } catch {}
  const wired = !!defaultIf && defaultIf !== dev && !/^(utun|ipsec|ppp)/.test(defaultIf);
  if (!cur || !cur.spairport_network_channel) return { kind: wired ? "wired" : "none", device: dev };
  const ch = /^(\d+)\s*\((\d+(?:\.\d+)?)GHz,\s*(\d+)MHz\)/.exec(cur.spairport_network_channel);
  const sig = /(-?\d+)\s*dBm/.exec(cur.spairport_signal_noise || "");
  return {
    kind: wired ? "wired" : "wifi", device: dev,
    ssid: typeof cur._name === "string" && !/redacted/i.test(cur._name) ? cur._name : null,
    band: ch ? (ch[2] === "2" ? "2.4 GHz" : `${ch[2]} GHz`) : null,
    channel: ch ? +ch[1] : null, widthMHz: ch ? +ch[3] : null,
    phy: cur.spairport_network_phymode || null,
    rateMbps: Number(cur.spairport_network_rate) || null,
    rssi: sig ? +sig[1] : null,
  };
}

async function winWifi() {
  const r = await run("netsh", ["wlan", "show", "interfaces"]);
  // English labels; other Windows languages give partial information.
  const get = (label) => new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "mi").exec(r.out)?.[1]?.trim() || null;
  const state = get("State");
  if (!state || !/^connected$/i.test(state)) return { kind: "none" };
  const channel = Number(get("Channel")) || null;
  const pct = Number((get("Signal") || "").replace("%", "")) || null;
  const band = get("Band") || (channel ? (channel <= 14 ? "2.4 GHz" : "5 GHz") : null);
  const rate = Math.max(Number(get("Receive rate \\(Mbps\\)")) || 0, Number(get("Transmit rate \\(Mbps\\)")) || 0) || null;
  return {
    kind: "wifi", device: get("Name"), ssid: get("SSID"), profile: get("Profile"),
    band: band ? band.replace(/^2\.4\s*GHz|^2GHz/i, "2.4 GHz") : null, channel, phy: get("Radio type"),
    rateMbps: rate, rssi: pct != null ? Math.round(pct / 2 - 100) : null,
  };
}

let cache = { at: 0, value: null, pending: null };
/** This computer's network link (cached for 30 s; system_profiler takes a few seconds). */
async function localLink({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < 30_000) return cache.value;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    try {
      const v = process.platform === "darwin" ? await macWifi() : process.platform === "win32" ? await winWifi() : { kind: "unknown" };
      cache = { at: Date.now(), value: v, pending: null };
      return v;
    } catch (e) {
      cache.pending = null;
      return { kind: "unknown", error: e.message };
    }
  })();
  return cache.pending;
}

/**
 * Rough transfer speed in MB/s between this computer and a phone on the same Wi‑Fi.
 * Goodput is about half the PHY rate; when both are wireless on the same router, every byte
 * crosses the air twice, so the airtime of both legs adds up.
 */
function estimateMBps(pc, phone) {
  const legs = [];
  if (pc?.kind === "wifi" && pc.rateMbps) legs.push(pc.rateMbps * 0.55);
  const phoneRate = phone?.txMbps || phone?.linkMbps;
  if (phoneRate) legs.push(phoneRate * 0.55);
  if (!legs.length) return null;
  const mbit = legs.length === 2 ? 1 / (1 / legs[0] + 1 / legs[1]) : legs[0];
  return Math.round((mbit / 8) * 10) / 10;
}

const signalWord = (rssi) => rssi == null ? null : rssi >= -60 ? "strong" : rssi >= -70 ? "fair" : "weak";

// ---------- Direct link: join the phone's hotspot, then go back ----------

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}

/** Waits until this computer has an address in one of the phone's subnets; returns that phone address. */
async function waitForSubnet(addresses, { timeoutMs, cancelled }) {
  const v4 = addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cancelled?.()) throw new Error("Cancelled");
    const mine = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
    for (const phone of v4) {
      const prefix = phone.split(".").slice(0, 3).join(".") + ".";
      if (mine.some((m) => m.startsWith(prefix) && m !== phone)) return phone;
    }
    await sleep(500);
  }
  return null;
}

/**
 * Joins the phone's Direct link network. Returns a restore() that removes it and reconnects to the
 * previous Wi‑Fi. Throws if the OS couldn't join (the caller can ask the person to join by hand).
 */
async function joinNetwork(net, { cancelled } = {}) {
  if (!net?.ssid || !net?.passphrase) throw new Error("The phone didn't send its network details");
  if (process.platform === "darwin") return macJoin(net, cancelled);
  if (process.platform === "win32") return winJoin(net, cancelled);
  throw new Error("Joining automatically isn't supported on this system");
}

async function macJoin(net, cancelled) {
  const dev = await macWifiDevice();
  if (!dev) throw new Error("This Mac has no Wi‑Fi");
  const before = await localLink({ fresh: true }).catch(() => null);
  await run("networksetup", ["-setairportpower", dev, "on"]);
  let last = "";
  // The hotspot can take a few seconds to show up in scans: retry.
  for (let i = 0; i < 5; i++) {
    if (cancelled?.()) throw new Error("Cancelled");
    const r = await run("networksetup", ["-setairportnetwork", dev, net.ssid, net.passphrase], 45_000);
    last = (r.out + r.err).trim();
    if (r.code === 0 && !last) break;
    if (/admin|authori[sz]|not permitted/i.test(last)) throw new Error(`macOS needs permission to change Wi‑Fi: ${last}`);
    last = last || `exit code ${r.code}`;
    if (i === 4) throw new Error(`macOS couldn't join ${net.ssid}: ${last}`);
    await sleep(2500);
  }
  return () => macRestore(dev, net.ssid, before);
}

async function macRestore(dev, ssid, before) {
  // Forget the temporary network (may need admin rights on some Macs; harmless if refused).
  await run("networksetup", ["-removepreferredwirelessnetwork", dev, ssid]);
  if (before?.ssid) {
    const r = await run("networksetup", ["-setairportnetwork", dev, before.ssid], 45_000);
    if (r.code === 0 && !(r.out + r.err).trim()) return;
  }
  // Otherwise let macOS pick its usual network again.
  await run("networksetup", ["-setairportpower", dev, "off"]);
  await sleep(1500);
  await run("networksetup", ["-setairportpower", dev, "on"]);
}

async function winJoin(net, cancelled) {
  const before = await localLink({ fresh: true }).catch(() => null);
  const auth = net.security === "wpa3" ? "WPA3SAE" : "WPA2PSK";
  const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(net.ssid)}</name>
  <SSIDConfig><SSID><name>${xmlEscape(net.ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>${auth}</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(net.passphrase)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`;
  // The profile file holds the password: private temp file, deleted right after it's imported.
  const file = path.join(os.tmpdir(), `andromon-${crypto.randomUUID()}.xml`);
  fs.writeFileSync(file, xml, { mode: 0o600 });
  let r;
  try { r = await run("netsh", ["wlan", "add", "profile", `filename=${file}`, "user=current"]); }
  finally { fs.rmSync(file, { force: true }); }
  if (r.code !== 0) throw new Error(`Windows couldn't add the network: ${(r.out + r.err).trim()}`);
  for (let i = 0; i < 5; i++) {
    if (cancelled?.()) break;
    r = await run("netsh", ["wlan", "connect", `name=${net.ssid}`, `ssid=${net.ssid}`]);
    if (r.code === 0) return () => winRestore(net.ssid, before);
    await sleep(2500);
  }
  await run("netsh", ["wlan", "delete", "profile", `name=${net.ssid}`]);
  throw new Error(cancelled?.() ? "Cancelled" : `Windows couldn't join ${net.ssid}: ${(r.out + r.err).trim()}`);
}

async function winRestore(ssid, before) {
  await run("netsh", ["wlan", "delete", "profile", `name=${ssid}`]);
  if (before?.profile && before.profile !== ssid) await run("netsh", ["wlan", "connect", `name=${before.profile}`]);
}

/** Cleanup after the person joined the phone's network by hand. [before]: localLink() from before. */
async function forgetNetwork(ssid, before) {
  if (process.platform === "darwin") {
    const dev = await macWifiDevice();
    if (dev) await macRestore(dev, ssid, before);
  } else if (process.platform === "win32") {
    await winRestore(ssid, before);
  }
}

module.exports = { localLink, estimateMBps, signalWord, joinNetwork, waitForSubnet, forgetNetwork };
