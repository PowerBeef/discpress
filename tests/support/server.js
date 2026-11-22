// Serves the page under test over http://127.0.0.1 (a secure context, so OPFS works).
// Usage: node support/server.js [port]   (DISCPRESS_HTML selects the page)
//
// /discpress.html?testdb=1 serves the page with extra game database rows from
// <fixtures>/testdb.json merged in: synthetic discs can't match real Redump checksums,
// so this is how the checksum-verified identification path is tested.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FIXTURES, ROOT, pageUnderTest } from './paths.js';

const WEB = path.join(ROOT, 'web');

function withTestDb(html) {
  const extra = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'testdb.json'), 'utf8'));
  const re = /(<script type="application\/octet-stream" id="gamedb" data-size="\d+">[^<]*<\/script>)/;
  if (!re.test(html)) throw new Error('no game database in the page');
  const payload = JSON.stringify(extra).replace(/</g, '\\u003c');
  return html.replace(re, '$1\n<script type="application/json" id="testdb">' + payload + '</script>');
}

// For tests of the online version's service worker, whose requests the browser's routing can't see:
// /alt/<id>/... serves the same files as /..., except that after GET /__slow/<id> the page takes
// 60 s to answer, after GET /__fail/<id> it is answered with 503 Service Unavailable, GET /__reset/<id>
// clears both toggles for <id>, and under /alt/nosw-<id>/ the web/ files are missing (a copy on another site).
const slow = new Set();
const failing = new Set();

const port = +(process.argv[2] || process.env.PORT || 4173);
http.createServer(async (req, res) => {
  let [url, query = ''] = req.url.split('?');
  const toggle = /^\/__(slow|fail|reset)\/([\w-]+)$/.exec(url);
  if (toggle) {
    if (toggle[1] === 'reset') { slow.delete(toggle[2]); failing.delete(toggle[2]); }
    else (toggle[1] === 'slow' ? slow : failing).add(toggle[2]);
    res.end('ok');
    return;
  }
  const alt = /^\/alt\/([\w-]+)(\/.*)$/.exec(url);
  if (alt) {
    url = alt[2];
    if (slow.has(alt[1]) && (url === '/' || url === '/discpress.html')) await new Promise(r => setTimeout(r, 60_000));
    if (failing.has(alt[1]) && (url === '/' || url === '/discpress.html')) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('down for maintenance'); return; }
    if (alt[1].startsWith('nosw-') && !(url === '/' || url === '/discpress.html')) { res.writeHead(404); res.end('not found'); return; }
  }
  // the page it serves, so a test run that reuses a running server can check it's the page it tests
  if (url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ page: pageUnderTest() })); return; }
  if (url === '/blank.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>blank</title>'); return; }
  if (url === '/' || url === '/discpress.html') {
    // read on every request so a rebuilt page is picked up without restarting
    let html;
    try {
      html = fs.readFileSync(pageUnderTest(), 'utf8');
      if (/(^|&)testdb=1(&|$)/.test(query)) html = withTestDb(html);
    } catch (e) {
      res.writeHead(500); res.end(String(e)); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  // the hosted copy's other files (web/: service worker, manifest, icons), for tests of the hosted mode
  const web = /^\/(sw\.js|manifest\.webmanifest|[\w-]+\.png)$/.exec(url);
  if (web && fs.existsSync(path.join(WEB, web[1]))) {
    const type = { js: 'text/javascript', webmanifest: 'application/manifest+json', png: 'image/png' }[web[1].split('.').pop()];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(WEB, web[1])));
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(port, '127.0.0.1', () => console.log(`serving ${pageUnderTest()} on http://127.0.0.1:${port}/`));
