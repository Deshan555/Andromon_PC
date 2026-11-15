// Dropdown menus. Every <select> in the app, including ones a page adds later, is shown as a button that
// opens a menu drawn in the app's own style instead of the system's list. The <select> itself stays in the
// page (hidden) and stays the source of truth: its value, options, disabled state and "change" event work
// exactly as before, so no page needs to know about this file.

const state = new WeakMap(); // select -> { wrap, btn, label }
let menu = null, openFor = null, active = -1, typed = "", typedAt = 0;

const optionsOf = (sel) => [...sel.options].map((o, index) => ({ o, index, off: o.disabled || (o.parentElement?.tagName === "OPTGROUP" && o.parentElement.disabled) }));
const textOf = (o) => o.label || o.textContent || "";

function refresh(sel) {
  const s = state.get(sel); if (!s) return;
  const cur = sel.options[sel.selectedIndex];
  s.label.textContent = cur ? textOf(cur) : "";
  s.btn.disabled = sel.disabled;
  s.btn.title = sel.title || "";
  s.wrap.hidden = sel.hidden || sel.style.display === "none";
  if (openFor === sel) fill();
}

function enhance(sel) {
  if (sel.multiple || sel.size > 1 || sel.dataset.native != null) return;
  let s = state.get(sel);
  if (!s) {
    const label = document.createElement("span"); label.className = "dd-label";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "dd-btn";
    btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
    btn.append(label);
    const wrap = document.createElement("span"); wrap.className = "dd"; wrap.append(btn);
    // Sizes written on the <select> itself carry over to what is shown in its place.
    for (const p of ["width", "minWidth", "maxWidth", "flex", "margin"]) if (sel.style[p]) wrap.style[p] = sel.style[p];
    if (sel.id) btn.id = `${sel.id}-dd`;
    const name = sel.getAttribute("aria-label"); if (name) btn.setAttribute("aria-label", name);
    btn.addEventListener("click", () => (openFor === sel ? close() : open(sel)));
    btn.addEventListener("keydown", (e) => onKey(e, sel));
    s = { wrap, btn, label };
    state.set(sel, s);
    sel.classList.add("dd-native");
    // Options added or renamed, or the select disabled or hidden by its page: show that.
    new MutationObserver(() => refresh(sel)).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden", "style", "label", "title"] });
  }
  if (sel.previousElementSibling !== s.wrap) sel.before(s.wrap); // also when a page moves its select
  refresh(sel);
}

// ---------- the menu (one, shared) ----------
function fill() {
  const sel = openFor; if (!sel) return;
  const kids = []; let group = null;
  for (const { o, index, off } of optionsOf(sel)) {
    const g = o.parentElement?.tagName === "OPTGROUP" ? o.parentElement : null;
    if (g !== group) { group = g; if (g) { const h = document.createElement("div"); h.className = "dd-group"; h.textContent = g.label; kids.push(h); } }
    const item = document.createElement("div");
    item.className = "dd-item" + (index === sel.selectedIndex ? " sel" : "") + (index === active ? " act" : "") + (off ? " off" : "");
    item.setAttribute("role", "option"); item.id = `dd-opt-${index}`; item.dataset.index = String(index);
    item.setAttribute("aria-selected", String(index === sel.selectedIndex));
    if (off) item.setAttribute("aria-disabled", "true");
    item.textContent = textOf(o);
    kids.push(item);
  }
  menu.replaceChildren(...kids);
  state.get(sel).btn.setAttribute("aria-activedescendant", active >= 0 ? `dd-opt-${active}` : "");
}

function place() {
  const r = state.get(openFor).btn.getBoundingClientRect();
  const below = innerHeight - r.bottom - 12, above = r.top - 12;
  const up = below < 160 && above > below;
  menu.style.minWidth = `${Math.round(r.width)}px`;
  menu.style.maxHeight = `${Math.max(120, Math.min(340, up ? above : below))}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)))}px`;
  if (up) { menu.style.top = ""; menu.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`; }
  else { menu.style.bottom = ""; menu.style.top = `${Math.round(r.bottom + 6)}px`; }
}

function open(sel) {
  if (sel.disabled) return;
  close();
  if (!menu) {
    menu = document.createElement("div"); menu.className = "dd-menu"; menu.setAttribute("role", "listbox"); menu.hidden = true;
    menu.addEventListener("pointerdown", (e) => e.preventDefault()); // the button keeps the keyboard focus
    menu.addEventListener("click", (e) => { const it = e.target.closest(".dd-item"); if (it && !it.classList.contains("off")) choose(Number(it.dataset.index)); });
    menu.addEventListener("pointermove", (e) => { const it = e.target.closest(".dd-item"); if (it && !it.classList.contains("off") && Number(it.dataset.index) !== active) { active = Number(it.dataset.index); fill(); } });
    document.body.append(menu);
  }
  openFor = sel; active = sel.selectedIndex;
  // Inside a full-screen element (the mirror) only that element's children are drawn.
  (document.fullscreenElement || document.body).append(menu);
  menu.hidden = false; fill(); place();
  state.get(sel).btn.setAttribute("aria-expanded", "true");
  menu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function close() {
  if (!openFor) return;
  const s = state.get(openFor);
  s?.btn.setAttribute("aria-expanded", "false"); s?.btn.removeAttribute("aria-activedescendant");
  openFor = null; menu.hidden = true;
}

function choose(index) {
  const sel = openFor; if (!sel) return;
  close();
  if (index === sel.selectedIndex) return;
  sel.selectedIndex = index;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

function move(sel, step, from = active) {
  const list = optionsOf(sel);
  for (let i = from + step; i >= 0 && i < list.length; i += step) if (!list[i].off) { active = i; break; }
  fill(); menu.querySelector(".act")?.scrollIntoView({ block: "nearest" });
}

function onKey(e, sel) {
  const isOpen = openFor === sel;
  if (!isOpen) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); open(sel); }
    return;
  }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  else if (e.key === "Tab") close();
  else if (e.key === "ArrowDown") { e.preventDefault(); move(sel, 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); move(sel, -1); }
  else if (e.key === "Home") { e.preventDefault(); move(sel, 1, -1); }
  else if (e.key === "End") { e.preventDefault(); move(sel, -1, sel.options.length); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (active >= 0) choose(active); }
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Typing letters jumps to the first option that starts with them.
    typed = (Date.now() - typedAt > 700 ? "" : typed) + e.key.toLowerCase(); typedAt = Date.now();
    const hit = optionsOf(sel).find((x) => !x.off && textOf(x.o).trim().toLowerCase().startsWith(typed));
    if (hit) { active = hit.index; fill(); menu.querySelector(".act")?.scrollIntoView({ block: "nearest" }); }
  }
}

export function initDropdowns(root = document) {
  // Setting .value or .selectedIndex from code fires no event, so the shown text is refreshed here.
  for (const prop of ["value", "selectedIndex"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(HTMLSelectElement.prototype, prop, { ...d, set(v) { d.set.call(this, v); refresh(this); } });
  }
  root.addEventListener("change", (e) => { if (e.target instanceof HTMLSelectElement) refresh(e.target); }, true);
  addEventListener("pointerdown", (e) => { if (openFor && !menu.contains(e.target) && !state.get(openFor)?.wrap.contains(e.target)) close(); }, true);
  addEventListener("scroll", (e) => { if (openFor && e.target !== menu) close(); }, true);
  addEventListener("resize", close);
  addEventListener("blur", close);

  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.tagName === "SELECT") enhance(node);
    else for (const sel of node.querySelectorAll?.("select") || []) enhance(sel);
  };
  const gone = (node) => {
    if (node.nodeType !== 1) return;
    for (const sel of node.tagName === "SELECT" ? [node] : node.querySelectorAll?.("select") || []) {
      if (sel.isConnected) continue; // moved, not removed: enhance() puts the button beside it again
      if (openFor === sel) close();
      state.get(sel)?.wrap.remove();
    }
  };
  new MutationObserver((list) => {
    for (const m of list) { m.removedNodes.forEach(gone); m.addedNodes.forEach(scan); }
  }).observe(root.documentElement || root, { childList: true, subtree: true });
  scan(root.documentElement || root);
}
