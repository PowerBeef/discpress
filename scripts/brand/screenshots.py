#!/usr/bin/env python3
"""Take the app screenshots the README graphics show (docs/screenshots/*.png), from dist/discpress.html.

Needs Playwright with Chromium (pip install playwright && playwright install chromium) and the
synthetic test discs (python3 tests/fixtures/make_fixtures.py). Then run render.py.

- desktop-<theme>.png: 1280x800 at 2x, three games added, the first converted
- phone-start-<theme>.png: 390x844 at 3x, the empty start screen
- phone-ident-<theme>.png: 390x844 at 3x, a PlayStation disc identified, with its version picker
"""
import functools, http.server, os, sys, threading
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
DIST = os.path.abspath(os.path.join(ROOT, 'dist'))
FIX = os.path.abspath(os.path.join(ROOT, 'tests', '.cache', 'fixtures'))
OUT = os.path.join(ROOT, 'docs', 'screenshots')
SATURN = ['albert odyssey.cue', 'albert odyssey.bin']
MGS = ['mgs disc1.cue', 'mgs disc1 (Track 1).bin', 'mgs disc1 (Track 2).bin']
PS2 = ['agent.iso']
if not os.path.exists(os.path.join(FIX, 'agent.iso')):
    sys.exit('no test discs in %s: run tests/fixtures/make_fixtures.py first' % FIX)

# settings, and a stored speed test (4 threads) so the page doesn't measure the device first
SEED = '''t => {
  localStorage.clear();
  localStorage.setItem('chdman-web-settings', JSON.stringify({ theme: t }));
  localStorage.setItem('chdman-web-tuning', JSON.stringify({ key: navigator.hardwareConcurrency + '|' + navigator.userAgent,
    threads: 4, rate: 1, steps: [[1, 1]], cores: navigator.hardwareConcurrency, date: Date.now() }));
}'''
SETTLED = '''n => {
  const cards = [...document.querySelectorAll('#jobs article.job')];
  return cards.length === n && cards.every(c => /^(ready|blocked|done)$/.test(c.dataset.state) &&
    ![...c.querySelectorAll('.note')].some(x => /Identifying|Checking against/.test(x.textContent)));
}'''


def open_page(browser, theme, phone):
    ctx = browser.new_context(viewport={'width': 390, 'height': 844} if phone else {'width': 1280, 'height': 800},
                              device_scale_factor=3 if phone else 2, is_mobile=phone, has_touch=phone, color_scheme=theme)
    pg = ctx.new_page()
    pg.goto(PAGE)
    pg.evaluate(SEED, theme)
    pg.goto(PAGE)
    pg.wait_for_function("/ready/i.test(document.querySelector('#chipEngine').textContent)", timeout=60000)
    return ctx, pg


def add(pg, names):
    with pg.expect_file_chooser() as fc:
        pg.click('#addFiles')
    fc.value.set_files([os.path.join(FIX, n) for n in names])


def shot(pg, name):
    pg.evaluate("document.querySelectorAll('#toasts .toast').forEach(t => t.remove())")
    pg.wait_for_timeout(300)
    pg.screenshot(path=os.path.join(OUT, name), animations='disabled')
    print(name)


# served from localhost, as online: a page opened as a file gets no private storage in Chromium,
# and says so in a notice
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Quiet, directory=DIST))
threading.Thread(target=srv.serve_forever, daemon=True).start()
PAGE = 'http://127.0.0.1:%d/discpress.html' % srv.server_address[1]

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    for theme in ('light', 'dark'):
        ctx, pg = open_page(b, theme, phone=False)
        n = 0
        for names in (SATURN, MGS, PS2):  # one at a time, so the cards keep this order
            add(pg, names)
            n += 1
            pg.wait_for_function(SETTLED, arg=n, timeout=120000)
        first = pg.locator('#jobs article.job').first
        first.locator('.job-foot button.primary').click()
        pg.wait_for_function("document.querySelector('#jobs article.job').dataset.state === 'done'", timeout=120000)
        pg.evaluate('window.scrollTo(0, 0)')
        shot(pg, 'desktop-%s.png' % theme)
        ctx.close()

        ctx, pg = open_page(b, theme, phone=True)
        shot(pg, 'phone-start-%s.png' % theme)
        add(pg, MGS)
        pg.wait_for_function(SETTLED, arg=1, timeout=120000)
        shot(pg, 'phone-ident-%s.png' % theme)
        ctx.close()
    b.close()
srv.shutdown()
