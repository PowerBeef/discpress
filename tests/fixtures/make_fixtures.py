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

fixture('ps1-single', {
    'twine.cue': lambda: cue([('twine.bin', 'MODE2/2352', 0)]),
    'twine.bin': lambda: g.raw_sectors(ps1_iso('SLUS_012.72', 'TWINE', 1, 12), 2),
}, add=['twine.cue', 'twine.bin'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-01272',
   ident='serial', name='007 - The World Is Not Enough (USA)')

fixture('ps1-lone-bin', {
    'lone.bin': lambda: g.raw_sectors(ps1_iso('SLUS_009.75', 'TND', 1, 13), 2),
}, add=['lone.bin'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00975',
   ident='serial', name='007 - Tomorrow Never Dies (USA)', warning='No .cue file was added')

# a PlayStation CD game stored as a plain 2048-byte .iso: must become a CD CHD, not a DVD one
fixture('ps1-as-iso', {
    'tnd.iso': lambda: ps1_iso('SLUS_009.75', 'TND', 1, 14),
}, add=['tnd.iso'], job='create', disc='cd', command='createcd', sys='ps1', serial='SLUS-00975',
   ident='serial', name='007 - Tomorrow Never Dies (USA)')

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
fixture('ps2-dvd', {
    'agent.iso': lambda: g.pad_sectors(g.iso9660({
        'SYSTEM.CNF': b'BOOT2 = cdrom0:\\SLUS_202.65;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n',
        'SLUS_202.65': exe('SLUS_202.65'), 'DATA.BIN': g.filler(24 << 20, 21)}, 'AUF', 'PLAYSTATION')),
}, add=['agent.iso'], job='create', disc='dvd', command='createdvd', sys='ps2', serial='SLUS-20265',
   ident='serial', name='007 - Agent Under Fire (USA)')

fixture('psp-umd', {
    'frwl.iso': lambda: g.pad_sectors(g.iso9660({
        'UMD_DATA.BIN': b'ULUS-10080|0000000000000001|0001|G',
        'PSP_GAME/PARAM.SFO': g.sfo({'CATEGORY': 'UG', 'DISC_ID': 'ULUS10080', 'DISC_VERSION': '1.00', 'TITLE': 'FROM RUSSIA WITH LOVE'}),
        'PSP_GAME/SYSDIR/EBOOT.BIN': g.filler(2 << 20, 31), 'PSP_GAME/USRDIR/DATA.BIN': g.filler(12 << 20, 32)}, 'PSP_GAME', 'PSP GAME')),
}, add=['frwl.iso'], job='create', disc='dvd', command='createdvd', sys='psp', serial='ULUS-10080',
   ident='serial', name='007 - From Russia with Love (USA)')

# ---------------------------------------------------------------- Sega
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
        ipbin(b'SEGA SEGASATURN ', 0x20, b'T-12705H  ', 0x60, b'ALBERT ODYSSEY', {0x10: b'SEGA TP T-127   '}))), 1),
}, add=['albert odyssey.cue', 'albert odyssey.bin'], job='create', disc='cd', command='createcd', sys='saturn', serial='T-12705H',
   ident='serial', name='Albert Odyssey - Legend of Eldean (USA)')

# a USA disc whose serial (T-8113H) also prefixes European/German releases (T-8113H-50, T-8113H-18):
# the exact match must win
fixture('saturn-region', {
    'alien trilogy.cue': lambda: cue([('alien trilogy.bin', 'MODE1/2352', 0)]),
    'alien trilogy.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'0.BIN': g.filler(256 << 10, 42)}, 'ALIEN', 'SEGA SEGASATURN',
        ipbin(b'SEGA SEGASATURN ', 0x20, b'T-8113H   ', 0x60, b'ALIEN TRILOGY', {0x10: b'SEGA TP T-81    '}))), 1),
}, add=['alien trilogy.cue', 'alien trilogy.bin'], job='create', disc='cd', command='createcd', sys='saturn', serial='T-8113H',
   ident='serial', name='Alien Trilogy (USA)')

fixture('segacd', {
    'ax101.cue': lambda: cue([('ax101.bin', 'MODE1/2352', 0), ('ax101 audio.bin', 'AUDIO', 150)]),
    'ax101.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'MAIN.PRG': g.filler(768 << 10, 51)}, 'AX101', '',
        ipbin(b'SEGADISCSYSTEM  ', 0x180, b'GM T-86015 -00', 0x150, b'A/X-101'))), 1),
    'ax101 audio.bin': lambda: g.audio(300, 52, silence=150),
}, add=['ax101.cue', 'ax101.bin', 'ax101 audio.bin'], job='create', disc='cd', command='createcd', sys='segacd', serial='T-86015',
   ident='serial', name='A-X-101 (USA)')

fixture('dreamcast-gdi', {
    'aerowings.gdi': lambda: b'3\r\n1 0 4 2352 track01.bin 0\r\n2 450 0 2352 track02.raw 0\r\n3 45000 4 2352 track03.bin 0\r\n',
    'track01.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660({'README.TXT': b'fixture'}, 'AEROWINGS')), 1, 0),
    'track02.raw': lambda: g.audio(302, 61),
    'track03.bin': lambda: g.raw_sectors(g.pad_sectors(g.iso9660(
        {'1ST_READ.BIN': g.filler(2 << 20, 62)}, 'AEROWINGS', '',
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'T-40201N  ', 0x80, b'AEROWINGS', {0x10: b'SEGA ENTERPRISES', 0x30: b'GD-ROM1/1       '}))), 1, 45000),
}, add=['aerowings.gdi', 'track01.bin', 'track02.raw', 'track03.bin'], job='create', disc='gdrom', command='createcd', sys='dc',
   serial='T-40201N', ident='serial', name='AeroWings (USA)')

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
        ipbin(b'SEGA SEGAKATANA ', 0x40, b'T-40201N  ', 0x80, b'AEROWINGS', {0x10: b'SEGA ENTERPRISES', 0x30: b'GD-ROM1/1       '}))), 1, 45000),
}, add=['aerowings.cue', 'aerowings (Track 1).bin', 'aerowings (Track 2).bin', 'aerowings (Track 3).bin'], job='create', disc='gdrom',
   command='createcd', sys='dc', serial='T-40201N', ident='serial', name='AeroWings (USA)')

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

# extra database rows for the page served with ?testdb=1 (see tests/support/server.js)
vb = open(os.path.join(OUT, 'verified.bin'), 'rb').read()
with open(os.path.join(OUT, 'testdb.json'), 'w') as f:
    json.dump({'ps1': ['\t'.join(['Checksum Verified Game (USA)', 'SLUS-99999', str(len(vb)), '%08X' % zlib.crc32(vb), '', 'bin'])]}, f)

with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=1)
print('%d fixtures in %s' % (len(manifest), OUT))
