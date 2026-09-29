#!/usr/bin/env python3
"""Build db/db.json.gz (the built-in game list) from libretro-database's Redump DATs.

Usage: db/mkdb.py <path to libretro-database checkout> [output]
Easiest: scripts/update-db.sh, which fetches libretro-database and runs this.
"""
import re, json, os, struct, sys, zlib

def gzip_fixed(data):
    """gzip at level 9 with a fixed header (mtime 0, OS byte 3), so the bytes don't depend on the Python
    version: 3.11 and 3.12 write zlib's header (OS 3 on Linux, 19 on macOS), 3.10 and 3.13+ write OS 255."""
    c = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    body = c.compress(data) + c.flush()
    return (b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\x03' + body +
            struct.pack('<II', zlib.crc32(data) & 0xffffffff, len(data) & 0xffffffff))
if len(sys.argv) < 2:
    sys.exit(__doc__)
D = os.path.join(sys.argv[1], 'metadat', 'redump') + os.sep
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'db.json.gz')
SYS = [('ps1','Sony - PlayStation.dat'),('ps2','Sony - PlayStation 2.dat'),('psp','Sony - PlayStation Portable.dat'),
       ('saturn','Sega - Saturn.dat'),('segacd','Sega - Mega-CD - Sega CD.dat'),('dc','Sega - Dreamcast.dat'),
       ('pcecd','NEC - PC Engine CD - TurboGrafx-CD.dat'),('pcfx','NEC - PC-FX.dat'),('ngcd','SNK - Neo Geo CD.dat'),
       ('3do','The 3DO Company - 3DO.dat'),('cdi','Philips - CD-i.dat'),('cd32','Commodore - CD32.dat'),('cdtv','Commodore - CDTV.dat'),
       ('jagcd','Atari - Jaguar CD.dat'),('naomi','Sega - Naomi.dat'),('naomi2','Sega - Naomi 2.dat'),('pc98','NEC - PC-98.dat')]
out = {}
tot = 0
game_re = re.compile(r'^game \($(.*?)^\)$', re.S | re.M)
for key, fn in SYS:
    txt = open(D + fn, encoding='utf-8').read()
    rows = []
    for g in game_re.finditer(txt):
        body = g.group(1)
        name = re.search(r'^\s*name "(.*)"$', body, re.M).group(1)
        m = re.search(r'rom \( name "(.*?)" size (\d+) crc ([0-9A-Fa-f]{8})', body)
        if not m: continue
        rname, size, crc = m.group(1), int(m.group(2)), m.group(3).upper()
        sm = re.search(r'^\s*serial "(.*)"$', body, re.M)
        serial = sm.group(1) if sm else ''
        # track hint: which track the rom is (e.g. Track 3)
        tm = re.search(r'\(Track 0*(\d+)\)\.\w+$', rname)
        track = tm.group(1) if tm else ''
        e = os.path.splitext(rname)[1][1:].lower()
        rows.append('\t'.join([name, serial, str(size), crc, track, e]))
    out[key] = '\n'.join(rows)
    tot += len(rows)
    print(key, len(rows))
ver = re.search(r'version "(.*?)"', open(D + SYS[0][1]).read()).group(1)
blob = json.dumps({'version': ver, 'systems': out}, ensure_ascii=False).encode()
gz = gzip_fixed(blob)
open(OUT, 'wb').write(gz)
print('entries', tot, 'raw', len(blob), 'gz', len(gz), 'version', ver)
