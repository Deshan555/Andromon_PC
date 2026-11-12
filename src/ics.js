// iCalendar (RFC 5545) writer and reader for the Calendar tab and phone backups. No DOM, no
// libraries. Events use the companion's shape:
//   {id, calendarId, title, location, description, start, end (ms), allDay, timezone, rrule,
//    rdate?, exdate?, duration?, originalId?, originalInstanceTime?, status?, uid?, attendees?}
// Written files have no VTIMEZONE blocks: timed events are in UTC, all-day events are DATE values.
// (A repeating event's original time zone is kept in X-DROIDDESK-TZ, so importing a Droid Desk
// file gives the phone the same zone back and its repeats stay at the same local time.)

const pad = (n, w = 2) => String(n).padStart(w, "0");
const DAY = 86400000;

export const icsEscape = (s) => String(s ?? "")
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
export const icsUnescape = (s) => String(s ?? "").replace(/\\([nN;,\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

const enc = new TextEncoder();
/** Folds a content line at 75 octets; continuation lines start with one space. Never splits a character. */
export function icsFold(line) {
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = "", bytes = 0, max = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > max) { out.push(cur); cur = ""; bytes = 0; max = 74; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export const utcStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
export const utcDate = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

/** Offset (local − UTC, ms) of an IANA zone at a given instant. Throws for unknown zones. */
function tzOffset(tz, utcMs) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
/** A wall-clock time in an IANA zone → UTC ms. */
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = tzOffset(tz, guess);
  let utc = guess - off;
  const off2 = tzOffset(tz, utc);
  if (off2 !== off) utc = guess - off2;
  return utc;
}
export function validZone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * One date-time value → {ms, date (true for DATE values), floating}. tz: TZID parameter (may be "").
 * Floating times (no Z, no usable zone) are read in this computer's zone.
 */
export function parseIcsTime(value, tz = "") {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (m[4] == null) return { ms: Date.UTC(y, mo - 1, d), date: true, floating: false };
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] || 0)];
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), date: false, floating: false };
  if (tz && validZone(tz)) return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), date: false, floating: false };
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), date: false, floating: true };
}

/** "P1DT2H", "PT30M", "P2W", "P3600S" (Android writes that) → ms, or null. */
export function parseDuration(s) {
  const m = String(s || "").trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m || !/\d/.test(s)) return null;
  const ms = ((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 86400 + Number(m[4] || 0) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/**
 * Android's EXDATE / RDATE column → UTC ms values. It holds lines like
 * "20260105T090000Z,20260112T090000Z", "Europe/Berlin;20260105T100000" or "20260105".
 */
export function androidDates(text, fallbackTz = "") {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let tz = fallbackTz, body = line.trim();
    if (!body) continue;
    const semi = body.indexOf(";");
    if (semi > 0 && !/^\d/.test(body)) { tz = body.slice(0, semi).replace(/^TZID=/i, ""); body = body.slice(semi + 1); }
    for (const v of body.split(",")) { const t = parseIcsTime(v, tz); if (t) out.push(t.ms); }
  }
  return out;
}

const STATUS = { 0: "TENTATIVE", 1: "CONFIRMED", 2: "CANCELLED" };
const PARTSTAT = { 1: "ACCEPTED", 2: "DECLINED", 3: "NEEDS-ACTION", 4: "TENTATIVE" };
const uidOf = (e) => (e.uid && String(e.uid).trim()) || `droiddesk-${e.calendarId ?? 0}-${e.id ?? 0}@droiddesk`;
const qParam = (s) => `"${String(s).replace(/["\r\n]/g, "'")}"`;
// RRULE text is passed through as it is, but only when it looks like a rule (so it can't smuggle
// in other lines or properties).
const cleanRule = (s) => {
  const r = String(s).replace(/^(RRULE|EXRULE):/i, "").trim();
  return /^[A-Za-z0-9=;,+\-]+$/.test(r) && /(^|;)FREQ=/i.test(r) ? r : "";
};

function eventLines(e, { calendarName, stamp, exdates = [], recurrenceId = null }) {
  const allDay = !!e.allDay;
  const start = Number(e.start), endRaw = Number(e.end);
  const end = isFinite(endRaw) && endRaw >= start ? endRaw : start;
  const when = (name, ms) => (allDay ? `${name};VALUE=DATE:${utcDate(ms)}` : `${name}:${utcStamp(ms)}`);
  const L = ["BEGIN:VEVENT", `UID:${icsEscape(uidOf(e))}`, `DTSTAMP:${stamp}`, when("DTSTART", start)];
  if (allDay) L.push(when("DTEND", end > start ? end : start + DAY)); // DTEND of a DATE event is the day after
  else if (end > start) L.push(when("DTEND", end));
  if (recurrenceId != null) L.push(when("RECURRENCE-ID", recurrenceId));
  L.push(`SUMMARY:${icsEscape(e.title)}`);
  if (e.location) L.push(`LOCATION:${icsEscape(e.location)}`);
  if (e.description) L.push(`DESCRIPTION:${icsEscape(e.description)}`);
  if (recurrenceId == null) {
    for (const r of String(e.rrule || "").split(/\r?\n/)) if (cleanRule(r)) L.push(`RRULE:${cleanRule(r)}`);
    const rdates = androidDates(e.rdate, e.timezone);
    if (rdates.length) L.push(allDay ? `RDATE;VALUE=DATE:${rdates.map(utcDate).join(",")}` : `RDATE:${rdates.map(utcStamp).join(",")}`);
    const ex = [...new Set([...androidDates(e.exdate, e.timezone), ...exdates])].sort((a, b) => a - b);
    if (ex.length) L.push(allDay ? `EXDATE;VALUE=DATE:${ex.map(utcDate).join(",")}` : `EXDATE:${ex.map(utcStamp).join(",")}`);
  }
  if (STATUS[e.status]) L.push(`STATUS:${STATUS[e.status]}`);
  for (const a of e.attendees || []) {
    if (!a?.email || /[\s<>]/.test(a.email)) continue;
    L.push(`ATTENDEE${a.name ? `;CN=${qParam(a.name)}` : ""}${PARTSTAT[a.status] ? `;PARTSTAT=${PARTSTAT[a.status]}` : ""}:mailto:${a.email}`);
  }
  if (e.timezone && !allDay && /^[\w+\-/]+$/.test(e.timezone)) L.push(`X-DROIDDESK-TZ:${e.timezone}`);
  if (calendarName) L.push(`X-DROIDDESK-CALENDAR:${icsEscape(calendarName)}`);
  L.push("END:VEVENT");
  return L;
}

/** events (+ calendars for their names) → iCalendar text with CRLF line ends. */
export function writeIcs(events, { calendars = [], name = "", now = Date.now() } = {}) {
  const calName = new Map(calendars.map((c) => [c.id, c.name || ""]));
  const stamp = utcStamp(now);
  const byId = new Map(events.map((e) => [e.id, e]));
  // Changed or cancelled single occurrences of a repeating event are separate rows on Android.
  const cancelled = new Map(); // parent id -> [instance ms]
  for (const e of events) {
    if (e.originalId != null && byId.has(e.originalId) && Number(e.status) === 2 && isFinite(Number(e.originalInstanceTime))) {
      if (!cancelled.has(e.originalId)) cancelled.set(e.originalId, []);
      cancelled.get(e.originalId).push(Number(e.originalInstanceTime));
    }
  }
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Droid Desk//Droid Desk//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  if (name) L.push(`X-WR-CALNAME:${icsEscape(name)}`);
  let count = 0;
  for (const e of events) {
    if (!isFinite(Number(e.start))) continue;
    const opts = { calendarName: calName.get(e.calendarId) || "", stamp };
    if (e.originalId != null) {
      const parent = byId.get(e.originalId);
      if (Number(e.status) === 2) continue; // became an EXDATE of its parent (or the parent isn't exported)
      if (parent && isFinite(Number(e.originalInstanceTime))) {
        L.push(...eventLines({ ...e, uid: uidOf(parent) }, { ...opts, recurrenceId: Number(e.originalInstanceTime) }));
        count++; continue;
      }
    }
    L.push(...eventLines(e, { ...opts, exdates: cancelled.get(e.id) || [] }));
    count++;
  }
  L.push("END:VCALENDAR");
  return { text: L.map(icsFold).join("\r\n") + "\r\n", count };
}

/** Splits "NAME;P1=a;P2="b:c":value" into {name, params, value}. */
export function parseContentLine(line) {
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = []; let cur = ""; quoted = false;
  for (const ch of head) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ";" && !quoted) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const params = {};
  for (const p of parts.slice(1)) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1); }
  return { name: parts[0].replace(/^[^.]*\./, "").toUpperCase(), params, value };
}

const STATUS_CODE = { TENTATIVE: 0, CONFIRMED: 1, CANCELLED: 2 };
const MAX_EVENTS = 20000;

/**
 * iCalendar text → {events, name, skipped, floating, unknownZones}. Events are ready for the
 * companion's calendar.add. Changed occurrences (RECURRENCE-ID) become events of their own and an
 * EXDATE on the series, because the phone can't link them through this API; cancelled ones become
 * just the EXDATE. To-dos, journals, alarms and time-zone blocks are ignored.
 */
export function parseIcs(text) {
  const lines = String(text ?? "").replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = []; const unknownZones = new Set();
  let cur = null, depth = [], skipped = 0, floating = 0, name = "";
  const time = (p) => {
    const tz = p.params.TZID || "";
    const t = parseIcsTime(p.value, tz);
    if (t && tz && !validZone(tz)) unknownZones.add(tz);
    return t;
  };
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const p = parseContentLine(raw.trimEnd());
    if (!p) continue;
    if (p.name === "BEGIN") {
      const kind = p.value.trim().toUpperCase();
      depth.push(kind);
      if (kind === "VEVENT" && depth.filter((k) => k !== "VCALENDAR").length === 1) cur = { rrule: [], exdate: [], rdate: [], attendees: [] };
      continue;
    }
    if (p.name === "END") {
      const kind = p.value.trim().toUpperCase();
      const at = depth.lastIndexOf(kind);
      if (at >= 0) depth.length = at;
      if (kind === "VEVENT" && cur) {
        const done = cur; cur = null;
        if (!done.startT) { skipped++; continue; }
        if (events.length >= MAX_EVENTS) { skipped++; continue; }
        events.push(done);
      }
      continue;
    }
    if (!cur) { if (p.name === "X-WR-CALNAME" && depth[depth.length - 1] === "VCALENDAR") name = icsUnescape(p.value).trim(); continue; }
    if (depth[depth.length - 1] !== "VEVENT") continue; // inside VALARM etc.
    switch (p.name) {
      case "UID": cur.uid = icsUnescape(p.value).trim(); break;
      case "SUMMARY": cur.title = icsUnescape(p.value); break;
      case "LOCATION": cur.location = icsUnescape(p.value); break;
      case "DESCRIPTION": cur.description = icsUnescape(p.value); break;
      case "DTSTART": cur.startT = time(p); cur.tz = p.params.TZID || ""; break;
      case "DTEND": cur.endT = time(p); break;
      case "DURATION": cur.durationMs = parseDuration(p.value); break;
      case "RRULE": if (cleanRule(p.value)) cur.rrule.push(cleanRule(p.value)); break;
      case "EXDATE": for (const v of p.value.split(",")) { const t = parseIcsTime(v, p.params.TZID || ""); if (t) cur.exdate.push(t.ms); } break;
      case "RDATE": if ((p.params.VALUE || "").toUpperCase() !== "PERIOD") for (const v of p.value.split(",")) { const t = parseIcsTime(v, p.params.TZID || ""); if (t) cur.rdate.push(t.ms); } break;
      case "RECURRENCE-ID": cur.recT = time(p); break;
      case "STATUS": cur.status = STATUS_CODE[p.value.trim().toUpperCase()]; break;
      case "X-DROIDDESK-TZ": cur.ddTz = p.value.trim(); break;
      case "X-DROIDDESK-CALENDAR": cur.calendarName = icsUnescape(p.value); break;
    }
  }
  // Link changed/cancelled occurrences to their series.
  const series = new Map();
  for (const e of events) if (!e.recT && e.uid && e.rrule.length) series.set(e.uid, e);
  const out = [];
  for (const e of events) {
    const allDay = e.startT.date;
    if (e.startT.floating) floating++;
    if (e.recT) {
      const parent = e.uid && series.get(e.uid);
      if (parent) parent.exdate.push(e.recT.ms);
      if (e.status === 2) continue;
    } else if (e.status === 2) { skipped++; continue; }
    const start = e.startT.ms;
    let end = e.endT ? e.endT.ms : e.durationMs != null ? start + e.durationMs : allDay ? start + DAY : start;
    if (!(end >= start)) end = allDay ? start + DAY : start;
    if (allDay && end === start) end = start + DAY;
    const tz = allDay ? "UTC" : validZone(e.ddTz) ? e.ddTz : validZone(e.tz) ? e.tz : "";
    out.push({ src: e, ev: { title: e.title || "", location: e.location || "", description: e.description || "", start, end, allDay, timezone: tz, rrule: e.recT ? "" : e.rrule.join("\n"), uid: e.uid || "", calendarName: e.calendarName || "" } });
  }
  for (const { src, ev } of out) {
    if (src.recT) continue;
    const fmt = (list) => [...new Set(list)].sort((a, b) => a - b).map(utcStamp).join(",");
    if (src.exdate.length && ev.rrule) ev.exdate = fmt(src.exdate);
    if (src.rdate.length) ev.rdate = fmt(src.rdate);
    if (src.status != null) ev.status = src.status;
  }
  return { events: out.map((x) => x.ev), name, skipped, floating, unknownZones: [...unknownZones] };
}
