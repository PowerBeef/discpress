# libFLAC's math, the same in every build

libFLAC calls two libm functions while it encodes, and their last bits decide some of the bytes it writes:

- `cosf` builds the Tukey window for each block size;
- `log` estimates the bits per residual sample.

Libraries round these differently, so chdman's FLAC output (`cdfl` for CD audio, `flac`) used to depend on the libm it ran with. Emscripten's musl `cosf` differs from glibc's on 1.27% of the arguments libFLAC uses, and on 114 MB of real music the page's CHD differed from desktop chdman's.

`flac_libm.c` gives libFLAC (`window.c`, `lpc.c`, `fixed.c`) its own `discpress_cosf` and `discpress_log` in every build, native and wasm. Both are glibc's:

- **`discpress_cosf`** is Arm's `cosf` from [optimized-routines](https://github.com/ARM-software/optimized-routines), the code glibc 2.28 and later are built from.
- **`discpress_log`** is Arm's `log` with explicit `fma()` calls exactly where GCC fuses its multiply-adds when glibc is built for x86-64 with FMA. glibc runs that version on FMA-capable CPUs: nearly every PC since 2013. Without FMA hardware, `fma()` is computed exactly in software (musl in wasm).

Source: optimized-routines commit `47597821aaa52e9c055caf1ecf8f3aecfd751cd9` (`math/cosf.c`, `math/sincosf.h`, `math/sincosf_data.c`, `math/log.c`, `math/log_data.c`). License: MIT OR Apache-2.0 WITH LLVM-exception, used here under MIT ([`LICENSE`](LICENSE)). `flac_libm.c` lists its changes at the top. It must be compiled with `-ffp-contract=off` (`wasm/Makefile` does), so that no compiler fuses more than the code says.

The cost is in wasm, which has no FMA instruction: `discpress_log` takes about 143 ns there against musl's 5 ns. Creating a CD with audio takes about 4% longer with one thread, and 1% with four.

## How it was checked

| Check | Result |
|---|---|
| `discpress_cosf` against glibc 2.39's `cosf`, on every argument libFLAC's Tukey windows can take (block sizes 16–65535, the `p` of every compression level: 1.97 billion values) | identical, natively and in wasm; musl differs on 24.9 million |
| `discpress_log` against glibc 2.39's `log` on an FMA CPU, on 200 million inputs shaped like libFLAC's | identical, natively and in wasm; musl, like glibc without FMA, differs |
| CD-audio CHDs of 114 MB of CC and CC0 music, from the page and from unmodified chdman 0.289 | identical with every preset, 1 or 4 threads, SIMD or not; before, the page's differed |
| `tests/fixtures`: `music-cd`, 10 s of synthetic piano | the tests fail on the page before this change |

glibc on an x86-64 CPU without FMA, Apple's libm and MSVC's CRT round differently again. So chdman built there can differ in rare CD-audio hunks, from Discpress and from each other.

## Updating

Take the same five files from a newer optimized-routines commit and diff them against these functions. If `log.c` changed, dump GCC's fused operations for it:

```sh
gcc -O2 -mfma -ffp-contract=fast -DHAVE_FAST_FMA=1 -c log.c -fdump-tree-widening_mul
```

The `.FMA`/`.FNMA` lines of the `*.widening_mul` dump are the `fma()` calls to write. Then repeat both checks above.
