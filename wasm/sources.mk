# The chdman engine (engine/mame, see engine/README.md): chdman and exactly the parts of MAME it links.
# M can point at a MAME 0.289 checkout instead, with UPSTREAM=1 (scripts/build-upstream.sh).
M ?= $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../engine/mame)
UTIL := avhuff aviio bitmap cdrom chd chdcodec corefile corestr flac hashing huffman ioprocs palette path strformat unicode vbiparse vecstream
UTIL_SRC := $(addprefix $(M)/src/lib/util/,$(addsuffix .cpp,$(UTIL)))
OSD_SRC := $(addprefix $(M)/src/osd/,osdcore.cpp strconv.cpp osdsync.cpp modules/lib/osdlib_unix.cpp modules/file/posixfile.cpp modules/file/posixptty.cpp modules/file/posixsocket.cpp)
TOOL_SRC := $(M)/src/tools/chdman.cpp version.cpp wasm_helper.cpp
ZLIB_SRC := $(addprefix $(M)/3rdparty/zlib/,adler32.c crc32.c deflate.c inffast.c inflate.c inftrees.c trees.c zutil.c)
ZSTD_SRC := $(addprefix $(M)/3rdparty/zstd/lib/,common/entropy_common.c common/error_private.c common/fse_decompress.c common/pool.c common/xxhash.c common/zstd_common.c compress/fse_compress.c compress/hist.c compress/huf_compress.c compress/zstd_compress.c compress/zstd_compress_literals.c compress/zstd_compress_sequences.c compress/zstd_compress_superblock.c compress/zstd_double_fast.c compress/zstd_fast.c compress/zstd_lazy.c compress/zstd_ldm.c compress/zstdmt_compress.c compress/zstd_opt.c decompress/huf_decompress.c decompress/zstd_ddict.c decompress/zstd_decompress_block.c decompress/zstd_decompress.c)
FLAC_SRC := $(addprefix $(M)/3rdparty/flac/src/libFLAC/,bitmath.c bitreader.c bitwriter.c cpu.c crc.c fixed.c format.c lpc.c md5.c memory.c stream_decoder.c stream_encoder.c stream_encoder_framing.c window.c)
LZMA_SRC := $(addprefix $(M)/3rdparty/lzma/C/,CpuArch.c LzFind.c LzmaDec.c LzmaEnc.c)
# upstream unicode.cpp still uses utf8proc (the engine dropped the functions that need it)
UTF8_SRC := $(if $(UPSTREAM),$(M)/3rdparty/utf8proc/utf8proc.c)
