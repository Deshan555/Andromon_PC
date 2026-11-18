#!/usr/bin/env node
// Builds the web version of Andromon (the same app, in Chrome or Edge, no Electron) into dist/web/,
// ready to upload to any static host such as Netlify, plus dist/andromon-web.zip of the same files.
// Run with:  npm run build:web   (it bundles src/app.js first)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'renderer');
const OUT = path.join(ROOT, 'dist', 'web');
const ZIP = path.join(ROOT, 'dist', 'andromon-web.zip');
// Desktop-only files: the start-up splash window and the bundle's source map.
const SKIP = new Set(['splash.html', 'splash.js', 'app.js.map', '.DS_Store']);

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true, filter: (p) => !SKIP.has(path.basename(p)) });

// Caching for Netlify / Cloudflare Pages: the page and its bundle are checked on every visit (a new
// upload shows at once); fonts, the phone-side helpers and pictures keep their names, so a day is safe.
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin',
  '/index.html', '  Cache-Control: no-cache',
  '/app.js', '  Cache-Control: no-cache',
  '/fonts/*', '  Cache-Control: public, max-age=31536000, immutable',
  '/img/*', '  Cache-Control: public, max-age=86400',
  '/*.apk', '  Content-Type: application/vnd.android.package-archive', '  Cache-Control: public, max-age=3600',
  '/*.jar', '  Content-Type: application/java-archive', '  Cache-Control: public, max-age=86400',
].join('\n') + '\n');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify({ name: 'Andromon', version: pkg.version, built: new Date().toISOString() }, null, 2) + '\n');

fs.rmSync(ZIP, { force: true });
execFileSync('zip', ['-qr', ZIP, '.'], { cwd: OUT });

let bytes = 0, files = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } });
walk(OUT);
console.log(`Web build: dist/web/ (${files} files, ${(bytes / 1e6).toFixed(1)} MB) and dist/andromon-web.zip (${(fs.statSync(ZIP).size / 1e6).toFixed(1)} MB)`);
