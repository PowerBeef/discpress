// Serves the page under test over http://127.0.0.1 (a secure context, so OPFS works).
// Usage: node support/server.js [port]   (DISCPRESS_HTML selects the page)
import http from 'node:http';
import fs from 'node:fs';
import { pageUnderTest } from './paths.js';

const port = +(process.argv[2] || process.env.PORT || 4173);
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.end('ok'); return; }
  if (url === '/' || url === '/discpress.html') {
    // read on every request so a rebuilt page is picked up without restarting
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(pageUnderTest()));
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(port, '127.0.0.1', () => console.log(`serving ${pageUnderTest()} on http://127.0.0.1:${port}/`));
