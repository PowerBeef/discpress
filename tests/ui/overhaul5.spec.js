// Phase 5: Target Environment profiles, Milestone 7 reversible repairs (DPRC0001 trailer),
// --sessions (CHSE), --stripmeta, full CHD Health Auditor, folder-tree/console/frontend .m3u,
// and pre-flight collision <dialog>.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, fixture } from '../support/app.js';
import { FIXTURES, ROOT } from '../support/paths.js';
import { chdman, nativeChdman, info, sha1File } from '../support/native.js';

function nestedFakeFolder() {
  const tree = new Map(); // 'sub/a.chd' -> Uint8Array
  const bytes = d => d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  function makeDir(prefix, name) {
    const key = n => prefix ? prefix + '/' + n : n;
    return {
      kind: 'directory', name,
      async getDirectoryHandle(sub, { create = false } = {}) {
        const p = key(sub);
        const has = [...tree.keys()].some(k => k === p || k.startsWith(p + '/'));
        if (!create && !has) throw new DOMException('not found', 'NotFoundError');
        return makeDir(p, sub);
      },
      async getFileHandle(fn, { create = false } = {}) {
        const k = key(fn);
        if (!tree.has(k)) {
          if (!create) throw new DOMException('not found', 'NotFoundError');
          tree.set(k, new Uint8Array(0));
        }
        return {
          kind: 'file', name: fn,
          async getFile() { return new File([tree.get(k) || new Uint8Array(0)], fn); },
          async createWritable({ keepExistingData = false } = {}) {
            let buf = keepExistingData && tree.has(k) ? tree.get(k).slice() : new Uint8Array(0);
            const put = (pos, d) => {
              const b = bytes(d);
              if (pos + b.length > buf.length) { const n = new Uint8Array(pos + b.length); n.set(buf); buf = n; }
              buf.set(b, pos);
            };
            let at = 0;
            const ws = new WritableStream({
              write(chunk) { put(at, chunk); at += bytes(chunk).length; },
              close() { tree.set(k, buf); }
            });
            ws.write = async a => {
              if (a && a.type === 'write') put(a.position, a.data);
              else if (a instanceof Blob) { const ab = await a.arrayBuffer(); put(at, ab); at += ab.byteLength; }
              else { put(at, a); at += bytes(a).length; }
            };
            ws.truncate = async size => { const n = new Uint8Array(size); n.set(buf.subarray(0, size)); buf = n; };
            ws.close = async () => { tree.set(k, buf); };
            ws.abort = async () => { buf = null; };
            return ws;
          }
        };
      },
      async removeEntry(fn) { tree.delete(key(fn)); }
    };
  }
  window.__tree = tree;
  window.showDirectoryPicker = async () => makeDir('', 'ROMs');
}

test('Target Environment selector switches profiles cleanly across PS2, Saturn, Dreamcast, and PC', async ({ app, page }) => {
  await app.open();
  await app.add([
    ...fixture('ps2-dvd').add,
    ...fixture('saturn').add,
    ...fixture('dreamcast-gdi').add,
    'homebrew.iso'
  ]);
  const ps2 = app.job('agent'), sat = app.job('albert odyssey'), dc = app.job('aerowings'), pc = app.job('homebrew');
  for (const c of [ps2, sat, dc, pc]) await app.settled(c);

  // Universal default
  await expect(page.locator('#targetSelect')).toHaveValue('universal');
  await expect(ps2.locator('code.cmd')).toContainText('chdman createdvd');
  await expect(sat.locator('code.cmd')).not.toContainText('--codecplan');

  // Fast Universal
  await page.locator('#targetSelect').selectOption('fast-universal');
  await expect(sat.locator('code.cmd')).toContainText('--codecplan');
  await expect(sat.locator('code.cmd')).toContainText('--libdeflate');

  // Handheld (PS2 DVDs -> CD CHDs for NetherSX2/AetherSX2)
  await page.locator('#targetSelect').selectOption('handheld-linux');
  await expect(ps2.locator('code.cmd')).toContainText('chdman createcd');

  // MiSTer FPGA (Saturn -> 4-sector Zstd+FLAC -hs 9792; Dreamcast falls back to Fast Universal)
  await page.locator('#targetSelect').selectOption('mister');
  await expect(sat.locator('code.cmd')).toContainText('-c cdzs,cdfl');
  await expect(sat.locator('code.cmd')).toContainText('-hs 9792');
  await expect(dc.locator('code.cmd')).not.toContainText('cdzs');
  await expect(dc.locator('code.cmd')).toContainText('--codecplan');

  // Legacy (PS2 -> CD CHD, PC -> -c none for DOSBox Pure, #setCompat synced)
  await page.locator('#targetSelect').selectOption('legacy');
  await expect(ps2.locator('code.cmd')).toContainText('chdman createcd');
  await expect(pc.locator('code.cmd')).toContainText('-c none');
  await page.click('#settingsBtn');
  await expect(page.locator('#setCompat')).toBeChecked();
  await expect(page.locator('#setTarget')).toHaveValue('legacy');
  await page.click('#settingsClose');
});

test('Milestone 7 Saturn PREGAP/POSTGAP repair & Dreamcast CD-R pregap absorption round-trip byte-for-byte via DPRC0001 trailer', async ({ app }) => {
  // 1. Saturn cue with virtual PREGAP + POSTGAP
  const sdir = path.join(FIXTURES, 'gen', 'p5-sat-gaps');
  fs.mkdirSync(sdir, { recursive: true });
  const t1 = fs.readFileSync(path.join(FIXTURES, 'albert odyssey.bin'));
  const t2 = Buffer.alloc(40 * 2352, 0x33);
  fs.writeFileSync(path.join(sdir, 'sat (Track 1).bin'), t1);
  fs.writeFileSync(path.join(sdir, 'sat (Track 2).bin'), t2);
  const satCue =
    'FILE "sat (Track 1).bin" BINARY\r\n' +
    '  TRACK 01 MODE1/2352\r\n' +
    '    INDEX 01 00:00:00\r\n' +
    '    POSTGAP 00:00:10\r\n' +
    'FILE "sat (Track 2).bin" BINARY\r\n' +
    '  TRACK 02 AUDIO\r\n' +
    '    PREGAP 00:00:15\r\n' +
    '    INDEX 01 00:00:00\r\n';
  fs.writeFileSync(path.join(sdir, 'sat.cue'), satCue);

  await app.open({ settings: { rename: false, threads: 1 } });
  await app.add(['gen/p5-sat-gaps/sat.cue', 'gen/p5-sat-gaps/sat (Track 1).bin', 'gen/p5-sat-gaps/sat (Track 2).bin']);
  const sat = app.job('sat');
  await app.settled(sat);
  // Universal target: repair is NOT active by default (Tier R)
  await expect(sat.locator('code.cmd')).not.toContainText('--trailer');
  // Click 1-click repair button
  await sat.locator('.repair-bar[data-repair="gaps"] button').click();
  await expect(sat.locator('.repair-bar[data-repair="gaps"]')).toContainText('Tier X: Emulator-Fixed');
  await expect(sat.locator('.repair-bar[data-repair="gaps"]')).toContainText('Reversible on Extract');
  await expect(sat.locator('code.cmd')).toContainText('--trailer');
  await app.run(sat);
  const [satChd] = await app.downloads(sat);
  const satBytes = fs.readFileSync(satChd.path);
  expect(satBytes.subarray(satBytes.length - 8).toString('ascii')).toBe('DPRC0001');
  if (nativeChdman()) {
    const inf = info(satChd.path).raw;
    const t1Meta = chdman(['dumpmeta', '-i', satChd.path, '-t', 'CHT2', '-ix', '0']);
    const t2Meta = chdman(['dumpmeta', '-i', satChd.path, '-t', 'CHT2', '-ix', '1']);
    // Virtual PREGAP became stored (VAUDIO) and POSTGAP is 0
    expect(t1Meta).toContain('POSTGAP:0');
    expect(t2Meta).toContain('PREGAP:15 PGTYPE:VAUDIO');
    // No CUES metadata tag (Kronos/Yabause safe!)
    expect(inf).not.toContain("Tag='CUES'");
  }
  // Extract --redump reverses DPRC0001 back to exact original Track 1, Track 2 and cue!
  const satRel = 'gen/p5-sat-gaps/sat-repaired.chd';
  fs.copyFileSync(satChd.path, path.join(FIXTURES, satRel));
  await app.open({ settings: { rename: false, threads: 1 } });
  await app.add([satRel]);
  const exSat = app.job('sat-repaired');
  await app.settled(exSat);
  await app.run(exSat);
  const exOuts = await app.downloads(exSat);
  const outT1 = exOuts.find(o => /Track 1/.test(o.name));
  const outT2 = exOuts.find(o => /Track 2/.test(o.name));
  const outCue = exOuts.find(o => /\.cue$/.test(o.name));
  expect(fs.readFileSync(outT1.path).equals(t1)).toBe(true);
  expect(fs.readFileSync(outT2.path).equals(t2)).toBe(true);
  const cueTxt = fs.readFileSync(outCue.path, 'utf8');
  expect(cueTxt).toContain('POSTGAP 00:00:10');
  expect(cueTxt).toContain('PREGAP 00:00:15');

  // 2. Dreamcast CD-R pregap absorption -> Flycast <= 2.7 clean CHD + exact round-trip!
  await app.open({ settings: { rename: false, threads: 1 } });
  const dcFx = fixture('dreamcast-cdr');
  await app.add(dcFx.add);
  const dc = app.job('dc cdr');
  await app.settled(dc);
  await dc.locator('.repair-bar[data-repair="dcgaps"] button').click();
  await app.run(dc);
  const [dcChd] = await app.downloads(dc);
  if (nativeChdman()) {
    const inf = info(dcChd.path).raw;
    expect(inf).not.toMatch(/PREGAP:[1-9]/); // all pregaps absorbed -> PREGAP:0!
  }
  const dcRel = 'gen/p5-sat-gaps/dc-repaired.chd';
  fs.copyFileSync(dcChd.path, path.join(FIXTURES, dcRel));
  await app.open({ settings: { rename: false, threads: 1 } });
  await app.add([dcRel]);
  const exDc = app.job('dc-repaired');
  await app.settled(exDc);
  await app.run(exDc);
  const dcOuts = await app.downloads(exDc);
  const dcBin1 = dcOuts.find(o => /Track 1/.test(o.name));
  const dcBin2 = dcOuts.find(o => /Track 2/.test(o.name));
  expect(sha1File(dcBin1.path)).toBe(sha1File(path.join(FIXTURES, 'dc cdr (Track 1).bin')));
  expect(sha1File(dcBin2.path)).toBe(sha1File(path.join(FIXTURES, 'dc cdr (Track 2).bin')));
});

test('CHD Health Auditor detects issues, filters cards, and repairs via copy --stripmeta and -hs 2048', async ({ app, page }) => {
  const localChdman = path.join(ROOT, 'build', 'chdman-native');
  test.skip(!nativeChdman() || !fs.existsSync(localChdman), 'needs build/chdman-native to craft test CHDs');
  const dir = path.join(FIXTURES, 'gen', 'p5-audit');
  fs.mkdirSync(dir, { recursive: true });
  const badSat = path.join(dir, 'sat-cues.chd');
  const badPsp = path.join(dir, 'psp-4k.chd');
  // Saturn CHD carrying fatal CUES tag (using our Discpress native chdman --keepcue)
  execFileSync(localChdman, ['createcd', '-f', '-i', path.join(FIXTURES, 'albert odyssey.cue'), '-o', badSat, '--keepcue'], { stdio: 'ignore' });
  // PSP DVD CHD with 4096-byte hunks instead of 2048
  chdman(['createdvd', '-f', '-i', path.join(FIXTURES, 'frwl.iso'), '-o', badPsp, '-hs', '4096']);

  await app.open({ settings: { rename: false, threads: 1 } });
  await app.add(['gen/p5-audit/sat-cues.chd', 'gen/p5-audit/psp-4k.chd']);
  const cSat = app.job('sat-cues'), cPsp = app.job('psp-4k');
  await app.settled(cSat);
  await app.settled(cPsp);

  // Summary banner appears with counts & filter pills
  await expect(page.locator('#chdAudit')).toBeVisible();
  await expect(page.locator('#chdAudit')).toContainText('Broken (1)');
  await expect(page.locator('#chdAudit')).toContainText('Warnings (1)');
  await expect(cSat.locator('[data-audit="chd-strict-meta"]')).toBeVisible();
  await expect(cPsp.locator('[data-audit="chd-psp-layout"]')).toBeVisible();

  // Filter to Broken hides the warning card
  await page.locator('#chdAudit button', { hasText: 'Broken' }).click();
  await expect(cSat).toBeVisible();
  await expect(cPsp).toBeHidden();
  await page.locator('#chdAudit button', { hasText: 'All' }).click();
  await expect(cPsp).toBeVisible();

  // 1-click Strip extra metadata on Saturn CHD
  await cSat.locator('[data-audit="chd-strict-meta"] button').click();
  await app.waitState(cSat, 'done', 60_000);
  const [fixedSat] = await app.downloads(cSat);
  expect(info(fixedSat.path).raw).not.toContain("Tag='CUES'");

  // 1-click Fix 2,048-byte hunks on PSP CHD
  await cPsp.locator('[data-audit="chd-psp-layout"] button').click();
  await app.waitState(cPsp, 'done', 60_000);
  const [fixedPsp] = await app.downloads(cPsp);
  expect(info(fixedPsp.path).raw).toContain('Hunk Size:    2,048 bytes');
});

test('console folder grouping, ES-DE <Game>.m3u/ folder layout, and pre-flight collision dialog work end-to-end', async ({ app, page }) => {
  const dir = path.join(FIXTURES, 'gen', 'p5-esde');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [1, 2]) fs.copyFileSync(path.join(FIXTURES, 'twine.bin'), path.join(dir, `Hero (USA) (Disc ${n}).bin`));
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(dir, `Hero (USA) (Disc ${n}).cue`),
      `FILE "Hero (USA) (Disc ${n}).bin" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n`);
  }

  await page.addInitScript(nestedFakeFolder);
  await app.open({ settings: { storage: 'folder', rename: false, threads: 1, target: 'esde-modern', folderLayout: 'console' } });
  await app.add([
    'gen/p5-esde/Hero (USA) (Disc 1).cue', 'gen/p5-esde/Hero (USA) (Disc 1).bin',
    'gen/p5-esde/Hero (USA) (Disc 2).cue', 'gen/p5-esde/Hero (USA) (Disc 2).bin'
  ]);
  const d1 = app.job('Hero (USA) (Disc 1)'), d2 = app.job('Hero (USA) (Disc 2)');
  await app.settled(d1);
  await app.settled(d2);

  // Seed an existing Disc 1 CHD in psx/Hero (USA).m3u/ to trigger pre-flight #collisionDlg!
  await page.evaluate(() => {
    window.__tree.set('psx/Hero (USA).m3u/Hero (USA) (Disc 1).chd', new TextEncoder().encode('EXISTING'));
  });
  await page.click('#startAll');
  await expect(page.locator('#collisionDlg')).toBeVisible();
  await expect(page.locator('#collisionList')).toContainText('psx/Hero (USA).m3u/Hero (USA) (Disc 1).chd');
  // Choose Replace all -> both discs convert & auto-write ES-DE .m3u inside psx/Hero (USA).m3u/
  await page.locator('#collisionDlg button[value="replace"]').click();
  await app.waitState(d1, 'done', 60_000);
  await app.waitState(d2, 'done', 60_000);

  await expect.poll(() => page.evaluate(() => [...window.__tree.keys()].sort())).toEqual([
    'psx/Hero (USA).m3u/Hero (USA) (Disc 1).chd',
    'psx/Hero (USA).m3u/Hero (USA) (Disc 2).chd',
    'psx/Hero (USA).m3u/Hero (USA).m3u'
  ]);
  const m3u = await page.evaluate(() => new TextDecoder().decode(window.__tree.get('psx/Hero (USA).m3u/Hero (USA).m3u')));
  expect(m3u).toBe('Hero (USA) (Disc 1).chd\nHero (USA) (Disc 2).chd\n');
});
