// Andromon — finds personal data in a piece of text, for "Blur personal data" (the PC window, see
// src/privacyblur.js) and for blurring phone screenshots (Settings › Screenshot). Two ways in:
//  - patterns: IMEI/MEID, SIM number (ICCID), phone numbers, emails, IPv4/IPv6 and MAC addresses,
//    GPS coordinates;
//  - known values: the connected phone's own IMEI, serial, number, account names, Wi‑Fi name...,
//    registered with setKnownPii() as they are read, matched exactly wherever they show up.
// Things no pattern can recognise (message text, contact names, street addresses) are marked where
// they are drawn instead (data-pii in the PC window; by app and view in phone screenshots).

const known = new Set();
/** Adds exact values (strings of 4+ characters) to blur wherever they appear. */
export function setKnownPii(values) {
  const before = known.size;
  for (const v of [].concat(values || [])) { const s = String(v ?? "").trim(); if (s.length >= 4 && !/^(unknown|null|none|0+)$/i.test(s)) known.add(s); }
  if (known.size !== before) globalThis.dispatchEvent?.(new Event("andromon:pii-known")); // the window blur scans again
}
/** A phone's name is personal only when someone changed it ("Deshan's S20"); a stock model name isn't. */
export const personalName = (name) => {
  const s = String(name ?? "").trim();
  return /['’]s\b/.test(s) || !/^(galaxy|pixel|redmi|oneplus|xiaomi|poco|moto|nokia|oppo|vivo|realme|huawei|honor|sony|xperia|samsung|sm-|nothing|android)/i.test(s) ? s : "";
};
export const knownPii = () => [...known];

const digits = (s) => s.replace(/\D/g, "");
const PATTERNS = [
  ["email", /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ["mac", /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi],
  ["ipv6", /(?:\b[0-9a-f]{1,4})?(?:::?[0-9a-f]{1,4}){2,7}\b/gi],
  ["ipv4", /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g],
  ["coords", /-?\b\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g],
  ["meid", /\b[0-9A-F]{14}\b/g], // hex MEID; all-digit 14s are caught as numbers below
  // IMEI (15), ICCID (19–20) and phone numbers: runs of digits with the usual separators.
  ["number", /(?:\+|\(|\b)\d(?:[\s\-()]{0,2}\d){6,19}\b/g],
];

// A run of digits that is a date, a time, a size or a version, not a phone number.
function notANumber(m, text, at) {
  const d = digits(m);
  if (d.length < 7 || d.length > 20) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) || /^\d{2}[-/]\d{2}[-/]\d{4}$/.test(m.trim())) return true; // dates
  const before = text.slice(Math.max(0, at - 1), at), after = text.slice(at + m.length, at + m.length + 3);
  if (/[.:,]/.test(before) || /^[.:]\d/.test(after)) return true; // part of a version, decimal or time
  if (/^\s?(?:[kKMGT]?B|%|ms|px|dpi|mAh|Hz)\b/.test(after)) return true;
  return false;
}

/** Every piece of personal data in `text`: [{ start, end, kind }], sorted and not overlapping. */
export function findPii(text) {
  text = String(text ?? "");
  const hits = [];
  if (text.length < 4) return hits;
  for (const v of known) for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + v.length)) hits.push({ start: i, end: i + v.length, kind: "known" });
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text)); ) {
      if (kind === "number" && notANumber(m[0], text, m.index)) continue;
      if (kind === "meid" && !/[A-F]/.test(m[0])) continue;
      if (kind === "ipv6" && !m[0].includes("::") && m[0].split(":").length < 5) continue; // 10:45:22 is a time
      hits.push({ start: m.index, end: m.index + m[0].length, kind });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const h of hits) if (!out.length || h.start >= out[out.length - 1].end) out.push(h);
  return out;
}
export const hasPii = (text) => findPii(text).length > 0;
