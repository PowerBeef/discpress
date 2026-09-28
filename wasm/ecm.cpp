// ECM images (the Error Code Modeler format of Neill Corlett's ecm tools, .ecm): CD images without
// the parts of each sector that can be computed back from its data. The job worker presents the
// image inside to chdman (EcmStore in app/worker.js): a scan of the chunk headers maps the image's
// bytes to the file's, and windows of the image are rebuilt here as chdman reads them.
//
// The format: "ECM\0", chunks, a header with count 0 that ends them, and the EDC of the whole image
// (4 bytes, little-endian). A chunk is a header, a type and a count, then its stored bytes. The
// header's first byte holds the type (bits 0-1) and the low 5 bits of count - 1 (bits 2-6); while
// bit 7 is set another byte follows with the next 7 bits. The types:
//   0: count bytes, stored as they are
//   1: count Mode 1 sectors (2,352 bytes), stored as the 3-byte address and the 2,048 bytes of data;
//      sync, mode, EDC, the 8 zero bytes and ECC are computed
//   2: count Mode 2 Form 1 sectors without their sync and header (2,336 bytes), stored as the 4-byte
//      subheader (its copy is the same) and the 2,048 bytes of data; EDC and ECC are computed, the
//      ECC with a zero header as the standard has it for Mode 2
//   3: count Mode 2 Form 2 sectors, likewise (2,336 bytes), stored as the subheader and 2,324
//      bytes of data; the EDC is computed
// A raw image's Mode 2 sectors are 16 bytes of sync and header stored as they are, then a type 2
// or 3 sector.

#include "cdrom.h"

#include <cstdint>
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

// EDC: a CRC-32 with the polynomial x^32 + x^31 + x^16 + x^15 + x^4 + x^3 + x + 1 (0xd8018001
// reflected), starting from 0 and not inverted. The ECC is the engine's (cdrom_file::ecc_generate).
uint32_t edc_table[8][256];
bool tables_ready = false;

void make_tables()
{
	for (int i = 0; i < 256; i++)
	{
		uint32_t e = i;
		for (int k = 0; k < 8; k++)
			e = (e >> 1) ^ ((e & 1) ? 0xd8018001u : 0);
		edc_table[0][i] = e;
	}
	for (int t = 1; t < 8; t++)
		for (int i = 0; i < 256; i++)
			edc_table[t][i] = (edc_table[t - 1][i] >> 8) ^ edc_table[0][edc_table[t - 1][i] & 0xff];
	tables_ready = true;
}

uint32_t edc_update(uint32_t edc, uint8_t const *p, uint32_t n)
{
	for (; n >= 8; p += 8, n -= 8) // eight bytes at a time ("slicing-by-8")
	{
		uint32_t const x = edc ^ (uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24));
		uint32_t const y = uint32_t(p[4]) | (uint32_t(p[5]) << 8) | (uint32_t(p[6]) << 16) | (uint32_t(p[7]) << 24);
		edc = edc_table[7][x & 0xff] ^ edc_table[6][(x >> 8) & 0xff] ^ edc_table[5][(x >> 16) & 0xff] ^ edc_table[4][x >> 24] ^
			edc_table[3][y & 0xff] ^ edc_table[2][(y >> 8) & 0xff] ^ edc_table[1][(y >> 16) & 0xff] ^ edc_table[0][y >> 24];
	}
	for (; n; p++, n--)
		edc = (edc >> 8) ^ edc_table[0][(edc ^ *p) & 0xff];
	return edc;
}

inline void put_le32(uint8_t *p, uint32_t v)
{
	p[0] = uint8_t(v);
	p[1] = uint8_t(v >> 8);
	p[2] = uint8_t(v >> 16);
	p[3] = uint8_t(v >> 24);
}

uint8_t const sync_pattern[12] = { 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00 };
uint32_t const stored_size[4] = { 1, 3 + 2048, 4 + 2048, 4 + 2324 };
uint32_t const image_size[4] = { 1, 2352, 2336, 2336 };

// one sector of type 1, 2 or 3 at out, from its stored bytes at in
void rebuild_sector(uint32_t type, uint8_t const *in, uint8_t *out)
{
	if (type == 1)
	{
		std::memcpy(out, sync_pattern, 12);
		std::memcpy(out + 12, in, 3);
		out[15] = 1;
		std::memcpy(out + 16, in + 3, 2048);
		put_le32(out + 0x810, edc_update(0, out, 0x810));
		std::memset(out + 0x814, 0, 8);
		cdrom_file::ecc_generate(out);
	}
	else
	{
		// in a whole sector, for the ECC: mode 2, whose header counts as zeros
		uint8_t frame[2352] = { };
		uint8_t *const s = frame + 16;
		uint32_t const data = type == 2 ? 2048 : 2324;
		std::memcpy(s, in, 4);
		std::memcpy(s + 4, in, 4);
		std::memcpy(s + 8, in + 4, data);
		put_le32(s + 8 + data, edc_update(0, s, 8 + data));
		if (type == 2)
		{
			frame[15] = 2;
			cdrom_file::ecc_generate(frame);
		}
		std::memcpy(out, s, 2336);
	}
}

} // anonymous namespace


// Rebuilds out_len bytes of the image at out from the stored bytes at in (in_len of them),
// starting inside a chunk (its type and the sectors, or bytes, of it left) or, with left 0, at a
// header. The windows the job worker asks for start and end on sector boundaries, except inside
// a chunk of type 0. Returns the stored bytes used, or -1 if they are not a valid continuation.
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_ecm_decode(uint8_t const *in, uint32_t in_len, uint8_t *out, uint32_t out_len, uint32_t type, uint32_t left)
{
	if (!tables_ready)
		make_tables();
	uint32_t i = 0, o = 0;
	while (o < out_len)
	{
		if (!left)
		{
			if (i >= in_len)
				return -1;
			uint32_t c = in[i++];
			uint64_t n = (c >> 2) & 0x1f;
			int bits = 5;
			type = c & 3;
			while (c & 0x80)
			{
				if (i >= in_len || bits > 26)
					return -1;
				c = in[i++];
				n |= uint64_t(c & 0x7f) << bits;
				bits += 7;
			}
			if (n >= 0xffffffffu) // the end of the chunks (or a count too large): not inside an image
				return -1;
			left = uint32_t(n) + 1;
		}
		if (type > 3)
			return -1;
		if (type == 0)
		{
			uint32_t const k = left < out_len - o ? left : out_len - o;
			if (in_len - i < k)
				return -1;
			std::memcpy(out + o, in + i, k);
			i += k;
			o += k;
			left -= k;
		}
		else
		{
			if (out_len - o < image_size[type] || in_len - i < stored_size[type])
				return -1;
			rebuild_sector(type, in + i, out + o);
			i += stored_size[type];
			o += image_size[type];
			left--;
		}
	}
	return int(i);
}

// the EDC of the image so far, continued over n more bytes (the file's last 4 bytes hold it for the whole image)
extern "C" EMSCRIPTEN_KEEPALIVE uint32_t wasm_ecm_edc(uint32_t edc, uint8_t const *p, uint32_t n)
{
	if (!tables_ready)
		make_tables();
	return edc_update(edc, p, n);
}
