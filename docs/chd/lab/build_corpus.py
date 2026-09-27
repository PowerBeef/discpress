"""Build measurement corpora from freely licensed material (never committed anywhere).

data payload: Freedoom 0.13 WADs (BSD-3) + ELF binaries + Python sources (text)
              + incompressible "FMV-like" bytes + zero padding, in 2048-byte sectors.
audio:        CC BY-NC-SA (NIN "The Slip") and CC0 (Musopen Chopin) tracks resampled
              to 44.1 kHz / 16-bit with TPDF dither, like a CD master.

Outputs (in the directory given as argument, where lab.sh fetch put the sources):
  payload.iso    2048-byte sectors (DVD / createdvd / createcd MODE1 input)
  data_m1.bin    MODE1/2352 raw sectors of the payload (valid EDC/ECC)
  data_m2.bin    MODE2/2352 (Form 1, PS1-style) raw sectors of the payload
  audio.bin      CD-DA, 16-bit little endian stereo, each track padded to 2352
  mixed.cue/.bin a mixed-mode disc: data_m2 track + the audio tracks
"""
import glob, os, shutil, sys, zipfile
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'tests', 'fixtures'))
import discgen

here = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
os.chdir(here)
S = 2048


def pad(b, n=S):
    return b + bytes((-len(b)) % n)


def payload():
    parts = []
    z = zipfile.ZipFile('freedoom.zip')
    wad1 = z.read('freedoom-0.13.0/freedoom1.wad')
    wad2 = z.read('freedoom-0.13.0/freedoom2.wad')
    # executables: a deterministic selection of ELF shared objects (~8 MB)
    libs, total = [], 0
    for p in sorted(glob.glob('/usr/lib/x86_64-linux-gnu/*.so*')):
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        sz = os.path.getsize(p)
        if 200_000 < sz < 3_000_000:
            libs.append(open(p, 'rb').read()); total += sz
        if total > 8_000_000:
            break
    # text: Python standard library sources (~4 MB)
    txt, total = [], 0
    for p in sorted(glob.glob('/usr/local/lib/python3*/**/*.py', recursive=True)):
        b = open(p, 'rb').read(); txt.append(b); total += len(b)
        if total > 4_000_000:
            break
    rng = np.random.default_rng(1234)
    fmv = rng.integers(0, 256, 8 * 2**20, dtype=np.uint8).tobytes()
    zeros = bytes(4 * 2**20)
    for b in [wad1] + libs + txt + [fmv, wad2, zeros]:
        parts.append(pad(b))
    return b''.join(parts)


def audio_tracks():
    tracks = []
    rng = np.random.default_rng(99)
    for f in sorted(glob.glob('*.flac')):
        x, sr = sf.read(f, dtype='float64', always_2d=True)
        if sr != 44100:
            from math import gcd
            g = gcd(44100, sr)
            x = resample_poly(x, 44100 // g, sr // g, axis=0)
        x = x * 32767.0 + (rng.random(x.shape) - rng.random(x.shape))  # TPDF dither
        pcm = np.clip(np.round(x), -32768, 32767).astype('<i2').tobytes()
        tracks.append((f, pad(pcm, 2352)))
    return tracks


if __name__ == '__main__':
    p = payload()
    open('payload.iso', 'wb').write(p)
    m1 = discgen.raw_sectors_chunked(p, mode=1)
    open('data_m1.bin', 'wb').write(m1)
    m2 = discgen.raw_sectors_chunked(p, mode=2)
    open('data_m2.bin', 'wb').write(m2)
    tr = audio_tracks()
    with open('audio.bin', 'wb') as fa:
        for _, pcm in tr:
            fa.write(pcm)
    # mixed-mode disc: one bin per track, Redump style (2 s pregap of silence on audio tracks)
    cue = ['FILE "mixed (Track 1).bin" BINARY', '  TRACK 01 MODE2/2352', '    INDEX 01 00:00:00']
    open('mixed (Track 1).bin', 'wb').write(m2)
    for i, (_, pcm) in enumerate(tr, start=2):
        name = f'mixed (Track {i}).bin'
        open(name, 'wb').write(bytes(150 * 2352) + pcm)
        cue += [f'FILE "{name}" BINARY', f'  TRACK {i:02d} AUDIO', '    INDEX 00 00:00:00', '    INDEX 01 00:02:00']
    open('mixed.cue', 'w').write('\n'.join(cue) + '\n')
    # a smaller pair for the slowest variants (SLOW in run_variants.py): the first 12,000 sectors of
    # payload.iso, and a disc with the first 6,000 data frames plus the first and third audio tracks
    open('small.iso', 'wb').write(p[:12000 * S])
    open('small (Track 1).bin', 'wb').write(m2[:6000 * 2352])
    cue = ['FILE "small (Track 1).bin" BINARY', '  TRACK 01 MODE2/2352', '    INDEX 01 00:00:00']
    for i, src in ((2, 2), (3, 4)):
        name = f'small (Track {i}).bin'
        shutil.copyfile(f'mixed (Track {src}).bin', name)
        cue += [f'FILE "{name}" BINARY', f'  TRACK {i:02d} AUDIO', '    INDEX 00 00:00:00', '    INDEX 01 00:02:00']
    open('small.cue', 'w').write('\n'.join(cue) + '\n')
    print('payload', len(p) // S, 'sectors;', 'audio', sum(len(t[1]) for t in tr) // 2352, 'frames;',
          [(t[0], len(t[1]) // 2352) for t in tr])
