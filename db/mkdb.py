#!/usr/bin/env python3
"""Build db/db.json.gz (the built-in game list) from libretro-database's Redump DATs.

Usage: db/mkdb.py <path to libretro-database checkout> [output]
Easiest: scripts/update-db.sh, which fetches libretro-database and runs this.

Each system's rows: name, serial, size, CRC-32, track, extension, tab-separated. A release Redump lists
under several serials (T-1214M and T-1214M-0, one game entry each with the same file) is one row whose
serials are joined with '|', in the order the DAT gives them.
"""
import json, os, re, struct, sys, zlib

UNARY_FLAGS = {'baddump', 'nodump', 'verified', 'good'}
TOK_RE = re.compile(r'"((?:\\.|[^"\\])*)"|(\()|(\))|([^\s()"]+)')


def gzip_fixed(data):
    """gzip at level 9 with a fixed header (mtime 0, OS byte 3), so the bytes don't depend on the Python
    version: 3.11 and 3.12 write zlib's header (OS 3 on Linux, 19 on macOS), 3.10 and 3.13+ write OS 255."""
    c = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    body = c.compress(data) + c.flush()
    return (b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\x03' + body +
            struct.pack('<II', zlib.crc32(data) & 0xffffffff, len(data) & 0xffffffff))


def tokenize_dat(txt):
    """Tokenize clrmamepro DAT text, skipping # and // comments outside quotes and unescaping strings."""
    tokens = []
    for line in txt.splitlines():
        # Strip comments outside double quotes
        in_q = False
        esc = False
        cut = len(line)
        for i, ch in enumerate(line):
            if esc:
                esc = False
                continue
            if ch == '\\' and in_q:
                esc = True
                continue
            if ch == '"':
                in_q = not in_q
                continue
            if not in_q and (ch == '#' or (ch == '/' and i + 1 < len(line) and line[i + 1] == '/')):
                cut = i
                break
        seg = line[:cut]
        for m in TOK_RE.finditer(seg):
            if m.group(1) is not None:
                tokens.append(re.sub(r'\\(.)', r'\1', m.group(1)))
            else:
                tokens.append(m.group(0))
    return tokens


def parse_block(tokens, idx):
    """Parse a balanced (...) block starting right after '('; return (fields_dict, roms_list, next_idx)."""
    fields = {}
    roms = []
    n = len(tokens)
    while idx < n:
        t = tokens[idx]
        idx += 1
        if t == ')':
            return fields, roms, idx
        if idx < n and tokens[idx] == '(':
            sub_fields, _, idx = parse_block(tokens, idx + 1)
            if t == 'rom':
                roms.append(sub_fields)
        elif t.lower() in UNARY_FLAGS:
            fields[t.lower()] = True
        elif idx < n and tokens[idx] != ')':
            fields[t] = tokens[idx]
            idx += 1
    return fields, roms, idx


def parse_dat(txt):
    tokens = tokenize_dat(txt)
    header = {}
    games = []
    i = 0
    n = len(tokens)
    while i < n:
        t = tokens[i]
        i += 1
        if i < n and tokens[i] == '(':
            fields, roms, i = parse_block(tokens, i + 1)
            if t == 'clrmamepro':
                header = fields
            elif t == 'game':
                games.append((fields, roms))
    return header, games


def clean_field(val, what, forbid_pipe=False):
    if '\t' in val or '\n' in val or '\r' in val or (forbid_pipe and '|' in val):
        sys.exit('invalid delimiter in %s: %r' % (what, val))
    return val


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
ver = None
for key, fn in SYS:
    with open(D + fn, encoding='utf-8') as f:
        txt = f.read()
    header, games = parse_dat(txt)
    if ver is None:
        ver = header.get('version')
    rows, serials = [], {}  # (the same release under another serial: its serial joins the row's)
    for gfields, roms in games:
        name = gfields.get('name')
        if not name or not roms:
            continue
        rom = None
        for r in roms:
            if 'name' in r and 'size' in r and 'crc' in r:
                rom = r
                break
        if not rom:
            continue
        rname = rom['name']
        size_s = rom['size']
        crc_s = rom['crc'].strip()
        if not size_s.isdigit() or not re.fullmatch(r'[0-9A-Fa-f]{1,8}', crc_s):
            continue
        size = int(size_s)
        crc = crc_s.upper().zfill(8)
        serial = gfields.get('serial', '')
        clean_field(name, key + ' name')
        if serial:
            clean_field(serial, key + ' serial', forbid_pipe=True)
        # track hint: which track the rom is (e.g. Track 3)
        tm = re.search(r'\(Track 0*(\d+)\)\.\w+$', rname)
        track = tm.group(1) if tm else ''
        e = clean_field(os.path.splitext(rname)[1][1:].lower(), key + ' ext')
        k = (name, size, crc, track, e)
        if k in serials:
            if serial and serial not in serials[k]:
                serials[k].append(serial)
            continue
        serials[k] = [serial] if serial else []
        rows.append(k)
    rows = ['\t'.join([n, '|'.join(serials[(n, s, c, t, x)]), str(s), c, t, x]) for n, s, c, t, x in rows]
    out[key] = '\n'.join(rows)
    tot += len(rows)
    print(key, len(rows))
if not ver:
    sys.exit('missing version in ' + SYS[0][1])
blob = json.dumps({'version': ver, 'systems': out}, ensure_ascii=False).encode()
gz = gzip_fixed(blob)
with open(OUT, 'wb') as f:
    f.write(gz)
print('entries', tot, 'raw', len(blob), 'gz', len(gz), 'version', ver)
