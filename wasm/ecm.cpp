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

#include <cstdint>
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

// ---------------------------------------------------------------------------
// EDC: a CRC-32 with the polynomial x^32 + x^31 + x^16 + x^15 + x^4 + x^3 + x + 1 (0xd8018001
// reflected), starting from 0 and not inverted. ECC: the P and Q Reed-Solomon codes of ECMA-130
// annex A over GF(2^8) with x^8 + x^4 + x^3 + x^2 + 1.
// ---------------------------------------------------------------------------
uint32_t edc_table[8][256];
uint8_t gf_mul2[256];   // x * 2
uint8_t gf_div3[256];   // x / 3
bool tables_ready = false;

void make_tables()
{
	for (int i = 0; i < 256; i++)
	{
		uint32_t e = i;
		for (int k = 0; k < 8; k++)
			e = (e >> 1) ^ ((e & 1) ? 0xd8018001u : 0);
		edc_table[0][i] = e;
		uint8_t const m = uint8_t((i << 1) ^ ((i & 0x80) ? 0x1d : 0));
		gf_mul2[i] = m;
		gf_div3[i ^ m] = uint8_t(i); // i * 3 is i ^ i * 2
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

inline uint64_t load64(uint8_t const *p)
{
	uint64_t v;
	std::memcpy(&v, p, 8);
	return v;
}

// eight bytes, each multiplied by 2 in GF(2^8)
inline uint64_t mul2x8(uint64_t a)
{
	uint64_t const high = a & 0x8080808080808080ull;
	return ((a & 0x7f7f7f7f7f7f7f7full) << 1) ^ ((high >> 7) * 0x1d);
}

// Each parity pair (p0, p1) of a vector x[0..n) is a = sum x[k] * 2^(n-k), b = sum x[k], then
// p0 = (a * 2 + b) / 3 and p1 = p0 + b. The vectors of a code are independent, so eight of them
// are computed at once in 64-bit words, one byte each. `a` and `b` are their words; the parity
// goes to out[0..count) (p0) and out[count..2 * count) (p1).
void finish_parity(uint64_t const *a, uint64_t const *b, int count, uint8_t *out)
{
	uint8_t av[88], bv[88];
	std::memcpy(av, a, (count + 7) / 8 * 8);
	std::memcpy(bv, b, (count + 7) / 8 * 8);
	for (int i = 0; i < count; i++)
	{
		uint8_t const p0 = gf_div3[gf_mul2[av[i]] ^ bv[i]];
		out[i] = p0;
		out[count + i] = p0 ^ bv[i];
	}
}

// P and Q parity of the region of a sector that starts at its header: the header, then 2,060
// bytes (0x810 of them for Mode 1: data, EDC and the zero bytes), then P, 172 bytes, then Q, 104.
// Viewed as 26 rows of 43 16-bit words (the last two rows being P), P protects the 86 byte
// columns of the first 24 rows, and Q the 52 byte diagonals of all 26 rows (43 words each, one
// per column, each diagonal one row further down per column, wrapping around).
void ecc_region(uint8_t *r)
{
	uint64_t a[11] = {}, b[11] = {};
	for (int row = 0; row < 24; row++)
	{
		uint8_t const *p = r + 86 * row;
		for (int l = 0; l < 11; l++) // the last word reads 2 bytes beyond the row: columns 86 and 87, unused
		{
			uint64_t const x = load64(p + 8 * l);
			a[l] = mul2x8(a[l] ^ x);
			b[l] ^= x;
		}
	}
	finish_parity(a, b, 86, r + 2064);

	uint64_t qa[7] = {}, qb[7] = {};
	uint8_t v[56] = {};
	for (int col = 0; col < 43; col++)
	{
		// diagonal d crosses this column at row d + col (wrapping): gather the column's words in that order
		int row = col % 26;
		for (int d = 0; d < 26; d++)
		{
			std::memcpy(v + 2 * d, r + 86 * row + 2 * col, 2);
			if (++row == 26)
				row = 0;
		}
		for (int l = 0; l < 7; l++)
		{
			uint64_t const x = load64(v + 8 * l);
			qa[l] = mul2x8(qa[l] ^ x);
			qb[l] ^= x;
		}
	}
	finish_parity(qa, qb, 52, r + 2236);
}

// the ECC of a sector's 2,336 bytes after its header, written at data + 0x80c; header nullptr: zeros
void ecc_generate(uint8_t const *header, uint8_t *data)
{
	uint8_t r[2340 + 8];
	if (header)
		std::memcpy(r, header, 4);
	else
		std::memset(r, 0, 4);
	std::memcpy(r + 4, data, 2060);
	std::memset(r + 2064, 0, 8); // read (unused) by the last word of P's last row
	ecc_region(r);
	std::memcpy(data + 0x80c, r + 2064, 172 + 104);
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
		ecc_generate(out + 12, out + 16);
	}
	else
	{
		uint32_t const data = type == 2 ? 2048 : 2324;
		std::memcpy(out, in, 4);
		std::memcpy(out + 4, in, 4);
		std::memcpy(out + 8, in + 4, data);
		put_le32(out + 8 + data, edc_update(0, out, 8 + data));
		if (type == 2)
			ecc_generate(nullptr, out);
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
