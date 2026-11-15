// Developer tab › Input: type on the phone from the PC keyboard, paste the PC clipboard, and press
// system keys.
//
// Typing uses `input text`, which only handles plain ASCII; other characters are reported, not dropped
// silently.

const KEYS = [
  ["Back", "KEYCODE_BACK"], ["Home", "KEYCODE_HOME"], ["Recents", "KEYCODE_APP_SWITCH"], ["Menu", "KEYCODE_MENU"],
  ["Enter", "KEYCODE_ENTER"], ["Tab", "KEYCODE_TAB"], ["Backspace", "KEYCODE_DEL"], ["Delete", "KEYCODE_FORWARD_DEL"],
  ["↑", "KEYCODE_DPAD_UP"], ["↓", "KEYCODE_DPAD_DOWN"], ["←", "KEYCODE_DPAD_LEFT"], ["→", "KEYCODE_DPAD_RIGHT"],
  ["Volume +", "KEYCODE_VOLUME_UP"], ["Volume −", "KEYCODE_VOLUME_DOWN"], ["Power", "KEYCODE_POWER"], ["Wake", "KEYCODE_WAKEUP"],
];
const PANELS = [
  ["Notifications", "cmd statusbar expand-notifications"],
  ["Quick settings", "cmd statusbar expand-settings"],
  ["Close panels", "cmd statusbar collapse"],
];
// Live typing: keys that become key events instead of text.
const LIVE_KEYS = {
  Enter: "KEYCODE_ENTER", Backspace: "KEYCODE_DEL", Delete: "KEYCODE_FORWARD_DEL", Tab: "KEYCODE_TAB", Escape: "KEYCODE_BACK",
  ArrowUp: "KEYCODE_DPAD_UP", ArrowDown: "KEYCODE_DPAD_DOWN", ArrowLeft: "KEYCODE_DPAD_LEFT", ArrowRight: "KEYCODE_DPAD_RIGHT",
  Home: "KEYCODE_MOVE_HOME", End: "KEYCODE_MOVE_END",
};

export function mount(root, ctx) {
  const { el, sh, shQuote, toast, showError, clearError } = ctx;

  // ---------- typing ----------
  const isAscii = (s) => /^[\x20-\x7e\n\t]*$/.test(s);
  // `input text` turns "%s" into a space, so spaces are sent as %s; a literal "%s" can't be typed.
  const textCmd = (s) => `input text ${shQuote(s.replace(/ /g, "%s"))}`;
  async function typeText(text) {
    if (!text) return;
    const bad = [...new Set(text.replace(/[\x20-\x7e\n\t]/g, ""))];
    if (bad.length) throw new Error(`Android's typing command only handles plain letters, numbers and symbols. Remove: ${bad.slice(0, 8).join(" ")}${bad.length > 8 ? " …" : ""} (Screen mirror can paste any text).`);
    const cmds = [];
    for (const part of text.split(/(\n|\t)/)) {
      if (part === "\n") cmds.push("input keyevent KEYCODE_ENTER");
      else if (part === "\t") cmds.push("input keyevent KEYCODE_TAB");
      else for (let i = 0; i < part.length; i += 200) cmds.push(textCmd(part.slice(i, i + 200)));
    }
    // Several short commands per shell call keep it fast without making one huge command line.
    for (let i = 0; i < cmds.length; i += 8) await sh(cmds.slice(i, i + 8).join("; "));
  }

  const area = el("textarea", { className: "dev-type", rows: 3, placeholder: "Text to type into the focused field on the phone", spellcheck: false });
  const sendBtn = el("button", { className: "btn primary sm", type: "button", textContent: "Type on phone" });
  const pasteBtn = el("button", { className: "btn sm", type: "button", textContent: "Type PC clipboard" });
  const clearAfter = el("input", { type: "checkbox", checked: true });
  sendBtn.onclick = async () => {
    ctx.busy(sendBtn, true, "Typing…");
    try { await typeText(area.value); clearError(); toast("Typed on the phone"); if (clearAfter.checked) area.value = ""; }
    catch (e) { showError(e); } finally { ctx.busy(sendBtn, false); }
  };
  area.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendBtn.click(); } });
  pasteBtn.onclick = async () => {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { showError("Couldn't read this computer's clipboard."); return; }
    if (!text) { toast("The clipboard is empty"); return; }
    ctx.busy(pasteBtn, true, "Typing…");
    try { await typeText(text); clearError(); toast(`Typed ${text.length} characters`); }
    catch (e) { showError(e); } finally { ctx.busy(pasteBtn, false); }
  };

  // Live typing: a box that forwards each key as you press it.
  const live = el("input", { type: "text", className: "dev-live", placeholder: "Click here and type: keys go straight to the phone", spellcheck: false, autocomplete: "off" });
  const liveState = el("span", { className: "dev-lbl" });
  let pending = "", queue = Promise.resolve(), flushTimer = null;
  const enqueue = (cmd) => { queue = queue.then(() => sh(cmd)).catch((e) => showError(e)); };
  const flush = () => { clearTimeout(flushTimer); if (pending) { enqueue(textCmd(pending)); pending = ""; } };
  live.addEventListener("keydown", (e) => {
    if (e.isComposing || e.metaKey || (e.ctrlKey && e.key !== "Backspace")) return;
    e.preventDefault();
    if (LIVE_KEYS[e.key]) { flush(); enqueue(`input keyevent ${LIVE_KEYS[e.key]}`); return; }
    if (e.key.length !== 1) return;
    if (!isAscii(e.key)) { liveState.textContent = "That character can't be typed this way"; return; }
    liveState.textContent = "";
    pending += e.key;
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 120);
  });
  live.addEventListener("paste", (e) => {
    e.preventDefault(); flush();
    const t = e.clipboardData?.getData("text") || "";
    queue = queue.then(() => typeText(t)).catch((err) => showError(err));
  });
  live.addEventListener("blur", flush);

  const keyRow = el("div", { className: "dev-keys" });
  for (const [label, code] of KEYS) {
    const b = el("button", { className: "btn sm", type: "button", textContent: label });
    b.onclick = () => sh(`input keyevent ${code}`).catch(showError);
    keyRow.append(b);
  }
  const panelRow = el("div", { className: "dev-keys" });
  for (const [label, cmd] of PANELS) {
    const b = el("button", { className: "btn sm", type: "button", textContent: label });
    b.onclick = () => sh(cmd).catch(showError);
    panelRow.append(b);
  }

  root.append(
    ctx.card("Type on the phone", null,
      el("div", { className: "dev-row" }, live), liveState,
      el("div", { className: "dev-row", style: "margin-top:12px" }, area),
      el("div", { className: "dev-row" }, sendBtn, pasteBtn,
        el("label", { className: "dev-check" }, clearAfter, " Clear after typing")),
      el("p", { className: "dev-note", textContent: "Tap a text field on the phone first. Ctrl/⌘ + Enter types the box. Only plain English letters, numbers and symbols work this way." })),
    ctx.card("Keys & panels", null, keyRow, panelRow));

  return {
    hide: flush,
    disconnected: () => { pending = ""; },
  };
}
