// Andromon — reads app details out of .apk files and split-APK bundles (.apks / .xapk / .apkm)
// before they are installed: name, icon, package, version, SDK levels, permissions and splits.
//
// An APK is a zip. AndroidManifest.xml inside it is "binary XML" (AXML), and labels/icons point into
// resources.arsc, a binary resource table. Both formats are parsed here directly; unzipping uses fflate.
// All values come from an untrusted file: callers must insert them as text, never as HTML.
import { unzipSync } from "fflate";

const RES_STRING_POOL = 0x0001, RES_TABLE = 0x0002, RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102, RES_XML_RESOURCE_MAP = 0x0180;
const RES_TABLE_PACKAGE = 0x0200, RES_TABLE_TYPE = 0x0201;
const TYPE_REFERENCE = 0x01, TYPE_STRING = 0x03, TYPE_INT_DEC = 0x10, TYPE_INT_HEX = 0x11, TYPE_INT_BOOLEAN = 0x12;

// android:* attribute resource ids (stable across Android versions).
const ATTR = {
  0x01010001: "label", 0x01010002: "icon", 0x01010003: "name",
  0x0101021b: "versionCode", 0x0101021c: "versionName",
  0x0101020c: "minSdkVersion", 0x01010270: "targetSdkVersion", 0x01010271: "maxSdkVersion",
  0x0101052c: "roundIcon",
};

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf16 = new TextDecoder("utf-16le", { fatal: false });

function readStringPool(dv, off) {
  const count = dv.getUint32(off + 8, true);
  const flags = dv.getUint32(off + 16, true);
  const stringsStart = dv.getUint32(off + 20, true);
  const isUtf8 = (flags & 0x100) !== 0;
  const headerSize = dv.getUint16(off + 2, true);
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const cache = new Map();
  const get = (i) => {
    if (i < 0 || i >= count) return null;
    if (cache.has(i)) return cache.get(i);
    let p = off + stringsStart + dv.getUint32(off + headerSize + i * 4, true);
    let s;
    if (isUtf8) {
      let n = bytes[p++]; if (n & 0x80) p++;               // utf-16 length (skipped)
      let len = bytes[p++]; if (len & 0x80) len = ((len & 0x7f) << 8) | bytes[p++];
      s = utf8.decode(bytes.subarray(p, p + len));
    } else {
      let len = dv.getUint16(p, true); p += 2;
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | dv.getUint16(p, true); p += 2; }
      s = utf16.decode(bytes.subarray(p, p + len * 2));
    }
    cache.set(i, s);
    return s;
  };
  return { get, count };
}

/** Parses binary XML into a flat list of start elements: [{ name, attrs: { key: value } }]. */
export function parseAxml(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== RES_XML) throw new Error("Not a binary XML file");
  let strings = null, resMap = [];
  const elements = [];
  let off = dv.getUint16(2, true);
  const end = Math.min(dv.getUint32(4, true), buf.byteLength);
  while (off + 8 <= end) {
    const type = dv.getUint16(off, true), headerSize = dv.getUint16(off + 2, true), size = dv.getUint32(off + 4, true);
    if (size < 8) break;
    if (type === RES_STRING_POOL) strings = readStringPool(dv, off);
    else if (type === RES_XML_RESOURCE_MAP) {
      resMap = []; for (let p = off + headerSize; p + 4 <= off + size; p += 4) resMap.push(dv.getUint32(p, true));
    } else if (type === RES_XML_START_ELEMENT && strings) {
      const ext = off + headerSize;
      const name = strings.get(dv.getUint32(ext + 4, true));
      const attrStart = dv.getUint16(ext + 8, true), attrSize = dv.getUint16(ext + 10, true), attrCount = dv.getUint16(ext + 12, true);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = dv.getUint32(a + 4, true);
        const rawIdx = dv.getUint32(a + 8, true);
        const dataType = dv.getUint8(a + 15), data = dv.getUint32(a + 16, true);
        // Obfuscated apps strip attribute names; the resource map still identifies android:* attributes.
        const key = ATTR[resMap[nameIdx]] || strings.get(nameIdx) || `attr${nameIdx}`;
        let value;
        if (dataType === TYPE_STRING) value = strings.get(data);
        else if (dataType === TYPE_REFERENCE) value = { ref: data };
        else if (dataType === TYPE_INT_BOOLEAN) value = data !== 0;
        else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) value = data | 0;
        else value = rawIdx !== 0xffffffff ? strings.get(rawIdx) : data;
        attrs[key] = value;
      }
      elements.push({ name, attrs });
    }
    off += size;
  }
  return elements;
}

/** Parses resources.arsc into a resolver: id -> [{ density, language, type, data }] */
export function parseArsc(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== RES_TABLE) throw new Error("Not a resource table");
  const entries = new Map();
  let values = null;
  let off = dv.getUint16(2, true);
  while (off + 8 <= buf.byteLength) {
    const type = dv.getUint16(off, true), size = dv.getUint32(off + 4, true);
    if (size < 8) break;
    if (type === RES_STRING_POOL && !values) values = readStringPool(dv, off);
    else if (type === RES_TABLE_PACKAGE) readPackage(dv, off, size, entries);
    off += size;
  }
  return {
    values,
    lookup: (id) => entries.get(id >>> 0) || [],
  };
}

function readPackage(dv, pkgOff, pkgSize, entries) {
  const pkgId = dv.getUint32(pkgOff + 8, true);
  const headerSize = dv.getUint16(pkgOff + 2, true);
  let off = pkgOff + headerSize;
  const end = pkgOff + pkgSize;
  while (off + 8 <= end) {
    const type = dv.getUint16(off, true), hs = dv.getUint16(off + 2, true), size = dv.getUint32(off + 4, true);
    if (size < 8) break;
    if (type === RES_TABLE_TYPE) {
      const typeId = dv.getUint8(off + 8), flags = dv.getUint8(off + 9);
      const entryCount = dv.getUint32(off + 12, true), entriesStart = dv.getUint32(off + 16, true);
      const cfg = off + 20;
      const language = String.fromCharCode(dv.getUint8(cfg + 8), dv.getUint8(cfg + 9)).replace(/\0/g, "");
      const density = dv.getUint16(cfg + 14, true);
      const sparse = (flags & 0x01) !== 0, offset16 = (flags & 0x02) !== 0;
      const idx = off + hs;
      const visit = (entryIndex, entryOff) => {
        const e = off + entriesStart + entryOff;
        if (e + 8 > off + size) return;
        const eFlags = dv.getUint16(e + 2, true);
        let dataType, data;
        if (eFlags & 0x08) { dataType = eFlags >>> 8; data = dv.getUint32(e + 4, true); } // compact entry
        else if (eFlags & 0x01) return;                                                  // complex (bag): not needed
        else { const v = e + dv.getUint16(e, true); dataType = dv.getUint8(v + 3); data = dv.getUint32(v + 4, true); }
        const id = ((pkgId << 24) | (typeId << 16) | entryIndex) >>> 0;
        let list = entries.get(id); if (!list) entries.set(id, (list = []));
        list.push({ language, density, type: dataType, data });
      };
      if (sparse) {
        for (let i = 0; i < entryCount; i++) visit(dv.getUint16(idx + i * 4, true), dv.getUint16(idx + i * 4 + 2, true) * 4);
      } else if (offset16) {
        for (let i = 0; i < entryCount; i++) { const o = dv.getUint16(idx + i * 2, true); if (o !== 0xffff) visit(i, o * 4); }
      } else {
        for (let i = 0; i < entryCount; i++) { const o = dv.getUint32(idx + i * 4, true); if (o !== 0xffffffff) visit(i, o); }
      }
    }
    off += size;
  }
}

// Resolve a reference to a string (label) or file path (icon), following reference chains.
function resolve(table, value, pickDensity) {
  for (let hops = 0; hops < 6 && value && typeof value === "object" && "ref" in value; hops++) {
    if (!table) return null;
    let cands = table.lookup(value.ref);
    if (!cands.length) return null;
    let c;
    if (pickDensity) {
      // Prefer bitmap icons (png/webp), highest density; adaptive-icon XML can't be shown as an image.
      const files = cands.filter((x) => x.type === TYPE_STRING).map((x) => ({ ...x, path: table.values.get(x.data) || "" }));
      const bitmaps = files.filter((x) => /\.(png|webp|jpe?g)$/i.test(x.path)).sort((a, b) => (b.density === 0xffff ? 0 : b.density) - (a.density === 0xffff ? 0 : a.density));
      if (bitmaps.length) return bitmaps[0].path;
      c = files.find((x) => x.path.endsWith(".xml")) || cands[0];
    } else {
      c = cands.find((x) => !x.language) || cands.find((x) => x.language === "en") || cands[0];
    }
    if (c.type === TYPE_STRING) return table.values.get(c.data);
    if (c.type === TYPE_REFERENCE) { value = { ref: c.data }; continue; }
    return null;
  }
  return typeof value === "string" ? value : null;
}

// An adaptive icon's XML points at a foreground (and background) drawable; use it if it's a bitmap.
function iconFromAdaptiveXml(xml, table) {
  try {
    const els = parseAxml(xml);
    for (const tag of ["foreground", "background"]) {
      const el = els.find((e) => e.name === tag);
      const d = el && (el.attrs.drawable || Object.values(el.attrs).find((v) => v && typeof v === "object"));
      const p = d && resolve(table, d, true);
      if (p && /\.(png|webp|jpe?g)$/i.test(p)) return p;
    }
  } catch {}
  return null;
}

const MIME = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };

/**
 * Reads one APK (as bytes). Returns { package, versionName, versionCode, minSdk, targetSdk, label,
 * icon (Blob|null), permissions[], split (string|null), abis[] }.
 */
export function readApk(bytes) {
  const wanted = new Set(["AndroidManifest.xml", "resources.arsc"]);
  const abiSet = new Set();
  // unzipSync's filter sees every entry name: note native-library ABIs without extracting them.
  const files = unzipSync(bytes, {
    filter: (f) => {
      const m = f.name.match(/^lib\/([^/]+)\/[^/]+\.so$/); if (m) abiSet.add(m[1]);
      return wanted.has(f.name);
    },
  });
  if (!files["AndroidManifest.xml"]) throw new Error("This file isn't an Android app (no AndroidManifest.xml).");
  const els = parseAxml(files["AndroidManifest.xml"]);
  const manifest = els.find((e) => e.name === "manifest")?.attrs || {};
  const sdk = els.find((e) => e.name === "uses-sdk")?.attrs || {};
  const appEl = els.find((e) => e.name === "application")?.attrs || {};
  const permissions = [...new Set(els.filter((e) => /^uses-permission(-sdk-23|-sdk-m)?$/.test(e.name)).map((e) => e.attrs.name).filter((n) => typeof n === "string"))].sort();

  let table = null;
  if (files["resources.arsc"]) { try { table = parseArsc(files["resources.arsc"]); } catch {} }
  const label = typeof appEl.label === "string" ? appEl.label : resolve(table, appEl.label, false);
  const versionName = typeof manifest.versionName === "string" ? manifest.versionName : resolve(table, manifest.versionName, false);

  let icon = null;
  try {
    const one = (name) => unzipSync(bytes, { filter: (f) => f.name === name })[name];
    let iconPath = resolve(table, appEl.icon, true) || resolve(table, appEl.roundIcon, true);
    if (iconPath?.endsWith(".xml")) {
      const xml = one(iconPath);
      iconPath = xml ? iconFromAdaptiveXml(xml, table) : null;
    }
    const data = iconPath && one(iconPath);
    if (data) icon = new Blob([data], { type: MIME[iconPath.split(".").pop().toLowerCase()] || "image/png" });
  } catch {}

  return {
    package: typeof manifest.package === "string" ? manifest.package : null,
    versionName: versionName || null,
    versionCode: typeof manifest.versionCode === "number" ? manifest.versionCode >>> 0 : null,
    minSdk: typeof sdk.minSdkVersion === "number" ? sdk.minSdkVersion : null,
    targetSdk: typeof sdk.targetSdkVersion === "number" ? sdk.targetSdkVersion : null,
    label: label || null,
    icon,
    permissions,
    split: typeof manifest.split === "string" ? manifest.split : null,
    abis: [...abiSet],
  };
}

const ABI_SPLIT = { arm64_v8a: "arm64-v8a", armeabi_v7a: "armeabi-v7a", armeabi: "armeabi", x86: "x86", x86_64: "x86_64", mips: "mips", mips64: "mips64" };

/**
 * Opens what the user dropped: one .apk, several .apk files (a split set), or a bundle
 * (.apks / .xapk / .apkm zip of APKs, possibly with OBB data). Returns
 * { base, splits: [{ name, split, bytes, size }], obb: [{ path, bytes }], sourceName }.
 */
export async function openPackageFiles(fileList) {
  const files = [...fileList];
  const apkParts = [], obb = [];
  for (const f of files) {
    const lower = f.name.toLowerCase();
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (lower.endsWith(".apk")) { apkParts.push({ name: f.name, bytes }); continue; }
    if (/\.(apks|xapk|apkm|zip)$/.test(lower)) {
      let entries;
      try { entries = unzipSync(bytes, { filter: (e) => /\.apk$/i.test(e.name) || /^Android\/obb\//i.test(e.name) }); }
      catch { throw new Error(`${f.name} couldn't be opened. Encrypted .apkm files from APKMirror need the APKMirror Installer app.`); }
      for (const [name, data] of Object.entries(entries)) {
        if (/^Android\/obb\//i.test(name) && !name.endsWith("/")) obb.push({ path: name, bytes: data });
        else if (/\.apk$/i.test(name)) apkParts.push({ name: name.split("/").pop(), bytes: data });
      }
      continue;
    }
    throw new Error(`${f.name} isn't an app file. Drop an .apk, .apks, .xapk or .apkm.`);
  }
  if (!apkParts.length) throw new Error("No APK found in what you dropped.");

  const parsed = apkParts.map((p) => ({ ...p, size: p.bytes.byteLength, info: readApk(p.bytes) }));
  const bases = parsed.filter((p) => !p.info.split);
  if (bases.length !== 1) throw new Error(bases.length ? "These files contain more than one app. Drop one app at a time." : "The base APK is missing from this set of splits.");
  const base = bases[0];
  const others = parsed.filter((p) => p !== base);
  const wrong = others.find((p) => p.info.package && p.info.package !== base.info.package);
  if (wrong) throw new Error(`${wrong.name} belongs to a different app (${wrong.info.package}).`);
  const sourceName = files.length === 1 ? files[0].name : `${files.length} files`;
  return {
    info: base.info, sourceName, obb,
    parts: [base, ...others].map((p) => ({ name: p.name, split: p.info.split, bytes: p.bytes, size: p.size, abis: p.info.abis })),
  };
}

/**
 * Chooses which splits to install on this phone: the base, feature splits, every language/density
 * split, and only the best-matching CPU-architecture split (installing a mismatched ABI split fails).
 */
export function selectSplits(parts, deviceAbis) {
  const abiOf = (p) => { const m = p.split?.match(/(?:^|\.)config\.([a-z0-9_]+)$/); return m && ABI_SPLIT[m[1]] ? ABI_SPLIT[m[1]] : null; };
  const abiParts = parts.filter(abiOf);
  let bestAbi = null;
  for (const abi of deviceAbis) if (abiParts.some((p) => abiOf(p) === abi)) { bestAbi = abi; break; }
  const chosen = [], skipped = [];
  for (const p of parts) {
    const abi = abiOf(p);
    if (abi && abi !== bestAbi) skipped.push(p); else chosen.push(p);
  }
  return { chosen, skipped, abi: bestAbi, needsAbi: abiParts.length > 0 && !bestAbi };
}

// Runtime permissions users usually care about (shown first, highlighted).
export const SENSITIVE_PERMISSIONS = new Set([
  "READ_SMS", "SEND_SMS", "RECEIVE_SMS", "READ_CALL_LOG", "WRITE_CALL_LOG", "PROCESS_OUTGOING_CALLS", "READ_CONTACTS", "WRITE_CONTACTS",
  "GET_ACCOUNTS", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "CAMERA", "RECORD_AUDIO",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "BODY_SENSORS", "BODY_SENSORS_BACKGROUND",
  "ACTIVITY_RECOGNITION", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES",
  "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "READ_CALENDAR", "WRITE_CALENDAR", "BLUETOOTH_SCAN", "NEARBY_WIFI_DEVICES",
  "SYSTEM_ALERT_WINDOW", "REQUEST_INSTALL_PACKAGES", "QUERY_ALL_PACKAGES", "BIND_ACCESSIBILITY_SERVICE",
  "BIND_NOTIFICATION_LISTENER_SERVICE", "BIND_DEVICE_ADMIN", "PACKAGE_USAGE_STATS", "USE_FULL_SCREEN_INTENT",
]);
