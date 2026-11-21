// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 The Andromon authors

// Feedback in the sidebar and Settings › About: report a bug or send feedback, on GitHub.
// Nothing is sent from here. The dialog builds a github.com link with the person's text (and, if they
// leave the box ticked, the app, computer and phone versions) filled in, and opens it in the browser.
// The person reads it there and presses Submit with their own GitHub account.
//   Bug     → an issue in Andromon_Releases, through .github/ISSUE_TEMPLATE/bug_report.yml. Each query
//             parameter fills the form field with the same id (what, steps, expected, env).
//   Feedback → a discussion in Andromon_Releases' "General" category (title and body parameters).
// The companion app builds the same links (android/…/Feedback.kt): keep the two in step.

export const FEEDBACK_REPO = "https://github.com/Deshan555/Andromon_Releases";
const FEEDBACK_CATEGORY = "general"; // a Discussions category slug in that repo
const MAX_URL = 7000; // GitHub refuses very long links (about 8 KB); the person's own text is shortened first

/** Shorten the longest of `fields` until `make(fields)` fits; returns the link. */
function fitted(fields, make) {
  const f = { ...fields };
  let url = make(f);
  for (let i = 0; url.length > MAX_URL && i < 60; i++) {
    const k = Object.keys(f).filter((key) => key !== "env").sort((a, b) => f[b].length - f[a].length)[0];
    if (!k || f[k].length < 40) break;
    f[k] = f[k].slice(0, Math.floor(f[k].length * 0.85)).trimEnd() + " …(shortened)";
    url = make(f);
  }
  return url;
}

export function bugUrl({ title, what, steps, expected, env }) {
  return fitted({ title, what, steps, expected, env }, (f) => {
    const q = new URLSearchParams({ template: "bug_report.yml", title: `[Bug] ${f.title}`.trim() });
    for (const k of ["what", "steps", "expected", "env"]) if (f[k]) q.set(k, f[k]);
    return `${FEEDBACK_REPO}/issues/new?${q}`;
  });
}

export function feedbackUrl({ title, text, env }) {
  return fitted({ title, text, env }, (f) => {
    const body = f.text + (f.env ? `\n\n---\n${f.env}` : "");
    const q = new URLSearchParams({ category: FEEDBACK_CATEGORY, title: f.title || `Feedback: ${firstLine(f.text)}`, body });
    return `${FEEDBACK_REPO}/discussions/new?${q}`;
  });
}

const firstLine = (s) => { const l = s.trim().split("\n")[0]; return l.length > 60 ? l.slice(0, 57).trimEnd() + "…" : l; };

/**
 * ctx: { el, toast, details } where details() resolves to [label, value] pairs (app, computer,
 * phone, companion). Returns { open(kind) } with kind "bug" or "feedback".
 */
export function initFeedback({ el, toast, details }) {
  const draft = { kind: "bug", title: "", what: "", steps: "", expected: "", text: "", withDetails: true };
  let env = "", box = null;

  const field = (label, key, { area = true, rows = 3, placeholder = "", required = false } = {}) => {
    const input = el(area ? "textarea" : "input", { className: "fb-input", value: draft[key], placeholder, spellcheck: true });
    if (area) input.rows = rows; else input.type = "text";
    input.oninput = () => { draft[key] = input.value; input.classList.remove("fb-missing"); };
    input.dataset.key = key;
    if (required) input.required = true;
    return el("label", { className: "fb-field" }, el("span", { textContent: label + (required ? "" : " (optional)") }), input);
  };

  function close() { box?.remove(); box = null; document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }

  const envText = () => (draft.withDetails ? env : "");
  function plainText() {
    const parts = draft.kind === "bug"
      ? [`Bug: ${draft.title}`, `What went wrong?\n${draft.what}`, draft.steps && `How to make it happen\n${draft.steps}`, draft.expected && `Expected\n${draft.expected}`]
      : [draft.title && `Feedback: ${draft.title}`, draft.text];
    return [...parts, envText()].filter(Boolean).join("\n\n");
  }

  function missing() {
    const need = draft.kind === "bug" ? ["title", "what"] : ["text"];
    const empty = need.filter((k) => !draft[k].trim());
    for (const k of empty) box.querySelector(`[data-key="${k}"]`)?.classList.add("fb-missing");
    if (empty.length) { box.querySelector(`[data-key="${empty[0]}"]`)?.focus(); toast(draft.kind === "bug" ? "Add a short title and what went wrong" : "Write your feedback first"); }
    return empty.length > 0;
  }

  function render() {
    const card = box.querySelector(".card");
    const tab = (kind, label) => {
      const b = el("button", { className: "btn sm" + (draft.kind === kind ? " primary" : ""), type: "button", textContent: label });
      b.setAttribute("aria-pressed", String(draft.kind === kind));
      b.onclick = () => { draft.kind = kind; render(); };
      return b;
    };
    const fields = draft.kind === "bug"
      ? [field("Title", "title", { area: false, required: true, placeholder: "e.g. Screen mirror freezes after a minute" }),
         field("What went wrong?", "what", { rows: 4, required: true, placeholder: "What happened, and any error message you saw" }),
         field("How can we make it happen?", "steps", { rows: 3, placeholder: "1. Connect the phone over USB\n2. Open …" }),
         field("What did you expect?", "expected", { rows: 2 })]
      : [field("Title", "title", { area: false, placeholder: "A few words about your feedback" }),
         field("Your feedback", "text", { rows: 7, required: true, placeholder: "What you like, what's missing, what's confusing, an idea…" })];

    const tick = el("input", { type: "checkbox", checked: draft.withDetails });
    const pre = el("pre", { className: "fb-env", textContent: env || "Reading the versions…", hidden: !draft.withDetails });
    tick.onchange = () => { draft.withDetails = tick.checked; pre.hidden = !tick.checked; };

    const closeBtn = el("button", { className: "btn sm", type: "button", textContent: "Cancel" }); closeBtn.onclick = close;
    const copy = el("button", { className: "btn sm", type: "button", textContent: "Copy text", title: "No GitHub account? Copy the report and e-mail or message it instead" });
    copy.onclick = async () => {
      if (missing()) return;
      try { await navigator.clipboard.writeText(plainText()); toast("Copied"); } catch { toast("Couldn't copy"); }
    };
    const go = el("button", { className: "btn sm primary", type: "button", textContent: "Open GitHub ›" });
    go.onclick = () => {
      if (missing()) return;
      const url = draft.kind === "bug"
        ? bugUrl({ title: draft.title.trim(), what: draft.what.trim(), steps: draft.steps.trim(), expected: draft.expected.trim(), env: envText() })
        : feedbackUrl({ title: draft.title.trim(), text: draft.text.trim(), env: envText() });
      window.open(url, "_blank", "noopener"); // main.js hands https links to the system browser
      toast("Check it on GitHub and press Submit");
      Object.assign(draft, { title: "", what: "", steps: "", expected: "", text: "" }); // sent on: start fresh next time
      close();
    };

    card.replaceChildren(
      el("div", { className: "fb-head" },
        el("h2", { textContent: draft.kind === "bug" ? "Report a bug" : "Send feedback" }),
        el("div", { className: "set-seg", role: "group", ariaLabel: "Kind" }, tab("bug", "Report a bug"), tab("feedback", "Send feedback"))),
      el("p", { className: "sub fb-intro", textContent: draft.kind === "bug"
        ? "Something doesn't work? Tell us what happened and we'll look into it."
        : "Ideas, things you like, things that are missing or confusing: all of it helps." }),
      ...fields,
      el("label", { className: "fb-tick" }, tick, el("span", { textContent: "Include app and phone details (no personal data)" })),
      pre,
      el("p", { className: "sub fb-note", textContent: `Opens GitHub in your browser with this filled in. Check it there and press Submit (a free GitHub account is needed). Nothing is sent before that, and what you post is public.${draft.kind === "bug" ? " Screenshots and logs can be dragged in on GitHub." : ""}` }),
      el("div", { className: "toolbar fb-actions" }, closeBtn, copy, go));
    card.querySelector(".fb-missing, textarea, input[type=text]")?.focus();
  }

  async function open(kind = "bug") {
    if (kind === "bug" || kind === "feedback") draft.kind = kind;
    if (box) { render(); return; }
    box = el("div", { className: "modal fb-modal", role: "dialog", ariaModal: "true", ariaLabel: "Report a bug or send feedback" }, el("div", { className: "card" }));
    box.addEventListener("click", (e) => { if (e.target === box) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(box);
    render();
    try {
      env = (await details()).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
    } catch { env = ""; }
    const pre = box?.querySelector(".fb-env");
    if (pre) pre.textContent = env || "Couldn't read the versions";
  }

  return { open };
}
