# L4: Getting Discpress (or its engine) to write multi-GB CHDs into Files on iPhone/iPad, without plain Safari

Research date: 2026-09-28. Repository read-only (no changes). "Unverified" means I could not confirm it from a primary source or a device test.

Starting point (from the task): in **Sitecase** (App Store, WKWebView), `dist/discpress.html` converts a 1.6 GB PSP ISO, but the result can't leave the app. `navigator.share` loads the whole ~1 GB file into memory and iOS kills the app. `<a download>` fails with "Frame load interrupted", which is WebKit's error when the host app doesn't handle a download: the app implements no `WKDownload`.

## Comparison

| Route | Works today? | Large files (1–8 GB)? | Effort for us | Effort for the user | Cost |
|---|---|---|---|---|---|
| **Sitecase, as is** | Converts: yes (reported). Export: **no** | Conversion yes; export impossible | none | low | free (Pro $6.99 not needed) |
| **Sitecase + ask the developer to add WKDownload** | No (needs an app update) | Should be fine, since WKDownload writes to disk (unverified for 1 GB blobs) | Send an email with a ~50-line patch suggestion | low, once shipped | free |
| **Sitecase + export in parts** (page shares 100–200 MB slices, then `cat` in a-Shell) | Plausible with a small Discpress change (unverified) | Yes, in slices (whether one share of about 200 MB survives is unverified) | small: a "save in parts" button | high (many share sheets plus one a-Shell command) | free |
| **iCab Mobile** (opens local HTML, has a download manager with `blob:` support, downloads visible in Files) | **Probably**: every piece is documented, but not the whole chain for 1 GB | Unverified for 1 GB blobs | none (maybe a doc note) | low–medium | $2.99 |
| **Documents by Readdle** (browser with a download manager) | Unverified: can it open a local .html with JS? Could load Discpress from an https URL instead | Unverified | none, or host the page on https | medium | free |
| **Other HTML viewers** (HTML Viewer Q, HTML Viewer Pro/++, Koder, Textastic preview, Htmly, OpenHTML…) | Unverified; none advertises downloads. Several are stale (Q: 2021, Koder: 2022) | Unverified / unlikely | none | — | free–$2.99 |
| **a-Shell / a-Shell mini + chdman built for WASI** | No: needs a WASI build and a-Shell's slow I/O bridge (see §2) | Yes (64-bit offsets OK). Writes go through a text bridge, speed unmeasured | medium (a WASI port of `engine/`, 2 EH variants) | medium (install the .wasm in `~/Documents/bin`, `pickFolder`, type a command, keep the app in front) | free |
| **iSH + Alpine `mame-tools`** (chdman 0.285, x86, edge/testing) | Maybe (the package exists for x86) | Painfully slow: iSH is "5–100× slower than native" | none | high | free |
| **UTM SE** (App Store, no JIT) | Technically | Far too slow | none | very high | free |
| **Thin native wrapper app** (WKWebView plus WKDownload or a JS bridge, Documents shared in Files) | Build it | Yes (disk-to-disk) | **small–medium: ~200–400 lines of Swift, 1–3 days** plus signing and review | low | $99/yr (App Store/TestFlight/EU marketplaces); free but 7-day re-signing via SideStore/AltStore |
| **Fully native iOS chdman app** (engine linked into a Swift app, pthreads) | Build it | Yes, the fastest (native, multithreaded; iOS 26 `BGContinuedProcessingTask` for background) | medium–large (1–3 weeks for a decent UI; we'd lose Discpress's JS front end unless it's reused in a WKWebView) | low | same as wrapper |
| **Shortcuts** | No: can't run wasm or read a page's OPFS; "Run JavaScript on Web Page" needs Safari | — | — | — | free |

**Bottom line:**
- **Try iCab Mobile first.** It needs no work from us, and each piece of the chain is documented, though the whole chain isn't.
- **Email the Sitecase developer and ask for WKDownload support.** The app is actively maintained, with a release the day before this research.
- **The durable fix is a thin wrapper app.** It needs a WKDownloadDelegate, or a custom-scheme or bridge writer to Documents. It later leaves room for a native-engine path.
- **a-Shell and WASI are feasible but second-rate.** The I/O bridge is slow, it runs single-threaded, the app has to stay in the foreground, and the port needs work.
- **No iOS app creates CHDs today.**

---

## 1. iOS apps that run local HTML/JS files

WebKit facts that apply to all of them: every iOS app uses WKWebView (App Review Guideline 2.5.6 requires WebKit; https://developer.apple.com/app-store/review/guidelines/). So JS, Web Workers, WebAssembly (with SIMD and exceptions on current iOS), IndexedDB and OPFS behave as in Safari's engine. What differs per app:

- **(a) Can it load a `file://` page with read access to its folder?**
- **(b) Does it implement downloads?** WKWebView downloads a `blob:` URL only when the app's navigation delegate answers `.download` (or `navigationAction.shouldPerformDownload`) and a `WKDownloadDelegate` chooses a destination. That is available from iOS 14.5 (https://github.com/bricklife/zenn/blob/main/articles/how-to-download-blob-on-wkwebview.md; Apple: https://developer.apple.com/documentation/webkit/wkdownloaddelegate). Without it, clicking `<a download>` fails with "Frame load interrupted".
- **(c) Which website data store does it use?** OPFS and IndexedDB persistence depend on it.

A claim that "each OPFS file in a WKWebView is limited to 10 MB" (https://github.com/wendylabsinc/opfs-checker) is unsourced, and Sitecase contradicts it: it wrote a ~1 GB CHD. **Treat that claim as wrong or outdated.**

### Sitecase ("HTML Viewer – Sitecase")
- **App Store listing** (https://apps.apple.com/us/app/html-viewer-sitecase/id6762896369):
  - Dennis Bortmes, v2.3.3 (2026-09-27), iOS 17.6+, free.
  - Pro is a $6.99 one-time purchase.
  - Features: "Full HTML, CSS and JavaScript rendering", "Turn network access on or off anytime", "Turn JavaScript support on or off (Pro)", Shortcuts/Siri to open saved files, and whole-folder import (Pro).
  - 2.1.0 "localStorage persistence fix"; 2.2.0 "Update from Source".
- **Downloads:** none advertised. The reported "Frame load interrupted" shows there is no WKDownload handling.
- **Settings that matter:**
  - JavaScript must be on (it's the default; the toggle is Pro).
  - Network access can stay **off**: Discpress makes no network requests (its tests fail on any).
  - Saved data persists (2.1.0), so OPFS contents survive between sessions but stay inside Sitecase's WebKit store, which the Files app can't see.
- **Contact:** privacy policy at https://dennisbortmes.github.io/legal/privacy, email: the address in the privacy policy (covers Sitecase, Nifuda, Plancase). Website https://sitecase.io (source: https://github.com/dennisbortmes/sitecase.io, which has an issue tracker with 0 issues). `llms.txt` there lists the features; it doesn't mention downloads.
- **What to ask the developer:**
  - handle `navigationAction.shouldPerformDownload` / `blob:` with `.download`;
  - in `download(_:decideDestinationUsing:suggestedFilename:)`, write to the app's Documents folder, then offer `UIDocumentPickerViewController(forExporting:)`, or enable `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` so Documents shows in Files.

  That's roughly 50–100 lines. For the 1 GB case, WebKit streams a file-backed blob to disk instead of memory (expected from how WebKit handles blobs, but **unverified on device**).

### iCab Mobile (Alexander Clauss), $2.99, v11.3.1 (2026-07-14), iOS 15+ (https://apps.apple.com/us/app/icab-mobile-web-browser/id308111628)
Version history (http://www.icab-mobile.de/history.html):
- **10.4 (2021-12-11):** "Since iOS 15 it is possible support downloads which a web site provides via "blob" URLs."
- **11.0.9 (2025-06-01):** "Bugfix: It could happen that "blob:" downloads were started in such a way that they were supposed to run in the background, but this cannot work in general." So blob downloads are actively maintained.
- **9.11.3:** mentions "local HTML files of the downloads window". **11.0.8:** "Links to local files ("file" protocol) in the quickstarter did not work when tapped" (fixed). So iCab opens local HTML files from its Downloads folder via `file:` URLs.
- **9.10.0 (2017-09-25):** "The downloads of iCab Mobile can be accessed from within the "Files" App if the "Downloads Sharing" option in the Network settings … is set".
- **4.2:** "iCab Mobile can now receive documents and files from other Apps (like HTML files …)".

**Likely user flow:**
1. Share or import `discpress.html` into iCab's Downloads.
2. Open it from the download manager.
3. Pick the inputs with the page's file picker and convert.
4. Tap Save: a `blob:` download lands in iCab's Downloads.
5. With Downloads Sharing on, the CHD is visible in Files under "iCab Mobile".

**Unverified:**
- whether OPFS works for iCab's `file:` pages (WebKit supports it, and Sitecase proves it works in a WKWebView);
- whether a 1–4 GB blob download streams rather than buffering in memory;
- whether iCab's download manager copes with that size.

**This is the best "no work for us" candidate; test it on a device.**

### Documents by Readdle
- Free, v8.22.6/8.22.7 (Sept 2026). App Store: "Download files from the web browser directly into Documents" (https://apps.apple.com/us/app/documents-file-manager/id364901807).
- Browser help: downloads go to a configurable folder, "Downloads" by default (https://support.readdle.com/documents/built-in-browser-download-manager/documents-internal-web-browser). Blob support and file size are not documented.
- **Opening a local .html with JS: unverified.** A user report says HTML folders "stopped working" after an update (search summary; Apple Community thread https://discussions.apple.com/thread/250693656).
- **Alternative:** load Discpress from an https URL (e.g. a GitHub Pages copy) in its browser and let the download manager take the `blob:` download. **Unverified.**

### Other viewers/editors (from the iTunes Search API, 2026-09-28)
| App | Version / date | Notes |
|---|---|---|
| HTML Viewer Q (Yi-Lun Lin) https://apps.apple.com/us/app/html-viewer-q/id810042973 | 1.8.4, 2021-05-30 | stale; downloads not advertised (unverified) |
| HTML Viewer Pro (Hayato Shimizu) https://apps.apple.com/us/app/html-viewer-pro/id1521187909 | 10.0.3, 2024-02-29 | no download claims |
| HTML Viewer ++ (HurryApp) https://apps.apple.com/us/app/html-viewer/id6738789687 | 26.0.5, 2026-02-18 | "Import and export … files"; download support unverified |
| HTML Viewer – Htmly https://apps.apple.com/us/app/html-viewer-htmly/id6780105308 | 1.0.3, 2026-09-09 | offline reader; JS/downloads unverified |
| OpenHTML https://apps.apple.com/us/app/openhtml-html-pdf-markdown/id6776524508 | 1.7.0, 2026-09-26 | offline preview, "JavaScript issues" diagnostics, PDF export; downloads unverified |
| Koder https://apps.apple.com/us/app/koder-code-editor/id1447489375 | 4.2.2, 2022-04-19 | editor with preview; stale |
| Textastic https://apps.apple.com/us/app/textastic-code-editor/id1049254261 | 10.9.8, 2026-09-05 | preview plus "JavaScript console"; downloads from preview unverified |
| Code App (thebaselab) https://github.com/thebaselab/codeapp | 1.12.3, 2026-09-16, $6.99 | local web dev environment (Node + PHP) with preview, 70+ terminal commands, "C/C++ Runtime with WebAssembly (with clang)", Files folder access. Downloads from preview unverified |
| Scriptable https://docs.scriptable.app/filemanager/ | 1.7.19, 2024-09-30 | has a WebView, but `FileManager.write` only overwrites a whole file (no append), so a 1 GB result would sit in memory. **Not suitable** |
| JSBox https://apps.apple.com/us/app/jsbox-learn-to-code/id1312014438 | 2.32.0, 2023-09-14 | JS runtime with native APIs; stale; not evaluated further |
| Play.js | — | not found in the US App Store search (2026-09-28); appears delisted (unverified) |
| Web-server apps: WorldWideWeb – Mobile (Iconfactory), TinyServer, Simple Server, Servit, PocketServer… | various | serve a folder over http. Only useful to reach Discpress from another browser; they don't solve the download on their own |

**Other routes to note:**
- **A local upload server (unverified).** With network access **on** in Sitecase, the page could `fetch` PUT the CHD in chunks to a local server that writes into a Files folder, e.g. a small Python upload handler in a-Shell on `127.0.0.1`. That needs CORS (`Access-Control-Allow-Origin: *`, since a `file:` page has a null origin), and both apps kept alive. iOS suspends background apps, so it only works reliably on iPad Split View. Not tested.
- **Export in parts (unverified).** A Discpress option could slice the OPFS file into 100–200 MB `File`s and share them one by one ("Save to Files"). The user then joins them with `cat part.* > game.chd` in a-Shell (or any tool that concatenates). Clunky, but it works within Sitecase's limits if a single ~200 MB share doesn't hit the memory kill.

## 2. a-Shell / a-Shell mini, iSH, UTM

### a-Shell's WebAssembly runtimes
a-Shell v2.2.2 (2026-09-21), free, iOS 14+ (https://apps.apple.com/us/app/a-shell/id1473805438). a-Shell mini is the same version. Source read from https://github.com/holzschu/a-shell (master, last commit 2026-09-23). a-Shell has **three** wasm runtimes:

1. **`wasm` (default):** runs in a hidden WKWebView with **JavaScriptCore** (JIT) and a patched `@wasmer/wasi`.
   - `wasm.js` does `new WebAssembly.Instance(module, wasi.getImports(module))`.
   - It is unavailable "In Extension", i.e. in Shortcuts' extension mode (`a-Shell/ExtraCommands.swift`, `wasm()`).
   - **All file I/O is bridged to Swift through synchronous `prompt()` calls** (`Resources/node_modules/@wasmer/wasi/lib/index.js` ~L870–1020; Swift side `a-Shell/SceneDelegate.swift` ~L4783–4910):
     - reads come back **base64-encoded** and are decoded in JS byte by byte (`base64DecToArr`);
     - writes are sent as the typed array's **`toString()`, i.e. comma-separated decimal bytes** ("84,104,105,…"), which Swift splits and parses byte by byte.
     - One source comment says websockets were tried and rejected.
   - Offsets travel as decimal strings and are parsed as `UInt64`, so >4 GB offsets are fine; JS Numbers are exact to 2^53.
   - **Throughput for GB-sized outputs is unmeasured.** Expect it to be the bottleneck: roughly 3.6 bytes of text per output byte, and one IPC round trip per hunk-sized write.
2. **`wasm3`:** an interpreter.
   - "wasm3 does not accept any kind of exception handling" (`a-Shell/AppDelegate.swift` ~L313), so the C++ exceptions chdman relies on rule it out.
   - The a-Shell guide says it is "more limited in memory allocation" (https://bianshen00009.gitbook.io/a-guide-to-a-shell/lets-do-more-for-it/webassembly-for-a-shell).
3. **`wasmkit`** (Swift interpreter, **iOS 18+**, added in a-Shell 2.2.0): "About as fast as wasm3" (App Store version history).
   - "wasmkit only accepts the new EH" (`AppDelegate.swift` ~L312).
   - WasmKit supports Exception Handling, fixed-width SIMD, Memory64, threads, and "majority of syscalls" of WASI 0.1 (https://github.com/swiftwasm/WasmKit).
   - wasm3's own benchmarks put it ~11.8× slower than native (https://github.com/wasm3/wasm3/blob/main/docs/Performance.md).
   - So wasmkit/wasm3 would take **roughly an hour or more** for a 1.6 GB DVD-type image (estimate).

**Compiler setup in a-Shell** (`AppDelegate.swift` ~L308–318): a-Shell's built-in clang forces `--target=wasm32-wasip1 -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -lunwind` on iOS 18+ and `…=true` (legacy EH) on iOS 14–17. So the JSC path supports C++ exceptions: legacy EH everywhere, new EH on iOS 18+.

**Limits** (README and guide): "no sockets, no forks", "no threads", no `mmap`, no `setjmp/longjmp`, no signals.

**Installing commands:**
- a `.wasm` placed in a `$PATH` directory, e.g. `~/Documents/bin`, runs by name;
- or `pkg install`, from https://github.com/holzschu/a-Shell-commands.

**File access:** `pickFolder` grants and bookmarks any Files folder. `~/Documents` is itself visible in Files (README, https://github.com/holzschu/a-shell).

**Large tools already running there:**
- `ffmpeg.wasm` (18 MB, all codecs plus libx264), `xz`, `sqlite3`, `zip`/`unzip`, and LLVM/clang itself (packages `llvm-18`/`llvm-22`) (a-Shell-commands README and `packages/`).
- No report found of multi-GB file processing speed.

**Shortcuts:** "In Extension" vs "In App" modes. The JSC `wasm` needs "In App" (README §Shortcuts).

**Porting `engine/` to WASI (estimate, not tried):**
- **Exceptions.** `wasm/Makefile` builds with `-fwasm-exceptions`, and chdman throws/catches `std::error_condition`, `std::bad_alloc` and more. wasi-sdk supports C++ exceptions **from wasi-sdk-33 (tagged 2026-04-28)**, with `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -lunwind`; no LTO, no shared libs (https://github.com/WebAssembly/wasi-sdk/blob/main/CppExceptions.md; tracking issue https://github.com/WebAssembly/wasi-sdk/issues/565). a-Shell also ships its own fork (https://github.com/holzschu/wasi-sdk). **We'd ship two builds:** legacy EH for iOS 14–17 and new EH for iOS 18+/wasmkit.
- **Threads.** chdman doesn't *need* threads. The work queues can run with 0 threads: `osdsync.cpp` already forces `threadnum = 0` under `SDLMAME_EMSCRIPTEN`, and `osd_get_num_processors` returns 1. But `osdsync.cpp` still uses `std::thread`/`std::mutex`/`condition_variable`, which wasi-sdk's non-threads libc++ likely doesn't provide (unverified). So it needs a single-threaded stub.
- **Other stubs:**
  - `posixsocket.cpp`/`posixptty.cpp`: WASI has no sockets or ptys, so stub them out.
  - `realpath` in `posixfile.cpp`: check wasi-libc support.
  - The SDL shim can stay.
- **Speed.** Single-threaded only; the Discpress helper-worker scheme doesn't apply, since a-Shell runs no workers. `docs/chd/measurements.md` (§ default vs plan) has the benchmark DVD (1 GB) at ~212 s on one native desktop thread and 241 s in the page with 1 thread. So under JSC JIT a 1.6 GB DVD-type image is ~6–7 min of CPU, plus the unknown bridge overhead. The "Nearly as small, faster" preset (`--codecplan --libdeflate`) would cut CPU ~1.5×.
- **Foreground.** a-Shell must stay in the foreground: iOS suspends it otherwise (general iOS behaviour; not a-Shell-specific documentation).

**Another route:** a-Shell includes many *native* commands (ios_system frameworks, e.g. native ffmpeg). Contributing chdman as a native a-Shell command would give native speed and threads, but depends on the maintainer (Nicolas Holzschuch) accepting it (unverified).

### iSH
- **Status:** v1.3.2, 2023-05-21 (https://apps.apple.com/us/app/ish-shell/id1436902243). User-mode x86 Linux via the "Asbestos" threaded interpreter: "iSH typically benchmarks at 5-100x slower than native code". Apple refused JIT even in the EU (https://ish.app/blog/ish-jit-and-eu, 2024-10-16).
- **Files access:** `mount -t ios . /mnt` opens a folder picker (https://github.com/ish-app/ish/wiki/Mounting-other-file-providers).
- **chdman:** Alpine has `mame-tools` 0.285-r1 for x86 in **edge/testing** (https://pkgs.alpinelinux.org/packages?name=mame-tools&branch=edge&arch=x86). iSH's pinned repositories may not install edge packages cleanly (unverified).
- **Speed:** at 5–100× slower, a 1.6 GB image takes ~30 min to many hours. **Not practical.**

### UTM
UTM SE (App Store, v4.7.5, 2026-01-11, https://apps.apple.com/us/app/utm-se-retro-pc-emulator/id1564628856) is full-system emulation with a threaded interpreter (TCTI, "slow edition"; https://docs.getutm.app/installation/ios/). **Far too slow.** JIT UTM needs sideloading plus a JIT enabler: not a user-friendly route.

## 3. A thin native wrapper app

### Design options, simplest first
1. **Load the bundled page.** Use `WKWebView.loadFileURL(bundled discpress.html, allowingReadAccessTo:)`; the page's `<input type=file>` works as in Sitecase.
2. **Downloads via WKDownload.**
   - Navigation delegate: `decisionHandler(.download)` when `navigationAction.shouldPerformDownload`, or when the URL scheme is `blob`.
   - `webView(_:navigationAction:didBecome:)` sets `download.delegate`.
   - `download(_:decideDestinationUsing:suggestedFilename:)` returns `Documents/<name>` (iOS 14.5+; https://developer.apple.com/documentation/webkit/wkdownloaddelegate, https://github.com/bricklife/zenn/blob/main/articles/how-to-download-blob-on-wkwebview.md).
   - Zero changes to Discpress, whose Save button already does `<a download>`.
   - Streaming of a file-backed OPFS blob: expected (the network process reads the blob from disk), **verify with 4 GB**.
3. **Make Documents visible in Files.** Info.plist `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` makes Documents show under "On My iPhone › Discpress". Optionally, `UIDocumentPickerViewController(forExporting: [url], asCopy: false)` moves the file anywhere, e.g. iCloud Drive or a USB drive.
4. **Alternatives to WKDownload, if it misbehaves:**
   - **Custom scheme.** Serve the page from a `WKURLSchemeHandler` scheme and have the page `fetch(PUT)` 8–64 MB ArrayBuffer slices to it; Swift appends them with `FileHandle`. POST bodies reach scheme handlers since WebKit r244617 (2019), but **Blob bodies don't**, so slice to ArrayBuffer first (https://bugs.webkit.org/show_bug.cgi?id=191362).
   - **Message handler.** `WKScriptMessageHandler` only takes property-list types (string/number/array/dict), so chunks would have to go as base64 strings: slower, but simple.
   - **Read OPFS from the native side.** WebKit stores OPFS as ordinary files under `<website data root>/<b64url(SHA-256(topOrigin+salt))>/<b64url(SHA-256(origin+salt))>/FileSystem/…`. **Names are stored verbatim** (`FileSystemStorageHandle.cpp`: `pathByAppendingComponent(m_path, name)`; `OriginStorageManager.cpp`: `typeStoragePath` → "FileSystem"; `NetworkStorageManager.cpp`: `originDirectoryPath`, salt file "salt"). With the default data store that root is inside the app's own container (`Library/WebKit/…`; exact iOS path **unverified**). So the wrapper *could* find the finished CHD by walking that tree and move it. It's undocumented and could change, so use it only as a fallback.

### Effort
- **Wrapper with WKDownload:** about 200–400 lines of Swift, 1–3 days including icons, a share/export button, and testing with multi-GB files.
- **Build-pipeline change:** one — copy `dist/discpress.html` into the app bundle.
- **Background:** the WebContent process is suspended when the app is backgrounded. iOS 26's `BGContinuedProcessingTask` lets user-started work continue with a system progress UI (https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask, WWDC25 227 https://developer.apple.com/videos/play/wwdc2025/227/). Whether it keeps a WKWebView's JS running is **unverified**; it definitely helps a native engine (§4).

### Distribution and costs
- **Apple Developer Program: $99/year** (https://developer.apple.com/programs/). It is required for the App Store, TestFlight and EU notarized distribution. A free Personal Team allows on-device testing only: profiles expire after 7 days, 3 apps per device (https://developer.apple.com/support/compare-memberships/).
- **TestFlight:** up to 10,000 external testers, public links, builds expire after **90 days**; the first build goes through Beta App Review (https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview, https://developer.apple.com/testflight/).
- **App Store review risks:**
  - **4.2 Minimum Functionality:** "elevate it beyond a repackaged website". Mitigate with native file handling, a Files integration and an app icon/UX; a pure web wrapper is the main rejection risk.
  - **4.2.2:** no "web clippings".
  - **2.5.2:** code must be in the bundle, which bundled HTML/wasm satisfies.
  - **Emulation adjacency:** emulators are allowed (4.7 mentions "retro game console and PC emulator apps can offer to download games"). A disc-image converter for user-owned files is a utility, and I found no guideline against it. The Redump name database shows game titles; that's low risk, but unverified with App Review. (All quotes: https://developer.apple.com/app-store/review/guidelines/)
- **Sideloading:**
  - AltStore Classic / SideStore with a free Apple ID: "Free accounts are limited to 3 apps that expire every 7 days", refreshed on-device over Wi-Fi (https://docs.sidestore.io/docs/faq). It works for enthusiasts; it's poor for normal users.
  - Sideloadly and similar tools are the same.
- **EU alternative marketplaces (AltStore PAL etc.):**
  - Still needs the paid account and **notarization** via App Store Connect; the developer hosts the ADP (https://faq.altstore.io/developers/distribute-with-altstore-pal).
  - From **2026-10-01** the Core Technology Commission (5%) replaces the Core Technology Fee and applies only to sales, so **free apps pay nothing** (https://developer.apple.com/support/dma-and-apps-in-the-eu/).
  - It only reaches EU users (PAL also lists Japan and Brazil).

## 4. A fully native iOS chdman

### Existing apps: none found that create CHDs
- **App Store:** iTunes Search API queries "chdman", "chd converter", "iso to chd", "chd" (2026-09-28) returned no CHD tools.
- **GitHub:** repository search `chdman ios` and `chd converter swift iOS` returned 0 results. 91 `chdman` repos exist: Windows/macOS/Linux front ends, an **Android port** (https://github.com/Pipetto-crypto/Chdman, "A chdman port for Android. Heavily work-in-progress"), and a macOS SwiftUI front end that needs Homebrew chdman (https://github.com/iTechMedic/Swift-CHD).
- **RetroArch:** an open feature request (2025-02-05) asks for a "CHDman core" on iOS, with no response (https://github.com/libretro/RetroArch/issues/17523).
- **Emulators read CHD but don't create it:**
  - Gamma (PS1) lists "CHD, PBP, ISO, and MDS" (App Store lookup id6499106870).
  - PPSSPP reads CHD since 1.17 and recommends `createdvd` (https://www.ppsspp.org/news/release-1.17/).
  - Manic EMU bundles libretro cores whose info files list chd; no conversion feature found in its App Store text (https://github.com/Manic-EMU/ManicEMU).
  - Delta, Folium, RetroArch and Provenance: no CHD-creation mention in App Store text (Provenance's lookup failed; unverified).

### Building chdman into an iOS app (estimate)
- **Build.**
  - `wasm/Makefile`'s `native` target is plain gcc/g++ with `-lpthread`, `-DSDLMAME_LINUX`, and the SDL shim. For iOS, compile the same `sources.mk` lists with Xcode clang (`-target arm64-apple-ios`) into a static library, likely with `-DSDLMAME_MACOSX`/`SDLMAME_DARWIN`-style defines.
  - `osdsync.cpp` uses `std::thread`, so work queues get real threads (`effective_num_processors` / `-np`).
  - `posixptty.cpp` uses `ptsname_r` and `osdlib_unix.cpp` uses `dlopen`. Both exist on Darwin; build them or stub them.
  - Unverified.
- **API.**
  - `chdman.cpp` has no `exit()` calls, and natively `main` → `chdman_start`/`chdman_continue` runs straight through. So a thin C entry point `chdman_run(argc, argv)` on a background thread works.
  - Progress goes to stdout/stderr with `\r`, so capture it through a `pipe`+`dup2`, or add a callback.
  - chdman keeps global state; one job at a time.
- **Output fidelity:** unchanged. The engine's rules (byte-identical output, `engine/libm` for FLAC) apply to any native build, and the tests' native reference (`build/chdman-native`) is the same code.
- **UI.** Either reuse Discpress's JS UI in a WKWebView and call native chdman through a message handler (native speed, same UX), or write a SwiftUI UI. That's 1–3 weeks for something polished (estimate).
- **Advantages over the web page:**
  - native NEON/multithreading, which beats the wasm helper workers;
  - direct `FileHandle` I/O on security-scoped URLs from `UIDocumentPickerViewController`, so no OPFS copy and no export step;
  - `BGContinuedProcessingTask` (iOS 26) to keep converting in the background with a system progress UI.
- **Distribution:** the same as §3.

## 5. Shortcuts and automation
- **"Run JavaScript on Web Page"** takes only an active Safari page (or SFSafariViewController / ASWebAuthenticationSession) from the share sheet (https://support.apple.com/en-in/guide/shortcuts/apd218e2187d/ios). It can't reach Sitecase's WKWebView or its OPFS, and results must be small serialisable values. **It can't move a 1 GB file out of a page.**
- **Shortcuts file actions** (Save File etc.) handle files other apps hand to them. No app exposes its WebKit OPFS, and Shortcuts can't run wasm.
- **a-Shell's Shortcuts actions** can run commands "In App" (all commands, including the JSC `wasm`) or "In Extension" (light commands; `wasm` unavailable there, `wasm3`/`wasmkit` only) (a-Shell README §Shortcuts; `ExtraCommands.swift`). So a WASI chdman could be scripted from Shortcuts once it exists (§2).
- **Sitecase's Shortcuts** only open saved files.

## Sources not otherwise cited inline
- a-Shell source read locally (clone of https://github.com/holzschu/a-shell, master @ 2026-09-23): `wasm.js`, `a-Shell/AppDelegate.swift`, `a-Shell/ExtraCommands.swift`, `a-Shell/SceneDelegate.swift`, `Resources/node_modules/@wasmer/wasi/lib/index.js`, `Resources*/commandDictionary.plist`.
- WebKit source: https://github.com/WebKit/WebKit/tree/main/Source/WebKit/NetworkProcess/storage (`FileSystemStorageHandle.cpp`, `OriginStorageManager.cpp`, `NetworkStorageManager.cpp`).
- wasi-sdk tags (git ls-remote): wasi-sdk-30 2026-01-29, -31 2026-03-11, -32 2026-03-16, -33 2026-04-28.
- Repository facts: `wasm/Makefile`, `wasm/sources.mk`, `engine/README.md`, `engine/mame/src/osd/osdsync.cpp`, `engine/mame/src/tools/chdman.cpp`, `docs/chd/measurements.md`.
