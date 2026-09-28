#!/usr/bin/env node
// Conversion benchmarks: times real conversions through the Discpress UI in headless
// Chromium and compares them with native chdman on the same machine.
//
//   node bench/bench.js [options]
//     --fixtures bench-cd,bench-dvd   fixture keys (see fixtures/make_fixtures.py; --quick uses small ones)
//     --quick                         small test fixtures instead of the large benchmark images
//     --ops create,extract            what to time: making CHDs and/or extracting them again
//     --threads 1,2,4                 compression thread counts (default: 1, 2, 4 ... up to the CPU count)
//     --simd on,off                   WebAssembly SIMD build, baseline build, or both
//     --presets default,fast          compression presets: default, fast, zstd, none
//     --repeat 1                      runs per configuration; the median is reported
//     --no-native                     skip the native chdman baseline
//     --no-native-timing              still verify against native chdman, but don't time it
//     --no-verify                     skip checking outputs against native chdman
//     --html PATH                     page to test (default dist/discpress.html)
//     --label NAME                    name for this run (saved as .cache/bench/<time>-<label>.json)
//     --compare FILE|latest           show the change against an earlier run
//     --cd-mb 300 --dvd-mb 1024       size of the generated benchmark images
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CACHE, FIXTURES, ROOT, TESTS } from '../support/paths.js';
import { nativeChdman, sameVersion } from '../support/native.js';

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : argv[i + 1]; };
const flag = name => argv.includes('--' + name);
const list = (name, def) => String(opt(name, def)).split(',').map(s => s.trim()).filter(Boolean);
const cores = os.cpus().length;
const quick = flag('quick');
const cfg = {
  fixtures: list('fixtures', quick ? 'ps1-multitrack,ps2-dvd' : 'bench-cd,bench-dvd'),
  ops: list('ops', 'create,extract'),
  threads: list('threads', [1, 2, 4, 8, 16].filter(t => t <= cores).join(',')).map(Number),
  simd: list('simd', 'on'),
  presets: list('presets', 'default'),
  repeat: +opt('repeat', 1),
  native: !flag('no-native') && !!nativeChdman(),
  nativeTiming: !flag('no-native-timing'),
  verify: !flag('no-verify'),
  html: path.resolve(ROOT, opt('html', process.env.DISCPRESS_HTML || 'dist/discpress.html')),
  label: opt('label', 'run'),
  compare: opt('compare', null),
};
const CODECS = {
  cd: { default: [], fast: ['-c', 'cdzl,cdfl'], zstd: ['-c', 'cdzs,cdfl'], none: ['-c', 'none'] },
  other: { default: [], fast: ['-c', 'zlib,huff'], zstd: ['-c', 'zstd'], none: ['-c', 'none'] },
};
const PRESET_LABEL = { default: 'Smallest (default)', fast: 'Faster to create', zstd: 'Faster to load (Zstd)', none: 'No compression' };

// ------------------------------------------------------------------ fixtures
const needBench = cfg.fixtures.some(k => k.startsWith('bench-'));
execFileSync('python3', [path.join(TESTS, 'fixtures', 'make_fixtures.py'), '--out', FIXTURES,
  ...(needBench ? ['--bench', '--cd-mb', opt('cd-mb', '300'), '--dvd-mb', opt('dvd-mb', '1024')] : [])], { stdio: 'inherit' });
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const fixtures = cfg.fixtures.map(k => manifest.find(f => f.key === k) || die(`unknown fixture ${k}`));
const mainInput = fx => fx.add.find(n => /\.(cue|gdi)$/i.test(n)) || fx.add[0];
const inputBytes = fx => fx.add.reduce((s, n) => s + fs.statSync(path.join(FIXTURES, n)).size, 0);
const codecs = (fx, preset) => CODECS[fx.disc === 'cd' || fx.disc === 'gdrom' ? 'cd' : 'other'][preset];

function die(msg) { console.error(msg); process.exit(1); }
const sha1 = p => { const h = crypto.createHash('sha1'); const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(8 << 20); let n; while ((n = fs.readSync(fd, b)) > 0) h.update(b.subarray(0, n)); fs.closeSync(fd); return h.digest('hex'); };
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

// ------------------------------------------------------------------ native baseline
const work = fs.mkdtempSync(path.join(CACHE, 'bench-work-'));
function nativeRun(args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(nativeChdman().bin, args, { cwd: FIXTURES, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) die(`native chdman failed: ${args.join(' ')}\n${r.stderr}`);
  return Number(process.hrtime.bigint() - t0) / 1e9;
}
const nativeRefs = {};
function nativeRef(fx, preset) {
  const key = `${fx.key}-${preset}`;
  if (!nativeRefs[key]) {
    const out = path.join(work, `${key}.chd`);
    nativeRun([fx.command, '-i', mainInput(fx), '-o', out, '-f', ...codecs(fx, preset)]);
    nativeRefs[key] = out;
  }
  return nativeRefs[key];
}

// ------------------------------------------------------------------ memory sampling
// peak resident memory of the browser process tree (page + workers), via ps
function treeRss(rootPid) {
  try {
    const ps = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    const rows = ps.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let total = 0; const stack = [...(kids.get(rootPid) || [])]; // descendants only (the browser), not this script
    while (stack.length) { const p = stack.pop(); total += rss.get(p) || 0; stack.push(...(kids.get(p) || [])); }
    return total * 1024;
  } catch { return 0; }
}

// ------------------------------------------------------------------ browser runs
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/discpress.html')) { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(cfg.html)); }
  else { r.writeHead(404); r.end(); }
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/discpress.html`;
// Each run gets a fresh persistent profile: like a normal browser window, and unlike an
// incognito-style context, whose storage quota (tied to free disk space) can be below 1 GB.
const browserPid = process.pid; // Chromium runs as a child of this process

async function appRun({ fx, op, threads, simd, preset, chdInput }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'discpress-bench-'));
  const ctx = await chromium.launchPersistentContext(profile, { acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(o => {
    localStorage.setItem('chdman-web-settings', JSON.stringify({ threads: o.threads }));
    if (!o.simd) {
      const v = WebAssembly.validate;
      WebAssembly.validate = function (b) { const u = b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b); return u.length < 64 && u.includes(0xfd) ? false : v.apply(this, arguments); };
    }
  }, { threads, simd });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => /ready/i.test(document.getElementById('chipEngine')?.textContent || ''), null, { timeout: 60_000 });
  const files = op === 'extract' ? [chdInput] : fx.add.map(n => path.join(FIXTURES, n));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#addFiles')]);
  await chooser.setFiles(files);
  const card = page.locator('#jobs article.job').first();
  await page.waitForFunction(() => {
    const c = document.querySelector('#jobs article.job');
    return c && c.dataset.state === 'ready' && !/Identifying|Checking against|Reading CHD/.test(c.innerText);
  }, null, { timeout: 600_000 });
  if (op === 'create' && preset !== 'default') {
    await card.locator('details.opts summary').click();
    await card.locator('label.field', { hasText: 'Compression' }).locator('select').selectOption({ label: PRESET_LABEL[preset] });
  }
  if (op === 'extract') await card.locator('label.field', { hasText: 'Output name' }).locator('input').fill('bench-out');
  // record state changes with the page's own clock
  await page.evaluate(() => {
    const c = document.querySelector('#jobs article.job');
    window.__bench = { [c.dataset.state]: performance.now() };
    new MutationObserver(() => { window.__bench[c.dataset.state] ??= performance.now(); }).observe(c, { attributes: true, attributeFilter: ['data-state'] });
  });
  let peak = 0;
  const sampler = browserPid ? setInterval(() => { peak = Math.max(peak, treeRss(browserPid)); }, 250) : null;
  await card.locator('.job-foot button.primary').click();
  await page.waitForFunction(() => /^(done|error|canceled)$/.test(document.querySelector('#jobs article.job').dataset.state), null, { timeout: 3_600_000 });
  if (sampler) clearInterval(sampler);
  const t = await page.evaluate(() => window.__bench);
  const state = await card.getAttribute('data-state');
  if (state !== 'done') die(`app ${op} ${fx.key} ended "${state}":\n${await card.innerText()}`);
  const seconds = (t.done - t.running) / 1000;
  // collect outputs (downloads) for size + verification
  const outs = [];
  const buttons = card.locator('.result .out button');
  for (let i = 0; i < await buttons.count(); i++) {
    const [dl] = await Promise.all([page.waitForEvent('download'), buttons.nth(i).click()]);
    const p = path.join(work, `app-${dl.suggestedFilename()}`);
    await dl.saveAs(p);
    outs.push({ name: dl.suggestedFilename(), path: p, size: fs.statSync(p).size });
  }
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  if (errors.length) die(`page errors: ${errors.join('; ')}`);
  return { seconds, peakRss: peak, outs };
}

// ------------------------------------------------------------------ run everything
const results = [];
const log = s => process.stderr.write(s + '\n');
log(`page ${path.relative(ROOT, cfg.html)} · ${cores} CPUs · native chdman ${cfg.native ? nativeChdman().version : 'off'}`);
for (const fx of fixtures) {
  const inBytes = inputBytes(fx);
  for (const preset of cfg.presets) {
    for (const op of cfg.ops) {
      const chdInput = op === 'extract' ? (cfg.native ? nativeRef(fx, preset) : null) : null;
      if (op === 'extract' && !chdInput) { log('extract needs native chdman to make the input CHD; skipped'); continue; }
      for (const simd of cfg.simd.map(s => s === 'on')) {
        for (const threads of cfg.threads) {
          const runs = [];
          for (let r = 0; r < cfg.repeat; r++) {
            const res = await appRun({ fx, op, threads, simd, preset, chdInput });
            runs.push(res);
            log(`  ${fx.key} ${op} ${preset} simd=${simd ? 'on' : 'off'} threads=${threads} run ${r + 1}: ${res.seconds.toFixed(2)} s`);
          }
          const last = runs[runs.length - 1];
          let verified = null;
          if (cfg.verify && cfg.native) {
            if (op === 'create') {
              const ref = nativeRef(fx, preset);
              verified = sameVersion() ? sha1(last.outs[0].path) === sha1(ref) : null;
            } else {
              const refDir = fs.mkdtempSync(path.join(work, 'x-'));
              const ext = { cd: '.cue', gdrom: '.gdi', dvd: '.iso', hd: '.img' }[fx.disc];
              nativeRun([`extract${fx.disc === 'gdrom' ? 'cd' : fx.disc}`, '-i', chdInput, '-o', path.join(refDir, 'bench-out' + ext)]);
              verified = last.outs.every(o => fs.existsSync(path.join(refDir, o.name)) && sha1(o.path) === sha1(path.join(refDir, o.name)));
            }
            if (verified === false) die(`output of ${fx.key} ${op} ${preset} differs from native chdman`);
          }
          const secs = median(runs.map(x => x.seconds));
          const outBytes = last.outs.reduce((s, o) => s + o.size, 0);
          results.push({
            fixture: fx.key, op, preset, simd, threads, seconds: +secs.toFixed(3), runs: runs.map(x => +x.seconds.toFixed(3)),
            inputMB: +((op === 'create' ? inBytes : fs.statSync(chdInput).size) / 1048576).toFixed(1),
            outputMB: +(outBytes / 1048576).toFixed(1), ratio: op === 'create' ? +(outBytes / inBytes).toFixed(4) : null,
            mbps: +((op === 'create' ? inBytes : outBytes) / 1048576 / secs).toFixed(1),
            peakRssMB: Math.round(Math.max(...runs.map(x => x.peakRss)) / 1048576) || null,
            verified,
          });
        }
      }
      // native baseline for the same work
      if (cfg.native && cfg.nativeTiming) {
        const threadsList = cfg.threads;
        for (const threads of threadsList) {
          const times = [];
          for (let r = 0; r < cfg.repeat; r++) {
            if (op === 'create') times.push(nativeRun([fx.command, '-i', mainInput(fx), '-o', path.join(work, 'n.chd'), '-f', '-np', String(threads), ...codecs(fx, preset)]));
            else { const d = fs.mkdtempSync(path.join(work, 'n-')); const ext = { cd: '.cue', gdrom: '.gdi', dvd: '.iso', hd: '.img' }[fx.disc]; times.push(nativeRun([`extract${fx.disc === 'gdrom' ? 'cd' : fx.disc}`, '-i', chdInput, '-o', path.join(d, 'o' + ext)])); fs.rmSync(d, { recursive: true }); }
          }
          const secs = median(times);
          results.push({ fixture: fx.key, op, preset, simd: 'native', threads, seconds: +secs.toFixed(3), runs: times.map(x => +x.toFixed(3)),
            inputMB: +((op === 'create' ? inBytes : fs.statSync(chdInput).size) / 1048576).toFixed(1), mbps: +((op === 'create' ? inBytes : results.at(-1).outputMB * 1048576) / 1048576 / secs).toFixed(1) });
          log(`  ${fx.key} ${op} ${preset} native threads=${threads}: ${secs.toFixed(2)} s`);
        }
      }
    }
  }
}
server.close();
fs.rmSync(work, { recursive: true, force: true });

// ------------------------------------------------------------------ report
const outDir = path.join(CACHE, 'bench');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const meta = { label: cfg.label, date: new Date().toISOString(), cpus: cores, cpuModel: os.cpus()[0]?.model, page: path.relative(ROOT, cfg.html),
  pageSha1: sha1(cfg.html).slice(0, 12), native: cfg.native ? nativeChdman().version : null, config: cfg };
let previous = null;
if (cfg.compare) {
  const f = cfg.compare === 'latest' ? fs.readdirSync(outDir).filter(n => n.endsWith('.json')).sort().pop() : cfg.compare;
  if (f) previous = JSON.parse(fs.readFileSync([path.resolve(f), path.join(outDir, f)].find(p => fs.existsSync(p)) || f, 'utf8'));
}
const keyOf = r => [r.fixture, r.op, r.preset, r.simd, r.threads].join('|');
const prev = new Map((previous?.results || []).map(r => [keyOf(r), r]));
const nativeOf = r => results.find(n => n.simd === 'native' && n.fixture === r.fixture && n.op === r.op && n.preset === r.preset && n.threads === r.threads);
const rows = results.map(r => {
  const n = r.simd !== 'native' ? nativeOf(r) : null, p = prev.get(keyOf(r));
  return `| ${r.fixture} | ${r.op} | ${r.preset} | ${r.simd === 'native' ? 'native' : r.simd ? 'SIMD' : 'baseline'} | ${r.threads} | ${r.seconds.toFixed(2)} | ${r.mbps} | ${r.ratio != null ? (100 * r.ratio).toFixed(1) + '%' : ''} | ${r.peakRssMB ?? ''} | ${n ? (r.seconds / n.seconds).toFixed(2) + '×' : ''} | ${p ? ((r.seconds / p.seconds - 1) * 100).toFixed(1) + '%' : ''} | ${r.verified == null ? '' : r.verified ? '✓' : '✗'} |`;
});
const md = [`# Discpress benchmark: ${cfg.label}`, '',
  `${meta.date} · ${cores} × ${meta.cpuModel} · page \`${meta.page}\` (${meta.pageSha1}) · native chdman ${meta.native || 'not used'}` + (previous ? ` · compared with "${previous.meta.label}" (${previous.meta.date})` : ''), '',
  '| fixture | op | preset | build | threads | seconds (median) | MB/s | size | peak RSS MB | vs native | vs previous | same as native |',
  '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|', ...rows, '',
  'MB/s is input size for create and output size for extract. "vs native" is app time ÷ native time (lower is better).',
  '"same as native": output byte-identical to native chdman (create) or identical extracted files (extract).'].join('\n');
const base = path.join(outDir, `${stamp}-${cfg.label}`);
fs.writeFileSync(base + '.json', JSON.stringify({ meta, results }, null, 1));
fs.writeFileSync(base + '.md', md + '\n');
console.log(md);
log(`\nsaved ${path.relative(TESTS, base)}.json / .md`);
