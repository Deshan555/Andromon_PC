#!/usr/bin/env node
// Keeps two files on the "release" branch up to date after each build (run by .github/workflows/desktop.yml):
//   latest.json    what the newest build is: version, build number, commit, and every installer with its
//                  size, SHA-256 and download address
//   CHANGELOG.md   one section per build, newest first, listing the commits since the build before it
// usage: node scripts/release-manifest.js <folder with the installers>
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
const repo = process.env.GITHUB_REPOSITORY || String(pkg.homepage || "").replace(/^https:\/\/github\.com\//, "");
const commit = process.env.GITHUB_SHA || git("rev-parse", "HEAD");
const build = Number(process.env.GITHUB_RUN_NUMBER) || 0;
const tag = `v${pkg.version}`;
const date = new Date().toISOString();

// ---------- the installers ----------
const KINDS = { ".dmg": ["mac", "dmg"], ".exe": ["windows", "exe"], ".appimage": ["linux", "AppImage"], ".deb": ["linux", "deb"] };
const archOf = (name) => (/arm64|aarch64/i.test(name) ? "arm64" : /x64|x86_64|amd64/i.test(name) ? "x64" : "");
const files = fs.readdirSync(dir).filter((n) => KINDS[path.extname(n).toLowerCase()]).sort().map((name) => {
  const data = fs.readFileSync(path.join(dir, name));
  const [platform, kind] = KINDS[path.extname(name).toLowerCase()];
  return {
    platform, arch: archOf(name), kind, name, size: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    // Works once the release for this version is published. GitHub stores a space in a file name as a dot.
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name.replace(/ /g, "."))}`,
  };
});
if (!files.length) { console.error(`No installers found in ${dir}`); process.exit(1); }

// ---------- what changed since the build before ----------
const manifestFile = path.join(root, "latest.json"), logFile = path.join(root, "CHANGELOG.md");
let previous = null;
try { previous = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch {}
const known = (sha) => { try { git("cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };
const range = previous?.commit && known(previous.commit) ? [`${previous.commit}..${commit}`] : ["-n", "30", commit];
// The workflow's own commits (this file and the changelog) are not changes to the app.
const changes = git("log", "--no-merges", "--format=%h%x09%s%x09%an", ...range).split("\n").filter(Boolean)
  .map((l) => l.split("\t")).filter(([, , author]) => author !== "github-actions[bot]").map(([sha, subject]) => ({ sha, subject }));

const manifest = {
  name: pkg.build?.productName || pkg.name, version: pkg.version, build, date, commit,
  release: `https://github.com/${repo}/releases/tag/${tag}`,
  changes: changes.map((c) => c.subject),
  files,
};
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");

// ---------- CHANGELOG.md: the new section goes on top ----------
const HEAD = "# Changelog\n\nEvery build of the `release` branch, newest first. Written by the build; don't edit by hand.\n";
const section = [
  `## ${tag}${build ? ` (build ${build})` : ""} · ${date.slice(0, 10)}`, "",
  ...(changes.length ? changes.map((c) => `- ${c.subject} (\`${c.sha}\`)`) : ["- Rebuilt; no changes to the app."]),
  ...(previous ? [] : ["", "First build recorded here: the list shows the latest commits, not everything before it."]),
  "",
].join("\n");
let old = "";
try { old = fs.readFileSync(logFile, "utf8"); } catch {}
const rest = old.startsWith(HEAD) ? old.slice(HEAD.length).replace(/^\n+/, "") : old.replace(/^# Changelog[^\n]*\n+/, "");
fs.writeFileSync(logFile, `${HEAD}\n${section}${rest ? "\n" + rest : ""}`);

console.log(`${tag} build ${build}: ${files.length} installer(s), ${changes.length} change(s) since ${previous?.commit?.slice(0, 7) || "the start"}`);
