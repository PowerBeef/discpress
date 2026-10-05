# Third-party notices

`dist/discpress.html` contains compiled code and data from the projects below. The code's source is in [`engine/`](engine/README.md) (chdman, the parts of MAME it uses and MAME's bundled libraries, with their license files); the game database is made by `scripts/update-db.sh`. The license texts are also shown in the app under Help → About and licenses.

| Component | License | Copyright |
|---|---|---|
| [MAME](https://github.com/mamedev/mame) 0.289: chdman, `src/lib/util`, `src/osd` (the parts used here) | BSD 3-Clause | Aaron Giles, R. Belmont, Vas Crabb and the MAMEdev team |
| zlib | zlib License | Jean-loup Gailly and Mark Adler |
| LZMA SDK | Public domain | Igor Pavlov |
| FLAC (libFLAC) | BSD 3-Clause | Josh Coalson, Xiph.Org Foundation |
| Zstandard | BSD 3-Clause | Meta Platforms, Inc. and affiliates |
| MD5 (`src/lib/util/md5.h`, libFLAC's `md5.c`) | Public domain | Colin Plumb |
| [Arm optimized-routines](https://github.com/ARM-software/optimized-routines): `cosf` and `log` for libFLAC ([`engine/libm`](engine/libm/README.md)) | MIT (chosen from MIT OR Apache-2.0 WITH LLVM-exception) | Arm Limited |
| [libdeflate](https://github.com/ebiggers/libdeflate) v1.24: its compressor, for `--libdeflate` ([`engine/libdeflate`](engine/libdeflate/README.md)) | MIT | Eric Biggers, Google LLC |
| [Emscripten](https://emscripten.org) 6.0.10's runtime: the JavaScript glue, and the C and C++ libraries compiled into the WebAssembly (musl libc, LLVM's libc++, libc++abi and compiler-rt) | Emscripten: MIT (or University of Illinois/NCSA); musl: MIT; LLVM's libraries: Apache-2.0 WITH LLVM-exception | The Emscripten authors; Rich Felker and musl's contributors; the LLVM project's contributors |
| [libretro-database](https://github.com/libretro/libretro-database) Redump DATs (`db/db.json.gz`: game names, serials, sizes, CRC-32) | See libretro-database; data from [Redump](http://redump.org) | libretro and Redump contributors |
| The serials of LibCrypt-protected PAL PlayStation games (`db/facts/libcrypt.tsv`), from [psxdatacenter](https://psxdatacenter.com)'s SBI list | A list of facts, with its source on each line | |

Some of the page's disc detection rules (Video CD, Neo Geo CD, CDTV and video discs) follow those of [MPF](https://github.com/SabreTools/MPF), the Media Preservation Frontend (MIT, © Matt Nadareski). No code was copied: they are written anew in `app/ident.js`.

MAME as a whole is licensed under GPL-2.0-or-later. Only BSD-licensed parts of MAME (and the public-domain `md5.h`) are in `engine/` and compiled into Discpress. Every change made to them is in [`engine/mame-0.289.diff`](engine/mame-0.289.diff).
