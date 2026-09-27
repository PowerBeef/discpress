# Third-party notices

`dist/discpress.html` contains compiled code and data from the projects below. Their source is fetched by `scripts/fetch-mame.sh` (MAME and its bundled libraries) and `scripts/update-db.sh` (game database). The full license texts are also shown in the app under Help → About and licenses.

| Component | License | Copyright |
|---|---|---|
| [MAME](https://github.com/mamedev/mame) 0.289: chdman, `src/lib/util`, `src/osd` (the parts used here) | BSD 3-Clause | Aaron Giles, R. Belmont, Vas Crabb and the MAMEdev team |
| zlib | zlib License | Jean-loup Gailly and Mark Adler |
| LZMA SDK | Public domain | Igor Pavlov |
| FLAC (libFLAC) | BSD 3-Clause | Josh Coalson, Xiph.Org Foundation |
| Zstandard | BSD 3-Clause | Meta Platforms, Inc. and affiliates |
| utf8proc | MIT | Steven G. Johnson, Jiahao Chen, Tony Kelman, Jonas Fonseca and contributors |
| Expat | MIT | Thai Open Source Software Center Ltd, Clark Cooper and the Expat maintainers |
| AES-256-CBC (`3rdparty/aes256cbc`) | MIT | Hallo Weeks |
| NanoSVG | zlib License | Mikko Mononen |
| MD5 (`src/lib/util/md5.cpp`) | Public domain | Colin Plumb |
| path_to_regex (`src/lib/util/path_to_regex.cpp`) | MIT | Alfred Bratterud |
| [libretro-database](https://github.com/libretro/libretro-database) Redump DATs (`db/db.json.gz`: game names, serials, sizes, CRC-32) | See libretro-database; data from [Redump](http://redump.org) | libretro and Redump contributors |

MAME as a whole is licensed under GPL-2.0-or-later. Only the BSD-licensed parts of MAME listed above (plus the permissively licensed files noted) are compiled into Discpress. The changes made to MAME for the browser build are in [`wasm/mame.patch`](wasm/mame.patch).
