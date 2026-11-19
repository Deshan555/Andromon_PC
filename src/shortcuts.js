// Andromon — keyboard shortcuts for the mirror's controls (Settings › Screen mirror › Keyboard
// shortcuts). A shortcut is a key with at least one modifier (or a function key), saved by its
// physical key (KeyboardEvent.code), so it stays on the same key in every keyboard layout. While
// mirroring, a key that is a shortcut runs that control instead of going to the phone.

const KEY = "andromon.mirrorShortcuts";
const isMac = /Mac/.test(navigator.platform);

// [action, name]. The actions are the mirror's own controls (KEY_BUTTONS in app.js).
export const SHORTCUT_ACTIONS = [
  ["back", "Back"], ["home", "Home"], ["recents", "Recent apps"], ["notif", "Notification shade"], ["quick", "Quick settings"],
  ["closepanels", "Close panels"], ["volup", "Volume up"], ["voldown", "Volume down"], ["mutephone", "Mute the phone"],
  ["power", "Power button"], ["lock", "Lock the phone"], ["screen", "Phone screen off / on"], ["rotate", "Rotate"],
  ["play", "Play / pause"], ["next", "Next track"], ["prev", "Previous track"], ["full", "Full screen"], ["zoom", "Actual size"],
  ["ontop", "Keep on top"], ["shot", "Save frame"], ["copyframe", "Copy frame"], ["paste", "Paste"], ["record", "Record"], ["audio", "Mute here"],
];

// Like scrcpy's: Alt (Option on a Mac) with a letter.
export const DEFAULT_SHORTCUTS = {
  back: "Alt+KeyB", home: "Alt+KeyH", recents: "Alt+KeyS", notif: "Alt+KeyN", quick: "Alt+Shift+KeyN", closepanels: "Alt+Shift+KeyC",
  volup: "Alt+ArrowUp", voldown: "Alt+ArrowDown", power: "Alt+KeyP", screen: "Alt+KeyO", rotate: "Alt+KeyR",
  full: "Alt+KeyF", shot: "Alt+Shift+KeyS", record: "Alt+Shift+KeyR",
};

export function loadShortcuts() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null");
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([a, c]) => typeof c === "string" && SHORTCUT_ACTIONS.some(([x]) => x === a)));
  } catch {}
  return { ...DEFAULT_SHORTCUTS };
}
export function saveShortcuts(map) { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch {} return map; }

const MODS = ["Ctrl", "Alt", "Shift", "Meta"];
/** "Ctrl+Alt+KeyK" for a key press, or null for a modifier alone. */
export function comboOf(e) {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock"].includes(e.key) || !e.code) return null;
  return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", e.code].filter(Boolean).join("+");
}
/** A combo may be a shortcut when it can't be plain typing: a modifier other than Shift, or F1–F24. */
export function usableCombo(combo) {
  const parts = combo.split("+"), code = parts.pop();
  return /^F\d{1,2}$/.test(code) || parts.some((m) => m !== "Shift");
}
const KEY_NAMES = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", Enter: "Enter", Backspace: "Backspace", Escape: "Esc", Tab: "Tab",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`" };
/** "⌥B" on a Mac, "Alt+B" elsewhere. */
export function comboLabel(combo) {
  if (!combo) return "";
  const parts = combo.split("+"), code = parts.pop();
  const key = KEY_NAMES[code] || code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
  const mac = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘" }, pc = { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win" };
  const sorted = MODS.filter((m) => parts.includes(m));
  return isMac ? sorted.map((m) => mac[m]).join("") + key : [...sorted.map((m) => pc[m]), key].join("+");
}

/** The editor in Settings: one row per control with its shortcut, and a button to record a new one. */
export function shortcutEditor({ el, toast }) {
  let map = loadShortcuts(), recording = null;
  const list = el("div", { className: "sc-list" });
  function render() {
    list.replaceChildren(...SHORTCUT_ACTIONS.map(([action, name]) => {
      const keys = el("kbd", { className: "sc-keys" + (map[action] ? "" : " none"), textContent: map[action] ? comboLabel(map[action]) : "None" });
      const set = el("button", { className: "btn sm", type: "button", textContent: recording === action ? "Press keys…" : "Change" });
      set.onclick = () => { recording = recording === action ? null : action; render(); if (recording) set.focus(); };
      set.onkeydown = (e) => {
        if (recording !== action) return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === "Escape") { recording = null; render(); return; }
        const combo = comboOf(e); if (!combo) return;
        if (!usableCombo(combo)) return toast("Hold Ctrl, Alt or ⌘ with the key (or use F1–F12), so it can't clash with typing");
        const taken = Object.entries(map).find(([a, c]) => c === combo && a !== action);
        if (taken) delete map[taken[0]];
        map[action] = combo; saveShortcuts(map); recording = null; render();
        if (taken) toast(`${comboLabel(combo)} was used by “${SHORTCUT_ACTIONS.find(([a]) => a === taken[0])[1]}”; that one now has none`);
      };
      const clear = el("button", { className: "btn sm", type: "button", textContent: "Remove", disabled: !map[action] });
      clear.onclick = () => { delete map[action]; saveShortcuts(map); render(); };
      return el("div", { className: "sc-row" }, el("span", { className: "sc-name", textContent: name }), keys, set, clear);
    }));
  }
  const reset = el("button", { className: "btn sm", type: "button", textContent: "Back to the defaults" });
  reset.onclick = () => { map = saveShortcuts({ ...DEFAULT_SHORTCUTS }); recording = null; render(); };
  render();
  return el("div", { className: "sc-box" }, list, el("div", { style: "margin-top:10px" }, reset));
}
