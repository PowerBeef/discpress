// license:BSD-3-Clause
// copyright-holders:Aaron Giles, Vas Crabb
/***************************************************************************

    hashing.c

    Hashing helper classes.

***************************************************************************/

#include "hashing.h"

#include "multibyte.h"
#include "strformat.h"

#include "eminline.h"

#include <zlib.h>

#include <algorithm>
#include <iomanip>
#include <sstream>


namespace util {

//**************************************************************************
//  INLINE FUNCTIONS
//**************************************************************************

namespace {

//-------------------------------------------------
//  char_to_hex - return the hex value of a
//  character
//-------------------------------------------------

constexpr int char_to_hex(char c)
{
	return
			(c >= '0' && c <= '9') ? (c - '0') :
			(c >= 'a' && c <= 'f') ? (10 + c - 'a') :
			(c >= 'A' && c <= 'F') ? (10 + c - 'A') :
			-1;
}


// Discpress: the 80 rounds unrolled with named variables (upstream indexed an array by i % 5)
#define SHA1_W(i) (w[(i) & 15U] = rotl_32(w[((i) + 13U) & 15U] ^ w[((i) + 8U) & 15U] ^ w[((i) + 2U) & 15U] ^ w[(i) & 15U], 1))
#define SHA1_R0(a, b, c, d, e, i) e += ((b & (c ^ d)) ^ d) + w[i] + 0x5a827999U + rotl_32(a, 5); b = rotl_32(b, 30);
#define SHA1_R1(a, b, c, d, e, i) e += ((b & (c ^ d)) ^ d) + SHA1_W(i) + 0x5a827999U + rotl_32(a, 5); b = rotl_32(b, 30);
#define SHA1_R2(a, b, c, d, e, i) e += (b ^ c ^ d) + SHA1_W(i) + 0x6ed9eba1U + rotl_32(a, 5); b = rotl_32(b, 30);
#define SHA1_R3(a, b, c, d, e, i) e += (((b | c) & d) | (b & c)) + SHA1_W(i) + 0x8f1bbcdcU + rotl_32(a, 5); b = rotl_32(b, 30);
#define SHA1_R4(a, b, c, d, e, i) e += (b ^ c ^ d) + SHA1_W(i) + 0xca62c1d6U + rotl_32(a, 5); b = rotl_32(b, 30);
#define SHA1_5(R, i) R(a, b, c, d, e, i) R(e, a, b, c, d, i + 1) R(d, e, a, b, c, i + 2) R(c, d, e, a, b, i + 3) R(b, c, d, e, a, i + 4)

// w: the block as 16 big-endian words; used as the message schedule, so it is overwritten
inline void sha1_process(std::array<uint32_t, 5> &st, uint32_t *w) noexcept
{
	uint32_t a = st[4], b = st[3], c = st[2], d = st[1], e = st[0];
	SHA1_5(SHA1_R0, 0U) SHA1_5(SHA1_R0, 5U) SHA1_5(SHA1_R0, 10U)
	SHA1_R0(a, b, c, d, e, 15U) SHA1_R1(e, a, b, c, d, 16U) SHA1_R1(d, e, a, b, c, 17U) SHA1_R1(c, d, e, a, b, 18U) SHA1_R1(b, c, d, e, a, 19U)
	SHA1_5(SHA1_R2, 20U) SHA1_5(SHA1_R2, 25U) SHA1_5(SHA1_R2, 30U) SHA1_5(SHA1_R2, 35U)
	SHA1_5(SHA1_R3, 40U) SHA1_5(SHA1_R3, 45U) SHA1_5(SHA1_R3, 50U) SHA1_5(SHA1_R3, 55U)
	SHA1_5(SHA1_R4, 60U) SHA1_5(SHA1_R4, 65U) SHA1_5(SHA1_R4, 70U) SHA1_5(SHA1_R4, 75U)
	st[4] += a; st[3] += b; st[2] += c; st[1] += d; st[0] += e;
}

#undef SHA1_5
#undef SHA1_R4
#undef SHA1_R3
#undef SHA1_R2
#undef SHA1_R1
#undef SHA1_R0
#undef SHA1_W

} // anonymous namespace



//**************************************************************************
//  CONSTANTS
//**************************************************************************

const crc16_t crc16_t::null = { 0 };
const crc32_t crc32_t::null = { 0 };
const md5_t md5_t::null = { { 0 } };
const sha1_t sha1_t::null = { { 0 } };
const sum16_t sum16_t::null = { 0 };



//**************************************************************************
//  SHA-1 HELPERS
//**************************************************************************

//-------------------------------------------------
//  from_string - convert from a string
//-------------------------------------------------

bool sha1_t::from_string(std::string_view string) noexcept
{
	// must be at least long enough to hold everything
	std::fill(std::begin(m_raw), std::end(m_raw), 0);
	if (string.length() < 2 * sizeof(m_raw))
		return false;

	// iterate through our raw buffer
	for (auto &elem : m_raw)
	{
		int const upper = char_to_hex(string[0]);
		int const lower = char_to_hex(string[1]);
		if (upper == -1 || lower == -1)
			return false;
		elem = (upper << 4) | lower;
		string.remove_prefix(2);
	}
	return true;
}


//-------------------------------------------------
//  as_string - convert to a string
//-------------------------------------------------

std::string sha1_t::as_string() const
{
	std::string result(2 * std::size(m_raw), ' ');
	auto it = result.begin();
	for (auto const &elem : m_raw)
	{
		auto const upper = elem >> 4;
		auto const lower = elem & 0x0f;
		*it++ = ((10 > upper) ? '0' : ('a' - 10)) + upper;
		*it++ = ((10 > lower) ? '0' : ('a' - 10)) + lower;
	}
	return result;
}


//-------------------------------------------------
//  reset - prepare to digest a block of data
//-------------------------------------------------

void sha1_creator::reset() noexcept
{
	m_cnt = 0U;
	m_st[0] = 0xc3d2e1f0U;
	m_st[1] = 0x10325476U;
	m_st[2] = 0x98badcfeU;
	m_st[3] = 0xefcdab89U;
	m_st[4] = 0x67452301U;
}


//-------------------------------------------------
//  append - digest a block of data
//-------------------------------------------------

void sha1_creator::append(const void *data, uint32_t length) noexcept
{
#ifdef LSB_FIRST
	constexpr unsigned swizzle = 3U;
#else
	constexpr unsigned swizzle = 0U;
#endif
	auto const *const src = reinterpret_cast<const uint8_t *>(data);
	uint32_t residual = (uint32_t(m_cnt) >> 3) & 63U;
	m_cnt += uint64_t(length) << 3;
	uint32_t offset = 0U;
	if (residual)
	{
		// complete the partial block first
		for ( ; (offset < length) && (residual < 64U); residual++, offset++)
			reinterpret_cast<uint8_t *>(m_buf)[residual ^ swizzle] = src[offset];
		if (residual < 64U)
			return;
		sha1_process(m_st, m_buf);
	}

	// Discpress: whole blocks are read straight from the input as big-endian words
	for ( ; (length - offset) >= 64U; offset += 64U)
	{
		uint32_t w[16];
		for (unsigned i = 0U; i < 16U; i++)
			w[i] = get_u32be(&src[offset + (i << 2)]);
		sha1_process(m_st, w);
	}
	for (residual = 0U; offset < length; residual++, offset++)
		reinterpret_cast<uint8_t *>(m_buf)[residual ^ swizzle] = src[offset];
}


//-------------------------------------------------
//  finish - compute final hash
//-------------------------------------------------

sha1_t sha1_creator::finish() noexcept
{
	const unsigned padlen = 64U - (63U & ((unsigned(m_cnt) >> 3) + 8U));
	uint8_t padbuf[64];
	padbuf[0] = 0x80;
	for (unsigned i = 1U; i < padlen; i++)
		padbuf[i] = 0x00;
	uint8_t lenbuf[8];
	for (unsigned i = 0U; i < 8U; i++)
		lenbuf[i] = uint8_t(m_cnt >> ((7U - i) << 3));
	append(padbuf, padlen);
	append(lenbuf, sizeof(lenbuf));
	sha1_t result;
	for (unsigned i = 0U; i < 20U; i++)
		result.m_raw[i] = uint8_t(m_st[4U - (i >> 2)] >> ((3U - (i & 3)) << 3));
	return result;
}



//**************************************************************************
//  MD-5 HELPERS
//**************************************************************************

//-------------------------------------------------
//  from_string - convert from a string
//-------------------------------------------------

bool md5_t::from_string(std::string_view string) noexcept
{
	// must be at least long enough to hold everything
	std::fill(std::begin(m_raw), std::end(m_raw), 0);
	if (string.length() < 2 * sizeof(m_raw))
		return false;

	// iterate through our raw buffer
	for (auto &elem : m_raw)
	{
		int const upper = char_to_hex(string[0]);
		int const lower = char_to_hex(string[1]);
		if (upper == -1 || lower == -1)
			return false;
		elem = (upper << 4) | lower;
		string.remove_prefix(2);
	}
	return true;
}


//-------------------------------------------------
//  as_string - convert to a string
//-------------------------------------------------

std::string md5_t::as_string() const
{
	std::string result(2 * std::size(m_raw), ' ');
	auto it = result.begin();
	for (auto const &elem : m_raw)
	{
		auto const upper = elem >> 4;
		auto const lower = elem & 0x0f;
		*it++ = ((10 > upper) ? '0' : ('a' - 10)) + upper;
		*it++ = ((10 > lower) ? '0' : ('a' - 10)) + lower;
	}
	return result;
}



//**************************************************************************
//  CRC-32 HELPERS
//**************************************************************************

//-------------------------------------------------
//  from_string - convert from a string
//-------------------------------------------------

bool crc32_t::from_string(std::string_view string) noexcept
{
	// must be at least long enough to hold everything
	m_raw = 0;
	if (string.length() < (2 * sizeof(m_raw)))
		return false;

	// iterate through our raw buffer
	m_raw = 0;
	for (int bytenum = 0; bytenum < sizeof(m_raw) * 2; bytenum++)
	{
		int const nibble = char_to_hex(string[0]);
		if (nibble == -1)
			return false;
		m_raw = (m_raw << 4) | nibble;
		string.remove_prefix(1);
	}
	return true;
}


//-------------------------------------------------
//  as_string - convert to a string
//-------------------------------------------------

std::string crc32_t::as_string() const
{
	return string_format("%08x", m_raw);
}


//-------------------------------------------------
//  append - hash a block of data, appending to
//  the currently-accumulated value
//-------------------------------------------------

void crc32_creator::append(const void *data, uint32_t length) noexcept
{
	m_accum.m_raw = crc32(m_accum, reinterpret_cast<const Bytef *>(data), length);
}



//**************************************************************************
//  CRC-16 HELPERS
//**************************************************************************

//-------------------------------------------------
//  from_string - convert from a string
//-------------------------------------------------

bool crc16_t::from_string(std::string_view string) noexcept
{
	// must be at least long enough to hold everything
	m_raw = 0;
	if (string.length() < (2 * sizeof(m_raw)))
		return false;

	// iterate through our raw buffer
	m_raw = 0;
	for (int bytenum = 0; bytenum < sizeof(m_raw) * 2; bytenum++)
	{
		int const nibble = char_to_hex(string[0]);
		if (nibble == -1)
			return false;
		m_raw = (m_raw << 4) | nibble;
		string.remove_prefix(1);
	}
	return true;
}

/**
 * @fn  std::string crc16_t::as_string() const
 *
 * @brief   -------------------------------------------------
 *            as_string - convert to a string
 *          -------------------------------------------------.
 *
 * @return  a std::string.
 */

std::string crc16_t::as_string() const
{
	return string_format("%04x", m_raw);
}

/**
 * @fn  void crc16_creator::append(const void *data, uint32_t length)
 *
 * @brief   -------------------------------------------------
 *            append - hash a block of data, appending to the currently-accumulated value
 *          -------------------------------------------------.
 *
 * @param   data    The data.
 * @param   length  The length.
 */

namespace {

// Discpress: slice-by-8 tables for CRC-16/CCITT; t[k][x] is the CRC of byte x followed by k zero
// bytes, so eight bytes are folded in at once (t[0] is upstream's byte-at-a-time table)
struct crc16_tables
{
	uint16_t t[8][256];

	constexpr crc16_tables() : t()
	{
		for (unsigned x = 0; x < 256; x++)
		{
			uint16_t crc = uint16_t(x << 8);
			for (int bit = 0; bit < 8; bit++)
				crc = (crc & 0x8000) ? uint16_t((crc << 1) ^ 0x1021) : uint16_t(crc << 1);
			t[0][x] = crc;
		}
		for (unsigned k = 1; k < 8; k++)
			for (unsigned x = 0; x < 256; x++)
				t[k][x] = uint16_t((t[k - 1][x] << 8) ^ t[0][t[k - 1][x] >> 8]);
	}
};

constexpr crc16_tables s_crc16;

} // anonymous namespace

void crc16_creator::append(const void *data, uint32_t length) noexcept
{
	const auto *src = reinterpret_cast<const uint8_t *>(data);
	auto const &t = s_crc16.t;

	// fetch the current value into a local and rip through the source data
	uint16_t crc = m_accum.m_raw;
	for ( ; length >= 8; length -= 8, src += 8)
		crc = t[7][(crc >> 8) ^ src[0]] ^ t[6][(crc & 0xff) ^ src[1]] ^ t[5][src[2]] ^ t[4][src[3]] ^
				t[3][src[4]] ^ t[2][src[5]] ^ t[1][src[6]] ^ t[0][src[7]];
	while (length-- != 0)
		crc = (crc << 8) ^ t[0][(crc >> 8) ^ *src++];
	m_accum.m_raw = crc;
}



//**************************************************************************
//  SUM-16 HELPERS
//**************************************************************************

//-------------------------------------------------
//  from_string - convert from a string
//-------------------------------------------------

bool sum16_t::from_string(std::string_view string) noexcept
{
	// must be at least long enough to hold everything
	m_raw = 0;
	if (string.length() < (2 * sizeof(m_raw)))
		return false;

	// iterate through our raw buffer
	m_raw = 0;
	for (int bytenum = 0; bytenum < sizeof(m_raw) * 2; bytenum++)
	{
		int const nibble = char_to_hex(string[0]);
		if (nibble == -1)
			return false;
		m_raw = (m_raw << 4) | nibble;
		string.remove_prefix(1);
	}
	return true;
}

/**
 * @fn  std::string sum16_t::as_string() const
 *
 * @brief   -------------------------------------------------
 *            as_string - convert to a string
 *          -------------------------------------------------.
 *
 * @return  a std::string.
 */

std::string sum16_t::as_string() const
{
	return string_format("%04x", m_raw);
}

/**
 * @fn  void sum16_creator::append(const void *data, uint32_t length)
 *
 * @brief   -------------------------------------------------
 *            append - sum a block of data, appending to the currently-accumulated value
 *          -------------------------------------------------.
 *
 * @param   data    The data.
 * @param   length  The length.
 */

void sum16_creator::append(const void *data, uint32_t length) noexcept
{
	const auto *src = reinterpret_cast<const uint8_t *>(data);

	// fetch the current value into a local and rip through the source data
	uint16_t sum = m_accum.m_raw;
	while (length-- != 0)
		sum += *src++;
	m_accum.m_raw = sum;
}

} // namespace util
