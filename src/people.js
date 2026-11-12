// Contacts tab extras: photos in the list, the edit dialog, deleting (one or many, after a
// confirmation), and "Find duplicates" with a review-and-merge step. The list itself, vCard import
// and export stay in app.js; this module gets what it needs through initPeople().
// Names, numbers and notes come from the phone: they only ever reach the page as text.
import { findDuplicateGroups, mergeContacts, richestContact, bytesToBase64 } from "./pdata.js";

const PHONE_TYPES = ["mobile", "home", "work", "main", "fax", "other"];
const EMAIL_TYPES = ["home", "work", "mobile", "other"];
const TINTS = ["var(--lavender)", "var(--salmon)", "var(--peach)", "var(--mint)", "var(--sky)", "var(--yellow)", "var(--pink)", "var(--coral)"];
const REASON = { phone: "same phone number", email: "same e‑mail address", name: "same name" };

export function initPeople(h) {
  const { $, el, toast, showError, clearError, busy, armedClick, cc, spinner } = h;
  const sel = new Set(); // contact ids ticked in the list
  const thumbs = new Map(); // contact id -> data URL ("" = none)
  const want = [];
  let pumping = false;

  // ---- photos ----
  const jpegUrl = (b64) => (typeof b64 === "string" && /^[A-Za-z0-9+/=]+$/.test(b64) ? `data:image/jpeg;base64,${b64}` : "");
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      want.push(e.target);
    }
    pump();
  }, { rootMargin: "300px" });
  async function pump() {
    if (pumping) return;
    pumping = true;
    const phone = h.getAdb();
    try {
      while (want.length && h.getAdb() && h.getAdb() === phone) {
        const node = want.shift();
        if (!node.isConnected) continue;
        const id = Number(node.dataset.contact);
        let url = thumbs.get(id);
        if (url === undefined) {
          url = "";
          try { url = jpegUrl(await cc("contacts.photo", { id, size: 96 })); } catch (e) { console.warn("Contact photo:", e); }
          if (h.getAdb() !== phone) break;
          thumbs.set(id, url);
          if (thumbs.size > 4000) thumbs.delete(thumbs.keys().next().value);
        }
        if (url) node.replaceChildren(el("img", { src: url, alt: "", draggable: false }));
      }
    } finally { pumping = false; }
  }
  function avatar(c, large = false) {
    const name = String(c?.name || "").trim();
    const a = el("span", { className: "avatar" + (large ? " lg" : ""), textContent: name ? [...name][0].toUpperCase() : "?" });
    a.style.background = TINTS[(Number(c?.id) || name.length) % TINTS.length];
    if (c?.hasPhoto && c.id != null) {
      a.dataset.contact = String(c.id);
      const url = thumbs.get(c.id);
      if (url) a.replaceChildren(el("img", { src: url, alt: "", draggable: false }));
      else if (url === undefined) observer.observe(a);
    }
    return a;
  }

  // ---- list cell and selection ----
  function nameCell(c) {
    const box = el("input", { type: "checkbox", checked: sel.has(c.id), title: "Select" });
    box.onchange = () => { if (box.checked) sel.add(c.id); else sel.delete(c.id); renderSelection(); };
    const name = el("button", { className: "ct-open", type: "button", title: "Edit this contact" },
      el("span", { textContent: (c.starred ? "★ " : "") + (c.name || "(no name)") }), c.org ? el("span", { className: "sub", textContent: c.org }) : "");
    name.onclick = () => openEdit(c);
    return el("div", { className: "ct-name" }, box, avatar(c), name);
  }
  function renderSelection() {
    const bar = $("ctSelBar"); if (!bar) return;
    const all = h.getContacts() || [];
    for (const id of [...sel]) if (!all.some((c) => c.id === id)) sel.delete(id);
    const chosen = all.filter((c) => sel.has(c.id));
    bar.hidden = !chosen.length;
    if (!chosen.length) { bar.replaceChildren(); return; }
    const clear = el("button", { className: "btn sm", type: "button", textContent: "Clear" });
    clear.onclick = () => { sel.clear(); h.render(); };
    const merge = el("button", { className: "btn sm", type: "button", textContent: "Merge into one…", disabled: chosen.length < 2 });
    merge.onclick = () => openDuplicates([{ contacts: chosen, reasons: [] }], "Merge the selected contacts");
    const del = el("button", { className: "btn sm danger", type: "button", textContent: `Delete ${chosen.length}…` });
    del.onclick = () => confirmDelete(chosen);
    bar.replaceChildren(el("b", { textContent: `${chosen.length} selected` }), el("span", { style: "flex:1" }), clear, merge, del);
  }

  // ---- dialogs ----
  function dialog(title, { wide = false } = {}) {
    const body = el("div", {});
    const card = el("div", { className: "card pd-dialog" + (wide ? " wide" : "") }, el("h2", { textContent: title }), body);
    const modal = el("div", { className: "modal" }, card);
    const onKey = (e) => { if (e.key === "Escape" && !modal.dataset.busy) close(); };
    function close() { modal.remove(); document.removeEventListener("keydown", onKey); }
    document.addEventListener("keydown", onKey);
    document.body.append(modal);
    return { modal, card, body, close, lock: (on) => { if (on) modal.dataset.busy = "1"; else delete modal.dataset.busy; } };
  }
  const accountLabel = (c) => {
    if (!c) return "";
    const type = String(c.accountType || ""), name = String(c.accountName || "");
    if (!type && !name) return "Saved on the phone (not synced)";
    const kind = /google/i.test(type) ? "Google" : /whatsapp/i.test(type) ? "WhatsApp" : /sim|icc/i.test(type) ? "SIM card" : /samsung|osp/i.test(type) ? "Samsung account" : /exchange|eas/i.test(type) ? "Exchange" : type;
    return `Saved in ${kind}${name && name !== kind ? ` (${name})` : ""}${c.rawCount > 1 ? ` and ${c.rawCount - 1} more linked source${c.rawCount > 2 ? "s" : ""}` : ""}`;
  };

  /** Shrinks a picture from this computer to a 720 px JPEG (base64). */
  async function pictureToJpeg(file) {
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) throw new Error("That file isn't a picture this computer can read.");
    const scale = Math.min(1, 720 / Math.max(bmp.width, bmp.height));
    const canvas = el("canvas", { width: Math.max(1, Math.round(bmp.width * scale)), height: Math.max(1, Math.round(bmp.height * scale)) });
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.88));
    if (!blob) throw new Error("Couldn't prepare that picture.");
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
  }

  // Rows of [value] [type] [remove], for phone numbers and e-mail addresses.
  function rowsEditor(items, key, types, placeholder, addLabel) {
    const wrap = el("div", { className: "pd-rows" });
    const rows = [];
    const add = (item = { [key]: "", type: types[0] }) => {
      const value = el("input", { type: "text", value: item[key] || "", placeholder });
      const type = el("select", {}, ...[...new Set([...types, item.type || types[0]])].map((t) => el("option", { value: t, textContent: t })));
      type.value = item.type || types[0];
      const rm = el("button", { className: "btn sm", type: "button", textContent: "Remove" });
      const row = el("div", { className: "pd-row" }, value, type, rm);
      const entry = { value, type, row };
      rm.onclick = () => { rows.splice(rows.indexOf(entry), 1); row.remove(); };
      rows.push(entry); wrap.insertBefore(row, more);
      return value;
    };
    const more = el("button", { className: "btn sm", type: "button", textContent: addLabel });
    more.onclick = () => add().focus();
    wrap.append(more);
    for (const it of items) add(it);
    return { el: wrap, values: () => rows.map((r) => ({ [key]: r.value.value.trim(), type: r.type.value })).filter((r) => r[key]) };
  }

  function openEdit(c) {
    const isNew = !c;
    const d = dialog(isNew ? "New contact" : "Edit contact");
    let photo; // undefined = unchanged, null = remove, string = new picture (base64 JPEG)
    const pic = el("span", { className: "pd-pic" }, avatar(c || { name: "" }, true));
    const showPic = (url) => pic.replaceChildren(url ? el("img", { src: url, alt: "" }) : avatar({ name: name.value, id: c?.id }, true));
    const fileIn = el("input", { type: "file", accept: "image/*", hidden: true });
    const change = el("button", { className: "btn sm", type: "button", textContent: "Choose photo…" });
    const remove = el("button", { className: "btn sm", type: "button", textContent: "Remove photo", hidden: !c?.hasPhoto });
    change.onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const f = fileIn.files[0]; fileIn.value = ""; if (!f) return;
      try { photo = await pictureToJpeg(f); showPic(jpegUrl(photo)); remove.hidden = false; } catch (e) { showError(e); }
    };
    remove.onclick = () => { photo = isNew ? undefined : null; showPic(""); remove.hidden = true; };
    const name = el("input", { type: "text", value: c?.name || "", placeholder: "Name" });
    const star = el("input", { type: "checkbox", checked: !!c?.starred });
    const phones = rowsEditor(c?.phones || [], "number", PHONE_TYPES, "Phone number", "Add a number");
    const emails = rowsEditor(c?.emails || [], "address", EMAIL_TYPES, "E‑mail address", "Add an e‑mail");
    const org = el("input", { type: "text", value: c?.org || "", placeholder: "Company" });
    const bday = el("input", { type: "text", value: c?.birthday || "", placeholder: "Birthday (YYYY-MM-DD)" });
    const note = el("textarea", { value: c?.note || "", placeholder: "Note", rows: 3 });
    const status = el("span", { className: "muted" });
    const save = el("button", { className: "btn primary", type: "button", textContent: isNew ? "Add to phone" : "Save" });
    const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
    const del = el("button", { className: "btn danger", type: "button", textContent: "Delete contact", hidden: isNew });
    cancel.onclick = d.close;
    const field = (label, control) => el("label", { className: "pd-field" }, el("span", { className: "muted small", textContent: label }), control);
    d.body.append(
      el("div", { className: "pd-top" }, pic, el("div", { className: "pd-grow" }, field("Name", name), el("div", { className: "toolbar", style: "margin:8px 0 0" }, change, remove, fileIn, el("label", { className: "small" }, star, " Favourite")))),
      el("div", { className: "pd-field" }, el("span", { className: "muted small", textContent: "Phone numbers" }), phones.el),
      el("div", { className: "pd-field" }, el("span", { className: "muted small", textContent: "E‑mail addresses" }), emails.el),
      el("div", { className: "pd-two" }, field("Company", org), field("Birthday", bday)),
      field("Note", note),
      isNew ? el("p", { className: "muted small", textContent: "Added to the phone's own contacts (not to an online account)." })
        : el("p", { className: "muted small", textContent: `${accountLabel(c)}. Changes made here sync to that account like changes made on the phone.` }),
      el("div", { className: "toolbar", style: "margin:0" }, save, cancel, status, el("span", { style: "flex:1" }), del));
    if (c?.hasPhoto) cc("contacts.photo", { id: c.id, size: 320 }).then((b) => { if (photo === undefined && d.modal.isConnected && jpegUrl(b)) showPic(jpegUrl(b)); }).catch(() => {});

    save.onclick = async () => {
      clearError();
      const contact = { name: name.value.trim(), starred: star.checked, phones: phones.values(), emails: emails.values(), org: org.value.trim(), note: note.value.trim(), birthday: bday.value.trim() };
      if (!contact.name && !contact.phones.length && !contact.emails.length) { status.textContent = "Enter a name, a number or an e‑mail address."; return; }
      if (contact.birthday && contact.birthday !== (c?.birthday || "") && !/^(\d{4}|-)-\d{2}-\d{2}$/.test(contact.birthday)) { status.textContent = "Write the birthday as YYYY-MM-DD (for example 1990-04-23)."; return; }
      busy(save, true, "Saving…"); d.lock(true);
      try {
        h.needPermission("WRITE_CONTACTS", "write-contacts");
        if (isNew) {
          if (typeof photo === "string") contact.photo = photo;
          await cc("contacts.add", { contacts: [contact] });
        } else {
          const r = await cc("contacts.update", { contact: { ...contact, id: c.id } });
          const id = r?.id ?? c.id;
          if (photo !== undefined) await cc("contacts.setPhoto", { id, data: photo });
          thumbs.delete(c.id); thumbs.delete(id);
        }
        d.close();
        toast(isNew ? "Contact added" : "Contact saved");
        await h.reload();
      } catch (e) { showError(e); status.textContent = String(e?.message || e); }
      finally { d.lock(false); if (save.isConnected) busy(save, false); }
    };
    armedClick(del, async () => {
      busy(del, true, "Deleting…"); d.lock(true);
      try { await deleteContacts([c]); d.close(); }
      catch (e) { showError(e); }
      finally { d.lock(false); if (del.isConnected) busy(del, false); }
    });
    name.focus();
  }

  async function deleteContacts(list) {
    h.needPermission("WRITE_CONTACTS", "write-contacts");
    let deleted = 0, failed = 0;
    for (let i = 0; i < list.length; i += 200) {
      const r = await cc("contacts.delete", { ids: list.slice(i, i + 200).map((c) => c.id) });
      deleted += Number(r?.deleted) || 0; failed += r?.failed?.length || 0;
    }
    for (const c of list) { sel.delete(c.id); thumbs.delete(c.id); }
    toast(`Deleted ${deleted} contact${deleted === 1 ? "" : "s"}${failed ? ` · ${failed} couldn't be deleted` : ""}`);
    await h.reload();
  }
  function confirmDelete(list) {
    const d = dialog(`Delete ${list.length} contact${list.length === 1 ? "" : "s"} from the phone?`);
    const names = list.slice(0, 12).map((c) => c.name || c.phones?.[0]?.number || c.emails?.[0]?.address || "(no name)").join(", ");
    const synced = list.some((c) => c.accountType || c.accountName);
    const go = el("button", { className: "btn danger armed", type: "button", textContent: `Delete ${list.length}` });
    const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
    cancel.onclick = d.close;
    go.onclick = async () => {
      busy(go, true, "Deleting…"); cancel.disabled = true; d.lock(true);
      try { await deleteContacts(list); d.close(); }
      catch (e) { showError(e); d.close(); }
    };
    d.body.append(
      el("p", { textContent: names + (list.length > 12 ? `, and ${list.length - 12} more` : "") }),
      el("p", { className: "muted", textContent: "This can't be undone from Droid Desk." + (synced ? " Contacts that sync with an account (Google, for example) are removed from that account too." : "") + " Export a vCard first if you want a copy." }),
      el("div", { className: "toolbar", style: "margin:0" }, go, cancel));
    cancel.focus();
  }

  // ---- duplicates: review, then merge ----
  /** Keeps `keep` with everyone's details, moves a photo over if it has none, deletes the others. */
  async function mergeGroup(contacts, keep) {
    const merged = mergeContacts(contacts, keep);
    const r = await cc("contacts.update", { contact: merged });
    const keepId = r?.id ?? keep.id;
    if (!keep.hasPhoto) {
      const donor = contacts.find((c) => c !== keep && c.hasPhoto);
      if (donor) {
        try { const data = await cc("contacts.photo", { id: donor.id, size: 720 }); if (data) await cc("contacts.setPhoto", { id: keepId, data }); }
        catch (e) { console.warn("Moving the photo:", e); }
      }
    }
    const ids = contacts.filter((c) => c !== keep).map((c) => c.id).filter((id) => id !== keepId);
    if (ids.length) {
      const del = await cc("contacts.delete", { ids });
      if (del?.failed?.length) throw new Error(`The details were merged into “${merged.name || "the contact"}”, but ${del.failed.length} of the old entries couldn't be deleted.`);
    }
    for (const c of contacts) { thumbs.delete(c.id); sel.delete(c.id); }
  }
  const detailLine = (c) => [...(c.phones || []).map((p) => p.number), ...(c.emails || []).map((m) => m.address), c.org].filter(Boolean).join(" · ") || "no details";

  function openDuplicates(groupsIn, title) {
    const all = h.getContacts() || [];
    const groups = (groupsIn || findDuplicateGroups(all)).map((g) => ({ ...g, keep: richestContact(g.contacts), included: new Set(g.contacts), done: false }));
    const d = dialog(title || "Possible duplicates", { wide: true });
    let changed = false;
    const finish = () => { d.close(); if (changed) h.reload().catch(showError); };
    const closeBtn = el("button", { className: "btn", type: "button", textContent: "Close" });
    closeBtn.onclick = finish;
    d.modal.addEventListener("click", (e) => { if (e.target === d.modal && !d.modal.dataset.busy) finish(); });
    if (!groups.length) {
      d.body.append(el("p", { className: "muted", textContent: `No duplicates found among ${all.length} contacts. Droid Desk looks for the same phone number, the same e‑mail address, or exactly the same name.` }), closeBtn);
      return;
    }
    const status = el("span", { className: "muted" });
    const mergeAll = el("button", { className: "btn primary", type: "button", textContent: `Merge all ${groups.length} groups`, hidden: groups.length < 2 });
    const listBox = el("div", { className: "dup-list" });
    const left = () => groups.filter((g) => !g.done);
    const refreshHead = () => {
      const n = left().length;
      if (!mergeAll.hasAttribute("aria-busy")) mergeAll.textContent = `Merge all ${n} groups`;
      mergeAll.hidden = n < 2;
      if (!n) status.textContent = "All done.";
    };

    function card(g) {
      const box = el("div", { className: "dup-group" });
      const draw = () => {
        const inc = g.contacts.filter((c) => g.included.has(c));
        if (!g.included.has(g.keep)) g.keep = inc.length ? richestContact(inc) : g.contacts[0];
        const rows = g.contacts.map((c) => {
          const use = el("input", { type: "checkbox", checked: g.included.has(c), title: "Part of this merge" });
          use.onchange = () => { if (use.checked) g.included.add(c); else g.included.delete(c); draw(); };
          const keep = el("input", { type: "radio", name: `keep-${groups.indexOf(g)}`, checked: g.keep === c, disabled: !g.included.has(c), title: "Keep this one" });
          keep.onchange = () => { g.keep = c; draw(); };
          return el("div", { className: "dup-row" + (g.included.has(c) ? "" : " off") }, use, avatar(c),
            el("div", { className: "pd-grow" }, el("div", { textContent: c.name || "(no name)" }), el("div", { className: "sub", textContent: detailLine(c) }), el("div", { className: "sub", textContent: accountLabel(c) })),
            el("label", { className: "small" }, keep, " keep"));
        });
        const go = el("button", { className: "btn sm primary", type: "button", textContent: inc.length > 1 ? `Merge these ${inc.length}` : "Merge", disabled: inc.length < 2 });
        const skip = el("button", { className: "btn sm", type: "button", textContent: "Not duplicates" });
        skip.onclick = () => { g.done = true; box.remove(); refreshHead(); };
        go.onclick = async () => {
          busy(go, true, "Merging…"); d.lock(true); clearError();
          try { await mergeGroup(inc, g.keep); changed = true; g.done = true; box.replaceChildren(el("div", { className: "muted", textContent: `✓ Merged into “${mergeContacts(inc, g.keep).name || "contact"}”` })); }
          catch (e) { changed = true; showError(e); if (go.isConnected) busy(go, false); }
          finally { d.lock(false); refreshHead(); }
        };
        const m = inc.length > 1 ? mergeContacts(inc, g.keep) : null;
        box.replaceChildren(
          g.reasons.length ? el("div", { className: "chips", style: "margin:0 0 8px" }, ...g.reasons.map((r) => el("span", { className: "chip", textContent: REASON[r] || r }))) : "",
          ...rows,
          m ? el("div", { className: "dup-result" }, el("b", { textContent: "After merging: " }), `${m.name || "(no name)"} · ${detailLine(m)}`) : el("div", { className: "muted small", textContent: "Tick at least two entries to merge them." }),
          el("div", { className: "toolbar", style: "margin:8px 0 0" }, go, skip));
      };
      draw();
      return box;
    }

    armedClick(mergeAll, async () => {
      busy(mergeAll, true, "Merging…"); d.lock(true); clearError(); closeBtn.disabled = true;
      let ok = 0, bad = 0;
      try {
        for (const g of left()) {
          const inc = g.contacts.filter((c) => g.included.has(c));
          if (inc.length < 2) continue;
          try { await mergeGroup(inc, g.included.has(g.keep) ? g.keep : richestContact(inc)); ok++; g.done = true; }
          catch (e) { bad++; console.warn("Merge:", e); }
          changed = true;
          status.textContent = `${ok + bad} of ${groups.length}…`;
        }
      } finally { d.lock(false); closeBtn.disabled = false; }
      toast(`Merged ${ok} group${ok === 1 ? "" : "s"}${bad ? ` · ${bad} failed` : ""}`);
      finish();
    });
    const shown = groups.slice(0, 150);
    listBox.append(...shown.map(card));
    d.body.append(
      el("p", { className: "muted", textContent: `${groups.length} group${groups.length === 1 ? "" : "s"} of contacts share a phone number, an e‑mail address or a name. For each group, choose which entry to keep; it gets every number, address and note of the others (and a photo, if it has none), and the others are deleted. Untick an entry to leave it alone.` + (groups.length > shown.length ? ` Showing the first ${shown.length}.` : "") }),
      el("div", { className: "toolbar" }, mergeAll, closeBtn, status), listBox);
  }

  $("ctDups")?.addEventListener("click", () => { if (h.getContacts()) openDuplicates(); });
  $("ctNew")?.addEventListener("click", () => { if (h.getContacts()) openEdit(null); });

  return {
    nameCell, renderSelection, avatar, openEdit, openDuplicates,
    reset() { sel.clear(); thumbs.clear(); want.length = 0; },
    forgetPhotos() { thumbs.clear(); },
  };
}
