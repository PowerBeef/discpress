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

### Phase 1: an https copy for Safari (the main fix; needs your go-ahead)

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

### Phase 2: making big jobs survive on iOS (engine and page)

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

## Device test checklist

On an iPhone (4 GB and 6+ GB if possible) and an iPad, iOS 18 and 26:

- [ ] Safari, hosted copy: 1.6 GB PSP ISO → CHD → Download lands in Files → Downloads. Note the time and whether Safari asks first.
- [ ] Home-screen web app: the same, including whether the download works or shows the "Open in…" card.
- [ ] Safari with the screen locked mid-job: does the job pause and resume, or is the page reloaded?
- [ ] A 4 GB PS2 DVD at 1, 2 and 3 threads: time, and whether the page is reloaded (memory).
- [ ] Sitecase: a small result (under 512 MB) through the share sheet still works.
- [ ] iCab Mobile: open the file, convert, download 1 GB, find it in Files.

## Decisions needed

1. **Publish Discpress on GitHub Pages?** It's free and HTTPS is automatic. With a custom domain, Discpress would get its own origin. Without one, it's `powerbeef.github.io/discpress/`.
2. **Go ahead with Phase 2?**
3. **Who contacts the Sitecase developer:** you, or should I draft the message?
4. **A wrapper app later?** ($99 a year, and App Store review.)
