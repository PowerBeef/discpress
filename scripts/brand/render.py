#!/usr/bin/env python3
"""Render the README brand graphics (docs/brand/*.png) from brand.html.

Needs Playwright with Chromium (pip install playwright && playwright install chromium)
and internet access for the Nunito / JetBrains Mono web fonts.
Screenshots of the app itself live in docs/screenshots/ (screenshots.py takes them).
"""
import os, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'docs', 'brand')
URL = 'file://' + os.path.join(HERE, 'brand.html')
JOBS = [(s, t) for s in ('hero', 'download', 'open', 'steps', 'features', 'systems', 'showcase') for t in ('light', 'dark')]
JOBS += [('divider', 'light'), ('mark', 'light')]

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1400, 'height': 1000}, device_scale_factor=2)
    # the web fonts are fetched here, not by the browser, which may not trust a proxy's certificate
    # (a font that fails to load silently falls back to another, and every graphic changes)
    def font(route):
        with urllib.request.urlopen(urllib.request.Request(route.request.url, headers={'User-Agent': route.request.headers.get('user-agent', '')})) as r:
            route.fulfill(status=r.status, headers={'Content-Type': r.headers['Content-Type'], 'Access-Control-Allow-Origin': '*'}, body=r.read())
    pg.route('https://fonts.googleapis.com/**', font)
    pg.route('https://fonts.gstatic.com/**', font)
    def shot(scene, theme, name, flat=False, m=False):
        pg.goto('%s?scene=%s&theme=%s%s%s' % (URL, scene, theme, '&flat=1' if flat else '', '&m=1' if m else ''))
        pg.evaluate('document.fonts.ready')
        pg.wait_for_function('[...document.images].every(i => !i.closest(".on") || (i.complete && i.naturalWidth))')
        pg.locator('#' + scene).screenshot(path=os.path.join(OUT, name), omit_background=True)
        print(name)
    for scene, theme in JOBS:
        name = {'divider': 'divider.png', 'mark': 'logo.png'}.get(scene, '%s-%s.png' % (scene, theme))
        shot(scene, theme, name)
    # narrow layouts shown on phones (README <picture> sources with max-width)
    for scene in ('hero', 'steps', 'features', 'systems'):
        for theme in ('light', 'dark'):
            shot(scene, theme, '%s-mobile-%s.png' % (scene, theme), m=True)
    # 1280x640 image for GitHub's social preview (Settings > General > Social preview)
    shot('hero', 'light', 'social-preview.png', flat=True)
    b.close()
