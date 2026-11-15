// Phone links: the small things that tie the phone to this computer. On the Overview: send a
// link or text to the phone, a shared clipboard, Find my phone and a remote for whatever the
// phone is playing. In Contacts and Call log: the Call buttons (callButton).
//
// Phone side: Links.kt (push.send, clip.set, phone.ring), ClipSendActivity.kt (the phone's
// clipboard arrives as a {type:"clip"} event) and Player.kt (player.control, {type:"media"}
// events). app.js owns the companion's "events" stream and passes on what belongs here:
// onLinkState(), onHello() and onEvent().
//
// Every string from the phone is untrusted: it goes in with textContent / el(), never innerHTML.
// Clipboard contents are never logged, and never stored.

const RECENT_MAX = 6;
const CLIP_MAX = 200_000; // Links.MAX_CLIP on the phone
const RING_SECONDS = 120;

export function initLinks(base) {
  const { $, el, toast, showError, clearError, sh, shQuote, busy, armedClick, cc, getAdb, companionPkg } = base;

  const store = {
    get(key, def) { try { const v = localStorage.getItem("dd.links." + key); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(key, v) { try { localStorage.setItem("dd.links." + key, JSON.stringify(v)); } catch {} },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const NEEDS_UPDATE = "This needs a newer Droid Desk Companion on the phone.";
  // Older companions don't know these calls.
  const friendly = (e) => (/Unknown method/.test(e?.message || "") ? new Error(NEEDS_UPDATE) : e);
  // Runs a button's action with the usual spinner and error box.
  const run = async (btn, label, fn) => {
    busy(btn, true, label); clearError();
    try { await fn(); } catch (e) { showError(friendly(e)); } finally { if (btn.isConnected) busy(btn, false); }
  };

  let linkState = "off";   // the events stream, as app.js sees it (off, starting, on, noperm, missing, outdated…)
  let access = null;       // "Notification access" on the phone: needed for the media remote
  let triedGrant = false;
  const listening = () => linkState === "on" || linkState === "noperm";

  // ---------- needs the companion ----------
  function renderGate() {
    const gate = $("lkGate");
    const need = !!getAdb() && (linkState === "missing" || linkState === "outdated");
    gate.hidden = !need;
    for (const id of ["lkSendText", "lkSendBtn", "lkClipTo", "lkClipFrom", "lkRingBtn"]) $(id).disabled = need;
    if (!need) return;
    const status = el("span", { className: "sub" });
    const btn = el("button", { className: "btn sm primary", type: "button", textContent: linkState === "outdated" ? "Update companion" : "Install companion" });
    btn.onclick = () => run(btn, "Installing…", async () => {
      await base.ensureCompanion((m) => { status.textContent = m; });
      base.restartEvents();
    });
    gate.replaceChildren(
      el("div", { className: "grow", textContent: linkState === "outdated"
        ? "Phone links need a newer Droid Desk Companion on the phone."
        : "Phone links need the Droid Desk Companion app on the phone." }),
      status, btn);
  }

  // ---------- 1. send a link or text to the phone ----------
  let recent = store.get("recent", []).filter((t) => typeof t === "string").slice(0, RECENT_MAX);

  function renderRecent() {
    const box = $("lkRecent");
    if (!recent.length) { box.replaceChildren(); return; }
    const chips = recent.map((text) => {
      const c = el("button", { className: "lk-chip", type: "button", title: "Put this back in the box", textContent: text.length > 60 ? text.slice(0, 60) + "…" : text });
      c.onclick = () => { $("lkSendText").value = text; $("lkSendText").focus(); };
      return c;
    });
    const clear = el("button", { className: "lk-chip clear", type: "button", textContent: "Clear", title: "Forget the recent list" });
    clear.onclick = () => { recent = []; store.set("recent", recent); renderRecent(); };
    box.replaceChildren(el("span", { className: "sub", textContent: "Recent" }), ...chips, clear);
  }

  async function sendToPhone(raw) {
    const text = String(raw || "").trim();
    if (!text) return;
    if (!getAdb()) throw new Error("Connect a phone first.");
    const r = await cc("push.send", { text });
    recent = [text.slice(0, 2000), ...recent.filter((t) => t !== text.slice(0, 2000))].slice(0, RECENT_MAX);
    store.set("recent", recent); renderRecent();
    let msg = !r?.link ? "Text sent to the phone" : r.opened ? "Link opened on the phone" : "Link sent: tap the notification on the phone";
    if (r?.notified === false) msg += r.opened ? "" : " (notifications are off for the companion app)";
    toast(msg);
  }

  $("lkSendForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("lkSendText");
    if (!input.value.trim()) { input.focus(); return; }
    run($("lkSendBtn"), "Sending…", async () => { await sendToPhone(input.value); input.value = ""; });
  });
  {
    // A link dragged from the browser (or selected text) dropped on the card is sent straight away.
    const card = $("lkSendCard");
    const hasText = (dt) => !!dt && [...dt.types].some((t) => t === "text/uri-list" || t === "text/plain");
    card.addEventListener("dragover", (e) => { if (hasText(e.dataTransfer)) { e.preventDefault(); card.classList.add("over"); } });
    card.addEventListener("dragleave", () => card.classList.remove("over"));
    card.addEventListener("drop", (e) => {
      card.classList.remove("over");
      if (!hasText(e.dataTransfer)) return;
      e.preventDefault();
      const uri = e.dataTransfer.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
      const text = (uri || e.dataTransfer.getData("text/plain") || "").trim();
      if (!text || $("lkSendBtn").disabled) return;
      run($("lkSendBtn"), "Sending…", () => sendToPhone(text));
    });
  }

  // ---------- 2. shared clipboard ----------
  let clipWaiter = null;   // resolves with the next {type:"clip"} event ("Get phone's clipboard")
  let pendingClip = null;  // text from the phone that couldn't be written while the window was in the background

  // Browsers only let the focused window write the clipboard. Text sent from the phone while
  // Droid Desk is in the background is kept in memory until the window is used again.
  function writeClip(text) {
    navigator.clipboard.writeText(text).then(
      () => { pendingClip = null; toast("Copied from phone"); },
      () => { pendingClip = text; toast("The phone sent its clipboard: click this window to copy it here"); });
  }
  window.addEventListener("focus", () => {
    if (pendingClip == null) return;
    const text = pendingClip; pendingClip = null;
    setTimeout(() => writeClip(text), 50);
  });

  $("lkClipTo").addEventListener("click", () => run($("lkClipTo"), "Copying…", async () => {
    let text;
    try { text = await navigator.clipboard.readText(); }
    catch { throw new Error("Couldn't read this computer's clipboard. Paste the text into “Send to phone” instead."); }
    if (!text) { toast("This computer's clipboard has no text"); return; }
    if (text.length > CLIP_MAX) throw new Error(`That's too long for the phone's clipboard (the limit is ${CLIP_MAX.toLocaleString()} characters).`);
    await cc("clip.set", { text });
    toast("Copied to the phone's clipboard");
  }));

  $("lkClipFrom").addEventListener("click", () => run($("lkClipFrom"), "Asking the phone…", async () => {
    if (!listening()) throw new Error("Droid Desk isn't listening to the phone yet. Try again in a moment.");
    const got = new Promise((resolve) => { clipWaiter = resolve; });
    try {
      // Android only lets the app on screen read the clipboard, so this opens the companion's
      // see-through screen for a moment (ClipSendActivity); the text comes back as an event.
      const out = await sh(`am start -n ${companionPkg}/.ClipSendActivity`);
      if (/does not exist|unable to resolve/i.test(out)) throw new Error(NEEDS_UPDATE);
      if (/^Error|Exception/m.test(out)) throw new Error("The phone couldn't open the clipboard helper.");
      const ev = await Promise.race([got, wait(9000).then(() => null)]);
      if (!ev) throw new Error("The phone didn't answer. Unlock it and try again.");
      if (ev.error === "locked") throw new Error("Unlock the phone, then try again: Android only shows the clipboard to the app on screen.");
      if (ev.error) toast("Nothing is copied on the phone");
      // On success onEvent() has already put the text on this computer's clipboard.
    } finally { clipWaiter = null; }
  }));

  // ---------- 3. find my phone ----------
  let ringing = false, ringTimer = 0;
  function setRinging(on, seconds = RING_SECONDS) {
    ringing = !!on;
    clearTimeout(ringTimer);
    const btn = $("lkRingBtn");
    btn.textContent = ringing ? "Stop ringing" : "Ring my phone";
    btn.classList.toggle("primary", ringing);
    $("lkRingCard").classList.toggle("ringing", ringing);
    // The phone stops by itself; this is only for when its "stopped" event got lost.
    if (ringing) ringTimer = setTimeout(() => setRinging(false), (seconds + 5) * 1000);
  }
  $("lkRingBtn").addEventListener("click", async () => {
    const btn = $("lkRingBtn"), want = !ringing;
    let r = null;
    await run(btn, want ? "Ringing…" : "Stopping…", async () => { r = await cc("phone.ring", { on: want }); });
    if (!r) return;
    setRinging(r.ringing, r.seconds || RING_SECONDS);
    if (r.ringing) toast(r.sound === false ? "The phone is vibrating, but couldn't play a sound" : "The phone is ringing");
  });

  // ---------- 5. now playing on the phone ----------
  let media = null, mediaAt = 0, mediaTick = 0;
  const fmtTime = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const mediaPos = () => {
    if (!media) return 0;
    const p = Number(media.position) || 0, d = Number(media.duration) || 0;
    const now = media.state === "playing" ? p + (Date.now() - mediaAt) : p;
    return d > 0 ? Math.min(d, now) : now;
  };
  const control = (action, extra = {}) => {
    clearError();
    return cc("player.control", { action, pkg: media?.pkg || "", ...extra }).catch((e) => showError(friendly(e)));
  };

  function renderMedia() {
    clearInterval(mediaTick);
    const card = $("lkMedia");
    if (!media || !getAdb()) { card.hidden = true; card.replaceChildren(); return; }
    const playing = media.state === "playing";
    const dur = Number(media.duration) || 0;
    const art = typeof media.art === "string" && /^[A-Za-z0-9+/=]+$/.test(media.art)
      ? el("img", { className: "art", alt: "", src: "data:image/jpeg;base64," + media.art })
      : el("div", { className: "art", textContent: "♪" });
    const btn = (glyph, title, action) => {
      const b = el("button", { className: "btn", type: "button", textContent: glyph, title });
      b.setAttribute("aria-label", title);
      b.onclick = () => control(action);
      return b;
    };
    const by = [media.artist, media.album].filter(Boolean).join(" · ");
    const info = el("div", { className: "info" },
      el("div", { className: "sub", textContent: `Now playing on phone${media.app ? " · " + media.app : ""}` }),
      el("div", { className: "title", textContent: media.title || "Unknown title" }),
      by ? el("div", { className: "sub", textContent: by }) : "");
    const kids = [art, info, el("div", { className: "keys" },
      btn("⏮", "Previous", "prev"), btn(playing ? "⏸" : "▶", playing ? "Pause" : "Play", playing ? "pause" : "play"), btn("⏭", "Next", "next"))];
    if (dur > 0) {
      const range = el("input", { type: "range", min: 0, max: dur, step: 1000, value: mediaPos(), disabled: !media.canSeek, title: media.canSeek ? "Seek" : "" });
      range.setAttribute("aria-label", "Position");
      const time = el("span", { className: "sub" });
      let dragging = false;
      const show = () => { time.textContent = `${fmtTime(dragging ? Number(range.value) : mediaPos())} / ${fmtTime(dur)}`; };
      range.oninput = () => { dragging = true; show(); };
      range.onchange = () => {
        const position = Number(range.value);
        dragging = false;
        media.position = position; mediaAt = Date.now(); show();
        control("seek", { position });
      };
      show();
      mediaTick = setInterval(() => { if (!card.isConnected || card.hidden) return; if (!dragging) range.value = mediaPos(); show(); }, 1000);
      kids.push(el("div", { className: "prog" }, range, time));
    }
    card.replaceChildren(...kids);
    card.hidden = false;
  }

  // Shown instead of the player while the phone hasn't given the companion "Notification access":
  // Android only shows other apps' players to a notification listener. Turning it on is the same
  // step as the Notifications tab's switch (cmd notification allow_listener, over adb).
  function renderMediaHint() {
    const box = $("lkMediaHint");
    const show = !!getAdb() && listening() && access === false && !store.get("mediaHintOff", false);
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    const on = el("button", { className: "btn sm primary", type: "button", textContent: triedGrant ? "Try again" : "Turn on" });
    on.onclick = () => run(on, "Turning on…", async () => { triedGrant = true; await base.grantNotifAccess(); base.restartEvents(); });
    const later = el("button", { className: "btn sm", type: "button", textContent: "Not now" });
    later.onclick = () => { store.set("mediaHintOff", true); renderMediaHint(); };
    const acts = el("div", { className: "lk-row" }, on);
    if (triedGrant) {
      const open = el("button", { className: "btn sm", type: "button", textContent: "Open the setting on the phone" });
      open.onclick = () => sh("am start -a android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").then(() => toast("Turn on Droid Desk Companion on the phone"), showError);
      acts.append(open);
    }
    acts.append(later);
    box.replaceChildren(
      el("h3", { textContent: "Now playing on phone" }),
      el("p", { className: "sub", textContent: triedGrant
        ? "The phone hasn't given Droid Desk Companion “Notification access” yet. Turn it on in the phone's settings, or try again."
        : "See what the phone is playing and pause or skip it from here. Android shows other apps' players only to apps with “Notification access”, " +
          "the same access the Notifications tab uses. Droid Desk turns it on for the companion app over the connection; your notifications aren't shown here unless you switch that tab on." }),
      acts);
  }

  // ---------- 4. dial from the PC ----------
  // A Call button for a phone number (Contacts, Call log). Dials on the phone, like "Call back" on
  // a missed call; the second click confirms. Returns "" for things that aren't phone numbers.
  function callButton(number, name) {
    const raw = String(number || "").trim();
    if (!/^[+\d*#][\d*#\s().-]*$/.test(raw)) return "";
    const num = raw.replace(/[^\d+*#]/g, "");
    if (!num) return "";
    const who = String(name || "").trim() || raw;
    // An icon button: the first click arms it (it fills and shows "Call?"), the second one dials.
    const title = `Call ${who} from the phone (click twice)`;
    const b = el("button", { className: "lk-icon lk-call", type: "button", title },
      document.querySelector('#nav button[data-view="calls"] svg')?.cloneNode(true) || "", el("span", { textContent: "Call?" }));
    b.setAttribute("aria-label", title);
    let timer = 0;
    const disarm = () => { clearTimeout(timer); b.classList.remove("armed"); };
    b.addEventListener("click", async () => {
      if (!b.classList.contains("armed")) { b.classList.add("armed"); timer = setTimeout(disarm, 3000); return; }
      disarm();
      if (!getAdb()) return;
      clearError();
      try {
        // "#" would start a URI fragment, so it travels encoded (USSD codes such as *123#).
        const out = await sh(`am start -a android.intent.action.CALL -d ${shQuote("tel:" + num.replace(/#/g, "%23"))}`);
        if (/^Error|SecurityException/m.test(out)) throw new Error("The phone refused to start the call.");
        toast(`Calling ${who} on the phone`);
      } catch (e) { showError(e); }
    });
    return b;
  }

  // ---------- hooks for app.js ----------
  function reset() {
    media = null; access = null; triedGrant = false; pendingClip = null;
    if (clipWaiter) { clipWaiter({ error: "gone" }); clipWaiter = null; }
    setRinging(false);
    renderMedia(); renderMediaHint();
  }

  renderRecent(); renderGate();

  return {
    // The events stream stays open for these even when call alerts and notifications are off.
    wantsEvents: () => true,
    wantsMedia: () => true,
    callButton,
    onConnected() { reset(); renderGate(); },
    onDisconnected() { linkState = "off"; reset(); renderGate(); },
    // app.js › setCallAlertState: the state of the events stream.
    onLinkState(state) {
      linkState = state;
      if (!listening()) { media = null; renderMedia(); }
      renderGate(); renderMediaHint();
    },
    // The stream's first line: {type:"hello", notifications:{access, connected}}.
    onHello(ev) {
      access = ev?.notifications ? !!ev.notifications.access : null;
      if (access) triedGrant = false;
      renderMediaHint();
    },
    // Every other event that isn't a call or a notification.
    onEvent(ev) {
      if (ev.type === "clip") {
        if (typeof ev.text === "string" && ev.text) writeClip(ev.text);
        if (clipWaiter) { clipWaiter(ev); clipWaiter = null; }
      } else if (ev.type === "ring") {
        if (ev.on === false && ringing) { setRinging(false); toast(ev.reason === "found" ? "Found: the phone stopped ringing" : "The phone stopped ringing"); }
      } else if (ev.type === "media") {
        const nothing = ev.state === "none" || (ev.state === "stopped" && !ev.title);
        media = nothing ? null : ev; mediaAt = Date.now();
        if (media && access === false) { access = true; renderMediaHint(); }
        renderMedia();
      }
    },
  };
}
