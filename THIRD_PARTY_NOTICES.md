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
| [libretro-database](https://github.com/libretro/libretro-database) Redump DATs (`db/db.json.gz`: game names, serials, sizes, CRC-32) | See libretro-database; data from [Redump](http://redump.org) | libretro and Redump contributors |

MAME as a whole is licensed under GPL-2.0-or-later. Only BSD-licensed parts of MAME (and the public-domain `md5.h`) are in `engine/` and compiled into Discpress. Every change made to them is in [`engine/mame-0.289.diff`](engine/mame-0.289.diff).
