# L3: Serving Discpress from an https origin for iPhone and iPad

Research date: 2026-09-28. Scope: research only, no repository changes. Repo facts come from this repository (CLAUDE.md, README.md, `app/`, `.github/workflows/release.yml`). Current `dist/discpress.html` is 2,935,720 bytes, or 1,964,307 bytes after `gzip -9` (measured locally), which is roughly what a gzip-serving host sends over the wire.

Confidence labels: **High** means official vendor documentation, compatibility data or a direct measurement. **Medium** means a credible secondary source or community report. **Unverified** means a claim I could not confirm; each one says so.

---

## Recommendation

1. **Host the exact release file on GitHub Pages, deployed from `release.yml`.** Publish the release asset byte for byte as `index.html`, next to a small `sw.js`, `manifest.webmanifest` and icons. Put the deploy in a second job of the existing Release workflow, not in a separate workflow triggered by `release: published`. The existing workflow creates releases with `GITHUB_TOKEN`, and events caused by `GITHUB_TOKEN` do not start new workflow runs. The `github-pages` environment also needs an allowed-tag rule for `v*`. Cost: free. HTTPS is automatic. The site fits easily within the limits. GitHub Pages can't set custom headers, but Discpress doesn't need any: it uses no SharedArrayBuffer, and CSP can go in a `<meta>` tag.
2. **Use a dedicated origin if you can.** Options are a custom domain or subdomain on Pages, or a host such as Cloudflare. `powerbeef.github.io/discpress/` shares one origin with every other `powerbeef.github.io` project site. That means shared OPFS, localStorage, service worker scope boundaries and storage quota, and any other PowerBeef Pages site could read Discpress's storage.
3. **Add a strict `<meta http-equiv="Content-Security-Policy">` to `app/index.html` itself** so it covers both the file:// and the hosted copy. It should include `connect-src 'none'`. Draft policy in §3.4.
4. **Make it an installable, offline PWA with a minimal service worker.** The worker caches the one HTML file, and the new version activates only when no job is running. On iOS 26, any site added to the Home Screen opens as a web app by default. Home Screen web apps are exempt from Safari's 7-day storage cap, and they are the main case in which WebKit grants `navigator.storage.persist()`.
5. **Keep the downloadable single file.** It stays the primary release for desktop and Android, and the hosted copy is the same bytes. Tell iPhone users to "Open discpress.app in Safari (or add it to your Home Screen)" instead of "use Sitecase".
6. **Don't bother with COOP/COEP now.** Choose Cloudflare (Workers static assets or Pages with `_headers`) or Netlify only if a future shared-memory build (`docs/chd/encoders.md`, item 22) makes cross-origin isolation worth having.

### Hosting options compared

| | **GitHub Pages** | **Cloudflare Workers static assets / Pages** | **Netlify** | **Vercel** |
|---|---|---|---|---|
| Cost at this scale | Free for public repos | Free: static-asset requests are "free and unlimited" (Workers) | Free plan: 300 credits/month, hard cap. Bandwidth costs 20 credits/GB (about 15 GB), a deploy costs 15 | Hobby plan: free, but "non-commercial, personal use only" |
| Bandwidth | 100 GB/month *soft* limit, about 51,000 cold loads of 1.96 MB | Unlimited static | About 15 GB/month on the credit-based Free plan (accounts created before 2025-09-04 keep 100 GB) | 100 GB Fast Data Transfer. After that, "wait until 30 days have passed" |
| Per-file / site limits | Site ≤ 1 GB, 10-minute deploy timeout | 25 MiB per asset (Pages), 20,000 files | Not a constraint here | Not a constraint here |
| Custom response headers | **No.** Fixed headers, `cache-control: max-age=600` (measured) | **Yes**: `_headers` file, up to 100 rules | **Yes**: `_headers` / `netlify.toml` | **Yes**: `vercel.json` |
| COOP/COEP (SharedArrayBuffer) | Only through the `coi-serviceworker` workaround (reloads the page once) | Yes (RetroShrink does this, measured) | Yes (squoosh.app and ffmpegwasm.netlify.app send them, measured) | Yes (chdman.com sends them, measured) |
| CSP | `<meta>` only | Header or `<meta>` | Header or `<meta>` | Header or `<meta>` |
| HTTPS | Automatic on `github.io`; Let's Encrypt for custom domains | Automatic; `.pages.dev` is HSTS-preloaded (via `.dev`) | Automatic; `.netlify.app` is HSTS-preloaded (via `.app`) | Automatic |
| Deploy from this repo | Native: `actions/deploy-pages@v4` in the existing release job | Wrangler / Git integration; needs a Cloudflare account and token | Netlify CLI / Git integration | Vercel CLI / Git integration |
| Privacy side notes | Visitor IPs "logged and stored for security purposes" | Measured `nel`/`report-to` headers on `*.pages.dev` (Chrome sends network-error reports to Cloudflare; Safari has no NEL support per MDN data) | Standard CDN logs | Standard CDN logs |
| Terms | Not for commercial business or SaaS; donation links are fine | Fine | Fine | Hobby plan is non-commercial only |

Sources: GitHub Pages limits https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits ; GitHub terms https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features ; IP logging https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages ; HTTPS https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https ; Cloudflare Pages limits https://developers.cloudflare.com/pages/platform/limits/ ; `_headers` https://developers.cloudflare.com/pages/configuration/headers/ and https://developers.cloudflare.com/workers/static-assets/headers/ ; Workers static-asset billing https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/ ; Netlify credits https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/ (the date of the legacy plan cutoff is from a secondary source, https://agentdeals.dev/vendor/netlify, Medium) ; Vercel Hobby https://vercel.com/docs/plans/hobby ; coi-serviceworker https://github.com/gzuidhof/coi-serviceworker ; HSTS status came from `hstspreload.org/api/v2/status`. For `github.io` it returned "unknown", so HSTS preloading of github.io is **unverified**, though GitHub serves github.io over HTTPS automatically. Response headers were measured with `curl -I` on 2026-09-28 against pages.github.com, mdn.github.io, retroshrink.pages.dev, squoosh.app, ffmpegwasm.netlify.app and chdman.com.

---

## 1. Can iOS Safari run a local .html file?

**Short answer: no. I found no built-in way on iOS 16, 17, 18 or 26 to run a local HTML app, JavaScript included, in Safari.** Confidence: Medium-High. The evidence is consistent community reports and the absence of any Apple feature, not an Apple statement.

- **Tapping an .html file in Files** opens a Quick Look preview. Quick Look renders HTML and CSS but does not run JavaScript. In an Apple Community thread from July 2025, the poster says JS doesn't run in the Files preview, Safari isn't offered in the share sheet, and other browsers fail on the `file:///` link. A Level 10 reply says "Quick Look is as close as you can get and it will not run JavaScript" and "you can no longer open an HTML file directly with Safari (or Firefox) in iOS 18.5." https://discussions.apple.com/thread/256102223 (Medium: community answer, not Apple documentation).
- **Sharing to Safari:** Safari does not appear as a share target for .html files in the same thread. Some SEO blogs describe a "Copy to Safari" option; I found no first-hand confirmation of it, so it is **unverified and probably wrong**.
- **file:// URLs:** iOS Safari does not open `file://` URLs typed or linked by the user. See the threads above, plus https://discussions.apple.com/thread/256001921 (iOS 18, March 2025, "only want to open a local file and it wont work") and https://developer.apple.com/forums/thread/701845 (a developer asking how to open a local file or an HTML string in Safari; no answer from Apple, no solution). Confidence: Medium.
- **iOS 26:** I found no change to any of this in the Safari 26.0 notes (https://webkit.org/blog/17333/webkit-features-in-safari-26-0/). The absence of a change is **unverified** in the sense that no source says so explicitly.
- **iOS 16/17:** no evidence of a difference. Earlier threads (2024, iPhone 15 Pro) only offer workarounds like Reading List or HTTrack (https://discussions.apple.com/thread/255549790).
- **What people use instead** are third-party WKWebView apps. Sitecase: "full JavaScript and CSS support", iOS 16+, no servers or analytics (https://apps.apple.com/de/app/sitecase-html-viewer/id6762896369). Such apps can only download files if the app implements WebKit's `WKDownload` delegate, available since iOS 14.5 (https://developer.apple.com/documentation/webkit/wkdownload). That is why the README's "open it with an app such as Sitecase" path can't hand large results to Files. Discpress already routes files ≤ 512 MB through the share sheet and notes that iOS killed Sitecase with a 1 GB PSP CHD (`app/ui.js` around line 1921).
- **Related repo fact:** when the page runs from a local file, OPFS is often unavailable and Discpress falls back to memory (`app/index.html` `#memTip`: "This page cannot use the browser's private storage here (for example when it is opened as a local file)"). OPFS `getDirectory()` is secure-context-only (https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory). How WKWebView treats `file://` origins is app-dependent, so the precise rule is **unverified**.

**Conclusion:** an https origin is the only built-in way to run Discpress in Safari on iOS.

---

## 2. GitHub Pages for this repo, and alternatives

### 2.1 Deploying the committed `dist/discpress.html`

GitHub's custom-workflow route uses `actions/configure-pages@v5`, `actions/upload-pages-artifact@v4` and `actions/deploy-pages@v4`. It needs `pages: write` and `id-token: write`, plus `environment: github-pages` (https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages). With a custom Actions workflow, the 10-builds-per-hour soft limit does not apply (limits page above). The alternatives are publishing from a branch or folder (`/docs` or `gh-pages`). Those would need the 2.9 MB file committed a second time. The `docs/` folder already holds research and brand assets, and Jekyll would process it, so Actions is the cleaner route.

Two gotchas that apply to this repo (High):
- **A separate workflow triggered by the release won't fire.** "Events triggered by the `GITHUB_TOKEN` will not create a new workflow run", except `workflow_dispatch` and `repository_dispatch` (https://docs.github.com/en/actions/concepts/security/github_token). `release.yml` creates releases with `GH_TOKEN: ${{ github.token }}`, so a `on: release` Pages workflow would never run for those releases. Add the deploy as a second job in `release.yml` (`needs: publish`).
- **The environment only accepts the default branch unless told otherwise.** The auto-created `github-pages` environment allows deployments from the default branch only, so a tag-triggered run fails with "Tag … is not allowed to deploy to github-pages due to environment protection rules". Add an allowed-tag rule `v*` under Settings → Environments → github-pages (https://github.com/actions/deploy-pages/issues/151, https://github.com/orgs/community/discussions/39054). Confidence: Medium-High.

Sketch (not committed; for illustration):

```yaml
  pages:
    needs: publish
    runs-on: ubuntu-latest
    permissions: { contents: read, pages: write, id-token: write }
    environment: { name: github-pages, url: '${{ steps.deploy.outputs.page_url }}' }
    steps:
      - uses: actions/checkout@v4
      - name: Stage the released file as the site
        env: { GH_TOKEN: '${{ github.token }}', TAG: '<same expression as publish>' }
        run: |
          mkdir site
          gh release download "$TAG" -p discpress.html -O site/index.html   # the exact released bytes
          cp app/pwa/sw.js app/pwa/manifest.webmanifest app/pwa/icon-*.png site/   # hypothetical files
          touch site/.nojekyll
          sha256sum site/index.html > site/SHA256SUMS
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with: { path: site }
      - id: deploy
        uses: actions/deploy-pages@v4
```

### 2.2 Custom domain and HTTPS
`github.io` sites are served over HTTPS automatically. Custom domains get Let's Encrypt certificates once DNS verifies, and "Enforce HTTPS" is available (https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https). A custom domain gives Discpress its own origin (point 2 of the recommendation). If the DNS for the custom domain is proxied through Cloudflare (orange cloud), Cloudflare zone features could rewrite HTML, for example Email Obfuscation injecting a script. That is **unverified** for this setup, but a `<meta>` CSP would block and expose any injected script.

### 2.3 Headers GitHub Pages sends
Measured on github.io and Pages custom domains on 2026-09-28: `server: GitHub.com`, `cache-control: max-age=600`, `expires`, `etag`, `last-modified`, `access-control-allow-origin: *`, `content-encoding: gzip`. The service sends no COOP, COEP, CSP or HSTS headers, and they can't be configured. GitHub says it "would support" custom headers but gives no ETA (https://github.com/orgs/community/discussions/13309).
- **Do we need COOP/COEP? No.** They are required only for `SharedArrayBuffer` and wasm threads (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy; Safari iOS supports COEP since 15.2 per MDN compat data). Discpress uses message-passing helper workers (CLAUDE.md). A hosted build could use shared memory in future (`docs/chd/encoders.md`: "only for an HTTPS-hosted build"). That would need Cloudflare, Netlify or Vercel, or `coi-serviceworker` on Pages (https://github.com/gzuidhof/coi-serviceworker, https://blog.tomayac.com/2025/03/08/setting-coop-coep-headers-on-static-hosting-like-github-pages/).
- **Caching:** `max-age=600` means a new release is visible within about 10 minutes without a service worker. With one, the worker decides (§3.3).
- **Size:** 2.9 MB is far below the 1 GB site limit. At about 1.96 MB per gzip transfer, the 100 GB/month soft limit allows about 51,000 uncached loads a month, and the service worker makes repeat visits free.

### 2.4 Terms
GitHub Pages "is not intended for or allowed to be used as a free web-hosting service to run your online business, e-commerce site, or … SaaS". Donation links are allowed (terms URL above). A free, open-source tool whose Pages site is built from its own repository is the standard Pages use case. The app ships no game data (CLAUDE.md: fixtures are synthetic), and MAME and chdman source already live on GitHub. Confidence that it is allowed: High for the Pages terms. Whether the Acceptable Use Policies have anything to say about emulation tooling is **unverified**, but I found no sign of a problem, and comparable tools are hosted on GitHub.

### 2.5 Alternatives
- **Cloudflare:** for new projects Cloudflare now steers people to Workers with static assets. Pages still works, but investment goes to Workers (https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/, Medium). Both support `_headers` (100 rules, 2,000 characters per line). Workers adds `Cache-Control: public, max-age=0, must-revalidate` and an ETag by default. Static requests are free and unlimited. RetroShrink runs on `retroshrink.pages.dev` with COOP, COEP and CORP set (measured).
- **Netlify:** has `_headers`, and squoosh.app and ffmpeg.wasm are hosted there (measured COOP/COEP). New accounts on the Free plan get about 15 GB/month.
- **Vercel:** Hobby allows 100 GB but is non-commercial only. chdman.com ("ROM Tools") is hosted there with COOP/COEP (measured).

---

## 3. Offline, installable PWA

### 3.1 iOS installation
- **iOS 26 / iPadOS 26:** "By default, every website added to the Home Screen opens as a web app… there are now zero requirements for 'installability'" (https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#every-site-can-be-a-web-app-on-ios-and-ipados). The Share → Add to Home Screen sheet has an **Open as Web App** toggle, on by default (https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios; https://www.heise.de/en/news/iOS-26-and-iPadOS-26-Changed-web-app-behaviour-on-the-home-screen-10749652.html). High.
- **iOS 16–18:** a site opens standalone when it has a manifest with `display: standalone`, or the `apple-mobile-web-app-capable` meta. `app/index.html` already has that meta and `apple-mobile-web-app-title`. MDN compat data: manifest `display`, `start_url`, `scope` and `name` supported since iOS 11.3; `id` since 16.4; `icons` since 15.4, used only when no `apple-touch-icon` exists. Add an `apple-touch-icon` link as well. High.
- A manifest must be a separate file to be reliable. Keeping `index.html` byte-identical to the release asset, while the page registers `./sw.js` and inserts `<link rel="manifest">` only when `location.protocol === 'https:'`, is one approach. Whether Safari honours a manifest link inserted at runtime is **unverified**. iOS 26 doesn't need a manifest, and the existing meta tags cover standalone mode on earlier versions. The alternative is to let the Pages job inject a static `<link rel="manifest">` and publish the hash of both files.

### 3.2 Storage rules (WebKit)
- **Quotas (Safari 17+ / iOS 17+):** in a browser app, one origin may use "up to 60% of the total disk space" and all origins together up to 80%. In other apps that embed WebKit (Sitecase-style viewers), the limits are 15% and 20%. A Home Screen web app "has the same origin quota and overall quota as when it is opened in a browser app". Eviction is per origin, least recently used (https://webkit.org/blog/14403/updates-to-storage-policy/). High. Consequence: in Safari, Discpress gets up to 4× the OPFS space it would get in a viewer app, which matters for DVD-sized outputs.
- **`persist()`:** "WebKit currently grants a request based on heuristics like whether the website is opened as a Home Screen Web App" (same post). `persist()` and `persisted()` have been available since iOS 15.2 (MDN compat data). High.
- **The 7-day cap:** ITP deletes "all other script-writeable storage after 7 days of no user interaction with the website": IndexedDB, LocalStorage, media keys, SessionStorage, and service worker registrations and caches (https://webkit.org/tracking-prevention/). The clock counts "seven days of Safari use", not calendar days (https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/). **Home Screen web apps are exempt:** "ITP always skips that domain", and their data "is kept isolated from Safari". High. OPFS isn't in the list; whether it falls under the cap is **unverified**. Discpress uses OPFS only as scratch space and cleans stale sessions (`Store.cleanupStale`), so eviction mostly costs the cached app shell and settings in `localStorage`, which the next online visit restores.
- Home Screen web app data is separate from Safari's (tracking-prevention page), so results or settings in a Safari tab are not visible in the installed app.

### 3.3 Service worker and how updates reach users
- Service workers have been in iOS Safari since 11.3. `updateViaCache`, `update()`, `skipWaiting()` and `clients.claim()` are all supported from 11.3 (MDN compat data).
- Update flow: the browser checks for a new worker on every in-scope navigation. A worker counts as updated when it is "byte-different". The new worker then waits "until the existing worker is controlling zero clients" unless it calls `skipWaiting()`, and long-lived pages can call `reg.update()` (https://web.dev/articles/service-worker-lifecycle). By default (`updateViaCache: 'imports'`), the worker script check bypasses the HTTP cache, so Pages' `max-age=600` doesn't delay it.
- Suggested design:
  - `sw.js` contains the release version and the SHA-256 of `index.html`, so every release changes its bytes.
  - It precaches `./` (index.html), the manifest and the icon, and serves cache-first.
  - On `install` it does not call `skipWaiting()`; the page shows "Update ready: restart when idle". The page sends `SKIP_WAITING` only when no job is running and no OPFS results are unsaved. A mid-conversion reload would lose the job.
  - It needs no runtime network access, because the app loads nothing else.
  - The cached shell is about 2.9 MB. A Safari tab loses it after 7 days of Safari use without a visit; the Home Screen app keeps it.
- iOS WKWebView apps (Sitecase and similar) don't get service workers unless the app opts into App-Bound Domains (https://webkit.org/blog/10882/app-bound-domains/). So the PWA layer only works in Safari or a Home Screen web app, which is the point of hosting.

### 3.4 Keeping "nothing is uploaded" credible
- **Add a `<meta>` CSP to the page.** Here is a draft that I haven't tested against the app:
  `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; worker-src blob: 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'`.
  - `'wasm-unsafe-eval'` is needed because the app calls `WebAssembly.compile` (`app/ui.js:265`, `app/worker.js:24`). Safari iOS has supported it since 16 (MDN compat data).
  - Workers are created from Blob URLs (`app/ui.js:301`), and blob: workers inherit the page's CSP (MDN, https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy). `connect-src 'none'` therefore also covers the chdman workers.
  - A `<meta>` CSP can't carry `frame-ancestors`, `sandbox` or `report-uri` (same page).
  - `script-src` could use a sha256 hash of the one inline script instead of `'unsafe-inline'`; `assemble.py` could compute it. The inline `style="…"` attributes in `app/index.html` still need `'unsafe-inline'` for styles.
  - The Emscripten glue contains two `fetch(` calls on paths that never run, because the wasm module is always passed in (`build/chdman.js`). `connect-src 'none'` makes that guarantee enforced.
  - `npm test` fails on any console error, so it would catch CSP violations.
- **What the page CSP doesn't cover:** the service worker gets its CSP from its own response headers, and GitHub Pages sends none. Keep `sw.js` tiny, readable and same-origin only.
- **No analytics, cookies or third-party requests.** State this and show how to check it:
  - Airplane mode after the first load.
  - Safari Web Inspector (Mac + cable) or desktop devtools Network tab: nothing after load.
  - `curl -s https://<site>/ | sha256sum` equals the release asset's SHA-256, and the build is reproducible (CLAUDE.md).
  - Show the version and hash in Help → About.
- **Be honest about the new trust dependency.** A hosted page can change whenever the host or account is compromised, and SRI doesn't exist for top-level documents. Mitigations: deploy only from tagged releases, publish hashes in release notes, and keep the downloadable file as the fully offline option.

---

## 4. What an https origin enables on iOS, compared with file:// in a third-party WKWebView

| Capability | Safari tab (https) | Home Screen web app | file:// in a viewer app (Sitecase-style) | Evidence |
|---|---|---|---|---|
| OPFS (`getDirectory`, `createSyncAccessHandle`) | Yes, iOS 15.2+ | Yes | Often unavailable: Discpress falls back to memory (`#memTip`). The rule depends on the app (**unverified**) | MDN compat; repo |
| OPFS quota | Up to 60% of disk (iOS 17+) | Same as Safari | Up to 15% | https://webkit.org/blog/14403/updates-to-storage-policy/ |
| `FileSystemFileHandle.createWritable` | iOS 26+ | iOS 26+ | n/a | MDN compat; Safari 26.0 notes |
| `navigator.storage.persist()` granted | Unlikely (heuristic) | Yes (heuristic favours Home Screen apps) | n/a | WebKit storage post |
| Exempt from 7-day cap | No | Yes | n/a (app sandbox) | https://webkit.org/tracking-prevention/ |
| Downloads (`<a download>` on a Blob, including OPFS-backed Files) | Yes: Safari download manager → Downloads folder (iCloud Drive by default; "On My iPhone" or other configurable) | **Unverified on iOS 18/26.** Historically broken in standalone mode (https://developer.apple.com/forums/thread/95911, 2018; https://developer.apple.com/forums/thread/119017). Test before relying on it; the share sheet works as a fallback for ≤ 512 MB | Only if the app implements `WKDownload` (iOS 14.5+); most viewers don't | https://support.apple.com/en-lamr/102440 ; https://support.apple.com/guide/iphone/customize-your-safari-settings-iphb3100d149/ios ; https://bugs.webkit.org/show_bug.cgi?id=216918 (blob download in WKWebView, closed 2024 after working on iOS 17.3) |
| Service workers | Yes (11.3+) | Yes | No, unless the app uses App-Bound Domains | MDN compat; https://webkit.org/blog/10882/app-bound-domains/ |
| Streamed downloads through a service worker (StreamSaver-style) | Reported to work since Safari 15.4 (`ServiceWorkerDownloadTask`); regressed in iOS 18.2–18.3 and fixed in 18.4. Real-world failures on 1.4 GB and 11.9 GB files on iOS 18.7 | Unverified | No | https://github.com/jimmywarting/StreamSaver.js/issues/373 (Medium; not checked against WebKit source) |
| Web Share with files | iOS 14+ | Yes (**unverified** in standalone, likely) | Yes if the WKWebView allows it (Discpress uses it in Sitecase today) | MDN compat (`navigator.share` files: 14) |
| Screen Wake Lock | iOS 16.4+ in Safari | **Fixed in iOS 18.4**; broken in Home Screen apps on 16.4–18.3 | **Unverified** | https://webkit.org/blog/16574/webkit-features-in-safari-18-4/ ; https://bugs.webkit.org/show_bug.cgi?id=254545 ; MDN compat |
| COOP/COEP → SharedArrayBuffer | Only if the host sets headers (not GitHub Pages) | Same | Never (no headers from file://) | `docs/chd/encoders.md`; MDN compat (COEP 15.2) |
| `showDirectoryPicker` (write into a folder) | No (Safari has none) | No | No | MDN compat |
| Background Fetch | No | No | No | MDN compat |
| Installable icon, offline launch | Yes (bookmark) | Yes | App-specific | §3 |

Notes on streamed downloads:
- A service worker download doesn't help CHD creation. chdman seeks within its output: the map and header are written or updated at the end, and `StreamStore`'s folder writes use seeks. So the output can't be streamed as it is produced, and Discpress must still write to OPFS first. That is my reasoning from the code, not a measured fact.
- Once the output is in OPFS, the current `downloadOutput` passes a disk-backed `File` to `<a download>`. The README says Safari streams that from disk into Downloads.
- The one gain from service worker streaming would be sequential extract outputs (`.bin`/`.iso`) streamed without an OPFS copy. That saves disk space, but the Transcend data in issue #373 suggests large service worker downloads on iOS remain fragile.

---

## 5. Privacy and trust framing; precedent for browser CHD tools

Existing browser CHD converters (all hosted, none single-file):
- **CHD Creator (chdman web)**, https://chd.emulationonline.com/ by EmulationOnline (PicoStation emulator). "All the processing happens locally on your own machine". Only cue+bin → CHD. It warns that it "uses a lot of memory" and asks for one .cue per folder. It credits MAME's GPLv2 code and publishes its changes on GitHub. Hosted behind Cloudflare with no COOP/COEP (measured).
- **RetroShrink**, https://github.com/Kelvao/RetroShrink → https://retroshrink.pages.dev/. chdman compiled to WebAssembly in a Worker, OPFS, CD/DVD/GDI/HD. The UI says "100% Local ● ZERO Upload" (Portuguese UI). Cloudflare Pages with COOP/COEP/CORP (measured). Its README says GitHub Pages, but the host is actually Cloudflare Pages.
- **chdman.com**, "ROM Tools: Patch, compress, test, and analyze your ROM files". A Vercel SPA with COOP/COEP (measured). The content is rendered by JavaScript, so its privacy claims and CHD features are **unverified**.
- GitHub topic listing both wasm ports alongside Discpress: https://github.com/topics/chdman?o=desc&s=updated

How similar hosted-but-local tools frame it:
- **Squoosh** (Google Chrome Labs): a PWA that caches its codecs after the first visit and then works offline; images are processed locally (https://web.dev/blog/introducing-libsquoosh; secondary: https://meshworld.in/blog/web-dev/squoosh-image-optimization-guide/). Netlify with COOP/COEP (measured).
- **ffmpeg.wasm**: "runs only inside your browser… no data is sent to remote server" (https://ffmpegwasm.netlify.app/).
- **VERT** (https://github.com/VERT-sh/vert): "fully local*". The asterisk is there because video goes to a server. This shows why an unqualified claim needs to be literally true; Discpress can make it without an asterisk.
- **RetroArch web player / PPSSPP web ports**: files are loaded into browser storage (https://github.com/libretro/RetroArch/blob/master/pkg/emscripten/README.md; https://github.com/root-hunter/ppsspp-wasm). Some add optional cloud features (Google Drive), which Discpress should avoid.

Suggested wording: "Discpress runs entirely on your device. The page is the same file as the release download (SHA-256 shown in About). It has no analytics or cookies, and its Content-Security-Policy forbids network connections, so your discs can't be sent anywhere. Turn on airplane mode after it loads to see for yourself." Mention that the host (GitHub) logs visitor IPs when the page is fetched, like any website.

---

## 6. Risks that remain in Safari, and how web apps handle them

1. **Backgrounding stops the work.** An Apple Frameworks Engineer: "If you are trying to keep running UI when the app itself is in the background, you cannot control this… On iOS it is very intentional to prevent this kind of behavior" (https://developer.apple.com/forums/thread/777860). Safari "pauses almost all background activity" (https://firt.dev/understanding-js-background/, Medium). Whether workers keep running while the app is backgrounded on iOS is **unverified**; assume they don't.
   - Mitigations: Screen Wake Lock (already in `ui.js`; Home Screen apps need iOS 18.4+); a clear "keep Discpress on screen" banner; `visibilitychange` handling; progress that survives a pause.
2. **Memory kills (jetsam).** iOS reloads the tab with "This webpage was reloaded because it was using significant memory" and no JavaScript error. Reported budgets range from about 1.5 GB (iPhone 12 Pro after days of uptime) to about 3 GB (iPhone 15 Pro) and vary with RAM, load and uptime (https://github.com/Nehanth/pooled/issues/207, Medium).
   - All dedicated workers run in the page's WebContent process, so the job worker plus up to 8 helper wasm instances (`Tuning` caps touch devices at 8) share that budget. That is my inference from WebKit's process model; **unverified** for workers specifically.
   - A related WebKit bug (304810) makes the optimizing wasm compiler spike to about 4 GB on Asyncify builds, and jetsam killed them on iOS 26.6.2 (https://github.com/frankhinek/webkit-wasm-compiler-memory-repro). Discpress uses C++20 coroutines, not Asyncify (CLAUDE.md), so it is probably unaffected, but measure peak memory on a 4 GB-RAM iPhone.
   - Mitigations: cap helpers on iPhone by measured memory, not only speed; keep the 512 MB share-sheet cap (share loads the whole file); stream from OPFS for downloads.
3. **Loss of state after a reload.** OPFS outputs survive a reload, but the job model doesn't.
   - Option: persist a job journal in `localStorage`/OPFS so a reload can offer "resume / save finished results". Today, stale sessions are cleaned up based on Web Locks (`Store.cleanupStale`). On a reload after jetsam the lock is gone, so finished-but-unsaved results would be deleted: **check this**.
4. **Picked input files can disappear.** iOS Safari deletes its temporary copies of picked files (existing handling in `ui.js` around line 2300). The same applies when hosted.
5. **Storage eviction and space.** In a Safari tab, data goes after 7 days of Safari use without a visit, plus LRU eviction under disk pressure. Home Screen use and `persist()` help. Check `navigator.storage.estimate()` (iOS 17+) before a DVD job. Private Browsing gives ephemeral storage, possibly with a smaller quota (**unverified**).
6. **Downloads.**
   - iOS 26 users report large Safari downloads failing when Safari goes to the background (https://discussions.apple.com/thread/256160022, October 2025, Medium). Those were network downloads; whether local Blob downloads are affected is **unverified**. Tell users to stay on the page until the download completes.
   - Home Screen web app downloads: **unverified** on iOS 18/26 (see §4). If they fail, fall back to the share sheet for small files and suggest "Open in Safari" for large ones.
7. **Service worker update mid-job.** A worker that activates immediately and reloads the page would kill a conversion. Only activate when idle (§3.3).
8. **Shared origin.** On `powerbeef.github.io`, other project sites share Discpress's storage and quota (§Recommendation 2).
9. **Platform policy risk.** Apple planned to remove Home Screen web apps in the EU for iOS 17.4 and then reversed the decision (https://modernwebweekly.substack.com/p/open-files-with-a-pwa, Medium). Keep the Safari-tab path fully functional.

---

## Unverified items (collected)
- Whether a "Copy to Safari" or "Open in Safari" share action for local .html exists on any iOS version (evidence says no).
- Whether iOS 26 changed anything about local HTML or file:// (no source found either way).
- Exactly when WKWebView apps expose OPFS for file:// pages.
- Whether `<a download>` Blob downloads work in Home Screen web apps on iOS 18/26.
- Screen Wake Lock and Web Share inside third-party WKWebView apps and standalone web apps (beyond the 18.4 wake-lock fix).
- Whether OPFS is covered by ITP's 7-day cap.
- Whether Safari honours a manifest `<link>` inserted by script.
- Whether dedicated workers share the page's jetsam budget on iOS.
- Whether Cloudflare zone features inject scripts on a proxied custom domain.
- Whether `github.io` is HSTS-preloaded.
- chdman.com's feature set and privacy claims.
- The StreamSaver issue's WebKit version claims (not checked against WebKit commits).
