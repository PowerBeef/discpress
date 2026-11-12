# Fuzzing the engine

libFuzzer feeds the engine damaged and made-up files under AddressSanitizer and UndefinedBehaviorSanitizer,
to find what a file can make it do wrong: read or write outside its memory, do what C++ leaves undefined,
hang, or leak. Each finding becomes an input in `regressions/`, and the fix goes into `engine/` like any
other change (`scripts/engine-diff.sh`, `./build.sh`).

```sh
./scripts/fuzz.sh build          # build/fuzz/{chd,desc,codec,ecm}, and their seeds in build/fuzz/seeds/
./scripts/fuzz.sh run all 600    # the four at once, 10 minutes each; new inputs go to build/fuzz/corpus/
./scripts/fuzz.sh check all      # every seed, regression and corpus input once (CI)
./scripts/fuzz.sh repro chd build/fuzz/findings/chd-crash-…   # one input, with the engine's messages
./scripts/fuzz.sh prune all      # the corpus without inputs that add nothing (CI, after a run)
```

It needs clang and its libFuzzer runtime (Debian and Ubuntu: `clang` and `libclang-rt-<version>-dev`).
`.github/workflows/fuzz.yml` runs it weekly for 30 minutes per fuzzer, on demand, and for 5 minutes when
`engine/`, `wasm/` or the fuzzers change; it keeps the corpus between runs in the Actions cache and uploads
a finding with the run.

## What each fuzzer feeds the engine

- **`chd`** (`fuzz_chd.cpp`): a CHD file, read the ways the page reads one. Identification first, with
  `wasm/wasm_helper.cpp`'s probe functions as `app/ident.js` calls them (the tracks, the first sectors, the
  volume descriptor and the directory it names). Then, for a CHD whose data is at most 8 MB, chdman's `info`,
  `verify` and every extract command (`extractraw`, `extracthd`, `extractdvd`, `extractcd` to a cue sheet, a
  TOC, a GDI and with `--redump`, `extractld`).
- **`desc`** (`fuzz_desc.cpp`): a cue sheet, cdrdao TOC, GDI, Nero image or ISO (the first byte picks the
  kind and the options), parsed with `cdrom_file::parse_toc`; one whose tracks are short is made into a CD
  CHD with `createcd` (stored, or with the default codecs), then verified and extracted again. Its folder
  holds the track files the seeds name: `t.bin`, `a.bin`, `a.wav`, `odd.bin` and `empty.bin`.
- **`codec`** (`fuzz_codec.cpp`): one compressed hunk for each codec a CHD can use, decompressed as a
  helper worker does (`wasm_helper_dinit`, `wasm_helper_decompress`).
- **`ecm`** (`fuzz_ecm.cpp`): an ECM image's stored bytes, rebuilt into sectors a window at a time as the
  job worker asks for them (`wasm/ecm.cpp`'s `wasm_ecm_decode`), in buffers of exactly their size.

The engine is built with `__EMSCRIPTEN__` defined, so the browser-only code is fuzzed too: the read-ahead of
extract and verify (`chd_file::wasm_read_ahead`), the probe and helper functions, the ECM decoder.
`host.cpp` stands in for the page's JavaScript (`wasm/par_lib.js`, `app/worker.js`): it runs chdman
commands as the job worker does (`chdman_begin`, then `chdman_resume` while chdman pauses), and its
"helpers" decompress the hunks chdman reads ahead, in one of four ways chosen by the input's size: none,
all of them, all but one in three (as a helper that traps), or in reverse order. A command that pauses
again and again with nothing left to wait for aborts: in the browser it would spin forever. Compression
stays in the engine, as on a page without helper workers.

Allocating more than 1 GB at once fails (`max_allocation_size_mb`, as a phone's browser would) and must be
an error, not a crash. Leaks unmodified chdman 0.289 has too are suppressed (`tests/support/lsan.supp`).
clang's check of calls through a pointer to another function type is off (`-fno-sanitize=function`): the
LZMA SDK calls its match finder through pointers that take `void *`, which every ABI, WebAssembly's
included, makes the same call. gcc's sanitizers (`scripts/build-sanitized.sh`) don't have that check.

`seeds.cpp` writes the seeds with the engine itself: CHDs of every kind and codec (v3 and v4 by hand,
since chdman no longer writes them), descriptors of every kind, compressed hunks and ECM chunks. They are
synthetic, like the test fixtures.

## Findings

Fixed, each with its input in `regressions/`:

- **A Huffman tree with more codes than one bit has room for** (`codec/huffman-one-bit-overfull`): codes
  longer than their length, and a lookup table written past its end, on the stack for the small tree a
  `huff` hunk starts with. chdman 0.289 has it, in the hunks' `huff` codec and in a v5 CHD's map
  (`huffman.cpp`'s `assign_canonical_codes`; `engine.spec.js` tests the map).
- **A CD codec's sector data longer than its hunk** (`codec/cd-base-longer-than-hunk`): the base codec
  decoded past the end of the hunk's data, and the subcode's length wrapped (`chdcodec.cpp`; chdman 0.289
  has it).
- **A LaserDisc frame larger than its hunk** (`codec/avhuff-frame-larger-than-hunk`): decoded past the end
  of the hunk; also more than 16 audio channels, and raw audio shorter than its samples (`avhuff.cpp`,
  `chdcodec.cpp`; chdman 0.289 has them).
- **A map larger than the file** (`chd/map-past-end`): up to 4 GB allocated before the read that fails.
  Looking at it turned up a map size computed in 32 bits, which wraps at 358 million hunks, so that the
  map is written past its end (`chd.cpp`; chdman 0.289 segfaults, `engine.spec.js`).
- **A map's bit widths over 32** (`chd/map-bits-over-32`): the bit reader shifted by a negative count.
  And of exactly 32 (`chd/map-bits-32`, found by CI's first run without a cached corpus): the reader
  shifted its 32-bit buffer by 32, which kept its bits on x86 and in WebAssembly, so the next field read
  them again (`bitstream.h`'s `remove`; chdman 0.289 has it).
- **A hunk compressed with a codec the CHD has none for** (`chd/codec-missing`): a v3 CHD without
  compression whose map says a hunk is compressed, or a v5 map that names an empty codec slot; a call
  through a null pointer (`chd.cpp`; chdman 0.289 segfaults, `engine.spec.js`).
- **A hunk in a parent the CHD doesn't have** (`chd/parent-missing`): a map entry for a parent's hunk
  in a CHD without a parent, read through a null pointer (`chd.cpp`; chdman 0.289 segfaults,
  `engine.spec.js`).
- **CD metadata with a string longer than 15 characters** (`chd/metadata-long-string`): read with `%s`
  into 16-byte buffers on the stack (`cdrom.cpp`'s `parse_metadata`; chdman 0.289 has it, as does every
  reader that took MAME's parser).
- **CD metadata without one of its tracks** (a corpus input; `engine.spec.js` names a track twice): a
  track of 0-byte sectors, which `extractcd` divided by. The old binary CD metadata (`CHCD`) was also read
  without checking its length, its number of tracks or their sector sizes (`cdrom.cpp`'s `parse_metadata`;
  chdman 0.289 has both).
- **A read of 0 bytes** (`chd/read-0-bytes`), as identification makes of a CD track that has no metadata
  (the next track's is there): the last hunk wrapped around, and a whole hunk was read into a sector's
  buffer, on the stack (`chd_file::read_bytes`; chdman 0.289 has it).
- **A Huffman tree that leaves codes uncovered** (`chd/huffman-uncovered-codes`): the lookup table's
  entries no code covers were never set, and decoding took bit counts from whatever that memory held,
  then shifted by more than 32 (`huffman.cpp`'s `build_lookup_table`; chdman 0.289 has it).
- **A compressed map of 0 bytes** (`chd/map-length-0`), and metadata of 0 bytes: element 0 of an empty
  vector, which C++ leaves undefined (`chd.cpp`).
- Found while writing the seeds: the bit writer shifted a 32-bit value by 32 when a map has no copies of
  hunks (`bitstream.h`, unused result), and libFLAC added an offset to a null pointer when it doesn't use
  escape codes (`stream_encoder.c`). Neither changes a byte of output.
