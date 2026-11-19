# How the build scripts work

This page explains every script that turns the Andromon source into installers, and how they fit together. The README's [Build installers](../README.md#build-installers) section is the short version.

## Contents

1. [The scripts at a glance](#1-the-scripts-at-a-glance)
2. [What a build is made of](#2-what-a-build-is-made-of)
3. [`build/release.py`: pull, build, sign, check](#3-buildreleasepy-pull-build-sign-check)
4. [The two kinds of signing](#4-the-two-kinds-of-signing)
5. [Automatic builds on GitHub](#5-automatic-builds-on-github)
6. [`scripts/release-manifest.js`](#6-scriptsrelease-manifestjs)
7. [The helper builds](#7-the-helper-builds)
8. [Common tasks](#8-common-tasks)
9. [When something fails](#9-when-something-fails)

## 1. The scripts at a glance

| Script | Run with | What it does |
|---|---|---|
| `npm run build:renderer` | npm | Bundles `src/app.js` into `renderer/app.js` with esbuild. Every other build starts with this. |
| `npm run dist:mac` / `dist:win` / `dist:linux` | npm | Bundles the page, then runs electron-builder for one system. Installers land in `dist/`. |
| `build/release.py` | `python3` | Asks what to build, pulls the newest code, does the same build, then collects the installers, signs them and checks them. |
| `scripts/release-manifest.js` | `node` (the release workflows) | Writes `latest.json`, `CHANGELOG.md` and the release notes after a build on GitHub. |
| `npm run build:companion` | npm | Rebuilds the phone app in `../android` and copies its APK to `renderer/companion.apk`. |
| `npm run build:uihelper` | npm | Rebuilds `renderer/ui-helper.jar` from `uihelper/src`. |

There are two ways to make installers:

- **On your computer**, with `build/release.py` (or the plain `npm run dist:*` commands). The result goes to `build/` (the installers are kept out of git by `.gitignore`).
- **On GitHub**, by raising `version` in `package.json` and pushing to the `release` branch. `Andromon_Releases` builds and publishes it within the hour.

The two don't depend on each other. The GitHub workflow does not use `release.py`.

## 2. What a build is made of

A build has three steps, whichever script starts it.

1. **Bundle the page.** esbuild turns `src/app.js` and everything it imports into one file, `renderer/app.js` (plus a source map that is left out of the installers).
2. **Stamp the build.** `build-info.json` is filled in with the build number, the commit and the date. The app's update check reads this file to know which build it is. In the repository the file holds zeros; a build made on a developer's computer has build number 0.
3. **Package.** electron-builder reads the `build` section of `package.json`, copies the files listed under `files` into `app.asar`, adds Electron, and makes the installers:

| System | Installer | CPU types | File name |
|---|---|---|---|
| macOS | `.dmg` | arm64, x64 | `Andromon-0.1.0-arm64.dmg` |
| Windows | setup wizard `.exe` (NSIS) | x64, arm64 | `Andromon-Setup-0.1.0-x64.exe` |
| Linux | `.AppImage` and `.deb` | x64 | `Andromon-0.1.0-x86_64.AppImage`, `Andromon-0.1.0-amd64.deb` |

The version in the file names comes from `version` in `package.json`. A new source file in the main process has to be added to `build.files` in `package.json`, or the installed app won't have it.

## 3. `build/release.py`: pull, build, sign, check

One Python file with no packages to install. It needs Python 3.9 or newer, git, Node with npm, and OpenSSL 3. It takes no arguments: it asks its questions in the terminal. It sits in `build/` next to the installers' pictures; electron-builder doesn't put it in the app.

```sh
python3 build/release.py
```

It works from any folder, as long as the path to the file is right (`python3 pc/build/release.py` from the folder above, `./release.py` inside `build/`).

### The questions

Pressing Enter takes the answer in square brackets.

```
Andromon 0.1.0: build, sign and check the installers

What do you want to do?
  1) Full build: pull the code, build, sign, check
  2) Check a folder of installers
  3) Sign a folder of installers
Your choice (number) [1]:

Step 1: the newest code
Pull the newest code from GitHub first? (Y/n):

Step 2: what to build

Which systems?
  1) macOS (.dmg)
  2) Windows (setup .exe)
  3) Linux (.AppImage and .deb)
Your choice (numbers, separated by commas) [1]: 1,2

Which CPU types?
  1) arm64 (Apple Silicon, Windows and Linux on ARM)
  2) x64 (Intel and AMD)
  3) both
Your choice (number) [3]:

Folder for the installers [/Users/you/androidTools/builds]:
Build number (0 for a build made by hand) [0]:

About to build: macOS (.dmg), Windows (setup .exe); CPU: arm64 and x64; into /Users/you/androidTools/builds
Start? (Y/n):
```

| Question | Notes |
|---|---|
| Which systems? | One or more numbers, like `1,3`. The default is the system you are on. macOS is only offered on a Mac, because its build only works there; Windows and Linux installers can be built on a Mac. |
| Which CPU types? | One CPU type or both, for every system chosen. This replaces the CPU types in `package.json`, so Linux can be built for arm64 too. |
| Folder for the installers | Default `build/`, the folder that also holds `release.py` and the installer pictures; `.gitignore` keeps the installers out of git. Installers with the same name are replaced. |
| Build number | Stamped into the app for its update check. Leave it at 0 for a build made by hand. |

After a full build the folder holds:

```
build/
  Andromon-1.0.4-arm64.dmg
  Andromon-1.0.4-x64.dmg
  Andromon-Setup-1.0.4-arm64.exe
  Andromon-Setup-1.0.4-x64.exe
  SHA256SUMS.txt        one line per installer: its SHA-256 and its name
  SHA256SUMS.txt.sig    the release signature of SHA256SUMS.txt
```

### Step 1: pull the newest code

Runs `git pull --ff-only` on the current branch and lists the commits that came in. `--ff-only` only moves the branch forward: it never rewrites commits you made here and never touches uncommitted work. When the pull can't be done (no network, your branch and GitHub's have gone different ways, or a pulled file has uncommitted changes) the script shows git's message and asks whether to build the code that is on this computer anyway. When the pull changed `build/release.py` itself, the script stops and asks to be started again.

### Step 3: build

| | What happens |
|---|---|
| 1 | Checks that npm exists, and runs `npm ci` when `node_modules` is missing. |
| 2 | Reads the current commit from git. Says so when the working tree has uncommitted changes: the build includes them, the stamped commit does not. |
| 3 | Decides on code signing (see [section 4](#4-the-two-kinds-of-signing)). |
| 4 | Writes the build number, commit and date into `build-info.json`. |
| 5 | Runs `npm run build:renderer`, then electron-builder with `--publish never`. |
| 6 | Puts `build-info.json` back as it was, also when the build failed, so the working tree stays clean. |
| 7 | Copies the installers that this run made from `dist/` to the folder. Older files in `dist/` are left alone. |
| 8 | Writes `SHA256SUMS.txt` for every installer in the folder. |

The CPU types are passed to electron-builder as `dmg:arm64`, `nsis:arm64` and so on. The plain `--arm64` flag would be ignored, because `package.json` names the CPU types for each target and that wins.

### Step 4: signing files

All automatic:

1. **The release key**, the first time only. An Ed25519 key pair is made: the private key in `~/.andromon/release-signing-key.pem` (a key made before the app was renamed, in `~/.droid-desk/`, is still found and used there), readable only by you, and the public key in `build/release-signing-key.pub.pem`, which you commit. An existing key is never replaced.
2. **`SHA256SUMS.txt.sig`**: the folder is compared with `SHA256SUMS.txt` (the script stops when they disagree), the checksums are signed with the private key, and the signature is checked against the public key straight away.

Keep a copy of the private key somewhere safe: without it, later builds can't be signed with the same key. Its place can be changed with the `ANDROMON_SIGNING_KEY` environment variable, the public key's with `ANDROMON_PUBLIC_KEY`. OpenSSL is looked for in Homebrew's folders, on the `PATH`, and in Git for Windows; set `OPENSSL` to its path when it lives elsewhere. The OpenSSL that comes with macOS is LibreSSL and can't do this: `brew install openssl`.

### Step 5: check

Prints one line per check: `ok`, `warn` or `FAIL`. The script ends with exit code 1 when anything failed.

| Check | Applies to | Fails when |
|---|---|---|
| Checksums | every installer | `SHA256SUMS.txt` is missing, a file's SHA-256 differs, a listed file is absent, or an installer is not listed |
| Release signature | `SHA256SUMS.txt` | `SHA256SUMS.txt.sig` is missing, or does not match the checksums and the public key |
| File name | every installer | the name doesn't carry the version from `package.json` |
| Size | every installer | smaller than 20 MB |
| Disk image | `.dmg` | `hdiutil verify` reports damage, or the image holds no app or more than one |
| App details | `.dmg` | the version or the app id in `Info.plist` is wrong, the program is built for another CPU type than the file name says, `app.asar` is missing, or the packaged `package.json` has another version |
| Stamped commit | `.dmg` | the working tree was clean and the packaged `build-info.json` names another commit than the one built. No stamp at all is a warning |
| Code signature | `.dmg` | the signature is broken. Ad-hoc only, or not notarized, is a warning |
| Program header | `.exe` | the file is not a Windows program. No Authenticode signature is a warning |
| AppImage header | `.AppImage` | the ELF or AppImage mark is missing, or the CPU type differs from the file name |
| Package description | `.deb` | the file is not a `.deb`, or its version differs from `package.json` |

The `.dmg` checks open the disk image (read-only, without showing it in Finder) and close it again. They only run on a Mac; elsewhere a `.dmg` gets a header check. The app inside the `.exe`, `.AppImage` and `.deb` files is not opened, so the stamped commit is only checked for macOS.

### The other two menu entries

- **Check a folder of installers** runs step 5 on any folder, for example one downloaded from GitHub. It asks two more questions: whether a missing release signature is a failure (otherwise a warning), and whether a missing code signature or notarization is a failure.
- **Sign a folder of installers** runs step 4 on any folder. When `SHA256SUMS.txt` is missing or doesn't match the files, it offers to rewrite it first. Use it after copying installers from several computers into one folder.

## 4. The two kinds of signing

They answer different questions, and one doesn't replace the other.

| | Release signature | Code signing |
|---|---|---|
| What it proves | These files are the ones the key's owner built | The system's maker knows who published the app |
| Made by | `build/release.py`, step 4 | electron-builder, during the build |
| Needs | The free key the script makes | Apple Developer ID and notarization; a Windows code-signing certificate |
| Checked by | Anyone, with OpenSSL and the public key | macOS Gatekeeper, Windows SmartScreen |
| Removes the system's warnings | No | Yes |

**Checking a release signature by hand:**

```sh
openssl base64 -d -A -in SHA256SUMS.txt.sig -out sums.sig
openssl pkeyutl -verify -pubin -inkey release-signing-key.pub.pem -rawin -in SHA256SUMS.txt -sigfile sums.sig
shasum -a 256 -c SHA256SUMS.txt
```

The first two lines show that `SHA256SUMS.txt` is untouched; the third shows that the installers match it.

**Code signing during the build:**

| Situation | What the build does |
|---|---|
| `CSC_LINK` (and `CSC_KEY_PASSWORD`) set | electron-builder signs with that certificate. With `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` it also notarizes the macOS app. |
| Neither | Windows and Linux installers are unsigned. The macOS app gets an ad-hoc signature. |

The ad-hoc signature matters. Left completely unsigned, the macOS app keeps the signature Electron shipped with, which no longer fits the changed app, and macOS calls a downloaded copy "damaged". An ad-hoc signature fits the app, so macOS shows the milder "can't be opened" message that right-click › Open gets past.

The app's own update check does not read the release signature. It checks the downloaded installer against the SHA-256 in `latest.json`.

## 5. Automatic builds on GitHub

Releases are built and published by GitHub Actions in their own repository, [Deshan555/Andromon_Releases](https://github.com/Deshan555/Andromon_Releases), from the `release` branches of this repository and of [Andromon-android](https://github.com/Deshan555/Andromon-android).

**Making a release:** raise `version` in `package.json` (and the phone app's version in `android/app/build.gradle.kts`), then put the code on both `release` branches:

```sh
git push origin main:release            # in pc/
git -C ../android push origin main:release
```

Within the hour, `Andromon_Releases/.github/workflows/build.yml` notices the new version and:

1. **New version?** Reads the version in `package.json` on this repository's `release` branch. It builds when `Andromon_Releases` has no release for it yet and it is newer than the newest one there (an old `release` branch never republishes an older version). It also runs from that repository's Actions tab, where **force** builds whatever is on the branches.
2. **Phone app**: built from Andromon-android's `release` branch and signed with the `KEYSTORE_*` secrets of `Andromon_Releases`. Without them, the APK committed in `renderer/companion.apk` is used as it is, so bundle the newest one first (`npm run build:companion`, commit it).
3. **Desktop**, with that phone app bundled: macOS `.dmg` (Apple Silicon, Intel; ad-hoc signed unless `CSC_LINK` is set), Windows setup `.exe` (x64, ARM64, both in one, and 32-bit on Electron 43.8.12), Linux `.AppImage` and `.deb` (x64, ARM64). The build number is that workflow's run number.
4. **Web**: `Andromon-Web-<version>.zip`, and the phone app as `Andromon-Companion-<version>.apk`.
5. **Publish**: `SHA256SUMS.txt` (signed with `RELEASE_SIGNING_KEY` when set), then `scripts/release-manifest.js` with `RELEASE_REPOSITORY` (download links), `SOURCE_REPOSITORY` and `SOURCE_SHA` (the commits built), continuing from that repository's `latest.json` and `CHANGELOG.md`. The release `v<version>` is published at once, and its README, `latest.json` and `CHANGELOG.md` are updated.

The installed app's update check reads `latest.json` from `Andromon_Releases` (`updater.js`), so it sees a release as soon as it is published.

| Secret in `Andromon_Releases` | Used for |
|---|---|
| `RELEASE_SIGNING_KEY` | Signing `SHA256SUMS.txt` (the contents of `~/.andromon/release-signing-key.pem`) |
| `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD` | Signing the phone app. Phones only accept an update signed with the same key as the app they have |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Code signing on macOS and Windows |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarizing the macOS app |

All are optional.

### Releasing from the `automation` branch

`.github/workflows/automation.yml` in this repository publishes straight away instead of waiting for the hourly check: **push a new version to the `automation` branch**. On every push there it reads the version in `package.json`; when `Andromon_Releases` has no release for it and it is newer than the newest one there, it builds the same files as above (phone app from Andromon-android's `release` branch, or the bundled APK; every desktop installer; the web zip) and publishes the release in `Andromon_Releases`, with its README, `latest.json` and `CHANGELOG.md`. A push that doesn't raise the version builds nothing; **Actions › Release from automation › Run workflow** with **force** rebuilds a released version and replaces its files.

It needs the secret `RELEASES_TOKEN` in this repository: a fine-grained personal access token for `Deshan555/Andromon_Releases` with **Contents: Read and write**. The other secrets are the same as in the table above, set in this repository. Both workflows skip a version that is already released, so whichever gets to a new version first publishes it.

Nothing builds on a push to `main` or `release` in this repository. To try a change on every system without releasing it, build locally with `build/release.py` (section 3).

## 6. `scripts/release-manifest.js`

```sh
node scripts/release-manifest.js <folder with the installers> [file for the release notes]
```

It writes up to three files:

| File | Content |
|---|---|
| `latest.json` | The newest build: version, build number, date, commit, the commit subjects since the previous build, and every installer with its system, CPU type, size, SHA-256 and download address. |
| `CHANGELOG.md` | One section per build, newest first. The new section goes on top. |
| Release notes (optional) | The same list of commits, with links, as the description of the GitHub Release. |

How it finds what changed: it reads the commit of the previous build from the existing `latest.json` and lists the commits from there to the current one, leaving out merges and the workflow's own commits. With no previous build it lists the last 30 commits.

It takes the repository, commit and build number from `GITHUB_REPOSITORY`, `GITHUB_SHA` and `GITHUB_RUN_NUMBER`, and falls back to `package.json` and git when they are not set. The installed app reads `latest.json` from `Andromon_Releases` to find updates; the workflow there writes it when it publishes the release, so its download addresses work. With `MANIFEST_OUT` it writes to another folder, and the phone app and web build in the folder are listed too (see the comment at the top of the script).

## 7. The helper builds

Two files inside `renderer/` are built from other sources and committed, so a normal build doesn't need their tools.

- **`npm run build:companion`** runs `./gradlew assembleRelease` in `../android` (the phone app's repository, cloned next to this one) and copies the APK to `renderer/companion.apk`. Andromon installs this file on the phone.
- **`npm run build:uihelper`** runs `uihelper/build.sh`: it compiles `uihelper/src` with `javac`, converts the classes with `d8` and packs them into `renderer/ui-helper.jar`. It needs a JDK 17 or newer and the Android SDK (`ANDROID_HOME`, or `~/Library/Android/sdk`).

Run them only after changing the phone app or the helper, and commit the new file.

## 8. Common tasks

**Make a signed set of installers:** `python3 build/release.py`, press Enter at the menu, choose the systems and CPU types.

**Try a build quickly without touching `build/`:** choose one system and one CPU type, and type another folder (for example `/tmp/andromon-test`) at "Folder for the installers".

**After the first build, commit the public key:**

```sh
git add build/release.py build/release-signing-key.pub.pem
git commit -m "Add the release build script and the signing key's public half"
```

**Sign installers that were built on several computers:** copy them all into one folder, start the script, choose **3) Sign a folder of installers**, type the folder, and answer `y` to rewrite the checksums.

**Check a folder strictly before giving it to other people:** choose **2) Check a folder of installers** and answer `y` to both "Fail when…" questions.

**Answer the questions from a file or another script:** the answers are read from standard input, one per line, so they can be piped in. An empty line takes the default.

```sh
printf '1\ny\n1,2\n3\n\n\ny\n' | python3 build/release.py   # full build, pull, macOS + Windows, both CPU types
```

## 9. When something fails

| Message | Cause and fix |
|---|---|
| `can't open file … release.py` | The path is wrong for the folder the terminal is in. From `pc`: `python3 build/release.py`. |
| `The pull failed` | No network, your branch and GitHub's have gone different ways, or a pulled file has uncommitted changes. git's own message is shown above the question. Answer `y` to build what is here, or fix it and start again. |
| `The pull changed this script itself` | Start the script again; it then runs the new version. |
| `OpenSSL 3 not found` | macOS only has LibreSSL. `brew install openssl`, or set `OPENSSL` to the program's path. |
| `Not signing, the folder and its checksums disagree` | An installer was added, removed or changed after `SHA256SUMS.txt` was written. Choose **Sign a folder** and let it rewrite the checksums. |
| `SHA256SUMS.txt.sig does NOT match …` | The checksums changed after signing, or the signature was made with another key than the public key in `build/`. |
| `The private key and … are not a pair` | The private key in `~/.andromon` doesn't belong to the committed public key (for example on a second computer). Copy the right private key there. |
| `… already exists` | Only one half of the key pair is present. Put the missing half back; the script won't replace a key. |
| `the code signature is broken` | The macOS app was built without any signing (plain `npm run dist:mac` with `CSC_IDENTITY_AUTO_DISCOVERY=false`, or the GitHub workflow). Build it with `build/release.py`. |
| `stamped build 0, commit none` (warning) | The installer was built with the plain npm command, which doesn't stamp `build-info.json`. |
| `electron-builder finished but left no new installer` | The build made nothing new in `dist/`; read electron-builder's output above the message. |
| `No answer: this script asks its questions in a terminal` | It was started without a terminal and without piped answers. |
