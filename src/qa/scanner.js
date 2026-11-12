// Security scan, static part: reads an APK (and its split APKs) and lists security findings, like
// MobSF or Android lint's security checks. Pure code (no phone, no DOM), so it also runs in node tests.
//
// Everything here comes from an untrusted file. Callers show it as text. Secrets are never kept in
// full: `mask()` runs before a match is stored.

import { unzipSync } from "fflate";
import { parseArsc } from "../apk.js";
import { parseXmlTree, findAll, child, resolveValue } from "./axml.js";
import { dexStrings, asciiStrings } from "./dex.js";

export const SEVERITIES = ["high", "medium", "low", "info"];
const ANDROID_NS_ACTIONS = /^android\./;
const SENSITIVE = new Set([
  "READ_SMS", "SEND_SMS", "RECEIVE_SMS", "READ_CALL_LOG", "WRITE_CALL_LOG", "PROCESS_OUTGOING_CALLS", "READ_CONTACTS", "WRITE_CONTACTS",
  "GET_ACCOUNTS", "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "CAMERA", "RECORD_AUDIO",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "BODY_SENSORS", "BODY_SENSORS_BACKGROUND",
  "ACTIVITY_RECOGNITION", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO",
  "READ_MEDIA_AUDIO", "READ_CALENDAR", "WRITE_CALENDAR", "BLUETOOTH_SCAN", "NEARBY_WIFI_DEVICES",
]);
// Permissions Google Play reviews separately or that give unusual power.
const SPECIAL = new Set([
  "SYSTEM_ALERT_WINDOW", "REQUEST_INSTALL_PACKAGES", "QUERY_ALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE", "BIND_ACCESSIBILITY_SERVICE",
  "BIND_NOTIFICATION_LISTENER_SERVICE", "BIND_DEVICE_ADMIN", "PACKAGE_USAGE_STATS", "USE_FULL_SCREEN_INTENT", "READ_PRIVILEGED_PHONE_STATE",
  "WRITE_SECURE_SETTINGS", "INSTALL_PACKAGES", "REQUEST_DELETE_PACKAGES",
]);

// ---------- secrets ----------
/** "AKIAABCDEFGHIJKLWXYZ" -> "AKIA****WXYZ". Short values keep only their first two characters. */
export function mask(s) {
  s = String(s);
  if (s.length <= 8) return s.slice(0, 2) + "****";
  if (s.length <= 16) return s.slice(0, 3) + "****" + s.slice(-2);
  return s.slice(0, 4) + "****" + s.slice(-4);
}
// Each rule: id, regex (group 1 = the part to mask when there's a key in front), severity, title, advice.
export const SECRET_RULES = [
  { id: "aws", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, sev: "high", title: "AWS access key",
    fix: "Remove the key from the app and revoke it in AWS IAM. Apps should get short-lived credentials from your server (e.g. Cognito)." },
  { id: "pem", re: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----)/, sev: "high", title: "Private key",
    fix: "A private key in an app is public. Remove it, replace the key pair, and keep private keys on the server." },
  { id: "stripe", re: /\b((?:sk|rk)_live_[0-9A-Za-z]{16,})\b/, sev: "high", title: "Stripe live secret key",
    fix: "Roll the key in the Stripe dashboard. Apps may only contain the publishable key (pk_live_…)." },
  { id: "slack", re: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/, sev: "high", title: "Slack token",
    fix: "Revoke the token in Slack and move the call to your server." },
  { id: "github", re: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/, sev: "high", title: "GitHub token",
    fix: "Revoke the token on GitHub and move the call to your server." },
  { id: "gcp-sa", re: /("type"\s*:\s*"service_account")/, sev: "high", title: "Google service-account credentials",
    fix: "Service-account JSON grants server access. Remove it from the app and delete the key in Google Cloud." },
  { id: "jwt", re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/, sev: "medium", title: "Hard-coded JWT / bearer token",
    fix: "Tokens should come from a login at run time, not be built into the app. Revoke this one if it's still valid." },
  { id: "assign", re: /\b(?:password|passwd|pwd|secret|api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([^\s"'&,;]{6,})/i,
    sev: "medium", title: "Password or key in a string", fix: "Don't ship credentials in the app. Use a login, or call a server that holds the secret." },
  { id: "google", re: /\b(AIza[0-9A-Za-z_-]{35})\b/, sev: "low", title: "Google API key",
    fix: "Keys like this (often Firebase) are expected in apps, but restrict them in Google Cloud › Credentials to your app's package and signing certificate, and to the APIs it uses." },
];
const SECRET_PLACEHOLDER = /^(?:x+|\*+|your[_-]|change[_-]?me|placeholder|example|test|dummy|null|undefined|true|false|\$\{|%s|%1\$s|\{\{)/i;

// http:// hosts that are XML namespaces or documentation, not network calls.
const BENIGN_HTTP = /^((?:[a-z0-9-]+\.)*(?:w3\.org|ietf\.org|whatwg\.org|unicode\.org|opensource\.org|mozilla\.org|gnu\.org|dartlang\.org|dart\.dev|flutter\.dev)$|localhost|127\.|10\.0\.2\.2|0\.0\.0\.0|schemas\.android\.com|www\.w3\.org|w3\.org|ns\.adobe\.com|xml\.org|xmlpull\.org|apache\.org|www\.apache\.org|java\.sun\.com|purl\.org|schemas\.xmlsoap\.org|(www\.)?example\.(com|org|net)|json-schema\.org|schemas\.microsoft\.com|xmlns\.com|www\.apple\.com|ns\.google\.com|schemas\.google\.com|www\.slf4j\.org|jsoup\.org|xml\.apache\.org|www\.opengis\.net|exslt\.org|relaxng\.org|iptc\.org|cipa\.jp|www\.xfa\.org|xmp|creativecommons\.org)/i;

// Strings in code that point at risky APIs. Exact matches against the dex string pool.
const API_HINTS = [
  { s: "addJavascriptInterface", sev: "medium", title: "WebView JavaScript bridge (addJavascriptInterface)",
    what: "Web pages in the WebView can call into the app's Java/Kotlin code.",
    fix: "Only load your own HTTPS content in WebViews that have a JavaScript interface, and annotate only the methods you mean to expose with @JavascriptInterface." },
  { s: "setAllowUniversalAccessFromFileURLs", sev: "medium", title: "WebView file pages may read any origin",
    what: "A local HTML file could read data from any website or other files.", fix: "Leave setAllowUniversalAccessFromFileURLs / setAllowFileAccessFromFileURLs off (false)." },
  { s: "setAllowFileAccessFromFileURLs", sev: "medium", title: "WebView file pages may read other files",
    what: "A local HTML file could read other local files.", fix: "Leave setAllowFileAccessFromFileURLs off (false)." },
  { s: "ALLOW_ALL_HOSTNAME_VERIFIER", sev: "medium", title: "Hostname check turned off (ALLOW_ALL_HOSTNAME_VERIFIER)",
    what: "HTTPS would accept a certificate for any server name, so traffic can be intercepted.", fix: "Use the default HostnameVerifier." },
  { s: "Lorg/apache/http/conn/ssl/AllowAllHostnameVerifier;", sev: "medium", title: "Hostname check turned off (AllowAllHostnameVerifier)",
    what: "HTTPS would accept a certificate for any server name.", fix: "Use the default HostnameVerifier." },
  { s: "setWebContentsDebuggingEnabled", sev: "low", title: "WebView debugging can be switched on",
    what: "Chrome DevTools on a computer can inspect the app's WebViews when this is on.", fix: "Only call setWebContentsDebuggingEnabled(true) in debug builds (e.g. if (BuildConfig.DEBUG))." },
  { s: "setJavaScriptEnabled", sev: "info", title: "WebView with JavaScript",
    what: "JavaScript runs in a WebView. That's fine for your own content.", fix: "Don't load untrusted URLs in it, and keep file access off." },
  { s: "getExternalStorageDirectory", sev: "low", title: "Writes to shared storage",
    what: "Files in shared storage (/sdcard) can be read by other apps on older Android versions.", fix: "Keep private data in getFilesDir() or getExternalFilesDir()." },
  { s: "rawQuery", sev: "info", title: "Raw SQL queries",
    what: "rawQuery/execSQL with text built from input can allow SQL injection.", fix: "Use ? placeholders (selectionArgs) instead of joining strings." },
];
// Weak crypto: string constants passed to Cipher / MessageDigest.
const CRYPTO_HINTS = [
  { re: /^(AES|DES|DESede|Blowfish|RC2)\/ECB\//i, sev: "medium", title: "Encryption in ECB mode",
    what: "ECB encrypts equal blocks to equal output and leaks patterns.", fix: "Use AES/GCM/NoPadding with a random 12-byte IV." },
  { re: /^AES$/, sev: "info", title: "\"AES\" without a mode",
    what: "Fine for keys (SecretKeySpec, KeyGenerator), but Cipher.getInstance(\"AES\") picks ECB mode on Android.", fix: "When creating a Cipher, name the mode: \"AES/GCM/NoPadding\"." },
  { re: /^(DES|DESede|DESEDE|TripleDES|RC4|ARC4|ARCFOUR)(\/|$)/, sev: "medium", title: "Outdated cipher (DES / 3DES / RC4)",
    what: "These ciphers are broken or too weak.", fix: "Use AES-GCM." },
  { re: /^(MD5|SHA-?1)$/i, sev: "info", title: "MD5 / SHA-1 hashing",
    what: "Fine for checksums, but not for passwords or signatures.", fix: "For passwords use a server-side KDF; for integrity use SHA-256." },
];

// ---------- helpers ----------
const yieldNow = () => new Promise((r) => setTimeout(r, 0));
const short = (name, pkg) => (pkg && typeof name === "string" && name.startsWith(pkg + ".") ? name.slice(pkg.length) : name);

/**
 * Scans APK files. parts: [{ name, bytes }] with the base APK first.
 * Returns { info, findings, stats }. onProgress(text, fraction) is called as it goes.
 */
export async function scanApk(parts, { onProgress = () => {}, codeLimitBytes = 160 * 1024 * 1024 } = {}) {
  const findings = [];
  const add = (f) => findings.push({ evidence: [], ...f });
  const base = parts[0];
  onProgress("Reading the app…", 0.02);

  // ---- what's inside ----
  const entries = []; // { part, name, size }
  for (const p of parts) {
    unzipSync(p.bytes, { filter: (f) => { entries.push({ part: p, name: f.name, size: f.originalSize }); return false; } });
  }
  const baseNames = new Set(entries.filter((e) => e.part === base).map((e) => e.name));
  if (!baseNames.has("AndroidManifest.xml")) throw new Error("This file isn't an Android app (no AndroidManifest.xml).");
  const take = (part, names) => (names.length ? unzipSync(part.bytes, { filter: (f) => names.includes(f.name) }) : {});
  const baseFiles = take(base, ["AndroidManifest.xml", "resources.arsc"]);

  let table = null;
  if (baseFiles["resources.arsc"]) { try { table = parseArsc(baseFiles["resources.arsc"]); } catch {} }
  const val = (v) => resolveValue(table, v);
  const doc = parseXmlTree(baseFiles["AndroidManifest.xml"]);
  const manifest = child(doc, "manifest");
  if (!manifest) throw new Error("The app's manifest couldn't be read.");
  const pkg = val(manifest.attrs.package) || "";
  const app = child(manifest, "application") || { attrs: {}, children: [] };
  const sdk = child(manifest, "uses-sdk")?.attrs || {};
  const minSdk = Number(val(sdk.minSdkVersion)) || 1;
  const targetSdk = Number(val(sdk.targetSdkVersion)) || minSdk;
  const A = (node, k) => val(node.attrs[k]);

  const info = {
    package: pkg, versionName: val(manifest.attrs.versionName) || "", versionCode: Number(val(manifest.attrs.versionCode)) || 0,
    minSdk, targetSdk, label: val(app.attrs.label) || "", size: parts.reduce((n, p) => n + p.bytes.length, 0), parts: parts.length,
  };

  // ---- application flags ----
  if (A(app, "debuggable") === true)
    add({ sev: "high", cat: "Build", title: "The app is debuggable", what: "Anyone with the phone and a USB cable can attach a debugger, read the app's private files (run-as) and change how it runs.", fix: "Never ship a debug build. Release builds set this automatically; don't put android:debuggable=\"true\" in the manifest." });
  if (A(app, "testOnly") === true)
    add({ sev: "low", cat: "Build", title: "Marked test-only", what: "android:testOnly=\"true\": Google Play rejects it and it installs only with adb install -t.", fix: "Build the release variant (Android Studio adds testOnly to builds run from the IDE)." });
  const backup = A(app, "allowBackup");
  const backupRules = app.attrs.fullBackupContent !== undefined || app.attrs.dataExtractionRules !== undefined;
  if (backup !== false) {
    add({ sev: backupRules ? "info" : "low", cat: "Data", title: backup === true ? "App data can be backed up" : "App data can be backed up (default)",
      what: backupRules ? "Backup is on with backup rules set. Check that they leave out tokens and keys."
        : `android:allowBackup is ${backup === true ? "true" : "not set (true by default)"}, so the app's private files go into cloud backups${targetSdk < 31 ? " and can be copied out with adb backup" : ""}.`,
      fix: "Set android:allowBackup=\"false\", or add android:dataExtractionRules (Android 12+) and android:fullBackupContent rules that exclude secrets." });
  }
  if (manifest.attrs.sharedUserId !== undefined)
    add({ sev: "low", cat: "Build", title: "Shared user id", what: `android:sharedUserId="${val(manifest.attrs.sharedUserId)}" makes apps signed with the same key share data. It's deprecated.`, fix: "Remove sharedUserId if you can; use content providers or services to share data." });
  if (targetSdk < 24)
    add({ sev: "medium", cat: "Network", title: `Old target SDK (${targetSdk}): trusts user-installed certificates`, what: "Apps that target Android 6 or lower trust certificates the user installed, so a tool like Charles can read their HTTPS traffic.", fix: "Target a current SDK (Google Play requires a recent one)." });
  else if (targetSdk < 33)
    add({ sev: "low", cat: "Build", title: `Old target SDK (${targetSdk})`, what: "Newer targets turn on platform protections (exported flags, safer intents, pending-intent mutability…).", fix: "Raise targetSdkVersion to the level Google Play currently requires." });

  // ---- network security ----
  onProgress("Checking network settings…", 0.08);
  const cleartext = A(app, "usesCleartextTraffic");
  const nscRef = app.attrs.networkSecurityConfig;
  let nsc = null;
  if (nscRef !== undefined) {
    const path = val(nscRef);
    if (typeof path === "string") {
      const f = take(base, [path])[path];
      if (f) { try { nsc = parseXmlTree(f); } catch {} }
    }
  }
  if (nsc) {
    const root = child(nsc, "network-security-config") || nsc;
    const baseCfg = child(root, "base-config");
    const domainCfgs = findAll(root, "domain-config");
    const dbg = child(root, "debug-overrides");
    const userTrust = (node) => node && findAll(node, "certificates").some((c) => val(c.attrs.src) === "user");
    if (baseCfg && A(baseCfg, "cleartextTrafficPermitted") === true)
      add({ sev: "medium", cat: "Network", title: "Plain HTTP allowed for all servers", what: "The network security config's <base-config cleartextTrafficPermitted=\"true\"> lets the app send unencrypted traffic anywhere.", fix: "Set cleartextTrafficPermitted=\"false\" in base-config and allow HTTP only for specific domains that need it." });
    const httpDomains = domainCfgs.filter((d) => A(d, "cleartextTrafficPermitted") === true)
      .flatMap((d) => d.children.filter((c) => c.name === "domain").map((c) => (c.text || "").trim())).filter(Boolean);
    if (domainCfgs.some((d) => A(d, "cleartextTrafficPermitted") === true))
      add({ sev: "low", cat: "Network", title: "Plain HTTP allowed for some domains", what: "A <domain-config cleartextTrafficPermitted=\"true\"> allows unencrypted traffic to those servers.", fix: "Use HTTPS for those servers and remove the exception.", evidence: [...new Set(httpDomains)].slice(0, 20) });
    if (userTrust(baseCfg) || domainCfgs.some(userTrust))
      add({ sev: "medium", cat: "Network", title: "Trusts user-installed certificates in release", what: "<certificates src=\"user\"> outside <debug-overrides> lets anyone who installs a certificate on the phone read the app's HTTPS traffic.", fix: "Move <certificates src=\"user\"/> into <debug-overrides> so only debug builds trust them." });
    if (userTrust(dbg))
      add({ sev: "info", cat: "Network", title: "Debug builds trust user certificates", what: "Fine: <debug-overrides> only applies to debuggable builds, so you can inspect traffic while developing.", fix: "Nothing to do." });
    const pins = findAll(root, "pin-set");
    if (pins.length)
      add({ sev: "info", cat: "Network", title: "Certificate pinning is set up", what: `${pins.length} pin set${pins.length > 1 ? "s" : ""} in the network security config.`, fix: "Keep a backup pin and an expiration date so a certificate change can't lock users out." });
  } else if (cleartext === true) {
    add({ sev: "medium", cat: "Network", title: "Plain HTTP allowed (usesCleartextTraffic)", what: "android:usesCleartextTraffic=\"true\" lets the app send unencrypted traffic to any server.", fix: "Remove it and use HTTPS, or allow HTTP only for specific domains with a network security config." });
  } else if (targetSdk < 28 && cleartext !== false) {
    add({ sev: "medium", cat: "Network", title: "Plain HTTP allowed by default", what: `Apps targeting Android 8.1 or lower (target ${targetSdk}) may use unencrypted HTTP unless they say otherwise.`, fix: "Add android:usesCleartextTraffic=\"false\" or a network security config, or raise the target SDK." });
  }

  // ---- permissions ----
  const declaredPerms = new Map(); // name -> protection level (0 normal, 1 dangerous, 2 signature, 3 signatureOrSystem)
  for (const p of findAll(manifest, "permission")) declaredPerms.set(val(p.attrs.name), Number(val(p.attrs.protectionLevel) || 0) & 0xf);
  const used = [...new Set(manifest.children.filter((c) => /^uses-permission(-sdk-23|-sdk-m)?$/.test(c.name)).map((c) => val(c.attrs.name)).filter(Boolean))];
  const shortPerm = (p) => String(p).replace(/^android\.permission\./, "");
  const sens = used.filter((p) => p.startsWith("android.permission.") && SENSITIVE.has(shortPerm(p))).map(shortPerm);
  const special = used.filter((p) => p.startsWith("android.permission.") && SPECIAL.has(shortPerm(p))).map(shortPerm);
  if (special.length)
    add({ sev: "low", cat: "Permissions", title: "Powerful permissions", what: "These give unusual access and Google Play asks for a reason for most of them.", fix: "Remove any the app doesn't really need.", evidence: special });
  if (sens.length)
    add({ sev: "info", cat: "Permissions", title: `${sens.length} permission${sens.length > 1 ? "s" : ""} for personal data`, what: "The user is asked for these. Only request what a feature needs, when it needs it.", fix: "Review the list.", evidence: sens });
  const weakPerms = [...declaredPerms].filter(([, lvl]) => lvl === 0 || lvl === 1).map(([n]) => n);

  // ---- components ----
  onProgress("Checking components…", 0.12);
  const appPerm = val(app.attrs.permission);
  const TYPES = { activity: "Activities", "activity-alias": "Activities", service: "Services", receiver: "Receivers", provider: "Content providers" };
  const comps = [];
  for (const node of app.children) {
    if (!TYPES[node.name]) continue;
    const name = val(node.attrs.name) || (node.name === "activity-alias" ? val(node.attrs.targetActivity) : "") || "?";
    const filters = node.children.filter((c) => c.name === "intent-filter").map((f) => ({
      node: f,
      actions: f.children.filter((c) => c.name === "action").map((c) => val(c.attrs.name)).filter(Boolean),
      categories: f.children.filter((c) => c.name === "category").map((c) => val(c.attrs.name)).filter(Boolean),
      data: f.children.filter((c) => c.name === "data").map((c) => ({ scheme: val(c.attrs.scheme), host: val(c.attrs.host), path: val(c.attrs.path) || val(c.attrs.pathPrefix) || val(c.attrs.pathPattern) })),
      autoVerify: val(f.attrs.autoVerify) === true,
    }));
    const exp = val(node.attrs.exported);
    const enabled = val(node.attrs.enabled) !== false;
    let exported, implicit = false;
    if (exp === true || exp === false) exported = exp;
    else if (node.name === "provider") { exported = targetSdk < 17; implicit = exported; }
    else { exported = filters.length > 0; implicit = exported; }
    const perm = node.name === "provider"
      ? (val(node.attrs.permission) || (val(node.attrs.readPermission) && val(node.attrs.writePermission) ? val(node.attrs.readPermission) : null))
      : (val(node.attrs.permission) || appPerm || null);
    comps.push({
      type: node.name, name, short: short(name, pkg), exported, implicit, enabled, perm,
      readPerm: val(node.attrs.readPermission), writePerm: val(node.attrs.writePermission),
      grantUri: val(node.attrs.grantUriPermissions) === true, authorities: String(val(node.attrs.authorities) || "").split(";").filter(Boolean),
      filters, launchMode: Number(val(node.attrs.launchMode) || 0), taskAffinity: node.attrs.taskAffinity !== undefined ? String(val(node.attrs.taskAffinity) ?? "") : null,
    });
  }
  const label = (c) => `${c.short}${c.implicit ? " (exported because of its intent-filter)" : ""}${c.perm && weakPerms.includes(c.perm) ? ` (permission ${c.perm} can be requested by any app)` : ""}`;
  const open = (c) => c.exported && c.enabled && (!c.perm || weakPerms.includes(c.perm));
  const isLauncher = (c) => c.filters.some((f) => f.actions.includes("android.intent.action.MAIN") && (f.categories.includes("android.intent.category.LAUNCHER") || f.categories.includes("android.intent.category.LEANBACK_LAUNCHER")));
  const isBrowsable = (c) => c.filters.some((f) => f.actions.includes("android.intent.action.VIEW") && f.categories.includes("android.intent.category.BROWSABLE"));

  const providers = comps.filter((c) => c.type === "provider" && c.exported && c.enabled && !(c.perm || (c.readPerm && c.writePerm)) );
  if (providers.length)
    add({ sev: "high", cat: "Components", title: `${providers.length} content provider${providers.length > 1 ? "s" : ""} open to other apps`, what: "Any app on the phone can query (and maybe change) the data these providers serve.", fix: "Set android:exported=\"false\", or protect them with a signature-level android:readPermission and android:writePermission.", evidence: providers.map((c) => `${label(c)} — content://${c.authorities.join(", content://")}`) });
  const halfProviders = comps.filter((c) => c.type === "provider" && c.exported && c.enabled && !c.perm && !!c.readPerm !== !!c.writePerm);
  if (halfProviders.length)
    add({ sev: "medium", cat: "Components", title: "Content provider protected for only reading or writing", what: "One of readPermission / writePermission is set, so the other direction is open to every app.", fix: "Set both readPermission and writePermission (or android:permission).", evidence: halfProviders.map(label) });
  const weakGuard = comps.filter((c) => c.exported && c.perm && weakPerms.includes(c.perm));
  if (weakGuard.length)
    add({ sev: "medium", cat: "Components", title: "Guarded by a permission any app can get", what: "The permission protecting these components is declared with protectionLevel normal or dangerous, so other apps can simply request it.", fix: "Use android:protectionLevel=\"signature\" for permissions that guard your own components.", evidence: weakGuard.map((c) => `${c.short} — ${c.perm}`) });
  const services = comps.filter((c) => c.type === "service" && open(c) && !weakGuard.includes(c));
  if (services.length)
    add({ sev: "medium", cat: "Components", title: `${services.length} exported service${services.length > 1 ? "s" : ""} without a permission`, what: "Other apps can start or bind to these services and send them data.", fix: "Set android:exported=\"false\" unless other apps must use them; otherwise add a signature permission and check the caller.", evidence: services.map(label) });
  const receivers = comps.filter((c) => c.type === "receiver" && open(c) && !weakGuard.includes(c));
  const customReceivers = receivers.filter((c) => !c.filters.length || c.filters.some((f) => f.actions.some((a) => !ANDROID_NS_ACTIONS.test(a))));
  const systemReceivers = receivers.filter((c) => !customReceivers.includes(c));
  if (customReceivers.length)
    add({ sev: "low", cat: "Components", title: `${customReceivers.length} exported broadcast receiver${customReceivers.length > 1 ? "s" : ""} without a permission`, what: "Any app can send these receivers broadcasts with its own data.", fix: "Set android:exported=\"false\", register receivers in code with RECEIVER_NOT_EXPORTED, or require a signature permission.", evidence: customReceivers.map(label) });
  if (systemReceivers.length)
    add({ sev: "info", cat: "Components", title: "Receivers for system broadcasts", what: "These listen for Android's own broadcasts (boot, package changes…). Other apps can send the same actions to them.", fix: "Don't trust the data in those intents.", evidence: systemReceivers.map((c) => `${c.short} — ${[...new Set(c.filters.flatMap((f) => f.actions))].slice(0, 3).join(", ")}`) });
  const activities = comps.filter((c) => (c.type === "activity" || c.type === "activity-alias") && open(c) && !isLauncher(c) && !weakGuard.includes(c));
  if (activities.length)
    add({ sev: "low", cat: "Components", title: `${activities.length} screen${activities.length > 1 ? "s" : ""} other apps can open directly`, what: "Exported activities can be started by any app with any extras, skipping the screens before them (e.g. a login).", fix: "Set android:exported=\"false\" on screens that aren't entry points, and validate intent extras on those that are.", evidence: activities.map(label) });
  const hijack = comps.filter((c) => c.exported && (c.type === "activity" || c.type === "activity-alias") && c.taskAffinity !== null && c.taskAffinity !== "" && c.taskAffinity !== pkg && (c.launchMode === 2 || c.launchMode === 3));
  if (hijack.length)
    add({ sev: "low", cat: "Components", title: "Task affinity could allow task hijacking", what: "singleTask/singleInstance screens with a custom taskAffinity can be placed in another app's task.", fix: "Set android:taskAffinity=\"\" on the <application> unless you need it.", evidence: hijack.map((c) => `${c.short} — taskAffinity ${c.taskAffinity}`) });

  // Deep links
  const links = [];
  let unverified = [];
  for (const c of comps.filter((x) => x.exported && isBrowsable(x))) {
    for (const f of c.filters.filter((f) => f.actions.includes("android.intent.action.VIEW") && f.categories.includes("android.intent.category.BROWSABLE"))) {
      const schemes = [...new Set(f.data.map((d) => d.scheme).filter(Boolean))];
      const hosts = [...new Set(f.data.map((d) => d.host).filter(Boolean))];
      const paths = [...new Set(f.data.map((d) => d.path).filter(Boolean))];
      for (const s of schemes.length ? schemes : ["(any)"]) {
        const url = `${s}://${hosts.length ? hosts.join("|") : "*"}${paths.length ? paths[0] : ""}`;
        links.push(`${url} → ${c.short}`);
        if (/^https?$/.test(s) && !f.autoVerify) unverified.push(url);
      }
    }
  }
  if (links.length)
    add({ sev: "info", cat: "Deep links", title: `${links.length} deep link${links.length > 1 ? "s" : ""}`, what: "Links that open the app from a browser or another app. Any app can claim custom schemes too, so don't send tokens through them.", fix: "Treat every value in a deep link as untrusted input.", evidence: links.slice(0, 40) });
  unverified = [...new Set(unverified)];
  if (unverified.length)
    add({ sev: "low", cat: "Deep links", title: "Web links without verification", what: "http/https links without android:autoVerify=\"true\" can be opened by other apps that claim the same URLs (users see a chooser).", fix: "Add android:autoVerify=\"true\" and host /.well-known/assetlinks.json on the domain (Android App Links).", evidence: unverified.slice(0, 20) });

  // ---- signing ----
  onProgress("Checking the signature…", 0.16);
  const sig = signingInfo(base.bytes, [...baseNames]);
  if (sig.v1.length) {
    const certFiles = take(base, sig.v1);
    sig.v1Debug = Object.values(certFiles).some((b) => hasAscii(b, "Android Debug"));
  }
  info.signing = [sig.v1.length ? "v1" : null, sig.v2 ? "v2" : null, sig.v3 ? "v3" : null, sig.v31 ? "v3.1" : null].filter(Boolean).join(" + ") || "none";
  if (!sig.v1.length && !sig.v2 && !sig.v3)
    add({ sev: "high", cat: "Signing", title: "The app isn't signed", what: "Android won't install it, and nothing proves who made it.", fix: "Sign it with your release key (apksigner / Android Studio › Generate Signed Bundle)." });
  else if (!sig.v2 && !sig.v3)
    add({ sev: minSdk < 24 ? "medium" : "low", cat: "Signing", title: "Only the old v1 (JAR) signature", what: "v1 signatures don't cover the whole file; on Android 5–8 that allowed tampering (the \"Janus\" bug).", fix: "Sign with APK Signature Scheme v2 or v3 (apksigner does by default)." });
  if (sig.debug || sig.v1Debug)
    add({ sev: "high", cat: "Signing", title: "Signed with a debug key", what: "The certificate says \"Android Debug\". Debug keys are not secret, and Google Play rejects such apps.", fix: "Build a release version signed with your own upload/release key." });

  // ---- what it's built with, native code ----
  const allNames = entries.map((e) => e.name);
  const libs = entries.filter((e) => /^lib\/[^/]+\/[^/]+\.so$/.test(e.name));
  const abis = [...new Set(libs.map((e) => e.name.split("/")[1]))];
  info.abis = abis;
  info.framework = allNames.some((n) => /libflutter\.so$/.test(n)) ? "Flutter"
    : allNames.includes("assets/index.android.bundle") || allNames.some((n) => /libreactnativejni\.so$|libhermes\.so$/.test(n)) ? "React Native"
    : allNames.some((n) => /^assemblies\/|libmonodroid\.so$/.test(n)) ? "Xamarin / .NET MAUI"
    : allNames.some((n) => /^assets\/www\/(index\.html|cordova\.js)$/.test(n)) ? "Cordova / Ionic"
    : allNames.some((n) => /libunity\.so$/.test(n)) ? "Unity" : "Android (Java/Kotlin)";
  if (libs.length)
    add({ sev: "info", cat: "Code", title: `Native code: ${abis.join(", ")}`, what: `${new Set(libs.map((e) => e.name.split("/").pop())).size} native libraries. Native code isn't covered by Java memory safety.`, fix: "Keep native libraries up to date.", evidence: [...new Set(libs.map((e) => e.name.split("/").pop()))].slice(0, 30) });

  // ---- code and assets: strings ----
  const secretHits = new Map(); // rule.id -> Set(evidence)
  const httpHosts = new Map(); // host -> count
  const apiHits = new Set(), cryptoHits = new Map(); // title -> Set(sample)
  let runtime = false, exec = false, jsUrl = 0, strCount = 0;
  const apiSet = new Map(API_HINTS.map((h) => [h.s, h]));
  const checkSecrets = (s, where) => {
    if (s.length < 10 || s.length > 4000) return;
    for (const r of SECRET_RULES) {
      const m = r.re.exec(s);
      if (!m) continue;
      const v = m[1] || m[0];
      // "password = :password", "api_key=%1$s", "token={token}": names and templates, not values.
      // Code like "accessToken: res['x']" or "password: TextField(" isn't a value either; real ones have a digit or are long.
      if (r.id === "assign" && (SECRET_PLACEHOLDER.test(v) || /^[^A-Za-z0-9]/.test(v) || /pass|secret|token|key|user|name/i.test(v)
        || /^AIza/.test(v) || /[()[\]{}!$<>]/.test(v) || /^[A-Z][A-Za-z]+\.[a-z]/.test(v) || !(/\d/.test(v) || v.length >= 16))) continue;
      const shown = r.id === "assign" ? `${m[0].slice(0, m[0].indexOf(v)).trim()} ${mask(v)}` : mask(v);
      let set = secretHits.get(r.id); if (!set) secretHits.set(r.id, (set = new Set()));
      if (set.size < 12) set.add(`${shown} — in ${where}`);
    }
  };
  const checkUrl = (s) => {
    if (s.length > 2000 || s.indexOf("http://") < 0) return;
    for (const m of s.matchAll(/http:\/\/([A-Za-z0-9.-]+)(?::\d+)?/g)) {
      const host = m[1].toLowerCase();
      if (!host.includes(".") || BENIGN_HTTP.test(host)) continue;
      httpHosts.set(host, (httpHosts.get(host) || 0) + 1);
    }
  };
  const onCode = (where) => (s) => {
    strCount++;
    const h = apiSet.get(s); if (h) apiHits.add(h);
    if (s === "Ljava/lang/Runtime;") runtime = true; else if (s === "exec") exec = true;
    else if (s.startsWith("javascript:")) jsUrl++;
    if (s.length <= 40) for (const c of CRYPTO_HINTS) if (c.re.test(s)) { let set = cryptoHits.get(c); if (!set) cryptoHits.set(c, (set = new Set())); set.add(s); }
    checkSecrets(s, where);
    checkUrl(s);
  };

  // Code is read part by part, with breaks so the window stays responsive.
  const codeEntries = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  let budget = codeLimitBytes, skipped = 0;
  const totalCode = codeEntries.reduce((n, e) => n + e.size, 0) || 1;
  let doneCode = 0;
  for (const e of codeEntries) {
    if (e.size > budget) { skipped++; continue; }
    budget -= e.size;
    onProgress(`Reading code (${e.name})…`, 0.2 + 0.55 * (doneCode / totalCode));
    await yieldNow();
    const bytes = take(e.part, [e.name])[e.name];
    if (bytes) {
      // Split into slices of work: dexStrings is synchronous, so yield between files only, but they're bounded.
      dexStrings(bytes, onCode(e.name));
    }
    doneCode += e.size;
  }
  info.dexFiles = codeEntries.length;

  // resources.arsc string values (google_api_key, URLs in strings.xml…)
  if (table?.values) {
    onProgress("Reading resources…", 0.78);
    await yieldNow();
    const n = Math.min(table.values.count, 400000);
    for (let i = 0; i < n; i++) { const s = table.values.get(i); if (s) { checkSecrets(s, "resources (strings.xml)"); checkUrl(s); } }
  }

  // Cross-platform code: React Native bundle, Flutter assets and compiled Dart (libapp.so).
  const textAssets = entries.filter((e) => e.size <= 8 * 1024 * 1024 && (e.name === "assets/index.android.bundle"
    || /^assets\/flutter_assets\/.+\.(json|js|txt|env|yaml|yml|properties|xml|html)$/i.test(e.name)
    || /^assets\/[^/]+\.(json|properties|env|txt|js|xml)$/i.test(e.name) || /^assets\/www\/.+\.js$/i.test(e.name)));
  if (textAssets.length) {
    onProgress("Reading app assets…", 0.82);
    await yieldNow();
    const dec = new TextDecoder("utf-8", { fatal: false });
    let n = 0;
    for (const e of textAssets.slice(0, 400)) {
      const b = take(e.part, [e.name])[e.name];
      if (!b) continue;
      const text = dec.decode(b);
      for (const line of text.split(/[\n;]/)) { checkSecrets(line.slice(0, 4000), e.name); checkUrl(line); }
      if (++n % 20 === 0) await yieldNow();
    }
  }
  // Release builds compile Dart into libapp.so; debug builds keep it in flutter_assets/kernel_blob.bin.
  const dartLib = entries.find((e) => /^lib\/(arm64-v8a|armeabi-v7a|x86_64|x86)\/libapp\.so$/.test(e.name))
    || entries.find((e) => e.name === "assets/flutter_assets/kernel_blob.bin");
  if (dartLib && dartLib.size > 192 * 1024 * 1024) skipped++;
  else if (dartLib) {
    onProgress("Reading compiled Dart code…", 0.88);
    await yieldNow();
    const b = take(dartLib.part, [dartLib.name])[dartLib.name];
    const where = dartLib.name.endsWith("libapp.so") ? "Dart code (libapp.so)" : "Dart code (debug kernel_blob.bin)";
    // A debug kernel also holds every package's source comments, so its URLs would only be noise.
    const urls = dartLib.name.endsWith("libapp.so");
    if (b) asciiStrings(b, (s) => { checkSecrets(s, where); if (urls) checkUrl(s); }, 8, 192 * 1024 * 1024);
  }
  onProgress("Writing the report…", 0.96);

  for (const r of SECRET_RULES) {
    const set = secretHits.get(r.id);
    if (!set) continue;
    add({ sev: r.sev, cat: "Secrets", title: r.title, what: "Text that looks like a credential is built into the app. Anyone can unpack an APK and read it.", fix: r.fix, evidence: [...set] });
  }
  if (httpHosts.size) {
    const top = [...httpHosts].sort((a, b) => b[1] - a[1]).map(([h]) => h);
    add({ sev: "low", cat: "Network", title: `Plain http:// addresses (${top.length} server${top.length > 1 ? "s" : ""})`, what: "These URLs would send data unencrypted. Some may come from libraries or never be called.", fix: "Use https:// for every server the app talks to.", evidence: top.slice(0, 20) });
  }
  for (const h of apiHits) add({ sev: h.sev, cat: "Code", title: h.title, what: `${h.what} (Found in the code; it may come from a library.)`, fix: h.fix });
  for (const [c, set] of cryptoHits) add({ sev: c.sev, cat: "Crypto", title: c.title, what: `${c.what} (Found in the code; it may come from a library.)`, fix: c.fix, evidence: [...set].slice(0, 6) });
  if (runtime && exec) add({ sev: "info", cat: "Code", title: "Runs shell commands (Runtime.exec)", what: "The code can start other programs. Building the command from input would allow command injection.", fix: "Avoid Runtime.exec; never pass user input into it." });
  if (jsUrl) add({ sev: "info", cat: "Code", title: "Runs JavaScript in a WebView via javascript: URLs", what: `${jsUrl} javascript: string${jsUrl > 1 ? "s" : ""} in the code.`, fix: "Use evaluateJavascript() and never put untrusted data into the script." });
  if (skipped) add({ sev: "info", cat: "Scan", title: "Part of the code wasn't scanned", what: `${skipped} code file${skipped > 1 ? "s were" : " was"} skipped to keep the scan quick.`, fix: "" });

  findings.sort((a, b) => SEVERITIES.indexOf(a.sev) - SEVERITIES.indexOf(b.sev));
  findings.forEach((f, i) => { f.id = i + 1; });
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.sev === s).length]));
  return {
    info, findings, counts,
    stats: { strings: strCount, components: comps.length, exported: comps.filter((c) => c.exported).length },
    // For the checks on the phone.
    providers: comps.filter((c) => c.type === "provider" && c.exported && c.enabled).map((c) => ({ name: c.short, authorities: c.authorities, perm: c.perm || c.readPerm || null })),
    debuggable: A(app, "debuggable") === true,
  };
}

// ---------- signatures ----------
function hasAscii(bytes, text) {
  const t = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - t.length; i++) {
    if (bytes[i] !== t[0]) continue;
    for (let j = 1; j < t.length; j++) if (bytes[i + j] !== t[j]) continue outer;
    return true;
  }
  return false;
}

/** v1 certificate files, and which v2/v3 blocks the APK Signing Block holds (plus a debug-cert hint). */
export function signingInfo(bytes, names) {
  const out = { v1: names.filter((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n)), v2: false, v3: false, v31: false, debug: false };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: last 22 bytes + up to 64 KB comment.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff < 32 || cdOff > bytes.length) return out;
  const magic = String.fromCharCode(...bytes.subarray(cdOff - 16, cdOff));
  if (magic !== "APK Sig Block 42") return out;
  const size = Number(dv.getBigUint64(cdOff - 24, true));
  const start = cdOff - size - 8;
  if (start < 0) return out;
  let p = start + 8;
  while (p + 12 <= cdOff - 24) {
    const len = Number(dv.getBigUint64(p, true));
    if (len < 4 || p + 8 + len > cdOff) break;
    const id = dv.getUint32(p + 8, true);
    if (id === 0x7109871a) out.v2 = true;
    else if (id === 0xf05368c0) out.v3 = true;
    else if (id === 0x1b93ad61) out.v31 = true;
    if (id === 0x7109871a || id === 0xf05368c0) {
      if (hasAscii(bytes.subarray(p + 12, p + 8 + len), "Android Debug")) out.debug = true;
    }
    p += 8 + len;
  }
  return out;
}
