# L1: exporting a large OPFS file to the Files app on iOS/iPadOS

Research for Discpress (a CHD of 0.5–4 GB sits in OPFS and has to reach the Files app). Researched 2026-09-28.
Current releases then: iOS/iPadOS 26.x, with iOS 27 / Safari 27.0 released 2026-09-17.

**Source-code references** point to WebKit `main` at commit `3095f6e16a4a1cd342675f9f4cffa6b53a4d48b2` (2026-09-28), written as
`W:<path>:<line>`, meaning `https://github.com/WebKit/WebKit/blob/3095f6e16a4a1cd342675f9f4cffa6b53a4d48b2/<path>#L<line>`.
Shipping Safari/iOS builds come from Apple branches, not `main`. The code paths cited here have been stable for years (ShareDataReader dates from 2020), but a given iOS build could differ in details.

**Confidence levels:** **H** = read in source, or stated by Apple/WebKit. **M** = several consistent reports, or an inference from source. **L/unverified** = plausible, but no primary evidence found.

---

## Summary table

| Mechanism | Safari (iOS 13+) | Home-screen web app (16.4+/17/18/26 "Open as Web App") | Third-party WKWebView app (e.g. Sitecase) |
|---|---|---|---|
| `navigator.share({files})` → "Save to Files" | Works. **Whole file in RAM.** WebContent peak ≈2× (3× during the IPC encode), UI process (Safari) ≈1×, plus a tmp copy on disk. Files ≥ 4 GiB are refused with an `AbortError` that has a different message from a user cancel. | Same code, so same memory behaviour (the UI process is the web-app host). **M** | Same code, enabled by default (`WebShareEnabled`/`WebShareFileAPIEnabled` default on for Cocoa WebKit). **The host app itself holds ≥1 full copy**, which is what got Sitecase killed. **H** |
| `<a download href=blob:>`: OPFS `File` or a `new File([opfsFile])` | Works since iOS 13. Safari asks "Do you want to download …?". Goes to Files → Downloads (iCloud Drive by default; "On My iPhone" or "Other" can be chosen in Settings → Safari → Downloads). **Streamed disk→disk in the network process in 512 KiB chunks. No size limit in the code, flat memory.** **H** (code) / **M** (Safari UI) | Unreliable. On iOS 18.4, attachment downloads in a Home Screen web app show a full-screen "Open in …" file card with no way back into the app. Not confirmed for blob URLs or for iOS 26. **L/unverified** | **Only if the app opts in** (iOS 14.5+: return `.download` for `navigationAction.shouldPerformDownload` and implement `WKDownloadDelegate`). Otherwise error 102 "Frame load interrupted" (Sitecase), or a silently cancelled download. **H** |
| Service-worker streamed download (StreamSaver style: SW `respondWith(new Response(stream or file, {headers:{'Content-Disposition':'attachment'}}))`) | Supported since Safari 15.4 (`ServiceWorkerDownloadTask`), written to disk incrementally. Regressions: iOS 18.2–18.3 (interrupted, fixed 18.4); 26.0/26.1 (not saved to Downloads, fixed 26.2). **Needs https hosting: impossible from `file://` and from a single self-contained HTML file.** **H** | SWs run in web apps. Whether the download UI works there is **unverified** (same "Open in…" problem likely). | **Disabled** unless the app has the `com.apple.developer.WebKit.ServiceWorkers`/`web-browser` entitlement or uses App-Bound Domains (so Chrome/Edge/Firefox for iOS yes, Sitecase no). `file://` never. **H** |
| `window.open(blobURL)` / `location.href = blobURL` | Non-displayable type (`application/octet-stream`) → Safari converts it to a download, streamed like the above. `window.open` after an `await` risks the popup blocker. **M** | `window.open` historically opens Safari or is blocked; not useful. **L** | `window.open` needs the app's `WKUIDelegate`; `location.href` hits the same policy → 102. **H** (code) |
| `data:` URL | Decoded in WebContent. A base64 string of 0.5–4 GB is far past practical JS string and memory limits. **Not viable.** **H** | same | same |
| File System Access pickers (`showSaveFilePicker`, `showDirectoryPicker`) | **Not implemented** (no trace in WebCore; standards position "oppose"). Only OPFS; `createWritable` (Safari 26.0) writes only into OPFS. **H** | same | same |
| Chunked shares, WebDAV, local servers, cloud upload | See §7: none gives a single large file in Files with bounded memory offline, except fetch-uploading to a server, which is a different product. | | |

**Bottom line.** In Safari, an `<a download>` of the OPFS-backed `File` is the only built-in path that is memory-safe for multi-GB files, and Discpress already uses it above 512 MB. In a WKWebView host that doesn't implement WKDownload (Sitecase), **no web-page technique can put a multi-GB file into Files without holding it in memory**. The share sheet is the only exit there, and its memory cost is a full copy in the host app plus two in WebContent. The practical answer for those users is to run Discpress in Safari (for example from an https copy of the page) or in a host app that implements downloads.

---

## 1. `navigator.share({ files })`: exact data path

### 1.1 The pipeline (H, from source)

1. **Page → `Navigator::share`** (`W:Source/WebCore/page/Navigator.cpp:165-212`):
   - The document must be fully active and pass the `web-share` permissions policy.
   - A pending share rejects with `InvalidStateError "share() is already in progress"`.
   - It **consumes transient activation** (`:183`) and runs `canShare`.
   - With files and `webShareFileAPIEnabled`, it creates a `ShareDataReader`, **stores it in `Navigator::m_loader`** (`:200-211`, `Navigator.h:88`), and starts it.
   - `canShare` (`:152-163`) does **not** look at file size or type. It returns true for any non-empty `files` when the setting is on, and a `url`, if given, must be http(s) (`:133-145`).
2. **`ShareDataReader::start`** (`W:Source/WebCore/page/ShareDataReader.cpp:47-66`): for every file it starts a `BlobLoader` with `FileReaderLoader::ReadAsArrayBuffer`.
3. **`FileReaderLoader`** (`W:Source/WebCore/fileapi/FileReaderLoader.cpp:95-130, 162-196, 205-260`):
   - It loads the blob through a temporary blob URL with a `ThreadableLoader`. The data comes from the network process's `NetworkDataTaskBlob` in 512 KiB reads.
   - On the response it **allocates one `ArrayBuffer` of the whole `expectedContentLength`** (`ArrayBuffer::tryCreate`, `:185`) and memcpy's each chunk into it (`:253`).
   - **Hard limit:** `if (length > std::numeric_limits<unsigned>::max()) failed(NotReadableError)` (`:179-181`, with the comment "FIXME: Support reading more than the current size limit of ArrayBuffer"). So a file of **≥ 4 GiB (4 294 967 296 bytes) cannot be shared**.
   - An allocation failure also becomes `NotReadableError` (`:187-189`). The JSC `ArrayBuffer` cap is 16 GiB on 64-bit (`W:Source/JavaScriptCore/runtime/PageCount.h:36-38`), so the 4 GiB check is the binding one.
4. **`ShareDataReader::didFinishLoading`** (`:68-95`):
   - Any read error → `completionHandler(Exception{AbortError, "Abort due to error while reading files."})` (`:75-79`).
   - Otherwise `file.fileData = SharedBuffer::create(arrayBuffer->span())` (`:86`). **That is copy #2** (`SharedBuffer(std::span)` → `DataSegment::create(Vector)` copies, `W:Source/WebCore/platform/SharedBuffer.h:261`, `SharedBuffer.cpp:478-481, 531-535`).
   - The `ArrayBuffer`s are released only when **all** files have finished (`m_pendingFileLoads.clear()`, `:91`). With several files, every `ArrayBuffer` and every `SharedBuffer` coexist until the last file is read.
5. **`Navigator::showShareData`** (`Navigator.cpp:214-247`) → `Chrome::showShareSheet` → `WebChromeClient::showShareSheet` → `WebPage::showShareSheet`. The latter sends **`Messages::WebPageProxy::ShowShareSheet(ShareDataWithParsedURL)`** (`W:Source/WebKit/WebProcess/WebPage/WebPage.cpp:9371-9373`; the message is declared at `W:Source/WebKit/UIProcess/WebPageProxy.messages.in:82`).
6. **IPC encoding.** `RawFile{String fileName; RefPtr<SharedBuffer> fileData}` (`W:Source/WebKit/Shared/WebCoreArgumentCoders.serialization.in:519-522`) is serialized through `FragmentedSharedBuffer::toIPCData()` (`W:Source/WebCore/platform/SharedBuffer.cpp:131-152`):
   - On Cocoa, any buffer ≥ 4096 bytes that isn't a mapped file goes through `SharedMemory::copyBuffer(*this)`, which `mach_vm_allocate`s a new purgeable region of the full size and **memcpy's the whole file into it**: **copy #3** (`W:Source/WebCore/platform/SharedMemory.cpp:53-67`, `W:Source/WebCore/platform/cocoa/SharedMemoryCocoa.mm` `SharedMemory::allocate`).
   - Only a Mach memory-entry port goes into the message. The message body itself goes out-of-line when it exceeds 4096 bytes (`W:Source/WebKit/Platform/IPC/cocoa/ConnectionCocoa.mm:59, 336-341`).
   - **No maximum IPC or shared-memory size exists in this path.** The only limits are address space and the per-process memory (jetsam) limit.
   - If `SharedMemory::allocate` fails, the encoder falls back to inline spans, which the Cocoa decoder rejects for sizes ≥ 4096 (`SharedBuffer.cpp:64-80`). A decode failure is treated as an invalid message: the share fails (and WebKit normally terminates a sender of invalid messages; not tested).
7. **UI process (Safari, the web-app host, or the third-party app).**
   - `FragmentedSharedBuffer::fromIPCData` maps the region and then calls **`SharedBuffer::create(sharedMemoryBuffer->span())`**, which copies it into a heap `Vector`: **copy #4, in the host app's own address space** (`SharedBuffer.cpp:82-90`).
   - `WebPageProxy::showShareSheet` (`W:Source/WebKit/UIProcess/WebPageProxy.cpp:12000-12008`) checks that the URL is http(s) or data and that the file API is enabled. It then goes to `PageClientImpl::showShareSheet` → `-[WKContentView _showShareSheet:]` (`W:Source/WebKit/UIProcess/ios/WKContentViewInteraction.mm:9902-9920`) → `-[WKShareSheet presentWithParameters:]` (`W:Source/WebKit/UIProcess/Cocoa/WKShareSheet.mm:309-364`).
8. **Temp files.** `appendFilesAsShareableURLs` (`WKShareSheet.mm:263-307`):
   - It wraps each `SharedBuffer` in an `NSData` without copying (`createNSData`, `W:Source/WebCore/platform/cocoa/SharedBufferCocoa.mm:157-179`).
   - On a background `WorkQueue` it writes each one with `-[NSData writeToURL:options:NSDataWritingAtomic]` into `NSTemporaryDirectory()/WKFileShare…/<uuid>/<sanitized name>` (`:555-596`). That is a **full copy on disk in the host app's tmp**; an atomic write goes to a temporary name and is then renamed.
   - Only then, back on the main thread, does it build a `UIActivityViewController` whose items are `WKShareSheetFileItemProvider`s returning the **file URL** (`:139-180, 284-305, 389-425`).
   - "Save to Files" then copies that file into the chosen location (out of process, file based; no WebKit memory involved).
   - The tmp directory is deleted in `-dismiss` (`:458-472`).
9. **Promise.** It resolves when the sheet completes. When the user cancels it rejects with `AbortError "Abort due to cancellation of share."` (`Navigator.cpp:236-246`).

### 1.2 Memory and disk ledger for one file of N bytes

| Where | What | Size | Lifetime |
|---|---|---|---|
| WebContent | `FileReaderLoader` `ArrayBuffer` | N | until every file is read |
| WebContent | `SharedBuffer` copy | N | **retained after the share finishes**: `Navigator::m_loader` keeps the `ShareDataReader` and its `m_shareData.files` alive until the next file share replaces it or the page goes away (`Navigator.cpp:200-211`; nothing clears `m_loader` on completion). Inference from source, **M-H** |
| WebContent | `SharedMemory::copyBuffer` for IPC | N (purgeable VM, owned by WebContent) | until the UI side unmaps it after decoding |
| UI process (host app) | heap copy from `fromIPCData` | N | until the tmp-file write finishes |
| UI process disk | tmp file | N | until the share sheet is dismissed |
| destination | Files copy | N | permanent |

Peaks are therefore **≈2–3 N in WebContent** and **≈1 N (+ the transient mapping) in the host app**. A 1.03 GB CHD means ~2–3 GB in WebContent and ~1 GB of dirty heap in the app.

iOS enforces per-process jetsam limits that are a fraction of RAM. Apple offers the `com.apple.developer.kernel.increased-memory-limit` entitlement (iOS 15+) to raise, not remove, the cap (https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit). Exact limits per device are **unverified**; third-party reports put them around 50–60% of RAM.

A WebContent kill makes the page reload ("A problem repeatedly occurred…"). **The host app itself being closed, as in Sitecase, fits the host's own full copy (#4) pushing it over its limit** (inference, M).

### 1.3 Variants

- **OPFS `File` vs `Blob` vs `new File([opfsFile])`:** no difference. `FileSystemFileHandle::getFile()` returns a path-backed `File` (`W:Source/WebCore/Modules/filesystem/FileSystemFileHandle.cpp:67-87`). `ShareDataReader` reads any blob the same way, into one `ArrayBuffer`. **H**
- **Several smaller files in one `share()`:** no help. All buffers coexist, one IPC message carries all of them, and the UI side holds every one until they are all written. **H**
- **Several `share()` calls, each with one part:** peak memory scales with the part size. But each call needs a new user gesture, the user ends up with N part files, and iOS has no built-in way to concatenate binary files (a Shortcuts-based join is **unverified**). Not usable for a CHD that an emulator must open as one file.
- **Sharing a URL instead of a file:**
  - WebCore only accepts http(s) URLs (`Navigator.cpp:133-145`); the UI process accepts http(s) or `data:` (`WebPageProxy.cpp:12002`). A `blob:` URL is rejected (`canShare` false → `TypeError`).
  - An https URL shares the link, not the bytes.
  - A `data:` URL can't come from the page (WebCore filters it).
  - **Not viable.** **H**
- **Files ≥ 4 GiB:** they reject with `AbortError`, message "Abort due to error while reading files.", before any UI appears. **H**
  - **Discpress impact:** `saveOutput`/`downloadMany` in `app/ui.js` treat every `AbortError` as "closed by the user" and return silently. Only files ≤ `SHARE_MAX` (512 MB) are shared, so today this can't trigger, but any raise of `SHARE_MAX` would hit it. Distinguish the two cases by `e.message`, or make sure files near or over 4 GiB never go to share.
- **Safari vs a third-party WKWebView app:** the WebKit code is identical.
  - In Safari the host is MobileSafari. A jetsam kill there takes down Safari, and whether Safari's limit is higher is **unverified**.
  - In a third-party app the host is the app (Sitecase), so the app dies.
  - Web Share is enabled by default for every Cocoa WKWebView (`WebShareEnabled`, `WebShareFileAPIEnabled` default `true` for `PLATFORM(COCOA)`, `W:Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml:7409-7433`). Apps can only switch it off through private SPI. **H**

---

## 2. Downloads (`<a download>` with `blob:`)

### 2.1 How Safari streams a blob download (H, from source)

1. `HTMLAnchorElement` click with `download` → `FrameLoader` → `PolicyChecker::checkNavigationPolicy`. It carries `downloadAttribute` and fires the Navigation API `navigate` event with `downloadRequest` first (`W:Source/WebCore/loader/PolicyChecker.cpp:240-248`). The blob URL's lifetime is extended across the policy decision (`:236`).
2. The UI process asks the client, `WKNavigationDelegate webView:decidePolicyForNavigationAction:`. `navigationAction.shouldPerformDownload` is true (iOS 14.5+). Safari answers with *download*.
3. `NetworkConnectionToWebProcess::startDownload` → `DownloadManager::startDownload` (`W:Source/WebKit/NetworkProcess/Downloads/DownloadManager.cpp:51-71`). For `blob:` it resolves the blob's **file references** (`blobRegistry().filesInBlob`, `:65-67`), and a `NetworkLoad` creates a **`NetworkDataTaskBlob`**.
4. `NetworkDataTaskBlob` (`W:Source/WebKit/NetworkProcess/NetworkDataTaskBlob.cpp`):
   - `bufferSize = 512 * 1024` (`:57`).
   - On `PolicyAction::Download` it calls `download()` (`:160-161, 198-221`), which opens the destination file chosen by the client and writes every chunk read from the source file with `m_downloadFile.write(...)` (`writeDownload`, `:223-237`).
   - **Disk-to-disk streaming, one 512 KiB buffer, entirely inside the network process. No size limit in the code; the page's WebContent never sees the bytes.**
   - An OPFS `File`, or `new File([opfsFile])`, is a file-backed blob item, so it streams as well. **H**
5. The same task also handles a *navigation* to a blob URL whose response the client turns into a download (`PolicyAction::Download` in `didReceiveResponse`, `:140-164`). So `location.href`/`window.open` of an octet-stream blob also streams, if the client chooses to download.

**Costs.** Disk space N (OPFS keeps its copy), no RAM growth, speed about equal to flash copy speed.

### 2.2 Safari UI and versions

- **iOS ≤ 12:** the `download` attribute was not supported. Blobs opened in the tab or failed (FileSaver.js history: https://github.com/eligrey/FileSaver.js/issues/12). **M**
- **iOS 13:** the `download` attribute and Safari's download manager arrived (https://bugs.webkit.org/show_bug.cgi?id=167341: "[iOS] Add support for the download attribute", fixed, shipped in iOS 13). **H**
  - Early iOS 13/14 builds showed blob downloads as "Unknown" or needed a delay before revoking the URL (same bug and FileSaver issue). **M**
- **iOS 14.5:** public WKDownload API (below). **H**
- **iOS 15–27:** no documented change to blob downloads. Two open quirks remain:
  - `text/plain`/XML/PDF/images tend to open in a tab instead of downloading; recreating the blob as `application/octet-stream` works around it (https://bugs.webkit.org/show_bug.cgi?id=263608, open, 2023–2026). Discpress already uses `application/octet-stream`.
  - WebKit bug 216918 ("WKWebView does not support blob: URLs … download") was closed as CONFIGURATION CHANGED in 2024 after it worked in Safari 17.3 (https://bugs.webkit.org/show_bug.cgi?id=216918). **M**
- **Does Safari ask?** Yes, an alert "Do you want to download “name”?". Observed on iOS 18.4 for attachments (https://github.com/tobias-bischoff/ios-pwa-download-reproduction, step 8). It is a Safari UI decision, not a WebKit one. **M**
- **Where the file lands:** Files → **Downloads** folder.
  - The default is **iCloud Drive/Downloads**.
  - Settings → Apps → Safari → Downloads offers *iCloud Drive*, *On My iPhone*, or *Other…* (Apple Support: https://support.apple.com/en-us/102440, and the iPhone User Guide "Customize your Safari settings", https://support.apple.com/guide/iphone/iphb3100d149/ios). **H**
  - A 4 GB file in iCloud Drive/Downloads also syncs to iCloud. What happens when the iCloud quota is too small is **unverified**; recommending "On My iPhone" for large files is prudent.
  - A download list appears via the Downloads button next to the address field.

### 2.3 WKWebView apps (H, from source and Apple docs)

**What the app must implement (iOS/iPadOS 14.5+)**, per Apple docs (`shouldPerformDownload`, `WKNavigationActionPolicy.download`, `webView(_:navigationAction:didBecome:)`, `WKDownloadDelegate.download(_:decideDestinationUsing:suggestedFilename:completionHandler:)`, all "iOS 14.5+"; https://developer.apple.com/documentation/webkit/wknavigationaction/shouldperformdownload, https://developer.apple.com/documentation/webkit/wkdownloaddelegate):
- In `decidePolicyFor navigationAction`, return `.download` when `navigationAction.shouldPerformDownload`.
- Implement `webView(_:navigationAction:didBecome:)` and set `download.delegate`.
- In `download(_:decideDestinationUsing:suggestedFilename:)`, return a file URL. The app can then show a `UIDocumentPickerViewController(forExporting:)` to move the file into Files.

**What happens when the app doesn't:**
- **No navigation delegate method at all:** WebKit's default policy *does* download blobs that carry `download` (`W:Source/WebKit/UIProcess/Cocoa/NavigationState.mm:626-631`: `… || [scheme isEqualToString:@"blob"]) { if (navigationAction->shouldPerformDownload()) listener->download();`). But with no `WKDownloadDelegate`, `decideDestinationWithSuggestedFilename` completes with an empty path (`W:Source/WebKit/UIProcess/API/Cocoa/WKDownload.mm:116-119`), so the download is dropped silently. **H**
- **Delegate returns `.allow` (typical of viewer apps):**
  - On Cocoa, WebKit deliberately does *not* force a download from the attribute (`forceDownloadFromDownloadAttribute = false` for `PLATFORM(COCOA)`, `W:Source/WebKit/UIProcess/WebPageProxy.cpp:6013-6019`).
  - The blob loads as a navigation. With no response delegate, WebKit uses `canShowMIMEType` (`NavigationState.mm:805-827`) → *ignore*. A response delegate that says allow → `DocumentLoader::continueAfterContentPolicy` finds the MIME type unshowable (`W:Source/WebCore/loader/DocumentLoader.cpp:1144-1149`).
  - Either way `stopLoadingForPolicyChange()` → `interruptedForPolicyChangeError()` = **WebKitErrorFrameLoadInterruptedByPolicyChange (102), "Frame load interrupted"** (`DocumentLoader.cpp:1204-1207, 1287-1290`; `W:Source/WebKit/Shared/WebErrors.cpp:68`; code 102 in `W:Source/WebKit/Shared/API/c/WKErrorRef.h:38`).
  - The French "Chargement du cadre interrompu" seen in Sitecase is this error, which the app displays from `didFailProvisionalNavigation`. **H**
- **App-side workarounds some apps use:** injected JS reads the blob with `FileReader` into base64 and posts it through `WKScriptMessageHandler`. That is fully in memory (worse than the share sheet) and fatal at GB sizes. **M**

Sitecase ("opens HTML files… offline", iOS 16+, https://apps.apple.com/gh/app/sitecase/id6762896369) evidently returns `.allow` and doesn't implement downloads. The page can't change that.

### 2.4 Can the page find out beforehand whether downloads work?

- **No API reports whether a download was accepted, refused, or completed.** **H**
  - The Navigation API `navigate` event with `event.downloadRequest` (Safari 26.2+, https://webkit.org/blog/17640/webkit-features-for-safari-26-2/) fires in WebContent *before* the UI-process decision (`PolicyChecker.cpp:242-248`), so it fires in Sitecase too.
  - Error 102 goes to the app's delegate, not to the page.
- **A probe download of a tiny blob** is visible to the user in both cases: Safari shows the download prompt, Sitecase shows its error alert. Not recommended.
- **User-agent heuristic (M-H):** `WKWebViewConfiguration.applicationNameForUserAgent` defaults to `"Mobile/15E148"` (`W:Source/WebKit/UIProcess/API/Cocoa/WKWebViewConfiguration.mm:532-536`). A plain WKWebView app's UA therefore has **no `Version/… Safari/…` token**, unless the app sets one or a custom UA. Safari, SFSafariViewController, and Chrome/Edge/Firefox for iOS include `Safari/604.1`.
  - Heuristic: `isIOS && !/ Safari\//.test(navigator.userAgent)` → "embedded web view; downloads probably don't work".
  - Home-screen web apps may also lack the Safari token (**unverified**), but they have `navigator.standalone === true` (`W:Source/WebCore/page/Navigator.cpp:366-369`). In WKWebView apps `navigator.standalone` is `false` (not `undefined`).
- **`window.webkit?.messageHandlers`** exists only if the app registered handlers. Not reliable.

---

## 3. Home-screen web apps (standalone / "Open as Web App")

- **iOS 26:** every site added to the Home Screen opens as a web app by default, with an "Open as Web App" toggle and no manifest needed (https://webkit.org/blog/17333/webkit-features-in-safari-26-0/). Service workers keep working there ("Home Screen Web App that uses a Service Worker", same post). **H**
- **Downloads in web apps are poorly supported and badly documented:**
  - **iOS 18.4 (simulator):** `<a download>` plus `Content-Disposition: attachment` shows "a full-size file icon with 'Open in …', no way to return to the PWA", and the user has to force-quit. Inline files also trap navigation (https://github.com/tobias-bischoff/ios-pwa-download-reproduction). **M**
    - The "Open in…" card presumably leads to a share sheet with "Save to Files". Whether that card holds the file in memory is **unverified**.
  - **Older reports:** "Impossible to download a file on PWA" (https://developer.apple.com/forums/thread/95911), and `window.open` not working in standalone mode since iOS 7 (FileSaver discussions). **M**
  - **Contrary data point:** a PWABuilder issue (Jan 2024) says `data:` URI downloads worked in an iOS home-screen web app but not in PWABuilder's WKWebView package (https://github.com/pwa-builder/PWABuilder/issues/4634). **L**
  - Behaviour of **blob** downloads in iOS 26/27 web apps: **unverified**. No WebKit or Apple note found; Safari 26.x and 27.0 release notes say nothing about web-app downloads.
- **`navigator.share({files})`** works in web apps with the same whole-file memory behaviour (§1). **M**
- **Practical advice:** in standalone mode, don't rely on downloads. For multi-GB files, tell the user to open the page in Safari itself.

---

## 4. Service-worker streamed downloads

**How WebKit implements it (H):**
- **History:** WebKit bug 202142 "Fix ServiceWorker downloads", fixed 2021-12-13 (r286944 / 245169@main), introduced `ServiceWorkerDownloadTask` (https://bugs.webkit.org/show_bug.cgi?id=202142, https://trac.webkit.org/changeset/286944/webkit). Shipped in **Safari 15.4 / iOS 15.4**: "new support for allowing users to download files generated by a ServiceWorker" (https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/).
- **Streaming body:** `ServiceWorkerDownloadTask::didReceiveData` writes each chunk straight to the download file (`W:Source/WebKit/NetworkProcess/ServiceWorker/ServiceWorkerDownloadTask.cpp:187-205`).
- **Blob or File body:** if the SW answers with a Blob or File body (e.g. `new Response(opfsFile)`), the SW's WebContent reads it with a `BlobLoader` and forwards chunk after chunk (`W:Source/WebKit/WebProcess/Storage/WebServiceWorkerFetchTaskClient.cpp:118-178`). **Both paths are streamed with bounded memory.**
- **Not implemented:** a `FormData` body (`ServiceWorkerDownloadTask.cpp:208-215`: "FIXME: Support writing formData in downloads" → the download fails).

**Regressions and fixes:**
- iOS 18.2–18.3: "Service Worker downloads being prematurely interrupted since iOS 18.2". iOS 18.1 was the last good version; fixed by 291712@main / 289651.390@safari-7621-branch for iOS 18.4 (https://bugs.webkit.org/show_bug.cgi?id=286060). The reporter's test page offered 4, 12 and 20 GiB downloads, triggered with `location.href = <scope>/…`, with a `postMessage` ping to keep the SW alive (https://stat-info.cz/safari-sw-download-tests.html), which suggests multi-GB SW downloads worked on iOS ≤ 18.1. **M**
- Safari 26.2: "Fixed an issue where service worker downloads are not being saved to Downloads folder. (154501503)" (https://webkit.org/blog/17640/webkit-features-for-safari-26-2/). So 26.0/26.1 were broken in some way. **H**
- StreamSaver.js still forces WebKit onto its in-memory blob fallback. An issue from 2026-09-03 argues for using the SW path on WebKit ≥ 16, but it has **no published multi-GB iOS measurements of the SW path yet** (https://github.com/jimmywarting/StreamSaver.js/issues/373). **L** for "proven on iOS 26 at 4 GB".

**Where it works:**
- **Safari:** yes (15.4+, except the regressions above).
- **Home-screen web apps:** SWs run, but the download UI is subject to §3. **Unverified.**
- **WKWebView apps:** `WKWebView` turns `ServiceWorkersEnabled` off on iOS unless the app holds `com.apple.developer.WebKit.ServiceWorkers` or `com.apple.developer.web-browser`, or sets `limitsNavigationsToAppBoundDomains` (`W:Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm:872-876`; also `W:Source/WebKit/WebProcess/WebPage/WebPage.cpp:5485-5493`). So Chrome/Edge/Firefox for iOS yes, Sitecase no. **H**
- **`file://`:** never. SW registration needs a secure http(s) origin and a same-origin script URL, so a `blob:` or `data:` script URL isn't allowed.
  - **This rules it out for the self-contained offline HTML file.** It would need Discpress served over https with a separate `sw.js` (for example GitHub Pages), and it only helps in Safari.
- **Memory:** yes, it avoids copies, same as a plain blob download in Safari.
  - In Safari a plain `<a download href=blob:>` of the OPFS File *already* streams (§2.1), so for Discpress a SW adds nothing in Safari.
  - It might help only in a context where SWs run but blob downloads don't. None is documented.
- **Risk:** the SW or tab being suspended mid-stream. iOS suspends background tabs. With a File body the copy takes seconds, so the risk is small.

---

## 5. Other navigations

- **`location.href = blobURL`** (same tab):
  - **Safari:** the response is `application/octet-stream`, not displayable, and Safari's response policy downloads it. The data path is identical to §2.1 (`NetworkDataTaskBlob::didReceiveResponse` → `download()`). Prompt and location as in §2.2. **M** (Safari policy) / **H** (streaming code).
  - **WKWebView:** error 102 as in §2.3, unless the app's `decidePolicyFor navigationResponse` returns `.download` and implements WKDownload.
- **`window.open(blobURL)` / `target=_blank`:**
  - **Safari:** a new tab, then the same download path, but subject to the popup blocker (user activation is lost after `await`s). **M**
  - **WKWebView:** needs `WKUIDelegate webView(_:createWebViewWith:…)`. Without it, `window.open` returns `null` and nothing happens. **H** (API contract)
  - **Standalone web apps:** historically `window.open` is broken or opens Safari, which can't see the web app's blob URL (blob URLs are partitioned per origin and session). **L**
- **`data:` URLs:**
  - `<a download href="data:…">` is decoded **inside WebContent** ("We decode data URL internally", `DocumentLoader.cpp:1180-1182`).
  - Top-frame navigation to `data:` is refused (`disallowDataRequest`, `DocumentLoader.cpp:1145, 1166`).
  - A 1 GB file needs a 1.33 GB base64 string, several times over in memory. JSC strings are capped near 2^31 characters. **Not viable** for anything big. **H**
- **`download` attribute with a cross-origin URL:** browsers ignore `download` for cross-origin URLs, so the server's `Content-Disposition` decides. Irrelevant offline, and the file must already be on a server. **M**
- **Quick Look:** there is no web API to hand a file to Quick Look. AR Quick Look (`rel="ar"`) only takes USDZ/Reality files, and Safari's inline viewers (PDF, images) don't apply to `.chd`. **H**
- **Summary:** in **Safari** every navigation form that ends in a download streams from disk (use `<a download>`). In **Sitecase-like apps** none of them work.

---

## 6. File System Access and related APIs

- **`showSaveFilePicker` / `showOpenFilePicker` / `showDirectoryPicker`:** absent from WebCore (no IDL, no preference in `UnifiedWebPreferences.yaml` at this commit). WebKit's standards position is **"oppose"** ("concerns: security", https://github.com/WebKit/standards-positions/issues/28, opened 2022-07-06). There is no flag and no announcement through Safari 27.0 (https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ mentions none). **H**
- **What WebKit ships instead:**
  - OPFS (Safari 15.2+) and `getFile()` (15.4) (https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/).
  - `FileSystemSyncAccessHandle`.
  - **`FileSystemWritableFileStream`/`createWritable()` in Safari 26.0**, described as "direct writing to files within the user’s file system… such as direct downloads" (https://webkit.org/blog/17333/webkit-features-in-safari-26-0/). In WebKit the only way to get a `FileSystemFileHandle` is OPFS, so that means **OPFS only**, not the Files app. `createWritable` is gated by `FileSystemWritableStreamEnabled`, stable and default-on for Cocoa (`UnifiedWebPreferences.yaml:2338-2347`; `W:Source/WebCore/Modules/filesystem/FileSystemFileHandle.idl:41`). **H**
  - Discpress's `saveToFolder` (`showDirectoryPicker`) will therefore never be offered on iOS.
- **Web Share Level 2 (files):** this is the §1 API (Safari 15+/iOS 15; `WebShareFileAPIEnabled` stable). **H**
- **Web Share Target:** not in WebKit. **Unverified** (no preference or IDL seen).
- **Download attribute improvements:** nothing new through Safari 27.0. **H**
- **Byte streams:** Safari 26.4 added byte streams as fetch bodies and a BYOB reader for `Blob.stream()`; Safari 27 added transferable streams (https://webkit.org/blog/17862/webkit-features-for-safari-26-4/, https://webkit.org/blog/18325/webkit-features-for-safari-27-0/). Useful for a SW design, not a new route into Files. **H**

---

## 7. Other techniques people use

- **Split into several downloads or shares and join later:**
  - It keeps each share bounded (§1.3), but iOS has no built-in way to join binary files. Files can only compress or uncompress ZIP.
  - A ZIP of parts isn't a joined file, and building a ZIP in JS still streams through the same channels.
  - It only helps if the consumer can read split files; emulators can't use a split CHD. **Not useful.** **M**
- **Fetch-upload to a server** (WebDAV `PUT`, a NAS, cloud resumable upload with `Blob.slice`):
  - A `File` body is streamed by the network process (bounded memory; **M**, not traced in this study).
  - The problems:
    - It needs a network server, so it is no longer offline.
    - From an https page, mixed content blocks `http://` LAN servers.
    - From `file://` or a WKWebView app, CORS and iOS **Local Network** permission apply, and the host app must declare `NSLocalNetworkUsageDescription`.
    - The Files app mounts **SMB** servers but not WebDAV (needs a third-party File Provider).
  - Legitimate as an optional "send to my computer or NAS", but not a way to save on the device.
- **Local server apps** (another iOS app running an HTTP/WebDAV server the page uploads to): iOS suspends background apps within seconds to minutes, so a multi-GB transfer is unreliable. The page also can't open a listening socket itself. **M**
- **Run the page in Safari** (hosted on https, or any Safari-reachable URL). Safari can't open a local `.html` from Files as `file://`; Files shows HTML through Quick Look, which is why Sitecase-type apps exist.
  - Once in Safari, `<a download>` streams (§2.1), and a SW path becomes possible (§4).
  - This is the only robust general answer for 1–4 GB outputs. **H/M**
- **Pick a host app that implements WKDownload**, or ask the Sitecase developer to add the 30-line WKDownload support (§2.3). **H** (API)

---

## Implications for Discpress (brief)

1. Keep `<a download>` for large files in Safari. It is memory-safe by construction (`NetworkDataTaskBlob`, 512 KiB chunks).
2. **In an embedded WKWebView** (no `Safari/` token, not standalone):
   - Downloads almost certainly fail with error 102, and a large share sheet kills the host app.
   - Show a clear message ("open this page in Safari to save files over ~0.5 GB").
   - Or offer the share sheet with an explicit memory warning.
   - SHARE_MAX (512 MB) is a guess. The host app needs at least 1 × size of headroom and WebContent 2–3 × size.
3. **Never share files ≥ 4 GiB.** WebKit rejects them with `AbortError` ("Abort due to error while reading files."), which the current code mistakes for a user cancel. Check `e.message`, or at least avoid silently returning.
4. **After a successful share, WebContent keeps one copy of the shared file** until the next file share (`Navigator::m_loader`). Discpress runs chdman in the same tab afterwards, so a large share inflates memory for later jobs (from source reading; not measured on a device).
5. **A service-worker download route** would require an https-hosted build plus `sw.js`, and gives nothing in Safari that `<a download>` doesn't already give. It isn't available in Sitecase or from `file://`.
