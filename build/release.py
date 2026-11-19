#!/usr/bin/env python3
"""Build, sign and verify the Andromon installers. It asks its questions in the terminal:

  python3 build/release.py

A full build does these steps in order:
  1. pulls the newest code from GitHub (git pull --ff-only)
  2. asks which systems (macOS, Windows, Linux) and which CPU types (arm64, x64) to build for
  3. builds the installers with electron-builder and collects them in a folder (build/, next to this script)
  4. writes SHA256SUMS.txt, makes the release key when there is none yet, and signs the checksums
     (SHA256SUMS.txt.sig)
  5. checks every installer, the checksums and the signature

The menu also offers to only check or only sign a folder of installers.

The release signature is Ed25519, made with the private key in ~/.andromon/release-signing-key.pem.
The public half is build/release-signing-key.pub.pem, in the repository, so anyone can check a download:

  openssl base64 -d -A -in SHA256SUMS.txt.sig -out sums.sig
  openssl pkeyutl -verify -pubin -inkey release-signing-key.pub.pem -rawin -in SHA256SUMS.txt -sigfile sums.sig

This signature is not the system's code signing (Apple Developer ID and notarization, Windows
Authenticode). electron-builder does that during the build when CSC_LINK and CSC_KEY_PASSWORD are set
(plus APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID for notarization). The check reports which
kind each installer has.

Needs Python 3.9+, git, Node with npm, and OpenSSL 3.
"""
import base64
import datetime
import hashlib
import io
import json
import os
import platform
import plistlib
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
DEFAULT_OUT = ROOT / "build"  # the installers sit beside the build resources; .gitignore keeps them out of git
SUMS = "SHA256SUMS.txt"
SIG = SUMS + ".sig"
PUBLIC_KEY = Path(os.environ.get("ANDROMON_PUBLIC_KEY") or os.environ.get("DROID_DESK_PUBLIC_KEY")
                  or Path(__file__).resolve().parent / "release-signing-key.pub.pem")


def _private_key_path():
    """~/.andromon, or ~/.droid-desk where the key was made before the app was renamed from Droid Desk."""
    new = Path.home() / ".andromon" / "release-signing-key.pem"
    old = Path.home() / ".droid-desk" / "release-signing-key.pem"
    return old if old.exists() and not new.exists() else new


PRIVATE_KEY = Path(os.environ.get("ANDROMON_SIGNING_KEY") or os.environ.get("DROID_DESK_SIGNING_KEY") or _private_key_path())
KINDS = {".dmg": "mac", ".exe": "windows", ".appimage": "linux", ".deb": "linux"}
HOST = {"Darwin": "mac", "Windows": "win", "Linux": "linux"}.get(platform.system(), "")


class Problem(Exception):
    """Something the person has to fix; shown without a traceback."""


def say(text=""):
    print(text, flush=True)


def run(cmd, **kw):
    """Run a command that shows its own output; stop when it fails."""
    say(f"$ {' '.join(str(c) for c in cmd)}")
    if subprocess.run(cmd, **kw).returncode:
        raise Problem(f"{Path(str(cmd[0])).name} failed")


def quiet(cmd):
    """Run a command and return (exit code, its output and errors as one text)."""
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    return p.returncode, p.stdout.strip()


def package():
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


def installers(folder):
    return sorted((p for p in Path(folder).iterdir() if p.is_file() and p.suffix.lower() in KINDS), key=lambda p: p.name)


def arch_of(name):
    n = name.lower()
    return "arm64" if "arm64" in n or "aarch64" in n else "x64" if any(a in n for a in ("x64", "x86_64", "amd64")) else ""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


# ---------- SHA256SUMS.txt ----------

def write_sums(folder):
    files = installers(folder)
    if not files:
        raise Problem(f"No installers in {folder}")
    lines = [f"{sha256(p)}  {p.name}" for p in files]
    # Bytes, so the file (and its signature) is the same on Windows.
    (Path(folder) / SUMS).write_bytes(("\n".join(lines) + "\n").encode())
    for line in lines:
        say(f"  {line}")
    stale = Path(folder) / SIG
    if stale.exists():
        stale.unlink()
        say(f"Removed {SIG}: it signed the previous checksums.")
    return files


def read_sums(folder):
    """{file name: sha256} from SHA256SUMS.txt, or None when the folder has none."""
    path = Path(folder) / SUMS
    if not path.exists():
        return None
    sums = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            digest, _, name = line.partition(" ")
            sums[name.strip().lstrip("*")] = digest.lower()
    return sums


def check_sums(folder):
    """Compare the folder with its SHA256SUMS.txt. Returns (problems, checked file names)."""
    sums = read_sums(folder)
    if sums is None:
        return [f"{SUMS} is missing"], []
    present = {p.name: p for p in installers(folder)}
    problems = [f"{n}: listed in {SUMS} but not in the folder" for n in sums if n not in present]
    problems += [f"{n}: not listed in {SUMS}" for n in present if n not in sums]
    good = []
    for name in sorted(set(sums) & set(present)):
        if sha256(present[name]) == sums[name]:
            good.append(name)
        else:
            problems.append(f"{name}: SHA-256 differs from {SUMS}")
    return problems, good


# ---------- the release signature (Ed25519, through OpenSSL) ----------

def openssl():
    """An OpenSSL 3 program. The one that comes with macOS is LibreSSL, which can't sign a file with Ed25519."""
    places = [os.environ.get("OPENSSL"), "/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl",
              shutil.which("openssl"), r"C:\Program Files\Git\usr\bin\openssl.exe", r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe"]
    for exe in places:
        if exe and Path(exe).exists():
            code, out = quiet([exe, "version"])
            if code == 0 and out.startswith("OpenSSL") and int(out.split()[1].split(".")[0]) >= 3:
                return exe
    raise Problem("OpenSSL 3 not found. Install it (macOS: brew install openssl, Windows: comes with Git for Windows) "
                  "or set OPENSSL to its path.")


def signature_state(folder, pubkey):
    """("ok" | "bad" | "none" | "nokey", text) for the folder's SHA256SUMS.txt.sig."""
    sig = Path(folder) / SIG
    if not sig.exists():
        return "none", f"{SIG} is missing: the checksums are not signed"
    if not Path(pubkey).exists():
        return "nokey", f"{SIG} can't be checked: no public key at {pubkey}"
    try:
        raw = base64.b64decode(sig.read_text(encoding="ascii").strip(), validate=True)
    except ValueError:
        return "bad", f"{SIG} is not base64"
    with tempfile.TemporaryDirectory() as tmp:
        raw_file = Path(tmp) / "sig"
        raw_file.write_bytes(raw)
        code, out = quiet([openssl(), "pkeyutl", "-verify", "-pubin", "-inkey", str(pubkey), "-rawin",
                           "-in", str(Path(folder) / SUMS), "-sigfile", str(raw_file)])
    if code == 0:
        return "ok", f"{SIG} matches {SUMS} and the public key {Path(pubkey).name}"
    return "bad", f"{SIG} does NOT match {SUMS} and the public key {Path(pubkey).name}"


def cmd_keygen(args):
    key, pub = Path(args.key), Path(args.pubkey)
    for path in (key, pub):
        if path.exists():
            raise Problem(f"{path} already exists. Builds signed with it stop verifying if it is replaced; "
                          "move it away yourself if that is what you want.")
    exe = openssl()
    key.parent.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        key.parent.chmod(0o700)
    # --encrypt: OpenSSL asks for a passphrase now and at every "sign".
    run([exe, "genpkey", "-algorithm", "ed25519", "-out", str(key)] + (["-aes-256-cbc"] if args.encrypt else []))
    if os.name != "nt":
        key.chmod(0o600)
    pub.parent.mkdir(parents=True, exist_ok=True)
    run([exe, "pkey", "-in", str(key), "-pubout", "-out", str(pub)])
    say(f"\nPrivate key: {key}\n  Keep it secret and keep a copy somewhere safe. It is not in the repository.")
    say(f"Public key:  {pub}\n  Commit this file; the check and other people verify signatures with it.")


def cmd_sign(args):
    folder, key = Path(args.folder), Path(args.key)
    if not key.exists():
        cmd_keygen(args)
    problems, good = check_sums(folder)
    if problems:
        raise Problem("Not signing, the folder and its checksums disagree:\n  " + "\n  ".join(problems)
                      + "\nIf the folder is right, choose \"Sign a folder\" in the menu and let it rewrite the checksums.")
    if not good:
        raise Problem(f"{SUMS} in {folder} lists no installers")
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "sig"
        run([openssl(), "pkeyutl", "-sign", "-inkey", str(key), "-rawin", "-in", str(folder / SUMS), "-out", str(raw)])
        (folder / SIG).write_bytes(base64.b64encode(raw.read_bytes()) + b"\n")
    say(f"Signed {len(good)} installer(s): {folder / SIG}")
    state, text = signature_state(folder, args.pubkey)
    if state != "ok":
        raise Problem(f"{text}\nThe private key and {args.pubkey} are not a pair.")
    say(text)


# ---------- build ----------

def cmd_build(args):
    npm = shutil.which("npm")
    if not npm:
        raise Problem("npm not found. Install Node.js 22 or newer.")
    targets = args.platform or [HOST]
    if not all(targets):
        raise Problem("Unknown system; say which with --platform.")
    if "mac" in targets and HOST != "mac":
        raise Problem("The macOS build only works on a Mac.")
    pkg = package()
    if not (ROOT / "node_modules" / ".bin").exists():
        run([npm, "ci"], cwd=ROOT)

    code, commit = quiet(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    commit = os.environ.get("GITHUB_SHA") or (commit if code == 0 else "")
    if quiet(["git", "-C", str(ROOT), "status", "--porcelain"])[1]:
        say("Note: the working tree has uncommitted changes; the build includes them, the stamped commit does not.")
    number = args.build_number if args.build_number is not None else int(os.environ.get("GITHUB_RUN_NUMBER") or 0)

    env = dict(os.environ)
    extra = []
    if not (args.codesign or env.get("CSC_LINK") or env.get("CSC_NAME")):
        env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"  # no certificate: don't search the keychain for one
        say("No code-signing certificate given (CSC_LINK is not set): the installers will not be code-signed.")
        if "mac" in targets:
            # Left unsigned, the app keeps Electron's signature, which no longer fits the changed bundle:
            # macOS then calls a downloaded copy "damaged". An ad-hoc signature ("-") seals it properly.
            # The hardened runtime is for notarization; with an ad-hoc signature it can stop the app starting.
            extra = ["-c.mac.identity=-", "-c.mac.hardenedRuntime=false"]

    # The app's update check reads this file; put back what was there so the working tree stays clean.
    info = ROOT / "build-info.json"
    before = info.read_bytes() if info.exists() else None
    stamp = {"build": number, "commit": commit, "date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    started = time.time() - 2
    try:
        info.write_text(json.dumps(stamp) + "\n", encoding="utf-8")
        run([npm, "run", "build:renderer"], cwd=ROOT, env=env)
        flags = []
        for t in targets:
            flags.append(f"--{t}")
            if args.arch:
                # package.json names the CPU types per target, which wins over --x64/--arm64; "dmg:arm64" overrides it.
                kinds = [k["target"] if isinstance(k, dict) else k for k in pkg["build"].get(t, {}).get("target", [])]
                flags += [f"{k}:{a}" for k in kinds for a in args.arch]
        run([npm, "exec", "--", "electron-builder", *flags, *extra, "--publish", "never"], cwd=ROOT, env=env)
    finally:
        if before is None:
            info.unlink(missing_ok=True)
        else:
            info.write_bytes(before)

    made = [p for p in installers(DIST) if p.stat().st_mtime >= started]
    if not made:
        raise Problem(f"electron-builder finished but left no new installer in {DIST}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for p in made:
        shutil.copy2(p, out / p.name)
    say(f"\nv{pkg['version']} build {number}, commit {commit[:7] or 'unknown'}: {len(made)} installer(s) in {out}")
    write_sums(out)
    return out


# ---------- verify ----------

class Report:
    def __init__(self):
        self.failed = 0
        self.warned = 0

    def ok(self, text):
        say(f"  ok    {text}")

    def warn(self, text):
        self.warned += 1
        say(f"  warn  {text}")

    def fail(self, text):
        self.failed += 1
        say(f"  FAIL  {text}")


def asar_json(asar, name):
    """A JSON file from the top level of an app.asar, or None."""
    with open(asar, "rb") as f:
        _, header_size, _, json_len = struct.unpack("<4I", f.read(16))
        entry = json.loads(f.read(json_len))["files"].get(name)
        if not entry or "offset" not in entry:
            return None
        f.seek(8 + header_size + int(entry["offset"]))
        return json.loads(f.read(entry["size"]))


def macho_archs(path):
    with open(path, "rb") as f:
        head = f.read(8)
    names = {0x0100000C: "arm64", 0x01000007: "x64"}
    if head[:4] == b"\xcf\xfa\xed\xfe":
        return [names.get(struct.unpack("<I", head[4:])[0], "?")]
    return ["arm64", "x64"] if head[:4] == b"\xca\xfe\xba\xbe" else []


def check_app(app, r, want, arch, require_codesign):
    """A macOS .app or the resources of any Electron build: version, commit, CPU type, code signature."""
    info = plistlib.loads((app / "Contents" / "Info.plist").read_bytes())
    for key, expected in (("CFBundleShortVersionString", want["version"]), ("CFBundleIdentifier", want["appId"])):
        (r.ok if info.get(key) == expected else r.fail)(f"{key} is {info.get(key)!r}" + ("" if info.get(key) == expected else f", expected {expected!r}"))
    archs = macho_archs(app / "Contents" / "MacOS" / info["CFBundleExecutable"])
    (r.ok if not arch or arch in archs else r.fail)(f"the program is built for {', '.join(archs) or 'an unknown CPU'}")

    asar = app / "Contents" / "Resources" / "app.asar"
    if not asar.exists():
        r.fail("app.asar is missing from the app")
    else:
        inner = asar_json(asar, "package.json") or {}
        (r.ok if inner.get("version") == want["version"] else r.fail)(f"packaged package.json says version {inner.get('version')}")
        stamp = asar_json(asar, "build-info.json") or {}
        commit = stamp.get("commit") or ""
        text = f"stamped build {stamp.get('build')}, commit {commit[:7] or 'none'}, {stamp.get('date') or 'no date'}"
        if want["commit"] and commit and commit != want["commit"]:
            r.fail(f"{text}; expected commit {want['commit'][:7]}")
        elif not commit:
            r.warn(text)
        else:
            r.ok(text)

    code, details = quiet(["codesign", "-dv", "--verbose=2", str(app)])
    if code:
        (r.fail if require_codesign else r.warn)("not code-signed at all (macOS on Apple Silicon refuses to start it)")
        return
    code, out = quiet(["codesign", "--verify", "--deep", "--strict", str(app)])
    if code:
        r.fail(f"the code signature is broken: {out.splitlines()[-1] if out else 'codesign failed'}")
    elif "Signature=adhoc" in details:
        (r.fail if require_codesign else r.warn)("ad-hoc code signature only (no Developer ID): Gatekeeper warns on other people's Macs")
    else:
        who = next((l.split("=", 1)[1] for l in details.splitlines() if l.startswith("Authority=")), "unknown")
        r.ok(f"code-signed by {who}")


def check_exe(path, r, require_codesign):
    with open(path, "rb") as f:
        head = f.read(4096)
    pe = struct.unpack_from("<I", head, 0x3C)[0] if head[:2] == b"MZ" else -1
    if pe < 0 or head[pe:pe + 4] != b"PE\0\0":
        r.fail("not a Windows program (no PE header)")
        return
    r.ok("Windows program (the setup wizard itself is 32-bit and holds the app for the CPU in its name)")
    optional = pe + 24
    magic = struct.unpack_from("<H", head, optional)[0]
    # Data directory 4 is the certificate table: where an Authenticode signature lives.
    _, size = struct.unpack_from("<II", head, optional + (96 if magic == 0x10B else 112) + 4 * 8)
    if size:
        r.ok("has an Authenticode signature (Windows or signtool checks whose)")
    else:
        (r.fail if require_codesign else r.warn)("no Authenticode signature: SmartScreen warns")


def check_appimage(path, r, arch):
    with open(path, "rb") as f:
        head = f.read(20)
    if head[:4] != b"\x7fELF" or head[8:10] != b"AI":
        r.fail("not an AppImage (ELF or AppImage mark missing)")
    else:
        machine = struct.unpack_from("<H", head, 18)[0]
        built = {0x3E: "x64", 0xB7: "arm64"}.get(machine, hex(machine))
        (r.ok if built == (arch or "x64") else r.fail)(f"AppImage for {built}")


def check_deb(path, r, want):
    with open(path, "rb") as f:
        if f.read(8) != b"!<arch>\n":
            r.fail("not a .deb (no ar header)")
            return
        control = None
        while len(header := f.read(60)) == 60:
            name, size = header[:16].decode().strip().rstrip("/"), int(header[48:58])
            if name.startswith("control.tar"):
                control = f.read(size)
                break
            f.seek(size + size % 2, os.SEEK_CUR)
    if control is None:
        r.fail("the .deb has no control archive")
        return
    try:
        with tarfile.open(fileobj=io.BytesIO(control), mode="r:*") as tar:
            text = tar.extractfile(next(m for m in tar if m.name.lstrip("./") == "control")).read().decode()
    except (tarfile.TarError, StopIteration, OSError) as e:
        r.warn(f"can't read the package description here ({e}); format looks right")
        return
    fields = dict(l.split(": ", 1) for l in text.splitlines() if ": " in l and not l.startswith(" "))
    good = fields.get("Version", "").split("-")[0] == want["version"]
    (r.ok if good else r.fail)(f"package {fields.get('Package')} {fields.get('Version')} for {fields.get('Architecture')}")


def mounted_app_check(path, r, want, arch, require_codesign):
    proc = subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-plist", str(path)], capture_output=True)
    if proc.returncode:
        r.fail("the disk image can't be opened")
        return
    mounts = [e["mount-point"] for e in plistlib.loads(proc.stdout).get("system-entities", []) if "mount-point" in e]
    try:
        apps = [a for m in mounts for a in Path(m).glob("*.app")]
        if len(apps) != 1:
            r.fail(f"expected one app in the disk image, found {len(apps)}")
        else:
            check_app(apps[0], r, want, arch, require_codesign)
    finally:
        for m in mounts:
            if quiet(["hdiutil", "detach", m, "-quiet"])[0]:
                quiet(["hdiutil", "detach", m, "-force", "-quiet"])
    code, _ = quiet(["xcrun", "stapler", "validate", str(path)])
    if code == 0:
        r.ok("notarized by Apple (ticket stapled)")
    else:
        (r.fail if require_codesign else r.warn)("not notarized: macOS says it \"can't be opened\" until the person allows it")


def cmd_verify(args):
    folder = Path(args.folder)
    if not folder.is_dir():
        raise Problem(f"{folder} is not a folder")
    files = installers(folder)
    if not files:
        raise Problem(f"No installers in {folder}")
    pkg = package()
    want = {"version": pkg["version"], "appId": pkg["build"]["appId"], "commit": args.commit or ""}
    r = Report()

    say(f"Checksums ({folder / SUMS})")
    problems, good = check_sums(folder)
    for name in good:
        r.ok(f"{name}: SHA-256 matches")
    for p in problems:
        r.fail(p)

    say("Release signature")
    state, text = signature_state(folder, args.pubkey) if (folder / SUMS).exists() else ("none", "nothing to sign yet")
    if state == "ok":
        r.ok(text)
    elif state == "bad" or args.require_signature:
        r.fail(text)
    else:
        r.warn(text)

    for path in files:
        say(f"{path.name}  ({path.stat().st_size / 1e6:.1f} MB)")
        kind, arch = path.suffix.lower(), arch_of(path.name)
        (r.ok if want["version"] in path.name else r.fail)(f"file name carries version {want['version']}")
        if path.stat().st_size < 20e6:
            r.fail("smaller than 20 MB: an Electron installer can't be that small")
        try:
            if kind == ".dmg" and HOST == "mac":
                code, out = quiet(["hdiutil", "verify", "-quiet", str(path)])
                if code:
                    r.fail(f"hdiutil says the disk image is damaged: {out[-200:]}")
                else:
                    r.ok("disk image checksum is valid")
                    mounted_app_check(path, r, want, arch, args.require_codesign)
            elif kind == ".dmg":
                with open(path, "rb") as f:
                    f.seek(-512, os.SEEK_END)
                    (r.ok if f.read(4) == b"koly" else r.fail)("disk image trailer (run verify on a Mac for the full check)")
            elif kind == ".exe":
                check_exe(path, r, args.require_codesign)
            elif kind == ".appimage":
                check_appimage(path, r, arch)
            elif kind == ".deb":
                check_deb(path, r, want)
        except (OSError, ValueError, KeyError, struct.error) as e:
            r.fail(f"can't be read as a {kind} file: {e!r}")

    say()
    if r.failed:
        raise Problem(f"{r.failed} check(s) failed, {r.warned} warning(s)")
    say(f"All checks passed for {len(files)} installer(s)" + (f", {r.warned} warning(s)." if r.warned else "."))


# ---------- pull the newest code ----------

def pull_code():
    """Fast-forward the current branch to GitHub's. Local commits and uncommitted work are never rewritten."""
    git = ["git", "-C", str(ROOT)]
    code, branch = quiet(git + ["rev-parse", "--abbrev-ref", "HEAD"])
    if code:
        raise Problem(f"{ROOT} is not a git repository")
    code, upstream = quiet(git + ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    if code:
        say(f"Branch {branch} follows no branch on GitHub: nothing to pull.")
        return
    before = quiet(git + ["rev-parse", "HEAD"])[1]
    say(f"$ git pull --ff-only   ({branch} <- {upstream})")
    code, out = quiet(git + ["pull", "--ff-only"])
    if code:
        say(out)
        if not ask_yes("The pull failed. Build the code that is on this computer anyway?", False):
            raise Problem("Stopped: the code could not be pulled")
        return
    after = quiet(git + ["rev-parse", "HEAD"])[1]
    if after == before:
        say(f"Already up to date ({after[:7]}).")
    else:
        say(quiet(git + ["log", "--oneline", f"{before}..{after}"])[1])
        say(f"Updated {before[:7]} -> {after[:7]}.")
        if Path(__file__).resolve() in [ROOT / n for n in quiet(git + ["diff", "--name-only", before, after])[1].splitlines()]:
            raise Problem("The pull changed this script itself. Start it again to use the new one.")


# ---------- questions in the terminal ----------

def ask(question, default=""):
    try:
        answer = input(f"{question}{f' [{default}]' if default else ''}: ").strip()
    except EOFError:
        raise Problem("No answer: this script asks its questions in a terminal") from None
    return answer or default


def ask_yes(question, default=True):
    while True:
        answer = ask(f"{question} ({'Y/n' if default else 'y/N'})").lower()
        if not answer:
            return default
        if answer in ("y", "yes", "n", "no"):
            return answer.startswith("y")
        say("  Answer y or n.")


def ask_choice(question, options, default, many=False):
    """Show a numbered list of (value, label) and return the chosen value, or the chosen values with many=True."""
    say(f"\n{question}")
    for i, (_, label) in enumerate(options, 1):
        say(f"  {i}) {label}")
    hint = "numbers, separated by commas" if many else "number"
    while True:
        answer = ask(f"Your choice ({hint})", default)
        try:
            picked = [options[int(n) - 1][0] for n in answer.replace(" ", ",").split(",") if n and int(n) > 0]
        except (ValueError, IndexError):
            picked = []
        if picked and (many or len(picked) == 1):
            return list(dict.fromkeys(picked)) if many else picked[0]
        say(f"  Type {'one or more of' if many else 'one of'} the numbers 1 to {len(options)}.")


def ask_folder(question, must_exist):
    while True:
        folder = Path(ask(question, str(DEFAULT_OUT))).expanduser().resolve()
        if folder.is_dir() or not must_exist:
            return folder
        say(f"  {folder} is not a folder.")


def options(**values):
    base = dict(key=str(PRIVATE_KEY), pubkey=str(PUBLIC_KEY), encrypt=False, commit="", require_signature=False,
                require_codesign=False, codesign=False, build_number=None, platform=None, arch=None)
    return types.SimpleNamespace(**{**base, **values})


def full_build():
    say("\nStep 1: the newest code")
    if ask_yes("Pull the newest code from GitHub first?"):
        pull_code()

    say("\nStep 2: what to build")
    systems = [("mac", "macOS (.dmg)"), ("win", "Windows (setup .exe)"), ("linux", "Linux (.AppImage and .deb)")]
    if HOST != "mac":
        systems = systems[1:]  # a macOS build only works on a Mac
        say("macOS is not offered: its build only works on a Mac.")
    here = next((str(i) for i, (value, _) in enumerate(systems, 1) if value == HOST), "1")
    targets = ask_choice("Which systems?", systems, here, many=True)
    this_cpu = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    cpus = [(["arm64"], "arm64 (Apple Silicon, Windows and Linux on ARM)"), (["x64"], "x64 (Intel and AMD)"), (["arm64", "x64"], "both")]
    arch = ask_choice("Which CPU types?", cpus, "3")
    say()
    out = ask_folder("Folder for the installers", must_exist=False)
    number = ask("Build number (0 for a build made by hand)", os.environ.get("GITHUB_RUN_NUMBER") or "0")
    if not number.isdigit():
        raise Problem(f"The build number must be a whole number, not {number!r}")

    names = dict(systems)
    say(f"\nAbout to build: {', '.join(names[t] for t in targets)}; CPU: {' and '.join(arch)}; into {out}")
    if "linux" in targets and "arm64" in arch and HOST != "linux" and this_cpu != "arm64":
        say("Note: building Linux arm64 on another kind of computer can be slow or fail.")
    if not ask_yes("Start?"):
        raise Problem("Stopped before building")

    say("\nStep 3: build")
    args = options(platform=targets, arch=arch, out=str(out), build_number=int(number), folder=str(out))
    cmd_build(args)

    say("\nStep 4: signing files")
    cmd_sign(args)  # makes the release key first when there is none

    say("\nStep 5: check")
    args.require_signature = True
    if not quiet(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"])[1]:
        args.commit = quiet(["git", "-C", str(ROOT), "rev-parse", "HEAD"])[1]
    cmd_verify(args)
    say(f"\nDone. The distribution packages are in {out}")


def main():
    say(f"Andromon {package()['version']}: build, sign and check the installers")
    try:
        todo = ask_choice("What do you want to do?", [
            ("build", "Full build: pull the code, build, sign, check"),
            ("verify", "Check a folder of installers"),
            ("sign", "Sign a folder of installers"),
        ], "1")
        if todo == "build":
            full_build()
        elif todo == "verify":
            say()
            args = options(folder=str(ask_folder("Folder with the installers", must_exist=True)))
            args.require_signature = ask_yes("Fail when the release signature is missing?", False)
            args.require_codesign = ask_yes("Fail when an installer is not code-signed (and notarized, on macOS)?", False)
            cmd_verify(args)
        else:
            say()
            args = options(folder=str(ask_folder("Folder with the installers", must_exist=True)))
            if check_sums(args.folder)[0] and ask_yes(f"{SUMS} is missing or doesn't match the folder. Rewrite it from the files there?"):
                write_sums(args.folder)
            cmd_sign(args)
    except Problem as e:
        sys.exit(f"\nError: {e}")
    except KeyboardInterrupt:
        sys.exit("\nStopped.")


if __name__ == "__main__":
    main()
