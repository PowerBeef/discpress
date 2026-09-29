// Writing results straight into a folder (Settings → Where to keep results → a folder), with a fake
// folder standing in for the File System Access API: like the browser's, writes go to a temporary
// copy that close() makes the file and abort() throws away.
import { test, expect, fixture } from '../support/app.js';

function fakeFolder() {
  const files = new Map(); // name -> Uint8Array
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
        ws.write = async a => { if (a && a.type === 'write') put(a.position, a.data); else { put(at, a); at += bytes(a).length; } };
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
