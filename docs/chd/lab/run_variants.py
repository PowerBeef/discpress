"""Create CHDs with encoder variants, then prove every existing decoder path still reads them:
MAME (`chdman verify`, stock binary) and libchdr (decode all hunks, compare data SHA-1)."""
import json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
LAB = os.environ.get('LAB', os.path.join(ROOT, 'tests', '.cache', 'chd-lab'))
CORPUS = os.path.join(LAB, 'corpus')
VAR = os.path.join(LAB, 'bin', 'chdman-variant')
STOCK = os.path.join(ROOT, 'build', 'chdman-native')
READ = os.path.join(LAB, 'bin', 'chdread')
OUT = os.path.join(LAB, 'out'); os.makedirs(OUT, exist_ok=True)

VARIANTS = {
    'stock': {},
    'lzma9': {'CHDV_LZMA': 'level=9'},
    'lzma9-fb273': {'CHDV_LZMA': 'level=9,fb=273'},
    'lzma9-fb273-mc512': {'CHDV_LZMA': 'level=9,fb=273,mc=512'},
    'libdeflate12': {'CHDV_DEFLATE': 'libdeflate:12'},
    'zopfli15': {'CHDV_DEFLATE': 'zopfli:15'},
    'flac-e-p': {'CHDV_FLAC': 'e,p'},
    'flac-l32': {'CHDV_FLAC': 'l=32'},
    'flac-e-p-l32': {'CHDV_FLAC': 'e,p,l=32'},
    'flac-apod': {'CHDV_FLAC': 'a=subdivide_tukey(5)'},
    'flac-p': {'CHDV_FLAC': 'p'},
    # the "Smallest" preset candidate from docs/chd/fork-plan.md (every setting decodable by all readers)
    'smallest': {'CHDV_LZMA': 'level=9,fb=273,mc=1000', 'CHDV_DEFLATE': 'libdeflate:12', 'CHDV_FLAC': 'p'},
}
SLOW = {'zopfli15', 'flac-e-p', 'flac-e-p-l32'}  # minutes to hours on the full corpus: run on the -small jobs

JOBS = {
    'cd': ['createcd', 'mixed.cue'],
    'dvd': ['createdvd', 'payload.iso'],
    'cd-small': ['createcd', 'small.cue'],
    'dvd-small': ['createdvd', 'small.iso'],
}


def run(cmd, env=None):
    t0 = time.time()
    p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    _, _, ru = os.wait4(p.pid, 0)
    out, err = p.stdout.read().decode(), p.stderr.read().decode()
    return out, err, ru.ru_utime + ru.ru_stime, time.time() - t0


def one(variant, job):
    cmdname, inp = JOBS[job]
    dst = os.path.join(OUT, f'{job}-{variant}.chd')
    env = dict(os.environ); env.update(VARIANTS[variant])
    out, err, cpu, wall = run([VAR, cmdname, '-i', os.path.join(CORPUS, inp), '-o', dst, '-f', '-np', '4'], env)
    note = ' '.join(l for l in err.splitlines() if l.startswith('CHDV'))
    info, _, _, _ = run([STOCK, 'info', '-i', dst])
    datasha = re.search(r'Data SHA1:\s+([0-9a-f]+)', info).group(1)
    ver_out, ver_err, vcpu, _ = run([STOCK, 'verify', '-i', dst])
    mame_ok = 'Raw SHA1 verification successful' in (ver_out + ver_err)
    p = subprocess.run(f'"{READ}" "{dst}" | sha1sum', shell=True, capture_output=True, text=True)
    libchdr_ok = p.stdout.split()[0] == datasha if p.stdout else False
    r = {'variant': variant, 'job': job, 'bytes': os.path.getsize(dst), 'cpu_s': round(cpu, 2), 'wall_s': round(wall, 2),
         'mame_verify': mame_ok, 'libchdr_sha1_ok': libchdr_ok, 'data_sha1': datasha, 'note': note,
         'libchdr_decode': p.stderr.strip()}
    print(json.dumps(r), flush=True)
    return r


if __name__ == '__main__':
    plan = sys.argv[1:] or [f'{v}:{j}' for v in VARIANTS for j in ('cd', 'dvd') if v not in SLOW]
    for item in plan:
        v, j = item.split(':')
        one(v, j)
