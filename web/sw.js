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
  var scope = self.registration.scope;
  var keep = new Set(FILES.map(function (f) { return new URL(f, scope).href; }));
  keep.add(new URL('discpress.html', scope).href);
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.keys().then(function (reqs) {
        return Promise.all(reqs.filter(function (r) { return r.url.indexOf(scope) === 0 && !keep.has(r.url); }).map(function (r) { return c.delete(r); }));
      });
    }).catch(function () {}).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // one saved copy per file, whatever query string a link added (and the page's, as ./ or ./index.html)
  var url = new URL(req.url);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/index\.html$/, '/');
  var scope = self.registration.scope;
  var isAppPage = req.mode === 'navigate' && (url.href === scope || url.href === scope + 'discpress.html');
  function saved() {
    return caches.match(url.href, { cacheName: CACHE }).then(function (hit) {
      return hit || (isAppPage ? caches.match(scope, { cacheName: CACHE }) : undefined);
    });
  }
  var done = false, timer = null, saving = Promise.resolve();
  function canCache(res) {
    return res && res.status === 200 && res.type === 'basic' && !res.redirected;
  }
  var net = fetch(req).then(function (res) {
    if (canCache(res)) {
      // when the timeout already answered from cache, store res directly instead of cloning a 3 MB stream
      var toStore = done ? res : res.clone();
      saving = caches.open(CACHE).then(function (c) { return c.put(url.href, toStore); }).catch(function () { /* storage full: not saved */ });
    }
    return res;
  });
  e.waitUntil(net.then(function () { return saving; }, function () { /* offline */ }));
  e.respondWith(new Promise(function (resolve) {
    function answer(res) {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      resolve(res);
    }
    net.then(function (res) {
      // pass redirects through unchanged; on an error page for the app itself, serve the saved copy
      if (res.type === 'opaqueredirect' || res.ok || !isAppPage) return answer(res);
      saved().then(function (hit) { answer(hit || res); }, function () { answer(res); });
    }, function () {
      // (the saved copies unreadable too: an answer all the same, never a page that loads for ever)
      saved().then(function (hit) { answer(hit || Response.error()); }, function () { answer(Response.error()); });
    });
    timer = setTimeout(function () {
      timer = null;
      if (done) return;
      saved().then(function (hit) { if (hit) answer(hit); }, function () { /* the network answers */ });
    }, WAIT);
  }));
});
