// Calendar tab: the phone's calendars as an agenda (one month at a time, grouped by day), with a
// calendar filter, search across all dates, export to .ics and import from .ics into a calendar
// the person chooses. The phone expands repeating events (calendar.list with from/to returns the
// occurrences); this file only draws them. Event text comes from the phone or from a file:
// it is only ever inserted as text.
import { writeIcs, parseIcs } from "./ics.js";

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const colorOf = (c) => (/^#[0-9a-f]{6}$/i.test(c?.color || "") ? c.color : "var(--muted)");

export function initCalendar(h) {
  const { $, el, toast, showError, clearError, busy, cc, download, spinner } = h;
  const st = {
    built: false, calendars: [], off: new Set(), month: firstOfMonth(new Date()),
    events: new Map(), instances: [], all: null, q: "", loading: 0, open: new Set(),
  };
  let ui = null;

  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  const emptyBox = (text) => el("div", { className: "empty", textContent: text });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { timeStyle: "short" });
  // An all-day event lives on UTC midnights; a timed one is shown in this computer's time.
  const dayKeyLocal = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayKeyUtc = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const keyToDate = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const calById = (id) => st.calendars.find((c) => c.id === id);
  const shown = (ev) => !st.off.has(ev.calendarId);

  async function ready() {
    await h.ensurePerms(["READ_CALENDAR", "WRITE_CALENDAR"]);
    h.needPermission("READ_CALENDAR", "calendar");
  }

  function build() {
    if (st.built) return;
    st.built = true;
    const prev = el("button", { className: "btn sm", type: "button", textContent: "‹", title: "Previous month" });
    const next = el("button", { className: "btn sm", type: "button", textContent: "›", title: "Next month" });
    const today = el("button", { className: "btn sm", type: "button", textContent: "Today" });
    const title = el("b", { className: "cal-month" });
    const search = el("input", { type: "search", placeholder: "Search all events…" });
    const exp = el("button", { className: "btn sm", type: "button", textContent: "Export .ics" });
    const imp = el("button", { className: "btn sm", type: "button", textContent: "Import .ics" });
    const fileIn = el("input", { type: "file", accept: ".ics,.ical,.ifb,text/calendar", hidden: true });
    const reload = el("button", { className: "btn sm", type: "button", textContent: "Reload" });
    const filter = el("div", { className: "chips cal-filter" });
    const summary = el("div", { className: "muted small", style: "margin-top:10px" });
    const importBox = el("div", { className: "card", hidden: true });
    const agenda = el("div", { className: "cal-agenda" });
    ui = { title, filter, summary, importBox, agenda, search };
    prev.onclick = () => { st.month = new Date(st.month.getFullYear(), st.month.getMonth() - 1, 1); loadMonth().catch(showError); };
    next.onclick = () => { st.month = new Date(st.month.getFullYear(), st.month.getMonth() + 1, 1); loadMonth().catch(showError); };
    today.onclick = () => { st.month = firstOfMonth(new Date()); search.value = ""; st.q = ""; loadMonth().then(() => ui.agenda.querySelector(".cal-day.today")?.scrollIntoView({ block: "start", behavior: "smooth" })).catch(showError); };
    reload.onclick = () => { st.all = null; loadMonth().catch(showError); };
    let timer = 0;
    search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = search.value.trim().toLowerCase(); render().catch(showError); }, 200); };
    exp.onclick = async () => {
      busy(exp, true, "Exporting…");
      try {
        const { text, count } = await exportIcs({ only: (e) => shown(e) });
        if (!count) return toast("No events to export");
        const d = new Date();
        download(new Blob([text], { type: "text/calendar" }), `calendar-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.ics`);
        toast(`Exported ${count} events`);
      } catch (e) { showError(e); } finally { busy(exp, false); }
    };
    imp.onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; fileIn.value = ""; if (!f) return;
      try {
        if (f.size > 64 * 1024 * 1024) throw new Error("That file is too large for a calendar file.");
        showImport(f.name, parseIcs(await f.text()));
      } catch (e) { showError(e); }
    };
    $("calMain").replaceChildren(
      importBox,
      el("div", { className: "card" },
        el("div", { className: "toolbar" }, prev, title, next, today, search, exp, imp, fileIn, reload),
        filter, summary),
      agenda);
  }

  // ---- data ----
  async function loadMonth() {
    const token = ++st.loading;
    ui.title.textContent = st.month.toLocaleDateString([], { month: "long", year: "numeric" });
    ui.agenda.replaceChildren(el("div", { className: "card" }, el("div", { className: "empty" }, spinner(), " Loading the calendar…")));
    const from = st.month.getTime() - DAY; // a day either side: all-day events sit on UTC midnights
    const to = new Date(st.month.getFullYear(), st.month.getMonth() + 1, 1).getTime() + DAY;
    const r = await cc("calendar.list", { from, to });
    if (token !== st.loading) return;
    const firstLoad = !st.calendars.length;
    st.calendars = Array.isArray(r?.calendars) ? r.calendars : [];
    if (firstLoad) for (const c of st.calendars) if (c.visible === false) st.off.add(c.id); // as on the phone
    st.events = new Map((r?.events || []).map((e) => [e.id, e]));
    st.instances = Array.isArray(r?.instances) ? r.instances : [];
    await render();
  }
  async function fetchAll(force = false) {
    if (!st.all || force) {
      const r = await cc("calendar.list", {});
      st.all = { calendars: r?.calendars || [], events: r?.events || [] };
      if (!st.calendars.length) st.calendars = st.all.calendars;
    }
    return st.all;
  }
  /** Every event (or those passing `only`) as iCalendar text. Used by Export and by phone backups. */
  async function exportIcs({ only = () => true, name = "" } = {}) {
    await ready();
    const all = await fetchAll(true);
    const events = all.events.filter(only);
    return { ...writeIcs(events, { calendars: all.calendars, name }), calendars: all.calendars };
  }
  /** Adds events to one calendar in batches. → {added, skipped, failed} */
  async function addEvents(calendarId, events, onProgress = () => {}) {
    await ready();
    h.needPermission("WRITE_CALENDAR", "calendar-write");
    const total = { added: 0, skipped: 0, failed: 0 };
    for (let i = 0; i < events.length; i += 200) {
      const r = await cc("calendar.add", { calendarId, events: events.slice(i, i + 200) });
      for (const k of Object.keys(total)) total[k] += Number(r?.[k]) || 0;
      onProgress(Math.min(i + 200, events.length), events.length);
    }
    st.all = null;
    return total;
  }
  /** Calendars events can be added to. */
  async function writableCalendars() {
    await ready();
    const all = await fetchAll(true);
    return all.calendars.filter((c) => c.writable);
  }
  const createLocal = async (name) => (await cc("calendar.createLocal", name ? { name } : {}))?.id;

  // ---- drawing ----
  function renderFilter() {
    const chips = st.calendars.map((c) => {
      const on = !st.off.has(c.id);
      const dot = el("i", { className: "cal-dot" }); dot.style.background = colorOf(c);
      const b = el("button", { className: "chip cal-chip" + (on ? " on" : ""), type: "button", title: `${c.account || "On the phone"}${c.writable ? "" : " · read only"}` }, dot, el("span", { textContent: c.name || c.account || "Calendar" }));
      b.setAttribute("aria-pressed", String(on));
      b.onclick = () => { if (on) st.off.add(c.id); else st.off.delete(c.id); render().catch(showError); };
      return b;
    });
    ui.filter.replaceChildren(...(chips.length ? chips : [el("span", { className: "muted small", textContent: "No calendars on this phone yet. Import an .ics file to create one." })]));
  }

  function eventRow(ev, when, key) {
    const cal = calById(ev.calendarId);
    const dot = el("i", { className: "cal-dot" }); dot.style.background = colorOf(cal);
    const row = el("button", { className: "cal-ev", type: "button" },
      el("span", { className: "cal-when", textContent: when }), dot,
      el("span", { className: "cal-what" },
        el("span", { className: "cal-title", textContent: (ev.title || "(no title)") + (ev.rrule ? "  ↻" : "") }),
        ev.location ? el("span", { className: "sub", textContent: ev.location }) : ""),
      el("span", { className: "muted small hide-sm", textContent: cal?.name || "" }));
    const wrap = el("div", { className: "cal-item" }, row);
    const detail = () => {
      const lines = [];
      if (ev.description) lines.push(el("div", { className: "cal-desc", textContent: ev.description }));
      if (ev.rrule) lines.push(el("div", { className: "sub", textContent: `Repeats: ${ev.rrule}` }));
      if (ev.attendees?.length) lines.push(el("div", { className: "sub", textContent: `Guests: ${ev.attendees.map((a) => a.name || a.email).filter(Boolean).join(", ")}` }));
      lines.push(el("div", { className: "sub", textContent: `${cal?.name || "Calendar"}${cal?.account ? ` · ${cal.account}` : ""}${ev.timezone && !ev.allDay ? ` · ${ev.timezone}` : ""}` }));
      return el("div", { className: "cal-detail" }, ...lines);
    };
    if (st.open.has(key)) wrap.append(detail());
    row.onclick = () => {
      if (st.open.has(key)) { st.open.delete(key); wrap.lastChild.remove(); }
      else { st.open.add(key); wrap.append(detail()); }
    };
    return wrap;
  }

  function renderMonth() {
    const y = st.month.getFullYear(), m = st.month.getMonth();
    const monthPrefix = `${y}-${pad(m + 1)}-`;
    const days = new Map(); // "YYYY-MM-DD" -> [{ev, inst, when, sort}]
    let count = 0;
    for (const inst of st.instances) {
      const ev = st.events.get(inst.eventId);
      if (!ev || !shown(ev)) continue;
      const allDay = !!ev.allDay;
      const begin = Number(inst.begin), end = Math.max(begin, Number(inst.end) || begin);
      // Days this occurrence covers: an all-day end is the day after; a timed one ending at midnight doesn't reach the next day.
      const first = allDay ? keyToDate(dayKeyUtc(begin)) : keyToDate(dayKeyLocal(begin));
      const lastMs = end > begin ? end - 1 : end;
      const last = allDay ? keyToDate(dayKeyUtc(lastMs)) : keyToDate(dayKeyLocal(lastMs));
      let listed = false;
      for (let d = new Date(first), n = 0; d <= last && n < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1), n++) {
        const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        if (!key.startsWith(monthPrefix)) continue;
        const isFirst = d.getTime() === first.getTime(), isLast = d.getTime() === last.getTime();
        const when = allDay ? "All day" : isFirst && isLast ? `${fmtTime(begin)} – ${fmtTime(end)}` : isFirst ? `${fmtTime(begin)} →` : isLast ? `→ ${fmtTime(end)}` : "All day";
        if (!days.has(key)) days.set(key, []);
        days.get(key).push({ ev, when, sort: allDay || !isFirst ? -1 : begin, key: `${ev.id}:${begin}:${key}` });
        listed = true;
      }
      if (listed) count++;
    }
    const todayKey = dayKeyLocal(Date.now());
    const cards = [...days.keys()].sort().map((key) => {
      const d = keyToDate(key);
      const rows = days.get(key).sort((a, b) => a.sort - b.sort || String(a.ev.title).localeCompare(String(b.ev.title)));
      return el("div", { className: "card cal-day" + (key === todayKey ? " today" : "") },
        el("div", { className: "cal-date" }, el("b", { textContent: String(d.getDate()) }), el("span", { textContent: d.toLocaleDateString([], { weekday: "long" }) + (key === todayKey ? " · today" : "") })),
        el("div", { className: "cal-list" }, ...rows.map((r) => eventRow(r.ev, r.when, r.key))));
    });
    ui.summary.textContent = `${count} event${count === 1 ? "" : "s"} in ${st.month.toLocaleDateString([], { month: "long", year: "numeric" })} · times are shown in this computer's time zone`;
    ui.agenda.replaceChildren(...(cards.length ? cards : [el("div", { className: "card" }, emptyBox(st.calendars.length ? "Nothing planned this month." : "No calendars on this phone."))]));
  }

  async function renderSearch() {
    const token = st.loading;
    if (!st.all) ui.agenda.replaceChildren(el("div", { className: "card" }, el("div", { className: "empty" }, spinner(), " Searching…")));
    const all = await fetchAll();
    if (token !== st.loading || !st.q) return;
    const q = st.q;
    const has = (s) => String(s || "").toLowerCase().includes(q);
    const hits = all.events.filter((e) => shown(e) && e.originalId == null && (has(e.title) || has(e.location) || has(e.description)))
      .sort((a, b) => b.start - a.start);
    const rows = hits.slice(0, 300).map((ev) => {
      const start = Number(ev.start);
      const date = ev.allDay ? keyToDate(dayKeyUtc(start)).toLocaleDateString([], { dateStyle: "medium" }) : new Date(start).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      return eventRow(ev, (ev.rrule ? "from " : "") + date, `s:${ev.id}`);
    });
    ui.summary.textContent = `${hits.length} event${hits.length === 1 ? "" : "s"} match in all dates` + (hits.length > 300 ? " · showing the newest 300" : "");
    ui.agenda.replaceChildren(el("div", { className: "card cal-day cal-results" }, el("div", { className: "cal-list" }, ...(rows.length ? rows : [emptyBox("No matches")]))));
  }

  async function render() {
    renderFilter();
    if (st.q) await renderSearch(); else renderMonth();
  }

  // ---- import ----
  async function showImport(fileName, parsed) {
    const box = ui.importBox;
    box.hidden = false;
    const close = () => { box.hidden = true; box.replaceChildren(); };
    const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
    cancel.onclick = close;
    const events = parsed.events;
    if (!events.length) {
      box.replaceChildren(el("h2", { textContent: "Nothing to import" }), el("p", { className: "muted", textContent: `No events were found in ${fileName}.` }), cancel);
      return;
    }
    box.replaceChildren(el("div", { className: "empty" }, spinner(), " Reading the phone's calendars…"));
    let cals = [];
    try { cals = await writableCalendars(); } catch (e) { close(); throw e; }
    const NEW = "__new__";
    const pick = el("select", {}, ...cals.map((c) => el("option", { value: String(c.id), textContent: `${c.name || "Calendar"}${c.account ? ` (${c.account})` : ""}` })),
      el("option", { value: NEW, textContent: "A new calendar kept only on the phone (“Andromon”)" }));
    const preferred = cals.find((c) => c.primary) || cals[0];
    pick.value = preferred ? String(preferred.id) : NEW;
    const repeating = events.filter((e) => e.rrule).length;
    const range = events.reduce((r, e) => [Math.min(r[0], e.start), Math.max(r[1], e.start)], [Infinity, -Infinity]);
    const fmt = (ms) => new Date(ms).toLocaleDateString([], { dateStyle: "medium" });
    const status = el("span", { className: "muted" });
    const add = el("button", { className: "btn primary", type: "button", textContent: `Add ${events.length} events` });
    add.onclick = async () => {
      busy(add, true, "Adding…"); cancel.disabled = true; clearError();
      try {
        let id = pick.value === NEW ? await createLocal() : Number(pick.value);
        if (id == null || !isFinite(Number(id))) throw new Error("The phone couldn't create a calendar.");
        const r = await addEvents(Number(id), events, (n, total) => { status.textContent = `${n} of ${total}…`; });
        const done = el("button", { className: "btn", type: "button", textContent: "Close" });
        done.onclick = close;
        box.replaceChildren(el("h2", { textContent: "Import finished" }),
          el("p", { className: "muted", textContent: `${r.added} events added · ${r.skipped} already in that calendar${r.failed ? ` · ${r.failed} couldn't be added` : ""}` }), done);
        await loadMonth();
      } catch (e) { showError(e); status.textContent = ""; }
      finally { if (add.isConnected) { busy(add, false); cancel.disabled = false; } }
    };
    const notes = [
      `${events.length} events${repeating ? ` (${repeating} repeating)` : ""}, from ${fmt(range[0])} to ${fmt(range[1])}${parsed.name ? `, calendar “${parsed.name}”` : ""}. Events the chosen calendar already has (same title and start) are skipped.`,
      "Guests and reminders are not imported, so nobody gets an invitation. If the calendar syncs with an account, the new events sync there too.",
      parsed.skipped ? `${parsed.skipped} entries were skipped (cancelled, or without a start time).` : "",
      parsed.unknownZones.length ? `Unknown time zone${parsed.unknownZones.length === 1 ? "" : "s"} (${parsed.unknownZones.slice(0, 3).join(", ")}): those events are read in this computer's time zone.` : "",
      parsed.floating && !parsed.unknownZones.length ? `${parsed.floating} events have no time zone and are read in this computer's time zone.` : "",
    ];
    box.replaceChildren(el("h2", { textContent: `Import ${events.length} events from ${fileName}?` }),
      ...notes.filter(Boolean).map((t) => el("p", { className: "muted", textContent: t })),
      el("div", { className: "toolbar", style: "margin:0" }, el("span", { className: "muted", textContent: "Add to" }), pick, add, cancel, status));
    box.scrollIntoView({ block: "nearest" });
  }

  return {
    async load() {
      await h.withCompanion($("calGate"), $("calMain"), async () => {
        await ready();
        build();
        try { await loadMonth(); }
        catch (e) {
          if (!/Unknown method/.test(e?.message)) throw e;
          ui.agenda.replaceChildren();
          throw new Error("The Andromon Companion on the phone is too old for the Calendar. Remove it (Apps tab → dev.andromon.companion → Uninstall) and open this tab again, so Andromon installs the current one.");
        }
      });
    },
    onDisconnected() {
      st.calendars = []; st.off.clear(); st.events = new Map(); st.instances = []; st.all = null; st.open.clear(); st.loading++;
      if (ui) { ui.agenda.replaceChildren(); ui.importBox.hidden = true; ui.importBox.replaceChildren(); }
    },
    exportIcs, addEvents, writableCalendars, createLocal,
  };
}
