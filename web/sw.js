// Discpress's service worker, on the online version only (see README.md here): it keeps the page available
// offline. Network first, so a new release reaches the next visit; a page that is already open, and a
// conversion in it, is never touched. On a slow network a saved copy answers after a few seconds, and the
// download still refreshes it; when the site answers the page with an error, the saved copy answers. It caches only this site's own files and makes no other requests.
var CACHE = 'discpress';
var FILES = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
var WAIT = 4000;

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // one saved copy per file, whatever query string a link added (and the page's, as ./ or ./index.html)
  var url = new URL(req.url);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/index\.html$/, '/');
  var nav = req.mode === 'navigate';
  function saved() {
    return caches.match(url.href).then(function (hit) { return hit || (nav ? caches.match('./') : undefined); });
  }
  var saving = Promise.resolve();
  var net = fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      saving = caches.open(CACHE).then(function (c) { return c.put(url.href, copy); }).catch(function () { /* storage full: not saved */ });
    }
    return res;
  });
  e.waitUntil(net.then(function () { return saving; }, function () { /* offline */ }));
  e.respondWith(new Promise(function (resolve) {
    var done = false;
    function answer(res) { if (!done) { done = true; resolve(res); } }
    net.then(function (res) {
      // an error page (the site down, a bad deploy) is no better than being offline: the saved copy, if any
      if (res.ok || !nav) return answer(res);
      saved().then(function (hit) { answer(hit || res); }, function () { answer(res); });
    }, function () {
      // (the saved copies unreadable too: an answer all the same, never a page that loads for ever)
      saved().then(function (hit) { answer(hit || Response.error()); }, function () { answer(Response.error()); });
    });
    setTimeout(function () {
      saved().then(function (hit) { if (hit) answer(hit); }, function () { /* the network answers */ });
    }, WAIT);
  }));
});
