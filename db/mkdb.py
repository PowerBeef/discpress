#!/usr/bin/env python3
"""Build db/db.json.gz (the built-in game list) from libretro-database's Redump DATs.

Usage: db/mkdb.py <path to libretro-database checkout> [output]
Easiest: scripts/update-db.sh, which fetches libretro-database and runs this.

Each system's rows: name, serial, size, CRC-32, track, extension, tab-separated. A release Redump lists
under several serials (T-1214M and T-1214M-0, one game entry each with the same file) is one row whose
serials are joined with '|', in the order the DAT gives them.
"""
import io, json, os, re, struct, sys, xml.etree.ElementTree as ET, zipfile, zlib

UNARY_FLAGS = {'baddump', 'nodump', 'verified', 'good'}
TOK_RE = re.compile(r'"((?:\\.|[^"\\])*)"|(\()|(\))|([^\s()"]+)')


def disc_digest(tracks):
    """32-bit non-commutative Murmur3/FNV-1a cascade over ordered (size, crc32) tuples.
    Matches discDigest() in app/ident.js bit-for-bit."""
    h = (0x811C9DC5 ^ len(tracks)) & 0xffffffff
    for sz, crc in tracks:
        lo = sz & 0xffffffff
        hi = (sz >> 32) & 0xffffffff
        c = crc & 0xffffffff
        h = ((h ^ lo) * 0x01000193) & 0xffffffff
        h = ((h ^ hi) * 0x01000193) & 0xffffffff
        h = ((h ^ c) * 0x01000193) & 0xffffffff
        h = (((h >> 16) ^ h) * 0x85EBCA6B) & 0xffffffff
    h ^= (h >> 13)
    h = (h * 0xC2B2AE35) & 0xffffffff
    h ^= (h >> 16)
    return h & 0xffffffff


def parse_redump_xml(raw_bytes):
    """Parse an official Redump Logiqx XML DAT (raw XML or ZIP containing one XML).
    Returns (version, [(name, serial, [(rom_name, size, crc_int), ...]), ...])."""
    if raw_bytes[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
            xml_name = next((n for n in zf.namelist() if n.lower().endswith('.dat') or n.lower().endswith('.xml')), None)
            if not xml_name:
                return None, []
            raw_bytes = zf.read(xml_name)
    root = ET.fromstring(raw_bytes)
    hdr = root.find('header')
    ver = hdr.findtext('version', '').strip() if hdr is not None else ''
    games = []
    for g in root.findall('game'):
        name = g.attrib.get('name') or g.findtext('description', '').strip()
        if not name:
            continue
        serial = (g.findtext('serial') or '').strip()
        roms = []
        for r in g.findall('rom'):
            rn = r.attrib.get('name', '')
            sz = r.attrib.get('size', '')
            cr = r.attrib.get('crc', '').strip()
            if not rn or not sz.isdigit() or not re.fullmatch(r'[0-9A-Fa-f]{1,8}', cr):
                continue
            if rn.lower().endswith(('.cue', '.gdi', '.sbi', '.lsd')):
                continue
            roms.append((rn, int(sz), int(cr, 16) & 0xffffffff))
        if roms:
            games.append((name, serial, roms))
    return ver, games


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
args = sys.argv[1:]
xml_dir = None
if '--redump-xml' in args:
    xi = args.index('--redump-xml')
    xml_dir = args[xi + 1]
    del args[xi:xi + 2]
D = os.path.join(args[0], 'metadat', 'redump') + os.sep
OUT = args[1] if len(args) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'db.json.gz')
# (sys_key, libretro_dat_filename, redump_xml_code, optional)
SYS = [
    ('ps1', 'Sony - PlayStation.dat', 'psx', False),
    ('ps2', 'Sony - PlayStation 2.dat', 'ps2', False),
    ('psp', 'Sony - PlayStation Portable.dat', 'psp', False),
    ('saturn', 'Sega - Saturn.dat', 'ss', False),
    ('segacd', 'Sega - Mega-CD - Sega CD.dat', 'mcd', False),
    ('dc', 'Sega - Dreamcast.dat', 'dc', False),
    ('pcecd', 'NEC - PC Engine CD - TurboGrafx-CD.dat', 'pce', False),
    ('pcfx', 'NEC - PC-FX.dat', 'pcfx', False),
    ('ngcd', 'SNK - Neo Geo CD.dat', 'ngcd', False),
    ('3do', 'The 3DO Company - 3DO.dat', '3do', False),
    ('cdi', 'Philips - CD-i.dat', 'cdi', False),
    ('cd32', 'Commodore - CD32.dat', 'cd32', False),
    ('cdtv', 'Commodore - CDTV.dat', 'cdtv', False),
    ('jagcd', 'Atari - Jaguar CD.dat', 'ajcd', False),
    ('naomi', 'Sega - Naomi.dat', 'naomi', False),
    ('naomi2', 'Sega - Naomi 2.dat', 'naomi2', False),
    ('triforce', 'Namco - Sega - Nintendo - Triforce.dat', 'triforce', True),
    ('chihiro', 'Sega - Chihiro.dat', 'chihiro', True),
    ('pc98', 'NEC - PC-98.dat', 'pc98', False),
    ('fmtowns', 'Fujitsu - FM Towns series.dat', 'fmtowns', True),
    ('x68k', 'Sharp - X68000.dat', 'x68k', True),
    ('pippin', 'Bandai - Pippin.dat', 'pippin', True),
    ('playdia', 'Bandai - Playdia Quick Interactive System.dat', 'bdp', True),
    ('nuon', 'VM Labs - NUON.dat', 'nuon', True),
    ('amigacd', 'Commodore - Amiga CD.dat', 'acd', True),
    ('ks573', 'Konami - System 573.dat', 'ks573', True),
    ('ns246', 'Namco - System 246.dat', 'ns246', True),
]
out = {}
tot = 0
ver = None
for key, fn, rcode, optional in SYS:
    dat_path = D + fn
    xml_path = None
    if xml_dir:
        for cand in (rcode + '.zip', rcode + '.dat', rcode + '.xml'):
            p = os.path.join(xml_dir, cand)
            if os.path.exists(p):
                xml_path = p
                break
    # Optional Redump XML supplies full multi-track ntrk + discDigest keyed by (name, primary_size, primary_crc)
    xml_multi = {}
    xml_games = []
    if xml_path:
        xver, xml_games = parse_redump_xml(open(xml_path, 'rb').read())
        if ver is None and xver:
            ver = xver
        for xname, xser, xroms in xml_games:
            # primary data track: Track 3 for GD-ROMs (dc/naomi/triforce/chihiro), else Track 1 (or first track)
            if key in ('dc', 'naomi', 'naomi2', 'triforce', 'chihiro') and len(xroms) >= 3:
                prim = xroms[2]
            else:
                prim = xroms[0]
            dig = '%08X' % disc_digest([(sz, cr) for _, sz, cr in xroms]) if len(xroms) >= 2 else ''
            xml_multi[(xname, prim[1], '%08X' % prim[2])] = (len(xroms), dig)
    if not os.path.exists(dat_path):
        if xml_games:
            rows, serials = [], {}
            for xname, xser, xroms in xml_games:
                prim = xroms[2] if (key in ('dc', 'naomi', 'naomi2', 'triforce', 'chihiro') and len(xroms) >= 3) else xroms[0]
                rname, size, crc_i = prim
                crc = '%08X' % crc_i
                clean_field(xname, key + ' name')
                if xser:
                    clean_field(xser, key + ' serial', forbid_pipe=True)
                tm = re.search(r'\(Track 0*(\d+)\)\.\w+$', rname)
                track = tm.group(1) if tm else ''
                e = clean_field(os.path.splitext(rname)[1][1:].lower(), key + ' ext')
                ntrk = str(len(xroms)) if len(xroms) >= 2 else ''
                dig = '%08X' % disc_digest([(sz, cr) for _, sz, cr in xroms]) if len(xroms) >= 2 else ''
                k = (xname, size, crc, track, e, ntrk, dig)
                if k in serials:
                    if xser and xser not in serials[k]:
                        serials[k].append(xser)
                    continue
                serials[k] = [xser] if xser else []
                rows.append(k)
            rows = ['\t'.join([n, '|'.join(serials[(n, s, c, t, x, nt, dg)]), str(s), c, t, x] + ([nt, dg] if nt else []))
                    for n, s, c, t, x, nt, dg in rows]
            out[key] = '\n'.join(rows)
            tot += len(rows)
            print(key, len(rows), '(xml)')
            continue
        if optional:
            continue
        sys.exit('missing ' + dat_path)
    with open(dat_path, encoding='utf-8') as f:
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
        xm = xml_multi.get((name, size, crc))
        ntrk = str(xm[0]) if xm and xm[0] >= 2 else ''
        dig = xm[1] if xm and xm[0] >= 2 else ''
        k = (name, size, crc, track, e, ntrk, dig)
        if k in serials:
            if serial and serial not in serials[k]:
                serials[k].append(serial)
            continue
        serials[k] = [serial] if serial else []
        rows.append(k)
    rows = ['\t'.join([n, '|'.join(serials[(n, s, c, t, x, nt, dg)]), str(s), c, t, x] + ([nt, dg] if nt else []))
            for n, s, c, t, x, nt, dg in rows]
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
