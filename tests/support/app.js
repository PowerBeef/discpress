// Page driver + Playwright fixtures for Discpress.
//
// Every test that uses `app` also checks, when it ends, that the page logged no
// console errors / uncaught exceptions and made no network requests (the app
// promises to work offline and upload nothing).
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES, TESTS, pageUnderTest } from './paths.js';

export { expect };

export function manifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
}
export function fixture(key) {
  const f = manifest().find(x => x.key === key);
  if (!f) throw new Error(`no fixture ${key}`);
  return f;
}
export const fixturePath = name => path.join(FIXTURES, name);

// Stores the requested settings before the app loads. Runs on a blank page of the same origin:
// written from an init script at document start instead, Chromium sometimes never saved the
// page's own storage (seen with file:// pages).
function seedStorage(o) {
  try {
    if (o.settings) localStorage.setItem('chdman-web-settings', JSON.stringify(o.settings));
    if (o.debug) localStorage.setItem('chdman-web-debug', JSON.stringify(o.debug));
    // a stored per-device speed test, so tests don't each spend seconds measuring (tuned: false opts out)
    if (o.tuned !== false) {
      const cores = Math.max(1, o.cores || navigator.hardwareConcurrency || 4);
      localStorage.setItem('chdman-web-tuning', JSON.stringify({ key: cores + '|' + navigator.userAgent,
        threads: Math.min(4, cores), rate: 1, steps: [[1, 1]], cores, date: Date.now(), ...o.tuning }));
    }
  } catch (e) { /* storage may be blocked */ }
}

// Runs in the page before any app code.
function initScript(o) {
  if (o.noSimd) {
    // the app feature-tests SIMD with a tiny module that contains the 0xFD opcode prefix
    const validate = WebAssembly.validate;
    WebAssembly.validate = function (b) {
      const u = b instanceof Uint8Array ? b : new Uint8Array(b.buffer || b);
      if (u.length < 64 && u.includes(0xfd)) return false;
      return validate.apply(this, arguments);
    };
  }
  if (o.noOpfs && navigator.storage) {
    Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined });
  }
  if (o.cores) Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => o.cores });
}

export class App {
  constructor(page, testInfo, fileUrl) {
    this.page = page;
    this.testInfo = testInfo;
    this.fileUrl = fileUrl;
    this.errors = [];
    this.requests = [];
    this.allowed = [];
    page.on('console', m => { if (m.type() === 'error') this.errors.push(m.text()); });
    page.on('pageerror', e => this.errors.push('uncaught: ' + e.message));
    page.on('request', r => this.requests.push(r.url()));
    page.on('dialog', d => d.accept());
  }

  /** Open the page. Options: settings, debug, noSimd, noOpfs, cores, theme, testdb (extra database rows),
   *  tuned (false: no stored per-device speed test, so automatic threads measure the device),
   *  tuning (fields that replace the stored speed test's). */
  async open(opts = {}) {
    const o = { ...opts };
    if (o.theme) o.settings = { ...(o.settings || {}), theme: o.theme };
    await this.page.goto(this.fileUrl ? pathToFileURL(path.join(TESTS, 'support', 'blank.html')).href : '/blank.html');
    await this.page.evaluate(seedStorage, o);
    this.requests = [];
    await this.page.addInitScript(initScript, o);
    this.url = this.fileUrl ? pathToFileURL(pageUnderTest()).href : '/discpress.html' + (o.testdb ? '?testdb=1' : '');
    await this.page.goto(this.url);
    await expect(this.page.locator('#chipEngine')).toContainText(/ready/i, { timeout: 60_000 });
    return this;
  }

  allowErrors(re) { this.allowed.push(re); }
  unexpectedErrors() { return this.errors.filter(e => !this.allowed.some(re => re.test(e))); }
  foreignRequests() {
    const page = this.page.url().split('#')[0];
    return [...new Set(this.requests)].filter(u => !(u.split('#')[0] === page || u.startsWith('blob:') || u.startsWith('data:')));
  }

  /** Add fixture files through the real file chooser. */
  async add(names, { via = '#addFiles' } = {}) {
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), this.page.click(via)]);
    await chooser.setFiles(names.map(fixturePath));
  }

  jobs() { return this.page.locator('#jobs article.job'); }
  job(title) { return this.jobs().filter({ has: this.page.locator('h3', { hasText: new RegExp(`^${escapeRe(title)}$`) }) }); }

  async waitState(card, states, timeout = 120_000) {
    const list = [].concat(states);
    await expect.poll(async () => card.getAttribute('data-state'), { timeout, intervals: [100, 250, 500] }).toMatch(new RegExp(`^(${list.join('|')})$`));
    return card.getAttribute('data-state');
  }

  /** Wait until identification has finished (no "Identifying…" note left). */
  async settled(card) {
    await this.waitState(card, ['ready', 'blocked']);
    await expect(card.locator('.note', { hasText: /Identifying|Checking against/ })).toHaveCount(0, { timeout: 60_000 });
  }

  async run(card, { expectState = 'done', timeout = 180_000 } = {}) {
    await card.locator('.job-foot button.primary').click();
    const st = await this.waitState(card, ['done', 'error', 'canceled'], timeout);
    if (st !== expectState) {
      const text = await card.innerText();
      throw new Error(`job ended "${st}", expected "${expectState}":\n${text}`);
    }
  }

  /** Download every output of a finished job; returns [{name, path}]. */
  async downloads(card) {
    const buttons = card.locator('.result .out button');
    const n = await buttons.count();
    const dir = this.testInfo.outputPath('downloads');
    fs.mkdirSync(dir, { recursive: true });
    const out = [];
    for (let i = 0; i < n; i++) {
      const [dl] = await Promise.all([this.page.waitForEvent('download'), buttons.nth(i).click()]);
      const p = path.join(dir, dl.suggestedFilename());
      await dl.saveAs(p);
      out.push({ name: dl.suggestedFilename(), path: p });
    }
    return out;
  }

  command(card) { return card.locator('code.cmd').textContent(); }

  async settings(values) {
    await this.page.click('#settingsBtn');
    for (const [id, v] of Object.entries(values)) {
      const el = this.page.locator('#' + id);
      if (typeof v === 'boolean') await el.setChecked(v); else await el.selectOption(String(v));
    }
    await this.page.click('#settingsClose');
  }
}

export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export const test = base.extend({
  fileUrl: [false, { option: true }],
  app: async ({ page, fileUrl }, use, testInfo) => {
    const app = new App(page, testInfo, fileUrl);
    await use(app);
    expect(app.unexpectedErrors(), 'console errors or uncaught exceptions').toEqual([]);
    expect(app.foreignRequests(), 'network requests (the app must work offline)').toEqual([]);
  },
});
