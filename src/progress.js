// Andromon — the progress line shown while files are copied, uploaded or downloaded: what is
// happening, how far ("45% · 12 MB of 30 MB · 3.1 MB/s · 8 s left") and a bar under it. Without a
// known total the bar slides back and forth instead. Transfers report every chunk (64 KB), so the
// page is redrawn at most once per frame.

const fmtLeft = (s) => {
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${Math.max(1, Math.round(s))} s left`;
  if (s < 3600) return `about ${Math.round(s / 60)} min left`;
  return `about ${(s / 3600).toFixed(1)} h left`;
};

/**
 * Returns { node, update(text, done, total, unit), reset() }. unit is "bytes" (sizes, speed and time
 * left are shown) or "items" (just "3 of 10"). Call update(text) alone for a step without a total.
 */
export function createProgress({ el, fmtSize }) {
  const label = el("span", { className: "pg-label" });
  const meta = el("span", { className: "pg-meta" });
  const fill = el("i");
  const bar = el("div", { className: "bar pg-bar indet", role: "progressbar" }, fill);
  bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
  const node = el("div", { className: "pg" }, el("div", { className: "pg-line" }, label, meta), bar);
  let want = null, frame = 0;
  let speed = { at: 0, done: 0, rate: 0 };

  function draw() {
    frame = 0;
    const { text, done, total, unit } = want;
    label.textContent = text || ""; label.title = text || "";
    if (!(total > 0)) {
      bar.classList.add("indet"); bar.removeAttribute("aria-valuenow");
      fill.style.width = ""; meta.textContent = done > 0 && unit === "bytes" ? fmtSize(done) : "";
      return;
    }
    const frac = Math.max(0, Math.min(1, done / total)), pct = Math.floor(frac * 100);
    bar.classList.remove("indet"); bar.setAttribute("aria-valuenow", String(pct));
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    if (unit !== "bytes") { meta.textContent = `${done.toLocaleString()} of ${total.toLocaleString()}`; return; }
    // Speed: smoothed over half-second steps; time left once there is a steady speed.
    const now = performance.now();
    if (!speed.at || done < speed.done) speed = { at: now, done, rate: 0, t0: now };
    else if (now - speed.at > 500) {
      const r = ((done - speed.done) * 1000) / (now - speed.at);
      speed = { ...speed, at: now, done, rate: speed.rate ? speed.rate * 0.7 + r * 0.3 : r };
    }
    const parts = [`${pct}%`, `${fmtSize(done)} of ${fmtSize(total)}`];
    if (speed.rate > 0) parts.push(`${fmtSize(speed.rate)}/s`);
    if (speed.rate > 0 && now - speed.t0 > 1500 && done < total) parts.push(fmtLeft((total - done) / speed.rate));
    meta.textContent = parts.join(" · ");
  }
  return {
    node,
    update(text, done = 0, total = 0, unit = "bytes") {
      want = { text, done: Number(done) || 0, total: Number(total) || 0, unit };
      if (!frame) frame = requestAnimationFrame(draw);
    },
    reset() { speed = { at: 0, done: 0, rate: 0 }; },
  };
}

/** Passes a stream through unchanged, reporting the bytes as they go; `check()` may throw to stop it. */
export function countBytes(stream, onBytes, check) {
  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctl) { check?.(); onBytes(chunk.byteLength ?? chunk.length ?? 0); ctl.enqueue(chunk); },
  }));
}
