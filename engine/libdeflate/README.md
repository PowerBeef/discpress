# libdeflate's compressor

With `--libdeflate` (`chd_file::set_libdeflate`; the page's faster presets), chdman's deflate codec (`zlib`, and `cdzl` and the subcode of `cdlz` in CD CHDs) encodes with [libdeflate](https://github.com/ebiggers/libdeflate) at its level 9 instead of zlib's level 9. The result is standard raw deflate, so every CHD reader decodes it with zlib as before, and the CHD's checksums are the same. Only the compressed bytes differ, which is why it is opt-in.

Measured on 4 KiB DVD hunks and 18,816-byte CD hunks of a freely licensed corpus: 2.0 and 2.8 times faster than zlib's level 9, and 0.46% and 0.41% smaller.

Source: libdeflate v1.24, commit `96836d7d9d10e3e0d53e6edb54eb908514e336c4`, unmodified. Only what compression needs is kept: `libdeflate.h`, `common_defs.h`, and from `lib/` `deflate_compress.c`, `utils.c` and the headers they include (`x86/` and `arm/` only for their compile-time `matchfinder_impl.h` and `cpu_features.h`). Decompression still uses zlib. License: MIT ([`COPYING`](COPYING)).

The compressor's output depends only on its input and level, not on the CPU's features: the page's CHDs equal the native build's (`tests/ui/convert.spec.js`).
