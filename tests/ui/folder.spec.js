// Writing results straight into a folder (Settings → Where to keep results → a folder), with a fake
// folder standing in for the File System Access API: like the browser's, writes go to a temporary
// copy that close() makes the file and abort() throws away.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES } from '../support/paths.js';
import { chdman, nativeChdman } from '../support/native.js';

function fakeFolder(delay = 0) {
  const files = new Map(); // name -> Uint8Array
  window.__written = 0;
  const bytes = d => d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  function fileHandle(name) {
    return {
      kind: 'file', name,
      async getFile() { return new File([files.get(name) || new Uint8Array(0)], name); },
      async createWritable({ keepExistingData = false } = {}) {
        let buf = keepExistingData && files.has(name) ? files.get(name).slice() : new Uint8Array(0);
        const put = (pos, d) => {
          const b = bytes(d);
          if (pos + b.length > buf.length) { const n = new Uint8Array(pos + b.length); n.set(buf); buf = n; }
          buf.set(b, pos);
        };
        let at = 0;
        const ws = new WritableStream({
          write(chunk) { put(at, chunk); at += bytes(chunk).length; },
          close() { files.set(name, buf); }
        });
        ws.write = async a => {
          if (delay) await new Promise(r => setTimeout(r, delay)); // a slow drive
          if (a && a.type === 'write') { put(a.position, a.data); window.__written += bytes(a.data).length; } else { put(at, a); at += bytes(a).length; }
        };
        ws.truncate = async size => { const n = new Uint8Array(size); n.set(buf.subarray(0, size)); buf = n; };
        ws.close = async () => { files.set(name, buf); };
        ws.abort = async () => { buf = null; };
        return ws;
      }
    };
  }
  const dir = {
    kind: 'directory', name: 'Games',
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, new Uint8Array(0));
      }
      return fileHandle(name);
    },
    async removeEntry(name) { files.delete(name); }
  };
  window.__folder = files;
  window.showDirectoryPicker = async () => dir;
}

const text = (page, name) => page.evaluate(n => window.__folder.has(n) ? new TextDecoder().decode(window.__folder.get(n).slice(0, 16)) : null, name);

async function open(app, page) {
  await page.addInitScript(fakeFolder);
  await app.open({ settings: { storage: 'folder', rename: false, threads: 1 } });
  await page.evaluate(() => window.__folder.set('agent.chd', new TextEncoder().encode('OLD RESULT')));
}

test('cancelling a conversion into the folder keeps the file that was already there', async ({ app, page }) => {
  await open(app, page);
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click(); // asked to replace agent.chd: yes (the harness accepts)
  await app.waitState(card, 'running');
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled');
  expect(await text(page, 'agent.chd')).toBe('OLD RESULT');
});

test('a file already in the folder is replaced only if the user agrees', async ({ app, page }) => {
  await open(app, page);
  const asked = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked.push(d.message()); d.dismiss(); });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'canceled');
  expect(asked).toEqual(['“agent.chd” is already in the folder “Games”. Replace it?']);
  expect(await text(page, 'agent.chd')).toBe('OLD RESULT');

  // agreeing replaces it with the new CHD
  page.removeAllListeners('dialog');
  page.on('dialog', d => d.accept());
  await card.locator('.job-foot button', { hasText: 'Try again' }).click();
  await app.waitState(card, 'ready');
  await app.run(card);
  expect(await text(page, 'agent.chd')).toMatch(/^MComprHD/);
});

test('a cancelled conversion leaves no new file behind', async ({ app, page }) => {
  await open(app, page);
  await page.evaluate(() => window.__folder.clear());
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'running');
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled');
  await expect.poll(() => page.evaluate(() => [...window.__folder.keys()])).toEqual([]);
});

// A slow drive (a USB stick, a network share) used to leave everything chdman produced waiting in the
// page's memory: a whole DVD's worth. The worker now pauses chdman while too much is unwritten (audit, batch 3).
for (const threads of [1, 4]) {
  test(`writing into a slow folder keeps little waiting in memory (${threads} thread${threads > 1 ? 's' : ''})`, async ({ app, page }) => {
    test.skip(!nativeChdman(), 'needs native chdman to make the CHD');
    // a 64 MB DVD image, stored uncompressed (quick to make and to read)
    const dir = path.join(FIXTURES, 'gen');
    fs.mkdirSync(dir, { recursive: true });
    const size = 64 << 20;
    if (!fs.existsSync(path.join(dir, 'big.chd'))) {
      const iso = Buffer.alloc(size);
      for (let i = 0; i < size; i += 2048) iso.writeUInt32LE(i, i); // no two sectors alike
      fs.writeFileSync(path.join(dir, 'big.iso'), iso);
      chdman(['createdvd', '-i', 'gen/big.iso', '-o', 'gen/big.chd', '-c', 'none', '-f']);
    }
    await page.addInitScript(fakeFolder, 25); // 25 ms per 1 MiB write: about 40 MB/s
    // the bytes the page has received to write but not written yet, at most
    await page.addInitScript(() => {
      window.__received = 0; window.__maxWaiting = 0;
      const W = window.Worker;
      window.Worker = class extends W {
        constructor(...a) {
          super(...a);
          this.addEventListener('message', e => {
            if (e.data && e.data.type === 's-write') {
              window.__received += e.data.data.byteLength;
              window.__maxWaiting = Math.max(window.__maxWaiting, window.__received - window.__written);
            }
          });
        }
      };
    });
    await app.open({ settings: { storage: 'folder', rename: false, threads }, debug: { sinkMax: 2 << 20 } });
    await app.add(['gen/big.chd']);
    const card = app.job('big');
    await app.settled(card);
    await card.locator('.seg button', { hasText: 'Extract' }).click();
    await app.run(card, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__folder.get('big.iso').length)).toBe(size);
    // at most the 2 MiB limit, one 8 MiB step of chdman's, and what the worker sends when chdman ends
    // (the file's first 8 MiB, kept for rewrites, and its last step): not the whole 64 MiB
    expect(await page.evaluate(() => window.__maxWaiting)).toBeLessThan(32 << 20);
  });
}

// Once chdman had finished, the last writes into the folder could take a while, and Cancel did nothing
// meanwhile ("Saving to folder"); a worker that crashed left its files half written (audit, remaining items).
test('Cancel works while the last writes into the folder are still going', async ({ app, page }) => {
  await page.addInitScript(fakeFolder, 150); // 150 ms per 1 MiB write: seconds after chdman is done
  await app.open({ settings: { storage: 'folder', rename: false, threads: 1 } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await expect(card.locator('.ptext')).toContainText('Saving to folder', { timeout: 60_000 });
  await card.locator('.job-foot button.danger', { hasText: 'Cancel' }).click();
  await app.waitState(card, 'canceled');
  await expect.poll(() => page.evaluate(() => [...window.__folder.keys()])).toEqual([]);
});

test('a job worker that crashes leaves no half-written file in the folder', async ({ app, page }) => {
  await page.addInitScript(fakeFolder);
  await page.addInitScript(() => {
    const W = window.Worker;
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', e => {
          if (e.data && e.data.type === 's-write' && !this.crashed) {
            this.crashed = true;
            this.terminate();
            setTimeout(() => this.onerror && this.onerror(new ErrorEvent('error', { message: 'the worker crashed' })));
          }
        });
      }
    };
  });
  await app.open({ settings: { storage: 'folder', rename: false, threads: 1 } });
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'error', 60_000);
  await expect(card).toContainText('the worker crashed');
  await expect.poll(() => page.evaluate(() => [...window.__folder.keys()])).toEqual([]);
});

// Only the result's main file (the .cue of an extract) was asked about: its track files replaced the
// folder's own without a word (second review)
test('extracting into a folder asks before replacing any file already there, track files too', async ({ app, page }) => {
  test.skip(!nativeChdman(), 'needs native chdman to make the CHD');
  fs.mkdirSync(path.join(FIXTURES, 'gen'), { recursive: true });
  chdman(['createcd', '-i', 'mgs disc1.cue', '-o', 'gen/mgs-x.chd', '-f']);
  await page.addInitScript(fakeFolder);
  await app.open({ settings: { storage: 'folder', rename: false, threads: 1 } });
  const extractOnce = async () => {
    await app.add(['gen/mgs-x.chd']);
    const card = app.job('mgs-x');
    await app.settled(card);
    await card.locator('.job-foot button.primary').click();
    return card;
  };
  let card = await extractOnce();
  await app.waitState(card, 'done');
  const names = await page.evaluate(() => [...window.__folder.keys()].sort());
  const bins = names.filter(n => n.endsWith('.bin'));
  expect(bins.length).toBeGreaterThan(0);
  // the user's own files of those names, and no .cue
  await page.evaluate(b => { for (const n of b) window.__folder.set(n, new TextEncoder().encode('MY OWN DUMP')); for (const n of [...window.__folder.keys()]) if (n.endsWith('.cue')) window.__folder.delete(n); }, bins);
  await card.locator('.job-head button[aria-label="Remove"]').click();
  const asked = [];
  page.removeAllListeners('dialog');
  page.on('dialog', d => { asked.push(d.message()); d.dismiss(); });
  card = await extractOnce();
  await app.waitState(card, 'canceled');
  expect(asked[0]).toContain(`“${bins[0]}” is already in the folder`);
  for (const n of bins) expect(await text(page, n)).toBe('MY OWN DUMP');
});

test('a version picked while the job waits in the queue names the result in the folder', async ({ app, page }) => {
  await page.addInitScript(fakeFolder);
  await app.open({ settings: { storage: 'folder', threads: 1 } });
  await page.evaluate(() => window.__folder.clear());
  await app.add(fixture('ps2-dvd').add);
  const mgs = fixture('ps1-multitrack');
  await app.add(mgs.add);
  const first = app.jobs().first(), card = app.job('mgs disc1');
  await app.settled(first);
  await app.settled(card);
  await first.locator('.job-foot button.primary').click();
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'queued');
  await card.locator('.note.ident select').selectOption(mgs.names[1]);
  await app.waitState(card, 'done', 60_000);
  await expect.poll(() => page.evaluate(() => [...window.__folder.keys()])).toContain(`${mgs.names[1]}.chd`);
});

test('a write the folder refuses stops the job and leaves no empty file', async ({ app, page }) => {
  await page.addInitScript(fakeFolder);
  await page.addInitScript(() => { // the third write fails, as when the drive is full
    const orig = window.showDirectoryPicker;
    window.showDirectoryPicker = async () => {
      const dir = await orig();
      const get = dir.getFileHandle.bind(dir);
      dir.getFileHandle = async (n, o) => {
        const h = await get(n, o), cw = h.createWritable.bind(h);
        h.createWritable = async (x) => { const w = await cw(x), wr = w.write; let k = 0; w.write = async a => { if (++k === 3) throw new DOMException('full', 'QuotaExceededError'); return wr(a); }; return w; };
        return h;
      };
      return dir;
    };
  });
  await app.open({ settings: { storage: 'folder', rename: false, threads: 1 } });
  await page.evaluate(() => window.__folder.clear());
  await app.add(fixture('ps2-dvd').add);
  const card = app.jobs().first();
  await app.settled(card);
  await card.locator('.job-foot button.primary').click();
  await app.waitState(card, 'error', 60_000);
  await expect(card).toContainText('full');
  await expect.poll(() => page.evaluate(() => [...window.__folder.keys()])).toEqual([]);
});
