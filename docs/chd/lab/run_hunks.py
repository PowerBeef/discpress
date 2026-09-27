"""Hunk size vs. size / create CPU / per-hunk decode cost (stock chdman; libchdr decode)."""
import json, os, re, subprocess, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
LAB = os.environ.get('LAB', os.path.join(ROOT, 'tests', '.cache', 'chd-lab'))
CORPUS = os.path.join(LAB, 'corpus')
STOCK = os.path.join(ROOT, 'build', 'chdman-native')
READ = os.path.join(LAB, 'bin', 'chdread')
OUT = os.path.join(LAB, 'out'); os.makedirs(OUT, exist_ok=True)


def cpu_run(cmd):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    _, _, ru = os.wait4(p.pid, 0)
    return p.stdout.read().decode(), p.stderr.read().decode(), ru.ru_utime + ru.ru_stime


plan = [('createcd', 'mixed.cue', 'cd', hs) for hs in (9792, 19584, 39168, 78336)] + \
       [('createdvd', 'payload.iso', 'dvd', hs) for hs in (2048, 4096, 8192, 16384, 32768, 65536)]
for cmd, inp, kind, hs in plan:
    dst = os.path.join(OUT, f'hs-{kind}-{hs}.chd')
    _, _, cpu = cpu_run([STOCK, cmd, '-i', os.path.join(CORPUS, inp), '-o', dst, '-f', '-np', '4', '-hs', str(hs)])
    info, _, _ = cpu_run([STOCK, 'info', '-i', dst])
    datasha = re.search(r'Data SHA1:\s+([0-9a-f]+)', info).group(1)
    hunks = int(re.search(r'Total Hunks:\s+([\d,]+)', info).group(1).replace(',', ''))
    p = subprocess.run(f'"{READ}" "{dst}" | sha1sum', shell=True, capture_output=True, text=True)
    m = re.search(r'decoded in ([\d.]+) s', p.stderr)
    dec = float(m.group(1)) if m else -1
    print(json.dumps({'kind': kind, 'hunkbytes': hs, 'bytes': os.path.getsize(dst), 'create_cpu_s': round(cpu, 2),
                      'hunks': hunks, 'libchdr_decode_cpu_s': dec, 'decode_us_per_hunk': round(dec / hunks * 1e6, 1),
                      'libchdr_ok': p.stdout.split()[0] == datasha}), flush=True)
