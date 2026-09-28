# libFLAC's math, the same in every build

libFLAC calls two libm functions while it encodes, and their last bits decide some of the bytes it writes:

- `cosf` builds the Tukey window for each block size;
- `log` estimates the bits per residual sample.

Libraries round these differently, so chdman's FLAC output (`cdfl` for CD audio, `flac`) used to depend on the libm it ran with. Emscripten's musl `cosf` differs from glibc's on 1.27% of the arguments libFLAC uses, and on 114 MB of real music the page's CHD differed from desktop chdman's.

`flac_libm.c` gives libFLAC (`window.c`, `lpc.c`, `fixed.c`) its own `discpress_cosf` and `discpress_log` in every build, native and wasm. Both are glibc's:

- **`discpress_cosf`** is Arm's `cosf` from [optimized-routines](https://github.com/ARM-software/optimized-routines), the code glibc 2.28 and later are built from.
- **`discpress_log`** is Arm's `log` with its multiply-adds fused exactly where GCC fuses them when glibc is built for x86-64 with FMA. glibc runs that version on FMA-capable CPUs: nearly every PC since 2013. Wasm has no fma instruction, so the fused results are computed from plain operations (below).

Source: optimized-routines commit `47597821aaa52e9c055caf1ecf8f3aecfd751cd9` (`math/cosf.c`, `math/sincosf.h`, `math/sincosf_data.c`, `math/log.c`, `math/log_data.c`). License: MIT OR Apache-2.0 WITH LLVM-exception, used here under MIT ([`LICENSE`](LICENSE)). `flac_libm.c` lists its changes at the top. It must be compiled with `-ffp-contract=off` (`wasm/Makefile` does), so that no compiler fuses more than the code says.

## Fused results without an fma instruction

libFLAC calls `log` about 670 times per 4 KiB DVD hunk, and Arm's `log` has 8 fused multiply-adds. With musl's `fma()` (about 20 ns each in wasm) `discpress_log` took 160 ns, and DVD creation got 20% slower. So `discpress_log` gets the fused results another way:

- `r = fma(z, invc, -1)`: the product is split exactly (Dekker), and since it is within 2^-7 of 1, subtracting 1 is exact, so one rounding remains, as in the fused operation.
- `w = fma(Ln2hi, k, logc)`: Arm's table makes `k*Ln2hi + logc` exact, so nothing rounds either way.
- The other six are computed unfused. From the operands' ranges, that moves the polynomial's result by at most 2^-63.5 (2^-69 was the most seen). When a margin of 2^-62 can't change the final rounding, the unfused result is the fused one. Otherwise (about once in 2,500 calls on libFLAC's arguments) the six are emulated exactly: an exact product and an exact sum rounded once, with round-to-odd (Boldo and Melquiond, 2008).

`discpress_log` now takes 11–13 ns in wasm against musl's 6–8 ns. Creating CHDs takes within 1% of the time it took with musl's functions: 51.8 s for the benchmark CD with one thread either way, and 61.3 s against 60.9 s for the 1 GB DVD with four.

## How it was checked

| Check | Result |
|---|---|
| `discpress_cosf` against glibc 2.39's `cosf`, on every argument libFLAC's Tukey windows can take (block sizes 16–65535, the `p` of every compression level: 1.97 billion values) | identical, natively and in wasm; musl differs on 24.9 million |
| `discpress_log` against glibc 2.39's `log` on an FMA CPU, on 200 million inputs shaped like libFLAC's | identical, natively and in wasm; musl, like glibc without FMA, differs |
| The exact-fma emulation against the CPU's fma instruction, on a billion operand triples (ranges like log's, general, near-cancelling, and 200 million built so that the last bits decide a tie) | identical |
| The unfused-when-safe `discpress_log` against the fma version above, on a billion inputs (all positive doubles, 2^-20–2^40, around 1, small logarithms); against glibc's `log` on 300 million more; and wasm (SIMD or not) against native, by hashing 300 million results | identical everywhere. With the margin set to 0 instead, the check finds wrong results, so it would catch an unsafe margin |
| CD-audio CHDs of 114 MB of CC and CC0 music, from the page and from unmodified chdman 0.289 | identical with every preset, 1 or 4 threads, SIMD or not; before, the page's differed |
| `tests/fixtures`: `music-cd`, 10 s of synthetic piano | the tests fail on the page before this change |

glibc on an x86-64 CPU without FMA, Apple's libm and MSVC's CRT round differently again. So chdman built there can differ in rare CD-audio hunks, from Discpress and from each other.

## Updating

Take the same five files from a newer optimized-routines commit and diff them against these functions. If `log.c` changed, dump GCC's fused operations for it:

```sh
gcc -O2 -mfma -ffp-contract=fast -DHAVE_FAST_FMA=1 -c log.c -fdump-tree-widening_mul
```

The `.FMA`/`.FNMA` lines of the `*.widening_mul` dump are the fused operations to reproduce. If `log.c`'s polynomial or table changed, redo the bound on the unfused part and the reasoning for `r` and `w` in `discpress_log`. Then repeat the checks above.
