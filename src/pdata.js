// Personal-data file formats and logic, kept free of DOM and phone access so node can test it:
// vCard (with photos), the "SMS Backup & Restore" compatible XML for messages and calls, the call
// log CSV, duplicate contacts and their merge, and safe file names for anything written to disk.
// Everything read here comes from the phone or from a file someone picked: treat it as untrusted.

// ---------- file names ----------
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
/** One path segment that is safe to create on Windows, macOS and Linux. Never "", "." or "..". */
export function safeName(s, fallback = "file") {
  let n = String(s ?? "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  if (n.length > 120) {
    const ext = (n.match(/\.[A-Za-z0-9]{1,8}$/) || [""])[0];
    n = n.slice(0, 120 - ext.length).replace(/[\s.]+$/, "") + ext;
  }
  if (!n) n = fallback;
  if (RESERVED.test(n)) n = "_" + n;
  return n;
}
/** A relative path ("a/b/c.jpg") made only of safe segments; "..", "." and empty parts are dropped. */
export function safeRelPath(p, fallback = "file") {
  const parts = String(p ?? "").split(/[\\/]+/).filter((x) => x && x !== "." && x !== "..").map((x) => safeName(x, "_"));
  return parts.length ? parts.join("/") : fallback;
}
const MIME_EXT = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/3gpp": "3gp", "video/3gpp2": "3g2", "video/webm": "webm", "video/quicktime": "mov",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/amr": "amr", "audio/ogg": "ogg", "audio/aac": "aac", "audio/3gpp": "3gp", "audio/wav": "wav",
  "text/x-vcard": "vcf", "text/vcard": "vcf", "text/calendar": "ics", "application/pdf": "pdf", "text/plain": "txt",
};
export const extForMime = (mime) => MIME_EXT[String(mime || "").toLowerCase().split(";")[0].trim()] || "bin";
/** File name for an MMS attachment: its own name when it has one, always with an extension. */
export function attachmentName(part, mmsId) {
  const raw = String(part?.name || "").replace(/^<|>$/g, "").split(/[\\/]/).pop();
  let n = safeName(raw, "");
  if (!n) n = `attachment-${part?.partId ?? 0}`;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(n)) n += "." + extForMime(part?.mime);
  return mmsId == null ? n : `${mmsId}-${part?.partId ?? 0}-${n}`;
}

// ---------- CSV ----------
// CSV cell; neutralises spreadsheet formulas (=, @, or +/- followed by a non-digit).
export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=@\t\r]/.test(s) || /^[+-][^\d\s]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
/** RFC 4180 reader: quoted cells, doubled quotes, line breaks inside quotes. Returns rows of strings. */
export function parseCsv(text) {
  const t = String(text ?? "").replace(/^\ufeff/, "");
  const rows = []; let row = [], cell = "", quoted = false, any = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === "") { quoted = true; any = true; }
    else if (ch === ",") { row.push(cell); cell = ""; any = true; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      if (any || cell !== "") { row.push(cell); rows.push(row); }
      row = []; cell = ""; any = false;
    } else cell += ch;
  }
  if (any || cell !== "") { row.push(cell); rows.push(row); }
  return rows;
}
// Undoes csvCell's formula guard.
const csvPlain = (s) => /^'[=@\t\r+-]/.test(s) ? s.slice(1) : s;

// ---------- XML (attribute-only records, as SMS Backup & Restore writes them) ----------
export const xmlAttr = (s) => String(s ?? "")
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function xmlUnescape(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return "";
      // SMS Backup & Restore writes emoji as two surrogate references; fromCharCode joins them again.
      return code <= 0xffff ? String.fromCharCode(code) : String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}
/** Yields {name, attrs, end} for every start tag with one of the given names. Attributes only; no DOM. */
export function* xmlTags(text, names, wantAttrs = () => true) {
  const re = new RegExp(`<(${names.join("|")})(?=[\\s/>])`, "g");
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex;
    const attrs = {}, keep = wantAttrs(m[1]);
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length || text[i] === ">" || text[i] === "/") break;
      let j = i;
      while (j < text.length && !/[\s=>/]/.test(text[j])) j++;
      const key = text.slice(i, j);
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== "=") { i = j === i ? j + 1 : j; continue; }
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") { i = j; continue; }
      const k = text.indexOf(q, j + 1);
      if (k < 0) { i = text.length; break; }
      if (keep && key) attrs[key] = xmlUnescape(text.slice(j + 1, k));
      i = k + 1;
    }
    re.lastIndex = i;
    yield { name: m[1], attrs, end: i };
  }
}
const nullable = (v) => (v == null || v === "null" ? "" : String(v));

// ---------- messages: XML compatible with "SMS Backup & Restore" ----------
/**
 * sms: [{address, body, date, dateSent, type, read}], mms: the companion's mms.list entries.
 * partRef(mms, part) may return {data: base64} to embed an attachment or {file: "mms/…"} to point at
 * a file saved next to the XML (Andromon's own attribute, ignored by other apps); null = neither.
 */
export function buildSmsXml({ sms = [], mms = [], nameFor = () => "", fmtDate = () => "", partRef = () => null }) {
  const out = [`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>`, `<!-- Written by Andromon. Same layout as the "SMS Backup & Restore" app. -->`,
    `<smses count="${sms.length + mms.length}">`];
  for (const m of sms) {
    out.push(`  <sms protocol="0" address="${xmlAttr(m.address)}" date="${Number(m.date) || 0}" type="${Number(m.type) || 1}" subject="null" body="${xmlAttr(m.body)}" toa="null" sc_toa="null" service_center="null" read="${m.read ? 1 : 0}" status="-1" locked="0" date_sent="${Number(m.dateSent) || 0}" readable_date="${xmlAttr(fmtDate(m.date))}" contact_name="${xmlAttr(nameFor(m.address) || "(Unknown)")}" />`);
  }
  for (const m of mms) {
    const people = mmsPeople(m);
    const incoming = Number(m.type) === 1;
    const atts = m.parts || [];
    out.push(`  <mms date="${Number(m.date) || 0}" msg_box="${Number(m.type) || 1}" address="${xmlAttr(people.join("~"))}" sub="${xmlAttr(m.subject || "null")}" read="${m.read ? 1 : 0}" seen="1" locked="0" date_sent="${Number(m.dateSent) || 0}" m_type="${incoming ? 132 : 128}" ct_t="application/vnd.wap.multipart.related" text_only="${atts.length ? 0 : 1}" readable_date="${xmlAttr(fmtDate(m.date))}" contact_name="${xmlAttr(people.map((a) => nameFor(a) || a).join(", ") || "(Unknown)")}">`);
    out.push("    <parts>");
    let seq = 0;
    if (m.text) out.push(`      <part seq="${seq++}" ct="text/plain" name="null" chset="106" cd="null" fn="null" cid="&lt;text&gt;" cl="text" ctt_s="null" ctt_t="null" text="${xmlAttr(m.text)}" />`);
    for (const p of atts) {
      const ref = partRef(m, p) || {};
      const extra = (ref.data ? ` data="${xmlAttr(ref.data)}"` : "") + (ref.file ? ` dd_file="${xmlAttr(ref.file)}"` : "");
      out.push(`      <part seq="${seq++}" ct="${xmlAttr(p.mime || "application/octet-stream")}" name="${xmlAttr(p.name || "null")}" chset="null" cd="null" fn="null" cid="null" cl="${xmlAttr(p.name || "null")}" ctt_s="null" ctt_t="null" text="null" dd_size="${Number(p.size) || 0}"${extra} />`);
    }
    out.push("    </parts>", "    <addrs>");
    if (m.from) out.push(`      <addr address="${xmlAttr(m.from)}" type="137" charset="106" />`);
    else out.push(`      <addr address="insert-address-token" type="137" charset="106" />`);
    for (const a of m.to || []) out.push(`      <addr address="${xmlAttr(a)}" type="151" charset="106" />`);
    out.push("    </addrs>", "  </mms>");
  }
  out.push("</smses>");
  return out.join("\n");
}

/** Reads the XML above (or a real SMS Backup & Restore file). MMS entries are only counted. */
export function parseSmsXml(text) {
  const sms = []; let mmsCount = 0, bad = 0;
  // <part> and <addr> are walked too (without keeping anything), so text inside their quoted
  // values, such as attachment data, is never mistaken for a message.
  for (const tag of xmlTags(String(text ?? ""), ["sms", "mms", "part", "addr"], (n) => n === "sms")) {
    if (tag.name === "mms") { mmsCount++; continue; }
    if (tag.name !== "sms") continue;
    const a = tag.attrs;
    const date = Number(a.date), type = Number(a.type);
    const address = nullable(a.address).trim(), body = nullable(a.body);
    if (!isFinite(date) || date <= 0 || !(type >= 1 && type <= 6) || (!address && !body)) { bad++; continue; }
    sms.push({ address, body, date, dateSent: Number(a.date_sent) > 0 ? Number(a.date_sent) : 0, type, read: a.read !== "0" });
  }
  return { sms, mmsCount, bad };
}

// ---------- MMS helpers ----------
const sameNumber = (a, b) => {
  const x = String(a || "").replace(/\D/g, ""), y = String(b || "").replace(/\D/g, "");
  return x.length >= 6 && y.length >= 6 ? x.slice(-9) === y.slice(-9) : String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
};
const uniqNumbers = (list) => {
  const out = [];
  for (const a of list) { const s = String(a || "").trim(); if (s && s !== "insert-address-token" && !out.some((x) => sameNumber(x, s))) out.push(s); }
  return out;
};
/** The other people in an MMS: the thread's recipients when the phone knows them, else sender + receivers. */
export function mmsPeople(m) {
  if (m?.recipients?.length) return uniqNumbers(m.recipients);
  return uniqNumbers(Number(m?.type) === 1 ? [m.from, ...(m.to || [])] : (m?.to || []));
}
/**
 * Works out who is in a conversation. msgs: SMS ({address}) and MMS ({mms:true, from, to, recipients}).
 * Without the phone's own list, an incoming MMS names this phone among its receivers; a number that
 * only ever shows up as a receiver of incoming messages (never as a sender, never as a receiver of
 * ours) is taken to be this phone and left out.
 */
export function threadPeople(msgs) {
  const withList = msgs.find((m) => m.mms && m.recipients?.length);
  if (withList) return uniqNumbers(withList.recipients);
  const sent = msgs.filter((m) => m.mms && Number(m.type) !== 1 && m.to?.length);
  if (sent.length) return uniqNumbers(sent.flatMap((m) => m.to));
  const senders = uniqNumbers(msgs.map((m) => (m.mms ? (Number(m.type) === 1 ? m.from : "") : m.address)));
  const mmsIn = msgs.filter((m) => m.mms && Number(m.type) === 1);
  const others = uniqNumbers(mmsIn.flatMap((m) => m.to || [])).filter((a) => !senders.some((s) => sameNumber(s, a)));
  // In every incoming group message "me" is among the receivers; anyone else is too, or is the sender.
  const me = others.filter((a) => mmsIn.every((m) => (m.to || []).some((t) => sameNumber(t, a))));
  const rest = others.filter((a) => !me.includes(a));
  // One such number is this phone; with several we can't tell which, so all are shown.
  return uniqNumbers([...senders, ...rest, ...(me.length > 1 ? me : [])]);
}

// ---------- call log: CSV and XML ----------
export const CALL_TYPE_NAMES = { 1: "Incoming", 2: "Outgoing", 3: "Missed", 4: "Voicemail", 5: "Declined", 6: "Blocked", 7: "Answered elsewhere" };
const CALL_TYPE_CODES = Object.fromEntries(Object.entries(CALL_TYPE_NAMES).map(([k, v]) => [v.toLowerCase(), Number(k)]));
Object.assign(CALL_TYPE_CODES, { rejected: 5, received: 1, dialed: 2, dialled: 2 });
export const CALLS_CSV_HEADER = ["Date", "Type", "Number", "Name", "Duration (s)"];
export function buildCallsCsv(calls, nameFor = () => "") {
  return "\ufeff" + toCsv(CALLS_CSV_HEADER, calls.map((c) => [new Date(c.date).toISOString(), CALL_TYPE_NAMES[c.type] || c.type, c.number, c.name || nameFor(c.number), c.duration]));
}
export function buildCallsXml(calls, nameFor = () => "", fmtDate = () => "") {
  const out = [`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>`, `<calls count="${calls.length}">`];
  for (const c of calls) {
    out.push(`  <call number="${xmlAttr(c.number)}" duration="${Number(c.duration) || 0}" date="${Number(c.date) || 0}" type="${Number(c.type) || 1}" presentation="${c.number ? 1 : 2}" readable_date="${xmlAttr(fmtDate(c.date))}" contact_name="${xmlAttr(c.name || nameFor(c.number) || "(Unknown)")}" />`);
  }
  out.push("</calls>");
  return out.join("\n");
}
const validCall = (c) => isFinite(c.date) && c.date > 0 && c.type >= 1 && c.type <= 7 && isFinite(c.duration) && c.duration >= 0;
/** Reads Andromon's call-log CSV or a <calls> XML file. Returns {calls, bad}. */
export function parseCallsFile(text) {
  const t = String(text ?? "").replace(/^\ufeff/, "");
  const calls = []; let bad = 0;
  if (/^\s*</.test(t)) {
    for (const tag of xmlTags(t, ["call"])) {
      const a = tag.attrs;
      const name = nullable(a.contact_name);
      const c = { number: nullable(a.number).trim(), date: Number(a.date), duration: Math.round(Number(a.duration) || 0), type: Number(a.type), name: name === "(Unknown)" ? "" : name };
      if (validCall(c)) calls.push(c); else bad++;
    }
    return { calls, bad };
  }
  const rows = parseCsv(t);
  if (!rows.length) return { calls, bad };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const iDate = col("date"), iType = col("type"), iNum = col("number"), iName = col("name"), iDur = col("duration");
  if (iDate < 0 || iType < 0 || iNum < 0) throw new Error("This doesn't look like an Andromon call log (needs Date, Type and Number columns).");
  for (const r of rows.slice(1)) {
    const rawType = csvPlain(r[iType] || "").trim();
    const rawDate = (r[iDate] || "").trim();
    const c = {
      number: csvPlain(r[iNum] || "").trim(),
      date: /^\d{11,}$/.test(rawDate) ? Number(rawDate) : Date.parse(rawDate),
      duration: iDur >= 0 ? Math.round(Number(r[iDur]) || 0) : 0,
      type: /^\d+$/.test(rawType) ? Number(rawType) : CALL_TYPE_CODES[rawType.toLowerCase()] || 0,
      name: iName >= 0 ? csvPlain(r[iName] || "") : "",
    };
    if (validCall(c)) calls.push(c); else bad++;
  }
  return { calls, bad };
}

// ---------- vCard ----------
export const vEsc = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const VTEL = { mobile: "CELL", home: "HOME", work: "WORK", main: "MAIN", fax: "FAX" };
const utf8Len = (s) => new TextEncoder().encode(s).length;
/** Folds one content line at 75 octets (continuation lines start with a space), never inside a character. */
export function foldLine(line, limit = 75) {
  if (line.length <= limit && utf8Len(line) <= limit) return line;
  const out = []; let cur = "", bytes = 0, max = limit;
  for (const ch of line) {
    const n = utf8Len(ch);
    if (bytes + n > max) { out.push(cur); cur = ""; bytes = 0; max = limit - 1; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const photoKind = (b64) => (b64.startsWith("iVBOR") ? "PNG" : b64.startsWith("R0lG") ? "GIF" : b64.startsWith("UklG") ? "WEBP" : "JPEG");
/** vCard 3.0. photo: base64 image (optional). */
export function toVcard(c, photo) {
  const L = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vEsc(c.name)}`, `N:;${vEsc(c.name)};;;`];
  for (const p of c.phones || []) L.push(`TEL;TYPE=${VTEL[p.type] || "VOICE"}:${vEsc(p.number)}`);
  for (const m of c.emails || []) L.push(`EMAIL;TYPE=INTERNET${["home", "work"].includes(m.type) ? "," + m.type.toUpperCase() : ""}:${vEsc(m.address)}`);
  if (c.org) L.push(`ORG:${vEsc(c.org)}`);
  if (c.birthday) L.push(`BDAY:${vEsc(c.birthday)}`);
  if (c.note) L.push(`NOTE:${vEsc(c.note)}`);
  if (c.starred) L.push("X-ANDROMON-STARRED:1");
  const b64 = cleanBase64(photo ?? c.photo);
  if (b64) L.push(`PHOTO;ENCODING=b;TYPE=${photoKind(b64)}:${b64}`);
  L.push("END:VCARD");
  return L.map((l) => foldLine(l)).join("\r\n");
}

export const MAX_PHOTO_B64 = 4 * 1024 * 1024;
/** Base64 with whitespace removed, or "" when it isn't base64 (or is unreasonably large). */
export function cleanBase64(s) {
  if (typeof s !== "string" || !s) return "";
  const b = s.replace(/\s+/g, "");
  if (!b || b.length > MAX_PHOTO_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return "";
  return b;
}

export function decodeQuotedPrintable(s, charset = "utf-8") {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(s.charCodeAt(i) & 0xff);
  }
  try { return new TextDecoder(charset).decode(new Uint8Array(bytes)); } catch { return new TextDecoder().decode(new Uint8Array(bytes)); }
}
const vUnesc = (s) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const splitUnescaped = (s, ch) => s.split(new RegExp(`(?<!\\\\)${ch}`));

// Minimal vCard 2.1/3.0/4.0 reader: names, phones, emails, org, birthday, note, photo.
export function parseVcf(text) {
  let t = String(text ?? "").replace(/\r\n?/g, "\n");
  if (/QUOTED-PRINTABLE/i.test(t)) t = t.replace(/=\n/g, ""); // QP soft line breaks
  const lines = t.replace(/\n[ \t]/g, "").split("\n");        // unfold
  const out = []; let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^BEGIN:VCARD$/i.test(line)) { cur = { name: "", phones: [], emails: [] }; continue; }
    if (/^END:VCARD$/i.test(line)) { if (cur && (cur.name || cur.phones.length || cur.emails.length)) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const [prop0, ...params] = line.slice(0, i).split(";");
    const prop = prop0.replace(/^item\d+\./i, "").toUpperCase();
    const ps = params.join(";").toUpperCase();
    let value = line.slice(i + 1);
    if (/ENCODING=QUOTED-PRINTABLE/.test(ps)) value = decodeQuotedPrintable(value, (ps.match(/CHARSET=([\w-]+)/) || [])[1] || "utf-8");
    switch (prop) {
      case "FN": cur.name = vUnesc(value).trim(); break;
      case "N": if (!cur.name) {
        const [fam, giv, mid, pre, suf] = splitUnescaped(value, ";").map(vUnesc);
        cur.name = [pre, giv, mid, fam, suf].filter((x) => x && x.trim()).join(" ");
      } break;
      case "TEL": {
        const type = /CELL|MOBILE/.test(ps) ? "mobile" : /FAX/.test(ps) ? "fax" : /HOME/.test(ps) ? "home" : /WORK/.test(ps) ? "work" : /MAIN/.test(ps) ? "main" : "other";
        const number = vUnesc(value).replace(/^tel:/i, "").trim();
        if (number) cur.phones.push({ number, type });
      } break;
      case "EMAIL": {
        const address = vUnesc(value).trim();
        if (address) cur.emails.push({ address, type: /HOME/.test(ps) ? "home" : /WORK/.test(ps) ? "work" : "other" });
      } break;
      case "ORG": cur.org = vUnesc(splitUnescaped(value, ";")[0]); break;
      case "BDAY": cur.birthday = vUnesc(value); break;
      case "NOTE": cur.note = vUnesc(value); break;
      case "X-ANDROMON-STARRED": case "X-DROIDDESK-STARRED": if (value.trim() === "1") cur.starred = true; break;
      case "PHOTO": {
        // 3.0: ENCODING=b, 2.1: ENCODING=BASE64, 4.0: a data: URI. Links to pictures are not fetched.
        const data = /^data:/i.test(value) ? (value.match(/^data:[^,]*;base64,(.*)$/is) || [])[1] : /ENCODING=(B|BASE64)\b/.test(ps) ? value : "";
        const b64 = cleanBase64(data || "");
        if (b64) cur.photo = b64;
      } break;
    }
  }
  return out;
}

// ---------- duplicate contacts ----------
/** Comparable phone number: the last 9 digits (so +44 7700 900123 equals 07700 900123); short codes whole. */
export function normPhone(n) {
  const d = String(n ?? "").replace(/\D/g, "");
  if (d.length >= 7) return d.slice(-9);
  return d.length >= 3 ? "s" + d : "";
}
export const normEmail = (e) => String(e ?? "").trim().toLowerCase();
export const normName = (n) => String(n ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Groups contacts that share a phone number or an e-mail address, or have exactly the same name.
 * Returns [{contacts: [...], reasons: ["phone" | "email" | "name"]}], largest groups first.
 */
export function findDuplicateGroups(contacts) {
  const parent = contacts.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const links = [];
  const seen = new Map();
  const link = (key, i, reason) => {
    if (!key) return;
    const k = reason[0] + ":" + key;
    if (!seen.has(k)) { seen.set(k, i); return; }
    const j = seen.get(k);
    if (j === i) return;
    links.push([i, reason]);
    const a = find(i), b = find(j);
    if (a !== b) parent[a] = b;
  };
  contacts.forEach((c, i) => {
    for (const p of c.phones || []) link(normPhone(p.number), i, "phone");
    for (const m of c.emails || []) link(normEmail(m.address), i, "email");
    link(normName(c.name), i, "name");
  });
  const groups = new Map();
  contacts.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { contacts: [], reasons: [] });
    groups.get(r).contacts.push(c);
  });
  for (const [i, reason] of links) { const g = groups.get(find(i)); if (!g.reasons.includes(reason)) g.reasons.push(reason); }
  return [...groups.values()].filter((g) => g.contacts.length > 1).sort((a, b) => b.contacts.length - a.contacts.length);
}

const detailCount = (c) => (c.phones?.length || 0) + (c.emails?.length || 0) + (c.org ? 1 : 0) + (c.note ? 1 : 0) + (c.birthday ? 1 : 0) + (c.hasPhoto ? 2 : 0) + (c.name ? 1 : 0);
/** The contact worth keeping: the one with the most details (ties: the first). */
export const richestContact = (list) => list.reduce((best, c) => (detailCount(c) > detailCount(best) ? c : best), list[0]);

/** One contact with the union of everyone's details. `keep` decides the id, name and single-value fields. */
export function mergeContacts(list, keep = richestContact(list)) {
  const order = [keep, ...list.filter((c) => c !== keep)];
  const first = (f) => order.map(f).find((v) => v != null && String(v).trim() !== "") || "";
  const phones = [], emails = [];
  for (const c of order) {
    for (const p of c.phones || []) {
      const k = normPhone(p.number) || String(p.number).trim();
      if (k && !phones.some((x) => (normPhone(x.number) || String(x.number).trim()) === k)) phones.push({ number: p.number, type: p.type || "other" });
    }
    for (const m of c.emails || []) {
      const k = normEmail(m.address);
      if (k && !emails.some((x) => normEmail(x.address) === k)) emails.push({ address: m.address, type: m.type || "other" });
    }
  }
  const notes = [];
  for (const c of order) { const n = String(c.note || "").trim(); if (n && !notes.includes(n)) notes.push(n); }
  const out = { id: keep.id, name: first((c) => c.name), phones, emails, starred: order.some((c) => c.starred) };
  const org = first((c) => c.org), birthday = first((c) => c.birthday);
  if (org) out.org = org;
  if (birthday) out.birthday = birthday;
  if (notes.length) out.note = notes.join("\n");
  return out;
}

/** True when `c` is already among `existing` (same name and no new phone/e-mail, or a shared number/e-mail with the same name or no name). */
export function makeContactMatcher(existing) {
  const phones = new Map(), emails = new Map(), names = new Set(); // key -> Set of names it is stored under
  const put = (map, k, n) => { if (!k) return; if (!map.has(k)) map.set(k, new Set()); map.get(k).add(n); };
  for (const c of existing) {
    const n = normName(c.name); if (n) names.add(n);
    for (const p of c.phones || []) put(phones, normPhone(p.number), n);
    for (const m of c.emails || []) put(emails, normEmail(m.address), n);
  }
  return (c) => {
    const n = normName(c.name);
    const pk = (c.phones || []).map((p) => normPhone(p.number)).filter(Boolean);
    const ek = (c.emails || []).map((m) => normEmail(m.address)).filter(Boolean);
    if (!pk.length && !ek.length) return !!n && names.has(n);
    // Every number and address is already on the phone, under the same name (or one side has no name).
    const same = (set) => !!set && (!n || set.has(n) || set.has(""));
    return pk.every((k) => same(phones.get(k))) && ek.every((k) => same(emails.get(k)));
  };
}

// ---------- small shared bits ----------
export function base64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** "2026-03-09 1405" in local time, for folder names. */
export function folderStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}
