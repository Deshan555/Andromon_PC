// Applies the saved appearance before the page paints (the page's CSP allows no inline script).
// Mode: data-theme="light" | "dark", or none to follow the system. Colour theme: data-accent.
(function () {
  try {
    var mode = localStorage.getItem("dd.theme"), accent = localStorage.getItem("dd.accent"), root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    if (accent && accent !== "lime" && /^[a-z]+$/.test(accent)) root.setAttribute("data-accent", accent);
  } catch (e) {}
})();
