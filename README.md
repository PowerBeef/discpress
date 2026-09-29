<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/brand/hero-mobile-dark.png">
    <source media="(max-width: 600px)" srcset="docs/brand/hero-mobile-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/hero-dark.png">
    <img src="docs/brand/hero-light.png" width="100%" alt="Discpress: pack your game discs into CHD files, right in your browser. No install, nothing uploaded. Works on iPhone, iPad, Android, Mac, Windows and Linux.">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/PowerBeef/discpress/releases/latest/download/discpress.html">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/brand/download-dark.png">
      <img src="docs/brand/download-light.png" width="380" alt="Download Discpress: one HTML file, works offline">
    </picture>
  </a>
  <a href="https://powerbeef.github.io/discpress/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/brand/open-dark.png">
      <img src="docs/brand/open-light.png" width="406" alt="Use Discpress online: nothing to download, big files on iPhone">
    </picture>
  </a>
</p>

<p align="center">
  <b>Free and open source</b> &nbsp;·&nbsp; <b>No install</b> &nbsp;·&nbsp; <b>Nothing uploaded</b> &nbsp;·&nbsp; <b>Phone and desktop</b>
  <br><br>
  <a href="#how-it-works">How it works</a> &nbsp;·&nbsp;
  <a href="#features">Features</a> &nbsp;·&nbsp;
  <a href="#supported-systems">Systems</a> &nbsp;·&nbsp;
  <a href="#get-started">Get started</a> &nbsp;·&nbsp;
  <a href="#faq">FAQ</a> &nbsp;·&nbsp;
  <a href="#build-it-yourself">Build it yourself</a>
</p>

<img src="docs/brand/divider.png" width="100%" alt="">

## What is Discpress?

A single PlayStation or Saturn game can be a dozen `.bin` files plus a `.cue`. **CHD** packs the whole disc into one compressed file that takes much less space, loses nothing, and loads directly in MAME, RetroArch, DuckStation, PCSX2, PPSSPP, Flycast and more.

The standard tool for making CHDs is **chdman**, a command-line program from the MAME project. **Discpress** puts its own fork of chdman, built from MAME 0.289 and made faster with its bugs fixed, inside a friendly app that runs in your web browser, on your phone or your computer. By default it makes the very same CHD files as chdman 0.289. There's no terminal and nothing to install, and your files never leave your device. It also recognizes your games and names each file after its official title.

Use it the way that suits you: **download it** as one HTML file that works anywhere, even without internet, or **use it online** with nothing to download. The online version is also the way to convert big games on iPhone and iPad.

## How it works

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/brand/steps-mobile-dark.png">
    <source media="(max-width: 600px)" srcset="docs/brand/steps-mobile-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/steps-dark.png">
    <img src="docs/brand/steps-light.png" width="100%" alt="1. Add your games: pick the cue and bin files, a gdi set or an iso; Discpress spots the console and the exact game. 2. Press Start: Discpress’s chdman compresses every disc using all your CPU cores. 3. Save the CHDs, named after the official title and ready for your emulator.">
  </picture>
</p>

## Features

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/brand/features-mobile-dark.png">
    <source media="(max-width: 600px)" srcset="docs/brand/features-mobile-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/features-dark.png">
    <img src="docs/brand/features-light.png" width="100%" alt="chdman, improved. Knows your games. Multi-core fast. Made for phones. Big discs welcome. Totally private.">
  </picture>
</p>

<details>
<summary><b>Everything it can do</b></summary>
<br>

- **Real chdman output.** chdman from the official MAME 0.289 release, compiled to WebAssembly, makes standard CHD v5 files, byte for byte the same as desktop chdman 0.289 makes on Linux, and with the same checksums as any chdman 0.289.
- **The right command, picked for you:** `createcd`, `createdvd`, `createhd`, `createld`, `extractcd`, `extractdvd`, `extracthd`, `verify` and `info`. The **Advanced** tab gives you every chdman command and option, including `copy`, parent CHDs, `addmeta` and hard disk templates.
- **Game recognition.** Discpress reads the disc's own boot files to find the console and serial number, then looks the game up in a built-in copy of the [Redump](http://redump.org) database (about 42,000 discs). When the size and CRC-32 match, the dump is marked as verified. When several releases share a serial number, you choose which one. Verifying a CHD also compares it with Redump, without extracting it.
- **Official names.** For example `Metal Gear Solid (USA) (Disc 1).chd`. You can also type your own name, turn renaming off, or use **Rename** to fix the name of a CHD you already have.
- **Fast.** Compression is spread over all your CPU cores, with WebAssembly SIMD when your browser supports it.
- **Big files.** Results are written to the browser's private disk storage, so multi-gigabyte DVD images work, and results not saved yet are still there after a reload. On desktop Chrome and Edge, results can go straight into a folder you choose. (Chrome and Edge give a page opened as a downloaded file no disk storage, so there it keeps results in memory: for big DVD images, choose a folder or use it online.)
- **Made for phones.** It adapts to any screen, notch, rotation and text size, in light or dark mode. On iPhone and iPad, **Save to Files** uses the share sheet; results over 512 MB are downloaded instead, since the share sheet loads the whole file into memory. If iOS reloads the page before you save, finished results are still there, under **From your last visit**.
- **Private and offline.** It's one self-contained HTML file with nothing to load from the internet. The online version is that same file: it runs on your device too, and once opened it works offline.

</details>

## Supported systems

<p align="center">
  <picture>
    <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="docs/brand/systems-mobile-dark.png">
    <source media="(max-width: 600px)" srcset="docs/brand/systems-mobile-light.png">
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/systems-dark.png">
    <img src="docs/brand/systems-light.png" width="100%" alt="PlayStation, PlayStation 2, PSP, Saturn, Sega CD / Mega CD, Dreamcast, NAOMI, PC Engine CD / TurboGrafx-CD, PC-FX, Neo Geo CD, 3DO, CD-i, Amiga CD32, CDTV, arcade hard disks and LaserDisc.">
  </picture>
</p>

| System | Add these files | Becomes |
|---|---|---|
| PlayStation, Saturn, Sega CD, PC Engine CD, Neo Geo CD, 3DO, CD-i, Amiga CD32, PC-FX | `.cue` + `.bin` (or ECM-packed `.bin.ecm`), or CloneCD `.ccd` + `.img` (+ `.sub`) | CD CHD |
| Dreamcast | `.gdi` + tracks, or Redump `.cue` + `.bin` | CD CHD (GD-ROM detected) |
| PlayStation 2 | DVD games: `.iso`, or compressed `.cso`/`.zso` · CD games: `.cue` + `.bin` | DVD or CD CHD |
| PSP | `.iso`, or compressed `.cso`/`.zso` | DVD CHD |
| Arcade and computer hard disks | `.img`, `.hdd` | Hard disk CHD |
| LaserDisc arcade games | `.avi` | LaserDisc CHD |
| Any of the above | `.chd` | Back to `.cue`/`.bin` (by default the Redump dump's own files), `.gdi` or `.iso` |

## See it in action

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/showcase-dark.png">
    <img src="docs/brand/showcase-light.png" width="100%" alt="Discpress on a desktop browser with a PlayStation disc identified as Metal Gear Solid (USA) (Disc 1), next to the phone version.">
  </picture>
</p>

## Get started

1. **Pick a way to run it.** Both are the same app, both work in every modern browser, and both keep your files on your device.

   | | **[⬇ Download the file](https://github.com/PowerBeef/discpress/releases/latest/download/discpress.html)** | **[🌐 Use it online](https://powerbeef.github.io/discpress/)** |
   |---|---|---|
   | **What it is** | `discpress.html`, the whole app in one file you keep | The same file on [powerbeef.github.io/discpress](https://powerbeef.github.io/discpress/), updated with each release |
   | **Best for** | Computers and Android, and using it without any internet | Nothing to download, and **big games on iPhone and iPad** |
   | **How to open it** | Double-click it on a computer; on Android, open it with Chrome or another browser | Open the link. On iPhone and iPad, use Safari |
   | **Offline** | Always | Once opened; you can also install it (Share → **Add to Home Screen**, or the install button in Chrome and Edge) |
   | **Big DVD images** | In Chrome and Edge, choose a folder for the results (Settings): opened as a file, the page keeps them in memory | Results go to disk in every modern browser |

   **On iPhone and iPad, use it online, in Safari.** Safari can't open a downloaded HTML file, and apps that can, such as Sitecase, can't save results over about 512 MB (most DVD, PSP and PS2 games). In Safari, results of any size download to Files → Downloads. If a big download doesn't start from the Home Screen icon, open the page in Safari itself.
2. **Add your games.** Pick every file of a game together (the `.cue` *and* its `.bin` files), or drag them onto the page.
3. **Press Start all**, then **Save** or **Download** each CHD when it's ready. Keep the page open while it works; on a phone, keep the screen on too, since iOS and Android pause pages in the background.

<img src="docs/brand/divider.png" width="100%" alt="">

## FAQ

<details>
<summary><b>Are my games uploaded anywhere?</b></summary>
<br>
No. Discpress is a single file that runs entirely on your device, downloaded or online. It makes no network requests and works in airplane mode: its Content-Security-Policy (`connect-src 'none'`) forbids the page any connection, in the downloaded file and on [powerbeef.github.io/discpress](https://powerbeef.github.io/discpress/) alike. The online version is the release file byte for byte; each release lists its SHA-256 (`discpress.html.sha256`), and the site has the same file, so you can compare them. Opening it online is an ordinary visit to a GitHub Pages site: GitHub sees the request for the page, as for any website, never your files. It sets no cookies and has no analytics. The downloaded file doesn't contact anything at all.
</details>

<details>
<summary><b>Are the CHDs as good as the ones from desktop chdman?</b></summary>
<br>
Yes. Discpress runs chdman from the official MAME 0.289 release, so the files are standard CHD v5 with the same checksums as desktop chdman 0.289's, and byte for byte the same as chdman 0.289 makes on Linux, CD audio included. (chdman builds for Windows or macOS round the FLAC encoder's floating-point math differently, so their CD-audio bytes can differ from each other's and from Discpress's, never the audio itself.) Its source is in <a href="engine/README.md"><code>engine/</code></a>. The changes let it run in a browser and on several cores, make it faster without changing a byte, and fix chdman 0.289's crashes on bad input. Some opt-in choices change the bytes but not the checksums: the <i>Nearly as small, faster</i> and <i>Faster to create</i> compressions, and keeping cue sheets in CD CHDs. You can read every change in <a href="engine/mame-0.289.diff"><code>engine/mame-0.289.diff</code></a>.
</details>

<details>
<summary><b>Which browsers work?</b></summary>
<br>

| Browser | Support |
|---|---|
| Safari 16.4+ (iPhone, iPad, Mac) | Full |
| Chrome and Edge 102+ (desktop, Android) | Full, plus saving straight into a folder |
| Firefox 111+ | Full |

Older browsers keep results in memory instead of on disk, and so do Chrome and Edge when Discpress is opened as a downloaded file. That limits how big a disc can be, and a reload loses the results not saved yet (the page then says which). Choose a folder for results in Chrome and Edge, or use the online version.

The downloaded file and the online version work the same in each of them. On iPhone and iPad, use the [online version](https://powerbeef.github.io/discpress/) in Safari. Apps that open HTML files, such as Sitecase, run it too, but they can't save results over about 512 MB (most DVD, PSP and PS2 games): the page tells you when that's the case. Lockdown Mode turns off WebAssembly, which Discpress needs.
</details>

<details>
<summary><b>How big can a disc be?</b></summary>
<br>
Multi-gigabyte DVD images work as long as your device has the free space, because results are written to disk rather than memory. Creating a CHD is CPU-heavy, so expect a few minutes per CD on a computer and longer on a phone. <i>Nearly as small, faster</i> in Options tries each track with only the codec that suits it: about 1.7 times as fast for CDs and 1.5 for DVDs, with files at most 0.3% bigger and the same checksums. <i>Faster to create</i> trades more size for more speed.
</details>

<details>
<summary><b>My game says "not recognized". Is something wrong?</b></summary>
<br>
No. Hacks, translations, homebrew and modified dumps aren't in the Redump database, so they keep their original file name. The conversion works exactly the same. You can also type any name you like in Options.
</details>

<details>
<summary><b>Can I turn a CHD back into a .cue/.bin or .iso?</b></summary>
<br>
Yes. Add the <code>.chd</code> and choose Extract. A CD comes back as its Redump dump: the same cue sheet and <code>.bin</code> files. For discs whose cue sheet holds more than a CHD stores (CATALOG, FLAGS, ISRC, extra indexes: common on Saturn, Sega CD, PC Engine CD, 3DO and CD-i), turn on Settings → *Keep the cue sheet in CD CHDs* before converting, and that sheet comes back too. You can also verify a CHD's checksums, which compares it with Redump too, or view its details.
</details>

<details>
<summary><b>Does Discpress come with any games?</b></summary>
<br>
No. It only converts files you already have. Please convert only discs you own.
</details>

## Build it yourself

The build is fully reproducible: building from a clean checkout gives a byte-identical `dist/discpress.html`.

<details>
<summary><b>Build instructions</b></summary>
<br>

Requirements: [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) 6.0.10, Python 3 and make. The chdman source is in `engine/` (see [`engine/README.md`](engine/README.md)).

```sh
# one-time setup
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 6.0.10 && ~/emsdk/emsdk activate 6.0.10

# build
source ~/emsdk/emsdk_env.sh
./build.sh                      # -> dist/discpress.html
```

- If you only change files in `app/`, run `python3 scripts/assemble.py` instead of the full build. Without Emscripten, run `python3 scripts/extract-build.py` once first: it recovers the WebAssembly build from `dist/discpress.html`. A change to `engine/`, `wasm/` or `build.sh` needs the full build: the page records the sources its WebAssembly was built from, and `scripts/check-dist.sh` (run by every release) refuses a page built from older ones.
- `tests/` has end-to-end UI tests (Playwright) that check every conversion against native chdman, plus conversion benchmarks. See [`tests/README.md`](tests/README.md).
- To refresh the game database with the latest Redump data, run `./scripts/update-db.sh`, then `python3 scripts/assemble.py`.
- The README graphics are rendered from `scripts/brand/brand.html` with `python3 scripts/brand/render.py` (needs Playwright).
- Running **Actions → Release → Run workflow** on `main` with a tag such as `v1.3.5` (always `vX.Y.Z`: there are no prereleases) publishes a release: `discpress.html` and its SHA-256 as the download, and the same file on GitHub Pages as the online version. The download goes public only once the site is deployed, so both always carry the same version; a daily check (`scripts/check-release.sh`) confirms it. See `.github/workflows/release.yml` and [`web/README.md`](web/README.md). Release notes come from `.github/release-notes/<tag>.md` when that file exists.

</details>

<details>
<summary><b>Repository layout</b></summary>
<br>

| Path | What it is |
|---|---|
| `app/` | The web app: page, styles, UI, game identification, and the Web Worker that runs chdman |
| `engine/` | Discpress's chdman: MAME 0.289's chdman and the sources it links, with every change listed in `mame-0.289.diff`, plus libdeflate and the math FLAC needs |
| `wasm/` | WebAssembly build: Makefile, link flags, the parallel-compression helper, ECM decoding, and a small SDL stub |
| `db/` | Game database (`db.json.gz`) and the script that builds it from libretro-database |
| `web/` | What the online version adds to `discpress.html`: offline service worker, web app manifest and icons |
| `scripts/` | Fetch MAME, build native chdman, update the database, assemble the single HTML file, and render the brand graphics |
| `dist/` | The ready-to-use `discpress.html` |
| `tests/` | End-to-end UI tests and benchmarks (Playwright) with synthetic disc images |
| `docs/` | README graphics, research on the CHD format and chdman (`docs/chd/`), and on iPhone and iPad (`docs/ios/`) |

</details>

<details>
<summary><b>How it works inside</b></summary>
<br>

- **File access.** A custom Emscripten file system reads your files directly (no copy into memory) and writes results to the browser's private storage (OPFS), to a folder, or to memory.
- **Multi-core compression.** Helper workers compress hunks in parallel. chdman's commands are C++20 coroutines that pause while the helpers work; extracting and verifying use the helpers the same way to decompress ahead of the reads.
- **iPhone and iPad.** When a worker can't read the picked files (inside some file-viewer apps), the page streams them to the worker in chunks instead. A small record in the page's storage lets results survive a reload. [`docs/ios/`](docs/ios/README.md) explains iOS's limits and how Discpress works around them.
- **Game identification.** It reads boot headers (IP.BIN, SYSTEM.CNF, PARAM.SFO, IPL.TXT and others) through ISO 9660, including inside existing CHDs, then matches the serial number, or the size and CRC-32, against the database.

</details>

## Credits and license

Discpress is released under the [BSD 3-Clause license](LICENSE). It is built on **chdman** and MAME's `lib/util` (BSD 3-Clause, © Aaron Giles, R. Belmont and the MAMEdev team), with zlib, LZMA SDK, FLAC, Zstandard, libdeflate and a few smaller libraries. Game data comes from [Redump](http://redump.org) via [libretro-database](https://github.com/libretro/libretro-database). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full list.

Discpress is not affiliated with the MAME team, Redump or libretro.

<br>
<p align="center">
  <img src="docs/brand/divider.png" width="100%" alt="">
  <br><br>
  <img src="docs/brand/logo.png" width="56" alt="Discpress logo">
  <br>
  <sub><b>Discpress</b> · made for everyone with a shelf full of old discs</sub>
</p>
