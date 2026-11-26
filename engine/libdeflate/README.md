# libdeflate's compressor

With `--libdeflate` (`chd_file::set_libdeflate`; the page's faster presets), chdman's deflate paths (`zlib`, `cdzl`, the subcode of `cdlz`, and the subcode of `cdfl` in `chdcodec.cpp`) encode with [libdeflate](https://github.com/ebiggers/libdeflate) at its level 9 instead of zlib's level 9. When combined with `--ultra` (the page's **Smaller still** preset), those same deflate paths encode at libdeflate level 12. The browser's CSO v1/v2 writer (`wasm/lz4_block.c`) also uses `libdeflate_deflate_compress` at level 9 for deflate-compressed CSO blocks. The result is standard raw deflate, so every CHD or CSO reader decodes it with zlib as before, and CHD checksums are unchanged. Only the compressed bytes differ, which is why `--libdeflate` and `--ultra` are opt-in.

Measured on 4 KiB DVD hunks and 18,816-byte CD hunks of a freely licensed corpus: 2.0 and 2.8 times faster than zlib's level 9, and 0.46% and 0.41% smaller.

Source: libdeflate v1.24, commit `96836d7d9d10e3e0d53e6edb54eb908514e336c4`, with two small WebAssembly adaptations:
- `common_defs.h` (lines 122–126): defines `typedef u64 machine_word_t;` under `#ifdef __wasm__` so WebAssembly uses 64-bit word operations instead of 32-bit `size_t`.
- `lib/matchfinder_common.h` (lines 93–126): adds `#elif defined(__wasm_simd128__)` implementations (`matchfinder_init_wasm` and `matchfinder_rebase_wasm`) using 128-bit SIMD saturating arithmetic and 64-byte unrolled stores.

Only what compression needs is kept: `libdeflate.h`, `common_defs.h`, and from `lib/` `deflate_compress.c`, `utils.c` and the headers they include (`x86/` and `arm/` only for their compile-time `matchfinder_impl.h` and `cpu_features.h`). Decompression still uses zlib. License: MIT ([`COPYING`](COPYING)).

The compressor's output depends only on its input and level, not on the CPU's features: the page's CHDs equal the native build's (`tests/ui/convert.spec.js`).
