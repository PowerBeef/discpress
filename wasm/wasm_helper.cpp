// Browser build helper: lets a secondary WebAssembly instance (running in a
// helper Web Worker) compress CHD hunks exactly the way chd_file_compressor
// would, so the main chdman instance can spread compression over many cores,
// and decompress them for extract and verify.
#include "chd.h"
#include "chdcodec.h"
#include "hashing.h"
#include "ioprocsvec.h"

#include <emscripten.h>

#include <cstring>
#include <memory>
#include <unordered_set>
#include <vector>

namespace {
std::vector<uint8_t> s_store;
std::unique_ptr<chd_file> s_chd;
std::unique_ptr<chd_compressor_group> s_group;
std::vector<uint8_t> s_in, s_out;
uint32_t s_hunkbytes = 0;
std::unordered_set<uint64_t> s_seen; // hashes of hunks this helper already compressed
}

extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_init(uint32_t hunkbytes, uint32_t unitbytes, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3)
{
	try
	{
		chd_codec_type comp[4] = { c0, c1, c2, c3 };
		s_group.reset();
		s_chd.reset();
		s_store.clear();
		s_chd = std::make_unique<chd_file>();
		util::random_read_write::ptr file = std::make_unique<util::vector_read_write_adapter<uint8_t>>(s_store);
		std::error_condition err = s_chd->create(std::move(file), uint64_t(hunkbytes), hunkbytes, unitbytes, comp);
		if (err)
			return -1;
		s_group = std::make_unique<chd_compressor_group>(*s_chd, comp);
		s_hunkbytes = hunkbytes;
		s_seen.clear();
		s_in.assign(hunkbytes, 0);
		s_out.assign(hunkbytes, 0);
		return 0;
	}
	catch (...)
	{
		return -2;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_inbuf() { return s_in.data(); }
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_outbuf() { return s_out.data(); }

// result[0] = compressed length, result[1] = crc16; sha1out receives 20 bytes.
// codecs: the codec slots to try, a bit each (the codec plan; 15 = all).
// returns the codec index (-1 = stored uncompressed)
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_compress(uint32_t *result, uint8_t *sha1out, uint32_t codecs)
{
	result[1] = uint16_t(util::crc16_creator::simple(s_in.data(), s_hunkbytes));
	util::sha1_t const sha1 = util::sha1_creator::simple(s_in.data(), s_hunkbytes);
	std::memcpy(sha1out, sha1.m_raw, sizeof(sha1.m_raw));

	// a repeat of a hunk this helper already handled (earlier in the file) will be
	// stored as a "copy from self" by the writer, so don't waste time compressing it;
	// returns -2 and the writer compresses it itself if it turns out not to be a copy
	uint64_t key;
	std::memcpy(&key, sha1.m_raw, sizeof(key));
	key ^= uint64_t(result[1]) << 48;
	if (!s_seen.insert(key).second)
	{
		result[0] = 0;
		return -2;
	}
	if (s_seen.size() > 262144)
		s_seen.clear();

	uint32_t complen = s_hunkbytes;
	int8_t const compression = s_group->find_best_compressor(s_in.data(), s_out.data(), complen, codecs);
	result[0] = complen;
	return compression;
}


// ---------------------------------------------------------------------------
// Decompression for extract and verify: the job worker hands over a hunk's
// compressed bytes and its codec slot, and gets the hunk back
// (chd_file::wasm_read_ahead). The job worker still checks each hunk's CRC.
// ---------------------------------------------------------------------------

namespace {
std::vector<uint8_t> d_store;
std::unique_ptr<chd_file> d_chd;
chd_decompressor::ptr d_codec[4];
std::vector<uint8_t> d_in, d_out;
uint32_t d_hunkbytes = 0;
}

extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_dinit(uint32_t hunkbytes, uint32_t unitbytes, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3)
{
	try
	{
		// codecs are made for a CHD: a scratch one with the same parameters
		chd_codec_type comp[4] = { c0, c1, c2, c3 };
		for (auto &codec : d_codec)
			codec.reset();
		d_chd.reset();
		d_store.clear();
		d_chd = std::make_unique<chd_file>();
		util::random_read_write::ptr file = std::make_unique<util::vector_read_write_adapter<uint8_t>>(d_store);
		std::error_condition err = d_chd->create(std::move(file), uint64_t(hunkbytes), hunkbytes, unitbytes, comp);
		if (err)
			return -1;
		for (int i = 0; i < 4; i++)
		{
			if (comp[i] && !(d_codec[i] = chd_codec_list::new_decompressor(comp[i], *d_chd)))
				return -1;
		}
		d_hunkbytes = hunkbytes;
		d_in.assign(hunkbytes, 0);
		d_out.assign(hunkbytes, 0);
		return 0;
	}
	catch (...)
	{
		return -2;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_dinbuf() { return d_in.data(); }
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_doutbuf() { return d_out.data(); }

// decompresses length bytes from the input buffer with codec slot 0-3; returns 0, or -1 on failure
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_decompress(uint32_t codec, uint32_t length)
{
	if ((codec > 3) || !d_codec[codec] || (length > d_in.size()))
		return -1;
	try
	{
		d_codec[codec]->decompress(d_in.data(), length, d_out.data(), d_hunkbytes);
		return 0;
	}
	catch (...)
	{
		return -1;
	}
}


// ---------------------------------------------------------------------------
// Raw deflate, for CSO images (compressed ISOs) that the job worker presents to
// chdman as the ISO itself: returns the bytes written to dst, or -1.
// ---------------------------------------------------------------------------
#include <zlib.h>

namespace {
z_stream i_stream;
bool i_ready = false;
}

extern "C" EMSCRIPTEN_KEEPALIVE int wasm_inflate_raw(const uint8_t *src, uint32_t srclen, uint8_t *dst, uint32_t dstlen)
{
	if (!i_ready)
	{
		std::memset(&i_stream, 0, sizeof(i_stream));
		if (inflateInit2(&i_stream, -MAX_WBITS) != Z_OK)
			return -1;
		i_ready = true;
	}
	else if (inflateReset(&i_stream) != Z_OK)
		return -1;
	i_stream.next_in = const_cast<Bytef *>(src);
	i_stream.avail_in = srclen;
	i_stream.next_out = dst;
	i_stream.avail_out = dstlen;
	int const err = inflate(&i_stream, Z_FINISH);
	if ((err != Z_STREAM_END) && !((err == Z_BUF_ERROR || err == Z_OK) && (i_stream.avail_out == 0)))
		return -1;
	return int(dstlen - i_stream.avail_out);
}


// ---------------------------------------------------------------------------
// Probe API: read sectors from an existing CHD so the page can identify the
// game (system, serial, title) without extracting it.
// ---------------------------------------------------------------------------
#include "cdrom.h"

namespace {
std::unique_ptr<chd_file> p_chd;
std::unique_ptr<cdrom_file> p_cd;
}

// returns 1 = CD/GD-ROM, 2 = other (DVD, HD, raw), -1 = cannot open, -2 = needs parent
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_probe_open(const char *path)
{
	p_cd.reset();
	p_chd.reset();
	try
	{
		p_chd = std::make_unique<chd_file>();
		std::error_condition err = p_chd->open(path);
		if (err == chd_file::error::REQUIRES_PARENT)
			return -2;
		if (err)
			return -1;
		if (!p_chd->check_is_cd() || !p_chd->check_is_gd())
		{
			p_cd = std::make_unique<cdrom_file>(p_chd.get());
			return 1;
		}
		return 2;
	}
	catch (...)
	{
		p_cd.reset();
		return p_chd && p_chd->opened() ? 2 : -1;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE int wasm_probe_tracks()
{
	return p_cd ? p_cd->get_last_track() : 0;
}

// out[0]=type, out[1]=frames, out[2]=pregap, out[3]=datasize, out[4]=gdrom flag
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_probe_track_info(int track, uint32_t *out)
{
	if (!p_cd || track < 0 || track >= p_cd->get_last_track())
		return -1;
	const cdrom_file::track_info &t = p_cd->get_toc().tracks[track];
	out[0] = t.trktype;
	out[1] = t.frames;
	out[2] = t.pregap;
	out[3] = t.datasize;
	out[4] = p_cd->is_gdrom() ? 1 : 0;
	return 0;
}

// reads 2048 bytes of user data: sector lba of a CD track (counted from index 1),
// or byte offset lba*2048 for DVD/raw CHDs (track ignored)
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_probe_read(int track, uint32_t lba, uint8_t *out)
{
	try
	{
		if (p_cd)
		{
			if (track < 0 || track >= p_cd->get_last_track())
				return -1;
			if (p_cd->get_track_type(track) == cdrom_file::CD_TRACK_AUDIO)
				return -1;
			return p_cd->read_data(p_cd->get_track_start(track) + lba, out, cdrom_file::CD_TRACK_MODE1) ? 0 : -1;
		}
		if (!p_chd)
			return -1;
		uint64_t offset = uint64_t(lba) * 2048;
		if (offset + 2048 > p_chd->logical_bytes())
			return -1;
		return p_chd->read_bytes(offset, out, 2048) ? -1 : 0;
	}
	catch (...)
	{
		return -1;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE double wasm_probe_logical()
{
	return p_chd ? double(p_chd->logical_bytes()) : 0;
}
