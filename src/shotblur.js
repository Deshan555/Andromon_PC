// Andromon — "Blur personal data" for phone screenshots (Settings › Screenshot). Used by the Screenshot page
// and by the mirror's Save frame / Copy frame.
//
// How it works
// - While the picture is taken, the phone's list of on-screen elements is read with the same reader as Test
//   automation (./autotest.js: the ui-helper.jar process when it is running, `uiautomator dump` otherwise).
// - pickAreas() decides which elements to hide: anything whose text or description holds personal data
//   (./pii.js: numbers, emails, addresses, the phone's own IMEI, serial, Wi‑Fi name…); all text except buttons,
//   tabs and titles in messaging, contacts, phone, mail and chat apps (PERSONAL_APPS); notification text in the
//   shade and on the lock screen; and addresses in maps apps (MAPS_APPS).
// - Their bounds (phone screen pixels, in the current rotation) are scaled to the picture's own size, padded,
//   then pixelated, blurred and sprinkled with noise so the text can't be read or rebuilt.
// - It fails closed: if the screen can't be read in time, nothing is saved or copied unless the person
//   chooses to keep the picture without blur.
// Only text Android exposes can be found: pictures, games and some web pages aren't covered.
//
// Every string from the phone is untrusted: it is only matched, never inserted into the page.

import { hasPii } from "./pii.js";

// Apps whose screens are mostly someone's messages, contacts or calls: all their text is hidden except chrome.
export const PERSONAL_APPS = new Set([
  // text messages
  "com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.android.messaging",
  "com.textra", "com.verizon.messaging.vzmsgs", "com.motorola.messaging", "com.oneplus.mms", "com.miui.mms",
  // contacts, phone and call log
  "com.google.android.contacts", "com.samsung.android.app.contacts", "com.android.contacts", "com.google.android.dialer",
  "com.samsung.android.dialer", "com.android.dialer", "com.android.incallui", "com.samsung.android.incallui",
  "com.truecaller",
  // mail
  "com.google.android.gm", "com.microsoft.office.outlook", "com.samsung.android.email.provider", "com.android.email",
  "com.yahoo.mobile.client.android.mail", "ch.protonmail.android", "me.proton.android.mail", "com.fsck.k9", "com.readdle.spark",
  // chat
  "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "org.telegram.messenger.web", "org.thunderdog.challegram",
  "org.thoughtcrime.securesms", "com.facebook.orca", "com.facebook.mlite", "com.viber.voip", "com.discord", "com.snapchat.android",
  "jp.naver.line.android", "com.kakao.talk", "com.tencent.mm", "com.Slack", "com.microsoft.teams", "com.skype.raider",
  "com.google.android.apps.dynamite", "im.vector.app", "chat.simplex.app", "ch.threema.app", "com.wire",
]);
// Maps and ride apps: addresses, searched places and route ends are hidden.
export const MAPS_APPS = new Set([
  "com.google.android.apps.maps", "com.google.android.apps.mapslite", "com.waze", "com.here.app.maps", "net.osmand",
  "net.osmand.plus", "app.organicmaps", "com.mapswithme.maps.pro", "com.sygic.aura", "ru.yandex.yandexmaps",
  "com.citymapper.app.release", "com.ubercab", "com.bolt.android",
]);
const SYSTEM_UI = "com.android.systemui";

// Resource-id fragments.
const PERSONAL_ID = /name|contact|conversation|sender|from|recipient|participant|subject|snippet|message|msg|body|preview|bubble|number|phone|e_?mail|address|caller|avatar|photo|status_?text|last_?seen|chat_?title|chat_?name|quoted|reply_?text/i;
const CHROME_ID = /(^|[/_])(tab|tabs|button|btn|fab|menu|action|action_?bar_?title|toolbar_?title|title_?bar|app_?title|nav|navigation|bottom_?nav|filter|chip|hint|empty|section_?header|search_?hint)(?=[_\d]|$)/i;
const BAR = /Toolbar|ActionBar|TabLayout|TabWidget|BottomNavigation|NavigationBar|NavigationRail|BottomAppBar|(^|[/_])(toolbar|action_?bar|app_?bar|title_?bar|tab_?bar|tabs|bottom_?nav\w*|navigation_?bar)$/i;
const TAB_BAR = /TabLayout|TabWidget|BottomNavigation|NavigationBar|NavigationRail|(^|[/_])(tab_?bar|tabs|bottom_?nav\w*|navigation_?bar)$/i;
// Icons in a toolbar are told apart from a contact's photo there by what they are called.
const ICON_DESC = /^(more options|navigate up|back|search|menu|options|settings|close|done|share|delete|archive|info|details|edit|filter|sort|refresh|mute|(make a |video |voice )?call|attach\w*|add .{1,20}|new .{1,20}|compose|send|emoji|camera)$/i;
const BUTTON_CLASS = /(Button|Tab\b|TabView|Chip|CheckBox|Switch|RadioButton|ActionMenuItemView|Spinner|MenuItem)/;
// Notifications (shade, heads-up, lock screen): the standard text views of a notification, and anything inside one.
const NOTIF_TEXT_ID = /^android:id\/(title|text|big_text|conversation_text|message_text|message_name|inbox_text\d*|text_line_1|summary_text|header_text|conversation_title|title_text|big_picture|right_icon|conversation_icon|message_icon)$/;
// (One notification, not the whole panel: the quick settings tiles sit inside "notification_panel" too.)
const NOTIF_ROW_ID = /:id\/(status_bar_latest_event_content|expandableNotificationRow|notification_main_column|notification_messaging|notification_content)$/;
const NOTIF_ROW_CLASS = /ExpandableNotificationRow|NotificationContentView/;
const NOTIF_KEEP_ID = /:id\/(app_name_text|time|time_divider|chronometer|header_text_divider|expand_button\w*|profile_badge|feedback|alerted_icon|notification_footer\w*|dismiss_text|manage_text|clear_all)$/;
// Quick settings: the second line of a tile names the Wi‑Fi network, Bluetooth device...
const QS_DETAIL_ID = /:id\/(secondary_label|wifi_ssid|ssid|tile_secondary_label)$/;
// Maps: fields that hold a place or a route end.
const ADDRESS_ID = /address|location|place_?name|destination|origin|street|locality|omnibox|search_?box|directions_?(from|to)|waypoint|start_?point|end_?point/i;
const STREET = /\b(street|st\.|road|rd\.?|avenue|ave\.?|boulevard|blvd|lane|ln\.?|drive|dr\.|way|place|pl\.|square|sq\.|court|ct\.|highway|hwy|straße|strasse|str\.|weg|platz|gasse|allee|rue|chemin|via|viale|piazza|calle|avenida|plaza|rua|ulica|ul\.)\b/i;

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const editable = (n) => !!(n.f & 8);
const clickable = (n) => !!(n.f & 1);
// A resource id without its package ("com.whatsapp:id/name" -> "name"): package names say nothing about the view.
const rid = (n) => n.i.slice(n.i.indexOf("/") + 1);
const winPkg = (screen, n) => screen.wins[n.win]?.pkg || n.p || "";
function chain(n, until) { const out = []; for (let p = n.parent; p && p !== until; p = p.parent) out.push(p); return out; }

/** Text that reads like a street address, postcode or a "place, town, country" line. */
export function looksLikeAddress(s) {
  s = String(s || "").trim();
  if (s.length < 5) return false;
  if (/^\d+([.,]\d+)?\s?(min|mins|h|hr|hrs|km|mi|m|ft|%|s)\b/i.test(s)) return false; // a distance or a time
  if (STREET.test(s) && /\d|,/.test(s)) return true;
  if (/\b\d{5}(-\d{4})?\b/.test(s) || /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/.test(s)) return true; // US / UK postcodes
  if ((s.match(/,/g) || []).length >= 2) return true;
  return /\d/.test(s) && /\p{L}{3,}/u.test(s) && words(s) >= 2 && /^\d+\w?\s+\p{L}|\p{L}\s+\d+\w?(,|$)/u.test(s); // "221B Baker", "Hauptstr 5"
}

// Obvious UI chrome in a personal app: buttons, tabs, menu items, the app's own title, bottom navigation.
function isChrome(n, screen) {
  const label = (n.t || n.d).trim();
  if (label.length > 30 || words(label) > 4) return false;
  if (BUTTON_CLASS.test(n.c) || CHROME_ID.test(rid(n))) return true;
  if ((n.f & 16 || n.f & 256) && clickable(n) && label.length <= 20) return true; // a tab
  const up = chain(n);
  const bar = up.find((p) => BAR.test(p.c) || BAR.test(rid(p)));
  if (bar) {
    if (TAB_BAR.test(bar.c) || TAB_BAR.test(rid(bar))) return true;
    // A title in the toolbar, unless it can be tapped: in a conversation that is the other person's name.
    const between = chain(n, bar);
    if (!n.t && clickable(n) && ICON_DESC.test(n.d.trim())) return true;
    if (!clickable(n) && !between.some(clickable) && !between.some((p) => PERSONAL_ID.test(rid(p)))) return true;
  }
  // Short tappable text along the bottom edge: bottom navigation, action buttons.
  if (clickable(n) && label.length <= 20 && words(label) <= 3 && n.b[1] >= screen.h * 0.88) return true;
  return false;
}

/**
 * Which on-screen elements to hide. `screen` is autotest's model ({ w, h, nodes[], wins[] }, see flattenDump /
 * flattenXml). Returns [{ b: [l, t, r, b], why }] in phone screen pixels.
 */
export function pickAreas(screen) {
  const out = [];
  // Elements with text inside them: a container's description then needn't hide the whole container.
  const holdsText = new Set();
  for (const n of screen.nodes) if (n.t) for (let p = n.parent; p && !holdsText.has(p); p = p.parent) holdsText.add(p);
  for (const n of screen.nodes) {
    const why = reason(n, screen, holdsText);
    if (!why) continue;
    const [l, t, r, b] = n.b;
    if (r - l < 2 || b - t < 2) continue;
    out.push({ b: n.b, why });
  }
  return out;
}

function reason(n, screen, holdsText) {
  const pkgs = [n.p, winPkg(screen, n)];
  const label = n.t || n.d;
  const inSystemUi = pkgs.includes(SYSTEM_UI);
  if (inSystemUi) {
    // Notification pictures (a contact's photo, a received picture) are hidden too: they are known to be personal.
    if (NOTIF_TEXT_ID.test(n.i) && !n.t && !n.d) return /icon|picture/.test(n.i) ? "notification" : "";
  }
  if (!label) return "";
  if (hasPii(n.t) || hasPii(n.d)) return "personal data";
  if (inSystemUi) {
    if (QS_DETAIL_ID.test(n.i)) return "network or device name";
    if (NOTIF_TEXT_ID.test(n.i)) return "notification";
    const inNotif = [n, ...chain(n)].some((p) => NOTIF_ROW_ID.test(p.i) || NOTIF_ROW_CLASS.test(p.c));
    if (inNotif && !NOTIF_KEEP_ID.test(n.i) && !BUTTON_CLASS.test(n.c)) return "notification";
    return "";
  }
  if (pkgs.some((p) => PERSONAL_APPS.has(p))) {
    if (editable(n) && n.t) return "personal app";
    if (PERSONAL_ID.test(rid(n))) return "personal app";
    if (isChrome(n, screen)) return "";
    if (!n.t && holdsText.has(n)) return ""; // the text inside decides
    return "personal app";
  }
  if (pkgs.some((p) => MAPS_APPS.has(p))) {
    if ((editable(n) && n.t) || ADDRESS_ID.test(rid(n)) || looksLikeAddress(n.t) || looksLikeAddress(n.d)) return "address";
  }
  return "";
}

/**
 * Phone-screen rectangles -> rectangles on a picture of `width`×`height` pixels (the whole screen, at any size,
 * in the same rotation), padded a little and clipped to the picture. Throws if the picture's orientation is not
 * the screen's (the phone turned between the two).
 */
export function mapAreas(areas, screen, width, height) {
  const { w, h } = screen;
  if (!w || !h) throw new Error("the phone didn't say how big its screen is");
  if (w !== h && width !== height && (w > h) !== (width > height)) throw new Error("the phone turned while the picture was taken");
  const sx = width / w, sy = height / h, pad = Math.max(2, Math.round(6 * Math.min(sx, sy)));
  const out = [];
  for (const { b } of areas) {
    const x0 = Math.max(0, Math.floor(b[0] * sx) - pad), y0 = Math.max(0, Math.floor(b[1] * sy) - pad);
    const x1 = Math.min(width, Math.ceil(b[2] * sx) + pad), y1 = Math.min(height, Math.ceil(b[3] * sy) + pad);
    if (x1 - x0 >= 2 && y1 - y0 >= 2) out.push([x0, y0, x1, y1]);
  }
  return out;
}

/**
 * Hides `rects` ([x0, y0, x1, y1] in picture pixels) on the picture: each is shrunk to coarse blocks, its contrast
 * halved and random noise added (so the block colours can't be matched against rendered text), enlarged without
 * smoothing, then blurred.
 * Resolves to a PNG blob.
 */
export async function blurRects(picture, rects) {
  const bmp = await createImageBitmap(picture);
  const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const k = Math.min(c.width, c.height) / 1080; // pixels per "phone pixel" at a 1080-wide screen
  for (const [x0, y0, x1, y1] of rects) {
    const w = x1 - x0, h = y1 - y0;
    const block = Math.max(8, Math.round(Math.min(24 * k, Math.max(h, 8) / 2)));
    const sw = Math.max(1, Math.ceil(w / block)), sh = Math.max(1, Math.ceil(h / block));
    const small = new OffscreenCanvas(sw, sh), sg = small.getContext("2d", { willReadFrequently: true });
    sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = "high";
    sg.drawImage(c, x0, y0, w, h, 0, 0, sw, sh);
    // Halve the contrast towards the area's average colour, then add grey noise: what is left of the letters'
    // shapes is weaker than the noise.
    const px = sg.getImageData(0, 0, sw, sh), d = px.data, avg = [0, 0, 0], n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) avg[j] += d[i + j] / n;
    for (let i = 0; i < d.length; i += 4) {
      const noise = (Math.random() - 0.5) * 24;
      for (let j = 0; j < 3; j++) d[i + j] = avg[j] + (d[i + j] - avg[j]) * 0.5 + noise;
    }
    sg.putImageData(px, 0, 0);
    g.save();
    g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, sw, sh, x0, y0, sw * block, sh * block);
    // Blur the blocks into each other (the copy keeps a margin so the edges blur evenly).
    const m = block * 2, tx = Math.max(0, x0 - m), ty = Math.max(0, y0 - m);
    const tw = Math.min(c.width, x1 + m) - tx, th = Math.min(c.height, y1 + m) - ty;
    const tmp = new OffscreenCanvas(tw, th);
    tmp.getContext("2d").drawImage(c, tx, ty, tw, th, 0, 0, tw, th);
    g.filter = `blur(${Math.round(block * 0.8)}px)`;
    g.drawImage(tmp, tx, ty);
    g.restore();
  }
  return c.convertToBlob({ type: "image/png" });
}

/** Reads the screen, picks and blurs. Exported for tests; the app uses initShotBlur(). */
export async function blurPicture(picture, screen) {
  const bmp = await createImageBitmap(picture);
  const { width, height } = bmp; bmp.close?.();
  const areas = pickAreas(screen);
  const rects = mapAreas(areas, screen, width, height);
  return { blob: rects.length ? await blurRects(picture, rects) : picture, count: rects.length, areas };
}

const READ_MS = 3000;     // to read the screen once the helper is running
const START_MS = 10000;   // the first time, when the helper has to be started (or `uiautomator dump` used)

/**
 * The app's side: `readScreen()` -> autotest's screen model, `helperUp()` -> whether reading is quick right now.
 * capture(grab, { verb }) takes the picture with `grab()` (-> image Blob) while the screen is read, and resolves
 * to { blob, blurred } (blurred: how many areas were hidden, -1 if the person chose to keep it unblurred), or null
 * when there is nothing to save or copy.
 */
export function initShotBlur({ el, toast, readScreen, helperUp }) {
  function readInTime() {
    const ms = helperUp() ? READ_MS : START_MS;
    let timer;
    return Promise.race([
      Promise.resolve().then(readScreen),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the phone took too long to say what is on its screen")), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  /** "Couldn't blur" -> true if the person chooses to keep the picture without blur. */
  function askKeep(reason, verb) {
    return new Promise((resolve) => {
      const keep = el("button", { className: "btn", type: "button", textContent: `${verb} without blur` });
      const no = el("button", { className: "btn primary", type: "button", textContent: `Don't ${verb.toLowerCase()}` });
      const modal = el("div", { className: "modal" }, el("div", { className: "card pd-dialog" },
        el("h2", { textContent: "Personal data couldn't be blurred" }),
        el("p", { textContent: `Andromon couldn't read what is on the phone's screen (${reason}), so it can't tell what to hide. Nothing has been ${verb === "Copy" ? "copied" : "saved"} yet.` }),
        el("p", { className: "muted small", textContent: "Try again in a moment, or keep this picture as it is — then everything on it can be read." }),
        el("div", { className: "toolbar", style: "margin:12px 0 0" }, no, keep)));
      const onKey = (e) => { if (e.key === "Escape") finish(false); };
      function finish(v) { modal.remove(); document.removeEventListener("keydown", onKey); resolve(v); }
      keep.onclick = () => finish(true);
      no.onclick = () => finish(false);
      document.addEventListener("keydown", onKey);
      document.body.append(modal);
      no.focus();
    });
  }

  let busy = false;
  async function capture(grab, { verb = "Save" } = {}) {
    // One at a time: a second click while the screen is read (or the question is open) would stack them up.
    if (busy) { toast("Still working on the last picture…"); return null; }
    busy = true;
    try { return await captureNow(grab, verb); } finally { busy = false; }
  }
  async function captureNow(grab, verb) {
    const reading = readInTime().then((screen) => ({ screen }), (error) => ({ error }));
    const picture = await grab();
    if (!picture) return null;
    let { screen, error } = await reading;
    if (screen) {
      try {
        const r = await blurPicture(picture, screen);
        return { blob: r.blob, blurred: r.count };
      } catch (e) {
        // The phone turned between the two: read again once.
        if (!/turned/.test(e?.message || "")) error = e;
        else try { const r = await blurPicture(picture, await readInTime()); return { blob: r.blob, blurred: r.count }; } catch (e2) { error = e2; }
      }
    }
    const why = String(error?.message || error || "unknown error").replace(/^Error:\s*/, "").replace(/\.$/, "");
    console.warn("Blur personal data: the screen couldn't be read", error);
    if (await askKeep(why.charAt(0).toLowerCase() + why.slice(1), verb)) return { blob: picture, blurred: -1 };
    toast(verb === "Copy" ? "Nothing was copied" : "Nothing was saved");
    return null;
  }

  return { capture };
}
