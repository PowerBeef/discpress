# Lane A: the CHD container format, its codecs, and encoder freedom

> Part of the [Discpress chdman research dossier](README.md), 2026-09-27. Written by a research agent from source reading and experiments. `$SP/...` paths name artefacts in the temporary research workspace, which is not part of the repository (reproducible lab tooling is in [lab/](lab/)). Lane letters (A, B, C, D1, D2, E, G) refer to the reports listed in the README.

Research dossier for a Discpress hard fork of MAME `chdman`. It covers the byte formats, every codec, and the
encoder-side choices that existing decoders tolerate. Every conclusion marked **[tested]** was checked by building
CHD files and decoding them with the real decoders listed in §1.3; the rest comes from reading source code, with a
citation. Anything that is neither is marked **[unverified]**.

---

## 0. Key findings

1. **The format is far more permissive than chdman's output.** Three independent decoders (MAME's `chd_file`,
   libchdr, chd-rs) all re-derive codec parameters from the hunk size instead of reading them from the file, so the
   encoder is free to use any LZMA1 encoder with lc=3/lp=0/pb=2, any raw-deflate encoder, any zstd level or strategy
   without a dictionary, any valid Huffman tree, and any FLAC encoder that stays inside a few limits. **[tested]**
2. **Hunk size is the biggest compatible lever.** On a binaries proxy corpus, LZMA hunks of 64 KiB instead of 4 KiB
   are about 19% smaller, while tuning LZMA itself (level 9, fb=273) gains under 0.1%. Every decoder tested accepts
   non-default hunk sizes (1, 16, 26 and 27 CD frames; 2 KiB, 64 KiB and 1 MiB DVD hunks). **[tested]** Whether
   emulators cope with the random-access cost of large hunks belongs to lane D.
3. **Deflate can shrink by 1.3–3.8% with libdeflate level 12 or zopfli**, and these streams decode everywhere,
   including the subcode stream of every CD codec. **[tested]**
4. **FLAC is the codec with real traps.** The frame block size must not exceed the block size the decoder
   synthesizes, which is exact in libchdr since 2026-09-10. Frames smaller than that need variable-blocksize
   numbering, or MAME's libFLAC 1.4.3 inserts silence. Partition order must be ≤8 (dr_flac), the bits-per-sample code
   must be explicit (claxon/chd-rs), and the sample count must be exact (chd-rs). Within those limits, variable block
   sizes and LPC order up to 32 decode everywhere. **[tested]**
5. **Container constraints are strict.**
   - Compressed and NONE hunks must be stored contiguously in hunk order: their offsets are implicit, and the map
     CRC catches any gap.
   - A compressed length must be ≤ hunkbytes: libchdr rejects more, older libchdr corrupts its heap, and MAME
     silently overflows a buffer.
   - Map bit fields must be ≤25 bits wide because of libchdr's bitstream.
   - A codec tag must never appear twice in `compressors[]`: every libchdr before 2024-10-25 crashes with a double
     free.
   - Every listed codec must be able to initialize at the hunk size.

   **[tested]**
6. **Compatibility horizon for codecs:**
   - `zstd`/`cdzs`: MAME 0.262 (2024-01-31) and libchdr d6f59e7, merged 2024-01-31.
   - `huff`: libchdr 2022-12-29.
   - Non-CD `lzma`/`flac`: libchdr 2022-03-26.
   - `avhu`: libchdr 2026-04-24.

   A libchdr from 2022-08 **segfaults** on any codec it does not know (huff, zstd, cdzs). **[tested]**
7. **Reproducibility across library versions:**
   - Discpress builds from post-0.289 master (`mame0289-1167`), which ships LZMA SDK 26.02 and zstd 1.5.7. The
     actual 0.289 release shipped LZMA 23.01 and zstd 1.5.5.
   - LZMA 23.01 and 26.02 produce identical streams on 22,760 test hunks. **[tested]**
   - zstd 1.5.5 and 1.5.7 level-22 frames differ for about 12% of hunks **[tested]**, so `-c zstd`/`cdzs` output is
     *not* byte-identical to the chdman 0.289 release. Default codecs are unaffected.
   - The tree also contains post-0.289 CHD changes: the CHSE session metadata tag, which changes the overall SHA1
     of multi-session discs, and CD+G cue parsing. This is cross-cutting for lanes B and E.
8. **Robustness:**
   - All three decoders crash (stack overflow) on a SELF→self map cycle. **[tested]**
   - MAME's `chdman verify` hangs forever on a malformed FLAC hunk. **[tested]**
   - MAME has unbounded writes in its Huffman tree import and lookup-table build (from the code).

---

## 1. Sources, versions and method

### 1.1 Code examined

| Component | Version / commit | Notes |
|---|---|---|
| MAME | `76c7d197ed` = `mame0289-1167`, 2026-09-27 | Pristine files extracted with `git show`; the working tree carries `wasm/mame.patch`. All `path:line` citations refer to the pristine files. |
| MAME release 0.289 | tag `mame0289` = `f34f02505e`, 2026-07-30 | Used for the library-version comparison. |
| libchdr | `rtissera/libchdr@607694c`, 2026-09-27 (HEAD) | Full history was cloned. Worktrees were built at `647f42b` (2024-02-11), `44c91c9` (2022-08-17), `098e147` (2022-01-04) and `513aebf` (2020-12-25). |
| chd-rs | `SnowflakePowered/chd-rs@f6cdb77`, 2026-06-29 | Built with its default features: flate2/zlib-rs, lzma-rs-perf-exp 0.2.1, claxon 0.4.3, ruzstd 0.8.3. `verify_block_crc` is **off**. |
| dr_flac | 0.13.4, bundled in libchdr HEAD | Older libchdr snapshots bundle 0.12.28–0.12.42; see §10. |
| micro-flac | esphome-libs/micro-flac | Optional libchdr FLAC backend since 2026-09-06, the default only on MCU targets. Read from the wrapper only; its own source was not examined. **[partly unverified]** |

### 1.2 Third-party codec libraries bundled with MAME

| Library | At 76c7d19 | At the mame0289 release | Evidence |
|---|---|---|---|
| zlib | 1.3.2 | 1.3.2 | `3rdparty/zlib/zlib.h:44` |
| LZMA SDK | 26.02 (2026-06-25) | 23.01 | `3rdparty/lzma/C/7zVersion.h:4`. The update was `c23567b509` on 2026-08-04, after 0.289. |
| zstd | 1.5.7 | 1.5.5 | `3rdparty/zstd/lib/zstd.h:112-114`. The update was `f9050e8508` on 2026-08-05, after 0.289. |
| FLAC | 1.4.3 | 1.4.3 | `3rdparty/flac/CMakeLists.txt:11` |

The Discpress wasm build compiles LZMA with `-DZ7_ST`, single-threaded (`wasm/Makefile:24`).

### 1.3 Tools built for this lane

All tools live in `$SP/tools`; artefacts are in `$SP/expA`.

- **`chdlib.py`** is an independent Python CHD V5 reader and writer written from the code reading.
  - It decodes every chdman test file bit-exactly: zlib, lzma, huff, flac, zstd, cdlz, cdzl, cdzs and cdfl, with ECC
    regeneration.
  - Given chdman's own payloads, it **rewrites chdman files byte-for-byte**. This confirms the header, metadata
    placement, map encoding (including MAME's Huffman tree builder) and SHA1 rules.
- **`flacenc.py`** is a minimal FLAC frame encoder, used to probe FLAC decoder tolerance.
- **`lzmasdk/lzma_hunks`** is a per-hunk LZMA SDK encoder built from MAME's 26.02 sources.
  **`lzma2301/lzma_hunks`** is the same tool built from the 23.01 sources of the mame0289 tag.
- **`chdr_dump`** decodes a CHD with libchdr HEAD. **`chdr_dump_<commit>`** does the same with old snapshots.
  **`chdrs_dump`** does it with chd-rs.
- **`exp*.py`** are the experiment drivers. Each crafted CHD is checked three ways:
  - `chdman verify`, which uses MAME's decoder and checks both the raw and overall SHA1;
  - libchdr (HEAD and old), comparing the decoded bytes' SHA1;
  - chd-rs, comparing the decoded bytes' SHA1.
- Fixtures are Discpress's synthetic ones. Compression-size numbers from them are **not representative**. §9.3 uses
  a binaries corpus as a rough proxy.

---

## 2. Headers (V1–V5)

All multi-byte fields are big-endian. Every version starts with the tag `MComprHD` (8 bytes), then `length` (u32,
the header size) and `version` (u32). Source: `src/lib/util/chd.h:34-187` and
`rtissera/libchdr@607694c:include/libchdr/chd.h:60-140`.

### 2.1 V1 (76 bytes) and V2 (80 bytes)

| Off | Size | Field | Meaning |
|---|---|---|---|
| 0 | 8 | tag | `MComprHD` |
| 8 | 4 | length | 76 (V1) or 80 (V2) |
| 12 | 4 | version | 1 or 2 |
| 16 | 4 | flags | 0x1 = has parent, 0x2 = allows writes |
| 20 | 4 | compression | 0 = none, 1 = zlib |
| 24 | 4 | hunksize | Sectors per hunk. V1 sectors are 512 bytes; V2 uses `seclen`. |
| 28 | 4 | totalhunks | |
| 32 | 12 | cylinders, heads, sectors | Hard-disk geometry. `logicalbytes = C × H × S × seclen`. |
| 44 | 16 | md5 | MD5 of the raw data |
| 60 | 16 | parentmd5 | |
| 76 | 4 | seclen (V2 only) | Bytes per sector |

`hunkbytes = hunksize × 512` (V1) or `hunksize × seclen` (V2). libchdr rejects zero or a u32 overflow here
(`libchdr_chd.c` `header_read`, around lines 2843-2859).

### 2.2 V3 (120 bytes)

| Off | Size | Field |
|---|---|---|
| 16 | 4 | flags (as V1) |
| 20 | 4 | compression: 0 none, 1 zlib, 2 zlib+ (decoded as zlib), 3 AV (avhuff) |
| 24 | 4 | totalhunks |
| 28 | 8 | logicalbytes |
| 36 | 8 | metaoffset |
| 44 | 16 | md5 |
| 60 | 16 | parentmd5 |
| 76 | 4 | hunkbytes |
| 80 | 20 | sha1 (SHA1 of the raw data in V3) |
| 100 | 20 | parentsha1 |

### 2.3 V4 (108 bytes)

| Off | Size | Field |
|---|---|---|
| 16 | 4 | flags |
| 20 | 4 | compression (0..3 as in V3) |
| 24 | 4 | totalhunks |
| 28 | 8 | logicalbytes |
| 36 | 8 | metaoffset |
| 44 | 4 | hunkbytes |
| 48 | 20 | sha1: overall, raw plus metadata |
| 68 | 20 | parentsha1: the parent's overall SHA1 |
| 88 | 20 | rawsha1 |

MAME's parsers are `parse_v3_header` at `chd.cpp:2034-2079` and `parse_v4_header` at `chd.cpp:2097-2142`. Neither
version has `unitbytes`, which is guessed from metadata by `guess_unitbytes` (`chd.cpp:1998-2016`):
- the BPS value of GDDD for hard disks;
- 2448 if any CD or GD tag exists;
- otherwise hunkbytes.

libchdr does the same (`header_guess_unitbytes`, `libchdr_chd.c:2762-2782`).

### 2.4 V5 (124 bytes), the only version MAME writes

| Off | Size | Field | Notes |
|---|---|---|---|
| 0 | 8 | tag | |
| 8 | 4 | length = 124 | MAME and libchdr both reject any other value (`chd.cpp:2160`; `libchdr_chd.c:2828`). |
| 12 | 4 | version = 5 | |
| 16 | 16 | compressors[4] | FourCC codec tags. 0 means none. `compressors[0]==0` means the whole CHD is uncompressed. |
| 32 | 8 | logicalbytes | |
| 40 | 8 | mapoffset | |
| 48 | 8 | metaoffset | 0 means no metadata. |
| 56 | 4 | hunkbytes | Must be non-zero (`chd.cpp:2171`). The header comment says "512k maximum", but chdman allows 16 B–1 MiB. |
| 60 | 4 | unitbytes | Must be non-zero. MAME's create requires `hunkbytes % unitbytes == 0` (`chd.cpp:2587`). |
| 64 | 20 | rawsha1 | |
| 84 | 20 | sha1 | overall |
| 104 | 20 | parentsha1 | All zeros means no parent. |

Derived values: `hunkcount = ceil(logicalbytes / hunkbytes)` (u32) and
`unitcount = ceil(logicalbytes / unitbytes)` (`chd.cpp:2174-2175`). V5 has no flags field: a parent exists if
`parentsha1 != 0`, and the file is writable only if it is uncompressed.

### 2.5 Which versions each implementation reads and writes

| | Reads | Writes |
|---|---|---|
| MAME `chd_file` | V3, V4, V5 only (`chd.cpp:2715-2721`); V1/V2 give `UNSUPPORTED_VERSION` | V5 only (`chd.cpp:2579`, `create_common`). V3/V4 open read-only (`chd.cpp:2724`). |
| libchdr | V1–V5 (`header_read`, `libchdr_chd.c:2788-3005`) | none |
| chd-rs | V1–V5 (`chd-rs/src/header.rs:3`) | none |

The V1–V4 codecs are zlib, zlib+ and AV. libchdr has read V3/V4 AV since 2026-04-24. In V1–V4, libchdr rejects
undefined flag bits (`CHDFLAGS_UNDEFINED`) and hunkbytes ≥ 16 MiB (`libchdr_chd.c:2951`).

---

## 3. Map formats

### 3.1 V1/V2 map

The map starts right after the header and uses 8-byte entries:

```
entry     = be64
offset    = entry & ((1<<44)-1)            // file offset, 44 bits
length    = entry >> 44                    // 20 bits
type      = (length == hunkbytes) ? UNCOMPRESSED : COMPRESSED(zlib)
crc       = none                           // V1/V2 carry no per-hunk CRC, only the MD5 of the whole image
```

After `totalhunks` entries comes an end cookie. libchdr compares `entrysize` bytes against `"EndOfListCookie"`,
which is the first 8 bytes for V1/V2 (`libchdr_chd.c:1935-1946` and `:3556`).

### 3.2 V3/V4 map

The map starts right after the header (V3 at 120, V4 at 108) and uses 16-byte entries (`chd.h:112-116`):

```
[0]  be64 offset
[8]  be32 crc32          // zlib CRC-32 of the decompressed hunk
[12] be16 length_lo
[14] u8   length_hi      // length = length_lo | length_hi<<16  (24 bits)
[15] u8   flags          // type = flags & 0x0F ; 0x10 = NO_CRC
type 1 COMPRESSED        : read length bytes at offset, decode with header codec
     2 UNCOMPRESSED      : read hunkbytes at offset
     3 MINI              : offset field holds 8 data bytes (big-endian), repeated to fill the hunk
     4 SELF_HUNK         : same as hunk number <offset>
     5 PARENT_HUNK       : same as parent hunk number <offset>
     6 2ND_COMPRESSED    : "secondary codec" – unsupported (MAME returns INVALID_DATA; chd-rs UnsupportedFormat)
```

The map is followed by the 16-byte cookie `"EndOfListCookie\0"`. libchdr checks it, and checks that the largest
end offset fits in the file (`libchdr_chd.c:3548-3561`). MAME checks neither. MAME's decoder is at
`chd.cpp:1140-1188`, with the CRC-32 check at `:1156`.

### 3.3 V5 uncompressed map (`compressors[0] == 0`)

This map has one `be32` per hunk at `mapoffset`, which is 124: MAME writes it straight after the header
(`chd.cpp:2615`, `2637-2651`).

```
e = be32(map[h])
if e != 0:  data = file[e*hunkbytes : e*hunkbytes+hunkbytes]     // hunk data is hunk-aligned in the file
elif parent: data = parent.read_hunk(h)                           // same hunk index in the parent
else:        data = zeros
```

The writer appends data aligned to hunkbytes (`file_append(..., m_hunkbytes)`, `chd.cpp:1327`). An all-zero write
to an unallocated hunk is skipped (`chd.cpp:1314-1321`); with a parent, the hunk would then read back from the
parent. That is a latent MAME bug for uncompressed diff CHDs (lanes B and D, low relevance).

### 3.4 V5 compressed map

**On-disk layout** (`chd.h:171-187`, written at `chd.cpp:2397-2414`):

```
[mapoffset+0 ]  be32  mapbytes     // length of the bitstream that follows (not counting this header)
[mapoffset+4 ]  be48  firstoffs    // "datastart": file offset of the first TYPE_0-3/NONE hunk (0 if none)
[mapoffset+10]  be16  mapcrc       // CRC-16/CCITT-FALSE of the *expanded* map (hunkcount × 12 bytes)
[mapoffset+12]  u8    lengthbits   // width of compressed-length fields
[mapoffset+13]  u8    selfbits     // width of explicit self-reference fields
[mapoffset+14]  u8    parentbits   // width of explicit parent-unit fields
[mapoffset+15]  u8    reserved = 0
[mapoffset+16]  bitstream, MSB-first, mapbytes long (padded with zero bits to a byte)
```

**Expanded 12-byte entry.** This is what the CRC covers (`chd.h:182-187`):
`u8 type | be24 length | be48 offset | be16 crc16`.

**Symbols.** `COMPRESSION_*` at `chd.cpp:64-97`:

| Value | Name | Meaning |
|---|---|---|
| 0–3 | TYPE_0..3 | Compressed with `compressors[n]`. |
| 4 | NONE | Stored raw; length = hunkbytes. |
| 5 | SELF | Explicit reference to another hunk (hunk index). |
| 6 | PARENT | Explicit parent reference (unit index). |
| 7 | RLE_SMALL | The following symbol n means "repeat the last token 2+n more times". |
| 8 | RLE_LARGE | The following 2 symbols (hi, lo nibbles) mean "repeat 2+16+(hi<<4)+lo more times". |
| 9 | SELF_0 | Same target as the previous SELF. |
| 10 | SELF_1 | Previous SELF target + 1. |
| 11 | PARENT_SELF | Parent unit = h × hunkbytes / unitbytes (the same position in the parent). |
| 12 | PARENT_0 | Same as the previous PARENT. |
| 13 | PARENT_1 | Previous PARENT + hunkbytes/unitbytes. |

**Decoding pseudocode.** Equivalent to `decompress_v5_map` (`chd.cpp:2437-2555`) and libchdr
(`libchdr_chd.c:1100-1326`):

```
hdr   = read(mapoffset, 16); parse fields above
bits  = MSBFirstBitReader(read(mapoffset+16, mapbytes))      // reading past the end yields zeros

# (a) Huffman tree for a 16-symbol alphabet, max code length 8, "RLE tree" encoding with 4-bit fields
lengths = []
while len(lengths) < 16:
    v = bits.read(4)
    if v != 1: lengths.append(v)
    else:
        v = bits.read(4)
        if v == 1: lengths.append(1)                   # "1 1" encodes a literal length 1
        else:      lengths += [v] * (bits.read(4) + 3) # "1 v n" encodes (n+3) copies of v
codes = canonical_codes(lengths, maxbits=8)            # see §7.5 for the (unusual) canonical rule

# (b) pass 1: one token per hunk, with RLE
last = 0; rep = 0
for h in range(hunkcount):
    if rep: type[h] = last; rep -= 1; continue
    s = huff_decode(bits)                               # peek 8 bits, table lookup, consume code length
    if   s == 7: type[h] = last; rep = 2 + huff_decode(bits)
    elif s == 8: type[h] = last; rep = 2 + 16 + (huff_decode(bits) << 4) + huff_decode(bits)
    else:        type[h] = last = s                      # last may be a pseudo-type (9..13)

# (c) pass 2: per-hunk fields, same bitstream, no alignment
cur = firstoffs; last_self = 0; last_parent = 0
for h in range(hunkcount):
    t = type[h]; off = cur; length = 0; crc = 0
    if   t in 0..3: length = bits.read(lengthbits); crc = bits.read(16); cur += length
    elif t == 4:    length = hunkbytes;             crc = bits.read(16); cur += hunkbytes
    elif t == 5:    off = last_self = bits.read(selfbits)
    elif t == 6:    off = last_parent = bits.read(parentbits)
    elif t == 10:   last_self += 1; t = 5; off = last_self
    elif t == 9:    t = 5; off = last_self
    elif t == 11:   t = 6; off = last_parent = h*hunkbytes // unitbytes
    elif t == 13:   last_parent += hunkbytes // unitbytes; t = 6; off = last_parent
    elif t == 12:   t = 6; off = last_parent
    entry[h] = (t, length, off, crc)                    # SELF/PARENT: length 0, crc 0
require crc16_ccitt_false(b''.join(pack('>B', t) + be24(length) + be48(off) + be16(crc))) == mapcrc
```

Two consequences of this scheme matter most:

- **An RLE run repeats the last *token*, which can be a pseudo-type.** A run of `SELF_1` therefore walks
  consecutive targets, and a run of `PARENT_1` walks the parent sequentially. Deduplicated or parent-derived
  regions cost a few bits for an entire run.
- **Offsets of TYPE and NONE hunks are implicit:** `firstoffs` plus the running sum of lengths. Compressed and raw
  hunks must therefore lie contiguously, in hunk order, from `firstoffs`. Because the CRC covers the reconstructed
  offsets, a gap anywhere fails the map CRC in every decoder **[tested G2_16B_gap]**. SELF and PARENT hunks take no
  file space.

**Encoding pseudocode.** `compress_v5_map` (`chd.cpp:2212-2424`), reproduced byte-for-byte by `chdlib.py`:

```
mapcrc = crc16(raw 12-byte entries, with real offsets)
for h: promote SELF/PARENT to pseudo-types exactly as the decoder undoes them
       (SELF: ref==last_self→9, ref==last_self+1→10, else 5 and max_self=max(ref); last_self=ref)
       (PARENT: ref==h*hb/ub→11, ref==last_parent→12, ref==last_parent+hb/ub→13, else 6 and max_parent; last_parent=ref)
       otherwise max_complen = max(max_complen, length)      # NONE counts as hunkbytes
RLE over the token stream, initial "last" = 0:
       run of the same token after its first occurrence: count<3 → literal copies;
       3..18 → [7, count-3]; 19..274 → [8, (c-19)>>4, (c-19)&15], repeated for longer runs
Huffman: histogram of the whole RLE stream (including the count nibbles, which are coded with the SAME 16-symbol tree),
         MAME builds the tree with compute_tree_from_histo (§7.5), exported with export_tree_rle
lengthbits = bit_width(max_complen); selfbits = bit_width(max explicit self); parentbits = bit_width(max explicit parent)
emit tree, all tokens, then pass-2 fields; flush; header as above; append the map at the end of the file
```

**Limits.**

| Quantity | Format limit | Practical limit | Source |
|---|---|---|---|
| hunkcount | u32 | MAME computes `m_hunkcount*12` in 32 bits, which overflows beyond 357,913,941 hunks. libchdr caps the materialized map at 256 MiB, about 22.37 M hunks: roughly 91 GB at 4 KiB hunks or 438 GB at CD geometry. | `chd.cpp:2217,2780`; `libchdr_chd.c:113,864-884` |
| compressed length | 24 bits in the expanded entry | **≤ hunkbytes** (see §4.4) | `chd.cpp:2793`; `libchdr_chd.c:3024` |
| file offsets | 48 bits (256 TiB) | | `chd.h:186` |
| lengthbits/selfbits/parentbits | stored as u8; MAME writes the bit width of the maximum value | **≤25** for libchdr (all versions); ≤31 for MAME, since `bitstream_in::remove(32)` is an undefined shift; ≤32 for chd-rs **[tested G3, O_map]** | `libchdr_bitstream.c:52`; `bitstream.h:147-151` |
| explicit self target | selfbits | < 2^25 hunks for libchdr | derived |
| explicit parent unit | parentbits | < 2^25 units: 68.7 GB at 2048-byte units, 17 GB at 512-byte units (large HDD parents) | derived |
| mapbytes | u32 | | |
| hunkbytes | u32 | chdman: 16 B–1 MiB (`chdman.cpp:63-64`). libchdr: < 128 MiB (`libchdr_chd.c:100,2976`). | |
| logical size | u64 | libchdr: `hunkbytes × hunks` < 1 TiB since 2026-04-24; **< about 10 GB between 2024-10-25 (`b2e05f5`) and 2026-04-24 (`71b898f`)** | `libchdr_chd.c:109` |
| sparse maps | | libchdr from 2026-04-24 (`5cc52fd`) to 2026-09-10 (`d31d8b9`) rejected files where totalhunks > 8 × file_size, i.e. very sparse images | libchdr log |

Before MAME 0.263 (`0b15781e69`, 2024-02-24), `bitstream_in`/`bitstream_out` held only 25–32 bits and silently
dropped bits for fields wider than 25. Old chdman could therefore write corrupt maps for huge images; the map CRC
would catch this.

---

## 4. Hunk types, integrity, and references

### 4.1 V5 hunk types

These are the semantics MAME's `read_hunk` implements (`chd.cpp:1191-1255`).

| Type | Read | Integrity |
|---|---|---|
| TYPE_0..3 | Read `length` bytes at `offset` into a hunkbytes-sized buffer and call `compressors[type].decompress(src, length, dest, hunkbytes)`. | CRC16 of the decompressed hunk must equal the entry's CRC (`chd.cpp:1227-1231`). The alternative "CRC over compressed data" branch applies only to lossy codecs, and none exist: every codec entry has `lossy=false` (`chdcodec.cpp:535-548`). |
| NONE | Read hunkbytes at `offset`. | CRC16 of the data (`chd.cpp:1235-1243`). |
| SELF | `read_hunk(offset)`, where offset is the target hunk. | No CRC of its own; relies on the target hunk's check. |
| PARENT | `parent.read_bytes(offset × parent.unitbytes, dest, hunkbytes)` | No CRC (`chd.cpp:1248-1251`); the raw SHA1 in verify covers it. |

Pseudo-types 7–13 exist only in the on-disk map. `hunk_info` reports SELF, PARENT and MINI as the pseudo-codecs
1/2/3 (`chd.h:197-199`, `chd.cpp:419-519`).

### 4.2 Per-hunk checks

- **V5:** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection) of the full decompressed hunk, including
  zero padding in the last partial hunk (`hashing.h:214,226`; `hashing.cpp:397-401`). The padding bytes are
  arbitrary as long as the CRC matches them: a non-zero pad decodes everywhere **[tested
  G2_last_hunk_padding_nonzero]**.
- **V3/V4:** zlib CRC-32 of the decompressed hunk unless flag 0x10 is set (`chd.cpp:1156,1166,1175`). libchdr
  checks it only since `b1246d3` (2026-09-09). chd-rs checks it only with the `verify_block_crc` feature.
- **libchdr:** the checks are compiled under `VERIFY_BLOCK_CRC`, default 1 (`include/libchdr/chdconfig.h`).
  Embedders can turn them off.

### 4.3 Resolving references

- **SELF.**
  - MAME's encoder only references earlier hunks (`otherhunk < hunknum`, `chd.cpp:2893`).
  - Decoders accept forward references and chains **[tested G_forward_self_refs_and_chains]**.
  - **No decoder detects cycles**: a SELF→self entry crashes MAME, libchdr and chd-rs with a stack overflow
    **[tested R_self_loop]**.
  - libchdr keeps a small decoded-hunk cache for SELF targets (`selfcache`, 64 KiB by default).
- **PARENT.**
  - The map value is a **unit** index in the parent (V5). chdman hashes the parent at every unit offset, not only at
    hunk boundaries (`chd.cpp:3210-3222,3334-3346`), so parent matches can start at any unit.
  - libchdr (`libchdr_chd.c:3444-3480`) and chd-rs (`chdfile.rs:300-340`) handle unaligned units by reading two
    parent hunks **[tested child_shift]**.
  - Both assume **parent hunk size == child hunk size**: they index parent hunks with the child's units-per-hunk,
    and libchdr stores that value in a `uint8_t`. A child with hunkbytes ≠ parent hunkbytes decodes correctly only
    in MAME, which uses `read_bytes`. libchdr returned wrong data silently; chd-rs failed **[tested P_child_hunk8192,
    P_child_hunk2048]**. chdman always makes the child's hunk size equal to the parent's (`chdman.cpp:1343-1354`).
- **Parent identity.**
  - V4/V5: the child's `parentsha1` must equal the parent's **overall** SHA1 (`chd.cpp:2738`, compared against
    `m_parent->sha1()`; `create_common` writes `m_parent->sha1()` at `chd.cpp:2621`).
  - V3: flag bit 0 plus MD5/SHA1. libchdr compares MD5 and SHA1 when non-zero (`libchdr_chd.c:2064-2078`).
- **Missing parent.**
  - MAME opens the child with `m_parent_missing` set, and PARENT reads fail with `REQUIRES_PARENT`.
  - libchdr fails `chd_open` with `REQUIRES_PARENT`.
  - chd-rs opens and fails on read.
- **Other parent requirements.** MAME's create requires parent version ≥ 3 and `unitbytes == parent.unitbytes`
  (`chd.cpp:2583-2590`).

### 4.4 Buffer assumptions that bind encoders

- **MAME** reads compressed data into `m_compressed`, sized to hunkbytes (`chd.cpp:2793`), with `file_read(offset,
  m_compressed, blocklen)` (`:1222`). A length greater than hunkbytes is a **heap overflow**; it passed silently in
  testing (`G_complen_hunkbytes_plus16`).
- **libchdr HEAD** rejects `size > hunkbytes` (`libchdr_chd.c:3024`). **libchdr 2024-02 aborts with
  `free(): invalid pointer`**, because the check arrived only with the 2024-10-25 fix.
- **chd-rs** has no limit (`chdfile.rs:165`).
- **Rule:** compressed length ≤ hunkbytes. Equality is accepted everywhere **[tested]**; chdman only ever stores
  lengths < hunkbytes (`chdcodec.cpp:742,776`).

### 4.5 Role of `unitbytes`

- It is the sub-hunk granularity: CD frames (2448 = 2352 + 96), DVD sectors (2048), hard-disk sectors (BPS, 512 by
  default), a user value for raw images, or bytes per frame for laserdisc.
- It is the unit of parent references and of `read_units` (`chd.cpp:1368-1390`), and it sets chdman's parent-match
  granularity.
- For CD codecs the decoders check `hunkbytes % 2448 == 0`, not `unitbytes` (`chdcodec.cpp:348,417`; libchdr
  `cdzl/cdlz/cdzs/cdfl_codec_init`).
- Emulators may depend on `unitbytes`; that is lane D's question.

---

## 5. Metadata

### 5.1 Layout and chaining

Metadata entries form a singly linked list starting at `metaoffset`. Each entry is a 16-byte header followed by
its data (`chd.cpp:44`, write at `:1724-1732`, read at `:2945-2988`):

```
[0] be32 tag   [4] u8 flags   [5] be24 length   [8] be64 next (0 = end)   [16] data[length]
```

- `flags` bit 0 is `CHD_MDFLAGS_CHECKSUM`: the entry is included in the overall SHA1 (`chd.h:209`). The other bits
  are unused.
- Length is 1 ≤ len < 16 MiB (`chd.cpp:1675`). Text entries are written with a trailing NUL, so length is
  `strlen+1` (`chd.h:357`).
- Lookup finds the *n*-th entry with a given tag, in chain order (`metadata_find`). Order matters for CHSE (§5.3).
- chdman writes metadata straight after the header, before any hunk data. Hunks follow, and the map goes at the
  end: the observed `firstoffs` = 124 + Σ(16 + len).
- The chain may sit anywhere. Metadata after the hunk data decodes everywhere **[tested G_metadata_after_hunk_data,
  O_map_pm_tree_meta_last]**, as do a gap after the header and the map placed before the data **[tested]**.
- libchdr stops after 65,536 entries to defend against cycles (`libchdr_chd.c:3608-3619`). MAME has no such limit:
  a cyclic chain loops forever.

### 5.2 Which entries feed the overall SHA1

`compute_overall_sha1` (`chd.cpp:1839-1887`), for V4 and later:

```
items = sorted( be32(tag) || SHA1(data)  for each entry with flags & 1 )   # 24-byte records, memcmp order
overall = SHA1( rawsha1 || items[0] || items[1] || ... )
```

chdman writes every metadata entry with the checksum flag, except **AVLD**, which is written with flags 0
(`chdman.cpp:2425`), and `addmeta --nochecksum` entries (`chdman.cpp:3219-3221`).

### 5.3 Catalogue of metadata tags known to MAME at 76c7d19

| Tag | Content | Format | Written by / used for |
|---|---|---|---|
| `GDDD` | hard-disk geometry (text) | `"CYLS:%d,HEADS:%d,SECS:%d,BPS:%d"` (`chd.cpp:37`) | createhd, harddisk |
| `IDNT` | ATA IDENTIFY data (binary, 512 B) | binary | `createhd -ident` (`chdman.cpp:2149`) |
| `KEY ` | hard-disk key (binary) | binary | read by `harddisk.cpp:218` |
| `CIS ` | PCMCIA CIS (binary) | binary | `harddisk.cpp:210` |
| `CHCD` | legacy CD TOC (binary) | u32 numtrks + 99 × {trktype, subtype, datasize, subsize, frames, extraframes}; endianness is guessed | read only (`cdrom.cpp:1031-1073`) |
| `CHTR` | CD track (v1 text) | `"TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d"` (`chd.cpp:38`) | read only |
| `CHT2` | CD track (text) | `"TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d PREGAP:%d PGTYPE:%s PGSUB:%s POSTGAP:%d"` (`chd.cpp:39`). PGTYPE is prefixed with `V` when the pregap data is present in the image. | createcd |
| `CHSE` | **session** (text), new | `"SESSION:%d"` (`chd.cpp:40`) | Written only for multi-session discs, immediately before the first track of each session. It is parsed as applying only if the tag's absolute chain index is adjacent to the track's (`cdrom.cpp:934-941`). Added by `b93961fd52` (2026-08-15) and fixed by `20661546b2` (2026-08-26), **after 0.289**. Neither libchdr nor chd-rs defines it. |
| `CHGT` | legacy GD-ROM track | same text as CHGD; sets `CD_FLAG_GDROMLE` | read only (`cdrom.cpp:958-960`) |
| `CHGD` | GD-ROM track (text) | `"TRACK:%d TYPE:%s SUBTYPE:%s FRAMES:%d PAD:%d PREGAP:%d PGTYPE:%s PGSUB:%s POSTGAP:%d"` (`chd.cpp:41`) | createcd from .gdi |
| `DVD ` | DVD marker | empty string (1 byte, NUL) | createdvd (`chdman.cpp:2308`); DVD support dates from `28104cdbdf` (2023-04-09, MAME 0.254) |
| `AVAV` | A/V parameters (text) | `"FPS:%d.%06d WIDTH:%d HEIGHT:%d INTERLACED:%d CHANNELS:%d SAMPLERATE:%d"` (`chd.cpp:42`) | createld, avhuff setup |
| `AVLD` | laserdisc per-frame VBI (binary) | binary; **not checksummed** | createld |

There is **no CD+G tag**. The CD+G support added in `c9e87a6b7e` (2026-09-22, post-0.289) only teaches the
cue/toc parser a `CDG` track type (AUDIO, 2352 bytes, subtype RAW with 96 bytes). Track type and subtype strings
belong to lane C.

---

## 6. Hashes and verification

- **Raw SHA1** is the SHA1 of the `logicalbytes` bytes of image data, excluding hunk padding. The compressor
  accumulates it while reading (`chd.cpp:3478-3482`) and stores it at the end (`set_raw_sha1`, `:3281`). For V3 it
  lives in the `sha1` field; for V4/V5 in `rawsha1`.
- **Overall SHA1** is defined in §5.2. For V4/V5 it is refreshed on every metadata write (`metadata_update_hash`,
  `chd.cpp:3033-3050`) and after `set_raw_sha1`. It is kept only for compressed CHDs; uncompressed V5 files keep
  null SHA1s.
- **Parent SHA1** is the parent's *overall* SHA1 (§4.3).
- **`chdman verify`** (`chdman.cpp:1790-1874`):
  1. It rejects uncompressed CHDs and null SHA1s.
  2. It reads all data with `read_bytes`. That applies the CRC16 of every TYPE and NONE hunk and the V3/V4 CRC32;
     SELF and PARENT hunks are checked transitively.
  3. It compares the SHA1 of the data to the raw SHA1 (for V3, to `sha1`).
  4. For V4 and later it then recomputes the overall SHA1 from the *computed* raw SHA1 plus the metadata, and
     compares it to the header.
  5. `--fix` rewrites the header fields.
- **Per-hunk integrity in V5** is the CRC16 in the map entry, plus the map's own CRC16. Nothing else exists: no
  per-codec checksum and no zstd frame checksum. chdman disables the zstd checksum; FLAC's frame CRCs exist but
  libchdr skips dr_flac's CRC when `VERIFY_BLOCK_CRC` is set (`libchdr_flac.c:24-37`).

---

## 7. The codecs, precisely

Codec table at `chdcodec.cpp:532-549` (FourCCs at `chdcodec.h:153-169`). All codecs have `lossy=false`.

| Tag | Name | Implementation |
|---|---|---|
| `zlib` | Deflate | raw deflate |
| `zstd` | Zstandard | one zstd frame |
| `lzma` | LZMA | raw LZMA1, no props |
| `huff` | Huffman | 8-bit static Huffman |
| `flac` | FLAC | 'L'/'B' byte followed by raw FLAC frames |
| `cdzl` | CD Deflate | CD wrapper: base zlib, subcode zlib |
| `cdzs` | CD Zstandard | CD wrapper: base zstd, subcode zstd |
| `cdlz` | CD LZMA | CD wrapper: base LZMA, **subcode zlib** |
| `cdfl` | CD FLAC | FLAC frames for 2352 B/frame, then a zlib stream for the subcode, with no header |
| `avhu` | A/V Huffman | laserdisc frames |

### 7.1 Codec selection and fallback

- `chd_compressor_group::find_best_compressor` (`chdcodec.cpp:739-792`) tries every listed codec in slot order,
  swallows exceptions, and keeps the **strictly smallest** result below hunkbytes. A tie keeps the lower slot.
- If no codec produces a result, it returns -1 and the hunk is stored as NONE (`chd.cpp:2865`).
- Each codec throws when its output would reach its input size:

| Codec | Expansion condition |
|---|---|
| zlib | `total_out >= srclen` (`chdcodec.cpp:953`) |
| zstd | `output.pos == output.size` (`:1081`) |
| LZMA | `destLen = srclen`, giving `SZ_ERROR_OUTPUT_EOF` (`:1289-1292`) |
| huff | bitstream overflow at capacity srclen (`huffman.cpp:716-717`) |
| flac | `complen + 1 >= hunkbytes` (`:1499`) |
| CD wrapper | base `complen >= srclen` (`:382`) |
| cdfl | `complen >= srclen` (`:1665`) |

- Identical hunks, detected by CRC16 plus SHA1, become SELF. Hunks matching a parent unit run become PARENT
  (`chd.cpp:3237-3256`).

### 7.2 zlib (`zlib`, and the sub-streams of `cdzl`/`cdlz`/`cdfl`)

- **Compressor:** `deflateInit2(Z_BEST_COMPRESSION=9, Z_DEFLATED, windowBits=-15 (raw), memLevel=8,
  Z_DEFAULT_STRATEGY)`, followed by `deflate(Z_FINISH)` with `avail_out = srclen` (`chdcodec.cpp:912,936-958`).
  - Output is identical with system zlib 1.3 (Python) and MAME's 1.3.2 on all 109 zlib/cdzl test hunks, plus the
    100 cdlz subcode streams **[tested]**.
- **Decoders:**

| Decoder | Behaviour |
|---|---|
| MAME | `inflateInit2(-15)`, `inflate(Z_FINISH)`; must return `Z_STREAM_END` with `total_out == destlen` (`:977,1016-1020`). Trailing input is ignored. |
| libchdr (miniz tinfl, default since 2026-02) | `TINFL_STATUS_DONE && out_bytes == destlen` (`libchdr_codec_zlib.c:86-92`) |
| libchdr (system zlib, and all releases before 2026-02) | only checks `total_out == destlen`, not even `Z_STREAM_END` |
| chd-rs (flate2) | `total_out == len` |

### 7.3 zstd (`zstd`, and both sub-streams of `cdzs`)

- **Compressor:** `ZSTD_initCStream(stream, ZSTD_maxCLevel())` (level 22), then one `ZSTD_compressStream2(...,
  ZSTD_e_end)` (`chdcodec.cpp:1064-1085`).
  - Because the first call uses `ZSTD_e_end`, zstd sets the pledged source size to the input size
    (`3rdparty/zstd/lib/compress/zstd_compress.c:6345,6366`). The frame is therefore **single-segment with the
    content size**: the frame header descriptor is 0x60 with a 2-byte FCS for 256..65791 bytes **[tested]**, and the
    window equals the content size.
  - Parameters come from the small-source tables, all strategy `btultra2` **[tested with python-zstandard 1.5.7]**:

| Source size | windowLog | chainLog | hashLog | searchLog | minMatch | targetLength |
|---|---|---|---|---|---|---|
| 768 B (CD subcode) | 10 | 11 | 11 | 10 | 3 | 999 |
| 4096 B | 12 | 13 | 13 | 10 | 3 | 999 |
| 18816 B (CD base) | 15 | 16 | 16 | 11 | 3 | 999 |

  - No checksum and no dictID.
- **Decoders:**

| Decoder | Behaviour |
|---|---|
| MAME and libchdr | `ZSTD_initDStream`, then loop `ZSTD_decompressStream` while `input.pos < size && output.pos < size`; require `output.pos == destlen` (`chdcodec.cpp:1126-1146`; `libchdr_codec_zstd.c:52-90`). Default window limit 2^27 (`zstd.h:1287`). A frame with dictID ≠ 0 fails with `dictionary_wrong` (`zstd_decompress.c:716-717`). |
| chd-rs (ruzstd 0.8.3) | `decode_all` across frames; **window ≤ 100 MiB** (`ruzstd/src/decoding/frame_decoder.rs:19,114`) |
| chd-rs `fast_zstd` feature | C zstd `ZSTD_decompressDCtx` |

### 7.4 LZMA (`lzma`, and the base stream of `cdlz`)

- **Compressor:** `LzmaEncProps_Init; level=6; reduceSize=hunkbytes; Normalize` (`chdcodec.cpp:1312-1318`), then
  `LzmaEnc_MemEncode(..., writeEndMark=0, ...)` with `destLen = srclen` (`:1289-1290`).
  - For the `cdlz` base stream, hunkbytes is `frames × 2352`.
  - SDK 26.02 normalization (`LzmaEnc.c:70-110`): level 6 gives a default dictionary of 1<<26 on 64-bit builds
    (1<<25 in 23.01), clamped to `max(reduceSize, 4096)`; lc=3, lp=0, pb=2; algo=1 (optimal); fb=32; btMode=1 (bt4);
    numHashBytes=4; mc=32; numThreads 2, or 1 with `Z7_ST`.
  - **No properties are stored in the stream.**
  - SDK 23.01 and 26.02 output are identical on 22,760 hunks **[tested]**.
- **All decoders re-derive the properties from hunkbytes:**

| Decoder | Derivation |
|---|---|
| MAME | Builds encoder props exactly like the compressor and calls `LzmaEnc_WriteProperties` (`chdcodec.cpp:1330-1366`, with the FIXME at `:1336-1339` admitting the design flaw), then `LzmaDec_Allocate(props)` and `LzmaDec_DecodeToBuf(..., LZMA_FINISH_END)`. Requires `consumed == complen && decoded == destlen` (`:1385-1397`). The check compares `res` to `LZMA_STATUS_MAYBE_FINISHED_WITHOUT_MARK`, mixing an SRes with a status enum; it is harmless. |
| libchdr HEAD | Hard-codes the props byte as **93**, which is (pb × 5 + lp) × 9 + lc with lc3/lp0/pb2 (`libchdr_codec_lzma.c:224`). The dictionary comes from a verbatim copy of Normalize plus WriteProperties rounding (`:147-205`). Since 2026-09-05 it uses the caller's output buffer as the dictionary (`:273-287`). |
| libchdr 2026-02-02 to 2026-08-22 | Derived a 64 MiB dictionary (the "MAX not MIN" bug, fixed in `fa36420`). That wasted memory but was not a correctness problem. |
| chd-rs | lzma-rs with lc3/lp0/pb2 and the old level-9 formula (`chd-rs/src/compression/lzma.rs:60-90,114`) |

- **The derived dictionary** is the WriteProperties rounding of `max(4096, hunkbytes)`:

| Hunk (or base) size | Derived dictionary |
|---|---|
| 2448 | 4096 |
| 4096 | 4096 |
| 18816 / 19584 | 24576 |
| 63504 | 65536 |
| 66096 | 98304 |
| 1 MiB | 1 MiB |

### 7.5 Huffman (`huff`) and MAME's static Huffman

`huffman_8bit_encoder` is `huffman_encoder<256,16>`: 256 symbols and a maximum code length of 16
(`huffman.h:95-170`). The encoding is (`huffman.cpp:695-718`):

1. Build a histogram.
2. `compute_tree_from_histo`: a binary search on a weight scale so that the classic Huffman tree built from scaled
   weights has depth ≤ maxbits (`:425-456`). `build_tree` uses a sorted list with ties broken by symbol
   (`:524-605`).
3. Assign canonical codes.
4. `export_tree_huffman` (`:317-417`):
   - The code lengths are RLE-coded: literal = length + 1, token 0 = repeat.
   - They are then coded with a small 24-symbol, maximum-6-bit Huffman tree, whose lengths are sent as 3-bit values:
     `small[0]`, `first_non_zero-1` (clamped to 8), `small[first..last]`, then `7` as terminator.
   - A repeat count is `count-2` in 3 bits, or `7` followed by `count-7` in `rlefullbits` (8) bits.
5. Code the data MSB-first and flush to a byte.

**Canonical rule** (`assign_canonical_codes`, `huffman.cpp:614-646`):
- The start code for each length is computed from the **longest length downward**, starting at 0. Longer codes are
  therefore numerically *smaller*, the reverse of DEFLATE's convention.
- Within a length, codes are assigned in increasing symbol order.
- A tree is accepted only if `(curstart + count[len])` is even for every len ≥ 2. The code must be complete, or have
  a single half-used root (the one-symbol case).

**Decoding** peeks `maxbits` bits and looks the result up (`huffman.h:209-220`). The V5 map uses
`huffman_encoder<16,8>` with the simpler `export_tree_rle` (4-bit fields, `huffman.cpp:205-239,469-499`). avhuff uses
`<256+16,16>` and `export_tree_rle`. Byte-exact reproduction of 1983 `huff` hunks and of every chdman map confirms the
algorithm **[tested]**.

### 7.6 FLAC (`flac`)

**Compressor** (`chdcodec.cpp:1465-1528`, `flac.cpp:68-91`):
- libFLAC 1.4.3 at compression level 8: mid-side on, maximum LPC order 12, qlp precision automatic, partition
  order 0–6, apodization `subdivide_tukey(3)`, no exhaustive search (`stream_encoder.c:123-134`).
- `verify=false`, `streamable_subset=false`, `total_samples_estimate=0`, 44100 Hz, 2 channels, 16-bit.
- `do_md5` is left at its default, so an MD5 is computed and then discarded (a small CPU waste for lane B;
  `flac.cpp:78`).
- **Block size** is `blocksize(hunkbytes)`: hunkbytes/4 halved until ≤ 2048 (`:1520-1528`). A 4096-byte hunk gives
  1024; 8192 gives 2048.
- The output has **all metadata stripped**: the writer skips `fLaC` and every metadata block (`flac.cpp:245-284`), so
  only frames remain.
- The data is encoded twice, reading samples as big-endian and as little-endian; the smaller result is kept and
  prefixed with `'B'` or `'L'` (`:1483-1513`).

**Decoders:**

| Decoder | Behaviour |
|---|---|
| MAME | Synthesizes a 42-byte header: `fLaC`, STREAMINFO with the last-block flag, min = max blocksize = `blocksize(destlen)`, frame sizes 0, 44100 Hz, 2 channels, 16 bits, 0 samples, zero MD5 (`flac.cpp:438-470`). Then `process_single` until `destlen/4` samples are written; extra samples are clamped (`:493-507,671-718`). Errors reach an ignoring callback (`:732-734`). |
| libchdr (dr_flac) | Same header (`libchdr_flac.c:234-264`), but since `8778797` (2026-09-10) it writes the block size **un-multiplied**. Earlier versions wrote `block_size × channels`, i.e. 2× the real value. |
| chd-rs (claxon) | Parses raw frames with no STREAMINFO at all (`chd-rs/src/compression/flac.rs:40-95`). |

### 7.7 CD wrappers (`cdzl`, `cdlz`, `cdzs`)

Implemented by `chd_cd_compressor` and `chd_cd_decompressor` (`chdcodec.cpp:336-458`); libchdr's equivalent is
`cd_codec_decompress` (`libchdr_cdrom.c:531-657`). The compressed hunk layout is:

```
frames      = hunkbytes / 2448
ecc_bytes   = ceil(frames/8)          # bitmap, bit (f%8) of byte f/8 (LSB first) = "sync+ECC stripped for frame f"
clen_bytes  = 2 if hunkbytes < 65536 else 3    # depends on the HUNK size, not on the compressed length
[ecc bitmap][base_complen: be16/be24][base stream: frames*2352 bytes of sector data][subcode stream: frames*96 bytes]
```

- With the default 8-frame hunk the header is 3 bytes. At 27 frames (66096 bytes) the length field becomes 3 bytes
  **[tested]**.
- The subcode stream runs from the end of the base stream to `complen`.
- The base codec is constructed with hunkbytes `frames × 2352` and the subcode codec with `frames × 96`. That
  matters for LZMA's derived dictionary and for zstd's parameters.
- **Sub-codecs:** cdzl uses zlib/zlib, cdlz uses LZMA/**zlib**, and cdzs uses zstd/zstd.
- **Stripping and regeneration:**
  - A frame is stripped only if its first 12 bytes equal the sync pattern `00 FF×10 00` **and**
    `ecc_verify(sector)` succeeds (`chdcodec.cpp:371-377`).
  - Stripping zeroes the 12 sync bytes and the 276 P/Q ECC bytes at 0x81C–0x92F.
  - The EDC at 0x810, the header, the mode 2 subheader and the user data are **never** stripped.
  - On decode, when the bit is set, the sync pattern is written back and `ecc_generate` recomputes P
    (86 × 24 products) and Q (52 × 43) (`cdrom.cpp:1383-1450`).
  - `ecc_source_byte` treats header bytes 12–15 as zero when the mode byte is 2 (`:1363-1367`); that is the
    Mode 2 Form 1 rule.
  - Any sector that fails verification is stored verbatim: audio, Mode 2 Form 2, bad ECC, non-standard sectors.
    The scheme is lossless by construction.
- **No explicit fallback:** the CD compressor throws only if the base result ≥ the whole hunk.
- **Edge case (lane B):** when base and subcode are both incompressible, the concatenation can exceed the
  hunkbytes-sized test buffer by 1 byte (3 + 18815 + 767). This is a latent 1-byte overflow in
  `find_best_compressor`'s buffer. **[unverified in practice]**

### 7.8 CD FLAC (`cdfl`)

`chdcodec.cpp:1584-1799`:

- The sector data of every frame is FLAC-encoded as big-endian 16-bit stereo, i.e. with a byte swap on
  little-endian hosts (`:1593,1643`). There is **no ECC handling and no header**.
- Block size is `frames×2352/4` halved until ≤ 2352 (`:1682-1689`):

| Frames per hunk | Block size | Frames |
|---|---|---|
| 8 | 2352 | 2 |
| 27 | 1984 | 8 plus a 4-sample tail frame **[tested]** |

- Immediately after the last FLAC frame comes one raw-deflate stream holding the subcode.
- **The decoder finds the subcode by asking the FLAC decoder how many bytes it consumed:**
  - MAME: `FLAC__stream_decoder_get_decode_position` (`flac.cpp:542-555`).
  - libchdr (dr_flac): reconstructed from the bit-reader cache (`libchdr_flac.c` `flac_decoder_finish`).
  - micro-flac: `bytes_consumed`.
  - chd-rs: claxon's reader position.
  - The FLAC stream must therefore end exactly at a frame boundary, holding exactly the needed samples. MAME and
    libchdr tolerate extra samples in the last frame; chd-rs does not (§9).

### 7.9 avhuff (`avhu`), brief

This codec is for laserdisc only (`avhuff.cpp`). The raw frame is a `chav` header, metadata, 16-bit big-endian
audio channels and 8-bit YUY video.

- Audio (`AVHUFF_USE_FLAC=1`, `avhuff.h:27`): each channel is FLAC-encoded as mono 48 kHz with block size equal to
  the sample count, and the tree size is set to `0xffff`. The legacy Huffman path uses two `huffman_8bit` trees
  with RLE export.
- Video: delta-RLE Huffman with three `huffman_encoder<272,16>` contexts (Y, Cb, Cr).
- Decode can go through `codec_process_hunk` (`chd.cpp:999-1096`) for configure-based output.
- libchdr has supported it since 2026-04-24 (`405e581`); chd-rs supports it too.

### 7.10 Metadata used by codecs

avhuff reads AVAV at compressor post-init (`chdcodec.cpp:1889-1911`). No other codec reads metadata.

---

## 8. Third-party library versions and determinism

- **zlib 1.3.2 level 9** matches Python's zlib 1.3 output exactly **[tested]**. Deflate output has been stable across
  1.2.x and 1.3.x for level 9 **[unverified beyond these versions]**.
- **LZMA SDK 23.01 (the 0.289 release) versus 26.02 (76c7d19):** identical encoder output on all 22,760 test hunks
  at level 6 **[tested]**. The level-based default dictionary formula differs, but the hunk-size clamp hides it.
- **zstd 1.5.5 (the 0.289 release) versus 1.5.7 (76c7d19):** at level 22, **1,278 of 10,480 frames differ**; total
  size moved by +0.03% **[tested with python-zstandard 0.22 and 0.25]**. `zstd`/`cdzs` CHDs therefore depend on the
  zstd version. Default codecs do not use zstd.
- **FLAC 1.4.3** is unchanged since 0.289.
- **Cross-cutting (lanes B and E):**
  - Discpress's "chdman 0.289" is post-release master. It also contains these post-0.289 changes:
    - CHSE session metadata (changes the overall SHA1 of multi-session CDs);
    - `chdman: add GDI pregap support` (`ac47a71ce1`);
    - createcd/extractcd pregap parameters (`1cf0f9e986`);
    - CD+G parsing;
    - `util/chd: fix several size and range handling issues` (`e5e82312c2`).
  - Byte-identity claims should name the exact tree.

---

## 9. Encoder freedom

### 9.1 Experiments

Every row below was built with `chdlib.py` from real chdman payloads plus the modified hunks, then decoded by:
- **MAME:** chdman verify, raw and overall SHA1;
- **L-HEAD:** libchdr 607694c;
- **L-2402:** libchdr 647f42b;
- **L-2208:** libchdr 44c91c9;
- **L-2201:** libchdr 098e147 (FLAC tests only);
- **L-2012:** libchdr 513aebf, which uses libFLAC 1.3.3 and has no huff, zstd, or non-CD lzma/flac;
- **RS:** chd-rs f6cdb77.

"n/a" means that old library cannot open the base codec set at all.

| # | Variant | MAME | L-HEAD | L-2402 | L-2208 | L-2012 | RS |
|---|---|---|---|---|---|---|---|
| **LZMA** | | | | | | | |
| 1 | SDK level 9, fb 273, mc 1000 | ✔ | ✔ | ✔ | ✔ (cdlz) | ✔ (cdlz) | ✔ |
| 2 | level 1 / hc4 / fb 16; bt2 / fb 64 | ✔ | ✔ | ✔ | – | – | ✔ |
| 3 | 64 MiB encoder dictionary | ✔ | ✔ | ✔ | – | – | ✔ |
| 4 | **end marker written** (+5.4 B/hunk) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 5 | liblzma raw LZMA1, preset 9e, nice_len 273 (writes an end marker) | ✔ | ✔ | ✔ | – | – | ✔ |
| 6 | lc0/lp0/pb0 or lc4 | ✘ | ✘ | ✘ | – | – | ✘ |
| **Deflate** | | | | | | | |
| 7 | zopfli i15, libdeflate 12, zlib Z_FILTERED/memLevel 9, zlib level 1 window 2^9 | ✔ | ✔ | ✔ | ✔ (cd) | ✔ (cd) | ✔ |
| 8 | 8 bytes of garbage after the deflate stream (also inside the cdzl base stream) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 9 | zlib *wrapper* (2-byte header plus adler32) | ✘ | ✘ | ✘ | – | – | ✘ |
| **zstd** | | | | | | | |
| 10 | levels 3, 19, 22; no content size (saves 1 B/hunk); checksum; LDM; tuned btultra2; skippable-frame prefix; 2 frames per hunk | ✔ | ✔ | ✔ | n/a | n/a | ✔ |
| 11 | window_log 27 streaming frame without content size | ✔ | ✔ | ✔ | n/a | n/a | **✘** (ruzstd > 100 MiB) |
| 12 | trained dictionary, with or without dictID | ✘ | ✘ | ✘ | n/a | n/a | ✘ |
| **Huffman** | | | | | | | |
| 13 | package-merge (optimal length-limited) trees for `huff` hunks and the small tree | ✔ | ✔ | ✔ | n/a | n/a | ✔ |
| 14 | package-merge tree for the **map** | ✔ | ✔ | ✔ | ✔ (cd) | ✔ (cd) | ✔ |
| **FLAC (cdfl, 8-frame hunks)** | | | | | | | |
| 15 | own encoder, 2352-sample frames, fixed numbering | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 16 | **1176-sample frames with *fixed* frame numbers** | **✘** (libFLAC inserts silence) | ✔ | ✔ | ✔ | ✔ | ✔ |
| 17 | **1176-sample frames with the variable-blocksize bit and sample numbers** | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 18 | mixed 2352/588/1176/588… frames (variable numbering) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 19 | **one 4704-sample frame (> STREAMINFO max)** | ✔ | **✘** | ✔ | ✔ | ✔ | ✔ |
| 20 | bits-per-sample code 0 ("from STREAMINFO") | ✔ | ✔ | ✔ | ✔ | ✔ | **✘** (claxon) |
| 21 | sample rate code 0 or a wrong rate (48 k) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 22 | mid-side + Rice2 + partition order 4; verbatim subframes | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 23 | LPC order 32, 15-bit precision (including shift 15 and full-scale sines) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 24 | extra samples in the last frame (27-frame hunk) | ✔ | ✔ | ✔ | ✔ | ✔ | **✘** (WriteError) |
| **FLAC (`flac` codec, 2048-sample blocks)** | | | | | | | |
| 25 | partition order 8 | ✔ | ✔ | ✔ | ✔ | n/a | ✔ |
| 26 | **partition order 9** | ✔ | **✘** | ✘ | ✘ | n/a | ✔ |
| 27 | malformed stream (partition < predictor order) | **hang** (infinite loop) | ✘ | ✘ | ✘ | n/a | ✘ |
| **CD wrappers** | | | | | | | |
| 28 | ECC bitmap all 0, ECC stored raw (+20%) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 29 | stripped sync and ECC bytes filled with 0xFF instead of 0 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 30 | base via libdeflate 12, subcode via zopfli; subcode as stored blocks | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 31 | cdzs with base level 19 and subcode level 1, in slot 0 | ✔ | ✔ | ✔ | segfault | n/a | ✔ |
| 32 | 3-byte length field on a hunk < 64 KiB | ✘ | ✘ | ✘ | ✘ | ✘ | ✘ |
| **Container** | | | | | | | |
| 33 | forward SELF references and SELF chains | ✔ | ✔ | ✔ | – | – | ✔ |
| 34 | complen == hunkbytes | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 35 | complen = hunkbytes + 16 | "✔" (**heap overflow**) | ✘ | **abort, heap corruption** | – | – | ✔ |
| 36 | hole in codec list `[x, 0, y, z]` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 37 | **same codec in two slots** | ✔ | ✔ | **crash** | **double free** | **double free** | ✔ |
| 38 | unused `cdlz` listed on 4096-byte hunks | ✘ (open fails) | ✘ | ✘ | – | – | ✘ |
| 39 | metadata after the data; map before the data; 1 KiB gap after the header | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 40 | 16-byte gap between two hunks | ✘ (map CRC) | ✘ | ✘ | – | – | ✘ |
| 41 | lengthbits 24–25; selfbits ≤ 26 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 42 | lengthbits 28–30; selfbits 28 | ✔ | **✘** | ✘ | ✘ | ✘ | ✔ |
| 43 | selfbits 32 | **✘** (UB shift) | ✘ | ✘ | – | – | ✔ |
| 44 | non-zero padding in the last partial hunk | ✔ | ✔ | ✔ | – | – | ✔ |
| 45 | child shifted by one unit (unaligned PARENT refs) | ✔ | ✔ | – | – | – | ✔ |
| 46 | child hunkbytes ≠ parent hunkbytes | ✔ | **✘ silently wrong** | – | – | – | ✘ |
| 47 | SELF → self cycle | **crash** | **crash** | – | – | – | **crash** |
| 48 | hunk sizes of 1/16/26/27 CD frames; 2 KiB/64 KiB/1 MiB DVD | ✔ | ✔ | ✔ | ✔ (cd) | ✔ (cd) | ✔ |

### 9.2 Encoder-freedom matrix

Evidence notation: **[code]** means the constraint follows from the decoder source; **[T#]** refers to the test rows
above. Estimated gains are marked **[est.]** and need lane G's measurements on real game data, except where §9.3
gives a proxy.

| Codec | Parameter | Fixed by decoders? (evidence) | Freedom available | Likely gain |
|---|---|---|---|---|
| **all** | Hunk size | No. Any multiple of unitbytes; CD codecs need a multiple of 2448 and `flac` needs a multiple of 4 (libchdr `libchdr_codec_flac.c:27`, chd-rs). ≤ 1 MiB with chdman, < 128 MiB with libchdr [T48] | Larger hunks on DVD/HD; more frames per CD hunk. Up to 26 frames keeps the 2-byte length field. | **Large.** Proxy corpus with LZMA: 4 KiB→19.5 KiB −13%, →64 KiB −19% (§9.3). Costs random-access latency and memory in emulators (lane D). |
| all | Codec slots | Order and holes are free [T36]. Duplicates are fatal on libchdr before 2024-10-25 [T37]. Every listed codec must initialize at the hunk size [T38]. | Any order; up to 4 distinct codecs. Choose the tried set per image. | Speed: fewer codecs tried means faster encoding. |
| all | Codec choice per hunk | No: the map type selects the slot. | Pick by size, or by decode speed (e.g. prefer zstd/cdzs when within x% of LZMA). | Decode speed for emulators. |
| all | complen | **≤ hunkbytes** [code `chd.cpp:2793`, `libchdr_chd.c:3024`; T34/T35] | Trailing padding inside a stream is allowed for zlib and zstd only. | none |
| all | Layout | TYPE/NONE hunks contiguous and in hunk order from `firstoffs` [code; T40]. Map, metadata and header gaps are free [T39]. | Map before the data (streaming readers); metadata anywhere; pre-allocated or padded header area. | none (tooling only) |
| all | Map encoding | The tree must satisfy MAME's canonical and evenness rule; field widths ≤ 25 [T41/T42/T43]. RLE and pseudo-type use are free. | Optimal trees; wider or narrower fields; RLE choices. | Negligible (bytes per image). |
| all | Padding of the last hunk | Only the CRC must match [T44]. | Any padding. | none |
| all | SELF references | Any direction or chain [T33]; must be acyclic [T47]. | Deduplicate against later hunks too; prefer the most recent copy for locality. | Small; dedupe is already done. |
| all | PARENT references | Unit granularity [T45]; parent and child hunk size must match for libchdr/chd-rs [T46]. | Unit-offset matching, which chdman already does. | n/a |
| **zlib** | Deflate encoder | Only a raw deflate stream (windowBits −15) is required: output exactly `destlen`, `Z_STREAM_END` in MAME [code `chdcodec.cpp:1016-1020`]. The 32 KiB window is inherent to deflate. | **Any deflate encoder** (zopfli, libdeflate 1–12, zlib strategies) [T7]. Trailing bytes are tolerated [T8]. | Deflate streams 1.3–3.8% smaller (§9.3), 2–5× slower (libdeflate 12) or 100×+ (zopfli). The overall effect is smaller because cdlz/lzma usually win on data; the gain lands on cdzl-won hunks and subcode streams. |
| zlib | Header | Must *not* have a zlib wrapper [T9]. | none | – |
| **zstd** | Level and strategy | Free [T10]. | Any level; btultra2 tuning; long-distance matching (useless below the window size). | Level 19 = level 22 at CD/DVD hunk sizes (§9.3). zstd-22 is 2.7–7.7% larger than LZMA-6 per hunk but decodes several times faster [est.]. |
| zstd | Window | ≤ 2^27 for MAME/libchdr (`zstd.h:1287`), ≤ 100 MiB for chd-rs (ruzstd) [T11]. | Use a window ≤ hunk (single-segment). | none |
| zstd | Content size and checksum flags | Optional [T10]. | Dropping FCS saves 1 B/hunk; keep the checksum off (+4 B). | Tiny |
| zstd | Dictionary | **Forbidden**: no decoder loads a dictionary; dictID fails with `dictionary_wrong` [code `zstd_decompress.c:716`; T12]. | none | – |
| zstd | Frame structure | Multiple frames and skippable frames are OK [T10]. | Could split a hunk to encode it in parallel. | – |
| zstd | Library version | 1.5.5 ≠ 1.5.7 output [§8]. | Pin a version for reproducibility. | – |
| **LZMA** | lc/lp/pb | **Fixed at 3/0/2**: decoders recompute the props, and libchdr hard-codes 93 [code `libchdr_codec_lzma.c:224`; T6]. | none | – |
| LZMA | Dictionary size (encoder) | The decoder dictionary is ≥ the hunk; the encoder can use any size ≥ the hunk [T3]. | irrelevant | – |
| LZMA | fb, mc, algo, match finder, numHashBytes, level | Free [T1/T2]. | Any; any LZMA1 encoder, including liblzma or 7-Zip's newer ones. | Negligible at small hunks (≤ 0.1% measured, §9.3). Faster settings can speed up encoding at +0.1–1% size [est.]. |
| LZMA | End marker | Tolerated everywhere, including LZMA SDK 19 in libchdr 2020 [T4/T5]. | Enables liblzma-based encoders. | Costs about 5 B/hunk. |
| LZMA | Range-coder flush | Stream must end with `code == 0` and consume all input (`consumedlen == complen`) [code `chdcodec.cpp:1395`]. | Standard flush only; **no trailing bytes**. | – |
| **huff** | Tree | Any valid canonical tree, lengths ≤ 16 [T13]. | Optimal length-limited trees (package-merge). | Negligible (15 B on 1983 hunks). |
| **flac** / **cdfl** | Encoder implementation | Must emit plain FLAC frames with no metadata; the stream must end exactly at a frame boundary (cdfl: the subcode follows) [code]. | Any encoder (libFLAC 1.4/1.5 at -8ep with l 32, flake-style, custom). | 0.3–2% of audio size [est., lane G]. |
| flac | Frame block size | **≤ `blocksize(geometry)`** (2352 for cdfl at 8 frames, ≤ 2048 for `flac`). libchdr since 2026-09-10 and micro-flac reject larger frames [code `dr_flac.h:5568`; T19]. | Smaller frames allowed only with the **variable-blocksize bit and sample numbers** [T16–T18]. | Variable blocking can help transient audio: 0.5–2% [est.]. |
| flac | Numbering | Fixed numbering implies every frame except the last equals the STREAMINFO block size (libFLAC 1.4 gap fill, `stream_decoder.c:2149-2210`) [T16]. | Use variable numbering for anything else. | – |
| flac | Sample count | Exact: no overshoot (chd-rs) [T24]. | none | – |
| flac | LPC order and precision | Order ≤ 32; precision ≤ 15; **shift ≥ 0** (claxon rejects a negative shift, `claxon subframe.rs:688`). For libchdr 2021-03–2022-02 (dr_flac ≤ 0.12.33), keep `bps + precision + ilog2(order) ≤ 32`, as libFLAC does (`stream_encoder.c:3979-3983`) [code; T23 not reproduced as a failure]. | Orders up to 32, precision search, exhaustive model search. | Part of the 0.3–2% [est.]. |
| flac | Residual coding | Partition order ≤ 8 (dr_flac) [code `dr_flac.h:4869`; T26]; it must also divide the block size (2352 = 2^4 × 147, so ≤ 4 at cdfl default). Rice or Rice2 [T22]. | Up to 8; escape codes. | small |
| flac | Stereo mode | Any: independent, left/side, right/side, mid/side [T22]. | – | – |
| flac | Frame header fields | Bits-per-sample must be explicit (claxon) [T20]; sample-rate code is free [T21]; channels 2; CRC-8/CRC-16 must be correct (libFLAC replaces a bad frame with silence, claxon errors). | – | – |
| flac | 'L'/'B' byte (`flac` only) | 'L' or 'B' required. | Choose without encoding twice (encoder speed ×2). | Speed |
| **CD wrappers** | ECC bitmap | Per-frame optional; set a bit only if regeneration is exact [code; T28]. | Could skip the ECC check on hunks that are then compressed differently. | – |
| CD | Content of stripped bytes | Don't-care: decoders overwrite them [T29]. | Zeros are best. | – |
| CD | EDC, header, subheader | Must be stored (decoders don't regenerate them) [code]. | none (a format change would be needed) | – |
| CD | Length-field width | Fixed by the hunk size (< 65536 gives 2 bytes) [T32]. | Keep hunks ≤ 26 frames to save 1 byte. | – |
| CD | Subcode stream codec | Fixed by the codec: cdlz/cdzl/cdfl use deflate, cdzs uses zstd. The encoder is free [T30]. | Optimal deflate for subcode; all-zero subcode deflates to a few bytes. | Small (about 0.1–0.3% on discs with real subcode) [est.]. |
| **avhu** | – | Not studied in depth. | – | – |

### 9.3 Proxy measurements

The corpus is 16 MiB from `/usr/bin`, `/usr/lib/x86_64-linux-gnu` and `/usr/share/doc`: real binaries and text,
not game data. Sizes are totals with each hunk capped at hunkbytes.

| Hunk | zlib-9 → libdeflate-12 | zlib-9 → zopfli i15 (first 2 MiB) | LZMA-L6 → L9 fb273 | zstd-22 vs LZMA-L6 | zstd-19 vs zstd-22 |
|---|---|---|---|---|---|
| 4096 | −1.28% | −1.64% | −0.03% | +2.67% | ±0.00% |
| 19584 | −2.28% | −2.43% | −0.05% | +5.20% | ±0.00% |
| 65536 | −3.45% | −3.78% | −0.09% | +7.66% | ±0.00% |

With LZMA-L6, the total for this corpus falls from 6.91 MB at 4 KiB hunks to 5.99 MB at 19.5 KiB and 5.58 MB at
64 KiB.

---

## 10. MAME versus libchdr versus chd-rs

### 10.1 Codec support over time

| Codec | MAME | libchdr | chd-rs |
|---|---|---|---|
| cdzl, cdlz, cdfl | V5 (`f0823886a6`, 2012-02-16) | from its initial commit (`ecfbb1f`, 2017-07-27) | ✔ |
| zlib (non-CD V5) | 2012 | `2785de8`/`f08156f` (2018-07-24) | ✔ |
| lzma and flac (non-CD) | 2012 | `e23f32f` (2022-03-26) | ✔ |
| huff | 2012 | `5715077` (2022-12-29) | ✔ |
| **zstd, cdzs** | `05e69b43e9` (2023-12-11), **first release 0.262** (2024-01-31) | **`d6f59e7` by Zakk (2024-01-10), merged as `26d27ca`, PR #106 (2024-01-31)** | ✔ (ruzstd) |
| avhu / V3–V4 AV | ✔ | `405e581` (2026-04-24) | ✔ |
| FLAC backend | libFLAC (1.4.3 now) | libFLAC 1.3.3 until `878b5af`/`d540adf` (2021-03-11/13), then dr_flac 0.12.28 → 0.13.4; optional micro-flac since 2026-09-06 (the default only on MCU targets, `3721121`) | claxon 0.4.3 |
| zlib backend | zlib 1.3.2 | zlib 1.2.x/1.3.1 until 2026-02, **miniz 3.x tinfl** since `1cc6b0a` (2026-02-05) | flate2 / zlib-rs |
| LZMA backend | LZMA SDK 26.02 | LZMA SDK 19.00 → 22.01 → 24.05 → 25.01 → 26.02; encoder-free props since `a200d77` (2026-02-02) | lzma-rs |

An unknown codec tag gives `UNKNOWN_COMPRESSION` at open in MAME and `UNSUPPORTED_FORMAT` in libchdr 2020 and HEAD,
but **libchdr 2022-08 (44c91c9) segfaults** **[tested]**.

### 10.2 Other features and behaviour

| Aspect | MAME `chd_file` | libchdr (HEAD) | chd-rs |
|---|---|---|---|
| Header versions | V3–V5 | V1–V5 | V1–V5 |
| Write support | V5, compressed or uncompressed | none | none |
| V1–V4 end-of-map cookie check | no | yes | ? (not checked) |
| Per-hunk CRC | always | `VERIFY_BLOCK_CRC` (default on); V3/V4 CRC-32 only since 2026-09-09 | off by default |
| Map CRC | yes | yes | yes |
| Parent handling | any hunk size (`read_bytes`); `open_parent` callback | caller passes the parent; same hunk size assumed; `uint8_t` units-per-hunk | same hunk size assumed |
| complen > hunkbytes | heap overflow (UB) | error; pre-2024-10 heap corruption | accepted |
| Duplicate codec slots | fine | fine since `45670a9` (2024-10-25); crash before | fine |
| Map field width | ≤ 31 | ≤ 25 | ≤ 32 |
| FLAC STREAMINFO | exact block size, no max check (libFLAC) | exact since 2026-09-10, 2× before; frames > max rejected | none (claxon) |
| Size caps | none | < 1 TiB logical (10 GB 2024-10 to 2026-04), hunk < 128 MiB, map ≤ 256 MiB | none known |
| Metadata cycles | infinite loop | capped at 65,536 entries | ? |
| API extras | `read_units`/`read_bytes`, metadata write, codec_configure, `codec_process_hunk` (avhuff) | `chd_precache` (whole file in RAM, since 2020-06), `chd_open_core_file(_callbacks)`, `chd_set_cache_budget` read-ahead (2026), SELF cache, `LOWRAM_TARGET` (streamed map with checkpoints, two-level Huffman tables, lazy codec init) | buffered `Read`/`Seek` adapters |
| Build knobs | – | `WANT_SUBCODE`, `WANT_RAW_DATA_SECTOR`, `VERIFY_BLOCK_CRC`, `CHDR_CD_SCRATCH_BUFFER`, system zlib/zstd | features `want_subcode`, `want_raw_data_sector`, `verify_block_crc`, `fast_zstd` |

Known discrepancies, all **[tested]**: T16 (MAME stricter), T19/T26 (libchdr stricter), T20/T24/T11 (chd-rs stricter),
T46 (MAME more permissive), T43 (chd-rs more permissive).

---

## 11. Decoder robustness

- **MAME:**
  - SELF recursion has no cycle or depth guard: a stack-overflow crash **[tested]**.
  - `m_compressed` overflows when `blocklen > hunkbytes` (`chd.cpp:1222`) **[tested]**.
  - The FLAC decode loop never terminates on streams that end early: `process_single` returns true at
    END_OF_STREAM (`flac.cpp:503-505`; libFLAC `stream_decoder.c:1019-1021`). This is a **DoS**: `chdman verify` spins
    at 100% CPU **[tested]**. It also matters for Discpress's wasm worker when reading user CHDs.
  - `import_tree_rle` writes `repcount` nodes with no bound (`huffman.cpp:176-178`), and `build_lookup_table` doesn't
    bound-check `node.m_bits << shift`, which overflows `m_lookup` if code lengths violate Kraft at the top level
    (`huffman.cpp:614-674`). libchdr fixed both (`de74053`, 2023-02; `a154073`, 2024-10).
  - The metadata chain has no cycle guard.
  - Shifts by ≥ 32 on wide map fields are undefined behaviour.
  - `m_hunkcount*12` can overflow in 32 bits.
  - Every failure found is triggered by malformed files only.
- **libchdr** has been hardened heavily:
  - 2024-10 (Stenzek): bounds on precached reads, `hunk_read_compressed` overread, Huffman lookup overflow, map
    size overflow, double codec init, OOM in the map.
  - 2026: fuzz harness, a cap on metadata cycles, v1/v2 overflow checks, undefined-shift fixes, field-width
    checks ≤ 32.
  - It still crashes on SELF cycles **[tested]**.
  - Old snapshots vendored by emulators segfault on unknown codecs (2022) and double-free on duplicate codec tags
    (before 2024-10) **[tested]**.
- **chd-rs** is safe Rust, yet a SELF cycle aborts with a stack overflow **[tested]**. It returns errors for the
  other malformed cases tested.
- **Encoder implication:** a fork must never emit anything that relies on a decoder bug or UB. Compliance tests
  should run crafted files through MAME, libchdr HEAD, and at least one old libchdr snapshot.

---

## 12. Implications for a Discpress fork

### 12.1 Hard compatibility constraints

These are the must-not-violate rules, as they apply to every decoder tested:

1. **V5 header only**, length 124, codec FourCCs in `compressors[]` (§2.4). The first slot must be non-zero for a
   compressed file.
2. **Never list a codec twice.** Never list a codec that cannot initialize for the hunk size: CD codecs need
   hunkbytes % 2448 == 0, and `flac` needs hunkbytes % 4 == 0. Holes are allowed but pointless.
3. **Hunk layout:** TYPE_0..3 and NONE payloads contiguous, in hunk order, starting at `firstoffs`. **Compressed
   length ≤ hunkbytes.** SELF graphs acyclic. PARENT only against a parent with **identical hunkbytes and
   unitbytes**.
4. **Map:** exactly the V5 compressed-map syntax (§3.4). The canonical Huffman rule is MAME's (longest codes
   smallest), max 8 bits, and the tree must be complete. **Every bit field ≤ 25 bits.** The map CRC covers the
   expanded entries with real offsets.
5. **Hashes:** raw SHA1 over logical bytes; overall SHA1 per §5.2; CRC16/CCITT-FALSE per compressed or NONE hunk
   over the full hunk. Parent SHA1 is the parent's overall SHA1.
6. **LZMA:** raw LZMA1 with **lc=3, lp=0, pb=2**, no props in the stream, standard range-coder flush, no bytes after
   the stream. An end marker is optional.
7. **Deflate:** raw deflate (no zlib wrapper), producing exactly hunkbytes (or the sub-stream size).
8. **zstd:** standard frames, **no dictionaries**, window ≤ 100 MiB (practically ≤ the hunk). Only if the target
   emulators have libchdr ≥ 2024-01 / MAME ≥ 0.262.
9. **FLAC frames:**
   - block size ≤ `blocksize(geometry)`;
   - variable-blocksize numbering whenever a non-final frame is smaller than that;
   - explicit 16-bit bits-per-sample code;
   - partition order ≤ 8;
   - LPC order ≤ 32 with non-negative shift and `bps + precision + ilog2(order) ≤ 32`;
   - correct CRC-8/CRC-16;
   - **exactly** the hunk's sample count, with the stream ending on a frame boundary.
10. **CD wrappers:**
    - the length field is 2 bytes iff hunkbytes < 65536;
    - set an ECC bit only when `ecc_generate(sync+data)` reproduces the stored sector bit-exactly;
    - the subcode codec is fixed per wrapper (cdlz→deflate).
11. **Metadata:** same tags and text formats (lane C). Keep the chain order that CHSE parsing relies on. AVLD has no
    checksum.

### 12.2 Opportunities, ranked by value

1. **Choose larger hunks deliberately.** This is the largest pure-encoder gain and is fully decoder-compatible
   [T48].
   - DVD: 4 KiB → 16–64 KiB could cut size by about 10–19% on compressible data (proxy).
   - CD: 8 → 16–26 frames. Staying ≤ 26 frames keeps the 2-byte length field; the cdfl block size stays 1911–2352.
   - The cost is emulator seek granularity and cache memory, so lane D must confirm emulators handle non-default
     hunk sizes well. Offer it as an option, e.g. an "archive" profile, not as the default.
2. **Better deflate for cdzl/zlib/subcode streams.** libdeflate level 12 is fast enough for the browser; zopfli is
   too slow for large images.
   - Gains of 1.3–3.8% on deflate streams, applying to cdzl-won hunks, every subcode stream, and the non-CD zlib
     slot. Fully compatible [T7/T8/T30].
   - libdeflate is also far faster at *decoding* for our own verify path.
3. **FLAC encoder upgrade.**
   - libFLAC at -8 with exhaustive model search, qlp precision search and LPC orders up to 32, optionally with
     variable block sizes ≤ 2352 using variable numbering.
   - Estimated 0.5–2% on audio tracks, which can be a large share of PS1/Saturn/PCE CD images. Compatible within
     the §12.1 rule 9 limits [T17/T18/T23].
   - The biggest risk is getting numbering or block limits wrong. Mandate the three-decoder test.
   - Removing the MD5 computation and the double 'L'/'B' encode is pure speed.
4. **Smarter codec selection for speed.**
   - The format lets the encoder pick any listed codec per hunk: prefer a faster-decoding codec when it is within
     x% of the best (e.g. cdzs versus cdlz). This makes emulator loading faster and is compatible with emulators
     that know zstd.
   - Alternatively, try fewer codecs on hunks that obviously won't compress (encoding speed).
5. **Deterministic "profiles".** Keep a byte-identical "chdman 0.289 compatible" profile (the current promise) and
   make the others explicit.
   - Pin library versions: zstd output changes between 1.5.5 and 1.5.7; LZMA 23.01 and 26.02 happen to agree.
   - Decide whether the fork targets the 0.289 release or post-0.289 master, because of CHSE and CD+G (lanes B, C
     and E).
6. **Small wins:**
   - Optimal Huffman trees in the map and the huff codec (negligible).
   - Dropping the zstd FCS (1 B/hunk).
   - Better SELF deduplication, including forward references [T33].
   - Unit-offset PARENT matching, which chdman already does.
   - A map-before-data layout for streaming writers [T39]. This could allow single-pass output to a non-seekable
     stream if sizes were known, which they are not in one pass, so in practice it has little value.

### 12.3 Risks

- **Old decoders in the field:** emulators vendor libchdr snapshots from 2020–2026.
  - Avoid zstd/cdzs for broad compatibility: no support before 2024-01, and a segfault in 2022 snapshots.
  - Avoid `huff`, `lzma` and `flac` on non-CD media if 2021–2022-era libchdr matters. Note that chdman's own
    DVD/HD defaults already use them.
  - Never emit duplicate codec tags.
- **Emulator-level assumptions** that library tests cannot see (lane D): fixed 8-frame CD hunks, hunkbytes %
  2048, use of `unitbytes`, libchdr built without subcode or CRC.
- **FLAC behaviour differs by decoder** (§9.1 T16/T19/T20/T24/T26). Any FLAC change must be tested with at least
  MAME (libFLAC 1.4.3), libchdr HEAD (dr_flac 0.13.4, exact STREAMINFO), an old libchdr (dr_flac 0.12.x or libFLAC
  1.3.3) and chd-rs (claxon).
- **Decoder-side DoS** on malformed input: in Discpress's own reader (MAME code in wasm), a hostile CHD can hang
  the worker (FLAC) or overflow the stack (SELF cycle). The fork should add a depth or visited guard, bound the
  FLAC loop, and bound-check the Huffman import and complen.

---

## 13. Open questions

1. **micro-flac's exact limits** (LPC order, partition order, variable block size) were not read or tested. It is
   used only on MCU builds of libchdr.
2. Do **real emulators** (DuckStation, PCSX2, Flycast, Beetle/Mednafen cores, SwanStation, RetroArch's libchdr
   copies) accept non-default hunk sizes, variable-blocksize FLAC and zstd? What build flags do they use
   (`WANT_SUBCODE`, `VERIFY_BLOCK_CRC`)? Lane D.
3. **Real-data gains** for larger hunks, libdeflate/zopfli, FLAC -8ep with variable blocking, and zstd-versus-LZMA
   decode speed need measuring on real game images (lane G); the numbers here come from synthetic fixtures or a
   binaries proxy.
4. The theoretical 32-bit LPC overflow in dr_flac ≤ 0.12.33 (libchdr 2021-03 to 2022-02) was **not reproduced**,
   even with full-scale order-32/15-bit/shift-15 frames. The exact failure condition was not established.
5. Whether chd-rs checks the V1–V4 end cookie and metadata cycles was not examined.
6. The history of MAME's `flac` decoder before libFLAC 1.4, i.e. whether older MAME releases behave like
   libchdr-2020 on smaller fixed frames, was not tested. Only current MAME was built.
7. Should the fork emit **CHSE** metadata? It only exists on post-0.289 master and alters the overall SHA1 for
   multi-session discs (lanes C and E).
8. The zstd 1.5.5/1.5.7 output differences were measured with python-zstandard's one-shot API, which matched
   chdman's frames exactly for 1.5.7. MAME 0.289's own 1.5.5 build was not compiled for the comparison, so this is
   **[likely, not directly verified]**.
