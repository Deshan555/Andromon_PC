// Andromon — Repair: what a phone says about itself, read with plain shell commands (nothing on the
// phone is changed). Used by the check-in/check-out report, Bench, Parts and Wipe.
//
// `sh(cmd)` runs on the phone being looked at, so this works for any connected phone, not only the
// one in use. Anything the phone doesn't tell (or won't let adb read) stays empty, never guessed.

import { readBattery } from "../battery.js";

const PROPS = {
  maker: "ro.product.manufacturer", brand: "ro.product.brand", model: "ro.product.model", device: "ro.product.device",
  android: "ro.build.version.release", sdk: "ro.build.version.sdk", patch: "ro.build.version.security_patch", build: "ro.build.display.id",
  serialProp: "ro.serialno", bootState: "ro.boot.verifiedbootstate", flashLocked: "ro.boot.flash.locked", vbmeta: "ro.boot.vbmeta.device_state",
  sim: "gsm.sim.state", operator: "gsm.operator.alpha", cryptoType: "ro.crypto.type", cryptoState: "ro.crypto.state", bootReason: "sys.boot.reason",
};

/** IMEI from Android's phone service, where adb may still ask for it (often not on Android 10+). */
async function readImei(sh) {
  const out = await sh("service call iphonesubinfo 1 s16 com.android.shell 2>/dev/null").catch(() => "");
  // Parcel dump: the digits are spread over quoted, dotted fragments: '3.5.4.4.'
  const text = [...out.matchAll(/'([^']*)'/g)].map((m) => m[1]).join("").replace(/\./g, "").replace(/\s/g, "");
  const imei = text.match(/\d{14,16}/)?.[0] || "";
  return /^\d{15}$/.test(imei) ? imei : "";
}

export async function readFacts({ sh, serial = "", cc = null, companionReady = null }) {
  const keys = Object.keys(PROPS);
  const propOut = await sh(keys.map((k) => `getprop ${PROPS[k]}`).join("; echo '~'; ") ).catch(() => "");
  const vals = propOut.split("~").map((v) => v.trim());
  const p = Object.fromEntries(keys.map((k, i) => [k, vals[i] || ""]));
  const [df, mem, size, density, accounts, su, uptime, imei] = await Promise.all([
    sh("df -k /data 2>/dev/null | tail -n 1").catch(() => ""),
    sh("grep -m1 MemTotal /proc/meminfo").catch(() => ""),
    sh("wm size").catch(() => ""), sh("wm density").catch(() => ""),
    sh("dumpsys account 2>/dev/null | grep -E '^\\s*Account \\{'").catch(() => ""),
    sh("command -v su; ls /data/adb/magisk /sbin/su /system/xbin/su /system/bin/su 2>/dev/null; pm list packages 2>/dev/null | grep -E 'magisk|kernelsu|supersu' ").catch(() => ""),
    sh("cat /proc/uptime").catch(() => ""), readImei(sh),
  ]);
  const battery = await readBattery({ sh, cc: cc || (async () => null), companionReady: companionReady || (async () => false) }).catch(() => null);
  const d = df.trim().split(/\s+/);
  const acc = [...accounts.matchAll(/Account \{name=([^,]*), type=([^}]*)\}/g)].map((m) => ({ name: m[1], type: m[2] }));
  const unlocked = p.vbmeta === "unlocked" || p.flashLocked === "0" || p.bootState === "orange";
  return {
    at: Date.now(),
    maker: p.maker, brand: p.brand, model: p.model, device: p.device, name: [p.maker && !p.model.toLowerCase().startsWith(p.maker.toLowerCase()) ? p.maker : "", p.model].filter(Boolean).join(" "),
    android: p.android, sdk: Number(p.sdk) || 0, patch: p.patch, build: p.build,
    serial: serial || p.serialProp, imei,
    storage: Number(d[1]) > 0 ? { total: Number(d[1]) * 1024, used: Number(d[2]) * 1024, free: Number(d[3]) * 1024 } : null,
    ramBytes: (Number(mem.match(/(\d+)/)?.[1]) || 0) * 1024,
    screen: (size.match(/(\d+x\d+)\s*$/m)?.[1] || "") + (density.match(/(\d+)\s*$/m) ? ` · ${density.match(/(\d+)\s*$/m)[1]} dpi` : ""),
    sim: p.sim, operator: p.operator.replace(/,+$/, ""),
    bootloader: unlocked ? "Unlocked" : p.vbmeta === "locked" || p.flashLocked === "1" || p.bootState === "green" ? "Locked" : "",
    rooted: /su|magisk|kernelsu/i.test(su),
    encrypted: p.cryptoType === "file" || p.cryptoState === "encrypted",
    accounts: acc,
    googleAccount: acc.some((a) => a.type === "com.google"),
    uptimeH: Math.round((Number(uptime.split(/\s+/)[0]) || 0) / 360) / 10,
    bootReason: p.bootReason,
    battery: battery && { level: battery.level, healthPct: battery.healthPct, cycles: battery.cycleCount, condition: battery.health, tempC: battery.tempC, designMah: battery.designMah },
  };
}

/** An email or account name shown with most of it hidden: "j•••@gmail.com". */
export const maskAccount = (name) => String(name).replace(/^(.)[^@]*(@.*)?$/, (_, a, dom) => `${a}•••${dom || ""}`);

/** Rows for showing or printing facts: [label, value]. */
export function factRows(f, fmtSize) {
  if (!f) return [];
  const b = f.battery || {};
  return [
    ["Phone", f.name || f.model], ["Serial number", f.serial], ["IMEI", f.imei || "Not readable over adb (dial *#06# on the phone)"],
    ["Android", f.android ? `${f.android} (API ${f.sdk})` : ""], ["Security update", f.patch], ["Build", f.build],
    ["Storage", f.storage ? `${fmtSize(f.storage.used)} used of ${fmtSize(f.storage.total)}` : ""], ["Memory", f.ramBytes ? fmtSize(f.ramBytes) : ""], ["Screen", f.screen],
    ["Battery", [b.level != null ? `${b.level}%` : "", b.healthPct != null ? `health ${b.healthPct}%` : "health not measured by this phone", b.cycles != null ? `${b.cycles} cycles` : "", b.condition].filter(Boolean).join(" · ")],
    ["SIM", [f.sim, f.operator].filter(Boolean).join(" · ")], ["Bootloader", f.bootloader || "Unknown"], ["Rooted", f.rooted ? "Yes" : "No sign of root"],
    ["Encryption", f.encrypted ? "Encrypted" : "Not reported"], ["Accounts", f.accounts.length ? f.accounts.map((a) => `${maskAccount(a.name)} (${a.type.replace(/^com\./, "")})`).join(", ") : "None"],
    ["Up for", f.uptimeH ? `${f.uptimeH} h` : ""],
  ];
}
