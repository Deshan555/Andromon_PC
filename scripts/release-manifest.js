#!/usr/bin/env node
// Keeps two files on the "release" branch up to date after each build (run by .github/workflows/desktop.yml):
//   latest.json    what the newest build is: version, build number, commit, and every installer with its
//                  size, SHA-256 and download address
//   CHANGELOG.md   one section per build, newest first, listing the commits since the build before it
//   release notes  (optional third argument) the same list of commits, as the text of the GitHub Release
// Besides the desktop installers, the folder may hold the phone app (.apk) and the web build (.zip); they
// are listed with platform "android" and "web". The phone app's version, build number and the commits in
// ../android since the previous manifest are added under "companion" (COMPANION_SINCE=<commit> sets
// where its list starts when the previous manifest has none). MANIFEST_OUT=<folder> writes latest.json
// and CHANGELOG.md there instead of next to package.json.
// usage: node scripts/release-manifest.js <folder with the installers> [file to write the release notes to]
// It reads GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_RUN_NUMBER when GitHub sets them, and git otherwise.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error("usage: release-manifest.js <folder with the installers>"); process.exit(1); }
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// SOURCE_REPOSITORY / SOURCE_SHA: when the workflow runs in another repository (Andromon_Releases builds
// this one's code), the repository and commit that were built; GitHub's own variables name the other one.
const repo = process.env.SOURCE_REPOSITORY || process.env.GITHUB_REPOSITORY || String(pkg.homepage || "").replace(/^https:\/\/github\.com\//, "");
// Where the files are downloaded from: RELEASE_REPOSITORY (for example Deshan555/Andromon_Releases) when the
// releases are published in their own repository; commit links keep pointing at the source (repo).
const releaseRepo = process.env.RELEASE_REPOSITORY || repo;
const commit = process.env.SOURCE_SHA || (process.env.SOURCE_REPOSITORY ? "" : process.env.GITHUB_SHA) || git("rev-parse", "HEAD");
const build = Number(process.env.GITHUB_RUN_NUMBER) || 0;
const tag = `v${pkg.version}`;
const date = new Date().toISOString();

// ---------- the installers ----------
// The update check only looks at mac, windows and linux, so the phone app and the web build can sit in the same list.
const KINDS = { ".dmg": ["mac", "dmg"], ".exe": ["windows", "exe"], ".appimage": ["linux", "AppImage"], ".deb": ["linux", "deb"], ".apk": ["android", "apk"], ".zip": ["web", "zip"] };
const archOf = (name) => (/arm64|aarch64/i.test(name) ? "arm64" : /x64|x86_64|amd64/i.test(name) ? "x64" : /ia32|x86\b|i386/i.test(name) ? "ia32" : "");
const files = fs.readdirSync(dir).filter((n) => KINDS[path.extname(n).toLowerCase()]).sort().map((name) => {
  const data = fs.readFileSync(path.join(dir, name));
  const [platform, kind] = KINDS[path.extname(name).toLowerCase()];
  return {
    platform, arch: archOf(name), kind, name, size: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    // Works once the release for this version is published. GitHub stores a space in a file name as a dot.
    url: `https://github.com/${releaseRepo}/releases/download/${tag}/${encodeURIComponent(name.replace(/ /g, "."))}`,
  };
});
if (!files.length) { console.error(`No installers found in ${dir}`); process.exit(1); }

// ---------- what changed since the build before ----------
const outDir = process.env.MANIFEST_OUT ? path.resolve(process.env.MANIFEST_OUT) : root;
const manifestFile = path.join(outDir, "latest.json"), logFile = path.join(outDir, "CHANGELOG.md");
let previous = null;
try { previous = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch {}
// A new folder has no manifest yet: start from the one next to package.json (the last recorded build).
if (!previous && outDir !== root) try { previous = JSON.parse(fs.readFileSync(path.join(root, "latest.json"), "utf8")); } catch {}
const known = (sha) => { try { git("cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };
const range = previous?.commit && known(previous.commit) ? [`${previous.commit}..${commit}`] : ["-n", "30", commit];
// The workflow's own commits (this file and the changelog) are not changes to the app.
const changes = git("log", "--no-merges", "--format=%h%x09%s%x09%an", ...range).split("\n").filter(Boolean)
  .map((l) => l.split("\t")).filter(([, , author]) => author !== "github-actions[bot]").map(([sha, subject]) => ({ sha, subject }));

// ---------- the phone app (../android) ----------
// Version bumps ("Release 1.0.4") are left out of its list: the version is already in the manifest.
let companion = null;
const androidDir = path.join(root, "..", "android");
try {
  const gradle = fs.readFileSync(path.join(androidDir, "app", "build.gradle.kts"), "utf8");
  const agit = (...args) => execFileSync("git", args, { cwd: androidDir, encoding: "utf8" }).trim();
  const aknown = (sha) => { try { agit("cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };
  const acommit = agit("rev-parse", "HEAD");
  const since = previous?.companion?.commit || process.env.COMPANION_SINCE;
  const arange = since && aknown(since) ? [`${since}..${acommit}`] : ["-n", "30", acommit];
  companion = {
    version: gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1] || "",
    versionCode: Number(gradle.match(/versionCode\s*=\s*(\d+)/)?.[1]) || 0,
    build: Number(gradle.match(/"BUILD_NUMBER",\s*"(\d+)"/)?.[1]) || 0,
    commit: acommit,
    changes: agit("log", "--no-merges", "--format=%h%x09%s", ...arange).split("\n").filter(Boolean)
      .map((l) => l.split("\t")).filter(([, subject]) => !/^(Release \d|Bump to \d)/.test(subject)).map(([sha, subject]) => ({ sha, subject })),
    since: since && aknown(since) ? since : "",
  };
} catch (e) {
  // No ../android here (the GitHub workflow builds the pc repository alone): read the version from the
  // APK in the folder with aapt2 from the Android SDK, without a list of changes.
  const apk = files.find((f) => f.platform === "android");
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  try {
    if (!apk || !sdk) throw e;
    const tools = path.join(sdk, "build-tools");
    const newest = fs.readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    const badging = execFileSync(path.join(tools, newest, "aapt2"), ["dump", "badging", path.join(dir, apk.name)], { encoding: "utf8" });
    companion = {
      version: badging.match(/versionName='([^']*)'/)?.[1] || "", versionCode: Number(badging.match(/versionCode='(\d+)'/)?.[1]) || 0,
      build: 0, commit: "", changes: [], since: "", fromApk: true,
    };
  } catch (e2) { console.warn(`Phone app not recorded (${String(e2.message).split("\n")[0]})`); }
}

const manifest = {
  name: pkg.build?.productName || pkg.name, version: pkg.version, build, date, commit,
  release: `https://github.com/${releaseRepo}/releases/tag/${tag}`,
  changes: changes.map((c) => c.subject),
  ...(companion ? { companion: { ...companion, fromApk: undefined, changes: companion.changes.map((c) => c.subject) } } : {}),
  files,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

// ---------- CHANGELOG.md: the new section goes on top ----------
const HEAD = "# Changelog\n\nEvery build of the `release` branch, newest first. Written by the build; don't edit by hand.\n";
const list = (cs, none) => (cs.length ? cs.map((c) => `- ${c.subject} (\`${c.sha}\`)`) : [none]);
const has = (platform) => files.some((f) => f.platform === platform);
const section = [
  `## ${tag}${build ? ` (build ${build})` : ""} · ${date.slice(0, 10)}`, "",
  ...(companion ? ["### Desktop and web", ""] : []),
  ...list(changes, "- Rebuilt; no changes to the app."),
  ...(previous ? [] : ["", "First build recorded here: the list shows the latest commits, not everything before it."]),
  ...(companion ? [
    "", `### Phone app ${companion.version}${companion.build ? ` (build ${companion.build})` : ""}`, "",
    ...(companion.fromApk ? [`- The phone app bundled in this build (version code ${companion.versionCode}). Its changes are in the Android repository.`]
      : [...list(companion.changes, "- No changes to the phone app."),
        ...(companion.since ? [] : ["", "The list shows the phone app's latest commits, not everything before it."])]),
  ] : []),
  "", "### Downloads", "",
  ...files.map((f) => `- ${{ mac: "macOS", windows: "Windows", linux: "Linux", android: "Android", web: "Web" }[f.platform]}${f.arch ? ` ${f.arch}` : ""} (${f.kind}): [${f.name}](${f.url}), ${(f.size / 1e6).toFixed(1)} MB`),
  ...(has("web") ? ["", "The web build runs in Chrome or Edge: unzip it and upload the files to any static host."] : []),
  "",
].join("\n");
let old = "";
try { old = fs.readFileSync(logFile, "utf8"); } catch {}
if (!old && outDir !== root) try { old = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"); } catch {} // carry on the history
const rest = old.startsWith(HEAD) ? old.slice(HEAD.length).replace(/^\n+/, "") : old.replace(/^# Changelog[^\n]*\n+/, "");
fs.writeFileSync(logFile, `${HEAD}\n${section}${rest ? "\n" + rest : ""}`);

// ---------- the GitHub Release's description: what changed since the previous build ----------
if (process.argv[3]) {
  const link = (c) => `- ${c.subject} ([\`${c.sha}\`](https://github.com/${repo}/commit/${c.sha}))`;
  fs.writeFileSync(process.argv[3], [
    `## What's changed${build ? ` in build ${build}` : ""}`, "",
    ...(changes.length ? changes.map(link) : ["- Rebuilt; no changes to the app."]), "",
    previous?.commit
      ? `Changes since the previous build ([\`${previous.commit.slice(0, 7)}\`](https://github.com/${repo}/commit/${previous.commit})${previous.build ? `, build ${previous.build}` : ""}).`
      : "First build: the list shows the latest commits.",
    `Every build is listed in the [changelog](https://github.com/${releaseRepo}/blob/${releaseRepo === repo ? "release" : "HEAD"}/CHANGELOG.md).`, "",
    // The phone app lives in another repository, so its commits are named without a link.
    ...(companion ? [`## Phone app ${companion.version}${companion.build ? ` (build ${companion.build})` : ""}`, "",
      ...(companion.changes.length ? companion.changes.map((c) => `- ${c.subject} (\`${c.sha}\`)`) : ["- No changes to the phone app."]), ""] : []),
  ].join("\n"));
}

console.log(`${tag} build ${build}: ${files.length} file(s), ${changes.length} change(s) since ${previous?.commit?.slice(0, 7) || "the start"}`);
