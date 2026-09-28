# iOS / iPadOS limits for a heavy wasm web app (Discpress), L2 research

Research date: 2026-09-28. The current release is iOS/iPadOS 27 with Safari 27.0 (released 2026-09-17).
WebKit source quoted from `main` at commit `3095f6e16a4a1cd342675f9f4cffa6b53a4d48b2` (2026-09-28). Links use
`WK/` for `https://github.com/WebKit/WebKit/blob/3095f6e16a4a1cd342675f9f4cffa6b53a4d48b2/`. Older behaviour
comes from the `releases/Apple/Safari-*` tags in the same repository.

Confidence: **High** means read in WebKit source or in an official Apple/WebKit statement. **Medium** means one
credible measurement, or an inference from source that was not tested on a device. **Low / unverified** means
forum hearsay or my own estimate. Items I could not check are marked **UNVERIFIED**.

Context: Discpress runs every worker (the job worker, N helpers, and the reader/crc workers) as a thread of
**one WebContent process**. Each worker has its own JSC VM and its own wasm instance and linear memory. Its wasm
is linked with `-sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sINITIAL_MEMORY=16MB`, non-shared memory, and no
pthreads (`wasm/link.sh`). On iOS it runs in Safari (only when served over https, since iOS Safari cannot open
local HTML) or as a `file://` page inside a WKWebView file-viewer app such as Sitecase.

---

## 0. Summary table

| # | Limit (iOS/iPadOS) | Value | What it means for a 1–4 GB conversion | Conf. |
|---|---|---|---|---|
| 1 | WebContent process memory (the page, all workers, all wasm heaps, JIT code) | Set by the kernel (jetsam), not by WebKit, on iOS. A WebKit engineer describes a **soft limit of about 1.5 GB on iPhone**, which is enforced harder under memory pressure. Measured: about 1.5–3 GB on 6 GB iPhones (iOS 17); **ActiveHard 2048 MB** reported on iPhone 17 Pro (12 GB) with iOS 26.3–26.4.1; iPads get more. There is no `increased-memory-limit` entitlement for WebContent. | Never hold input or output in memory. The total footprint of all workers must stay well under 1.5 GB. The data streams through; only the hunk buffers live in memory. | High (mechanism), Medium (numbers) |
| 2 | What happens at the limit | SIGKILL: no exception and no `onerror`. Safari reloads the tab ("This webpage was reloaded because…"). WKWebView calls `webViewWebContentProcessDidTerminate:`; if the app doesn't handle it, WebKit **reloads once**, and after a second kill within 30 s it leaves the view blank. The host app survives. | All progress in memory is lost. OPFS files survive, partly written. You need a crash marker and resume or restart logic. | High |
| 3 | Host-app (UI process) memory | Ordinary app jetsam limit, e.g. **ActiveHard 2098 MB on 4 GB iPhones**. The host app is killed if it is handed a big payload. `navigator.share({files})` reads each file **whole into memory** and passes it to the host app. | The host app (Sitecase) dies when sharing a CHD of about 1 GB. The existing 512 MB `SHARE_MAX` is justified. | High (share code), Medium (limit numbers) |
| 4 | Typed-array and wasm address budget (Gigacage "Primitive" cage, per process) | **iOS ≤ 17: 2 GB for ALL ArrayBuffers and wasm memories together** (1.88 GB usable, measured on an 8 GB iPad). **iOS 18+: 16 GB of virtual space**, with each growable buffer able to reserve up to 4 GB. | On iOS 15.2–17.x, the heaps and JS buffers of all workers share about 1.8 GB even on a 16 GB iPad. | High |
| 5 | wasm "fast" (signal-handler bounds-checked) memories | iOS ≤ 17: **none**. iOS 18+: **3 per process** (8 on desktop). Other memories fall back to bounds-checked mode, where each `memory.grow` **allocates new memory and copies** (a peak of old + new). | The job worker plus 2 helpers get fast memory; helper 3 and later are slower and grow by copying. Size `INITIAL_MEMORY` so that it never grows. | High |
| 6 | wasm32 maximum, memory64 | wasm32: 65,536 pages (4 GiB) in JSC. **Memory64 has not shipped** in any iOS Safari up to 27.0 (it is in STP 251/252 and on by default in trunk). | 4 GB is theory; the real ceiling is the one in row 1. | High |
| 7 | wasm features | SIMD 16.4; legacy exceptions 15.2; exnref exceptions 18.4; tail calls and GC 18.2; JSPI **27.0**; runs without JIT (in-place interpreter) since 18.4; Safari 26 starts every module in the interpreter. | Discpress's floor (legacy EH, SIMD with fallback) means iOS 15.2+ works, and 16.4+ is fast. | High |
| 8 | JIT in WKWebView | Yes, for every app: WebContent carries WebKit's own JIT entitlements. **Lockdown Mode turns WebAssembly off completely** (`useWasm=false`). iOS 26.4 `WKSecurityRestrictionModeMaximizeCompatibility` (app opt-in) turns JIT off. | In Lockdown Mode, show "WebAssembly unavailable (Lockdown Mode)" rather than a generic "too old" error. | High |
| 9 | CPU / threads | `navigator.hardwareConcurrency` = **4 on every iPhone** (6 cores: 2 performance + 4 efficiency), 8 on iPads with 8+ cores. Low Power Mode costs about 40%. No limit on the number of workers. | Beyond 2–3 threads, extra helpers land on efficiency cores and add memory for little speed. | High (value), Medium (perf) |
| 10 | OPFS | `getDirectory` + `createSyncAccessHandle` since **15.2**. The sync handle's `getSize/truncate/flush/close` are synchronous only from **16.4**. `createWritable` from 26.0. **Private Browsing: `getDirectory()` rejects.** The sync handle does I/O directly on a file descriptor; quota is granted in 128 MB steps over IPC. | Target 16.4+. Detect a rejected getDirectory and fall back to memory, which is limited to small discs on iOS. | High |
| 11 | Storage quota (since iOS 17) | Browser apps (Safari): **60% of disk per origin, 80% overall**. Other apps (WKWebView apps such as Sitecase): **15% per origin, 20% overall**. Cross-origin iframe: 10% of that. `estimate()` since 17.0. | A 4 GB CHD fits on any 64 GB+ device (15% of 64 GB is 9.6 GB). Check `estimate()` before starting. | High |
| 12 | Eviction | Least-recently-used by origin when the overall quota is exceeded or disk space runs low. **ITP deletes all script-writable storage, OPFS included, after 7 days of Safari use without interaction** (Safari tabs). Home-screen web apps count their own days. `file://` pages are not tracked by ITP. `persist()` is granted only to home-screen web apps, app-bound domains and managed domains. | Don't leave finished CHDs in OPFS: save or download them promptly and delete them. | High (source), Medium (file:// inference) |
| 13 | Storage in `file://` WKWebView pages | Works: WebKit's `NeedsStorageAccessFromFileURLsQuirk` defaults to **true**, so localStorage, IndexedDB and OPFS are allowed. Every `file://` page in that app shares **one origin** (`file://`). A page loaded with an opaque origin (e.g. `loadHTMLString` with no base URL) gets **no** storage. | Works in Sitecase-type apps that use `loadFileURL`. Keep the memory fallback for apps that don't. | High (source), UNVERIFIED for Sitecase itself |
| 14 | Picked files (`<input type=file>`) | UIKit **imports (copies)** the file into the host app's `tmp`, then WebKit moves it into its own temp directory. It is deleted when the WKWebView is deallocated. If the move fails, UIKit deletes it about 60 s later. There is no size limit, but the app's container needs the space; an APFS clone is probably free for local files (UNVERIFIED). Reads from a worker (`FileReaderSync`, `Blob.slice`) are streamed through the Network process. | Picking a 4 GB file can take a while (iCloud, USB and SMB sources are downloaded in full first). A file can vanish mid-job, which is a plausible cause of the "worker can't read" failures seen in file-viewer apps. | High (code), Medium (failure hypothesis) |
| 15 | Background / screen lock | Once the page is hidden, WebKit gives the process **≤ 20 s** (prepare-to-suspend) and then **suspends it, workers included**. The app's own background task lasts **about 30 s**. A page playing **audible** media keeps a foreground assertion (Safari declares the audio background mode). While suspended, the process is a prime jetsam target. | A multi-minute conversion must stay in the foreground with the screen on. If the process survives, work resumes after unlock; if it was killed, the page reloads. | High (source) |
| 16 | Screen Wake Lock | Safari 16.4+. Home-screen web apps only from **18.4**. WKWebView apps: the source falls back to `UIApplication` idle-timer disabling, so it should work (UNVERIFIED on device). Needs user activation; released when the page is hidden. | Request it in the Start click handler and re-request it on `visibilitychange`. It stops auto-lock, not the power button. | High / Medium |
| 17 | Downloads and save | No `showSaveFilePicker` or `showDirectoryPicker` in Safari (so no StreamStore on iOS). In WKWebView apps a `download` only works if the host implements `WKDownload`. | Keep share (≤ 512 MB) plus download, plus an in-app "keep in storage, save later" option. | High |
| 18 | SharedArrayBuffer | Safari 15.2+, **only when cross-origin isolated** (COOP/COEP), which is impossible for `file://`. | No change: Discpress deliberately avoids SAB. | High |

**Safe budget recommendation (my synthesis, not a measured number, Medium/Low confidence):** total WebContent
footprint (all workers plus JS) **≤ about 700 MB on 4 GB iPhones** (iPhone 11–14, SE 3), **≤ about 1.2 GB on
6–8 GB iPhones** (13 Pro–16 Pro, 15 / 16 / 17), and **≤ about 1.5 GB on 8–16 GB iPads**, but **≤ about 1.5 GB of
ArrayBuffers plus wasm memories on any device running iOS ≤ 17**. Never plan to exceed 2 GB on an iPhone. With a
CD job (19,584-byte hunks) or a DVD job (hunks of a few KB), even with several hundred hunks in flight, a few hundred
MB is plenty. So the aim is
a small fixed heap per worker (for example 32–64 MB) with no growth, and only as many helpers as there are fast
memories.

---

## 1. Memory

### 1.1 How the WebContent limit is set on iOS

- **The kernel (jetsam) enforces it, not WebKit.** WebKit's own "websam" killer (`thresholdForMemoryKillOfActiveProcess`,
  7 GB + 1 GB per tab on 64-bit) only runs with `ENABLE(PERIODIC_MEMORY_MONITOR)`. That is 0 by default
  (`WK/Source/WTF/wtf/PlatformEnable.h#L473-L474`) and switched on only for the GTK, WPE, Windows and PlayStation
  CMake ports (`Source/cmake/Options{GTK,WPE,Win,PlayStation}.cmake`), not for Cocoa.
  (`WK/Source/WTF/wtf/MemoryPressureHandler.cpp#L111-L130`, `WK/Source/WebKit/WebProcess/WebProcess.cpp#L545-L566`). High.
- **The WebContent XPC service is a RunningBoard-managed "App"-type process**
  (`WK/Source/WebKit/WebProcess/EntryPoint/Cocoa/XPCService/WebContentService/Info-iOS.plist`: `_ProcessType App`,
  `RunningBoard Managed`, `UIBackgroundModes audio`). Its limit comes from the OS's per-device jetsam configuration,
  which is not public. Its entitlements include `com.apple.developer.kernel.extended-virtual-addressing`,
  `com.apple.developer.cs.allow-jit` (iOS 17.4+ SDK) and `com.apple.private.verified-jit`, but **not**
  `com.apple.developer.kernel.increased-memory-limit`
  (`WK/Source/WebKit/Scripts/process-entitlements.sh#L470-L486`). High.
- **WebKit reads the limit and scales its caches to it.** On iOS, `WTF::ramSize()` = min(physical RAM, the
  process's `memlimit_active` from `memorystatus_control(MEMORYSTATUS_CMD_GET_MEMLIMIT_PROPERTIES)`), rounded up to
  a multiple of 128 MB (`WK/Source/WTF/wtf/AvailableMemory.cpp#L88-L151`). The memory-pressure policy uses base =
  min(3 GB, ramSize); on iOS it releases caches at 50% ("conservative") and 65% ("strict") of that
  (`MemoryPressureHandler.cpp#L47-L53`, `#L378`). It also reacts to the kernel's `DISPATCH_MEMORYPRESSURE_PROC_LIMIT_WARN`
  and `_CRITICAL` events (`WK/Source/WTF/wtf/cocoa/MemoryPressureHandlerCocoa.mm#L95-L121`). Freeing caches does
  not free wasm heaps, so for Discpress the jetsam limit is the hard wall. High.
- **Page JavaScript cannot read the limit.** `navigator.deviceMemory` is not implemented in Safari (MDN BCD
  `api/Navigator.json`). Probing by allocating is what gets the page killed. High.

### 1.2 Numbers

| Device / OS | Observation | Source | Conf. |
|---|---|---|---|
| iPhone (general), 2024 | "WebContent processes on iPhone are subject to a 'soft' limit of around 1.5GB; if they use more than this amount of memory, they are subject to getting killed by 'jetsam'… you should design your web content to not exceed the 1.5GB limit." (Simon Fraser, WebKit) | https://bugs.webkit.org/show_bug.cgi?id=277848 | High |
| iPhone 12 Pro (6 GB), iOS 17.5.1 | About 3 GB right after a reboot, about 1.5 GB after 2–3 days; iPhone 15 Pro / Pro Max about 3 GB | same bug (reporter) | Medium |
| iPhone 17 Pro (12 GB), iOS 26.3 / 26.4 / 26.4.1 | WebContent killed at "ActiveHard 2048 MB" in both Safari and WKWebView; the same page is stable on iPads (iPad Pro 2018 and 2025), so iPads appear to get a bigger budget | Apple Developer Forums, WebKit tag (https://developer.apple.com/forums/tags/webkit?page=2). Seen only through search-engine snippets; I could not open the thread itself. | Low–Medium, **UNVERIFIED** |
| iPad Pro M1 8 GB, iOS 17 | Only 1.88 GB allocatable as `Uint8Array`: the "Gigacage… currently supports only 2GB of allocations on iOS" (Ben Nham, WebKit) | https://bugs.webkit.org/show_bug.cgi?id=268816 | High |
| iPhone SE 3 (4 GB) and iPad 8th gen (3 GB), iOS 26.2 | A page that builds a JS array of characters crashes at about "100 MB" (SE) and about "200 MB" (iPad) of text. The array costs about 8 bytes per character, so the real footprint is roughly 0.8–1.6 GB (my estimate). | https://lapcatsoftware.com/articles/2026/1/7.html | Medium (the numbers need careful reading) |
| iPhone 14 Pro Max (6 GB), iOS 26.6.2 | "expect roughly 1.5–3 GB, varying day to day. Not measured yet" | https://github.com/Nehanth/pooled/issues/207 (secondary) | Low |
| iPhone 16 Pro, iOS 26.6.2 | The WebContent process was killed by jetsam within 5–6 s because the OMG wasm compiler spiked memory (about 4 GB on macOS) on functions larger than 40 KB | https://github.com/frankhinek/webkit-wasm-compiler-memory-repro (WebKit bug 304810) | Medium |
| Native apps on 4 GB iPhones (X, XS, 12, 12 mini) | `EXC_RESOURCE … ActiveHard 2098 MB` | https://developer.apple.com/forums/thread/688973 | Medium |
| Native app with `increased-memory-limit`, iPhone 13 (4 GB) | `os_proc_available_memory` about 2.2–2.3 GB; iPad Pro 11" (4 GB) about 2.8 GB | https://developer.apple.com/forums/thread/702400 | Medium |

Reject the "300–450 MB for iPhone 13/14" table in https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit:
it contradicts the WebKit engineer's statement and the measurements above. Low.

### 1.3 What the user sees when WebContent is killed

- **Safari:** the tab reloads with a banner ("This webpage was reloaded because it was using significant memory",
  or "…because a problem occurred"). If it happens repeatedly, Safari shows "A problem repeatedly occurred". No JS
  exception, `pagehide` or `beforeunload` fires. (https://discussions.apple.com/thread/252354711,
  https://developer.apple.com/forums/thread/766309; the lapcat article confirms that "try-catch blocks don't help".) Medium.
- **WKWebView app:** WebKit calls the navigation delegate's `webViewWebContentProcessDidTerminate:`. If the
  app does **not** handle it (and the reason is Crash, ExceededMemoryLimit, Unresponsive, …), WebKit
  **reloads the page once** when the view is visible; after `maximumWebProcessRelaunchAttempts = 1` within
  `resetRecentCrashCountDelay = 30 s` it gives up and the view stays blank
  (`WK/Source/WebKit/UIProcess/WebPageProxy.cpp#L552-L553`, `#L14369-L14435`). If the app handles it, the app
  decides (blank view, its own reload, …). Whether Sitecase implements the delegate is **UNVERIFIED**. High (WebKit behaviour).
- **The host app is not killed by a WebContent kill.** They are separate processes. It can die from its own
  footprint, for example the share sheet: `ShareDataReader` reads every shared file with
  `FileReaderLoader::ReadAsArrayBuffer`
  (`WK/Source/WebCore/page/ShareDataReader.cpp#L52-L59`) and the data then goes to the UI process. That matches
  Discpress commit `b25d04d` (Sitecase closed when sharing a CHD over 1 GB). High.
- **After a reload, every `File` the user picked is gone**, and the temp copies are removed when the web view is
  deallocated (see 4.1). OPFS contents remain. The sync access handle's lock is released when the dead process's
  connection closes (`WK/Source/WebKit/NetworkProcess/storage/FileSystemStorageManager.cpp#L151-L166`). High.

### 1.4 The host app (UI process)

It is an ordinary app under jetsam: about 2 GB ActiveHard on 4 GB iPhones (above). In the background it can be
killed at any time, and background apps have lower limits ("vm-pageshortage: … free background process memory for
the current foreground app"; https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports).
When the host app is killed or suspended, its WebContent process goes with it. High.

### 1.5 Per-worker costs (in the same WebContent process)

- **Compiled wasm code is shared** when the same `WebAssembly.Module` is posted to workers, as Discpress does
  (`app/ui.js#L265-L272`, `app/worker.js#L22-L25`). JSC keeps one `CalleeGroup` per *memory mode* on the Module
  (`WK/Source/JavaScriptCore/wasm/WasmModule.h#L84-L101`), so there are at most **two copies of the JIT code**: one
  for fast (Signaling) memories and one for bounds-checked ones. High.
- **Linear memory:** each instance has its own. Fast memory reserves 4 GiB plus 8 MiB of red zone of *virtual*
  space, but only the committed bytes count toward the footprint
  (`WK/Source/JavaScriptCore/runtime/OptionsList.h#L594-L599`, `WasmMemory.cpp#L187-L214`). Bounds-checked
  non-shared memory commits only its current size, and **`grow` = allocate the new size, `memcpy`, free the old one**
  (`WK/Source/JavaScriptCore/wasm/WasmMemory.cpp#L389-L411`), so growth briefly needs old + new. High.
- **The JSC VM and heap per worker:** a few MB each (**UNVERIFIED**; no WebKit-specific measurement found).
  The OMG tier-up compile uses temporary memory per compiling thread. Discpress's largest function is 26 KB
  (`build/chdman.wasm`: 1,587 functions, none over 40 KB, measured here). That is under the sizes that hit bug
  304810, but the risk is not zero. Medium.
- **JS-side buffers:** each `FileReaderSync` slice, `postMessage` copy (unless transferred) and staged chunk is a
  separate ArrayBuffer. They all count toward the footprint and, on iOS ≤ 17, toward the 2 GB cage. Blob data
  made in JS is copied into the Network process and then spilled to mapped files
  (`WK/Source/WebCore/platform/network/BlobRegistryImpl.cpp#L156-L177`). Medium–High.
- **WebKit's own wasm budget** (`BufferMemoryManager::memoryLimit()` = 3 × ramSize,
  `WK/Source/JavaScriptCore/runtime/BufferMemoryHandle.h#L113-L118`) is never the binding limit. High.

---

## 2. WebAssembly on iOS

### 2.1 Memory size and address space
- **wasm32 cap:** `maxMemory32PageCount = 64 * 1024` pages, i.e. 4 GiB (`WK/Source/JavaScriptCore/runtime/PageCount.h#L124-L127`).
  An ArrayBuffer can be up to 2^34 bytes on 64-bit (`PageCount.h#L36-L44`). High.
- **The Gigacage "Primitive" cage holds every ArrayBuffer and wasm memory in the process:**
  - Safari ≤ 17.x on iOS: `primitiveGigacageSize = (hasCapacityToUseLargeGigacage ? 32 : 2) GB`, which is 2 GB on
    iOS because `BOS_EFFECTIVE_ADDRESS_WIDTH` ≤ 36 there
    (tag `releases/Apple/Safari-17.6-iOS-17.6`, `Source/bmalloc/bmalloc/Gigacage.h#L67-L71`). WebKit confirms it
    in bug 268816 (1.88 GB usable on an 8 GB iPad). High.
  - Safari 18.0+: `(… ? 64 : 16) GB`, i.e. **16 GB on iOS** (tag `Safari-18-iOS-18.0`, `Gigacage.h#L65-L69`). Trunk
    hard-codes `hasCapacityToUseLargeGigacage = false` for `IOS_FAMILY`, with a 16 GB budget, and one growable
    buffer may reserve at most budget / 4 = **4 GB** (`WK/Source/bmalloc/bmalloc/Gigacage.h#L57-L67`,
    `WK/Source/JavaScriptCore/runtime/BufferMemoryHandle.h#L63-L66`). High.
- **Fast memory:** it is only possible where the large cage exists (`canUseWebAssemblyFastMemory()` =
  `hasCapacityToUseLargeGigacage`), so it was **off on iOS through 17.x** (tag 17.6 `OptionsList.h#L513`). Bug 272232
  ("[JSC] Enable wasm fast-memory on iOS", landed 2024-04-05 as 277124@main) turned it on for Safari 18
  (https://bugs.webkit.org/show_bug.cgi?id=272232). **`maxNumWasmFastMemories = 3` on iOS (8 elsewhere)**
  (`OptionsList.h#L599`, tag 18.0 `#L519`). The count is process-wide (`BufferMemoryManager` singleton,
  `WK/Source/JavaScriptCore/runtime/BufferMemoryHandle.cpp#L86-L102`). The 4th and later memories silently use
  bounds-checked mode (`WasmMemory.cpp#L187-L245`). High.
- **Discpress's `MAXIMUM_MEMORY=2GB` is harmless for non-shared memory:** the bounds-checked non-shared path
  allocates only the initial size (tag 16.4 `WasmMemory.cpp#L207-L211`; trunk `#L235-L245`). The failure Godot
  reported ("maximum 2048MB… Out of Memory" on iOS 16.2) involved **shared** memory with threads, which reserves the
  maximum up front (`WasmMemory.cpp#L246-L273`; https://github.com/godotengine/godot/issues/70621). High / Medium.
- **Memory64:** not in any shipping iOS Safari up to 27.0. It appears as "flag, Safari Technology Preview 251"
  (https://github.com/WebAssembly/website/blob/main/features.json). STP 252 added memory64 with multi-memory
  (https://webkit.org/blog/18304/release-notes-for-safari-technology-preview-252/). The Safari 27.0 notes list JSPI
  but not memory64 (https://webkit.org/blog/18325/webkit-features-for-safari-27-0/). Trunk now has
  `WasmMemory64Enabled … defaultValue: true` (`WK/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml#L6795-L6804`),
  so a Safari 27.x or 28 release is likely (**UNVERIFIED**). Even then, Gigacage (4 GB per buffer) and jetsam apply. High.

### 2.2 Feature versions (Safari, iOS mirrors macOS)
From https://github.com/WebAssembly/website/blob/main/features.json and the WebKit release notes:
SIMD **16.4** (https://webkit.org/blog/13966/webkit-features-in-safari-16-4/); legacy exceptions **15.2**; the new
exnref exceptions **18.4** ("supersedes the legacy proposal, which WebKit supported since Safari 15.2 and will
continue to support", https://webkit.org/blog/16574/webkit-features-in-safari-18-4/); bulk memory and reference types
15; threads 14.5 (iOS); tail calls and GC 18.2; extended-const 17.4; JS string builtins 26.2; resizable-buffer
Memory APIs 26.2; **JSPI 27.0**; relaxed SIMD behind a flag. Safari 18.4: "supports running Wasm when … JIT is
disabled". Safari 26.0: "WebAssembly is first evaluated by our new in-place interpreter… launch even faster and use
less memory" (https://webkit.org/blog/17333/webkit-features-in-safari-26-0/). High.

### 2.3 JIT in WKWebView and its exceptions
- JIT is available to **every** WKWebView app, because the WebContent XPC service carries WebKit's own
  `com.apple.developer.cs.allow-jit` / `dynamic-codesigning` entitlements, independent of the host app
  (`process-entitlements.sh#L470-L486`). High.
- **Lockdown Mode:** `JSC::ExecutableAllocator::disableJIT(); … JSC::Options::useWasm() = false;`, so
  **`WebAssembly` is undefined** (`WK/Source/WebKit/Shared/EntryPointUtilities/Cocoa/XPCService/XPCServiceEntryPoint.mm#L208-L220`).
  This applies to Safari and to WKWebView apps (the system sets `WKSecurityRestrictionModeLockdown`). High.
- **iOS 26.4 API `WKWebpagePreferences.securityRestrictionMode`:** `MaximizeCompatibility` means "JavaScript JIT
  compilation disabled (interpreter-only execution)" (`WK/Source/WebKit/UIProcess/API/Cocoa/WKWebpagePreferences.h#L61-L72`,
  `#L119-L129`). A host app that opts in runs wasm in the interpreter only (many times slower; **UNVERIFIED** factor).
  The `disable-jit` bootstrap flag and the "Enhanced Security" process (`XPCServiceEntryPoint.mm#L221-L225`) do the
  same. Trunk has `EnhancedSecurityHeuristicsEnabled` ("Triggers EnhancedSecurity when insecure HTTP loads
  occur", `UnifiedWebPreferences.yaml#L2068-L2077`); it doesn't apply to `file://` or https. So **serve any hosted copy
  over https**. Medium.

### 2.4 Performance notes
- `navigator.hardwareConcurrency` is 4 when the device has fewer than 8 cores and 8 otherwise
  (`WK/Source/WebCore/page/NavigatorBase.cpp#L185-L197`). All iPhones report **4**; they have 6 cores (2 performance
  + 4 efficiency, e.g. A16/A17 Pro, https://en.wikipedia.org/wiki/Apple_A17). Scripts that WebKit classifies as
  fingerprinting get 4 or 8 regardless (Safari 26). High.
- Low Power Mode costs about 40% in Geekbench and pushes work to the efficiency cores
  (https://www.techlicious.com/blog/iphone-low-power-mode-slows-your-phone/). Sustained all-core load throttles
  thermally (**UNVERIFIED** magnitude). This repo's `docs/chd/fork-plan.md` already notes "iPhones exposing 2
  performance cores". Medium.
- Helpers beyond the 3rd wasm memory run bounds-checked code. That is typically a few percent to about 15% slower
  (**UNVERIFIED** on iOS), and they also cost a second JIT code set.

---

## 3. Storage

### 3.1 OPFS support by version (MDN BCD, https://github.com/mdn/browser-compat-data `api/FileSystem*.json`, `api/StorageManager.json`)
| API | Safari / iOS |
|---|---|
| `navigator.storage.getDirectory()`, `FileSystemFileHandle.createSyncAccessHandle()`, sync `read`/`write` | 15.2 |
| `FileSystemSyncAccessHandle.getSize/truncate/flush/close` as **synchronous** methods (they returned promises before) | **16.4** |
| `createSyncAccessHandle({mode})` (`readwrite-unsafe` etc.) | not supported |
| `FileSystemFileHandle.createWritable()` / `FileSystemWritableFileStream` | 26.0 |
| `StorageManager.estimate()` | 17.0 (Storage API "fully supported" in 17.0, https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) |
| `persist()` / `persisted()` | 15.2 (grants follow heuristics, see 3.3) |
| `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` | **not supported** |

High. Implementation: WebContent gets a real file handle and does `read`/`write` itself. Space is requested from the
Network process in **128 MB capacity steps** (`WK/Source/WebCore/Modules/filesystem/FileSystemSyncAccessHandle.cpp#L183-L202`,
`WK/Source/WebKit/NetworkProcess/storage/FileSystemStorageHandle.cpp#L43`, `#L527-L545`). So writes are local-file
speed with one synchronous IPC per 128 MB. Throughput numbers for iOS: **UNVERIFIED** (none found).

**Private Browsing / non-persistent data stores:** the storage path is empty and `createHandle` returns
`FileSystemStorageError::Unknown`, so `getDirectory()` rejects
(`WK/Source/WebKit/NetworkProcess/storage/FileSystemStorageManager.cpp#L77-L82`,
`OriginStorageManager.cpp#L208-L214`). PowerSync reports the same: "Incognito mode on Safari does not support OPFS"
(https://powersync.com/blog/sqlite-persistence-on-the-web). High.

### 3.2 Quotas (iOS 17+)
From "Updates to Storage Policy" (https://webkit.org/blog/14403/updates-to-storage-policy/) and the source
(`WK/Source/WebKit/UIProcess/WebsiteData/Cocoa/WebsiteDataStoreCocoa.mm#L80-L83`, `#L925-L933`):
- **Browser apps** (apps that can be the default browser, Safari included): origin quota **60%** of total disk,
  overall **80%**.
- **Other apps** (all ordinary WKWebView apps such as Sitecase): origin **15%**, overall **20%**.
- Cross-origin frame: 10% of the origin quota. Home-screen web apps get the same quotas as the browser.
- The disk size is rounded up to a whole GB (`NetworkStorageManager.cpp#L101`, `#L758-L785`). `estimate()` reports a
  "standard" quota to limit fingerprinting, and "quota might change based on factors like existing usage and site
  visit frequency". Writes beyond it throw `QuotaExceededError`. Before iOS 17 an origin started at 1 GB; Safari
  prompted for more, while home-screen apps simply failed (Safari 17.0 notes). High.

Example: 128 GB iPhone, WKWebView app: about 19 GB per origin and about 25.6 GB for the whole app. Safari: about 77 GB.

### 3.3 Eviction, ITP 7-day cap, persist()
- LRU eviction by origin when the overall quota is exceeded, when the system is under storage pressure, or through
  ITP. Origins with an active page or persistent mode are skipped (storage-policy post). High.
- **ITP 7-day cap:** "deleting all of a website's script-writable storage after seven days of Safari use without user
  interaction on the site" (https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/). The monitored
  types include **`WebsiteDataType::FileSystem` (OPFS)**
  (`WK/Source/WebKit/NetworkProcess/Classifier/WebResourceLoadStatisticsStore.cpp#L66-L80`). "Web applications added to the
  home screen are not part of Safari and thus have their own counter of days of use… We do not expect the first-party
  in such a web application to have its website data deleted." High.
- ITP is **on by default in third-party WKWebView apps** built with the iOS 14+ SDK unless they ask for tracking
  permission (`WK/Source/WebKit/Shared/Cocoa/DefaultWebBrowserChecks.mm#L120-L125`). But **`file://` pages are never
  recorded** (`WebResourceLoadObserver.cpp#L377`: `if (url.protocolIsAbout() || url.protocolIsFile() …) return`), so
  I infer that a `file://` origin never enters ITP's deletion list. Medium (inference).
- A separate time-based eviction (**180 days**) applies only to browsers with ITP off
  (`WK/Source/WebKit/UIProcess/WebsiteData/WebsiteDataStore.cpp#L1996-L2004`, `WebsiteDataStoreConfiguration.h#L334`). High.
- **`persist()`** is granted only if the origin's registrable domain is in `domainsExemptFromWebsiteDataDeletion()`:
  app-bound domains ∪ MDM-managed domains ∪ embedder-set persisted domains ∪ **the standalone (home-screen) web app's
  domain** (`WK/Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp#L914-L948`,
  `Classifier/ResourceLoadStatisticsStore.cpp#L786-L798`). So it returns `false` in Safari tabs and, in practice, for
  `file://` in apps (the registrable domain is empty; inference). It returns `true` in home-screen web apps.
  High (source), Medium (file:// case).

### 3.4 `file://` pages in a WKWebView (`loadFileURL:allowingReadAccessToURL:`)
- A `file:` URL gets the tuple origin (`"file"`, `""`, no port), not an opaque one
  (`WK/Source/WebCore/page/SecurityOriginData.cpp#L83-L101`). So **every `file://` document in that app shares one
  storage origin**: two different HTML files in Sitecase see each other's OPFS and localStorage. Medium–High.
- Storage APIs are refused for "local" origins **unless** `needsStorageAccessFromFileURLsQuirk` or universal access is
  set (`WK/Source/WebCore/dom/ScriptExecutionContext.cpp#L941-L970`). **The quirk defaults to `true`**
  (`UnifiedWebPreferences.yaml#L4399-L4403`, `WK/Source/WebKit/UIProcess/API/APIPageConfiguration.h#L653`,
  applied at `WKWebView.mm#L854`). Workers inherit it (`WK/Source/WebCore/workers/WorkerGlobalScope.cpp#L140-L141`).
  So localStorage, IndexedDB and OPFS **work** in `file://` pages of ordinary apps. An app can switch the quirk off
  through private SPI (`_setNeedsStorageAccessFromFileURLsQuirk:`). High.
- `file:` and app-defined custom schemes count as potentially trustworthy (secure context), so `[SecureContext]` APIs
  such as `navigator.storage` are exposed (`WK/Source/WebCore/page/SecurityOrigin.cpp#L90-L105`). High.
- An **opaque origin** (e.g. `loadHTMLString:` with a nil base URL, or a sandboxed iframe) gets
  `HasResourceAccess::No`, so there is no storage at all (`ScriptExecutionContext.cpp#L948-L950`). Discpress must keep
  its MemStore fallback. Which method Sitecase uses is **UNVERIFIED** (its App Store page:
  https://apps.apple.com/gh/app/sitecase/id6762896369).
- **When the app is closed:** OPFS data is ordinary files in the app's website-data directory. They survive app
  termination and device reboot, and are removed by eviction (above), by "clear website data" in the app, or by
  deleting the app. The picked-file temp copies do **not** survive (4.1). High (general WebKit design); exact
  directory **UNVERIFIED**.

---

## 4. Reading user-picked files

### 4.1 How `<input type=file>` delivers a file (Safari and WKWebView are the same code: `WKFileUploadPanel`)
- Files are picked with `UIDocumentPickerViewController … inMode:UIDocumentPickerModeImport`
  (`UIDocumentPickerModeOpen` only for `webkitdirectory`) (`WK/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm#L860-L881`).
  **Import mode copies the file into the host app's sandbox.** WebKit then *moves* that copy into a new temp
  directory created with `FileSystem::createTemporaryDirectory(@"WKFileUploadPanel")` in the host app's tmp. For
  directory picks it *copies* instead. "If moving/copying fails, keep the original URL and our 60 second time limit
  for file URLs from UIKit before it is deleted" (`WKFileUploadPanel.mm#L1008-L1043`, `#L1383-L1413`). These temp
  directories are removed "when deallocated" (`_removeTemporaryDirectoriesWhenDeallocated`, `#L1037`). High.
- **Size and memory:** no size limit in the code, and the file is not loaded into memory; it is a file on disk. The
  copy needs free space in the app container, unless APFS clones it: Apple documents that FileManager copies on APFS
  are clones, which should apply to local "On My iPhone" files (**UNVERIFIED** on this path). Files from iCloud Drive
  (not downloaded), USB drives, SMB or third-party providers are **downloaded or copied in full before `change`
  fires**. For a 4 GB image that can take minutes with no progress shown in the page. Medium.
- The WebContent process gets read-only sandbox extensions, and the Network process is told
  `AllowFilesAccessFromWebProcess` (`WK/Source/WebKit/UIProcess/WebPageProxy.cpp#L13512-L13541`). High.
- `webkitdirectory` works from iOS 18.4; before that it had no effect (MDN BCD `api/HTMLInputElement.json`). High.

### 4.2 Reading from workers
- `FileReaderSync` in workers has been supported since Safari 6, and `Blob.slice` and `Blob.stream()` (14.1) work;
  reads of a file-backed Blob go through a blob load (MDN BCD). Each read creates a new ArrayBuffer (memory; ≤ 17:
  Gigacage). High.
- Known failure modes that match Discpress's "worker can't read the picked files in some file-viewer apps"
  (hypotheses, **UNVERIFIED**):
  (a) the move out of UIKit's Inbox failed, so UIKit deleted the file about 60 s later, in the middle of the job;
  (b) the host app cleans its own `tmp` (on foregrounding or launch);
  (c) the page has an opaque or custom-scheme origin, or the app uses a non-persistent data store, which changes
  blob and storage access;
  (d) the app recreates its WKWebView (for example after backgrounding), which deletes the temp copies.
  Discpress's `stage-request` streaming protects against (a) only if the page reads before the deletion. Copying the
  input into OPFS first (the "stage 1" path) protects against all four.

---

## 5. Execution: screen lock, app switch, keeping a job alive

### 5.1 What happens
- **A hidden page loses its "visible" activity** (`WebPageProxy::updateThrottleState`,
  `WK/Source/WebKit/UIProcess/WebPageProxy.cpp#L3863-L3929`). When the WebContent process has no foreground or
  background activity left, the UI process sends `PrepareToSuspend` and starts a **20 s** timer
  (`processSuspensionTimeout { 20_s }`, `WK/Source/WebKit/UIProcess/ProcessThrottler.cpp#L49-L50`, `#L391-L397`).
  The process is then **suspended**: all its threads freeze, including every worker and wasm computation. High.
- **The app itself** (Safari, or the host app) takes a UIKit background task when sent to the background. On iOS
  "The background assertions time out after 30 seconds" (`WK/Source/WebKit/UIProcess/Cocoa/ProcessAssertionCocoa.mm#L341-L346`).
  Quinn (Apple DTS) measured 30 s on iOS 13.x (https://developer.apple.com/forums/thread/125162). After that the
  host app is suspended too. High.
- **Screen lock, the power button or an app switch** therefore stops the conversion within a few seconds (at most
  about 20–30 s). Switching tabs inside Safari does the same, because the page becomes hidden. **A suspended process
  keeps its state.** If it survives, the job continues after unlock. A suspended process with a large footprint is
  the first to be jetsammed, and then the page reloads when shown. High (mechanism), Medium (likelihood).
- **The audible-media exception:** while a page `IsAudible`, WebKit holds a foreground assertion
  (`WebPageProxy.cpp#L3891-L3906`) and releases it 10 s after audio stops (`audibleActivityClearDelay = 10_s`, `#L577`).
  For `<audio>`, "audible" means playing, not muted and `volume() > 0`; the samples are not inspected
  (`WK/Source/WebCore/html/HTMLMediaElement.cpp#L9564-L9580`, `#L9918-L9922`). The WebContent service declares
  `UIBackgroundModes audio`, and Safari plays audio in the background. So **looping a silent audio file, started by
  the Start tap, very likely keeps a Safari tab computing with the screen locked** (**UNVERIFIED** on device; it will
  show in Now Playing and uses battery). In a WKWebView app it works only if the *host app* has the audio background
  mode and a playback audio session (**UNVERIFIED**; most viewer apps won't).
- WebKit's background CPU-limit kill (`ExceededCPULimit`) applies only to pages configured with a CPU limit
  (Safari/macOS SPI) and is skipped for visible or audible pages (`WK/Source/WebKit/UIProcess/WebProcessProxy.cpp#L2610-L2644`).
  Not a factor for foreground iOS pages. High.

### 5.2 Screen Wake Lock
- Safari 16.4 (https://webkit.org/blog/13966/webkit-features-in-safari-16-4/). **In home-screen web apps only from
  iOS 18.4** ("Fixed Screen Wake Lock API for Home Screen Web Apps", https://webkit.org/blog/16574/webkit-features-in-safari-18-4/;
  MDN BCD: 16.4–18.4 "Does not work in standalone Home Screen Web Apps", bug 254545). High.
- The request is rejected if the document is hidden, or if there is no permission and no transient activation
  (`WK/Source/WebCore/Modules/screen-wake-lock/WakeLock.cpp#L62-L98`). It is released when the page becomes hidden
  (`WakeLockManager.cpp#L98-L103`). So **call it inside the Start click and re-acquire it on `visibilitychange`**. High.
- **In WKWebView apps:** the UI process asks the app's private `_webView:setShouldKeepScreenAwake:` and, **if the app
  doesn't implement it, disables the idle timer itself** with `UIApplication _setIdleTimerDisabled:forReason:`
  (`WK/Source/WebKit/UIProcess/ios/WebProcessProxyIOS.mm#L54-L72`,
  `WK/Source/WebCore/PAL/pal/system/ios/SleepDisablerIOS.mm`). So it should work in Sitecase-type apps (**UNVERIFIED**
  on device). A wake lock only stops *auto*-lock; the power button still suspends everything.

### 5.3 Keeping a job alive or resuming it (engineering)
1. Take the wake lock at Start, show a "keep this screen open" banner, and listen to `visibilitychange` and
   `pagehide` to pause the UI and log the interruption.
2. Write a `running` marker (localStorage, or a tiny OPFS file) with the job description before starting, and clear
   it at the end. On load, a leftover marker means the process was killed: show "the conversion was interrupted by
   iOS (memory or background)" and offer to restart. Nothing else detects a jetsam kill.
3. Make outputs resumable. chdman writes hunks in order and the map at the end, so a fork could checkpoint (hunk
   index, the compressor's CRC/SHA state, map-so-far) into OPFS every N MB and resume after a reload. This needs the
   inputs again: persist `File` handles is impossible on iOS, so the user must re-pick them, or the inputs must be
   staged into OPFS (which doubles disk use; §3.2 allows it).
4. For the Safari (https) build only: optional "keep running with screen locked" by playing silent audio (5.1),
   clearly labelled.

---

## 6. Home-screen web apps (standalone), iOS 16.4–27

| Aspect | vs a Safari tab | Source / conf. |
|---|---|---|
| Availability | Needs an https origin. Since iOS 26 **every site added to the Home Screen opens as a web app by default**, no manifest needed. A `file://` page inside another app cannot be added. | https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ High |
| Storage | Same quotas as the browser (60% / 80%). Separate from Safari's storage. ITP uses its own days-of-use counter, and first-party data is not expected to be deleted. `persist()` **granted** (the standalone domain is exempt). | storage-policy post; ITP post; `ResourceLoadStatisticsStore.cpp#L796-L797` High |
| Memory | Same kind of WebContent process; no evidence of a different limit. | **UNVERIFIED** |
| Workers, wasm, OPFS | Same engine and features. | High |
| File input | Same `WKFileUploadPanel`. | High |
| Wake Lock | **Broken 16.4–18.3, works from 18.4.** | High |
| Background | Suspended like Safari. Background audio in standalone mode: **UNVERIFIED** (26.2 fixed "audio element failed to play when re-opening a Home Screen Web App"). | Medium |
| Web Push, Badging | Only in home-screen web apps (16.4+). Not needed. | High |

---

## 7. Other limits that matter

- **Number of workers:** WebKit has no cap on dedicated workers (none found in `Source/WebCore/workers`). Each costs a
  thread, a VM and its wasm memory. Only 3 get fast memory (§2.1). High / Medium.
- **`postMessage` / MessageChannel:** everything is in one process, so there are no IPC size limits. Structured clone
  **copies** ArrayBuffers unless they are transferred, and a copy doubles the peak for that buffer. Transfer the
  staged chunks and hunk buffers. High (spec) / Medium.
- **Blob URLs:** worker scripts from Blob URLs work, including in `file://` origins (Discpress already does this). Big
  Blobs assembled in JS go to the Network process's memory, then to mapped files
  (`BlobRegistryImpl.cpp#L156-L177`). For outputs, hand out the `File` from an OPFS `getFile()` rather than
  `new Blob([...chunks])`. Medium.
- **Share sheet:** reads whole files into memory (§1.3). Keep `SHARE_MAX` at ≤ 512 MB or lower it on 4 GB devices. High.
- **Downloads in WKWebView apps:** with no `decidePolicyForNavigationAction` delegate, a `download` link becomes
  `listener->download()`. The file goes somewhere only if the app implements `webView:navigationAction:didBecomeDownload:`
  (WKDownload, iOS 14.5+) (`WK/Source/WebKit/UIProcess/Cocoa/NavigationState.mm#L600-L645`, `#L1400-L1413`).
  Whether Sitecase does is **UNVERIFIED**. Discpress should detect the failure: there is no event, so use a timeout
  plus a "didn't work? use Share or keep in storage" hint. High / Medium.
- **SharedArrayBuffer / COOP-COEP:** Safari 15.2+ exposes SAB only to cross-origin-isolated pages. That can't be done
  on `file://`; a WKWebView app could do it with a custom-scheme handler that sends the headers (**UNVERIFIED**). The
  current no-SAB design is right for iOS. High.
- **File System Access pickers:** absent, so there is no streaming to a user folder on iOS (MDN BCD `api/Window.json`). High.
- **Service workers:** not available to `file://`. In WKWebView apps they need App-Bound Domains. Irrelevant to
  Discpress offline. High.
- **OMG compiler memory spikes** (WebKit bug 304810, iOS 26.x): large functions can make tier-up allocate GBs.
  Discpress's biggest function is 26 KB (measured), below the 40 KB+ functions in the reproduction. Recheck after
  engine changes, and keep Asyncify out. Medium.
- **iOS Safari cannot open local HTML** from Files: Quick Look renders it without JavaScript
  (https://discussions.apple.com/thread/256102223). Hence the WKWebView-app route, or an https-hosted copy. Medium.

---

## 8. Concrete implications for Discpress (checklist)

1. **Memory plan (iOS):** job worker plus **at most 2 helpers** on iPhone. That uses the 3 fast memories and matches
   2 performance cores; `hardwareConcurrency` is 4 anyway. On iPads (report 8), allow more, but beyond 3 memories
   they run bounds-checked. Cap `Tuning`'s touch-device maximum of 8 accordingly on iOS WebKit.
2. **No heap growth:** give each helper a fixed heap (compute the need from hunk size × slots) and the job worker a
   fixed heap. Set `INITIAL_MEMORY` per role, or grow once at startup before other allocations. Growth of a
   bounds-checked memory copies the whole heap.
3. **Budget:** keep the sum of all heaps plus JS buffers below about 700 MB on 4 GB iPhones and about 1.2 GB on bigger
   ones. On iOS ≤ 17, keep all ArrayBuffers plus wasm memories below about 1.5 GB total (Gigacage).
4. **Crash detection and restart** (a `running` marker), plus optional resume via OPFS checkpoints (5.3).
5. **Wake Lock at Start**, re-acquired on visibility. Warn that locking the phone or switching apps pauses the job,
   and may kill it.
6. **OPFS first:** target 16.4+ for the synchronous handle API. Handle a `getDirectory()` rejection (Private
   Browsing, opaque origin) by falling back to memory with a size warning. Check `estimate()` against the expected
   output size plus the staged input. Delete outputs once they are saved (ITP 7-day cap in Safari; quota).
7. **Lockdown Mode:** detect `typeof WebAssembly === 'undefined'` and say so explicitly.
8. **Share ≤ 512 MB** (or about 256 MB on 4 GB devices). Beyond that, download (Safari) or "keep in app storage",
   and explain that downloads may not work in some viewer apps.
9. **Input robustness in viewer apps:** consider staging picked inputs into OPFS immediately (a clone-free copy costs
   disk space but survives temp cleanup and web view reloads).

---

## Sources (primary first)
- WebKit source, commit `3095f6e1` (paths above) and tags `releases/Apple/Safari-16.4-iOS-16.4`, `-17.4-iOS-17.4`,
  `-17.6-iOS-17.6`, `-18-iOS-18.0`, `-18.3.1-iOS-18.3.2`: https://github.com/WebKit/WebKit
- WebKit bugs: 277848 (1.5 GB soft limit), 268816 (2 GB Gigacage), 272232 (fast memory on iOS), 254545 (wake lock
  in web apps): https://bugs.webkit.org/
- WebKit blog: Updates to Storage Policy https://webkit.org/blog/14403/updates-to-storage-policy/ ; Full Third-Party
  Cookie Blocking and More https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ; Safari 16.4
  https://webkit.org/blog/13966/ ; 17.0 https://webkit.org/blog/14445/ ; 18.4 https://webkit.org/blog/16574/ ;
  26.0 https://webkit.org/blog/17333/ ; 26.2 https://webkit.org/blog/17640/ ; 26.6 https://webkit.org/blog/18178/ ;
  27.0 https://webkit.org/blog/18325/ ; STP 252 https://webkit.org/blog/18304/
- WebAssembly feature table: https://github.com/WebAssembly/website/blob/main/features.json
- MDN browser-compat-data: https://github.com/mdn/browser-compat-data (api/FileSystemSyncAccessHandle, FileSystemFileHandle,
  StorageManager, WakeLock, Navigator, Window, HTMLInputElement, javascript/builtins/SharedArrayBuffer)
- Apple: jetsam reports https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports ;
  forums 125162 (30 s background task), 688973, 702400, 766309, 801690
- Measurements and secondary sources: https://lapcatsoftware.com/articles/2026/1/7.html ;
  https://github.com/frankhinek/webkit-wasm-compiler-memory-repro ; https://github.com/godotengine/godot/issues/70621 ;
  https://github.com/Nehanth/pooled/issues/207 ; https://powersync.com/blog/sqlite-persistence-on-the-web ;
  https://www.techlicious.com/blog/iphone-low-power-mode-slows-your-phone/ ; https://discussions.apple.com/thread/256102223
- Discpress repo: `wasm/link.sh`, `app/ui.js#L258-L272`, `app/worker.js#L9-L33`, commit `b25d04d`; function sizes
  measured from `build/chdman.wasm` in this session.
