// Andromon start-up splash (see main.js showSplash). main.js calls splashStep(progress 0..1, text) as the
// main window gets further: starting, loading the interface, setting up, ready. Between two steps the bar
// creeps on slowly by itself, never past the next step, so it doesn't look stuck while a step takes time.
(() => {
  const fill = document.querySelector(".fill"), bar = document.querySelector(".track"), status = document.querySelector(".status");
  const version = new URLSearchParams(location.search).get("v");
  if (version) document.querySelector(".ver").textContent = `Version ${version}`;

  let shown = 0, target = 0.12, cap = 0.3;
  const draw = () => {
    fill.style.transform = `scaleX(${shown})`;
    bar.setAttribute("aria-valuenow", String(Math.round(shown * 100)));
  };
  globalThis.splashStep = (p, text) => {
    target = Math.max(target, Math.min(1, Number(p) || 0));
    cap = target >= 1 ? 1 : Math.min(0.95, target + 0.2);
    if (text) status.textContent = text;
    shown = Math.max(shown, target); draw();
  };
  setInterval(() => { if (shown < cap) { shown = Math.min(cap, shown + (cap - shown) * 0.08); draw(); } }, 120);
  requestAnimationFrame(() => { shown = target; draw(); });
})();
