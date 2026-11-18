// Applies the saved appearance before the page paints (the page's CSP allows no inline script).
// Mode: data-theme="light" | "dark", or none to follow the system. Colour theme: data-accent.
// Accessibility (Settings › Accessibility) sets data-text, data-contrast, data-motion, data-bold,
// data-focus, data-links and data-font; the styles for them are at the end of index.html.
(function () {
  var root = document.documentElement;
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  try {
    var mode = get("andromon.theme"), accent = get("andromon.accent");
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    if (accent && accent !== "lime" && /^[a-z]+$/.test(accent)) root.setAttribute("data-accent", accent);
  } catch (e) {}

  var SIZES = ["100", "115", "130", "150"];
  var media = function (q) { try { return window.matchMedia(q); } catch (e) { return null; } };
  var moreContrast = media("(prefers-contrast: more)"), lessMotion = media("(prefers-reduced-motion: reduce)");
  // "system" (or nothing saved) follows the computer's own setting.
  var follows = function (key, m) { var v = get(key); return v === "on" || (v !== "off" && !!(m && m.matches)); };
  var flag = function (name, on, value) { if (on) root.setAttribute(name, value); else root.removeAttribute(name); };
  function apply() {
    var size = get("andromon.a11y.text");
    flag("data-text", SIZES.indexOf(size) > 0, size);
    flag("data-contrast", follows("andromon.a11y.contrast", moreContrast), "more");
    flag("data-motion", follows("andromon.a11y.motion", lessMotion), "reduce");
    flag("data-bold", get("andromon.a11y.bold") === "on", "");
    flag("data-focus", get("andromon.a11y.focus") === "on", "strong");
    flag("data-links", get("andromon.a11y.links") === "on", "underline");
    flag("data-font", get("andromon.a11y.font") === "plain", "plain");
  }
  apply();
  [moreContrast, lessMotion].forEach(function (m) { if (m && m.addEventListener) m.addEventListener("change", apply); });
  window.ddA11y = { apply: apply, SIZES: SIZES };
})();
