// Applies the saved appearance before the page paints (the page's CSP allows no inline script).
// Mode: data-theme="light" | "dark", or none to follow the system. Colour theme: data-accent.
// Accessibility (Settings › Accessibility) sets data-text, data-contrast, data-motion, data-bold,
// data-focus, data-links, data-font, data-zoom (app zoom), data-buttons (button size) and data-icons
// (icon-only buttons, src/iconbuttons.js); the styles for them are at the end of index.html.
(function () {
  var root = document.documentElement;
  var get = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  try {
    var mode = get("andromon.theme"), accent = get("andromon.accent");
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    if (accent && accent !== "lime" && /^[a-z]+$/.test(accent)) root.setAttribute("data-accent", accent);
    // Settings › Accessibility › Blur personal data (src/privacyblur.js), before paint so nothing shows unblurred.
    if (get("andromon.privacy.blur") === "1") root.setAttribute("data-pii-blur", "");
  } catch (e) {}

  var SIZES = ["100", "115", "130", "150"];
  var ZOOMS = ["67", "75", "80", "90", "100", "110", "125", "150", "175", "200"];
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
    var zoom = get("andromon.a11y.zoom"), buttons = get("andromon.a11y.buttons");
    flag("data-zoom", ZOOMS.indexOf(zoom) >= 0 && zoom !== "100", zoom);
    flag("data-buttons", buttons === "small" || buttons === "smallest", buttons);
    var icons = get("andromon.a11y.icons") === "on";
    flag("data-icons", icons, "");
    if (window.ddIconButtons) window.ddIconButtons(icons); // set by the app once it has loaded
  }
  apply();
  [moreContrast, lessMotion].forEach(function (m) { if (m && m.addEventListener) m.addEventListener("change", apply); });
  window.ddA11y = { apply: apply, SIZES: SIZES, ZOOMS: ZOOMS };
})();
