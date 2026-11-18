# Andromon

An Android phone manager for **Windows and macOS**, in the style of the old phone suites (Moborobo, Wandoujia, AirDroid). The app talks ADB to the phone over USB using WebUSB, which is built into Electron's Chromium, through the MIT-licensed [Tango](https://github.com/yume-chan/ya-webadb) library. Nothing needs to be installed on the phone, and no `adb.exe` or Android SDK is needed on the PC.

This is the "Phase 1 – ADB-only" design.

**New here?** The [user guide](docs/USER_GUIDE.md) shows every page with screenshots and explains each option.

## Download

- **Andromon for macOS, Windows and Linux:** [Releases](https://github.com/Deshan555/Andromon_PC/releases). Each release lists its installers (`.dmg`, `.exe`, `.AppImage` / `.deb`) under **Assets**; pick the one for your computer.
- **Andromon Companion for Android (APK):** [Releases of the companion app](https://github.com/Deshan555/Andromon-android/releases). You normally don't need it: Andromon installs its bundled copy on the phone by itself.
- **Builds that are not released yet:** open the newest green run under [Actions](https://github.com/Deshan555/Andromon_PC/actions/workflows/desktop.yml) and download its **Artifacts** (needs a GitHub sign-in; kept for 90 days).

Releases are made by the build as **drafts**: a release shows on the Releases page once it has been published (see [Build installers](#build-installers)).

## Features

The window uses the same design as the companion app on the phone: brand colours lime `#E3F786`, green `#9CD237`, ink `#292A2C` and white; a light grey page with off-white cards, one lime-to-green gradient hero card on the Overview, big light headings, dark pill buttons, and a dark navigation rail whose open tool sits on white. It follows the system's light or dark mode unless **Settings** says otherwise.

**Settings** (bottom of the sidebar) has the appearance options: light / dark / same as the computer, five colour themes (Lime, Ocean, Sunset, Violet, Graphite), and collapsing the sidebar to a rail of icons (also the **Collapse** button under Settings, or Ctrl/⌘ + B). It also gathers the switches for call alerts, notification pop-ups and connecting over Wi‑Fi automatically. Appearance is stored in the app's local storage and applied before the page paints by `renderer/theme.js`; the page code is `src/settings.js`.

**Accessibility** (Settings, under Appearance; the same in the desktop app and the web version): text size (Default, Large, Larger, Largest: the whole page scales, so nothing overlaps), high contrast and reduce motion (each "Same as computer", On or Off; "Same as computer" follows the system's *Increase contrast* and *Reduce motion*), bold text, a plain system font instead of Poppins, a strong focus outline for keyboard use, and underlined links. Stored in `localStorage` (`dd.a11y.*`) and applied before the page paints by `renderer/theme.js` as attributes on `<html>`; the styles are at the end of `renderer/index.html`.

Settings also holds the **Screen mirror** defaults (quality, source, sound, phone screen off, frame rate; the same options as on the mirror page, kept in `localStorage`), **Saving files** (ask where each screenshot, recording or export goes, or save them straight into one folder; plus the Wi‑Fi receive folder), and **Downloads and sources**: what Andromon has downloaded (ReVanced's patcher and patches, F-Droid's catalogue, the debloat list), where each comes from, its size, and Download / Update / Remove (`appsettings.js` in the main process, `src/settings.js`).

The **Downloads** button at the top of every page is the download manager (`src/downloads.js`): each running download with a progress bar, speed, time left and Cancel, and a short history of finished, failed and cancelled ones. A ring around the button shows overall progress. The downloads run in the main process (`revanced.js`, `fdroid.js`), which announce start, progress and end on their event channels.

The sidebar groups the tools: **Communication** (Messages, Contacts, Call log, Calendar, Notifications), **Files & media** (Files, Photos, Music, Wi‑Fi transfer), **Device** (Apps, Debloat, ReVanced, F-Droid, Controls, Screen mirror, Screenshot) and **Developer** (Test automation, App testing, Developer, Shell). Click a group's heading to fold it; Developer starts folded, and the choice is remembered.

| Tab | What it does | How |
|---|---|---|
| Overview | Model, Android version, battery, storage, screen, uptime | `getprop`, `dumpsys battery`, `wm size`, `df` |
| Apps | List user, system, or all apps. **Install** by drag-and-drop: an `.apk`, several split `.apk`s, or an `.apks` / `.xapk` / `.apkm` bundle. Before installing, a preview shows the app's name, icon, version (vs. the installed one), required Android version, CPU match and permissions. Split bundles install only the splits that fit the phone's CPU, and `.xapk` game data (OBB) is copied too. **Manage** panel per app: version, install dates, open, force stop, clear data, disable/enable, export APK, uninstall, grant/revoke runtime permissions | `pm list packages`, `dumpsys package`, `monkey`, `am force-stop`, `pm clear`, `pm disable-user`/`enable`, `pm grant`/`revoke`, `pm uninstall` |
| Debloat | Remove, disable or restore pre-installed packages, using the [UAD-ng](https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation) community list: what each package does and how safe it is to remove (Recommended / Advanced / Expert / Unsafe). Removal is per user (`pm uninstall -k --user 0`), so it's always reversible here or by factory reset | list downloaded from GitHub on request and cached; `pm uninstall -k --user 0`, `pm disable-user`, `cmd package install-existing`, `pm enable` |
| ReVanced | Patch an app with [ReVanced](https://revanced.app) on this computer and install the result: for example YouTube without ads. **Download the patcher** fetches ReVanced CLI and the newest patches; the page then lists the phone's apps that have patches (with the version the patches are made for) and all supported apps. Choose an app from the phone, or drop an `.apk`; tick patches (ReVanced's defaults are pre-ticked), **Patch**, then **Install on the phone** or **Save the APK**. Also installs or updates **GmsCore** (needed for Google sign-in in patched YouTube / YouTube Music) and **ReVanced Manager** on the phone. Needs **Java 17+** on the computer. Apps installed from the Play Store as split parts can't be taken from the phone: ReVanced needs one full APK, so drop a file instead. **Any other app on this phone** lists every app you installed, for ReVanced's general patches (a second copy under another package name, allow screenshots, turn off certificate pinning…). A ticked patch shows its settings (switches, text and numbers; list-type settings stay at ReVanced's defaults). Andromon never downloads the apps themselves | Main process `revanced.js`: CLI v6.0.0 from github.com/ReVanced (SHA-256 pinned), `patches.rvp` from api.revanced.app with its PGP signature checked against ReVanced's key (fingerprint pinned), `java -jar … patch --exclusive -e …`, one signing keystore kept in the app's data folder so later builds update earlier ones. Page: `src/revanced.js`; APK pulled and pushed with adb sync, `pm install -r` |
| F-Droid | Browse and install free and open-source apps from [F-Droid](https://f-droid.org). **Download the catalogue** (about 25 MB) fetches F-Droid's list of about 5,000 apps; then search it, filter by category, sort by recently updated / newest / A to Z, and open an app for its screenshots (click one for full size), description, version, size, permissions, F-Droid's notes (ads, tracking…), every version and its links. **Install** downloads the version that fits the phone (Android version, processor) and installs it; **On this phone** lists the phone's apps that F-Droid has, **Updates** those with a newer version (one by one or **Update all**). Browsing and **Save the APK** work without a phone. An app that was installed from the Play Store with another signing key can't be replaced by F-Droid's build: Android refuses it and the page says so | Main process `fdroid.js`: `entry.jar` from f-droid.org with its JAR signature checked against F-Droid's certificate (SHA-256 fingerprint pinned), `index-v2.json` checked against the hash in it and reduced to the English texts (`catalog.json` in the app's data folder), an older index than the stored one is refused; icons, screenshots (up to 8 per app, phone ones in English first) and APKs are checked against their SHA-256 from the index. Page: `src/fdroid.js`; `pm list packages --show-versioncode -i`, APK pushed with adb sync, `pm install -r` |
| Controls | Toggles: Wi‑Fi, mobile data, Bluetooth, airplane mode, location, dark theme, auto-rotate, auto brightness, animations, show taps, Do Not Disturb, stay awake. Brightness, screen timeout, font size, media volume. Resolution/DPI override and reset. Wake, lock, reboot (normal, recovery, bootloader), power off | `settings get/put`, `cmd wifi`, `svc data`, `cmd bluetooth_manager`, `cmd connectivity`, `cmd location`, `cmd uimode`, `cmd notification`, `svc power`, `cmd media_session`, `wm size/density`, `input keyevent`, `reboot:` |
| Messages* | Conversations with contact names, SMS and **MMS** together: group conversations with everyone's name, pictures shown in the conversation (click to open or save), other attachments as a save link. Search covers text, subjects and attachment names. Reply / new SMS (a group conversation can only be answered with a normal SMS to one of its people: sending MMS is not supported). Export XML (compatible with SMS Backup & Restore; MMS with their text, without attachments) or CSV. **Restore…** puts the text messages of such an XML file back on the phone, after showing what the file holds; messages already there are skipped, MMS entries are counted and skipped | companion `sms.list`, `mms.list`, `mms.part`, `sms.send`, `sms.restore`; `appops set … WRITE_SMS allow` before a restore |
| Contacts* | List and search contacts with their photos. Click a name to **edit** it (name, numbers, e‑mail addresses, company, birthday, note, favourite, photo), **New contact**, **delete** one or many (tick them; asks first). **Find duplicates** groups contacts with the same phone number (last 9 digits), e‑mail address or name; for each group you choose which entry to keep, see the merged result, and merge: the kept one gets every detail of the others (and a photo if it had none), the others are deleted. Export vCard and import vCard, both with photos; import can skip contacts that are already on the phone | companion `contacts.list`, `contacts.add`, `contacts.update`, `contacts.delete`, `contacts.photo`, `contacts.setPhoto` |
| Call log* | Incoming, outgoing and missed calls with filters, export CSV. **Restore…** reads that CSV (or a `<calls>` XML file as SMS Backup & Restore writes it), shows the counts and adds the calls that aren't in the log yet | companion `calls.list`, `calls.restore` |
| Calendar* | The phone's calendars as an agenda: one month at a time, grouped by day, repeating events expanded by the phone. Switch calendars on and off, search all events, click an event for its details. **Export .ics** (the calendars that are switched on) and **Import .ics** into a calendar you choose, or into a new one kept only on the phone | companion `calendar.list`, `calendar.add`, `calendar.createLocal`; iCalendar reading and writing in `src/ics.js` |
| Phone backup* | On the **Backup & restore** page. **Back up this phone** writes a dated folder with contacts, messages, call log, calendar, a list of apps and, if ticked, app installers and all photos and videos. **Restore from a backup…** puts chosen parts back on a phone. **Copy new photos to this computer when the phone connects** (see [Phone backup and restore](#phone-backup-and-restore)) | the calls above, `media.list`, adb sync, `pm list packages`, `pm path`, `pm install`; files written by the main process (`backupfs.js`) |
| Notifications* | Every notification on the phone (WhatsApp, SMS, email…) live in a Notifications tab and as pop-ups (in the window, plus a system notification when Andromon is in the background). **Reply** from the PC with the app's own reply (typed text or one-click quick replies you can edit), press the notification's buttons ("Mark as read"…), dismiss one or clear all on the phone, mute pop-ups per app, search and filter by app. Off until switched on in the tab, which gives the companion "Notification access" over adb. SMS replies are sent as SMS directly | companion `NotifListener.kt` (a `NotificationListenerService`) on the `events` stream; `notif.list`, `notif.reply` (RemoteInput, like a smartwatch), `notif.action`, `notif.dismiss`, `notif.icon`. macOS system notifications get a reply field in signed builds |
| Call alerts* | While a phone is connected (USB or Wi‑Fi), incoming calls pop up in the window with the caller's name, **Answer**, **Decline** and **Silence**, plus a system notification when Andromon is in the background. Missed calls stay until dismissed, with **Call back** and **Message**. Answering picks up on the phone; the conversation stays on the phone. On/off switch at the top of the Call log tab (on by default) | companion `events` stream (`CallWatch.kt`: the PHONE_STATE broadcast), `call.answer` / `call.end`; Silence presses a volume key (`input keyevent`), Call back uses `am start -a android.intent.action.CALL`. The stream's 20 s ping doubles as a heartbeat: after 50 s of silence the link is checked, and a dead Wi‑Fi connection is closed instead of hanging. Notification buttons appear on macOS in signed builds only (`NSUserNotificationAlertStyle` = alert) |
| Phone links* | On the Overview. **Send to phone**: a link or text (typed, pasted or dropped) opens on the phone or arrives as a notification with Copy; the last 6 are kept. **Shared clipboard**: "Copy to phone's clipboard" and "Get phone's clipboard"; text sent from the phone ("Send clipboard to PC" on its notification or quick-settings tile) lands in this computer's clipboard. **Find my phone**: rings at full volume, even on silent, for up to 2 minutes. **Now playing on phone**: cover, title, play/pause, next/previous and seek for whatever app is playing; needs the companion's "Notification access" (one click, the same step as the Notifications tab). **Call** buttons on contacts' numbers and call-log rows dial on the phone (click twice to confirm) | `src/links.js`; companion `push.send`, `clip.set`, `phone.ring`, `player.control`, and `clip` / `ring` / `media` events on the `events` stream, which now stays open while a phone is connected even with call alerts and notifications off. "Get phone's clipboard" opens the companion's `ClipSendActivity` with `am start` (the phone must be unlocked). Call uses `am start -a android.intent.action.CALL`. Reading this computer's clipboard needs the `clipboard-read` permission, allowed for the app's own page in `main.js`. The recent list is stored in this computer's profile as plain text; clipboard contents aren't stored |
| Shizuku | On its own **Shizuku** page. For phones without the [Shizuku](https://shizuku.rikka.app) app it links to the download page. **Start Shizuku** when it is installed but not running (needed after every restart of an unrooted phone); a status badge when it runs. The companion uses Shizuku for its Freezer, RAM manager and Battery saver without the computer | `src/shizuku.js`; Shizuku's documented start command `sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh`, or its `libshizuku.so` starter when the script isn't there yet; status from `ps -A` (`shizuku_server`) |
| Files | Browse `/sdcard`; download, upload, delete | ADB sync protocol, `rm` |
| Screen mirror | Live phone screen in the window, 60 fps. Mouse = touch, wheel = scroll, keyboard typing, right-click/Esc = Back, clipboard both ways. Back / Home / Recents / volume / power / notifications / rotate buttons, phone-screen-off mode, save frame, full screen. Quality: 720p, 1080p or full. **Sound** from the phone (Android 11+). **Back/front camera** instead of the screen (Android 12+). **Record** to MP4 (picture + sound) | [scrcpy](https://github.com/Genymobile/scrcpy) server v3.3.3 (`renderer/scrcpy-server.jar`, Apache-2.0) run via `app_process`; H.264 decoded with WebCodecs via `@yume-chan/adb-scrcpy`; Opus audio via WebCodecs `AudioDecoder` + Web Audio; recording muxes the phone's own H.264/Opus packets into MP4 with [Mediabunny](https://mediabunny.dev) (no re-encoding) |
| Test automation | For testers: **record** a test by using the app on the live phone screen (tap, long-press, swipe, type, Back/Home), then **run** it again whenever the app changes. Buttons and fields are remembered by resource id / text / description rather than by position. Add checks ("this element / this text is shown" or "is not shown"), waits, screenshots and "open app" steps; edit, reorder and delete steps. A run waits for each element (10 s by default), stops at the first failing step and keeps a screenshot of it. **Run all**, HTML report, JUnit XML, import/export tests as JSON | `renderer/ui-helper.jar` (source in `uihelper/`) run via `app_process`: one UiAutomation session for reading the screen and injecting touches/keys. Fallback: `uiautomator dump` + `input`. See "Test automation" below |
| Screenshot | Capture the screen and save it as PNG | `screencap -p` |
| Developer | Logcat with crash finder, developer options as switches, per-app tools (permissions, Save APK, intents & deep links, private storage), screen recording and bug reports, live CPU/memory/frame graphs, Doze and battery tests, port forwarding and proxy, typing and fake GPS, several phones at once (see [Developer tools](#developer-tools)) | `logcat`, `setprop`/`settings`, `pm`/`am`/`run-as`, `screenrecord`, `bugreportz`, `dumpsys`, `adb reverse`, `cmd location` |
| App testing | Performance tests (startup, smoothness, memory) with limits and history, security scan of an app or APK, API calls the phone makes (HTTP/HTTPS proxy), an API tester with collections and tests, and Perfetto traces, method traces and heap dumps (see [App testing](#app-testing)) | `am start -W`, `dumpsys gfxinfo/meminfo`, APK/dex parsing, `adb reverse` + proxy, `perfetto`, `am profile`, `am dumpheap` |
| Shell | Run any shell command, with saved snippets and ↑/↓ history | `exec:` service |
| Photos | The phone's gallery as thumbnails: filter by photos/videos and album, sort by date or size, search. Full-screen viewer for photos and videos (← → keys). Select (click the circle or Ctrl/⌘-click), then copy to a folder on the computer (album sub-folders when several albums are selected) or delete. **Add to phone** puts files into the album you're viewing (or `Pictures`/`Movies/Andromon`) and indexes them, so they show up in the gallery at once. **Find duplicates** compares sizes, then the first and last 64 KB, then SHA‑1, and keeps the oldest copy. | Companion `media.*` calls (MediaStore index, thumbnails, delete, rescan, duplicates); file contents over adb sync |
| Music | Songs, Artists, Albums and Folders, search, optional recordings and ringtones. Plays a song on the computer (with next/previous), copies to a folder (artist sub-folders), adds music to `Music/Andromon`, deletes, and finds duplicate songs. | Same as Photos |
| Wi‑Fi transfer | Send files to and receive files from phones running [LocalSend](https://localsend.org) on the same network. No cable, no developer options. Works without a phone on USB | LocalSend protocol v2 over HTTPS in the Electron main process (`localsend.js`) |

\* These tabs use the **Andromon Companion** ([Andromon-android](https://github.com/Deshan555/Andromon-android)), a 40 KB helper app. Andromon installs it over USB the first time one of these tabs is opened, after the user clicks "Install companion". It talks only over the USB cable. See the [companion's README](https://github.com/Deshan555/Andromon-android#readme).

### Connect over Wi‑Fi (Wireless debugging)

Everything in Andromon also works without a cable, on Android 11 and later, through Android's own **Wireless debugging**:

**Easiest (no settings to find):** connect the phone with the USB cable once and click **Use this phone without the cable** on the Overview. Andromon:
1. Lets Andromon Companion switch Wireless debugging on and off (`pm grant … WRITE_SECURE_SETTINGS`; only a computer can grant this).
2. Turns Wireless debugging on. The phone asks once to "Allow wireless debugging on this network"; tap Allow.
3. Finds its address and port: mDNS, then `service.adb.tls.port`, then adbd's listening socket in `/proc/net/tcp*`.
4. Checks a Wi‑Fi connection using the **same key the phone already trusts from USB**, so no QR code or pairing code is needed, and remembers the phone.

After that, on the phone: **Andromon Companion › PC link › Turn on Wi‑Fi connection**. Andromon lists the phone on its welcome screen under **Your phones over Wi‑Fi**, or connects by itself with **Connect automatically**. If a phone doesn't accept the USB key over Wi‑Fi, the setup falls back to the QR code below.

**Without a cable at all:**

1. On the phone, turn on **Developer options › Wireless debugging**, on the same Wi‑Fi as the computer.
2. In Andromon, click **Connect over Wi‑Fi**. A QR code appears.
3. On the phone, tap **Pair device with QR code** and scan it. Andromon pairs, then connects.

You only pair once; after that the phone is listed under **Your phones** and connects with one click. There's also **Pair with a 6-digit code** and **Connect by address**, for networks that hide devices from discovery. Andromon Companion's **PC link** screen shows which step the phone is at and opens the right Settings page.

How it works (`wadb.js`, main process): Tango (the ADB library) can't pair or speak TLS, so Andromon does it:
- **Pairing:** adb's protocol is SPAKE2 (BoringSSL's Ed25519 variant) over TLS 1.3, keyed with exported keying material, then AES‑128‑GCM‑encrypted exchange of Andromon's adb public key for the phone's ID.
- **Discovery:** mDNS (`_adb-tls-pairing._tcp`, `_adb-tls-connect._tcp`).
- **Connecting:** when the phone answers `STLS`, Andromon upgrades the socket to TLS with its paired key. From then on the renderer's Tango runs unchanged over a MessagePort, so every tab (Apps, Files, Mirror, Photos…) works as over USB.

Security: the link is encrypted, and only computers paired on the phone are accepted; you can remove them under Wireless debugging › Paired devices. The wireless key is separate from the USB key and is stored in the app's data folder (`wireless-adb-key.json`).

### Phone backup and restore

**Back up this phone** (Backup & restore page) asks once for a folder, remembers it, and writes a new folder each time:

```
Andromon backup <model> <yyyy-mm-dd HHmm>/
  backup.json     what's inside, counts, phone model and Android version, Andromon version, time
  contacts.vcf    vCard 3.0, photos included
  messages.xml    SMS and MMS in the "SMS Backup & Restore" layout; MMS attachments are files in mms/
  calls.csv       the Call log tab's CSV, plus calls.xml (same data, SMS Backup & Restore layout)
  calendar.ics    every calendar's events
  apps.csv        installed user apps: name, package, version, version code, installed from
  apps/<package>/*.apk   only with "App installers" ticked (base + split APKs)
  photos/<album>/…       only with "Photos and videos" ticked: the original files; photos.json lists where each was
```

- Each part shows its own progress and result. **Cancel** stops after the current file. A part that fails is reported and the others still run; `backup.json` records what succeeded.
- The photos tick box shows how many files and how much space they need before you start.
- **Restore from a backup…** opens a `backup.json`, shows what the folder holds, and restores what you tick onto the phone that's connected: contacts (ones already there are skipped), SMS and calls (same), calendar events (into the calendar with the same name, otherwise the one you pick or a new one on the phone), photos and videos (pushed back to where they were on shared storage, otherwise `Pictures/Restored`, then indexed; a file is never overwritten), and apps (saved installers are reinstalled unless the app is there; without installers the list is shown). Running a restore twice adds nothing twice.
- **Not in a backup:** what apps keep inside themselves (chats, game progress, logins), phone settings, Wi‑Fi passwords, music. **Saved but not restorable:** MMS (Android doesn't let Andromon write them).
- **SMS restore** depends on Android's `WRITE_SMS` app-op, which Andromon allows for the companion over adb. Some phones ignore it; the companion reads back what it stored and says so if nothing was kept.
- **Copy new photos to this computer when the phone connects** (switch at the bottom of the backup card, with its own folder): on every connection, USB or Wi‑Fi, photos and videos that aren't in the folder yet are copied to `<folder>/<model> (<serial>)/<album>/`, in the background, with a small progress note and a summary. What was copied is remembered per phone (MediaStore id, size and date, in Andromon's data folder under `photo-backup/`), and the file must also really be in the folder: delete a copy and it's fetched again. Nothing is ever deleted, on the phone or on the computer.
- Calendar files: timed events are written in UTC without time-zone blocks, all-day events as dates, repeat rules as the phone stores them. A repeating event's own time zone is kept in an extra `X-ANDROMON-TZ` line that Andromon reads back (and `X-DROIDDESK-TZ`, written before the app was renamed); other calendar apps show such a series at a fixed UTC time, which shifts by an hour across daylight-saving changes. On import, events with a time zone Andromon doesn't know (Windows zone names) or with none are read in this computer's time zone; guests and reminders are not imported, so nobody gets an invitation.
- How it's built: `src/backup.js` (backup, restore, photo copy), `src/pdata.js` (vCard, messages/calls files, duplicate contacts, safe file names) and `src/ics.js` are kept free of DOM where possible, so node can test them. The sandboxed page can't touch the disk: `backupfs.js` in the main process writes only inside the folders picked in its own dialogs, checks every relative path, writes to a temporary name first and never replaces a finished file.

### Test automation

1. Open **Test automation**, click **New test**, give it a name and the app's package (or **Use the app on screen**).
2. Click **● Record**. Use the app **on the phone itself**, or on the phone's screen shown on the left (click = tap, hold = long-press, drag = swipe, scroll wheel = swipe, keyboard = typing, Esc / right-click = Back). Both are recorded. While recording, the phone shows a floating **Recording** badge with the number of steps and the last one (needs Andromon Companion; Andromon offers to install it). If the test is empty, recording starts by restarting the app, so the test always begins from its first screen.
3. Each action is first matched to the element under the pointer and added to the step list, then performed on the phone by the same code that replays tests. Add **Check element…** (then click the element), **Check text**, **Wait** or **Screenshot** where needed. Click a step to change how it finds its element, its text or its timeout.
4. **▶ Run** replays the test; **▶ Run all** (in the list) replays every test. Save the result as an HTML report (with screenshots) or JUnit XML.

How it works (`src/autotest.js`):
- **Reading the screen.** `uiautomator dump` takes 2–3 s per call because it starts a new process each time. Instead a 7 KB helper (`uihelper/`, built to `renderer/ui-helper.jar`) is pushed to `/data/local/tmp` and run with `app_process`, like the scrcpy server: nothing is installed, and it exits when Andromon disconnects. It keeps one UiAutomation session open and answers `dump` in a few milliseconds, and also injects taps, swipes, keys and text. If it can't start, Andromon falls back to `uiautomator dump` and `input` (same results, slower).
- **Selectors.** For a tap, the smallest element under the pointer is taken (in the topmost window that really has something there), and the shortest combination of resource id / description / text / class that matches only that element is stored, plus where inside the element the tap landed. Text typed into a field is never used to identify it. If nothing with a name is there (games, custom-drawn screens), the step is stored by position as a fraction of the screen.
- **Actions on the phone.** While recording, `getevent -lt` streams the touchscreen's raw events. A finger landing is seen at once; the element under it is looked up in a picture of the screen taken just before (refreshed about three times a second while recording), because the app has already reacted by the time the finger lifts. Raw panel coordinates are scaled by the ranges from `getevent -p` and turned for the current rotation. Taps on the on-screen keyboard aren't stored as taps: when typing pauses or the next action comes, the text added to the focused field becomes one **Type** step. Password fields hide their text, so those steps are added empty and marked for the tester to fill in. The three-button navigation bar is stored as Back / Home / Recents keys. Taps sent from this computer don't pass through the touchscreen, so nothing is recorded twice. Two-finger gestures aren't recorded. The keyboard's Enter/Search key isn't seen: add it with **Enter**.
- **Recording badge.** Andromon opens the companion's `rec.session` (see the [companion's README](https://github.com/Deshan555/Andromon-android#readme)) and keeps it open while recording; the badge is left out of what is recorded, and dragging it adds no step. Android hides such badges on its own Settings screens.
- **Timing.** Replays don't use recorded delays for element steps: each step polls until its element appears. After every action the runner waits until the screen has stopped changing, so the next step doesn't land in the middle of a transition.
- **Limits.** Only one UiAutomation client can run on a phone at a time, so close Appium / UI Automator Viewer first. Tests are stored in this computer's Andromon profile (export them to share or keep in version control). Typed text, including passwords, is stored in the test as plain text. "Erase the app's data first" on an **Open app** step runs `pm clear` and is off by default.

### Developer tools

The **Developer** tab collects what Android developers do with `adb` every day. Each sub-tab is its own file in `src/dev/` (styles in `renderer/dev/`), loaded the first time it's opened; `src/devtools.js` holds the tabs and the shared app picker (type a package, pick from the list, or **Current app** for the one on screen).

- **Logcat:** live log (`logcat -v threadtime`, main/system/crash buffers, last 500 lines first), coloured by level. Filter by level, text or `tag:Name`, or **Only this app** (follows the app's process ids across restarts). Pause, Clear (also on the phone), Save as .txt, auto-scroll and wrap. Java crashes (`FATAL EXCEPTION`) and native crashes (`Fatal signal`) are grouped under **Crashes**, with **Copy stack trace** and **Show in log**.
- **Dev settings:** switches for layout bounds, GPU overdraw, GPU rendering bars, pointer location, show taps, don't keep activities (opens the phone's Developer options: Android ignores this setting unless it's switched there), background "not responding" dialogs, right-to-left layout and a clean status bar (demo mode: 12:00, full battery). Animation speed (off to 10×), font size (to 2×), screen size and density with presets (small phone to 10″ tablet) and **Back to normal**, and **Wait for debugger** for the chosen app.
- **App tools:** version, SDKs, debuggable, installer, uid and data folder; Launch, Restart, Force stop, Clear data & restart, App settings. A switch per runtime permission (plus special access such as "display over other apps"), Grant all / Revoke all. **Save APK** (split APKs as one `.apks` zip). **Open a link or intent**: activity, broadcast or service with action, data, category, component and typed extras; the last 20 are kept. **App storage**: the app's private folder through `run-as` (debuggable apps) or `Android/data/<pkg>`; view, download, delete, and drop files in to upload.
- **Capture:** screen recording to MP4 (size, bit rate, length up to 3 minutes, optional show-taps), a full bug report (`bugreportz`, saved as .zip), and device details to copy as Markdown or text for bug tickets.
- **Performance:** live CPU, memory (PSS/RSS) and frames per second / jank / frame-time percentiles for the chosen app, with 2‑minute charts. Battery: pretend unplugged, fake level, reset or save battery stats. Doze: force deep Doze, step, leave. App standby bucket and inactive state.
- **Network:** port forwarding without an adb server. *Phone → PC* (`adb reverse`): apps on the phone reach a server on this computer at `127.0.0.1:<port>`, e.g. Metro on 8081 or a dev server on 3000. *PC → phone*: programs here connect to `127.0.0.1:<port>` and reach a port or `localabstract:` socket on the phone, e.g. Chrome DevTools. Rules are saved and come back on the next connection. The main process (`main.js` › `setupDevnet`) only opens or dials 127.0.0.1 and hands each connection to the page as a MessagePort. **Proxy:** set or clear the phone's HTTP proxy, or one click to use Charles/mitmproxy on this computer over the cable.
- **Input:** type into the focused field from a box or key by key, type this computer's clipboard, press system keys, open the notification shade or quick settings.
- **Fake location** (Android 12+): pick the spot on an OpenStreetMap map (click, drag the pin, search for a place, type or paste "lat, long", or a city preset) and set it through Android's test providers for GPS, network and fused location. "Show the phone's location" reads the phone's last known position and marks it on the map. The map is [Leaflet](https://leafletjs.com) with tiles from tile.openstreetmap.org; search uses OpenStreetMap's Nominatim, only when you press Search and at most once a second. Nothing is requested from either until the tab is opened.
- **Phones:** keep more than one phone connected. **Add another phone (USB)**, then **Use this phone** to make it the one every tab works with (the other stays connected). Run a shell command, install an APK or take screenshots on all of them at once.
- **Shell tab:** saved snippets (one-click commands; save your own, remove with ×) and command history with ↑ / ↓.

Leaving the phone as it was: **Disconnect** first stops a recording or bug report, removes phone → PC forwards, clears a proxy that pointed at this computer, ends Doze or the fake battery, and stops a fake location. If the cable is pulled instead, a leftover fake location is removed the next time the phone connects. Display changes (layout bounds, screen size, animation speed, font size…) stay until you change them back, like the same switches in Developer options.

Limits: typing from the computer uses `input text`, so only plain ASCII (Screen mirror can paste any text). In phone → PC forwarding, a client that sends and hangs up in the same instant (e.g. `printf … | nc`) can lose its data in the ADB library; normal clients (browsers, HTTP libraries, Metro) are fine. Extra phones in **Phones** are USB only. App standby buckets didn't change on the Android 12 emulator; Doze needed `deviceidle enable deep` there first (done automatically).

### App testing

The **App testing** tab is for testers and for checking an app before release. It uses the same sub-tab framework as Developer (`src/devtools.js` › `initAppTesting`, parts in `src/qa/`, styles in `renderer/qa/`) and the same app picker.

- **Performance tests:** repeatable measurements with pass/fail limits and history. *Startup time*: cold, warm or hot, 3–10 runs (`am start -W`), median / fastest / 90th percentile / slowest, plus "fully drawn" when the app reports it. *Smoothness*: swipes the screen that's open and reads `dumpsys gfxinfo` (janky frames, frame-time percentiles, causes). *Memory over repetitions*: opens and leaves the app 5–20 times and charts PSS, heaps, views and activities; a steadily rising activity count is flagged as a possible leak. Limits are editable. Every run is kept (100 most recent) with app version and phone; pick a baseline to see what got better or worse; export as JSON or an HTML report.
- **Security scan:** checks an app you build, either installed on the phone or an `.apk` from this computer. Static: manifest (debuggable, backup, cleartext traffic, network security config including user-CA trust and pinning, exported components and how they're protected, deep links, permissions, old SDK levels), signing schemes and debug keys, and strings in code and assets (dex, resources, React Native bundles, Flutter's Dart code) for hard-coded keys and tokens, `http://` servers, risky WebView/TLS calls and weak crypto. On the phone (read-only, optional): exported content providers that answer without permission, private files readable by others and secrets in SharedPreferences (debug builds, via `run-as`), files in `Android/data`, tokens or passwords in the app's log, and an open WebView debugging socket. Each finding has a severity, what it means, how to fix it, and evidence with secrets masked. Export as HTML or JSON. It reads; it doesn't attack anything.
- **API calls:** see the web requests apps on the phone make. **Start capture** runs a proxy on this computer (`inspector.js`, 127.0.0.1 only), forwards the phone's port to it (`adb reverse`, see `src/dev/tunnel.js`) and sets the phone's proxy; **Stop capture**, Disconnect or the next connection after a pulled cable clear it again. Plain HTTP is recorded in full; HTTPS shows as a tunnel unless **Decrypt HTTPS** is on, which needs Andromon's certificate installed on the phone (the tab puts it in Download and opens Settings) and an app that trusts user certificates: debug builds with the `debug-overrides` network security config shown in the tab. Pinned apps refuse it, and that's shown. Filter (`host:`, `status:4xx`, `method:`…), inspect headers and bodies (JSON tree, images), copy as cURL, export HAR, or **Open in API tester**.
- **API tester:** a small Postman. Method, URL, params, headers, body (JSON, text, form), auth (Bearer, Basic, API key), environments with `{{variables}}` (plus `{{$timestamp}}`, `{{$uuid}}`, `{{$randomInt}}`), tests (status, time, header, body text, JSON value), and "save to variable" to chain a login token into the next request. Collections run as a suite with a pass/fail report; import and export Postman v2.1 collections. Requests are sent by the main process (`apiclient.js`), so any server works. Saved in this computer's Andromon profile; credentials are left out of the history.
- **Traces:** a Perfetto system trace (Android 9+) with presets for app & UI, app startup (cold-starts the app while recording), CPU & battery, and memory, 5 s to 1 min, optionally with logcat. **Open in Perfetto** serves the trace once from 127.0.0.1:9001 and opens ui.perfetto.dev in the browser, like Android's `record_android_trace` script (`traceview.js`); the file isn't uploaded. Also method traces (`am profile`) and Java heap dumps (`am dumpheap`) for debug builds, to open in Android Studio.

### SD card recovery (PhotoRec)

The **SD card recovery** page (Files & media, works without a phone) recovers deleted photos, videos and files from a memory card or USB stick in this computer's card reader, or from an image file of one. The work is done by [PhotoRec](https://www.cgsecurity.org/wiki/PhotoRec) 7.2 (GPL v2+, Christophe Grenier), which is not bundled: Andromon downloads the official build from cgsecurity.org the first time and checks its SHA-256 (`recovery.js`), or uses a copy already installed (`brew install testdisk`, the `testdisk` package on Linux).

- Only removable drives are offered, and PhotoRec only reads them. Recovered files go to a folder you pick on the computer, in `Recovered <date>/recup_dir.N`.
- Reading a whole drive needs administrator rights: macOS shows its password dialog, Linux uses `pkexec`, Windows the UAC prompt (PhotoRec then runs in its own window). An image file needs none.
- It cannot recover from a phone's built-in storage (encrypted, and deleted space is wiped). The companion's **Recover** screen finds what is still in trash and recycle folders on the phone.

### Wi‑Fi transfer (LocalSend)

- Off by default. Nothing listens on the network until you turn it on, and the listener stops when you turn it off or close the window.
- HTTPS only. Andromon makes its own self-signed RSA-2048 certificate (stored in the app's data folder as `localsend-identity.json`). When sending, it pins the phone's certificate to the fingerprint the phone announced, and refuses on a mismatch. Phones with LocalSend's "Encryption" turned off are listed but can't be used.
- Every incoming transfer needs **Accept** in the window (auto-declined after 60 s). Uploads must match the session, a random per-file token and the sender's IP, and can't exceed the size announced up front. File names are sanitised and kept inside the download folder (default `Downloads/Andromon`, changeable).
- The first time you turn it on, **Windows Firewall** and **macOS** (for unsigned builds) ask whether to allow incoming connections. Allow it on private networks.
- Uses UDP multicast `224.0.0.167:53317` for discovery and TCP `53317`. If the LocalSend desktop app is running on the same computer, close it first (same port).
- **Transfer methods** (chosen in the Wi‑Fi tab, remembered):
  - **Same Wi‑Fi:** through the router. Works with Andromon Companion and the LocalSend app.
  - **Direct link** (Andromon Companion only): after the transfer is accepted, the phone starts a temporary private hotspot (Android's LocalOnlyHotspot, random name and password). Its details come back inside the encrypted reply, Andromon joins it (macOS `networksetup`, Windows `netsh wlan`, no admin needed), checks the phone's pinned certificate, sends, then forgets the network and reconnects to the previous Wi‑Fi. Data takes one hop instead of crossing the air twice through the router. The computer has no internet while it's on the phone's network. If joining automatically isn't allowed, Andromon shows the network name and password to join by hand. If that doesn't happen within 2 minutes, it sends over the normal Wi‑Fi instead.
  - **Auto** (default): Direct link for transfers of 100 MB or more when the estimated speed is under 6 MB/s; otherwise Same Wi‑Fi.
- **Link quality:** the Wi‑Fi tab shows this computer's band, rate and signal (macOS `system_profiler`, Windows `netsh`), and for Companion phones their link too, with an estimated speed. 2.4 GHz and weak links are flagged.
- PIN-protected receivers aren't supported yet. Turn off "Require PIN" in LocalSend on the phone.
- Speed: when sending, connections are kept alive and up to 3 files upload at once, so folders of photos don't pay a TLS handshake and a round trip per file. Large files are limited by the Wi‑Fi link, not by Andromon. For the best speed, put both devices on 5 GHz (or 6 GHz) Wi‑Fi, or connect the computer by Ethernet. Phone-to-computer speed is set by the LocalSend app on the phone.

## Develop

```sh
cd pc
npm install
npm start          # builds src/app.js -> renderer/app.js, then opens the desktop app
npm run web        # same UI in Chrome/Edge at http://localhost:8000 (no Electron)
npm run build:companion   # rebuild the companion (Andromon-android cloned next to this repo as ../android) and copy the APK to renderer/companion.apk
npm run build:uihelper    # rebuild uihelper/ into renderer/ui-helper.jar (needs a JDK and the Android SDK)
```

## Build installers

```sh
npm run dist:mac   # -> dist/Andromon-0.1.0-arm64.dmg and -x64.dmg   (run on a Mac)
npm run dist:win   # -> dist/Andromon-Setup-0.1.0-*.exe (x64 + ARM64) (best run on Windows)
npm run dist:linux # -> dist/Andromon-0.1.0-x86_64.AppImage and -amd64.deb (x64)
```
The installers' look is in `build/`: `icon.png` (the app icon, turned into `.icns` / `.ico` by electron-builder), the Windows setup wizard's pictures (`installerSidebar.bmp`, `uninstallerSidebar.bmp`, `installerHeader.bmp`) and its welcome texts (`installer.nsh`), and the macOS disk image's background (`background.png`, `@2x`). The Windows wizard's pages: Welcome › install for me or for everyone › folder › installing › Finish (with "Run Andromon"), plus desktop and Start menu shortcuts and an uninstaller that keeps settings. Add `build/license.txt` to get a licence page.


**Automatic builds:** every push to the `release` branch builds the macOS, Windows and Linux installers on GitHub (`.github/workflows/desktop.yml`). They are attached to the workflow run and collected in a **draft** GitHub Release named after the version in `package.json` (for example `v0.1.0`); open **Releases**, check it, and press **Publish**. Pushing the same version again replaces the files on that release, so raise `version` in `package.json` for a new one. 
After each build the workflow commits two files to the `release` branch (`scripts/release-manifest.js`):

- **`latest.json`**: the newest build. Version, build number, date, commit, the commit subjects since the previous build, and every installer with its platform, CPU type, size, SHA-256 and download address. The addresses work once that version's release is published. Always available at `https://raw.githubusercontent.com/Deshan555/Andromon_PC/release/latest.json`.
- **`CHANGELOG.md`**: one section per build, newest first, listing the commits since the build before it. The same list is the description of the GitHub Release.

**Update check** (`updater.js`, Settings › About): the app reads `latest.json` from the `release` branch, once a day at start-up (can be switched off) or on **Check now**. A build is newer when its version is higher, or when the version is the same and its build number is higher; the build number of an installed copy is stamped into `build-info.json` by the workflow (copies run from source have build 0 and are only offered a higher version). When there is one, a pill appears in the header and Settings lists what's new; **Download update** saves the installer for this computer (right platform and CPU type) to the Downloads folder through the download manager, checks its SHA-256 against `latest.json`, and **Open installer** starts it. Nothing is installed silently. The download works only once that version's release is published.

Because the build adds commits to `release`, bring `main` into it with a merge rather than pushing `main` over it:

```sh
git checkout release && git pull && git merge main && git push && git checkout main
```

The first time, create the branch with `git push origin main:release`.

The workflow can also be started by hand from **Actions → Build desktop app → Run workflow**; that run only attaches the installers.

**Optional tools:** Andromon needs nothing else to connect a phone. Java 17+ is needed only for ReVanced patching, and the Android platform tools (adb) only for people who use adb in a terminal. **Settings › This computer** shows what is installed, with its version and path (`requirements.js`), and offers Install (Windows, through winget) or the download page. The Windows setup wizard has an **Optional tools** page (`build/installer.nsh`): nothing is ticked by default, and a ticked tool is installed with winget before Andromon's files are copied. The `.deb` lists `default-jre` and `android-sdk-platform-tools-common` as recommended packages, so apt installs them alongside by default. The macOS disk image has no install step, so on a Mac use Settings.

**Linux:** the AppImage runs after `chmod +x`; the `.deb` installs with `sudo apt install ./Andromon-0.1.0-amd64.deb`. To let the app reach a phone over USB without root, the phone needs a udev rule (the `android-udev-rules` or `android-sdk-platform-tools-common` package provides them). The Linux build has not been run on a Linux computer yet.

**Unsigned builds:**
- **macOS** says the app "can't be opened". Right-click the app, choose **Open**, then confirm. Alternatively, run `xattr -dr com.apple.quarantine "/Applications/Andromon.app"`.
- **Windows SmartScreen** shows a warning. Click **More info**, then **Run anyway**.

**Signed builds:** to ship to other people without these warnings, sign the builds.
- **macOS:** needs an Apple Developer ID plus notarization ($99/yr).
- **Windows:** needs a code-signing certificate or Azure Trusted Signing.

The workflow file lists the environment variables electron-builder needs for signing.

## Connecting a phone

1. On the phone, open **Settings → About phone** and tap **Build number** 7 times. Then go to **Developer options** and turn on **USB debugging**.
2. Plug the phone in and click **Connect phone** (the plug button at the top right). Then tap **Allow** on the phone. Tick "Always allow from this computer" so you aren't asked again.
3. If another program holds the phone's USB connection (an `adb` server from the SDK, Android Studio or scrcpy), the desktop app stops adb itself (`adb kill-server`, then any adb process still running) and connects again. If it still says the device is busy, a program such as Android Studio started adb again: close it and retry. The browser version can't run programs, so there you run `adb kill-server` yourself.
4. **Windows:** Android 10+ phones connect with no driver, because Windows binds WinUSB automatically. Older phones may need the [Google USB Driver](https://developer.android.com/studio/run/win-usb) or the manufacturer's driver.
5. **Xiaomi / Oppo / Vivo:** also turn on "USB debugging (Security settings)" or "Install via USB" so app install works.

## Updating scrcpy

`renderer/scrcpy-server.jar` must be the exact version that `@yume-chan/scrcpy` supports (`SCRCPY_VERSION` in `src/app.js`, currently 3.3.3). To upgrade, bump `@yume-chan/adb-scrcpy` / `@yume-chan/scrcpy`, download the matching `scrcpy-server-vX.Y.Z` from the scrcpy GitHub release, check its SHA-256 against the release, and update `SCRCPY_VERSION` and the `AdbScrcpyOptions` class name.

## Project layout

```
pc/
  main.js            Electron main process: window, secure app:// origin, WebUSB permissions and device chooser, Wi‑Fi IPC
  preload.js         The only bridge from the sandboxed UI to the main process (Wi‑Fi transfer, wireless ADB, notifications, port forwarding)
  localsend.js       Wi‑Fi transfer: LocalSend protocol v2 (discovery, HTTPS server/client, certificate)
  netlink.js         Wi‑Fi link quality, and joining/leaving a phone's Direct link network
  wadb.js            Wireless debugging: QR/code pairing (SPAKE2), mDNS discovery, ADB-over-TLS link
  inspector.js       App testing › API calls: HTTP(S) proxy with its own CA for decrypting the phone's traffic
  apiclient.js       App testing › API tester: sends requests from the main process
  traceview.js       App testing › Traces: hands a trace to ui.perfetto.dev from 127.0.0.1:9001
  backupfs.js        Phone backup, restore and automatic photo copy: file access limited to the folders the person picked
  src/app.js         All UI and ADB logic (bundled by esbuild)
  src/apk.js         Reads APKs and split bundles (binary manifest + resources.arsc) for the install preview
  src/pdata.js       Personal-data formats without DOM: vCard (with photos), messages/calls XML and CSV, duplicate contacts, safe file names
  src/ics.js         iCalendar (.ics) writer and reader
  src/people.js      Contacts: photos, edit dialog, delete, find and merge duplicates
  src/calendar.js    Calendar tab
  src/backup.js      Backup & restore page: Back up this phone, Restore from a backup, automatic photo copy
  src/devtools.js    Developer tab: sub-tabs, shared app picker, Shell snippets and history
  src/links.js       Overview › Phone links (send to phone, shared clipboard, find my phone, now playing) and the Call buttons
  src/dev/*.js       Developer sub-tabs (logcat, settings, apptools, capture, perf, network, input, phones) and tunnel.js (port forwarding plumbing)
  src/qa/*.js        App testing sub-tabs (perftest, security + scanner/axml/dex, traffic, apitest, trace)
  renderer/          index.html (UI + CSS), fonts/ (Poppins) and the built app.js
  package.json       Scripts and electron-builder config (dmg + nsis)
```

## Third-party code

| Component | Licence | How it's used |
|---|---|---|
| Tango / ya-webadb (`@yume-chan/*`) | MIT | ADB over WebUSB, scrcpy client (bundled) |
| scrcpy server 3.3.3 | Apache-2.0 | `renderer/scrcpy-server.jar`, pushed to the phone while mirroring |
| Mediabunny | MPL-2.0 | MP4 muxing for recordings (bundled, unmodified; source at https://github.com/Vanilagy/mediabunny) |
| fflate | MIT | Unzipping APKs and bundles (bundled) |
| UAD-ng package list | GPL-3.0 | **Not bundled.** Downloaded from GitHub only when the user clicks "Download the list", then cached |
| qrcode-generator (QR code for pairing) | MIT | Bundled into the renderer |
| [Leaflet](https://leafletjs.com) 1.9.4 | BSD-2-Clause | The map on Developer › Fake location (bundled; its stylesheet is copied to `renderer/dev/leaflet.css`) |
| OpenStreetMap map tiles and Nominatim search | Map data © OpenStreetMap contributors, ODbL | **Not bundled.** Loaded from openstreetmap.org while the Fake location tab is used, under its tile and Nominatim usage policies; the credit stays on the map |
| Poppins font, subset to Latin (same files as the companion) | SIL OFL 1.1 | `renderer/fonts/`, licence in `renderer/fonts/OFL.txt` |
| [Lucide](https://lucide.dev) icons | ISC (parts derived from Feather, MIT) | Inline SVGs in the sidebar and overview (same icon set as the companion) |
| LocalSend protocol | Apache-2.0 (spec) | Implemented from the spec; no LocalSend code is included |

## Security

- The renderer runs sandboxed: `contextIsolation`, no Node.js access, and a strict CSP with no remote scripts. Only the app's own origin may use USB, and every other permission request is denied. The CSP's only network exception is `raw.githubusercontent.com` (for the debloat list); all other networking is in the main process.
- Package listings use `--user 0`. Phones with a second profile (Samsung Secure Folder, Dual Messenger, work profile) otherwise fail with "Shell does not have permission to access user …".
- Backup files, vCards, calendar files and message exports are read as data from a stranger: parsed by Andromon's own readers, shown as plain text, and never used as a path as they are. Names of albums, attachments and apps are reduced to safe file names before anything is written, and the main process refuses paths that leave the chosen folder.
- Everything the phone returns is inserted as plain text, never as HTML. A malicious file name or package name therefore can't run code. This lesson comes from AirDroid's vCard bug in the research report.
- The ADB RSA key is generated on first run and stored in the app's IndexedDB under the name `Andromon@andromon`.
