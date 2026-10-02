#!/usr/bin/env python3
"""Generate the synthetic test and benchmark discs into tests/.cache/fixtures.

Usage: tests/fixtures/make_fixtures.py [--bench] [--cd-mb N] [--dvd-mb N] [--out DIR]

Test fixtures are small (a few MB in total) and cover every input type and every
console the identifier knows how to recognize. They use serial numbers of real
games (so identification by serial can be tested against the built-in database)
but contain no game data. --bench also writes large, realistic images for timing.

Writes manifest.json describing each fixture: the files to add, the job the app
should make from them, and what identification should report. Generation is
deterministic and skipped for fixtures whose files already exist.
"""
import argparse, json, os, sys, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discgen as g

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--out', default=os.path.join(HERE, '..', '.cache', 'fixtures'))
ap.add_argument('--bench', action='store_true', help='also make the large benchmark images')
ap.add_argument('--cd-mb', type=int, default=300, help='benchmark CD size (data + audio)')
ap.add_argument('--dvd-mb', type=int, default=1024, help='benchmark DVD size')
args = ap.parse_args()
OUT = os.path.abspath(args.out)
os.makedirs(OUT, exist_ok=True)
manifest = []


def write(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data)


def fixture(key, files, **info):
    """Register a fixture; `files` maps file name -> zero-arg function returning bytes."""
    names = list(files)
    if not all(os.path.exists(os.path.join(OUT, n)) for n in names):
        print('generating', key, file=sys.stderr)
        for n, make in files.items():
            write(n, make())
    manifest.append(dict(key=key, files=names, **info))


def exe(serial):  # a stand-in boot executable
    return (b'PS-X EXE' + bytes(8) + serial.encode()).ljust(4096, b'\x00') + g.filler(60 * 2048, zlib.crc32(serial.encode()))


def ps1_iso(boot, volume, size_mb, seed):
    cnf = ('BOOT = cdrom:\\%s;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n' % boot).encode()
    return g.pad_sectors(g.iso9660({'SYSTEM.CNF': cnf, boot: exe(boot), 'DATA/MOVIE.STR': g.filler(size_mb << 20, seed),
                                    'DATA/SOUND.VH': g.filler(64 << 10, seed + 1)}, volume, 'PLAYSTATION'))


def cue(tracks):
    """tracks: [(file, mode, pregap_frames_in_file)] -> cue sheet text."""
    lines = []
    for i, (fn, mode, pre) in enumerate(tracks, 1):
        lines += ['FILE "%s" BINARY' % fn, '  TRACK %02d %s' % (i, mode)]
        if pre:
            lines.append('    INDEX 00 00:00:00')
        lines.append('    INDEX 01 %s' % g.msf(pre))
    return ('\r\n'.join(lines) + '\r\n').encode()


# ---------------------------------------------------------------- PlayStation
mgs_iso = lambda: ps1_iso('SLUS_005.94', 'MGS_1', 2, 11)
fixture('ps1-multitrack', {
    'mgs disc1.cue': lambda: cue([('mgs disc1 (Track 1).bin', 'MODE2/2352', 0), ('mgs disc1 (Track 2).bin', 'AUDIO', 150)]),
    'mgs disc1 (Track 1).bin': lambda: g.raw_sectors(mgs_iso(), 2),
    'mgs disc1 (Track 2).bin': lambda: g.audio(225, 5, silence=150),
}, add=['mgs disc1.cue', 'mgs disc1 (Track 1).bin', 'mgs disc1 (Track 2).bin'],
   job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00594',
   ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'])

# the same disc as a CloneCD image: one .img with both tracks, a .ccd listing them and a .sub
# (subchannel, not kept); the page turns the .ccd into a cue sheet, `ref` is that cue for native chdman
def ccd_image():
    t1, t2 = g.raw_sectors(mgs_iso(), 2), g.audio(225, 5, silence=150)
    f1 = len(t1) // g.RAW
    return t1 + t2, f1, f1 + 150

def ccd_text():
    img, i0, i1 = ccd_image()
    return ('[CloneCD]\r\nVersion=3\r\n[Disc]\r\nTocEntries=5\r\nSessions=1\r\nDataTracksScrambled=0\r\nCDTextLength=0\r\n'
            '[Session 1]\r\nPreGapMode=2\r\nPreGapSubC=0\r\n'
            '[TRACK 1]\r\nMODE=2\r\nINDEX 1=0\r\n[TRACK 2]\r\nMODE=0\r\nINDEX 0=%d\r\nINDEX 1=%d\r\n' % (i0, i1)).encode()

def ccd_ref():
    img, i0, i1 = ccd_image()
    return ('FILE "mgs ccd.img" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n'
            '    INDEX 00 %s\n    INDEX 01 %s\n' % (g.msf(i0), g.msf(i1))).encode()

fixture('ps1-clonecd', {
    'mgs ccd.ccd': ccd_text,
    'mgs ccd.img': lambda: ccd_image()[0],
    'mgs ccd.sub': lambda: bytes(96 * (len(ccd_image()[0]) // g.RAW)),
    'mgs ccd-ref.cue': ccd_ref,
}, add=['mgs ccd.ccd', 'mgs ccd.img', 'mgs ccd.sub'], ref='mgs ccd-ref.cue', job='create', disc='cd', command='createcd', sys='ps1',
   serial='SLUS-00594', ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'],
   warning='subchannel data')

# a PAL PS1 disc as CloneCD saves it, with a real Q subchannel in the .sub and LibCrypt's mark on a few
# sectors: Q changed, its CRC left as it was. The page makes the .sbi an emulator needs from it
# (`lc-expected.sbi`: "SBI\0", then per sector its absolute BCD time, type 1 and the 10 bytes of Q)
LC_BAD = [300, 301, 450, 500]
def lc_image():
    return g.raw_sectors(ps1_iso('SLES_999.90', 'LCTEST', 1, 81), 2)

def q_crc(q):
    c = 0
    for b in q:
        c ^= b << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) & 0xffff if c & 0x8000 else (c << 1) & 0xffff
    return (~c) & 0xffff

def bcd_msf(n):
    return bytes([g._bcd(n // 4500), g._bcd((n // 75) % 60), g._bcd(n % 75)])

def lc_q(i):
    q = bytes([0x41, 0x01, 0x01]) + bcd_msf(i) + b'\x00' + bcd_msf(i + 150)
    c = q_crc(q)
    q += bytes([c >> 8, c & 0xff])
    if i in LC_BAD:  # LibCrypt: the times change, the CRC stays
        q = bytearray(q)
        q[3] ^= 0x01
        q[8] ^= 0x80
        q = bytes(q)
    return q

def lc_sub():
    n = len(lc_image()) // g.RAW
    return b''.join(bytes(12) + lc_q(i) + bytes(72) for i in range(n))

def lc_sbi():
    return b'SBI\x00' + b''.join(bcd_msf(i + 150) + b'\x01' + lc_q(i)[:10] for i in LC_BAD)

fixture('ps1-libcrypt', {
    'lc.ccd': lambda: ('[CloneCD]\r\nVersion=3\r\n[Disc]\r\nTocEntries=4\r\nSessions=1\r\nDataTracksScrambled=0\r\nCDTextLength=0\r\n'
                       '[Session 1]\r\nPreGapMode=2\r\nPreGapSubC=0\r\n[TRACK 1]\r\nMODE=2\r\nINDEX 1=0\r\n').encode(),
    'lc.img': lc_image,
    'lc.sub': lc_sub,
    'lc-ref.cue': lambda: b'FILE "lc.img" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n',
    'lc-expected.sbi': lc_sbi,
}, add=['lc.ccd', 'lc.img', 'lc.sub'], ref='lc-ref.cue', job='create', disc='cd', command='createcd', sys='ps1',
   serial='SLES-99990', ident='none', name='lc', sbi=True, warning='subchannel data')

# the same disc with a cdrdao TOC (each track's file, a byte offset and a length, and the audio
# track's pregap inside its file) and as a Nero image (both tracks in one file, the track list at the end)
def toc_text():
    t1, t2 = g.raw_sectors(mgs_iso(), 2), g.audio(225, 5, silence=150)
    return ('CD_ROM_XA\n\n// Track 1\nTRACK MODE2_RAW\nDATAFILE "mgs disc1 (Track 1).bin" #0 %s\n\n'
            '// Track 2\nTRACK AUDIO\nTWO_CHANNEL_AUDIO\nDATAFILE "mgs disc1 (Track 2).bin" #0 %s\nSTART 00:02:00\n'
            % (g.msf(len(t1) // g.RAW), g.msf(len(t2) // g.RAW))).encode()


def nrg_image():
    t1, t2 = g.raw_sectors(mgs_iso(), 2), g.audio(225, 5, silence=150)
    be = lambda n, k: n.to_bytes(k, 'big')
    ends = [len(t1), len(t1) + len(t2)]
    tracks = [(0x600, 0, 0, ends[0]), (0x700, ends[0], ends[0] + 150 * g.RAW, ends[1])]
    body = be(0, 4) + bytes(13) + bytes(1) + be(0x2001, 2) + bytes([1, 2])
    for mode, i0, i1, end in tracks:
        body += bytes(12) + be(g.RAW, 2) + be(mode, 2) + bytes(2) + be(i0, 8) + be(i1, 8) + be(end, 8)
    chain = b'DAOX' + be(len(body), 4) + body + b'END!' + be(0, 4)
    return t1 + t2 + chain + b'NER5' + be(ends[1], 8)


fixture('ps1-toc', {
    'mgs disc1.toc': toc_text,
    'mgs disc1 (Track 1).bin': lambda: g.raw_sectors(mgs_iso(), 2),
    'mgs disc1 (Track 2).bin': lambda: g.audio(225, 5, silence=150),
}, add=['mgs disc1.toc', 'mgs disc1 (Track 1).bin', 'mgs disc1 (Track 2).bin'], engine=True, job='create', disc='cd', command='createcd',
   sys='ps1', serial='SLUS-00594', ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'])

# the engine keeps the Nero image's stored pregap as a cue sheet's INDEX 00 is kept: the CHD of mgs ccd-ref.cue
# (chdman 0.289 dropped it); the TOC's START is a stored pregap too, and its audio big-endian (cdrdao):
# compared with the engine's native build (`engine`)
fixture('ps1-nrg', {'mgs.nrg': nrg_image}, add=['mgs.nrg'], ref='mgs ccd-ref.cue', job='create', disc='cd', command='createcd',
   sys='ps1', serial='SLUS-00594', ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'])

fixture('ps1-single', {
    'twine.cue': lambda: cue([('twine.bin', 'MODE2/2352', 0)]),
    'twine.bin': lambda: g.raw_sectors(ps1_iso('SLUS_012.72', 'TWINE', 1, 12), 2),
}, add=['twine.cue', 'twine.bin'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-01272',
   ident='serial', name='007 - The World Is Not Enough (USA)')

fixture('ps1-lone-bin', {
    'lone.bin': lambda: g.raw_sectors(ps1_iso('SLUS_009.75', 'TND', 1, 13), 2),
}, add=['lone.bin'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00975',
   ident='serial', name='007 - Tomorrow Never Dies (USA)', warning='No .cue file was added')

# a serial Redump lists only with a release suffix (SLES-04107/GER): the disc itself says SLES-04107
fixture('ps1-slash-serial', {
    'allstar.iso': lambda: ps1_iso('SLES_041.07', 'ALLSTAR', 1, 40),
}, add=['allstar.iso'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLES-04107',
   ident='serial', name='All Star Action (Europe) (Disc 1)')

# a PlayStation CD game stored as a plain 2048-byte .iso: must become a CD CHD, not a DVD one
# SYSTEM.CNF boots a generic PSX.EXE: the serial is the name of a file in the root (SLUS_009.75)
def psxexe_iso():
    cnf = b'BOOT = cdrom:\\PSX.EXE;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n'
    return g.pad_sectors(g.iso9660({'SYSTEM.CNF': cnf, 'PSX.EXE': exe('SLUS_009.75'), 'SLUS_009.75': b'serial\r\n',
                                    'DATA/MOVIE.STR': g.filler(1 << 20, 91)}, 'TND', 'PLAYSTATION'))
fixture('ps1-psxexe', {'psxexe.iso': psxexe_iso}, add=['psxexe.iso'], job='create', disc='cd', command='createcd', sys='ps1',
   serial='SLUS-00975', ident='serial', name='007 - Tomorrow Never Dies (USA)')

fixture('ps1-as-iso', {
    'tnd.iso': lambda: ps1_iso('SLUS_009.75', 'TND', 1, 14),
}, add=['tnd.iso'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00975',
   ident='serial', name='007 - Tomorrow Never Dies (USA)', warning='This is a 2,048-byte copy of a PlayStation disc', quirks=['ps1-cooked'])

# a CD game dumped as raw 2,352-byte sectors but named .iso. Given the .iso, chdman types the track by
# file size alone: 640 raw sectors are also a whole number of 2,048-byte ones, so it would store the
# image as 2,048-byte sectors. The app writes a cue with the sectors' own mode instead; `ref` is the
# equivalent cue that native chdman gets for the byte-for-byte comparison.
def raw_iso():
    iso = ps1_iso('SLUS_009.75', 'TND', 1, 16)
    return g.raw_sectors(iso.ljust(-(-len(iso) // (128 * 2048)) * 128 * 2048, b'\0'), 2)


fixture('ps1-raw-iso', {
    'rawtnd.iso': raw_iso,
    'rawtnd-ref.cue': lambda: b'FILE "rawtnd.iso" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n',
}, add=['rawtnd.iso'], ref='rawtnd-ref.cue', job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00975',
   ident='serial', name='007 - Tomorrow Never Dies (USA)', warning='raw 2,352-byte CD sectors')

# the same disc as ps1-single through a cue with a byte order mark and lower-case keywords, which
# chdman alone reads as no tracks at all (it then never finishes)
fixture('ps1-cue-lowercase', {
    'twine lower.cue': lambda: b'\xef\xbb\xbf' + b'file "twine.bin" binary\r\n  track 01 mode2/2352\r\n    index 01 00:00:00\r\n',
}, add=['twine lower.cue', 'twine.bin'], ref='twine.cue', job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-01272',
   ident='serial', name='007 - The World Is Not Enough (USA)')

# serial SLUS-01272 (TWINE), but tests/support/server.js can add a test database row matching this
# bin's size and CRC-32 under another name, to exercise the checksum-verified path
fixture('ps1-verified', {
    'verified.cue': lambda: cue([('verified.bin', 'MODE2/2352', 0)]),
    'verified.bin': lambda: g.raw_sectors(ps1_iso('SLUS_012.72', 'VERIFIED', 1, 15), 2),
}, add=['verified.cue', 'verified.bin'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-01272',
   testdb=True, ident='hash', name='Checksum Verified Game (USA)', provisional='007 - The World Is Not Enough (USA)')

# ---------------------------------------------------------------- PlayStation 2 / PSP (DVD)
agent_iso = lambda: g.pad_sectors(g.iso9660({
    'SYSTEM.CNF': b'BOOT2 = cdrom0:\\SLUS_202.65;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n',
    'SLUS_202.65': exe('SLUS_202.65'), 'DATA.BIN': g.filler(24 << 20, 21)}, 'AUF', 'PLAYSTATION'))
fixture('ps2-dvd', {
    'agent.iso': agent_iso,
}, add=['agent.iso'], job='create', disc='dvd', command='createdvd', sys='ps2', serial='SLUS-20265',
   ident='serial', name='007 - Agent Under Fire (USA)')

fixture('psp-umd', {
    'frwl.iso': lambda: g.pad_sectors(g.iso9660({
        'UMD_DATA.BIN': b'ULUS-10080|0000000000000001|0001|G',
        'PSP_GAME/PARAM.SFO': g.sfo({'CATEGORY': 'UG', 'DISC_ID': 'ULUS10080', 'DISC_VERSION': '1.00', 'TITLE': 'FROM RUSSIA WITH LOVE'}),
        'PSP_GAME/SYSDIR/EBOOT.BIN': g.filler(2 << 20, 31), 'PSP_GAME/USRDIR/DATA.BIN': g.filler(12 << 20, 32)}, 'PSP_GAME', 'PSP GAME')),
}, add=['frwl.iso'], job='create', disc='dvd', command='createdvd', sys='psp', serial='ULUS-10080',
   ident='serial', name='007 - From Russia with Love (USA)')

# compressed ISOs: a small PSP disc in maxcso's three formats, and the PS2 disc above as a CSO. The
# page gives chdman the ISO inside, so the CHD must be the one desktop chdman makes from that ISO (`ref`).
umd_iso = lambda: g.pad_sectors(g.iso9660({
    'UMD_DATA.BIN': b'ULUS-10080|0000000000000001|0001|G',
    'PSP_GAME/PARAM.SFO': g.sfo({'CATEGORY': 'UG', 'DISC_ID': 'ULUS10080', 'DISC_VERSION': '1.00', 'TITLE': 'FROM RUSSIA WITH LOVE'}),
    'PSP_GAME/SYSDIR/EBOOT.BIN': g.filler(256 << 10, 35), 'PSP_GAME/USRDIR/DATA.BIN': g.filler(1 << 20, 36)}, 'PSP_GAME', 'PSP GAME'))
umd = dict(ref='umd.iso', job='create', disc='dvd', command='createdvd', sys='psp', serial='ULUS-10080',
           ident='serial', name='007 - From Russia with Love (USA)')
fixture('psp-cso', {'umd.iso': umd_iso, 'umd.cso': lambda: g.ciso(umd_iso())}, add=['umd.cso'], **umd)
# CSO v2 with 16 KiB blocks (the ISO's last one is not full), deflate and LZ4, blocks on 4-byte boundaries
fixture('psp-cso2', {'umd v2.cso': lambda: g.ciso(umd_iso(), 2, 16384, 2)}, add=['umd v2.cso'], **umd)
fixture('psp-zso', {'umd.zso': lambda: g.ciso(umd_iso(), zso=True)}, add=['umd.zso'], **umd)
fixture('ps2-cso', {'agent.cso': lambda: g.ciso(agent_iso())}, add=['agent.cso'], ref='agent.iso', job='create', disc='dvd',
        command='createdvd', sys='ps2', serial='SLUS-20265', ident='serial', name='007 - Agent Under Fire (USA)')

# Xbox 360 (XGD3 layout, as Redump dumps it): a video partition, which reads as ISO 9660, then the
# game partition at 0x2080000, whose XDVDFS volume descriptor is its sector 32. Emulators don't
# load such CHDs: the page says so (PROFILES in ui.js)
def xgd3_iso():
    video = g.pad_sectors(g.iso9660({'VIDEO_TS/VIDEO_TS.IFO': g.filler(64 << 10, 71)}, 'DVD_VIDEO'))
    vd = bytearray(2048)
    vd[0:20] = vd[0x7EC:0x800] = b'MICROSOFT*XBOX*MEDIA'
    vd[20:24] = (33).to_bytes(4, 'little'); vd[24:28] = (2048).to_bytes(4, 'little')
    return video.ljust(0x2080000, b'\x00') + bytes(32 * 2048) + bytes(vd) + g.filler(1 << 20, 72)


fixture('xbox-xgd3', {'xgd3.iso': xgd3_iso}, add=['xgd3.iso'], job='create', disc='dvd', command='createdvd', sys='xbox',
        ident='none', name='xgd3')

fixture('ps3-iso', {
    'ps3game.iso': lambda: g.pad_sectors(g.iso9660({
        'PS3_DISC.SFB': b'.SFB'.ljust(512, b'\x00'),
        'PS3_GAME/PARAM.SFO': g.sfo({'CATEGORY': 'DG', 'TITLE': 'SYNTHETIC PS3 GAME', 'TITLE_ID': 'BLUS30001'}),
        'PS3_GAME/USRDIR/EBOOT.BIN': g.filler(1 << 20, 73)}, 'PS3VOLUME')),
}, add=['ps3game.iso'], job='create', disc='dvd', command='createdvd', sys='ps3', serial='BLUS-30001', ident='none', name='ps3game')

# ---------------------------------------------------------------- Sega
# Sega's system areas: the Saturn's IP.BIN has the serial at 0x20, the disc of the set (CD-1/1) at 0x38,
# the area symbols at 0x40 and the title at 0x60; the Dreamcast's the disc (crc GD-ROM1/1) at 0x20, the
# areas at 0x30, the serial at 0x40 and the title at 0x80; the Sega CD's the serial at 0x180, the
# region at 0x1F0
def ipbin(magic, serial_off, serial, title_off, title, extra=None):
    b = bytearray(16 * 2048)
    b[0:16] = magic
    b[serial_off:serial_off + len(serial)] = serial
    b[title_off:title_off + len(title)] = title
    for off, v in (extra or {}).items():
        b[off:off + len(v)] = v
    return bytes(b)


fixture('saturn', {
    'albert odyssey.cue': lambda: cue([('albert odyssey.bin', 'MODE1/2352', 0)]),
    'albert odyssey.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'0.BIN': g.filler(1 << 20, 41), 'ABS.TXT': b'fixture'}, 'ALBERT', 'SEGA SEGASATURN',
        ipbin(b'SEGA SEGASATURN ', 0x20, b'T-12705H  ', 0x60, b'ALBERT ODYSSEY', {0x10: b'SEGA TP T-127   ', 0x38: b'CD-1/1  ', 0x40: b'U         '}))), 1),
}, add=['albert odyssey.cue', 'albert odyssey.bin'], job='create', disc='cd', command='createcd', sys='saturn', serial='T-12705H',
   ident='serial', name='Albert Odyssey - Legend of Eldean (USA)')

# a USA disc whose serial (T-8113H) also prefixes European/German releases (T-8113H-50, T-8113H-18):
# the exact match must win
fixture('saturn-region', {
    'alien trilogy.cue': lambda: cue([('alien trilogy.bin', 'MODE1/2352', 0)]),
    'alien trilogy.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'0.BIN': g.filler(256 << 10, 42)}, 'ALIEN', 'SEGA SEGASATURN',
        ipbin(b'SEGA SEGASATURN ', 0x20, b'T-8113H   ', 0x60, b'ALIEN TRILOGY', {0x10: b'SEGA TP T-81    ', 0x38: b'CD-1/1  ', 0x40: b'U         '}))), 1),
}, add=['alien trilogy.cue', 'alien trilogy.bin'], job='create', disc='cd', command='createcd', sys='saturn', serial='T-8113H',
   ident='serial', name='Alien Trilogy (USA)')

fixture('segacd', {
    'ax101.cue': lambda: cue([('ax101.bin', 'MODE1/2352', 0), ('ax101 audio.bin', 'AUDIO', 150)]),
    'ax101.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'MAIN.PRG': g.filler(768 << 10, 51)}, 'AX101', '',
        ipbin(b'SEGADISCSYSTEM  ', 0x180, b'GM T-86015 -00', 0x150, b'A/X-101', {0x1F0: b'U  '}))), 1),
    'ax101 audio.bin': lambda: g.audio(300, 52, silence=150),
}, add=['ax101.cue', 'ax101.bin', 'ax101 audio.bin'], job='create', disc='cd', command='createcd', sys='segacd', serial='T-86015',
   ident='serial', name='A-X-101 (USA)')

fixture('dreamcast-gdi', {
    'aerowings.gdi': lambda: b'3\r\n1 0 4 2352 track01.bin 0\r\n2 450 0 2352 track02.raw 0\r\n3 45000 4 2352 track03.bin 0\r\n',
    'track01.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'fixture'}, 'AEROWINGS')), 1, 0),
    'track02.raw': lambda: g.audio(302, 61),
    'track03.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'1ST_READ.BIN': g.filler(2 << 20, 62)}, 'AEROWINGS', '',
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'T-40201N  ', 0x80, b'AEROWINGS', {0x10: b'SEGA ENTERPRISES', 0x20: b'0000 GD-ROM1/1  ', 0x30: b'U       '}))), 1, 45000),
}, add=['aerowings.gdi', 'track01.bin', 'track02.raw', 'track03.bin'], job='create', disc='gdrom', command='createcd', sys='dc',
   serial='T-40201N', ident='serial', name='AeroWings (USA)')

# a PS2 game on CD with a music track: PCSX2 plays only the first track of a CD CHD, and the card says so
fixture('ps2-cd-audio', {
    'ps2 cdda.cue': lambda: cue([('ps2 cdda (Track 1).bin', 'MODE2/2352', 0), ('ps2 cdda (Track 2).bin', 'AUDIO', 150)]),
    'ps2 cdda (Track 1).bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({
        'SYSTEM.CNF': b'BOOT2 = cdrom0:\\SLUS_299.99;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n',
        'SLUS_299.99': exe('SLUS_299.99')}, 'CDDA', 'PLAYSTATION')), 2),
    'ps2 cdda (Track 2).bin': lambda: g.audio(225, 71, silence=150),
}, add=['ps2 cdda.cue', 'ps2 cdda (Track 1).bin', 'ps2 cdda (Track 2).bin'], job='create', disc='cd', command='createcd', sys='ps2',
   serial='SLUS-29999', ident='none', name='ps2 cdda')

# a CD-based Dreamcast disc (a CD-R, as homebrew is): an audio track, then the data track with a stored
# pregap, which Flycast 2.7 and earlier reject in a CHD; the card says so
fixture('dreamcast-cdr', {
    'dc cdr.cue': lambda: cue([('dc cdr (Track 1).bin', 'AUDIO', 0), ('dc cdr (Track 2).bin', 'MODE1/2352', 150)]),
    'dc cdr (Track 1).bin': lambda: g.audio(300, 72),
    'dc cdr (Track 2).bin': lambda: g.raw_sectors(bytes(150 * 2048) + g.pad_sectors(g.iso9660(
        {'1ST_READ.BIN': g.filler(512 << 10, 73)}, 'HOMEBREW', '',
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'T0000     ', 0x80, b'HOMEBREW', {0x10: b'SEGA ENTERPRISES', 0x20: b'0000 CD-ROM1/1  ', 0x30: b'JUE     '}))), 1, 300),
}, add=['dc cdr.cue', 'dc cdr (Track 1).bin', 'dc cdr (Track 2).bin'], job='create', disc='cd', command='createcd', sys='dc',
   serial='T0000', ident='none', name='dc cdr')

# a NAOMI GD-ROM whose serial the database lists under NAOMI 2: the two share one header layout. Its CHD
# keeps its file's name (out), which MAME and Flycast look for in the game's romset
fixture('naomi2-gdi', {
    'spikers.gdi': lambda: b'3\r\n1 0 4 2352 spikers01.bin 0\r\n2 450 0 2352 spikers02.raw 0\r\n3 45000 4 2352 spikers03.bin 0\r\n',
    'spikers01.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'fixture'}, 'SPIKERS')), 1, 0),
    'spikers02.raw': lambda: g.audio(302, 65),
    'spikers03.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'1ST_READ.BIN': g.filler(1 << 20, 66)}, 'SPIKERS', '',
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'GDS-0014  ', 0x80, b'BEACH SPIKERS', {0x10: b'SEGA ENTERPRISES', 0x20: b'0000 GD-ROM1/1  ', 0x30: b'JUE     ', 0x38: b'NAOMI   '}))), 1, 45000),
}, add=['spikers.gdi', 'spikers01.bin', 'spikers02.raw', 'spikers03.bin'], job='create', disc='gdrom', command='createcd', sys='naomi2',
   serial='GDS-0014', ident='serial', name='Beach Spikers - Virtua Beach Volleyball (World) (En,Ja)', out='spikers')

# The Redump layout of a GD-ROM: one .bin per track, track 2's 2-second pregap stored at the start of
# its file (INDEX 00), and REM lines marking the high-density area, which chdman places at LBA 45000.
GD_CUE = ('REM SINGLE-DENSITY AREA\r\n'
          'FILE "aerowings (Track 1).bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n'
          'FILE "aerowings (Track 2).bin" BINARY\r\n  TRACK 02 AUDIO\r\n    INDEX 00 00:00:00\r\n    INDEX 01 00:02:00\r\n'
          'REM HIGH-DENSITY AREA\r\n'
          'FILE "aerowings (Track 3).bin" BINARY\r\n  TRACK 03 MODE1/2352\r\n    INDEX 01 00:00:00\r\n').encode()
fixture('dreamcast-cue', {
    'aerowings.cue': lambda: GD_CUE,
    'aerowings (Track 1).bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'fixture'}, 'AEROWINGS')).ljust(300 * 2048, b'\0'), 1, 0),
    'aerowings (Track 2).bin': lambda: g.audio(302, 63, silence=150),
    'aerowings (Track 3).bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'1ST_READ.BIN': g.filler(2 << 20, 64)}, 'AEROWINGS', '',
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'T-40201N  ', 0x80, b'AEROWINGS', {0x10: b'SEGA ENTERPRISES', 0x20: b'0000 GD-ROM1/1  ', 0x30: b'U       '}))), 1, 45000),
}, add=['aerowings.cue', 'aerowings (Track 1).bin', 'aerowings (Track 2).bin', 'aerowings (Track 3).bin'], job='create', disc='gdrom',
   command='createcd', sys='dc', serial='T-40201N', ident='serial', name='AeroWings (USA)')

# Sega's US first-party discs say MK-51064, MK-81064 or MK-4432 where Redump lists 51064, 81064 and 4432
# (and the European releases as MK-51064-50): the US release, not the European one
def gd_fixture(key, stem, serial, title, device, area, seed, **info):
    fixture(key, {
        stem + '.gdi': lambda: ('3\r\n1 0 4 2352 %s01.bin 0\r\n2 450 0 2352 %s02.raw 0\r\n3 45000 4 2352 %s03.bin 0\r\n' % (stem, stem, stem)).encode(),
        stem + '01.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'fixture'}, title[:8].decode())), 1, 0),
        stem + '02.raw': lambda: g.audio(302, seed),
        stem + '03.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
            {'1ST_READ.BIN': g.filler(1 << 20, seed + 1)}, title[:8].decode(), '',
            ipbin(b'SEGA SEGAKATANA ', 0x40, serial.ljust(10), 0x80, title,
                  {0x10: b'SEGA ENTERPRISES', 0x20: device.ljust(16), 0x30: area.ljust(8)}))), 1, 45000),
    }, add=[stem + '.gdi', stem + '01.bin', stem + '02.raw', stem + '03.bin'], job='create', disc='gdrom', command='createcd',
       sys='dc', serial=serial.decode(), **info)


def saturn_fixture(key, stem, serial, title, device, area, seed, **info):
    fixture(key, {
        stem + '.cue': lambda: cue([(stem + '.bin', 'MODE1/2352', 0)]),
        stem + '.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
            {'0.BIN': g.filler(256 << 10, seed)}, title[:8].decode(), 'SEGA SEGASATURN',
            ipbin(b'SEGA SEGASATURN ', 0x20, serial.ljust(10), 0x60, title,
                  {0x10: b'SEGA ENTERPRISES', 0x38: device.ljust(8), 0x40: area.ljust(10)}))), 1),
    }, add=[stem + '.cue', stem + '.bin'], job='create', disc='cd', command='createcd', sys='saturn', serial=serial.decode(), **info)


gd_fixture('dc-firstparty', 'wheeler', b'MK-51064', b'18 WHEELER', b'0000 GD-ROM1/1', b'U', 131,
           ident='serial', name='18 Wheeler - American Pro Trucker (USA)')
saturn_fixture('saturn-firstparty', 'amok', b'MK-81064', b'AMOK', b'CD-1/1', b'U', 133, ident='serial', name='Amok (USA)')
fixture('segacd-firstparty', {
    'batman cd.cue': lambda: cue([('batman cd.bin', 'MODE1/2352', 0)]),
    'batman cd.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'MAIN.PRG': g.filler(256 << 10, 135)}, 'BATMAN', '',
        ipbin(b'SEGADISCSYSTEM  ', 0x180, b'GM MK-4432 -00', 0x150, b'THE ADVENTURES OF BATMAN & ROBIN', {0x1F0: b'U  '}))), 1),
}, add=['batman cd.cue', 'batman cd.bin'], job='create', disc='cd', command='createcd', sys='segacd', serial='MK-4432',
   ident='serial', name='Adventures of Batman and Robin, The (USA)')

# discs of a set share their serial (T-21301G is 3x3 Eyes' three discs): the disc's header says which it is
saturn_fixture('saturn-disc1', '3x3 eyes 1', b'T-21301G', b'3X3 EYES', b'CD-1/3', b'J', 137,
               ident='serial', name='3x3 Eyes - Kyuusei Koushu S (Japan) (Disc 1)')
saturn_fixture('saturn-disc2', '3x3 eyes 2', b'T-21301G', b'3X3 EYES', b'CD-2/3', b'J', 139,
               ident='serial', name='3x3 Eyes - Kyuusei Koushu S (Japan) (Disc 2)')
gd_fixture('dc-disc2', 'nightmare', b'T-15117N', b'ALONE IN THE DARK', b'0000 GD-ROM2/2', b'U', 141,
           ident='serial', name='Alone in the Dark - The New Nightmare (USA) (Disc 2)')

# a Japanese disc whose serial the database lists only as a European release's base (T-99990-50): not that game
saturn_fixture('saturn-other-region', 'other region', b'T-99990', b'OTHER REGION', b'CD-1/1', b'J', 145,
               testdb=True, ident='none', name='other region')

# a PS1 disc whose serial (SLES-99980) names one release exactly and, as a base serial, another
# (SLES-999802) of its data track's size: the size wins (Redump's Asterix, SLES-01748 and SLES-017482)
fixture('ps1-size-rank', {
    'size rank.cue': lambda: cue([('size rank.bin', 'MODE2/2352', 0)]),
    'size rank.bin': lambda: g.raw_sectors(ps1_iso('SLES_999.80', 'SIZERANK', 1, 143), 2),
}, add=['size rank.cue', 'size rank.bin'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLES-99980',
   testdb=True, ident='serial+size', name='Size Rank Game (Europe) (De,Es) (Rev 1)')

# ---------------------------------------------------------------- disc layouts some emulators misread
# (app/quirks.js: each card warns or notes, and the CHD is still chdman's own)
def text_cue(lines):
    return ('\r\n'.join(lines) + '\r\n').encode()

def segacd_data(seed):
    return g.raw_sectors(g.pad_sectors(g.iso9660({'MAIN.PRG': g.filler(256 << 10, seed)}, 'NINJAS', '',
        ipbin(b'SEGADISCSYSTEM  ', 0x180, b'GM T-93175 -00', 0x150, b'3 NINJAS KICK BACK', {0x1F0: b'U  '}))), 1)

# a Sega CD disc with a second data track (Genesis Plus GX stops there), an audio track whose pregap
# is stored (INDEX 00: libretro BlastEm) and a PREGAP line on track 3 (ares)
fixture('segacd-layout', {
    'ninjas.cue': lambda: text_cue([
        'FILE "ninjas (Track 1).bin" BINARY', '  TRACK 01 MODE1/2352', '    INDEX 01 00:00:00',
        'FILE "ninjas (Track 2).bin" BINARY', '  TRACK 02 AUDIO', '    INDEX 00 00:00:00', '    INDEX 01 00:02:00',
        'FILE "ninjas (Track 3).bin" BINARY', '  TRACK 03 MODE1/2352', '    PREGAP 00:02:00', '    INDEX 01 00:00:00']),
    'ninjas (Track 1).bin': lambda: segacd_data(151),
    'ninjas (Track 2).bin': lambda: g.audio(300, 152, silence=150),
    'ninjas (Track 3).bin': lambda: g.raw_sectors(g.filler(200 * 2048, 153), 1),
}, add=['ninjas.cue', 'ninjas (Track 1).bin', 'ninjas (Track 2).bin', 'ninjas (Track 3).bin'], job='create', disc='cd',
   command='createcd', sys='segacd', serial='T-93175', ident='ambiguous', names=['3 Ninjas Kick Back (USA)', 'Hook (USA) (Alt)'],
   warning='Genesis Plus GX reads a Sega CD disc’s tracks only up to the first data track after track 1, here track 3',
   quirks=['segacd-data-tracks', 'segacd-index0', 'ares-pregap'])

# a Saturn cue sheet with a PREGAP line (a virtual pregap): Beetle Saturn, Kronos and Yabause misplace what follows
fixture('saturn-pregap-cmd', {
    'albert pregap.cue': lambda: text_cue([
        'FILE "albert pregap (Track 1).bin" BINARY', '  TRACK 01 MODE1/2352', '    INDEX 01 00:00:00',
        'FILE "albert pregap (Track 2).bin" BINARY', '  TRACK 02 AUDIO', '    PREGAP 00:02:00', '    INDEX 01 00:00:00']),
    'albert pregap (Track 1).bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'0.BIN': g.filler(256 << 10, 155)}, 'ALBERT', 'SEGA SEGASATURN',
        ipbin(b'SEGA SEGASATURN ', 0x20, b'T-12705H  ', 0x60, b'ALBERT ODYSSEY', {0x10: b'SEGA TP T-127   ', 0x38: b'CD-1/1  ', 0x40: b'U         '}))), 1),
    'albert pregap (Track 2).bin': lambda: g.audio(225, 156),
}, add=['albert pregap.cue', 'albert pregap (Track 1).bin', 'albert pregap (Track 2).bin'], job='create', disc='cd',
   command='createcd', sys='saturn', serial='T-12705H', ident='serial', name='Albert Odyssey - Legend of Eldean (USA)',
   warning='Beetle Saturn, Kronos and Yabause read the tracks after a PREGAP or POSTGAP line from the wrong place', quirks=['saturn-gapcmd'])

def dc_cd_data(mode2048, seed):
    iso = g.pad_sectors(g.iso9660({'1ST_READ.BIN': g.filler(256 << 10, seed)}, 'HOMEBREW', '',
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'T0000     ', 0x80, b'HOMEBREW', {0x10: b'SEGA ENTERPRISES', 0x20: b'0000 CD-ROM1/1  ', 0x30: b'JUE     '})))
    return iso if mode2048 else g.raw_sectors(iso, 2)

# a Dreamcast CD with a MODE2/2048 track (chdman: MODE2_FORM1, which Flycast refuses)
fixture('dc-mode2-2048', {
    'dc form1.cue': lambda: text_cue(['FILE "dc form1 (Track 1).bin" BINARY', '  TRACK 01 AUDIO', '    INDEX 01 00:00:00',
                                      'FILE "dc form1 (Track 2).bin" BINARY', '  TRACK 02 MODE2/2048', '    INDEX 01 00:00:00']),
    'dc form1 (Track 1).bin': lambda: g.audio(300, 157),
    'dc form1 (Track 2).bin': lambda: dc_cd_data(True, 158),
}, add=['dc form1.cue', 'dc form1 (Track 1).bin', 'dc form1 (Track 2).bin'], job='create', disc='cd', command='createcd',
   sys='dc', serial='T0000', ident='none', name='dc form1', warning='Flycast can’t load CHDs with MODE2/2048 or MODE2/2324 tracks',
   quirks=['dc-mode2-form'])

# a MIL-CD-like Dreamcast disc: music in session 1, the game in session 2 (a CHD keeps no session gap)
fixture('dc-multisession', {
    'milcd.cue': lambda: text_cue(['REM SESSION 01', 'FILE "milcd (Track 1).bin" BINARY', '  TRACK 01 AUDIO', '    INDEX 01 00:00:00',
                                   'REM SESSION 02', 'FILE "milcd (Track 2).bin" BINARY', '  TRACK 02 MODE2/2352', '    INDEX 01 00:00:00']),
    'milcd (Track 1).bin': lambda: g.audio(300, 159),
    'milcd (Track 2).bin': lambda: dc_cd_data(False, 160),
}, add=['milcd.cue', 'milcd (Track 1).bin', 'milcd (Track 2).bin'], job='create', disc='cd', command='createcd',
   sys='dc', serial='T0000', ident='none', name='milcd', warning='This disc has 2 sessions.', quirks=['multisession'])

# a PlayStation cue sheet with a POSTGAP line: Beetle PSX counts it into the file
fixture('ps1-postgap', {
    'tnd postgap.cue': lambda: text_cue(['FILE "tnd postgap (Track 1).bin" BINARY', '  TRACK 01 MODE2/2352', '    INDEX 01 00:00:00', '    POSTGAP 00:02:00',
                                         'FILE "tnd postgap (Track 2).bin" BINARY', '  TRACK 02 AUDIO', '    INDEX 01 00:00:00']),
    'tnd postgap (Track 1).bin': lambda: g.raw_sectors(ps1_iso('SLUS_009.75', 'TND', 1, 161), 2),
    'tnd postgap (Track 2).bin': lambda: g.audio(225, 162),
}, add=['tnd postgap.cue', 'tnd postgap (Track 1).bin', 'tnd postgap (Track 2).bin'], job='create', disc='cd', command='createcd',
   sys='ps1', serial='SLUS-00975', ident='serial', name='007 - Tomorrow Never Dies (USA)',
   warning='Beetle PSX read the tracks after a POSTGAP line from the wrong place', quirks=['postgap'])

# a Neo Geo CD with a Mode 2 data track, which NeoCD doesn't take
fixture('ngcd-mode2', {
    'ngcd mode2.cue': lambda: cue([('ngcd mode2 (Track 1).bin', 'MODE2/2352', 0), ('ngcd mode2 (Track 2).bin', 'AUDIO', 150)]),
    'ngcd mode2 (Track 1).bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'IPL.TXT': b'PROG.PRG,0,0\r\n', 'PROG.PRG': g.filler(128 << 10, 163)}, 'NEOGEO')), 2),
    'ngcd mode2 (Track 2).bin': lambda: g.audio(225, 164, silence=150),
}, add=['ngcd mode2.cue', 'ngcd mode2 (Track 1).bin', 'ngcd mode2 (Track 2).bin'], job='create', disc='cd', command='createcd',
   sys='ngcd', ident='none', name='ngcd mode2', warning='NeoCD can’t load this CHD', quirks=['ngcd-layout'])

# ---------------------------------------------------------------- consoles told apart by their discs' markers
def area(off_bytes):  # a system area (sectors 0-15) with these bytes at these offsets
    b = bytearray(16 * 2048)
    for off, v in off_bytes.items():
        b[off:off + len(v)] = v
    return bytes(b)

def data_cue(name, mode='MODE1/2352'):
    return lambda: cue([(name + '.bin', mode, 0)])

def data_fixture(key, name, iso, sys, mode=1, **info):
    fixture(key, {name + '.cue': data_cue(name, 'MODE%d/2352' % mode), name + '.bin': lambda: g.raw_sectors(iso(), mode)},
            add=[name + '.cue', name + '.bin'], job='create', disc='cd', command='createcd', sys=sys, ident='none', name=name, **info)

# a PC Engine CD whose data track also has an ISO 9660 volume: its boot sector (sector 1) says so first
data_fixture('pcecd-iso', 'pce iso', lambda: g.pad_sectors(g.iso9660({'GAME.DAT': g.filler(128 << 10, 171)}, 'PCEGAME', '',
             area({2048 + 0x20: b'PC Engine CD-ROM SYSTEM'}))), 'pcecd')
data_fixture('pcfx-iso', 'pcfx iso', lambda: g.pad_sectors(g.iso9660({'GAME.DAT': g.filler(128 << 10, 172)}, 'PCFXGAME', '',
             area({0: b'PC-FX:Hu_CD-ROM '}))), 'pcfx')
# CD32.TM makes a CD32 disc whatever its system id says (CDTV here)
data_fixture('cd32-cdtvid', 'cd32 cdtvid', lambda: g.pad_sectors(g.iso9660({'CD32.TM': b'TM', 'S/STARTUP-SEQUENCE': b'game\n',
             'GAME': g.filler(64 << 10, 173)}, 'CD32GAME', 'CDTV')), 'cd32')
# an Amiga disc with a startup sequence and no trademark file: CD32 (MPF's rule); with CDTV.TM: CDTV
data_fixture('cd32-startup', 'cd32 startup', lambda: g.pad_sectors(g.iso9660({'S/STARTUP-SEQUENCE': b'game\n',
             'GAME': g.filler(64 << 10, 174)}, 'AMIGAGAME', 'AMIGA')), 'cd32')
data_fixture('cdtv-tm', 'cdtv tm', lambda: g.pad_sectors(g.iso9660({'CDTV.TM': b'TM', 'S/STARTUP-SEQUENCE': b'game\n',
             'GAME': g.filler(64 << 10, 175)}, 'CDTVGAME', 'AMIGA')), 'cdtv')
# a Neo Geo CD known by its text files (MPF), without IPL.TXT
data_fixture('ngcd-abs', 'ngcd abs', lambda: g.pad_sectors(g.iso9660({'ABS.TXT': b'abstract', 'BIB.TXT': b'bibliography',
             'CPY.TXT': b'copyright', 'PROG.PRG': g.filler(64 << 10, 176)}, 'NEOGEO')), 'ngcd')
# a CD-i Bridge disc, and a Video CD (one too, with its VCD and MPEGAV folders): CD-i, and video
data_fixture('cdi-bridge', 'cdi bridge', lambda: g.pad_sectors(g.iso9660({'CDI/CDI_APP': g.filler(64 << 10, 177)}, 'CDIGAME',
             'CD-RTOS CD-BRIDGE')), 'cdi', mode=2)
data_fixture('vcd', 'video cd', lambda: g.pad_sectors(g.iso9660({'VCD/INFO.VCD': b'VIDEO_CD' + bytes(2040), 'MPEGAV/AVSEQ01.DAT': g.filler(64 << 10, 178),
             'CDI/CDI_VCD.APP': b'app'}, 'VIDEOCD', 'CD-RTOS CD-BRIDGE')), 'vcd', mode=2)
fixture('dvd-video', {
    'film.iso': lambda: g.pad_sectors(g.iso9660({'VIDEO_TS/VIDEO_TS.IFO': g.filler(64 << 10, 179), 'AUDIO_TS/README': b''}, 'FILM')),
}, add=['film.iso'], job='create', disc='dvd', command='createdvd', sys='video', ident='none', name='film')
# a UMD Video: UMD_DATA.BIN and a UMD_VIDEO folder, no PSP_GAME (PPSSPP plays games only)
fixture('umd-video', {
    'umd film.iso': lambda: g.pad_sectors(g.iso9660({'UMD_DATA.BIN': b'UVXX-99999|0000000000000000|0001|G', 'UMD_VIDEO/PLAYLIST.UMD': g.filler(64 << 10, 180)},
                                                    'UMDFILM', 'PSP GAME')),
}, add=['umd film.iso'], job='create', disc='dvd', command='createdvd', sys='psp', ident='none', name='umd film',
   warning='This is a UMD Video (a film), not a game', quirks=['umd-video'])
# PS2 discs without a database entry: a DVD has a UDF volume as well, whatever its size; a CD has ISO 9660 only
def ps2_iso(boot, udf):
    return g.pad_sectors(g.iso9660({'SYSTEM.CNF': ('BOOT2 = cdrom0:\\%s;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n' % boot).encode(), boot: exe(boot)},
                                   'PS2GAME', 'PLAYSTATION', udf=udf))
fixture('ps2-dvd-small', {'ps2 small dvd.iso': lambda: ps2_iso('SLUS_299.98', True)}, add=['ps2 small dvd.iso'], job='create', disc='dvd',
        command='createdvd', sys='ps2', serial='SLUS-29998', ident='none', name='ps2 small dvd')
fixture('ps2-cd-iso', {'ps2 cd.iso': lambda: ps2_iso('SLUS_299.97', False)}, add=['ps2 cd.iso'], job='create', disc='cd',
        command='createcd', sys='ps2', serial='SLUS-29997', ident='none', name='ps2 cd')

# a Jaguar CD: audio tracks only, in two sessions; the second session's first track holds the boot
# header, byte-swapped as in the image's audio
def jag_boot():
    head = b'ATARI APPROVED DATA HEADER ATRI ' * 4
    raw = bytearray(g.audio(300, 181))
    raw[2352 * 2 + 100:2352 * 2 + 100 + len(head)] = bytes(b for i in range(0, len(head), 2) for b in (head[i + 1], head[i]))
    return bytes(raw)
fixture('jagcd', {
    'jaguar.cue': lambda: text_cue(['REM SESSION 01', 'FILE "jaguar (Track 1).bin" BINARY', '  TRACK 01 AUDIO', '    INDEX 01 00:00:00',
                                    'REM SESSION 02', 'FILE "jaguar (Track 2).bin" BINARY', '  TRACK 02 AUDIO', '    INDEX 01 00:00:00']),
    'jaguar (Track 1).bin': lambda: g.audio(300, 182),
    'jaguar (Track 2).bin': jag_boot,
}, add=['jaguar.cue', 'jaguar (Track 1).bin', 'jaguar (Track 2).bin'], job='create', disc='cd', command='createcd', sys='jagcd',
   ident='none', name='jaguar', warning='Jaguar CD emulators may not load this CHD', quirks=['jagcd-sessions'])

# ---------------------------------------------------------------- unrecognized / other types
fixture('homebrew-iso', {
    'homebrew.iso': lambda: g.pad_sectors(g.iso9660({'README.TXT': b'hello', 'GAME.DAT': g.filler(3 << 20, 71)}, 'HOMEBREW')),
}, add=['homebrew.iso'], job='create', disc='dvd', command='createdvd', sys=None, ident='none', name='homebrew')

fixture('hard-disk', {
    'arcade.img': lambda: bytes(446) + bytes([0x80, 1, 1, 0, 0x06, 0x0F, 0x3F, 0x20, 0x3F, 0, 0, 0, 0xC1, 0x3F, 0, 0]) + bytes(48) + b'\x55\xaa' + g.filler((8 << 20) - 512, 81),
}, add=['arcade.img'], job='create', disc='hd', command='createhd', sys=None, ident='none', name='arcade')

# content whose best codec keeps changing, so that every codec trial runs first, gives up early and
# wins in turn (the engine's early abort, which must not change a byte). `codec mix.img` has audio in
# both byte orders; the CD's audio track has hunks where FLAC gives up after its first block.
fixture('codec-mix-hd', {
    'codec mix.img': lambda: g.codec_mix(3 << 20, 4096, 101),
}, add=['codec mix.img'], job='create', disc='hd', command='createhd', sys=None, ident='none', name='codec mix')

fixture('codec-mix-cd', {
    'codec mix cd.cue': lambda: cue([('codec mix cd (Track 1).bin', 'MODE1/2352', 0), ('codec mix cd (Track 2).bin', 'AUDIO', 150)]),
    'codec mix cd (Track 1).bin': lambda: g.raw_sectors(g.codec_mix(640 * 2048, 3 * 2048, 102), 1),
    'codec mix cd (Track 2).bin': lambda: bytes(150 * g.RAW) + g.codec_audio(800, 103),
}, add=['codec mix cd.cue', 'codec mix cd (Track 1).bin', 'codec mix cd (Track 2).bin'], job='create', disc='cd',
   command='createcd', sys=None, ident='none', name='codec mix cd')

# music-like CD audio: libFLAC's windows and estimates use cosf and log, so the page's CHDs match
# native chdman's only with the same math (engine/libm); synthetic tones never showed the difference
fixture('music-cd', {
    'piano.cue': lambda: cue([('piano.bin', 'AUDIO', 0)]),
    'piano.bin': lambda: g.music(10, 1),
}, add=['piano.cue', 'piano.bin'], job='create', disc='cd', command='createcd', sys=None, ident='none', name='piano')

# ---------------------------------------------------------------- cue sheets chdman 0.289 misreads
# Each disc has a plain twin (`ref`: one file per track, little-endian audio) that 0.289 reads right.
# The engine must make the same CHD from both (engine.spec.js); the page too (convert.spec.js).
cue_data = lambda seed: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'cue sheet test', 'DATA.BIN': g.filler(400 << 10, seed)}, 'CUETEST')), 1)
cue_t2 = lambda: g.audio(203, 121, silence=150)   # 353 frames: a 2 s pregap, then the track
cue_t3 = lambda: g.audio(225, 122, silence=75)    # 300 frames: a 1 s pregap
cue_t4 = lambda: g.raw_sectors(bytes(150 * 2048) + g.pad_sectors(g.iso9660({'EXTRA.DAT': g.filler(200 << 10, 123)}, 'EXTRA')), 1)
be16 = lambda pcm: bytes(b for i in range(0, len(pcm), 2) for b in (pcm[i + 1], pcm[i]))
def wav(pcm):
    return (b'RIFF' + (36 + len(pcm)).to_bytes(4, 'little') + b'WAVEfmt ' + (16).to_bytes(4, 'little') +
            bytes([1, 0, 2, 0]) + (44100).to_bytes(4, 'little') + (176400).to_bytes(4, 'little') + bytes([4, 0, 16, 0]) +
            b'data' + len(pcm).to_bytes(4, 'little') + pcm)
def cue_text(files):
    """files: [(name, type, [(track, mode, [(index, frames)])])] -> cue sheet bytes (CRLF)"""
    out = []
    for fn, ty, tracks in files:
        out.append('FILE "%s" %s' % (fn, ty))
        for no, mode, idx in tracks:
            out.append('  TRACK %02d %s' % (no, mode))
            out += ['    INDEX %02d %s' % (i, g.msf(f)) for i, f in idx]
    return ('\r\n'.join(out) + '\r\n').encode()
t2n, t3n = 353, 300
twin = lambda stem, t2ext, t3ext, t2ty, t3ty: cue_text([
    ('%s (Track 1).bin' % stem, 'BINARY', [(1, 'MODE1/2352', [(1, 0)])]),
    ('%s (Track 2).%s' % (stem, t2ext), t2ty, [(2, 'AUDIO', [(0, 0), (1, 150)])]),
    ('%s (Track 3).%s' % (stem, t3ext), t3ty, [(3, 'AUDIO', [(0, 0), (1, 75)])]),
    ('%s (Track 4).bin' % stem, 'BINARY', [(4, 'MODE1/2352', [(0, 0), (1, 150)])])])

# MOTOROLA: big-endian audio, which 0.289 byte-swaps anyway
fixture('cue-motorola', {
    'moto.cue': lambda: cue_text([
        ('moto (Track 1).bin', 'BINARY', [(1, 'MODE1/2352', [(1, 0)])]),
        ('moto (Track 2).be', 'MOTOROLA', [(2, 'AUDIO', [(0, 0), (1, 150)])]),
        ('moto (Track 3).be', 'MOTOROLA', [(3, 'AUDIO', [(0, 0), (1, 75)])]),
        ('moto (Track 4).bin', 'BINARY', [(4, 'MODE1/2352', [(0, 0), (1, 150)])])]),
    'moto (Track 1).bin': lambda: cue_data(120), 'moto (Track 2).be': lambda: be16(cue_t2()),
    'moto (Track 3).be': lambda: be16(cue_t3()), 'moto (Track 4).bin': cue_t4,
    'moto (Track 2).bin': cue_t2, 'moto (Track 3).bin': cue_t3,
    'moto-ref.cue': lambda: twin('moto', 'bin', 'bin', 'BINARY', 'BINARY'),
}, add=['moto.cue', 'moto (Track 1).bin', 'moto (Track 2).be', 'moto (Track 3).be', 'moto (Track 4).bin'], ref='moto-ref.cue',
   job='create', disc='cd', command='createcd', sys=None, ident='none', name='moto')

# a file with several tracks after another file: 0.289 went on from the first file's offsets
fixture('cue-shared-file', {
    'shared.cue': lambda: cue_text([
        ('shared (Track 1).bin', 'BINARY', [(1, 'MODE1/2352', [(1, 0)])]),
        ('shared rest.bin', 'BINARY', [(2, 'AUDIO', [(0, 0), (1, 150)]), (3, 'AUDIO', [(0, t2n), (1, t2n + 75)]),
                                       (4, 'MODE1/2352', [(0, t2n + t3n), (1, t2n + t3n + 150)])])]),
    'shared (Track 1).bin': lambda: cue_data(124), 'shared rest.bin': lambda: cue_t2() + cue_t3() + cue_t4(),
    'shared (Track 2).bin': cue_t2, 'shared (Track 3).bin': cue_t3, 'shared (Track 4).bin': cue_t4,
    'shared-ref.cue': lambda: twin('shared', 'bin', 'bin', 'BINARY', 'BINARY'),
}, add=['shared.cue', 'shared (Track 1).bin', 'shared rest.bin'], ref='shared-ref.cue',
   job='create', disc='cd', command='createcd', sys=None, ident='none', name='shared')

# two tracks in one .wav: 0.289 gave the first track all of it
fixture('cue-wave-tracks', {
    'wavs.cue': lambda: cue_text([
        ('wavs (Track 1).bin', 'BINARY', [(1, 'MODE1/2352', [(1, 0)])]),
        ('wavs audio.wav', 'WAVE', [(2, 'AUDIO', [(0, 0), (1, 150)]), (3, 'AUDIO', [(0, t2n), (1, t2n + 75)])]),
        ('wavs (Track 4).bin', 'BINARY', [(4, 'MODE1/2352', [(0, 0), (1, 150)])])]),
    'wavs (Track 1).bin': lambda: cue_data(125), 'wavs audio.wav': lambda: wav(cue_t2() + cue_t3()), 'wavs (Track 4).bin': cue_t4,
    'wavs (Track 2).wav': lambda: wav(cue_t2()), 'wavs (Track 3).wav': lambda: wav(cue_t3()),
    'wavs-ref.cue': lambda: twin('wavs', 'wav', 'wav', 'WAVE', 'WAVE'),
}, add=['wavs.cue', 'wavs (Track 1).bin', 'wavs audio.wav', 'wavs (Track 4).bin'], ref='wavs-ref.cue',
   job='create', disc='cd', command='createcd', sys=None, ident='none', name='wavs')

# ---------------------------------------------------------------- cue sheets with more than a CHD's tracks hold
# Redump's cue sheets for many systems carry what chdman doesn't store: CATALOG, FLAGS, ISRC, INDEX
# 02 and later, the CDI/2352 track type. `createcd --keepcue` keeps the sheet in the CHD, and
# `extractcd --redump` writes it back (engine.spec.js, chd.spec.js); without it, a CHD is chdman's.
fixture('cue-fidelity', {
    'fidelity.cue': lambda: ('CATALOG 4988602165921\r\n'
                             'FILE "fidelity (Track 1).bin" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n'
                             'FILE "fidelity (Track 2).bin" BINARY\r\n  TRACK 02 AUDIO\r\n    FLAGS DCP\r\n    ISRC JPPI00652340\r\n'
                             '    INDEX 00 00:00:00\r\n    INDEX 01 00:02:00\r\n    INDEX 02 00:03:00\r\n'
                             'FILE "fidelity (Track 3).bin" BINARY\r\n  TRACK 03 AUDIO\r\n    FLAGS DCP PRE\r\n'
                             '    INDEX 00 00:00:00\r\n    INDEX 01 00:01:00\r\n').encode(),
    'fidelity (Track 1).bin': lambda: cue_data(126), 'fidelity (Track 2).bin': cue_t2, 'fidelity (Track 3).bin': cue_t3,
}, add=['fidelity.cue', 'fidelity (Track 1).bin', 'fidelity (Track 2).bin', 'fidelity (Track 3).bin'],
   job='create', disc='cd', command='createcd', sys=None, ident='none', name='fidelity')
fixture('cue-cdi', {
    'cdi disc.cue': lambda: b'FILE "cdi disc.bin" BINARY\r\n  TRACK 01 CDI/2352\r\n    INDEX 01 00:00:00\r\n',
    'cdi disc.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'cd-i test', 'DATA.BIN': g.filler(300 << 10, 127)}, 'CDITEST')), 2),
}, add=['cdi disc.cue', 'cdi disc.bin'], job='create', disc='cd', command='createcd', sys=None, ident='none', name='cdi disc')

# ---------------------------------------------------------------- ECM images
# CD images packed by the ecm tools (g.ecm writes what their bin2ecm does). The page gives chdman the
# image inside, so the CHD must be the one desktop chdman makes from the image itself: from the files
# the cue sheet names, or `ref`.
ecm_of = lambda name: g.ecm(open(os.path.join(OUT, name), 'rb').read())
# a PlayStation disc with XA sectors among its data: Mode 2 Form 2, which keep an EDC but no ECC
def xa_bin():
    iso = ps1_iso('SLUS_012.72', 'XA', 1, 17)
    return g.raw_sectors(iso, 2, 0, [i >= 100 and i % 4 == 3 for i in range(len(iso) // g.SECTOR)])
fixture('ps1-ecm', {
    'xa.cue': lambda: cue([('xa.bin', 'MODE2/2352', 0)]),
    'xa.bin': xa_bin,
    'xa.bin.ecm': lambda: ecm_of('xa.bin'),
}, add=['xa.cue', 'xa.bin.ecm'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-01272',
   ident='serial', name='007 - The World Is Not Enough (USA)')
# Mode 1 data, and an audio track whose silence the encoder stores as Mode 2 sectors (zeros are one)
fixture('segacd-ecm', {
    'ax101.bin.ecm': lambda: ecm_of('ax101.bin'),
    'ax101 audio.bin.ecm': lambda: ecm_of('ax101 audio.bin'),
}, add=['ax101.cue', 'ax101.bin.ecm', 'ax101 audio.bin.ecm'], job='create', disc='cd', command='createcd', sys='segacd',
   serial='T-86015', ident='serial', name='A-X-101 (USA)')
# only the data track packed
fixture('ps1-ecm-mixed', {
    'mgs disc1 (Track 1).bin.ecm': lambda: ecm_of('mgs disc1 (Track 1).bin'),
}, add=['mgs disc1.cue', 'mgs disc1 (Track 1).bin.ecm', 'mgs disc1 (Track 2).bin'], job='create', disc='cd', command='createcd',
   sys='ps1', serial='SLUS-00594', ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'])
# without its cue sheet: the page writes one, as for a lone .bin (`ref`)
fixture('ps1-ecm-lone', {
    'lone.bin.ecm': lambda: ecm_of('lone.bin'),
    'lone-ref.cue': lambda: b'FILE "lone.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n',
}, add=['lone.bin.ecm'], ref='lone-ref.cue', title='lone', job='create', disc='cd', command='createcd', sys='ps1',
   serial='SLUS-00975', ident='serial', name='007 - Tomorrow Never Dies (USA)', warning='No .cue file was added')
# a CloneCD image packed: data and audio in one file
fixture('ps1-clonecd-ecm', {
    'mgs ccd.img.ecm': lambda: ecm_of('mgs ccd.img'),
}, add=['mgs ccd.ccd', 'mgs ccd.img.ecm', 'mgs ccd.sub'], ref='mgs ccd-ref.cue', job='create', disc='cd', command='createcd',
   sys='ps1', serial='SLUS-00594', ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'],
   warning='subchannel data')

# ---------------------------------------------------------------- PS1 EBOOT.PBP (popstation)
# the CloneCD disc above packed as popstation does: the page reads the disc's TOC and gives chdman its
# image with a cue sheet made from it (`ref`: the same disc's cue for native chdman)
def pbp_mgs():
    img, i0, i1 = ccd_image()
    return img, [(False, 0, 0), (True, i0, i1)]
def pbp_lone():
    return open(os.path.join(OUT, 'lone.bin'), 'rb').read(), [(False, 0, 0)]
fixture('ps1-pbp', {
    'mgs.pbp': lambda: g.pbp([pbp_mgs()], 'METAL GEAR SOLID'),
}, add=['mgs.pbp'], ref='mgs ccd-ref.cue', job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00594',
   ident='ambiguous', names=['Metal Gear Solid (USA) (Disc 1)', 'Metal Gear Solid (USA) (Disc 1) (Rev 1)'])
# as it is usually named: the card takes the title in its PARAM.SFO; one track, so the checksum is compared too
fixture('ps1-pbp-eboot', {
    'EBOOT.PBP': lambda: g.pbp([pbp_lone()], 'Tomorrow Never Dies'),
}, add=['EBOOT.PBP'], ref='lone-ref.cue', title='Tomorrow Never Dies', job='create', disc='cd', command='createcd', sys='ps1',
   serial='SLUS-00975', ident='serial', name='007 - Tomorrow Never Dies (USA)')
# two discs in one file (PSTITLEIMG000000): a card each
fixture('ps1-pbp-discs', {
    'two discs.pbp': lambda: g.pbp([pbp_mgs(), pbp_lone()], 'TWO DISCS'),
}, add=['two discs.pbp'], job='pbp-discs', refs=['mgs ccd-ref.cue', 'lone-ref.cue'])
# ones that can't be converted: a PlayStation Store download (encrypted) and a PSP program
fixture('ps1-pbp-bad', {
    'store.pbp': lambda: g.pbp([pbp_lone()], 'STORE', encrypted=True),
    'homebrew.pbp': lambda: g.pbp([], 'HOMEBREW', psp=True),
}, add=['store.pbp', 'homebrew.pbp'], job='invalid')

# ---------------------------------------------------------------- benchmark images
if args.bench:
    cd_audio_frames = int(args.cd_mb * 0.3 * (1 << 20)) // 2352 // 3
    cd_data = int(args.cd_mb * 0.7 * (1 << 20)) // 2048 * 2048
    tr = [('bench-cd (Track 1).bin', 'MODE2/2352', 0)] + [('bench-cd (Track %d).bin' % i, 'AUDIO', 150) for i in (2, 3, 4)]
    files = {'bench-cd.cue': lambda: cue(tr),
             'bench-cd (Track 1).bin': lambda: g.raw_sectors_chunked(ps1_iso('SLUS_005.94', 'BENCH', cd_data >> 20, 91), 2)}
    for i in (2, 3, 4):
        files['bench-cd (Track %d).bin' % i] = (lambda s: lambda: g.audio(cd_audio_frames, s, silence=150))(90 + i)
    fixture('bench-cd', files, add=list(files), job='create', disc='cd', command='createcd', sys='ps1', bench=True)
    fixture('bench-dvd', {
        'bench-dvd.iso': lambda: g.pad_sectors(g.iso9660({
            'SYSTEM.CNF': b'BOOT2 = cdrom0:\\SLUS_202.65;1\r\nVER = 1.00\r\n', 'SLUS_202.65': exe('SLUS_202.65'),
            'DATA.BIN': g.filler((args.dvd_mb << 20) - (1 << 20), 95)}, 'BENCH', 'PLAYSTATION')),
    }, add=['bench-dvd.iso'], job='create', disc='dvd', command='createdvd', sys='ps2', bench=True)
    # its data track as an ECM image: what rebuilding the sectors while converting costs
    fixture('bench-cd-ecm', {
        'bench-cd (Track 1).bin.ecm': lambda: ecm_of('bench-cd (Track 1).bin'),
    }, add=['bench-cd.cue', 'bench-cd (Track 1).bin.ecm'] + ['bench-cd (Track %d).bin' % i for i in (2, 3, 4)], ref='bench-cd.cue',
       job='create', disc='cd', command='createcd', sys='ps1', bench=True)
    # the same image as a CSO: what decompressing it while converting costs
    fixture('bench-dvd-cso', {
        'bench-dvd.cso': lambda: g.ciso(open(os.path.join(OUT, 'bench-dvd.iso'), 'rb').read()),
    }, add=['bench-dvd.cso'], ref='bench-dvd.iso', job='create', disc='dvd', command='createdvd', sys='ps2', bench=True)

# extra database rows for the page served with ?testdb=1 (see tests/support/server.js)
def row(name, serial, data, ext):
    return '\t'.join([name, serial, str(len(data)), '%08X' % zlib.crc32(data), '', ext])
vb = open(os.path.join(OUT, 'verified.bin'), 'rb').read()
ui = open(os.path.join(OUT, 'umd.iso'), 'rb').read()  # the ISO inside the umd.* compressed ISOs
xb = open(os.path.join(OUT, 'xa.bin'), 'rb').read()   # the image inside xa.bin.ecm
mb = open(os.path.join(OUT, 'mgs disc1 (Track 1).bin'), 'rb').read()
mb = mb[:-1] + bytes([mb[-1] ^ 1])  # a game of the same size as mgs disc1's data track, not the same data
sr = open(os.path.join(OUT, 'size rank.bin'), 'rb').read()
sr = sr[:-1] + bytes([sr[-1] ^ 1])  # the size of size rank.bin, not its data
with open(os.path.join(OUT, 'testdb.json'), 'w') as f:
    json.dump({'ps1': [row('Checksum Verified Game (USA)', 'SLUS-99999', vb, 'bin'), row('Checksum Verified ECM Game (USA)', 'SLUS-99998', xb, 'bin'),
                       row('Same Size Game (USA)', 'SLUS-99997', mb, 'bin'),
                       row('Size Rank Game (Europe) (En,Fr)', 'SLES-99980', sr + bytes(2352), 'bin'),
                       row('Size Rank Game (Europe) (De,Es) (Rev 1)', 'SLES-999802', sr, 'bin')],
               'psp': [row('Checksum Verified PSP Game (USA)', 'ULUS-99999', ui, 'iso')],
               'saturn': [row('Other Region Game (Europe)', 'T-99990-50', bytes(2352), 'bin')]}, f)

with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=1)
print('%d fixtures in %s' % (len(manifest), OUT))
