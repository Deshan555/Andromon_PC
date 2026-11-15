// Beginner guides for the Developer and App testing tabs, shown in the knowledge drawer (./knowledge.js)
// for whichever tab is open. Each guide answers, in plain words: what is this, why would I use it, how do I
// use it step by step, how do I read what it shows, which words will I meet, and what should I be careful with.
//   what: paragraphs · why / how / careful: lists · read: [what you see, what it tells you] · words: [word, meaning]

export const DEV_GUIDES = {
  // ---------------- Developer ----------------
  logcat: {
    name: "Logcat",
    plain: "The phone's diary: a live stream of messages that Android and every app write while they work.",
    what: [
      "Every app and Android itself keep writing short notes about what they are doing: “starting screen X”, “network request failed”, “out of memory”. Logcat is where all those notes end up, newest at the bottom.",
      "Most of it is noise. The skill is filtering it down to the one app and the moment you care about.",
    ],
    why: [
      "An app crashed or froze and you want to know the reason, not just that it happened.",
      "Something silently does nothing (a button, a login) and the app shows no error.",
      "You are a developer and want to see your own log messages on a real phone.",
      "A tester needs to attach the exact error to a bug report.",
    ],
    how: [
      "Open the tab: the log starts streaming by itself.",
      "Choose the app you care about, so other apps' lines disappear.",
      "Raise the level to Warning or Error to hide chatter.",
      "Now do the thing on the phone that goes wrong, and watch what appears at that moment.",
      "Type a word in the text filter (an error word, a screen name) to narrow it further.",
      "Crashes are picked out for you: copy the whole crash with one click and paste it into your bug report.",
    ],
    read: [
      ["Level letter V, D, I, W, E, F", "How serious the line is: Verbose and Debug are chatter, Info is normal news, Warning is “odd but carried on”, Error is a real failure, Fatal is a crash."],
      ["Tag", "The short name before the message says which part of the app or system wrote it. The same tag repeating is your trail to follow."],
      ["“FATAL EXCEPTION” followed by indented “at …” lines", "A crash and its stack trace. Read the first line for the kind of error (for example NullPointerException) and the first “at” line that names the app's own package for the place it happened."],
      ["“ANR in …”", "App Not Responding: the app's main thread was busy for too long and Android offered to close it."],
      ["Many identical lines per second", "Something is stuck in a loop or retrying. That alone can drain battery."],
    ],
    words: [["Stack trace", "The list of steps the program was in the middle of when it failed, innermost first."], ["Exception", "The program's word for “an error I could not handle”."], ["PID", "The number Android gave the running app. It changes every time the app restarts."]],
    careful: ["Logs can contain personal data (names, addresses, tokens). Look before you share a log.", "The log is a ring: old lines fall off the end, so capture soon after the problem."],
  },
  settings: {
    name: "Dev settings",
    plain: "The developer options people use most, as switches, without digging through the phone's Settings.",
    what: [
      "Android has a hidden “Developer options” menu full of switches that change how the phone draws and behaves, meant for building and testing apps. This tab puts the useful ones in one place and shows their current state.",
      "It also has things that are fiddly on the phone: animation speed, screen size and density, font size, and a clean status bar for screenshots.",
    ],
    why: [
      "See where your finger really lands (Show taps, Pointer location) when recording a bug or a demo.",
      "Find layout problems: Layout bounds draws a box around every element.",
      "Find drawing waste: Overdraw colours areas that are painted several times.",
      "Check how an app looks on a smaller or denser screen, or with huge text, without owning that phone.",
      "Make animations slower to study them, or switch them off to make tests faster.",
    ],
    how: [
      "Flip a switch: it takes effect on the phone at once.",
      "Look at the phone (or Screen mirror) to see the difference.",
      "To test another screen size, set size or density, check the app, then press Reset to go back.",
      "Switch things off again when you are done; several of them make the phone look strange.",
    ],
    read: [
      ["Layout bounds", "Boxes that overlap or sit off-centre show mis-aligned or oversized elements."],
      ["Overdraw colours", "No colour or blue is fine; green is acceptable; pink and red mean the same pixels are painted three or four times, which wastes battery and can cause stutter."],
      ["Profile GPU rendering bars", "Each bar is one frame. Bars above the green line took longer than 16 ms and were seen as a stutter."],
      ["Text cut off or overlapping at a large font size", "The app does not adapt to people who need bigger text."],
    ],
    words: [["Density (dpi)", "How many pixels fit in an inch. A higher number makes everything smaller on the same screen."], ["Animation scale", "A multiplier for how long animations take: 0 is off, 1 is normal, 5 is slow motion."], ["Wait for debugger", "The chosen app pauses at start until a developer's debugger attaches."]],
    careful: ["Always Reset screen size and density afterwards; a wrong value can make the phone hard to use.", "These change the whole phone, not one app."],
  },
  apptools: {
    name: "App tools",
    plain: "Everything about one app: what it is, what it may do, its files, and buttons to start, stop and reset it.",
    what: [
      "Pick an app and this tab gathers what Android knows about it: version, where it is installed, what permissions it has, and whether it is running.",
      "From here you can start it, force it to stop, erase its data, save its installer (APK), open a link inside it, and look at the files it keeps.",
    ],
    why: [
      "Test a “first launch”: clear the app's data and start it as if freshly installed.",
      "Check what an app is allowed to do, and switch a permission off to see how the app copes.",
      "Open a deep link (a web address or app link) to jump straight to a screen you are testing.",
      "Look inside an app's saved settings and databases to see what it stored.",
      "Keep a copy of the exact version that showed a bug.",
    ],
    how: [
      "Choose the app at the top, or press Current app to take the one on the phone's screen.",
      "Read the info block first: version name and number tell you exactly which build you have.",
      "Use Start, Stop, Clear data as needed. Clear data asks twice.",
      "In Permissions, flip one off and use the app to see whether it asks again or breaks.",
      "In Files, open shared_prefs for settings and databases for stored data. Click a file to view or save it.",
    ],
    read: [
      ["versionName / versionCode", "The human version (2.4.1) and the build number (241). Bug reports should always include both."],
      ["Debuggable: yes", "A development build. Its private files can be opened here. Shop versions say no."],
      ["A long list of “dangerous” permissions", "The app can reach personal things (camera, contacts, location). Ask whether each is needed."],
      ["shared_prefs/*.xml", "The app's saved settings in readable text. Passwords or tokens in plain text here are a security problem."],
      ["Files only in Android/data", "The app is not debuggable, so only its shared folder is visible."],
    ],
    words: [["Package name", "The app's unique id, like com.example.shop. Two apps never share one."], ["APK", "The file an Android app is installed from."], ["Deep link", "An address that opens a specific screen inside an app."], ["run-as", "Android's way of letting a developer see a debuggable app's private files."]],
    careful: ["Clear data erases the app's logins and saved content for good.", "Private files of normal shop apps cannot be read; that is Android protecting them, not a fault."],
  },
  capture: {
    name: "Capture",
    plain: "Collect evidence: record the screen, pull a full bug report, and copy a summary of the phone.",
    what: [
      "When something goes wrong, the people who fix it need three things: what happened on screen, what the system logged, and which phone and Android version it was. This tab produces all three.",
    ],
    why: [
      "Show a bug that is hard to describe in words.",
      "Give developers everything they need in one go, so they don't have to ask you again.",
      "Paste the phone's exact model and versions into a ticket without typing them.",
    ],
    how: [
      "Screen recording: press record, reproduce the problem on the phone, stop. The video is saved to this computer.",
      "Bug report: press the button and wait; Android gathers logs and system state into one zip file (it can take a minute or two).",
      "Phone summary: press Copy and paste it at the top of your bug ticket.",
      "Write down the time the problem happened; it makes the logs searchable.",
    ],
    read: [
      ["The recording", "Watch for the exact tap that triggers the problem; turn on Show taps in Dev settings first so taps are visible."],
      ["bugreport zip", "Mostly for developers. The main text file inside can be searched for “FATAL”, “ANR” and the app's package name."],
      ["Summary lines", "Model, Android version, build and screen size: the four facts every bug report needs."],
    ],
    words: [["Bug report", "Android's own snapshot of logs and system state at one moment."], ["Reproduce", "Make the problem happen again on purpose."]],
    careful: ["A bug report contains a lot about the phone, including app names and account names. Share it only with people who should see that.", "Screen recordings capture everything on screen, including notifications."],
  },
  perf: {
    name: "Performance",
    plain: "Live charts of how hard one app is working the phone: processor, memory and smoothness.",
    what: [
      "While you use an app, this tab draws three moving charts: how much of the processor it uses, how much memory it holds, and how many frames it draws late.",
      "It also has switches to pretend the phone is on battery, idle, or restricting the app, to see how the app behaves in the background.",
    ],
    why: [
      "The app feels slow or stutters and you want to see when, and what was happening.",
      "The phone gets hot or the battery drains while an app is open.",
      "Memory keeps growing the longer the app is used (a leak).",
      "Check that notifications, syncing or alarms still work when Android puts the app to sleep.",
    ],
    how: [
      "Choose the app and press Start.",
      "Use the app normally on the phone for a minute and watch the charts.",
      "Repeat the action you suspect (open a list, scroll, open a photo) several times and see whether the charts react each time.",
      "For background tests, switch on the battery or Doze option, wait, and check whether the app still does its job. Switch it off afterwards.",
    ],
    read: [
      ["CPU stays high while the app is doing nothing", "Something runs in a loop. That drains battery."],
      ["CPU spikes only when you act, then drops", "Normal."],
      ["Memory rises with each repeat and never comes down", "A memory leak: the app keeps things it no longer needs. Eventually it gets slow or is closed."],
      ["Memory rises, then falls back", "Normal: the app cleaned up."],
      ["Janky frames above about 5–10% while scrolling", "People will notice stutter. Under 5% feels smooth."],
      ["Frame time 16 ms or less", "Smooth at 60 pictures a second. 33 ms means every other frame was missed."],
    ],
    words: [["Frame", "One picture of the screen. Phones draw 60 or more a second."], ["Jank", "A frame that arrived late, seen as a stutter."], ["PSS", "The memory figure Android uses to judge an app: its own memory plus its share of what it shares with others."], ["Doze", "Android's deep sleep for the whole phone when it lies unused."], ["App standby", "Android limiting an app it thinks you rarely use."]],
    careful: ["Measuring adds a little load itself; compare runs with each other, not with a stopwatch.", "Turn the battery and Doze tests off again, or the phone keeps pretending."],
  },
  network: {
    name: "Network",
    plain: "Connect programs on this computer with programs on the phone through the cable, and set the phone's proxy.",
    what: [
      "Normally a phone and a computer can only reach each other over Wi‑Fi. Port forwarding makes a tunnel through the ADB link, so “localhost” on one side reaches a program on the other.",
      "“Forward” lets this computer reach something on the phone. “Reverse” lets the phone reach something on this computer.",
      "The proxy setting sends the phone's web traffic through a program you choose.",
    ],
    why: [
      "You run a test server on this computer and want the app on the phone to use it (reverse).",
      "You want to open a web page or debugging tool that runs on the phone from this computer's browser (forward).",
      "Wi‑Fi blocks devices from seeing each other, but the cable still works.",
    ],
    how: [
      "Decide the direction: phone → computer is Reverse; computer → phone is Forward.",
      "Enter the port number the program listens on, on each side (often the same number, for example 8080).",
      "Add the rule. It stays listed while the phone is connected and is restored when it reconnects.",
      "On the side that connects, use the address 127.0.0.1 (or localhost) with that port.",
      "Remove the rule when you are done.",
    ],
    read: [
      ["Rule listed as active", "The tunnel is open. If the app still can't connect, the program on the far end isn't running or uses another port."],
      ["“Connection refused” in the app", "Nothing is listening on that port at the far end."],
      ["Works on Wi‑Fi but not through the tunnel", "The app is using the computer's Wi‑Fi address, not 127.0.0.1."],
    ],
    words: [["Port", "A numbered door on a device; each running server listens at one."], ["localhost / 127.0.0.1", "“This device itself”."], ["Proxy", "A middleman that web traffic passes through."]],
    careful: ["A proxy left on with nothing listening cuts the phone's internet. Clear it when finished.", "Tunnels end when the phone disconnects."],
  },
  input: {
    name: "Input",
    plain: "Type and press keys on the phone from this computer.",
    what: [
      "Typing long text on a phone is slow. Here you type on this computer's keyboard, or paste, and it lands in the field that is focused on the phone.",
      "The key buttons press the phone's own keys (Back, Home, volume, power) and open or close the notification shade.",
    ],
    why: [
      "Fill in forms, long passwords or test data quickly.",
      "Press Back, Home or Power when the phone's own buttons are hard to reach or broken.",
    ],
    how: [
      "Tap a text field on the phone first, then type or paste here.",
      "Use the top box to send each key as you press it, or the big box to send a whole text at once.",
    ],
    read: [
      ["Some characters reported as not typed", "This way of typing only handles plain English letters, digits and common symbols. Use Screen mirror's type box for other languages and emoji."],
    ],
    words: [["Focused field", "The text box on the phone that has the blinking cursor."], ["Key event", "One press of a key, sent to the phone as if its own button was pressed."]],
    careful: ["Text is typed into whatever is focused on the phone: check it is the right field before sending a password."],
  },
  location: {
    name: "Fake location",
    plain: "Pick a place on a map and make the phone believe it is there.",
    what: [
      "Fake location tells Android “you are at these coordinates”. Apps that ask for the location get that answer.",
      "The map and the search come from OpenStreetMap, a free map of the world made by volunteers.",
    ],
    why: [
      "Test how an app behaves in another city or country without travelling.",
      "Test what happens when the location jumps or is far from the last one.",
      "Check where the phone thinks it is right now.",
    ],
    how: [
      "Search for a place and pick a result, click the map, or type the latitude and longitude. A pin marks the spot; drag it to adjust.",
      "Click “Set location”. The pin turns green while the phone is at that spot. Open the app you are testing on the phone.",
      "“Show the phone's location” puts a blue dot where the phone says it is now.",
      "Click “Stop faking” when done; the phone goes back to its real position.",
    ],
    read: [
      ["The app still shows the real place", "The app caches its last position, or reads it from the network instead. Close and reopen it."],
      ["“The phone has no position yet”", "Location is off on the phone, or nothing has asked for a position since it started. Open a maps app for a moment."],
      ["The map stays empty", "This computer has no internet, or OpenStreetMap is busy. Typing coordinates still works."],
    ],
    words: [["Latitude, longitude", "The two numbers that pin a place on Earth, for example 6.9271, 79.8612."], ["Mock location", "Android's name for a fake position used for testing."], ["OpenStreetMap", "The free world map this page shows; its search service is called Nominatim."]],
    careful: ["Needs Android 12 or newer.", "Don't leave a fake location on: maps, weather and find-my-phone will be wrong.", "What you search for and the part of the map you look at are sent to openstreetmap.org."],
  },
  phones: {
    name: "Phones",
    plain: "Keep several phones connected at once and do the same thing on all of them.",
    what: [
      "Droid Desk normally works with one phone, the “main” one. This tab keeps others connected in the background and lets you switch which one is main with a click.",
      "It can also send one command, install one APK, or take a screenshot on every connected phone together.",
    ],
    why: [
      "Test the same app version on several phones and Android versions.",
      "Compare how one screen looks on different screen sizes side by side.",
      "Install a new build on your whole test set in one go.",
    ],
    how: [
      "Connect each phone (USB or Wi‑Fi). They appear in the list.",
      "Press Make main on the phone the other tabs should work with.",
      "Use the “all phones” actions to install, run a command, or screenshot everywhere at once.",
    ],
    read: [
      ["One phone fails an install that the others accept", "Usually an older Android version or a different processor type than the app supports."],
      ["Different command output per phone", "A quick way to compare versions or settings across the set."],
    ],
    words: [["Main phone", "The one every other page of Droid Desk is talking to."], ["Serial", "A phone's unique id, used to tell identical models apart."]],
    careful: ["An “all phones” command runs everywhere at once; check it on one phone first."],
  },

  // ---------------- App testing ----------------
  perftest: {
    name: "Performance tests",
    plain: "Repeatable measurements of one app (start-up time, smoothness, memory) with pass or fail limits.",
    what: [
      "The live Performance tab shows what happens while you watch. This tab runs the same fixed test every time and gives numbers you can compare between versions of your app.",
      "Three tests: how long the app takes to start, how smoothly it scrolls, and whether its memory grows when screens are opened and closed again and again.",
    ],
    why: [
      "Know whether a new version got slower before your users tell you.",
      "Set a target (“starts in under 1.5 seconds”) and have a clear pass or fail.",
      "Find memory leaks that only show after many repeats.",
    ],
    how: [
      "Choose the app.",
      "Pick a test and how many repeats; more repeats give steadier numbers.",
      "Set a limit if you have a target, then run. Don't touch the phone while it runs.",
      "Read the result and compare it with earlier runs in the history.",
      "Change one thing in the app, run again, compare.",
    ],
    read: [
      ["Cold start", "The app was fully closed. This is what people feel after a restart; under about 2 seconds is fine, over 5 is slow."],
      ["Warm and hot start", "The app was still in memory. These should be clearly faster than cold."],
      ["Median vs worst", "The median is the typical experience; a much worse “worst” means the app is sometimes very slow."],
      ["Janky frames %", "Share of frames that came late while scrolling. Under 5% is smooth."],
      ["90th / 99th percentile frame time", "How bad the slowest frames are. Above 16 ms they were visible as stutter."],
      ["Memory growth per round, Activities count rising", "The app keeps old screens in memory: a leak. It should stay level after the first round."],
    ],
    words: [["Cold / warm / hot start", "Started from nothing / from memory with the screen rebuilt / simply brought back to the front."], ["Median", "The middle value: half the runs were faster, half slower."], ["Percentile", "“99th percentile 30 ms” means 99 of 100 frames were faster than 30 ms."], ["Activity", "Android's word for one screen of an app."]],
    careful: ["Results vary with temperature, battery saver and other running apps. Compare runs made under the same conditions.", "The tests open, close and swipe in the app; don't run them on a screen where a swipe could delete or buy something."],
  },
  security: {
    name: "Security scan",
    plain: "Checks an app you build for common security mistakes and explains each finding.",
    what: [
      "The scan opens the app's installer file and reads it without running it: its settings, what it exposes to other apps, and text inside its code.",
      "For an app installed on the phone it also looks at what the app left readable there: files, saved settings, log lines.",
      "It is like a careful checklist, similar to tools such as MobSF or Android lint. It finds the well-known mistakes, not every possible problem.",
    ],
    why: [
      "Catch simple, embarrassing mistakes before release: a password in the code, debugging left on, traffic sent without encryption.",
      "Have a report to hand to developers or to a customer who asks about security.",
      "Learn what the usual weak spots of Android apps are.",
    ],
    how: [
      "Choose an app installed on the phone, or drop an APK file from this computer.",
      "Run the scan and wait; larger apps take longer.",
      "Start with the High findings. Open each to read what was found, where, and why it matters.",
      "Decide for each: real problem, or acceptable here? The scan can't know your intent.",
      "Fix, build again, scan again. Save the report if you need to share it.",
    ],
    read: [
      ["Debuggable is on", "Anyone with the phone can read the app's private data. Must be off in a release build."],
      ["Cleartext traffic allowed, http:// addresses", "Data can travel unencrypted and be read on the network. Use https."],
      ["Exported component without permission", "Another app on the phone can start that part of your app. Fine for a deliberate entry point, a hole otherwise."],
      ["Secret or API key found in the code", "Anyone can extract it from the app. Keys that cost money or open private data must not be shipped inside an app."],
      ["Backup allowed", "The app's data can be copied off the phone with a backup."],
      ["Weak crypto (MD5, SHA‑1, ECB)", "Old methods that can be broken. Replace them where they protect something."],
      ["Secrets in the log or in plain files", "Other tools, or a stolen phone, can read them."],
    ],
    words: [["Static scan", "Reading the app's file without running it."], ["Manifest", "The app's declaration: its name, permissions and parts."], ["Exported", "Reachable by other apps."], ["Cleartext", "Not encrypted."], ["False positive", "A finding that looks like a problem but isn't in your case."]],
    careful: ["A clean scan does not prove an app is secure; it means the common mistakes weren't found.", "Scan only apps you own or are allowed to test.", "Found secrets are shown masked on purpose."],
  },
  traffic: {
    name: "API calls",
    plain: "Watch the web requests apps on the phone make: where they go, what they send, what comes back.",
    what: [
      "Apps talk to servers constantly. Capture puts this computer in the middle (as a proxy) and lists every request the phone makes while it is on.",
      "Plain http can be read directly. https is encrypted; to read it the phone must trust a certificate from Droid Desk, and the app must accept that (apps you build in debug mode usually do; most shop apps refuse).",
    ],
    why: [
      "A screen shows “something went wrong”: see which request failed and what the server answered.",
      "Check what data an app really sends, for example for privacy.",
      "Find slow requests that make a screen take long to load.",
      "Copy a real request into the API tester to try it with other values.",
    ],
    how: [
      "Press Start capture. The phone's web traffic now passes through this computer.",
      "Use the app on the phone; requests appear in the list as they happen.",
      "Click a request to see its address, what was sent, and the answer.",
      "To read https, follow the steps to install the certificate on the phone, then try again.",
      "Press Stop when done. The phone's proxy is switched back off for you.",
    ],
    read: [
      ["Status 200–299", "Worked."],
      ["Status 301, 302", "The server sent the app somewhere else. Usually fine."],
      ["Status 400, 422", "The app sent something the server didn't accept: look at what was sent."],
      ["Status 401, 403", "Not logged in, or not allowed."],
      ["Status 404", "The address doesn't exist: wrong link or removed content."],
      ["Status 500–599", "The server itself failed. Not the app's fault, but the app should handle it gracefully."],
      ["Time in the hundreds of ms or more", "A slow request. Several in a row explain a slow screen."],
      ["Encrypted or failed https lines", "The app does not trust the certificate (pinning). You can see that it connected, not what it said."],
    ],
    words: [["Request / response", "What the app asks, and what the server answers."], ["Method", "GET reads, POST sends new data, PUT/PATCH changes, DELETE removes."], ["Header", "Extra information on a request, such as who you are (Authorization)."], ["JSON", "The usual text format of the data that travels."], ["Certificate pinning", "An app accepting only its own server's certificate, so nobody can sit in the middle."]],
    careful: ["Captured traffic can hold passwords and tokens. Clear it when done and don't share it carelessly.", "Remove the certificate from the phone when you no longer need it.", "Capture only your own traffic or apps you are allowed to test."],
  },
  apitest: {
    name: "API tester",
    plain: "Send your own web requests to a server and check the answers, like a small Postman.",
    what: [
      "Instead of waiting for an app to call a server, you write the request yourself: the address, the method, any headers and data. You press Send and see exactly what comes back.",
      "Requests can be saved in collections, given simple checks (“the answer must be 200”), and a whole collection can be run as a test.",
    ],
    why: [
      "Find out whether a problem is in the server or in the app.",
      "Try a server feature before the app's screen for it exists.",
      "Check the same set of requests after every server update.",
      "Replay a request captured in API calls with different values.",
    ],
    how: [
      "Choose the method (GET to read is the place to start) and type the address.",
      "Add headers if the server needs them, for example Authorization for a login token.",
      "For POST or PUT, write the data in Body, usually as JSON.",
      "Press Send and read the status, time and body of the answer.",
      "Add a test (expected status, text that must appear), save the request in a collection, and run the collection to check them all.",
      "Use environments for values that change, like the server address: write {{baseUrl}} in the request and set it once.",
    ],
    read: [
      ["Status code", "The first thing to read. 2xx worked, 4xx the request was wrong, 5xx the server failed."],
      ["Time", "How long the server took. Compare with what feels acceptable in the app."],
      ["Body", "The data returned. Check that the fields the app needs are there and have sensible values."],
      ["A test in red", "The answer was not what you declared it must be: the server changed or broke."],
      ["{{name}} left unreplaced in the request", "That variable is not set in the active environment."],
    ],
    words: [["Endpoint", "One address of a server that does one job."], ["Body", "The data sent with, or returned by, a request."], ["Environment", "A named set of values (test server, live server) you can switch between."], ["Collection", "A saved group of requests."], ["Token", "A text that proves you are logged in."]],
    careful: ["Requests are real. A DELETE on a live server deletes real data.", "Saved requests can contain tokens and passwords; think before exporting a collection."],
  },
  trace: {
    name: "Traces",
    plain: "Record in fine detail what the phone and an app were doing for a few seconds, to find what was slow.",
    what: [
      "A trace is a recording of activity, not of the screen: which parts of the system and the app were busy, millisecond by millisecond.",
      "System trace records the whole phone with Android's Perfetto tool and opens in the Perfetto viewer in your browser. Method trace and heap dump go deeper into one app that is built for debugging: which functions ran, and what is in its memory.",
    ],
    why: [
      "The Performance charts show that something is slow; a trace shows what was running at that moment.",
      "Start-up is slow and you need to know which step takes the time.",
      "Memory is too high and you need to know what kind of objects fill it.",
    ],
    how: [
      "Get the phone ready just before the slow moment.",
      "Start a system trace, do the slow thing on the phone, stop. Keep it short: 5 to 10 seconds.",
      "Press Open in Perfetto. Find your app's row and zoom into the time of the problem.",
      "For a debuggable app, use Method trace to see which functions took the time, or Heap dump to see what is in memory, and open the saved file in Android Studio.",
    ],
    read: [
      ["Long coloured bars on the app's main thread", "The app was busy and could not draw: that is the freeze you felt. The bar's name says what it was doing."],
      ["Frames marked red or yellow in the frame row", "Those frames were late. Look at what ran just before."],
      ["Main thread waiting (sleeping) for a long time", "It was waiting for something else: a file, the network, another thread."],
      ["In a heap dump: one type with a huge count or size", "That is what fills the memory. Bitmaps (pictures) are the usual suspect."],
    ],
    words: [["Main thread", "The one line of work that draws the screen and handles touches. If it is busy, the app freezes."], ["Perfetto", "Android's tracing tool and its viewer."], ["Method trace", "A recording of which functions ran and for how long."], ["Heap dump", "A snapshot of everything the app holds in memory."], ["Debuggable", "Built for development; shop versions are not."]],
    careful: ["Traces are large; keep them short.", "Method traces slow the app down while recording, so judge proportions, not absolute times.", "Heap dumps contain whatever was in memory, which can include personal data."],
  },
};

/** The order and titles of a guide's sections. */
export const GUIDE_SECTIONS = [["what", "What it is"], ["why", "Why you would use it"], ["how", "How to use it, step by step"], ["read", "How to read what you see"], ["words", "Words you will meet"], ["careful", "Be careful"]];
