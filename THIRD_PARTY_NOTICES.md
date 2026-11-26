# Third-party notices

`dist/discpress.html` contains compiled code and data from the projects below. The compiled C/C++ source lives in three places: [`engine/mame/`](engine/README.md) (chdman, the parts of MAME it uses, and MAME's bundled libraries, with their license files), external libraries outside `engine/mame/` ([`engine/libdeflate/`](engine/libdeflate/README.md) and [`engine/libm/`](engine/libm/README.md)), and vendored browser audio decoders in `wasm/` (`wasm/stb_vorbis.c`, `wasm/minimp3.h`, `wasm/minimp3_ex.h`). The game database is made by `scripts/update-db.sh`. The license texts are also shown in the app under Help → About and licenses.

| Component | License | Copyright |
|---|---|---|
| [MAME](https://github.com/mamedev/mame) 0.289: chdman, `src/lib/util`, `src/osd` (the parts used here) | BSD 3-Clause | Aaron Giles, R. Belmont, Vas Crabb, Olivier Galibert, Nathan Woods, Mietek Bak and the MAMEdev team |
| zlib 1.3.2 | zlib License | Jean-loup Gailly and Mark Adler (1995–2026) |
| LZMA SDK 23.01 (LZMA/LZMA2/7z archive decoder & filters, including PPMd7) | Public domain | Igor Pavlov; Dmitry Shkarin (PPMd var.H) |
| FLAC 1.4.3 (libFLAC) | BSD 3-Clause | Josh Coalson (2000–2009), Xiph.Org Foundation (2011–2023) |
| Zstandard 1.5.5 | BSD 3-Clause | Meta Platforms, Inc. and affiliates; Tino Reichardt (2016) |
| MD5 (`src/lib/util/md5.h`, libFLAC's `md5.c`) | Public domain | Colin Plumb |
| [Arm optimized-routines](https://github.com/ARM-software/optimized-routines): `cosf` and `log` for libFLAC ([`engine/libm`](engine/libm/README.md)) | MIT (chosen from MIT OR Apache-2.0 WITH LLVM-exception) | Arm Limited (1999–2024) |
| [libdeflate](https://github.com/ebiggers/libdeflate) v1.24: its compressor, for `--libdeflate`, `--ultra`, `cdfl` subcode, and CSO v1/v2 ([`engine/libdeflate`](engine/libdeflate/README.md)) | MIT | Eric Biggers (2016), Google LLC (2024) |
| [stb_vorbis](https://github.com/nothings/stb) v1.25: Ogg Vorbis audio track decoder (`wasm/stb_vorbis.c`) | Public domain (Unlicense, chosen from Unlicense OR MIT) | Sean Barrett |
| [minimp3](https://github.com/lieff/minimp3): MP3 gapless audio track decoder (`wasm/minimp3.h`, `wasm/minimp3_ex.h`) | CC0-1.0 Public domain | lieff |
| [Emscripten](https://emscripten.org) 6.0.10's runtime: the JavaScript glue, and the C and C++ libraries compiled into the WebAssembly (musl libc, LLVM's libc++, libc++abi and compiler-rt) | Emscripten: MIT (or University of Illinois/NCSA); musl: MIT; LLVM's libraries: Apache-2.0 WITH LLVM-exception | The Emscripten authors; Rich Felker and musl's contributors; the LLVM project's contributors |
| [libretro-database](https://github.com/libretro/libretro-database) Redump DATs (`db/db.json.gz`: game names, serials, sizes, CRC-32, multi-track digests) | See libretro-database; data from [Redump](https://redump.org) | libretro and Redump contributors |
| Per-game hardware facts (`db/facts/libcrypt.tsv`, `db/facts/saturn-cart.tsv`): PAL PS1 LibCrypt serials ([psxdatacenter](https://psxdatacenter.com)) and Sega Saturn mandatory RAM/ROM/MPEG cartridges | Lists of facts, with sources on each line | |

Some of the page's disc detection rules (Video CD, Neo Geo CD, CDTV and video discs) follow those of [MPF](https://github.com/SabreTools/MPF), the Media Preservation Frontend (MIT, © Matt Nadareski). No code was copied: they are written anew in `app/ident.js`.

MAME as a whole is licensed under GPL-2.0-or-later. Only BSD-licensed parts of MAME (and the public-domain `md5.h`), together with the permissively licensed libraries MAME bundles (the table above), are in `engine/mame/` and compiled into Discpress; every change made to `engine/mame/` is recorded in [`engine/mame-0.289.diff`](engine/mame-0.289.diff). Outside `engine/mame/`, [`engine/libdeflate/`](engine/libdeflate/README.md) and [`engine/libm/`](engine/libm/README.md) carry documented WebAssembly adaptations under their MIT licenses, and `wasm/` vendors `stb_vorbis.c` (Public domain / Unlicense) and `minimp3.h` / `minimp3_ex.h` (CC0-1.0 Public domain). `scripts/check-licenses.sh` verifies both `engine/` and `wasm/`.
