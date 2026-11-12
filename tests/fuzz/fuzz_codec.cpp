// Fuzzer: one compressed hunk, decompressed by a codec as a helper worker does for extract and verify
// (wasm/wasm_helper.cpp's wasm_helper_dinit and wasm_helper_decompress; tests/fuzz/README.md). Byte 0
// picks the codec, byte 1 the hunk size; the rest is the hunk's stored bytes.

#include "chd.h"
#include "chdcodec.h"

#include <cstdint>
#include <cstring>

extern "C" {
int wasm_helper_dinit(uint32_t hunkbytes, uint32_t unitbytes, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3);
uint8_t *wasm_helper_dinbuf();
uint8_t *wasm_helper_doutbuf();
int wasm_helper_decompress(uint32_t codec, uint32_t length);
}

// (the order tests/fuzz/seeds.cpp writes its seeds in)
static chd_codec_type const s_codecs[] = { CHD_CODEC_ZLIB, CHD_CODEC_ZSTD, CHD_CODEC_LZMA, CHD_CODEC_HUFFMAN, CHD_CODEC_FLAC,
	CHD_CODEC_CD_ZLIB, CHD_CODEC_CD_ZSTD, CHD_CODEC_CD_LZMA, CHD_CODEC_CD_FLAC, CHD_CODEC_AVHUFF };

extern "C" int LLVMFuzzerTestOneInput(uint8_t const *data, size_t size)
{
	if (size < 2)
		return 0;
	chd_codec_type const codec = s_codecs[data[0] % std::size(s_codecs)];
	bool const cd = (codec == CHD_CODEC_CD_ZLIB) || (codec == CHD_CODEC_CD_ZSTD) || (codec == CHD_CODEC_CD_LZMA) || (codec == CHD_CODEC_CD_FLAC);
	// CD hunks are whole frames of 2,448 bytes; other hunks a multiple of 512 bytes (of 4 for flac's samples)
	uint32_t const unitbytes = cd ? 2448 : 512;
	uint32_t const hunkbytes = (1 + data[1] % 32) * unitbytes;
	if (wasm_helper_dinit(hunkbytes, unitbytes, codec, 0, 0, 0) != 0)
		return 0;
	uint32_t const length = uint32_t(size - 2);
	if (length > hunkbytes) // a helper doesn't take it (the job worker reports it)
		return 0;
	std::memcpy(wasm_helper_dinbuf(), data + 2, length);
	wasm_helper_decompress(0, length);
	return 0;
}
