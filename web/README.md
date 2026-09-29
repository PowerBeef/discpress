# The online version (GitHub Pages)

https://powerbeef.github.io/discpress/ is Discpress for people who don't want to download the HTML file,
and the way to convert big games on iPhone and iPad: iOS Safari can't run a local HTML file, and apps that
can usually can't save results over 512 MB (see `docs/ios/README.md`). In Safari, results of any size
download into Files → Downloads. In any browser, the page can be installed (Add to Home Screen, or Chrome
and Edge's install button) and used offline.

The Release workflow (`.github/workflows/release.yml`) publishes it together with the download: the release stays a draft until the site is deployed, and `scripts/check-release.sh` then checks that both are the same file (also daily, `release-check.yml`). For each release it publishes:

- `index.html`: the release's `dist/discpress.html`, byte for byte, and `discpress.html.sha256`, its SHA-256
  (the same file is attached to the release, so anyone can compare the two);
- the files here: `sw.js` (keeps the page available offline: network first, so updates arrive on the next
  visit, but a saved copy answers after 4 s on a slow network, and at once when the site answers the page
  with an error), `manifest.webmanifest` and the icons.

The page registers the service worker itself, and only when it is served over https; once that succeeds it
adds the manifest link and the PNG touch icon. So the single file stays the same everywhere, works unchanged
from disk, and a copy put on another site without these files keeps its built-in icon. Browsers without
service workers (private windows in some, app web views) simply get the page without offline use. Its
Content-Security-Policy (`connect-src 'none'`) still forbids it any network connection; the service worker
fetches only this site's own files.

The icons are rendered from the logo in `app/index.html` (the `icon` link): `icon-192.png` and `icon-512.png`
as is, `icon-maskable-512.png` and `apple-touch-icon.png` (180 × 180) with the background filling the square.

One-time setup, in the repository's settings: Pages → Build and deployment → Source: **GitHub Actions**.
Releases run the workflow on `main`, which the `github-pages` environment allows by default.
