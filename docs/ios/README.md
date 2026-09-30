# Discpress on iPhone and iPad: what limits it, and the plan

Researched 2026-09-28 (iOS 26/27, Safari 27.0). Four reports sit next to this file; every claim below links to one of them, and they cite WebKit source (file:line), Apple and WebKit documents, and measurements:

- [export.md](export.md): every way a web page can hand a large file to the Files app, from WebKit's source.
- [limits.md](limits.md): memory, WebAssembly, storage, picked files and background limits.
- [hosting.md](hosting.md): serving Discpress over https (GitHub Pages and others) and as a home-screen web app.
- [apps-and-native.md](apps-and-native.md): HTML viewer apps, a-Shell, a native wrapper app, a native chdman.

## What happened

A user converted Crisis Core (PSP, a 1.6 GB `.iso`) on an iPhone in Sitecase, an App Store app that shows local HTML files in a web view. The page reported "Large files OK" (it has private disk storage there), identified the game by its checksum and made a 1.03 GB CHD in 1 min 42 s. Then the result could not leave the app:

1. **"Save to Files"** (the share sheet) closed Sitecase.
2. **"Download"** (added in PR #11 for results over 512 MB) showed "Erreur: Chargement du cadre interrompu" (Frame load interrupted).

## What the research found

**There are only two ways out of a web page into Files on iOS, and inside a viewer app like Sitecase neither works for large files.** ([export.md](export.md))

| | Safari | Home-screen web app | Viewer app (Sitecase) |
|---|---|---|---|
| Share sheet (`navigator.share` with files) | Works, but **the whole file is copied into memory 3 to 4 times**, once in the host app itself; files ≥ 4 GiB are refused | Same | Same: a 1 GB CHD gets the host app killed |
| Download (`<a download>` of the OPFS file) | **Streamed from disk to disk in 512 KiB pieces, no size limit**; lands in Files → Downloads | Unreliable (an "Open in…" card on iOS 18.4; unverified on 26) | **Only if the app implements WebKit downloads** (`WKDownload`, iOS 14.5+). Sitecase doesn't: error 102, "Frame load interrupted" |
| Save pickers (`showSaveFilePicker`) | Not in WebKit (position: oppose) | — | — |
| Service-worker download | Works from 15.4 (streamed), needs https | Unverified | Disabled for ordinary apps |

A page can't tell in advance whether downloads work; the best hint is an iOS user agent without the `Safari/` token (a web view), which the page already uses for its layout.

**iOS Safari can't run a local HTML file.** Tapping it in Files shows a Quick Look preview without JavaScript, Safari isn't offered to open it, and `file://` doesn't open. That's why the README sends iPhone users to viewer apps. ([hosting.md](hosting.md) §1)

**So the page has to be served from https for iPhone users to use Safari.** GitHub Pages is free, can be deployed from the existing release workflow, and needs no special headers, since Discpress uses no SharedArrayBuffer. Added to the Home Screen, it runs as a web app, and on iOS 26 every site added there opens as a web app by default. Home-screen web apps are exempt from Safari's 7-day storage deletion and can get persistent storage. ([hosting.md](hosting.md))

**Other iOS limits a 1–4 GB conversion runs into** ([limits.md](limits.md)):

- **Memory.**
  - The page and all its workers share one process. iOS kills that process at about 1.5 GB on iPhones (reports range from 1.5 to 3 GB), with no warning to the page. Safari reloads the tab; a viewer app reloads the page once, then shows it blank.
  - Up to iOS 17, all wasm heaps and ArrayBuffers together get 2 GB of address space, even on an 8 GB iPad.
- **WebAssembly.**
  - iOS 18+ gives fast memory to only 3 wasm instances per process. The others are bounds-checked, and each `memory.grow` copies the whole heap.
  - Every iPhone reports 4 cores (2 performance cores).
  - Discpress starts each heap at 16 MB and grows it, and allows up to 8 threads on touch devices.
  - Lockdown Mode turns WebAssembly off entirely.
- **Background.**
  - Once the page is hidden (screen lock, app switch), WebKit freezes it within 20 s, workers included, and a frozen process is a prime target for being killed.
  - Screen Wake Lock works in Safari 16.4+, and in home-screen web apps from 18.4.
- **Storage.**
  - OPFS with synchronous access handles works from 16.4.
  - Quotas: 60% of the disk per origin in Safari, 15% in other apps.
  - Safari deletes a site's storage after 7 days without a visit.
  - In viewer apps, every `file://` page shares one origin.
- **Picked files.** iOS copies each picked file into the host app's temporary folder, and it can be deleted while the page still reads it. That is a plausible cause of the "worker can't read the file" failures already seen in viewer apps.
- **After a reload.** Discpress deletes the previous session's files in private storage (`Store.cleanupStale`), and nothing on the page lists them any more. So a CHD that was finished but not yet saved when iOS reloaded the page is lost.

**Routes other than Safari** ([apps-and-native.md](apps-and-native.md)):

- **iCab Mobile ($2.99)** opens local HTML, supports `blob:` downloads (10.4+) and shows its downloads in Files. Every step is documented, but the whole chain is untested with a 1 GB file.
- **Sitecase is actively maintained** (v2.3.3, 2026-09-27; contact on sitecase.io). Adding downloads is about 50–100 lines in the app.
- **A thin native wrapper app** (WKWebView plus downloads into a Documents folder visible in Files) is 200–400 lines of Swift. It costs $99 a year for the App Store or TestFlight, with a review risk under guideline 4.2 ("repackaged website").
- **A fully native chdman app** would be the fastest, since the engine builds natively from `engine/`, but it means 1–3 weeks of UI work. No iOS app creates CHDs today.
- **a-Shell (WASI build)** is feasible but slow: every read and write crosses a text bridge, it runs single-threaded, and the app must stay in the foreground.
- **Rejected:** iSH and UTM (too slow), Shortcuts (can't do it), and "save in parts" (joining the parts needs a terminal).

## Plan

### Phase 0: in PR #11 (done)

- An identified PSP game is a DVD CHD, and the other type moves into Options.
- On iPhone and iPad, results over 512 MB skip the share sheet and download instead: that works in Safari, but not in Sitecase.

### Phase 1: an https copy for Safari (the main fix): done, deploys with the next release

**Status.**
- `release.yml` has a `pages` job that publishes the release file as `index.html` at https://powerbeef.github.io/discpress/, next to `web/` (`sw.js`, `manifest.webmanifest`, icons) and `discpress.html.sha256`, which the release also carries.
- The page adds the manifest, the PNG touch icon and the service worker only when served over https, so the file stays the same everywhere.
- The Content-Security-Policy with `connect-src 'none'` is in `app/index.html`.
- In an iPhone/iPad app's web view, a notice (`#iosTip`) points big games to the online version.
- README and Help send iPhone users to Safari.
- Tests: `tests/ui/hosted.spec.js`, `tests/ui/mobile.spec.js`.
- **One-time setup left:** Settings → Pages → Source: GitHub Actions.

The plan as it was:

1. **Publish the release file** byte for byte on GitHub Pages as `index.html`. Deploy it from a second job in `.github/workflows/release.yml` (a separate workflow triggered by the release would never run: [hosting.md](hosting.md) §2.1). Then:
   - enable Pages with source "GitHub Actions";
   - give the `github-pages` environment an allowed-tag rule for `v*`;
   - optionally add a custom domain. `powerbeef.github.io` is shared with every other PowerBeef project site, and so is its storage.
2. **Keep "nothing is uploaded" checkable.** Add a `Content-Security-Policy` meta tag with `connect-src 'none'` to `app/index.html` (it covers both the file and the hosted copy), and publish the file's SHA-256 with each release so anyone can compare the hosted copy.
3. **Make it an offline home-screen web app.** Add a manifest, icons and a small service worker that caches the one file and switches to a new version only when no job is running. The single-file download stays the main release for desktop and Android.
4. **In the page:**
   - in a viewer app, show a notice up front: large results can't be saved in this app; open the hosted copy in Safari instead;
   - in Safari, results over 512 MB download (already the case);
   - the Help page and README get new iPhone instructions: "open it in Safari, or add it to your Home Screen".
5. **Test on a device** (checklist below), including downloads from a home-screen web app.

### Phase 2: making big jobs survive on iOS (engine and page): done, except as noted

**Status.**
1. **Threads:** the speed test decides, as on other devices, trying at most 4 threads on iPhones (`iosThreadCap` in `app/ui.js`) and 8 on iPads.
   - **1.3.1** capped iPhones at 2 threads and iPads at 4, following the research, before measuring on a device.
   - **1.3.2** reverted this. Threads were not what closed Sitecase: the share sheet was. An iPhone 17 Pro converted the 1.6 GB PSP game in 1 min 42 s without the cap. A thread costs about 16 MB of memory, and the speed test runs on the device, so it already picks fewer threads where more don't help.
   - A stored speed test that stopped at the old cap is run again.
2. **Heaps:** not needed. Measured in the page (bench CD and 1 GB DVD, every preset): a helper's heap never grows past its initial 16 MB, and the job worker's peaks at 23–40 MB. Growth copies are small and rare.
3. **Wake lock:** already there. It is taken when a job starts and again whenever the page becomes visible. The Help page now says what iOS does when the phone is locked.
4. **Recovery:** done (`Recovery` in `app/ui.js`, `tests/ui/recovery.spec.js`). A record in `localStorage` lists the running job and the finished results not saved yet. At the next start, `Store.cleanupStale` keeps those results' folder, and the page lists them under "From your last visit" (Save or Delete), with the job that didn't finish.
5. **Staging inputs in viewer apps:** not done. The 1.6 GB job read its input for its whole run in Sitecase, and a copy would double the time and disk space of every job. The existing fallback remains: the page streams an input the worker can't read.
6. **Messages:** done. Lockdown Mode gets its own message, and a share-sheet read failure is no longer taken for the user closing the sheet.

The plan as it was:

1. **Threads.** Cap iOS WebKit at the job worker plus 2 helpers on iPhones (3 fast wasm memories, 2 performance cores); on iPads, go by the reported cores. Measure first: time and peak memory for a DVD at 1, 2 and 3 threads on a device.
2. **Heaps.** Give each worker a heap that doesn't grow: measure the peak per role and codec list, then start at that size. Growing a bounds-checked heap copies it.
3. **Keeping the phone awake.** Take a Screen Wake Lock when a job starts and again whenever the page becomes visible, and say that locking the phone or switching apps pauses the job and may stop it.
4. **Recovery after a reload.**
   - A job leaves a "running" marker in storage.
   - After a reload, the page says the job was stopped and offers to start it again.
   - Finished CHDs that weren't saved yet stay in private storage and are listed, instead of being deleted (`Store.cleanupStale`).
   - Saved results are deleted, as Safari's 7-day rule would delete them anyway.
5. **Inputs in viewer apps.** Copy picked inputs into private storage at the start when running in a web view, so iOS deleting its temporary copy can't break a job; check `estimate()` for the input plus the output.
6. **Clear messages.**
   - "WebAssembly is turned off (Lockdown Mode)".
   - A share-sheet read failure (`AbortError` with its own message, e.g. for files ≥ 4 GiB) reported as such, not taken for the user closing the sheet.

### Phase 3: outreach and alternatives (no code)

1. Ask the Sitecase developer to add downloads. The request would describe `shouldPerformDownload` → `.download`, a `WKDownloadDelegate` writing to Documents, and `UIFileSharingEnabled`/`LSSupportsOpeningDocumentsInPlace`. With that, Sitecase would work as is.
2. Test iCab Mobile end to end with a 1 GB result. If it works, list it in the README as the app to use for the downloaded file.

### Phase 4: only if there is demand

- A thin wrapper app: WKWebView, downloads to Documents shown in Files, TestFlight or App Store.
- Later, a native chdman app built from `engine/` (multithreaded, can keep working in the background on iOS 26).
- An a-Shell WASI build only as a curiosity.

## WebKit's WebAssembly compiler: "Out of bounds memory access"

A conversion in Playwright's WebKit once failed with "Multi-core compression failed (Out of bounds memory access (evaluating 'M._wasm_helper_compress(…)'))". Investigated (2026-09-30) with Playwright's Linux WebKit builds, the JSC options that force its optimizing tier early (`JSC_thresholdForOMGOptimizeAfterWarmUp=10` and the like, passed as environment variables), and the same PSP conversion in each:

| WebKit build | Normal settings | OMG tier forced early |
|---|---|---|
| 2024-09-25 (about Safari 18.0) | PSP and PS2 DVD conversions fail every time, 1 thread too | 24 of 24 fail |
| 2025-04-14 | | 0 of 24 |
| 2025-09-30 (about Safari 26.0) | rare | 11 of 54 fail or crash the page |
| 2026-01-14, 05-04, 07-20, 09-01 | | 0 of 24 each |

- Both are JSC bugs in its optimizing tier (OMG), not in the page. Every failure was a WebAssembly trap or a crash of the page's process, never a wrong CHD. The 2024 bug needs only OMG; the 2025 one needs OMG, the SIMD build and concurrent compilation together (without any of them: none in 40). Not memory: bounds-checked or mixed fast memories changed nothing. WebKit bug 316918 (SIMD inlined into non-SIMD code) is one such fix, but turning OMG inlining off didn't stop the 2025 crashes.
- These are x86-64 builds; iPhones and Apple silicon Macs compile with JSC's ARM64 backend, where the same bugs may or may not exist. A PSP or PS2 ISO converted on iOS 18.x and on early iOS 26 would tell.
- What the page does (`app/worker.js`, `app/ui.js`): a helper that traps is dropped and the others do its batches (the job worker keeps each batch until it is answered; with none left, extract and verify decompress in the job worker). A conversion whose helpers all fail, or whose job worker traps, runs once more from the start. Both give the same CHD, since compression is deterministic. When the second run fails too, the error says it is the browser's fault and to update it (on iOS: iOS; on a Mac: Safari, or another browser). A crash of the whole page can't be caught; Recovery reports it after the reload.
- Tests: `DEBUG.failHelpers` (`'one'`, `'all'` or `'always'`) makes helpers trap like this (`tests/ui/fallbacks.spec.js`).

## Device test checklist

On an iPhone (4 GB and 6+ GB if possible) and an iPad, iOS 18 and 26:

- [ ] Safari, hosted copy: 1.6 GB PSP ISO → CHD → Download lands in Files → Downloads. Note the time and whether Safari asks first.
- [ ] Home-screen web app: the same, including whether the download works or shows the "Open in…" card.
- [ ] Safari with the screen locked mid-job: does the job pause and resume, or is the page reloaded?
- [ ] A 4 GB PS2 DVD at 1, 2 and 3 threads: time, and whether the page is reloaded (memory).
- [ ] Sitecase: a small result (under 512 MB) through the share sheet still works.
- [ ] iCab Mobile: open the file, convert, download 1 GB, find it in Files.
- [ ] On iOS 18.x and on the first iOS 26 releases: a PSP and a PS2 DVD ISO at the default threads. Do they finish, or say that the browser engine failed (see above)?

## Decisions

1. **GitHub Pages:** yes, at `powerbeef.github.io/discpress/` (no custom domain for now).
2. **Phase 2:** yes.
3. **Who contacts the Sitecase developer:** open.
4. **A wrapper app later?** Open ($99 a year, and App Store review).
