"""Offline analysis of harness per-hunk dumps: what would each codec-selection policy cost
(output size) and save (CPU time) relative to chdman's default "try every codec" rule."""
import csv, json, sys

HS = {'cd': 19584, 'dvd': 4096}


def load(path):
    rows = list(csv.DictReader(open(path)))
    names = [k[:-4] for k in rows[0] if k.endswith('_len')]
    return rows, names


def policy(rows, names, hs, pick):
    """pick(row) -> list of codec names tried for this hunk (in order). Returns (bytes, cpu_s)."""
    total = 0; cpu = 0.0
    for r in rows:
        tried = pick(r)
        best = hs
        for n in tried:
            cpu += float(r[n + '_c'])
            l = int(r[n + '_len'])
            if 0 <= l < best:
                best = l
        total += best
    return total, cpu


def report(title, path, kind, default, extra_policies):
    rows, names = load(path)
    hs = HS[kind]
    raw = len(rows) * hs
    base_b, base_t = policy(rows, names, hs, lambda r: default)
    print(f'\n## {title}  ({len(rows)} unique hunks, {raw/1e6:.1f} MB)')
    print(f'{"policy":58s} {"size":>9s} {"vs default":>10s} {"CPU s":>7s} {"speedup":>7s}')
    print(f'{"default " + "+".join(default):58s} {base_b/raw:9.4f} {"":>10s} {base_t:7.2f} {1.0:7.2f}')
    # per-codec share of the default trial
    for n in default:
        t = sum(float(r[n + '_c']) for r in rows)
        print(f'   time share {n}: {t/base_t*100:5.1f}%')
    # oracle: only the winner runs
    def oracle(r):
        best = hs; w = []
        for n in default:
            l = int(r[n + '_len'])
            if 0 <= l < best:
                best = l; w = [n]
        return w
    ob, ot = policy(rows, names, hs, oracle)
    print(f'{"oracle (only the eventual winner runs)":58s} {ob/raw:9.4f} {(ob-base_b)/base_b*100:+9.2f}% {ot:7.2f} {base_t/ot:7.2f}')
    for label, fn in extra_policies:
        b, t = policy(rows, names, hs, fn)
        print(f'{label:58s} {b/raw:9.4f} {(b-base_b)/base_b*100:+9.2f}% {t:7.2f} {base_t/t:7.2f}')


def is_audio_guess(r):
    # a real implementation looks at the track type (chdman knows it from the cue/toc)
    return False


if __name__ == '__main__':
    d = sys.argv[1] if len(sys.argv) > 1 else '.'
    report('CD data (Mode 2 Form 1, game-like payload)', f'{d}/data_m2.csv', 'cd', ['cdlz', 'cdzl', 'cdfl'], [
        ('data track: cdlz only', lambda r: ['cdlz']),
        ('data track: cdlz + cdzl (skip cdfl)', lambda r: ['cdlz', 'cdzl']),
        ('data track: cdzs only (zstd-22)', lambda r: ['cdzs']),
        ('default + cdzs as 4th codec', lambda r: ['cdlz', 'cdzl', 'cdfl', 'cdzs']),
        ('data track: cdlz + cdzs', lambda r: ['cdlz', 'cdzs']),
    ])
    report('CD audio (CD-DA, 10.8 min, 4 tracks)', f'{d}/audio.csv', 'cd', ['cdlz', 'cdzl', 'cdfl'], [
        ('audio track: cdfl only', lambda r: ['cdfl']),
        ('audio track: cdfl + cdzl', lambda r: ['cdfl', 'cdzl']),
    ])
    report('DVD / raw data (2048-byte sectors, 4 KiB hunks)', f'{d}/dvd.csv', 'dvd', ['lzma', 'zlib', 'huff', 'flac'], [
        ('skip flac', lambda r: ['lzma', 'zlib', 'huff']),
        ('lzma only', lambda r: ['lzma']),
        ('lzma + zlib', lambda r: ['lzma', 'zlib']),
        ('default + zstd-22 as 5th codec', lambda r: ['lzma', 'zlib', 'huff', 'flac', 'zstd']),
        ('zstd-22 only', lambda r: ['zstd']),
    ])


def early_abort(rows, hs, order, listorder):
    """Byte-identical: codecs run in `order` (predicted winner first); each later codec is
    abandoned once its output would exceed the best so far (ties: earlier in `listorder` wins).
    Assumes output grows linearly with input consumed (estimate)."""
    total = 0; cpu = 0.0
    for r in rows:
        best = hs; bestidx = 99
        for n in order:
            c = float(r[n + '_c']); l = int(r[n + '_len']); idx = listorder.index(n)
            if l < 0:
                cpu += c; continue
            if best < hs and (l > best or (l == best and idx > bestidx)):
                cpu += c * min(1.0, best / l)   # abandoned part-way
                continue
            cpu += c
            if l < best or (l == best and idx < bestidx):
                best = l; bestidx = idx
        total += best
    return total, cpu


if __name__ == '__main__':
    print('\n## Byte-identical early abort (estimate: output grows linearly with input)')
    for title, path, kind, default, order in [
        ('CD data  ', 'data_m2.csv', 'cd', ['cdlz', 'cdzl', 'cdfl'], ['cdlz', 'cdzl', 'cdfl']),
        ('CD audio ', 'audio.csv', 'cd', ['cdlz', 'cdzl', 'cdfl'], ['cdfl', 'cdlz', 'cdzl']),
        ('DVD      ', 'dvd.csv', 'dvd', ['lzma', 'zlib', 'huff', 'flac'], ['lzma', 'zlib', 'huff', 'flac']),
        ('DVD huff1', 'dvd.csv', 'dvd', ['lzma', 'zlib', 'huff', 'flac'], ['huff', 'lzma', 'zlib', 'flac']),
    ]:
        rows, names = load(path)
        hs = HS[kind]
        bb, bt = policy(rows, names, hs, lambda r: default)
        eb, et = early_abort(rows, hs, order, default)
        print(f'{title} order {"+".join(order):24s} size {"identical" if eb == bb else "DIFFERS"}  CPU {bt:6.2f}s -> {et:6.2f}s  speedup {bt/et:4.2f}x')
