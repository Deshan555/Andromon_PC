#!/usr/bin/env node
// Records how often Andromon's releases have really been downloaded, from GitHub's own counters (run every day
// by .github/workflows/download-stats.yml, and by hand). Nothing here downloads a release or changes a count.
// Only the installers, the phone app and the web build are counted: latest.json, CHANGELOG.md and
// SHA256SUMS.txt are fetched by the update check and by people checking a download, not installs.
// It writes, into the folder given (default: stats/ next to package.json):
//   downloads.json  the newest snapshot: totals, per release, per platform, per file
//   history.csv     one line per day: date, total, and the total per platform (today's line is replaced)
//   badge.json      a shields.io endpoint badge ("downloads | 123")
//   DOWNLOADS.md    the same numbers as tables, for reading on GitHub
// usage: node scripts/download-stats.js [folder]
// RELEASE_REPOSITORY sets the repository (default Deshan555/Andromon_Releases); GH_TOKEN or GITHUB_TOKEN,
// when set, is sent so the request isn't held to GitHub's limit for anonymous requests.
const fs = require("node:fs");
const path = require("node:path");

const repo = process.env.RELEASE_REPOSITORY || "Deshan555/Andromon_Releases";
const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "stats"));
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

const PLATFORMS = [
  ["windows", /\.exe$/i], ["mac", /\.dmg$/i], ["linux", /\.(appimage|deb)$/i],
  ["android", /\.apk$/i], ["web", /\.zip$/i],
];
const platformOf = (name) => (PLATFORMS.find(([, re]) => re.test(name)) || [null])[0];

async function releases() {
  const all = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "andromon-download-stats", ...(token && { Authorization: `Bearer ${token}` }) },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${repo}'s releases: ${await res.text()}`);
    const list = await res.json();
    all.push(...list);
    if (list.length < 100) return all;
  }
}

const sum = (list) => list.reduce((n, x) => n + x.downloads, 0);
const zeroes = () => Object.fromEntries(PLATFORMS.map(([p]) => [p, 0]));
const fmt = (n) => n.toLocaleString("en-US");

(async () => {
  const list = (await releases()).filter((r) => !r.draft);
  const byPlatform = zeroes();
  const perRelease = list.map((r) => {
    const files = r.assets.filter((a) => platformOf(a.name))
      .map((a) => ({ name: a.name, platform: platformOf(a.name), downloads: a.download_count }))
      .sort((a, b) => b.downloads - a.downloads);
    const platforms = zeroes();
    for (const f of files) { platforms[f.platform] += f.downloads; byPlatform[f.platform] += f.downloads; }
    return { tag: r.tag_name, published: r.published_at, prerelease: r.prerelease, downloads: sum(files), platforms, files };
  });
  const total = sum(perRelease);
  const date = new Date().toISOString();
  const snapshot = { repository: repo, date, total, platforms: byPlatform, releases: perRelease };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "downloads.json"), JSON.stringify(snapshot, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "badge.json"), JSON.stringify({ schemaVersion: 1, label: "downloads", message: fmt(total), color: "9CD237" }) + "\n");

  // One line per day; running twice on the same day replaces that day's line.
  const csvFile = path.join(outDir, "history.csv");
  const header = ["date", "total", ...PLATFORMS.map(([p]) => p)].join(",");
  const day = date.slice(0, 10);
  let lines = [];
  try { lines = fs.readFileSync(csvFile, "utf8").trim().split("\n").slice(1).filter((l) => l && !l.startsWith(day + ",")); } catch {}
  lines.push([day, total, ...PLATFORMS.map(([p]) => byPlatform[p])].join(","));
  fs.writeFileSync(csvFile, [header, ...lines.sort()].join("\n") + "\n");

  const cap = (s) => ({ mac: "macOS", web: "Web" }[s] || s[0].toUpperCase() + s.slice(1));
  const md = [
    "# Downloads", "",
    `Downloads of the installers, the phone app and the web build, as counted by GitHub, on ${day}. Updated every day; the daily totals are in [history.csv](history.csv).`, "",
    `**Total: ${fmt(total)}**`, "",
    `| ${PLATFORMS.map(([p]) => cap(p)).join(" | ")} |`, `|${PLATFORMS.map(() => "---:").join("|")}|`,
    `| ${PLATFORMS.map(([p]) => fmt(byPlatform[p])).join(" | ")} |`, "",
    "## Per release", "",
    `| Release | Published | Downloads | ${PLATFORMS.map(([p]) => cap(p)).join(" | ")} |`, `|---|---|---:|${PLATFORMS.map(() => "---:").join("|")}|`,
    ...perRelease.map((r) => `| [${r.tag}](https://github.com/${repo}/releases/tag/${r.tag}) | ${String(r.published).slice(0, 10)} | ${fmt(r.downloads)} | ${PLATFORMS.map(([p]) => fmt(r.platforms[p])).join(" | ")} |`),
    "",
  ];
  fs.writeFileSync(path.join(outDir, "DOWNLOADS.md"), md.join("\n"));

  console.log(`${repo}: ${fmt(total)} downloads in ${perRelease.length} releases (${PLATFORMS.map(([p]) => `${p} ${byPlatform[p]}`).join(", ")})`);
  for (const r of perRelease) console.log(`  ${r.tag}: ${r.downloads}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n"));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
