// The knowledge drawer: the book button in the page header opens a panel on the right that explains the
// page in view (what it is for, how it works, good to know) and offers a tour: the page's parts are lit up
// one after another with a short note beside each. PAGES holds the words; a page may add its own section
// to the drawer (the ADB shell adds its command guide).
import { icon } from "./fileicons.js";
import { DEV_GUIDES, GUIDE_SECTIONS } from "./guides.js";

// view -> { name, intro, how: [...], tips: [...], tour: [[selector, title, text], ...] }
// A tour step whose element isn't on screen (no phone connected, a list still empty) is skipped.
const PAGES = {
  overview: {
    name: "Overview",
    intro: "The start page. It connects a phone and, once one is connected, shows its state at a glance.",
    how: [
      "Plug the phone in with USB debugging on and press Connect phone, or use Connect over Wi‑Fi (Android 11 and newer).",
      "Andromon talks to the phone with ADB, the same channel developers use. Nothing has to be installed on the phone to start.",
      "After connecting, the tiles open the most used tools, and the right column lists facts about the phone; click a row to copy it.",
      "Some tools (Messages, Contacts, Photos, Music, Notifications) need the Andromon Companion app on the phone. Andromon offers to install it when it is needed.",
    ],
    tips: ["Tools that need a phone are greyed out in the sidebar until one is connected.", "Settings and the Collapse button are at the bottom of the sidebar."],
    tour: [
      ["#nav", "The sidebar", "Every tool lives here, in groups you can fold: Communication, Files & media, Device and Developer."],
      ["#connectBtn", "Connect by cable", "With USB debugging on, this asks the phone for permission and connects."],
      ["#wifiConnectBtn", "Connect without a cable", "Pairs with the phone's Wireless debugging once; after that it connects with one click."],
      [".hd-group", "Quick actions", "Downloads in progress, this help panel, and Disconnect while a phone is connected."],
      ["#ovHero", "Battery and storage", "The phone's battery level and how full its storage is."],
      ["#ovQuick", "Shortcuts", "One click to the tools used most."],
      [".ov-side", "About this phone", "Model, Android version, serial and more. Click a row to copy its value."],
      ['#nav [data-view="settings"]', "Settings", "Appearance and every option of the tools are in one place."],
    ],
  },
  messages: {
    name: "Messages",
    intro: "Read and send the phone's SMS and MMS from this computer.",
    how: ["Conversations are read from the phone through the companion app; nothing is uploaded anywhere.", "Pick a conversation on the left to read it; type at the bottom to answer. The phone sends the message.", "Export saves all messages as XML or CSV; Restore puts a saved file back on the phone."],
    tips: ["Sending needs the phone to have signal, exactly as if you sent it there."],
    tour: [["#msgSearch", "Search", "Find a conversation by name, number or text."], ["#msgNew", "New message", "Start a conversation with any number."], ["#threadList", "Conversations", "Newest first. Click one to open it."], ["#threadView", "The conversation", "Messages, pictures, and the box to answer."]],
  },
  contacts: {
    name: "Contacts",
    intro: "The phone's address book: look up, edit, add, merge and back up contacts.",
    how: ["Click a name to edit that contact.", "The round buttons beside a number text or call it from the phone; Call needs two clicks.", "Find duplicates groups contacts that share a number, e‑mail or name so you can merge them.", "Export saves everyone as a vCard file; Import adds contacts from one."],
    tips: ["Tick several contacts to delete or export just those."],
    tour: [["#ctSearch", "Search", "By name, number or e‑mail."], ["#ctNew", "New contact", "Adds a contact on the phone."], ["#ctDups", "Find duplicates", "Shows contacts that look like the same person."], ["#ctRows", "The list", "Click a name to edit; the round buttons text or call the number."]],
  },
  calls: {
    name: "Call log",
    intro: "The phone's call history, and call alerts on this computer.",
    how: ["Each row is one call: who, when, how long, and whether it was missed.", "The phone button at the end of a row calls that number from the phone (two clicks).", "With call alerts on (Settings › Phone link), an incoming call pops up here with Answer and Decline.", "Export saves the history as CSV; Restore puts a saved history back."],
    tips: [],
    tour: [["#callAlertCard", "Call alerts", "Whether incoming calls show up on this computer."], ["#callSearch", "Search and filter", "Find calls by name or number, or show only missed ones."], ["#callRows", "The history", "Newest first."]],
  },
  calendar: { name: "Calendar", intro: "The phone's calendars and their events.", how: ["Events come from the calendars set up on the phone.", "Click a day or an event to see or change it; changes are written to the phone.", "Calendars can be exported to, and imported from, .ics files."], tips: [], tour: [['[data-panel="calendar"]', "Your calendar", "Months, events and the calendars they belong to."]] },
  notifs: {
    name: "Notifications",
    intro: "The phone's notifications on this computer: read them, answer, or dismiss them.",
    how: ["Switch it on in Settings › Notifications. The companion app then gets Android's “Notification access”.", "New notifications appear here and, if you like, as pop-ups.", "A notification that can be answered shows a reply box and your quick replies.", "Dismissing one here dismisses it on the phone too."],
    tips: ["Mute an app to keep it in the list without pop-ups."],
    tour: [["#ntCard", "Status", "Whether notifications are coming through, and what to do if not."], ["#ntSearch", "Search", "Filter the list by text or by app."], ["#ntList", "The notifications", "Newest first, with their buttons."]],
  },
  files: {
    name: "Files",
    intro: "Browse the phone's storage like a folder on this computer.",
    how: ["Click a folder to open it; the chips at the top lead back.", "Click a file to preview it on the right, with its details and actions.", "Tick files or folders to download, compress into a zip, or delete several at once.", "Upload copies files from this computer into the open folder."],
    tips: ["Compress and Extract make the zip or the folder on the phone, next to the original.", "Some system folders can't be listed: Android doesn't allow it without root."],
    tour: [[".fx-crumbs", "Where you are", "Each chip is a folder on the way here. Click one to go back to it."], [".fx-search", "Filter", "Shows only the names that contain what you type."], [".fx-tools", "Folder tools", "Up, reload, new folder and upload."], [".fx-head", "Sort", "Click Name, Size or Modified to sort by it."], [".fx-list", "Files and folders", "Click a folder to open it, a file to preview it."], [".fx-side", "Preview", "The file's content, details, and its actions: download, extract, compress, rename, delete."]],
  },
  photos: {
    name: "Photos",
    intro: "The phone's pictures and videos, as a gallery.",
    how: ["Thumbnails come from the phone's media library through the companion app.", "Click a picture to see it large; arrow keys move to the next.", "Tick pictures to copy them to this computer or delete them from the phone.", "Find duplicates looks for identical files."],
    tips: ["Copy new photos automatically is in Settings › Phone link."],
    tour: [["#phType", "Photos or videos", "Show everything, only pictures, or only videos."], ["#phAlbum-dd, #phAlbum", "Album", "Limit the gallery to one album."], ["#phSearch", "Search", "By file name."], ["#phAdd", "Add to phone", "Copies pictures from this computer to the phone."], ["#phGrid", "The gallery", "Click to view, tick to select."]],
  },
  music: {
    name: "Music",
    intro: "The phone's songs: browse, play here, copy, add.",
    how: ["Songs come from the phone's media library through the companion app.", "Switch between songs, artists and albums at the top.", "Click a song to play it on this computer.", "Tick songs to copy them here or delete them; Add music puts files on the phone."],
    tips: [],
    tour: [["#muView", "Songs, artists, albums", "Three ways to look at the same library."], ["#muSearch", "Search", "By title, artist or album."], ["#muAdd", "Add music", "Copies audio files from this computer to the phone."], ["#muBody", "The library", "Click to play, tick to select."]],
  },
  wifi: {
    name: "Wi‑Fi transfer",
    intro: "Send files between this computer and a phone over Wi‑Fi, without a cable.",
    how: ["Switch it on, and open the companion app's Receive screen (or a compatible app) on the phone.", "Phones that are ready appear in the list; pick one and choose files, or drop files on the window.", "Files sent from the phone ask for your OK here, then land in the folder shown.", "The transfer method and the folder are in Settings › Wi‑Fi transfer."],
    tips: ["Both devices must be on the same Wi‑Fi, except with Direct link."],
    tour: [["#wifiSwitch", "On or off", "While on, this computer can be found by phones on the same network."], ["#wifiMethodName", "Transfer method", "Auto, Same Wi‑Fi or Direct link."], ["#wifiFolder", "Received files", "Where files from the phone are saved."]],
  },
  storage: {
    name: "Storage map",
    intro: "See what fills the phone, folder by folder, and free space by deleting what you don't need.",
    how: ["The top card shows Android's own count: apps, photos, videos, music, downloads and the rest.", "The map shows the phone's storage as boxes sized by what each folder or file takes. Click a folder to go into it; the path above takes you back.", "The lists show the biggest items in the open folder and the biggest files below it. Delete asks for a second click."],
    tips: ["Folders that Android and apps need (DCIM, Download, Android…) can't be deleted as a whole: open them and delete what's inside.", "Deleted files are gone: there is no recycle bin on the phone. Back up first if in doubt."],
    tour: [["#storageRoot > .card:first-child", "By kind", "Android's own count of what takes the space."], [".sm-map", "The map", "Bigger box, more space. Click a folder to open it."], [".sm-lists", "Biggest items", "Delete what you don't need."]],
  },
  recovery: {
    name: "SD card recovery",
    intro: "Bring back deleted photos, videos and files from a memory card or USB stick in this computer.",
    how: ["Take the card out of the phone or camera and put it in this computer's card reader.", "Download PhotoRec once (the free program that does the recovery).", "Pick the card, what to look for and a folder on this computer.", "Start, and type your computer's password when asked: reading a whole card needs it.", "Open the folder when it finishes. Files get new names and are sorted into numbered folders."],
    tips: ["Stop using the card as soon as you notice something is missing: new photos overwrite deleted ones.", "This can't recover from a phone's built-in storage. On the phone, try Recover in Andromon Companion.", "A damaged card? Copy it to an image file first (for example with ddrescue) and recover from that."],
    tour: [["#recoveryRoot .card:nth-child(2)", "PhotoRec", "The recovery program. Downloaded once from its author's site and checked."], ["#recoveryRoot .card:nth-child(3)", "Source", "A card or drive in this computer, or an image file of one."], ["#recoveryRoot .card:nth-child(4)", "Options", "Which file types, and where the recovered files go."], ["#recoveryRoot .card:nth-child(5)", "Recover", "Start, watch the count grow, then open the folder."]],
  },
  apps: {
    name: "Apps",
    intro: "Everything installed on the phone: install, back up, uninstall, and look inside.",
    how: ["Drop an APK (or a set of split APKs) on the box at the top to install it.", "Click an app for its details: version, size, permissions, and its actions.", "Save APK copies an app's installer to this computer.", "Uninstall and Disable ask twice before doing anything."],
    tips: ["System apps are hidden until you change the filter."],
    tour: [["#apkDrop", "Install", "Drop an APK here, or click to choose one."], ["#appSearch", "Search", "By name or package."], ["#appScope-dd, #appScope", "Which apps", "Yours, system apps, or all."], ["#appRows", "Installed apps", "Click one for details and actions."]],
  },
  debloat: {
    name: "Debloat",
    intro: "Remove or disable preinstalled apps safely, using a community list that says what each one does.",
    how: ["Download the list once; it describes thousands of preinstalled packages and how safe each is to remove.", "Start with the Recommended level. Each row explains the package.", "Remove takes the app away for your user only: the file stays on the phone, so Restore always brings it back.", "A factory reset also brings everything back."],
    tips: ["If something stops working after removing an app, restore that app."],
    tour: [["#dbSafety-dd, #dbSafety", "Safety level", "Recommended is safe for most people; the levels below need more care."], ["#dbSearch", "Search", "By name, package or description."], ["#dbRemove", "Remove", "Removes the ticked apps for your user."], ["#dbRestore", "Restore", "Brings removed apps back."]],
  },
  revanced: {
    name: "ReVanced",
    intro: "Patch an app on this computer with ReVanced's official tools, then install the patched app.",
    how: ["First download ReVanced's patcher and patches (needs Java 17 or newer on this computer).", "Choose an app: drop an APK, or pick one from the phone.", "Tick the patches you want; ReVanced's own choice is preselected.", "Patch, then Install on the phone or save the APK."],
    tips: ["Apps installed from Play as “split” packages need a full APK file instead.", "Patched YouTube apps need GmsCore installed to sign in."],
    tour: [["#rvRoot .card", "Set-up", "Java, the patcher and the patches, with their versions."], ["#rvRoot", "Patch an app", "Choose the app, the patches, and where the result goes."]],
  },
  fdroid: {
    name: "F-Droid",
    intro: "Browse F-Droid's catalogue of free and open-source apps and install them on the phone.",
    how: ["Download the catalogue once; Update fetches the newest list.", "Search or pick a category, then open an app for its description and versions.", "Install downloads the APK to this computer, checks it, and installs it on the connected phone.", "Without a phone you can still browse and save APK files."],
    tips: ["Apps and versions that don't fit the connected phone are marked."],
    tour: [["#fdRoot", "The catalogue", "Search, categories and the apps."]],
  },
  controls: {
    name: "Controls",
    intro: "Switches for the phone's own settings: Wi‑Fi, Bluetooth, dark theme, animations and more.",
    how: ["Each switch reads the phone's current state and changes it when clicked.", "They do what the same switch does in the phone's Settings app.", "Reload reads every state again."],
    tips: ["A few switches don't exist on every Android version; those are left out or greyed."],
    tour: [["#refreshControls", "Reload", "Read the phone's current state again."], ["#controlsRoot", "The switches", "Grouped by topic. A click changes the setting on the phone."]],
  },
  mirror: {
    name: "Screen mirror",
    intro: "See the phone's screen in this window and use it with mouse and keyboard.",
    how: ["Start mirroring: a small capture helper (scrcpy) runs on the phone only while this is on; nothing is installed.", "Click is a tap, drag is a swipe, the wheel scrolls, right-click or Esc is Back. Typing goes to the phone.", "The control panel has the phone's buttons, media keys, brightness, and view options.", "Record saves the picture and sound as an MP4 file; Save frame and Copy frame take a still."],
    tips: ["Quality, sound, video format and the rest are in Settings › Screen mirror.", "Actual size shows every pixel; Keep on top holds the window above others."],
    tour: [["#mirrorStart", "Start", "Begins mirroring with the options shown on the right."], [".mr-setup", "Options in use", "Set in Settings › Screen mirror."], ["#mirrorStage", "The phone's screen", "Click, drag, scroll and type here."], ["#mirrorNav", "Navigation", "Back, Home, Recents and the phone's panels, left of the screen."], ["#mirrorKeys", "Controls", "Sound, power, media, view and capture, right of the screen. Point at an icon to see its name."], ["#mirrorType", "Type box", "Text typed here is pasted on the phone, in any language."]],
  },
  screen: {
    name: "Screenshot",
    intro: "Take pictures of the phone's screen and copy, save or rotate them.",
    how: ["Take screenshot captures the screen as it is now.", "A countdown (3, 5 or 10 seconds) gives you time to open a menu on the phone first.", "The icon group copies, saves, rotates or deletes the picture in view.", "Captures of this session stay in the strip below; click one to bring it back."],
    tips: ["Format, size, clean status bar and automatic copy or save are in Settings › Screenshot."],
    tour: [[".sh-main", "Take one", "Captures the phone's screen now."], [".sh-timers", "Countdown", "Captures after a few seconds."], [".sh .fx-group", "What to do with it", "Copy, save, rotate left or right, delete."], [".sh-stage", "The picture", "The capture in view."], [".sh-strip", "This session", "Earlier captures. Click one to see it again."]],
  },
  tests: {
    name: "Test automation",
    intro: "Record what you do on the phone as steps, and play them back as a test.",
    how: ["Start shows the phone's screen here. Record, then use the phone in the picture: each tap and text becomes a step.", "Steps are tied to the element you touched, not to a position, so they survive layout changes.", "Play runs the steps and reports which passed.", "Tests can be saved, loaded and exported."],
    tips: ["Add a check step to assert that a text or element is on screen."],
    tour: [["#atStart", "Start", "Shows the phone and gets ready to record."], ["#atSlot", "The phone", "Use it here while recording."], ["#atRoot", "Steps", "The recorded steps, their results, and the buttons to run them."]],
  },
  qa: { name: "App testing", intro: "Tools for checking an app before release: API calls, performance, security, traces.", how: ["Pick a tool with the tabs at the top.", "API tester sends requests from this computer; API calls records the requests apps on the phone make.", "Performance and Traces measure a running app; Security looks inside an APK."], tips: [], tour: [['[data-panel="qa"]', "The tools", "One tab per tool."]] },
  dev: { name: "Developer", intro: "Developer tools: logcat, an app's files and data, port forwarding, input, capture and device settings.", how: ["Pick a tool with the tabs at the top.", "Logcat streams the phone's log with filters.", "App tools show a debuggable app's private files and let you clear data or change permissions.", "Network forwards ports between this computer and the phone."], tips: [], tour: [["#devTabs", "Tabs", "One per tool."], ['[data-panel="dev"]', "The tool in view", "Each tab has its own controls."]] },
  backup: {
    name: "Backup & restore",
    intro: "Saves a copy of the phone's data on this computer, and puts a saved copy back.",
    how: [
      "Tick what to save (contacts, messages, call log, calendar, the list of apps, app installers, photos and videos) and press Back up now. Each backup goes into a new dated folder.",
      "Restore from a backup opens a backup folder, shows what it holds and lets you pick the parts to put back.",
      "Automatic photo copy saves new photos and videos each time the phone connects. Its switch and folder are in Settings › Phone link.",
    ],
    tips: ["A backup changes nothing on the phone.", "Restore only adds what isn't on the phone yet; nothing is deleted or replaced.", "Apps come back without their data or logins."],
    tour: [["#backupCard .card:nth-child(1)", "Back up", "Choose the folder and the parts, then Back up now."], ["#backupCard .card:nth-child(2)", "Restore", "Pick a backup folder and the parts to put back."], ["#backupCard .card:nth-child(3)", "Automatic photo copy", "Whether it is on, its folder, and what the last copy did."]],
  },
  shizuku: {
    name: "Shizuku",
    intro: "Shows whether the Shizuku app is on the phone and running, and starts it.",
    how: [
      "Shizuku is a free app that lends other apps on the phone the rights of adb.",
      "The companion app uses it for its Freezer, Memory and Battery saver screens, so they work without this computer.",
      "On a phone that isn't rooted, Shizuku stops when the phone restarts. Start Shizuku starts it again over the connection.",
    ],
    tips: ["After the first start, give the companion its permission: in the companion, Settings › Privileged access › Grant permission.", "It keeps running after you unplug the phone."],
    tour: [["#szCard .card:nth-child(1)", "State and actions", "Whether Shizuku is installed and running, with Start, Open on the phone and Check again."], ["#szCard .card:nth-child(2)", "What it is for", "The companion tools that use it."], ["#szCard .card:nth-child(3)", "Setting it up", "The steps, once per phone."], ["#ramCard", "Phone RAM manager", "Andromon's own helper: it gives the companion's Memory screen the same rights without Shizuku, until the phone restarts."]],
  },
  shell: {
    name: "ADB shell",
    intro: "Run commands on the phone, as with adb shell in a terminal.",
    how: ["Type a command and press Run. Each command's answer is kept as its own block.", "Hover a block to copy it, run it again, or put the command back in the box.", "The chips under the box are saved snippets: one click runs them.", "The command guide below lists useful commands; clicking one fills the box without running it."],
    tips: ["Commands run as Android's “shell” user: no root.", "A command must end by itself: use logcat -d, not plain logcat."],
    tour: [["#shellForm", "Command box", "Type here; Enter runs. ↑ and ↓ go through earlier commands."], [".snips", "Snippets", "Saved commands. Save as snippet keeps the one in the box."], [".tm-filter", "Filter", "Shows only the output lines that contain what you type."], [".tm-bar .fx-group", "Output tools", "Copy everything, save it as a text file, or clear."], [".tm-out", "Output", "One block per command, with how long it took."]],
  },
  settings: {
    name: "Settings",
    intro: "Every option of Andromon in one place.",
    how: ["Appearance: light or dark, the colour theme, the sidebar.", "Each tool has its own section here: Phone link, Notifications, Screen mirror, Screenshot, ADB shell, Wi‑Fi transfer.", "Saving files decides whether Andromon asks where each file goes.", "Downloads and sources lists what Andromon has downloaded, where from, and lets you update or remove it.", "About shows the version and checks for updates."],
    tips: ["Changes apply at once; there is no Save button."],
    tour: [["#settingsRoot .card:nth-child(1)", "Appearance", "Mode, colour theme and sidebar."], ["#settingsRoot .card:nth-child(2)", "Phone link", "What happens when a phone connects."], ["#settingsRoot .card:nth-child(4)", "Screen mirror", "The options the mirror page uses."], ["#settingsRoot .card:last-child", "About", "Version, updates and credits."]],
  },
};

export function initKnowledge({ $, el, extras = {} }) {
  const app = document.querySelector(".app");
  const btn = $("guideBtn");
  btn.replaceChildren(icon("book-open"));
  const view = () => app.dataset.view || "overview";
  const page = () => PAGES[view()] || PAGES.overview;

  // ---------- the drawer ----------
  const body = el("div", { className: "kb-body" });
  const closeBtn = el("button", { className: "fx-ib", type: "button", title: "Close" }, icon("x"));
  closeBtn.setAttribute("aria-label", "Close");
  const title = el("h2", {});
  const drawer = el("aside", { className: "kb-drawer", id: "kbDrawer" }, el("div", { className: "kb-head" }, title, closeBtn), body);
  drawer.setAttribute("aria-label", "How this page works");
  drawer.inert = true;
  const shade = el("div", { className: "kb-shade" });
  document.body.append(shade, drawer);
  btn.setAttribute("aria-controls", "kbDrawer");
  const isOpen = () => drawer.classList.contains("open");

  function open(on, focusBack = true) {
    if (on) render();
    drawer.classList.toggle("open", on); shade.classList.toggle("open", on);
    drawer.inert = !on;
    btn.setAttribute("aria-expanded", String(on));
    if (on) setTimeout(() => { if (isOpen()) closeBtn.focus(); }, 60);
    else if (focusBack) btn.focus();
  }
  btn.onclick = () => open(!isOpen());
  closeBtn.onclick = () => open(false);
  shade.onclick = () => open(false);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen() && !tour) { e.stopPropagation(); open(false); } }, true);

  // Developer and App testing have several tools behind tabs: the drawer explains the one that is open.
  const TABS = { dev: "devTabs", qa: "qaTabs" };
  const openTool = () => { const t = TABS[view()]; return t ? DEV_GUIDES[$(t).querySelector("button.on")?.dataset.part] || null : null; };
  /** The detailed beginner guide of one tool: plain sentence, then its sections. */
  function toolGuide(g) {
    const kids = [el("p", { className: "kb-plain", textContent: g.plain })];
    for (const [key, heading] of GUIDE_SECTIONS) {
      const v = g[key]; if (!v?.length) continue;
      kids.push(el("h3", { textContent: heading }));
      if (key === "what") kids.push(...v.map((t) => el("p", { className: "kb-p", textContent: t })));
      else if (key === "read" || key === "words") kids.push(el("dl", { className: "kb-dl" }, ...v.flatMap(([k, d]) => [el("dt", { textContent: k }), el("dd", { textContent: d })])));
      else kids.push(list(v, key === "how"));
    }
    return kids;
  }

  const list = (items, ordered) => el(ordered ? "ol" : "ul", { className: "kb-list" }, ...items.map((t) => el("li", { textContent: t })));
  function render() {
    const p = page(), tool = openTool();
    title.textContent = tool ? `${p.name} › ${tool.name}` : p.name;
    const kids = [el("p", { className: "kb-intro", textContent: tool ? `A beginner's guide to this tool. Switch tabs to read about another one.` : p.intro })];
    const start = el("button", { className: "btn primary kb-tour", type: "button" }, icon("play"), el("span", { textContent: "Show me around this page" }));
    start.onclick = () => { open(false, false); startTour(p.tour); };
    kids.push(start);
    if (view() !== "overview") {
      const whole = el("button", { className: "btn sm kb-tour", type: "button" }, el("span", { textContent: "Tour of the whole app" }));
      whole.onclick = () => { open(false, false); startTour(PAGES.overview.tour); };
      kids.push(whole);
    }
    if (tool) kids.push(...toolGuide(tool));
    else {
      kids.push(el("h3", { textContent: "How it works" }), list(p.how, true));
      if (p.tips.length) kids.push(el("h3", { textContent: "Good to know" }), list(p.tips, false));
    }
    const extra = extras[view()]?.();
    if (extra) kids.push(el("h3", { textContent: extra.title }), extra.node);
    body.replaceChildren(...kids);
    drawer.scrollTop = 0;
  }
  // Moving to another page while the drawer is open shows that page's help.
  new MutationObserver(() => { btn.title = `How ${page().name} works`; btn.setAttribute("aria-label", btn.title); if (isOpen()) render(); endTour(); })
    .observe(app, { attributes: true, attributeFilter: ["data-view"] });
  btn.title = `How ${page().name} works`; btn.setAttribute("aria-label", btn.title);
  // Switching to another tool's tab while the drawer is open shows that tool's guide.
  for (const id of Object.values(TABS)) new MutationObserver(() => { if (isOpen()) render(); }).observe($(id), { attributes: true, attributeFilter: ["class"], subtree: true });

  // ---------- the tour ----------
  let tour = null; // { steps, at }
  const spot = el("div", { className: "kb-spot", hidden: true });
  const tip = el("div", { className: "kb-tip", hidden: true });
  tip.setAttribute("role", "dialog");
  document.body.append(spot, tip);
  const onScreen = (sel) => {
    for (const node of document.querySelectorAll(sel)) { const r = node.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== "hidden") return node; }
    return null;
  };
  function startTour(steps) {
    const found = steps.map(([sel, name, text]) => ({ node: onScreen(sel), name, text })).filter((s) => s.node);
    if (!found.length) return showNote("There is nothing to point at yet. Connect a phone and open this page's content, then try the tour again.");
    tour = { steps: found, at: 0 };
    spot.hidden = false; tip.hidden = false;
    showStep();
  }
  function endTour() {
    if (!tour) { tip.hidden = true; return; }
    tour = null; spot.hidden = true; tip.hidden = true;
    btn.focus();
  }
  function showNote(text) {
    const ok = el("button", { className: "btn sm primary", type: "button", textContent: "OK" });
    ok.onclick = () => { tip.hidden = true; btn.focus(); };
    tip.replaceChildren(el("div", { className: "kb-text", textContent: text }), el("div", { className: "kb-nav" }, el("span", {}), ok));
    tip.style.left = `${Math.max(16, innerWidth - 380)}px`; tip.style.top = "110px";
    tip.hidden = false; ok.focus();
  }
  function place() {
    if (!tour) return;
    const s = tour.steps[tour.at];
    if (!s.node.isConnected) return endTour();
    const r = s.node.getBoundingClientRect(), pad = 6;
    const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad), right: Math.min(innerWidth - 4, r.right + pad), bottom: Math.min(innerHeight - 4, r.bottom + pad) };
    Object.assign(spot.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
    // The note goes below the part when there is room, otherwise above, otherwise over its lower edge.
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(12, Math.min(innerWidth - w - 12, box.left + (box.right - box.left) / 2 - w / 2));
    const top = box.bottom + 12 + h < innerHeight ? box.bottom + 12 : box.top - 12 - h > 0 ? box.top - 12 - h : Math.max(12, innerHeight - h - 16);
    tip.style.left = `${Math.round(left)}px`; tip.style.top = `${Math.round(top)}px`;
  }
  function showStep() {
    const s = tour.steps[tour.at], last = tour.at === tour.steps.length - 1;
    const b = (text, cls, fn) => { const x = el("button", { className: "btn sm" + (cls ? " " + cls : ""), type: "button", textContent: text }); x.onclick = fn; return x; };
    const next = b(last ? "Done" : "Next", "primary", () => { if (last) endTour(); else { tour.at++; showStep(); } });
    tip.replaceChildren(
      el("div", { className: "kb-step", textContent: `${tour.at + 1} of ${tour.steps.length}` }),
      el("b", { textContent: s.name }), el("div", { className: "kb-text", textContent: s.text }),
      el("div", { className: "kb-nav" }, b("End tour", "", endTour), el("span", { className: "sp" }),
        tour.at ? b("Back", "", () => { tour.at--; showStep(); }) : "", next));
    s.node.scrollIntoView({ block: "center", inline: "nearest" });
    place(); requestAnimationFrame(place);
    next.focus();
  }
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  document.addEventListener("keydown", (e) => {
    if (!tour) return;
    if (e.key === "Escape") { e.stopPropagation(); endTour(); }
    else if (e.key === "ArrowRight" && tour.at < tour.steps.length - 1) { tour.at++; showStep(); }
    else if (e.key === "ArrowLeft" && tour.at > 0) { tour.at--; showStep(); }
  }, true);

  return { open: () => open(true), close: () => open(false, false), startTour: () => startTour(page().tour) };
}
