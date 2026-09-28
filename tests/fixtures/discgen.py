"""Synthetic disc image building blocks for Discpress tests and benchmarks.

Everything here is generated from scratch (no game data): ISO 9660 file systems,
raw 2352-byte CD sectors with valid EDC/ECC (Mode 1 and Mode 2 Form 1), CD audio,
and filler data with a realistic mix of compressible and incompressible content.
Output is fully deterministic for a given seed.
"""
import numpy as np

SECTOR = 2048
RAW = 2352

# ---------------------------------------------------------------- EDC / ECC

def _luts():
    f = np.zeros(256, np.uint8)
    b = np.zeros(256, np.uint8)
    edc = np.zeros(256, np.uint32)
    for i in range(256):
        j = ((i << 1) ^ (0x11D if i & 0x80 else 0)) & 0xFF
        f[i] = j
        b[i ^ j] = i
        e = i
        for _ in range(8):
            e = (e >> 1) ^ (0xD8018001 if e & 1 else 0)
        edc[i] = e
    return f, b, edc


ECC_F, ECC_B, EDC_LUT = _luts()


def _ecc_index(major_count, minor_count, major_mult, minor_inc):
    size = major_count * minor_count
    idx = np.zeros((major_count, minor_count), np.int64)
    for major in range(major_count):
        index = (major >> 1) * major_mult + (major & 1)
        for minor in range(minor_count):
            idx[major, minor] = index
            index += minor_inc
            if index >= size:
                index -= size
    return idx


P_IDX = _ecc_index(86, 24, 2, 86)   # covers bytes 0x00C..0x81B
Q_IDX = _ecc_index(52, 43, 86, 88)  # covers bytes 0x00C..0x8C7 (includes P)


def _ecc_block(src, idx):
    g = src[:, idx]                          # (N, majors, minors)
    a = np.zeros(g.shape[:2], np.uint8)
    b = np.zeros(g.shape[:2], np.uint8)
    for k in range(g.shape[2]):
        t = g[:, :, k]
        a ^= t
        b ^= t
        a = ECC_F[a]
    a = ECC_B[ECC_F[a] ^ b]
    return np.concatenate([a, a ^ b], axis=1)


def edc(data):
    """EDC (CRC-32 variant) of each row of an (N, L) uint8 array."""
    e = np.zeros(data.shape[0], np.uint32)
    for i in range(data.shape[1]):
        e = (e >> np.uint32(8)) ^ EDC_LUT[(e ^ data[:, i]) & 0xFF]
    return e


def _bcd(n):
    return ((n // 10) << 4) | (n % 10)


def raw_sectors(user, mode=1, start_lba=0):
    """Wrap 2048-byte user data (bytes, length multiple of 2048) into raw 2352-byte
    sectors: Mode 1, or Mode 2 Form 1 (mode=2) with a data subheader."""
    u = np.frombuffer(user, np.uint8).reshape(-1, SECTOR)
    n = u.shape[0]
    s = np.zeros((n, RAW), np.uint8)
    s[:, 1:11] = 0xFF
    lba = np.arange(n) + start_lba + 150
    s[:, 12] = [_bcd(x // 4500) for x in lba]
    s[:, 13] = [_bcd((x // 75) % 60) for x in lba]
    s[:, 14] = [_bcd(x % 75) for x in lba]
    s[:, 15] = mode
    if mode == 1:
        s[:, 16:16 + SECTOR] = u
        e = edc(s[:, 0:0x810])
        s[:, 0x810:0x814] = e.view(np.uint8).reshape(n, 4)
        s[:, 0x81C:0x8C8] = _ecc_block(s[:, 12:12 + 2064], P_IDX)
        s[:, 0x8C8:0x930] = _ecc_block(s[:, 12:12 + 2236], Q_IDX)
    else:
        s[:, 18] = s[:, 22] = 0x08            # subheader submode: data
        s[:, 24:24 + SECTOR] = u
        e = edc(s[:, 0x10:0x818])
        s[:, 0x818:0x81C] = e.view(np.uint8).reshape(n, 4)
        hdr = s[:, 12:16].copy()
        s[:, 12:16] = 0                       # Mode 2 ECC is computed with a zero header
        s[:, 0x81C:0x8C8] = _ecc_block(s[:, 12:12 + 2064], P_IDX)
        s[:, 0x8C8:0x930] = _ecc_block(s[:, 12:12 + 2236], Q_IDX)
        s[:, 12:16] = hdr
    return s.tobytes()


def raw_sectors_chunked(user, mode=1, start_lba=0, chunk=4096):
    out = []
    for off in range(0, len(user), chunk * SECTOR):
        out.append(raw_sectors(user[off:off + chunk * SECTOR], mode, start_lba + off // SECTOR))
    return b''.join(out)


# ---------------------------------------------------------------- content

def audio(frames, seed=1, silence=0):
    """CD audio: 16-bit little-endian stereo at 44.1 kHz, `frames` sectors of 2352
    bytes. A few sine tones with a slow envelope and light noise, preceded by
    `silence` sectors of digital silence (a Redump-style pregap)."""
    rng = np.random.default_rng(seed)
    n = frames * 588
    t = np.arange(n) / 44100.0
    freqs = rng.uniform(110, 880, 3)
    sig = sum(np.sin(2 * np.pi * f * t + p) for f, p in zip(freqs, rng.uniform(0, 6, 3)))
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.25 * t)
    left = sig * env * 6000 + rng.normal(0, 200, n)
    right = np.roll(left, 37) * 0.9
    pcm = np.clip(np.stack([left, right], 1), -32768, 32767).astype('<i2').tobytes()
    return bytes(silence * RAW) + pcm


def _tone(rng, n, noise, big_endian=False):
    t = np.arange(n) / 44100.0
    x = np.sin(2 * np.pi * float(rng.uniform(100, 2000)) * t) * float(rng.uniform(2000, 12000)) + rng.normal(0, noise, n)
    pcm = np.clip(np.stack([x, np.roll(x, 7) * 0.8], 1), -32768, 32767)
    return pcm.astype('>i2' if big_endian else '<i2').tobytes()


def codec_audio(frames, seed=1):
    """CD audio whose best codec changes from hunk to hunk (8 sectors): clean and noisy tones,
    white noise, silence, and hunks that turn from noise to a tone or back halfway."""
    rng = np.random.default_rng(seed)
    out = bytearray()
    while len(out) < frames * RAW:
        n = 8 * 588
        k = int(rng.integers(0, 6))
        if k == 0: out += _tone(rng, n, 0)
        elif k == 1: out += _tone(rng, n, float(rng.choice([100, 1000, 4000])))
        elif k == 2: out += _tone(rng, n, 20000)[: n * 2] + bytes(n * 2) if rng.integers(0, 2) else _tone(rng, n, 20000)
        elif k == 3: out += bytes(n * 4)
        elif k == 4: out += _tone(rng, n // 2, 20000) + _tone(rng, n - n // 2, 0)
        else: out += _tone(rng, n // 2, 0) + _tone(rng, n - n // 2, 20000)
    return bytes(out[: frames * RAW])


def music(seconds, seed=1):
    """Piano-like CD audio: notes with decaying, slightly inharmonic overtones at random onsets, a
    little room reverb, stereo, 16-bit with dither. Unlike the sine tones above, it exposes libFLAC's
    dependence on cosf and log: with the libm the wasm build used to have, 10 seconds of it already
    gave different bytes from native chdman."""
    rng = np.random.default_rng(seed)
    sr = 44100
    n = int(seconds * sr)
    out = np.zeros((n, 2))
    t = np.arange(int(3.0 * sr)) / sr
    scale = 440.0 * 2 ** (np.array([-21, -19, -17, -16, -14, -12, -10, -9, -7, -5, -4, -2, 0, 2, 3, 5, 7, 8, 10, 12, 15, 17, 19]) / 12)
    pos = 0
    while pos < n:
        f = rng.choice(scale) * (1 + rng.normal(0, 0.001))
        amp = rng.uniform(0.05, 0.3)
        tone = np.zeros_like(t)
        for h in range(1, 9):
            tone += (amp / h ** 1.3) * np.sin(2 * np.pi * f * h * t * (1 + 0.0004 * h * h) + rng.uniform(0, 6.28)) * np.exp(-t * (1.2 + 0.9 * h))
        tone *= np.minimum(1, t / 0.004)
        pan = rng.uniform(0.2, 0.8)
        end = min(n, pos + len(t))
        out[pos:end, 0] += tone[: end - pos] * (1 - pan)
        out[pos:end, 1] += tone[: end - pos] * pan
        pos += int(rng.uniform(0.05, 0.4) * sr)
    ir = rng.normal(0, 1, int(0.08 * sr)) * np.exp(-np.arange(int(0.08 * sr)) / (0.02 * sr)) * 0.02
    for c in range(2):
        out[:, c] += np.convolve(out[:, c], ir)[:n]
    out /= max(1e-9, np.abs(out).max()) / 0.8
    x = out * 32767 + rng.uniform(-0.5, 0.5, out.shape) + rng.uniform(-0.5, 0.5, out.shape)
    pcm = np.clip(np.round(x), -32768, 32767).astype('<i2').tobytes()
    return pcm[: len(pcm) // RAW * RAW]


def codec_mix(size, grain, seed=1):
    """Data whose best codec changes every `grain` bytes: zeros, random and low-entropy bytes, text,
    filler, and 16-bit audio in both byte orders, clean and noisy."""
    rng = np.random.default_rng(seed)
    out = bytearray()
    while len(out) < size:
        k = int(rng.integers(0, 9))
        if k == 0: out += bytes(grain)
        elif k == 1: out += rng.integers(0, 256, grain, dtype=np.uint8).tobytes()
        elif k == 2: out += rng.integers(0, 16, grain, dtype=np.uint8).tobytes()
        elif k == 3: out += (b'LEVEL SCORE PLAYER ITEM the quick brown fox ' * (grain // 44 + 1))[:grain]
        elif k == 4: out += filler(max(grain, SECTOR), int(rng.integers(1, 1 << 30)))[:grain]
        else: out += _tone(rng, grain // 4, float(rng.choice([0, 30, 3000])), big_endian=k >= 7)
    return bytes(out[:size])


def filler(size, seed=1):
    """Deterministic data with a realistic mix: runs of zeros, structured/text-like
    data, graphics-like gradients and incompressible (already compressed) blocks."""
    rng = np.random.default_rng(seed)
    blocks = size // SECTOR
    out = np.zeros((blocks, SECTOR), np.uint8)
    kinds = rng.choice(4, blocks, p=[0.30, 0.30, 0.15, 0.25])
    words = np.frombuffer(b'the quick brown fox jumps over lazy dog LEVEL SCORE PLAYER ITEM 0123456789 ', np.uint8)
    i = 0
    while i < blocks:
        run = int(rng.integers(1, 64))
        k = kinds[i]
        sl = slice(i, min(blocks, i + run))
        m = sl.stop - sl.start
        if k == 1:
            out[sl] = words[rng.integers(0, len(words), (m, SECTOR)) // 4 * 4 % len(words)]
        elif k == 2:
            base = rng.integers(0, 256, (m, 1))
            out[sl] = (base + np.arange(SECTOR) // int(rng.integers(4, 64))).astype(np.uint8)
        elif k == 3:
            out[sl] = rng.integers(0, 256, (m, SECTOR), dtype=np.uint8)
        i = sl.stop
    tail = size - blocks * SECTOR
    return out.tobytes() + bytes(tail)


# ---------------------------------------------------------------- ISO 9660

DATE7 = bytes([100, 1, 1, 0, 0, 0, 0])            # 2000-01-01 00:00:00 UTC
DATE17 = b'2000010100000000\x00'


def _both16(v):
    return v.to_bytes(2, 'little') + v.to_bytes(2, 'big')


def _both32(v):
    return v.to_bytes(4, 'little') + v.to_bytes(4, 'big')


def _dirrec(name, lba, size, is_dir):
    ln = 33 + len(name) + (1 if len(name) % 2 == 0 else 0)
    r = bytes([ln, 0]) + _both32(lba) + _both32(size) + DATE7 + bytes([2 if is_dir else 0, 0, 0]) + _both16(1) + bytes([len(name)]) + name
    return r + bytes(ln - len(r))


def iso9660(files, volume_id='DISC', system_id='', system_area=b''):
    """Build an ISO 9660 image (bytes) from {path: bytes}; directories are implied
    by '/' in paths. `system_area` (up to 32 KiB) fills sectors 0-15, e.g. an IP.BIN."""
    tree = {'': {}}
    for path, data in files.items():
        parts = path.upper().split('/')
        for d in range(1, len(parts)):
            tree.setdefault('/'.join(parts[:d]), {})
            tree['/'.join(parts[:d - 1])][parts[d - 1]] = ('dir', '/'.join(parts[:d]))
        tree['/'.join(parts[:-1])][parts[-1]] = ('file', data)
    dirs = sorted(tree, key=lambda p: (p.count('/') if p else -1, p))
    dir_lba, lba = {}, 20
    for d in dirs:
        dir_lba[d] = lba
        lba += 1
    file_lba = {}
    for d in dirs:
        for name, (kind, v) in sorted(tree[d].items()):
            if kind == 'file':
                file_lba[(d, name)] = lba
                lba += max(1, -(-len(v) // SECTOR))
    total = lba
    img = bytearray(total * SECTOR)
    img[:len(system_area)] = system_area

    for d in dirs:
        parent = d.rsplit('/', 1)[0] if '/' in d else ''
        recs = _dirrec(b'\x00', dir_lba[d], SECTOR, True) + _dirrec(b'\x01', dir_lba[parent], SECTOR, True)
        for name, (kind, v) in sorted(tree[d].items()):
            if kind == 'dir':
                recs += _dirrec(name.encode(), dir_lba[v], SECTOR, True)
            else:
                recs += _dirrec((name + ';1').encode(), file_lba[(d, name)], len(v), False)
                o = file_lba[(d, name)] * SECTOR
                img[o:o + len(v)] = v
        assert len(recs) <= SECTOR, 'directory too large for this simple writer'
        img[dir_lba[d] * SECTOR:dir_lba[d] * SECTOR + len(recs)] = recs

    # path tables (L at 18, M at 19)
    num = {d: i + 1 for i, d in enumerate(dirs)}
    lt, mt = b'', b''
    for d in dirs:
        nm = d.rsplit('/', 1)[-1].encode() if d else b'\x00'
        parent = num[d.rsplit('/', 1)[0] if '/' in d else '']
        pad = b'\x00' if len(nm) % 2 else b''
        lt += bytes([len(nm), 0]) + dir_lba[d].to_bytes(4, 'little') + parent.to_bytes(2, 'little') + nm + pad
        mt += bytes([len(nm), 0]) + dir_lba[d].to_bytes(4, 'big') + parent.to_bytes(2, 'big') + nm + pad
    img[18 * SECTOR:18 * SECTOR + len(lt)] = lt
    img[19 * SECTOR:19 * SECTOR + len(mt)] = mt

    pvd = bytearray(SECTOR)
    pvd[0:7] = b'\x01CD001\x01'
    pvd[8:40] = system_id.encode().ljust(32)
    pvd[40:72] = volume_id.encode().ljust(32)
    pvd[80:88] = _both32(total)
    pvd[120:124] = _both16(1)
    pvd[124:128] = _both16(1)
    pvd[128:132] = _both16(SECTOR)
    pvd[132:140] = _both32(len(lt))
    pvd[140:144] = (18).to_bytes(4, 'little')
    pvd[148:152] = (19).to_bytes(4, 'big')
    pvd[156:190] = _dirrec(b'\x00', dir_lba[''], SECTOR, True)
    pvd[190:813] = b' ' * 623
    for o in (813, 830, 847, 864):
        pvd[o:o + 17] = DATE17
    pvd[881] = 1
    img[16 * SECTOR:17 * SECTOR] = pvd
    img[17 * SECTOR:17 * SECTOR + 7] = b'\xffCD001\x01'
    return bytes(img)


def pad_sectors(b, sector=SECTOR):
    return b + bytes(-len(b) % sector)


def sfo(entries):
    """PlayStation Portable PARAM.SFO with UTF-8 string entries."""
    keys, data, index = b'', b'', b''
    for k, v in entries.items():
        val = v.encode() + b'\x00'
        cap = (len(val) + 3) // 4 * 4
        index += len(keys).to_bytes(2, 'little') + (0x0204).to_bytes(2, 'little') + len(val).to_bytes(4, 'little') + cap.to_bytes(4, 'little') + len(data).to_bytes(4, 'little')
        keys += k.encode() + b'\x00'
        data += val.ljust(cap, b'\x00')
    keys = keys.ljust((len(keys) + 3) // 4 * 4, b'\x00')
    key_off = 20 + len(index)
    return b'\x00PSF' + (0x0101).to_bytes(4, 'little') + key_off.to_bytes(4, 'little') + (key_off + len(keys)).to_bytes(4, 'little') + len(entries).to_bytes(4, 'little') + index + keys + data


def msf(frames):
    return '%02d:%02d:%02d' % (frames // 4500, (frames // 75) % 60, frames % 75)


# ---------------------------------------------------------------- compressed ISOs (CSO, ZSO)

def lz4_block(data):
    """LZ4 block format (a simple greedy compressor; slow, for small fixtures)."""
    n, out, table, anchor, i = len(data), bytearray(), {}, 0, 0

    def more(v):  # a length past the token's 15
        while v >= 255:
            out.append(255)
            v -= 255
        out.append(v)

    while i + 12 <= n:  # the last match starts 12 bytes or more before the end
        key = data[i:i + 4]
        cand = table.get(key)
        table[key] = i
        if cand is None or i - cand > 65535:
            i += 1
            continue
        m = 4
        while i + m < n - 5 and data[cand + m] == data[i + m]:  # the last 5 bytes are literals
            m += 1
        lit = i - anchor
        out.append(min(lit, 15) << 4 | min(m - 4, 15))
        if lit >= 15:
            more(lit - 15)
        out += data[anchor:i] + (i - cand).to_bytes(2, 'little')
        if m - 4 >= 15:
            more(m - 4 - 15)
        i = anchor = i + m
    lit = n - anchor
    out.append(min(lit, 15) << 4)
    if lit >= 15:
        more(lit - 15)
    return bytes(out + data[anchor:])


def ciso(iso, version=1, block=SECTOR, shift=0, zso=False):
    """A compressed ISO laid out as maxcso writes one (its README_CSO.md and README_ZSO.md):
    CSO v1 (deflate), CSO v2 (deflate and LZ4, alternating so that both appear) or ZSO (LZ4).
    The last block is filled to the block size with zeros before it is compressed. Blocks that
    don't shrink are stored as they are. Blocks start on 2**shift-byte boundaries, padded with 0xAA."""
    import zlib
    count, align = -(-len(iso) // block), 1 << shift
    head = (b'ZISO' if zso else b'CISO') + (24).to_bytes(4, 'little') + len(iso).to_bytes(8, 'little') + \
        block.to_bytes(4, 'little') + bytes([2 if version == 2 else 1, shift, 0, 0])
    pos = 24 + 4 * (count + 1)
    body, index = bytearray(b'\xaa' * (-pos % align)), []
    pos += len(body)
    for b in range(count):
        raw = iso[b * block:(b + 1) * block].ljust(block, b'\0')
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed, lz4 = c.compress(raw) + c.flush(), zso or (version == 2 and b % 2 == 1)
        if lz4:
            packed = lz4_block(raw)
        stored = len(packed) + (-len(packed) % align)
        if (stored >= block) if version == 2 else (len(packed) >= block):
            index.append(pos >> shift | (0 if version == 2 else 0x80000000))
            packed = raw
        else:
            index.append(pos >> shift | (0x80000000 if version == 2 and lz4 else 0))
        packed += b'\xaa' * (-len(packed) % align)
        body += packed
        pos += len(packed)
    index.append(pos >> shift)
    return head + b''.join(e.to_bytes(4, 'little') for e in index) + bytes(body)
