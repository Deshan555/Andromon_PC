// The app's shared icons: file types for every list of files, and the icons of controls built in script. The drawings are Lucide icons (lucide.dev,
// ISC License), stroked by the stylesheet (.ficon svg). fileKind() sorts a file name into a kind;
// fileIcon() returns that kind's icon in a small tinted tile; icon() returns one bare icon by name.

const ICONS = {
  "archive-restore": "<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\"/> <path d=\"M4 8v11a2 2 0 0 0 2 2h2\"/> <path d=\"M20 8v11a2 2 0 0 1-2 2h-2\"/> <path d=\"m9 15 3-3 3 3\"/> <path d=\"M12 12v9\"/>",
  "archive": "<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\"/> <path d=\"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8\"/> <path d=\"M10 12h4\"/>",
  "arrow-up": "<path d=\"m5 12 7-7 7 7\"/> <path d=\"M12 19V5\"/>",
  "book-open": "<path d=\"M12 7v14\"/> <path d=\"M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z\"/>",
  "database": "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/> <path d=\"M3 5V19A9 3 0 0 0 21 19V5\"/> <path d=\"M3 12A9 3 0 0 0 21 12\"/>",
  "download": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> <polyline points=\"7 10 12 15 17 10\"/> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"/>",
  "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/> <circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "file-archive": "<path d=\"M10 12v-1\"/> <path d=\"M10 18v-2\"/> <path d=\"M10 7V6\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M15.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v16a2 2 0 0 0 .274 1.01\"/> <circle cx=\"10\" cy=\"20\" r=\"2\"/>",
  "file-audio": "<path d=\"M17.5 22h.5a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M2 19a2 2 0 1 1 4 0v1a2 2 0 1 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 1 1-4 0v-1a2 2 0 1 1 4 0\"/>",
  "file-code": "<path d=\"M10 12.5 8 15l2 2.5\"/> <path d=\"m14 12.5 2 2.5-2 2.5\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z\"/>",
  "file-cog": "<path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"m3.2 12.9-.9-.4\"/> <path d=\"m3.2 15.1-.9.4\"/> <path d=\"M4.677 21.5a2 2 0 0 0 1.313.5H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v2.5\"/> <path d=\"m4.9 11.2-.4-.9\"/> <path d=\"m4.9 16.8-.4.9\"/> <path d=\"m7.5 10.3-.4.9\"/> <path d=\"m7.5 17.7-.4-.9\"/> <path d=\"m9.7 12.5-.9.4\"/> <path d=\"m9.7 15.5-.9-.4\"/> <circle cx=\"6\" cy=\"14\" r=\"3\"/>",
  "file-image": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <circle cx=\"10\" cy=\"12\" r=\"2\"/> <path d=\"m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22\"/>",
  "file-json": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1\"/> <path d=\"M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1\"/>",
  "file-lock": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <rect width=\"8\" height=\"6\" x=\"8\" y=\"12\" rx=\"1\"/> <path d=\"M10 12v-2a2 2 0 1 1 4 0v2\"/>",
  "file-spreadsheet": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M8 13h2\"/> <path d=\"M14 13h2\"/> <path d=\"M8 17h2\"/> <path d=\"M14 17h2\"/>",
  "file-symlink": "<path d=\"m10 18 3-3-3-3\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M4 11V4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7\"/>",
  "file-terminal": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"m8 16 2-2-2-2\"/> <path d=\"M12 18h4\"/>",
  "file-text": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M10 9H8\"/> <path d=\"M16 13H8\"/> <path d=\"M16 17H8\"/>",
  "file-type": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"M9 13v-1h6v1\"/> <path d=\"M12 12v6\"/> <path d=\"M11 18h2\"/>",
  "file-video": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/> <path d=\"m10 11 5 3-5 3v-6Z\"/>",
  "file": "<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/> <path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/>",
  "folder-open": "<path d=\"m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2\"/>",
  "folder-plus": "<path d=\"M12 10v6\"/> <path d=\"M9 13h6\"/> <path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
  "folder": "<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>",
  "package": "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/> <path d=\"M12 22V12\"/> <path d=\"m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7\"/> <path d=\"m7.5 4.27 9 5.15\"/>",
  "pencil": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/> <path d=\"m15 5 4 4\"/>",
  "presentation": "<path d=\"M2 3h20\"/> <path d=\"M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3\"/> <path d=\"m7 21 5-5 5 5\"/>",
  "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/> <path d=\"M21 3v5h-5\"/> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/> <path d=\"M8 16H3v5\"/>",
  "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/> <path d=\"m21 21-4.3-4.3\"/>",
  "trash-2": "<path d=\"M3 6h18\"/> <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/> <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/> <line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/> <line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>",
  "upload": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> <polyline points=\"17 8 12 3 7 8\"/> <line x1=\"12\" x2=\"12\" y1=\"3\" y2=\"15\"/>",
  "x": "<path d=\"M18 6 6 18\"/> <path d=\"m6 6 12 12\"/>",
  "arrow-left": "<path d=\"m12 19-7-7 7-7\"/> <path d=\"M19 12H5\"/>",
  "bell": "<path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9\"/> <path d=\"M10.3 21a1.94 1.94 0 0 0 3.4 0\"/>",
  "camera": "<path d=\"M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z\"/> <circle cx=\"12\" cy=\"13\" r=\"3\"/>",
  "circle-dot": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <circle cx=\"12\" cy=\"12\" r=\"1\"/>",
  "circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"/>",
  "clipboard-paste": "<path d=\"M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z\"/> <path d=\"M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2M16 4h2a2 2 0 0 1 2 2v2M11 14h10\"/> <path d=\"m17 10 4 4-4 4\"/>",
  "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>",
  "eye-off": "<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\"/> <path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\"/> <path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\"/> <path d=\"m2 2 20 20\"/>",
  "headphones": "<path d=\"M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3\"/>",
  "image": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/> <circle cx=\"9\" cy=\"9\" r=\"2\"/> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"/>",
  "images": "<path d=\"M18 22H4a2 2 0 0 1-2-2V6\"/> <path d=\"m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18\"/> <circle cx=\"12\" cy=\"8\" r=\"2\"/> <rect width=\"16\" height=\"16\" x=\"6\" y=\"2\" rx=\"2\"/>",
  "lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>",
  "maximize": "<path d=\"M8 3H5a2 2 0 0 0-2 2v3\"/> <path d=\"M21 8V5a2 2 0 0 0-2-2h-3\"/> <path d=\"M3 16v3a2 2 0 0 0 2 2h3\"/> <path d=\"M16 21h3a2 2 0 0 0 2-2v-3\"/>",
  "menu": "<line x1=\"4\" x2=\"20\" y1=\"12\" y2=\"12\"/> <line x1=\"4\" x2=\"20\" y1=\"6\" y2=\"6\"/> <line x1=\"4\" x2=\"20\" y1=\"18\" y2=\"18\"/>",
  "panel-top-close": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/> <path d=\"M3 9h18\"/> <path d=\"m9 16 3-3 3 3\"/>",
  "pin": "<path d=\"M12 17v5\"/> <path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z\"/>",
  "play": "<polygon points=\"6 3 20 12 6 21 6 3\"/>",
  "power": "<path d=\"M12 2v10\"/> <path d=\"M18.4 6.6a9 9 0 1 1-12.77.04\"/>",
  "rotate-ccw": "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"/> <path d=\"M3 3v5h5\"/>",
  "rotate-cw": "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/> <path d=\"M21 3v5h-5\"/>",
  "send": "<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\"/> <path d=\"m21.854 2.147-10.94 10.939\"/>",
  "skip-back": "<polygon points=\"19 20 9 12 19 4 19 20\"/> <line x1=\"5\" x2=\"5\" y1=\"19\" y2=\"5\"/>",
  "skip-forward": "<polygon points=\"5 4 15 12 5 20 5 4\"/> <line x1=\"19\" x2=\"19\" y1=\"5\" y2=\"19\"/>",
  "sliders-horizontal": "<line x1=\"21\" x2=\"14\" y1=\"4\" y2=\"4\"/> <line x1=\"10\" x2=\"3\" y1=\"4\" y2=\"4\"/> <line x1=\"21\" x2=\"12\" y1=\"12\" y2=\"12\"/> <line x1=\"8\" x2=\"3\" y1=\"12\" y2=\"12\"/> <line x1=\"21\" x2=\"16\" y1=\"20\" y2=\"20\"/> <line x1=\"12\" x2=\"3\" y1=\"20\" y2=\"20\"/> <line x1=\"14\" x2=\"14\" y1=\"2\" y2=\"6\"/> <line x1=\"8\" x2=\"8\" y1=\"10\" y2=\"14\"/> <line x1=\"16\" x2=\"16\" y1=\"18\" y2=\"22\"/>",
  "square": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>",
  "sun-dim": "<circle cx=\"12\" cy=\"12\" r=\"4\"/> <path d=\"M12 4h.01\"/> <path d=\"M20 12h.01\"/> <path d=\"M12 20h.01\"/> <path d=\"M4 12h.01\"/> <path d=\"M17.657 6.343h.01\"/> <path d=\"M17.657 17.657h.01\"/> <path d=\"M6.343 17.657h.01\"/> <path d=\"M6.343 6.343h.01\"/>",
  "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/> <path d=\"M12 2v2\"/> <path d=\"M12 20v2\"/> <path d=\"m4.93 4.93 1.41 1.41\"/> <path d=\"m17.66 17.66 1.41 1.41\"/> <path d=\"M2 12h2\"/> <path d=\"M20 12h2\"/> <path d=\"m6.34 17.66-1.41 1.41\"/> <path d=\"m19.07 4.93-1.41 1.41\"/>",
  "timer": "<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\"/> <line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\"/> <circle cx=\"12\" cy=\"14\" r=\"8\"/>",
  "volume-1": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/> <path d=\"M16 9a5 5 0 0 1 0 6\"/>",
  "volume-2": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/> <path d=\"M16 9a5 5 0 0 1 0 6\"/> <path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"/>",
  "volume-x": "<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"/> <line x1=\"22\" x2=\"16\" y1=\"9\" y2=\"15\"/> <line x1=\"16\" x2=\"22\" y1=\"9\" y2=\"15\"/>",
  "zoom-in": "<circle cx=\"11\" cy=\"11\" r=\"8\"/> <line x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\"/> <line x1=\"11\" x2=\"11\" y1=\"8\" y2=\"14\"/> <line x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\"/>",
  "zoom-out": "<circle cx=\"11\" cy=\"11\" r=\"8\"/> <line x1=\"21\" x2=\"16.65\" y1=\"21\" y2=\"16.65\"/> <line x1=\"8\" x2=\"14\" y1=\"11\" y2=\"11\"/>",
  "minimize": "<path d=\"M8 3v3a2 2 0 0 1-2 2H3\"/> <path d=\"M21 8h-3a2 2 0 0 1-2-2V3\"/> <path d=\"M3 16h3a2 2 0 0 1 2 2v3\"/> <path d=\"M16 21v-3a2 2 0 0 1 2-2h3\"/>",
  "chevron-left": "<path d=\"m15 18-6-6 6-6\"/>",
  "chevron-right": "<path d=\"m9 18 6-6-6-6\"/>"
};

// kind -> [icon, extensions]. The kind also names the tile's colour class (fk-<kind>).
const KINDS = {
  image: ["file-image", "jpg jpeg png gif webp bmp svg avif ico heic heif tif tiff raw dng"],
  video: ["file-video", "mp4 m4v mkv webm mov avi 3gp 3g2 ts flv wmv mpg mpeg"],
  audio: ["file-audio", "mp3 m4a aac ogg oga opus wav flac amr mid midi wma"],
  archive: ["file-archive", "zip rar 7z tar gz tgz bz2 xz zst lz4 jar"],
  apk: ["package", "apk apks apkm xapk aab obb"],
  pdf: ["book-open", "pdf epub mobi"],
  doc: ["file-text", "doc docx odt rtf pages"],
  sheet: ["file-spreadsheet", "xls xlsx ods csv tsv numbers"],
  slides: ["presentation", "ppt pptx odp key"],
  code: ["file-code", "js mjs cjs ts jsx tsx kt kts java py rb go rs c h cpp hpp cs swift php html htm css scss xml gradle sql lua dart smali"],
  data: ["file-json", "json yaml yml toml ini conf cfg properties plist prop"],
  text: ["file-text", "txt md log srt vtt vcf ics nfo readme"],
  script: ["file-terminal", "sh bash zsh bat cmd ps1 rc"],
  font: ["file-type", "ttf otf woff woff2"],
  db: ["database", "db sqlite sqlite3 realm mdb"],
  secure: ["file-lock", "pem crt cer key keystore jks p12 pfx gpg asc"],
  system: ["file-cog", "so dex odex vdex art img bin dat dll exe elf ko"],
};
const BY_EXT = new Map();
for (const [kind, [, exts]] of Object.entries(KINDS)) for (const e of exts.split(" ")) BY_EXT.set(e, kind);

export const extOf = (name) => { const m = /\.([^./\\]+)$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };

/** "image", "video", "archive"…; "folder" and "link" for those; "file" when the type isn't known. */
export function fileKind(name, type = "file") {
  if (type === "dir") return "folder";
  if (type === "link") return "link";
  const n = String(name || "").toLowerCase();
  if (/\.tar\.(gz|bz2|xz|zst)$/.test(n)) return "archive";
  return BY_EXT.get(extOf(n)) || "file";
}

/** One Lucide icon as an <svg> element. */
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || ICONS.file;
  return svg;
}

/** The icon for a file, in its tinted tile: <span class="ficon fk-image"><svg/></span>. */
export function fileIcon(name, type = "file") {
  const kind = fileKind(name, type);
  const tile = document.createElement("span");
  tile.className = `ficon fk-${kind}`;
  tile.append(icon(kind === "folder" ? "folder" : kind === "link" ? "file-symlink" : KINDS[kind]?.[0] || "file"));
  return tile;
}

/** A short name for the kind, for people: "Image", "Archive", "PDF document". */
export const KIND_NAMES = {
  folder: "Folder", link: "Link", file: "File", image: "Image", video: "Video", audio: "Audio", archive: "Archive", apk: "Android app",
  pdf: "Document", doc: "Document", sheet: "Spreadsheet", slides: "Presentation", code: "Code", data: "Settings file", text: "Text",
  script: "Script", font: "Font", db: "Database", secure: "Key or certificate", system: "System file",
};
