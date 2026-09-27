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
import { FIXTURES, pageUnderTest } from './paths.js';

function withTestDb(html) {
  const extra = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'testdb.json'), 'utf8'));
  const re = /(<script type="application\/octet-stream" id="gamedb" data-size=")(\d+)(">)([^<]*)(<\/script>)/;
  const m = re.exec(html);
  if (!m) throw new Error('no game database in the page');
  const db = JSON.parse(zlib.gunzipSync(Buffer.from(m[4], 'base64')).toString('utf8'));
  for (const [sys, rows] of Object.entries(extra)) db.systems[sys] = (db.systems[sys] ? db.systems[sys] + '\n' : '') + rows.join('\n');
  const json = Buffer.from(JSON.stringify(db), 'utf8');
  const b64 = zlib.gzipSync(json).toString('base64');
  return html.replace(re, () => m[1] + json.length + m[3] + b64 + m[5]);
}

const port = +(process.argv[2] || process.env.PORT || 4173);
http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  if (url === '/healthz') { res.end('ok'); return; }
  if (url === '/' || url === '/discpress.html') {
    // read on every request so a rebuilt page is picked up without restarting
    let html = fs.readFileSync(pageUnderTest(), 'utf8');
    try {
      if (/(^|&)testdb=1(&|$)/.test(query)) html = withTestDb(html);
    } catch (e) {
      res.writeHead(500); res.end(String(e)); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(port, '127.0.0.1', () => console.log(`serving ${pageUnderTest()} on http://127.0.0.1:${port}/`));
