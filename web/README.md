# The hosted copy (GitHub Pages)

iOS Safari can't run a local HTML file, so iPhone and iPad users run Discpress from
https://powerbeef.github.io/discpress/ (see `docs/ios/README.md`). There, results of any size download
into Files → Downloads, and the page can be added to the Home Screen and used offline.

The Release workflow (`.github/workflows/release.yml`, job `pages`) publishes, for each release:

- `index.html`: the release's `dist/discpress.html`, byte for byte, and `discpress.html.sha256`, its SHA-256
  (the same file is attached to the release, so anyone can compare the two);
- the files here: `sw.js` (keeps the page available offline: network first, so updates arrive on the next
  visit), `manifest.webmanifest` and the icons.

The page adds the manifest link, the PNG touch icon and the service worker itself, and only when it is served
over https, so the single file stays the same everywhere and works unchanged from disk. Its
Content-Security-Policy (`connect-src 'none'`) still forbids it any network connection; the service worker
fetches only this site's own files.

The icons are rendered from the logo in `app/index.html` (the `icon` link): `icon-192.png` and `icon-512.png`
as is, `icon-maskable-512.png` and `apple-touch-icon.png` (180 × 180) with the background filling the square.

One-time setup, in the repository's settings: Pages → Build and deployment → Source: **GitHub Actions**.
Releases run the workflow on `main`, which the `github-pages` environment allows by default.
