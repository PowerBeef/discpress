#!/usr/bin/env python3
"""Print one SHA-256 for every source the WebAssembly build is made from, so a page can record the
sources its wasm was built from and scripts/check-dist.sh can tell when they changed since.

The sources: build.sh and the files under engine/ and wasm/ that git tracks or would track (not
ignored), except documentation (*.md), engine/FILES and engine/mame-0.289.diff (the diff is shown in
Help, which check-dist compares separately). The hash covers their contents and paths, never dates,
so every checkout of the same sources gives the same one. It is the SHA-256 of `sha256sum`'s listing
of those files, sorted by path:
    git ls-files --cached --others --exclude-standard build.sh engine wasm \\
      | grep -v -e '\\.md$' -e '^engine/FILES$' -e '^engine/mame-0.289.diff$' | LC_ALL=C sort \\
      | xargs sha256sum | sha256sum

Usage: scripts/engine-sources.py [--list]   (--list prints the listing instead of its hash)
"""
import hashlib, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE = {'engine/FILES', 'engine/mame-0.289.diff'}


def files():
    try:
        out = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
                              'build.sh', 'engine', 'wasm'], cwd=ROOT, check=True, capture_output=True).stdout
        paths = [p.decode('utf-8') for p in out.split(b'\0') if p]
    except (OSError, subprocess.CalledProcessError):
        # not a git checkout (a source archive): every file there
        paths = ['build.sh'] + [os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, '/')
                                for top in ('engine', 'wasm') for d, _, fs in os.walk(os.path.join(ROOT, top)) for f in fs]
    # a file deleted but not yet removed from git's index is simply gone
    return sorted({p for p in paths if not p.endswith('.md') and p not in EXCLUDE and os.path.isfile(os.path.join(ROOT, p))},
                  key=lambda p: p.encode('utf-8'))


def listing():
    lines = []
    for p in files():
        with open(os.path.join(ROOT, p), 'rb') as f:
            lines.append('%s  %s\n' % (hashlib.sha256(f.read()).hexdigest(), p))
    return ''.join(lines)


def digest():
    return hashlib.sha256(listing().encode('utf-8')).hexdigest()


if __name__ == '__main__':
    sys.stdout.write(listing() if sys.argv[1:] == ['--list'] else digest() + '\n')
