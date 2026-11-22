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
#include <vector>

namespace {
constexpr uint32_t SEEN_SLOTS = 65536; // 512 KiB direct-mapped dedup cache (16x smaller than unordered_set)
std::vector<uint8_t> s_store;
std::unique_ptr<chd_file> s_chd;
std::unique_ptr<chd_compressor_group> s_group;
std::vector<uint8_t> s_in, s_out;
uint32_t s_hunkbytes = 0;
std::vector<uint64_t> s_seen; // hashes of hunks this helper already compressed
}

// flags: 1 = the deflate codec encodes with libdeflate, as the job's CHD does (chd_file::set_libdeflate)
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_init(uint32_t hunkbytes, uint32_t unitbytes, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3, uint32_t flags)
{
	s_hunkbytes = 0;
	s_group.reset();
	s_chd.reset();
	s_store.clear();
	s_in.clear();
	s_out.clear();
	s_seen.clear();
	if (!hunkbytes || !unitbytes || (hunkbytes % unitbytes))
		return -1;
	try
	{
		chd_codec_type comp[4] = { c0, c1, c2, c3 };
		s_chd = std::make_unique<chd_file>();
		util::random_read_write::ptr file = std::make_unique<util::vector_read_write_adapter<uint8_t>>(s_store);
		std::error_condition err = s_chd->create(std::move(file), uint64_t(hunkbytes), hunkbytes, unitbytes, comp);
		if (err)
		{
			s_chd.reset();
			return -1;
		}
		s_chd->set_libdeflate(flags & 1);
		s_group = std::make_unique<chd_compressor_group>(*s_chd, comp);
		s_in.assign(hunkbytes, 0);
		s_out.assign(hunkbytes, 0);
		s_seen.assign(SEEN_SLOTS, 0);
		s_hunkbytes = hunkbytes;
		return 0;
	}
	catch (...)
	{
		s_hunkbytes = 0;
		s_group.reset();
		s_chd.reset();
		s_in.clear();
		s_out.clear();
		s_seen.clear();
		return -2;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_inbuf() { return s_in.data(); }
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_outbuf() { return s_out.data(); }

// result[0] = compressed length, result[1] = crc16; sha1out receives 20 bytes.
// codecs: the codec slots to try, a bit each (the codec plan; 15 = all).
// returns the codec index (-1 = stored uncompressed, -2 = probable duplicate, -3 = error)
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_compress(uint32_t *result, uint8_t *sha1out, uint32_t codecs)
{
	if (!s_group || !s_hunkbytes || (s_in.size() < s_hunkbytes) || (s_out.size() < s_hunkbytes))
		return -3;
	try
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
		if (key == 0)
			key = 1;
		uint32_t const slot = uint32_t(key ^ (key >> 32)) & (SEEN_SLOTS - 1);
		if (s_seen[slot] == key)
		{
			result[0] = 0;
			return -2;
		}
		s_seen[slot] = key;

		uint32_t complen = s_hunkbytes;
		int8_t const compression = s_group->find_best_compressor(s_in.data(), s_out.data(), complen, codecs);
		result[0] = complen;
		return compression;
	}
	catch (...)
	{
		return -3;
	}
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
	d_hunkbytes = 0;
	for (auto &codec : d_codec)
		codec.reset();
	d_chd.reset();
	d_store.clear();
	d_in.clear();
	d_out.clear();
	if (!hunkbytes || !unitbytes || (hunkbytes % unitbytes))
		return -1;
	try
	{
		// codecs are made for a CHD: a scratch one with the same parameters
		chd_codec_type comp[4] = { c0, c1, c2, c3 };
		d_chd = std::make_unique<chd_file>();
		util::random_read_write::ptr file = std::make_unique<util::vector_read_write_adapter<uint8_t>>(d_store);
		std::error_condition err = d_chd->create(std::move(file), uint64_t(hunkbytes), hunkbytes, unitbytes, comp);
		if (err)
		{
			d_chd.reset();
			return -1;
		}
		for (int i = 0; i < 4; i++)
		{
			if (comp[i] && !(d_codec[i] = chd_codec_list::new_decompressor(comp[i], *d_chd)))
			{
				for (auto &codec : d_codec)
					codec.reset();
				d_chd.reset();
				return -1;
			}
		}
		d_in.assign(hunkbytes, 0);
		d_out.assign(hunkbytes, 0);
		d_hunkbytes = hunkbytes;
		return 0;
	}
	catch (...)
	{
		d_hunkbytes = 0;
		for (auto &codec : d_codec)
			codec.reset();
		d_chd.reset();
		d_in.clear();
		d_out.clear();
		return -2;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_dinbuf() { return d_in.data(); }
extern "C" EMSCRIPTEN_KEEPALIVE uint8_t *wasm_helper_doutbuf() { return d_out.data(); }

// decompresses length bytes from the input buffer with codec slot 0-3; returns 0, or -1 on failure
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_helper_decompress(uint32_t codec, uint32_t length)
{
	if (!d_hunkbytes || (codec > 3) || !d_codec[codec] || (length > d_in.size()) || (d_out.size() < d_hunkbytes))
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
std::unique_ptr<chd_file> p_parent; // the parent CHD a child CHD needs, if it has one
std::unique_ptr<cdrom_file> p_cd;
}

// returns 1 = CD/GD-ROM, 2 = other (DVD, HD, raw), -1 = cannot open, -2 = needs parent
// parent: the path of the child's parent CHD, or null
extern "C" EMSCRIPTEN_KEEPALIVE int wasm_probe_open(const char *path, const char *parent)
{
	p_cd.reset();
	p_chd.reset();
	p_parent.reset();
	try
	{
		if (parent && *parent)
		{
			p_parent = std::make_unique<chd_file>();
			if (p_parent->open(parent))
				p_parent.reset();
		}
		p_chd = std::make_unique<chd_file>();
		std::error_condition err = p_chd->open(path, false, p_parent.get());
		if (err == chd_file::error::REQUIRES_PARENT)
		{
			p_chd.reset();
			p_parent.reset();
			return -2;
		}
		if (err)
		{
			p_chd.reset();
			p_parent.reset();
			return -1;
		}
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
		if (p_chd && p_chd->opened())
			return 2;
		p_chd.reset();
		p_parent.reset();
		return -1;
	}
}

extern "C" EMSCRIPTEN_KEEPALIVE int wasm_probe_tracks()
{
	return p_cd ? p_cd->get_last_track() : 0;
}

// out[0..9]: type, frames, pregap, datasize, gdrom, subtype, postgap, padframes, pgdatasize, logframeofs
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
	out[5] = t.subtype;
	out[6] = t.postgap;
	out[7] = t.padframes;
	out[8] = t.pgdatasize;
	out[9] = t.logframeofs;
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
			// the sector as stored, then its 2048 bytes of user data: asking read_data for MODE1 only
			// converts from Mode 1 tracks, and gave shifted bytes or nothing for MODE2/2048 and MODE2/2336
			static const int skip[] = { 0, 16, 8, 0, 0, 8, 24 }; // by CD_TRACK_* type, up to MODE2_RAW
			const cdrom_file::track_info &ti = p_cd->get_toc().tracks[track];
			uint32_t const type = ti.trktype;
			if (type > cdrom_file::CD_TRACK_MODE2_RAW || type == cdrom_file::CD_TRACK_MODE2_FORM2)
				return -1;
			uint32_t const stored_pregap = ti.pgdatasize ? ti.pregap : 0;
			uint32_t const track_len = (ti.frames > stored_pregap) ? (ti.frames - stored_pregap) : 0;
			uint32_t const start = p_cd->get_track_start(track);
			if (lba >= track_len || lba > UINT32_MAX - start || ti.datasize < uint32_t(skip[type]) + 2048)
				return -1;
			uint8_t sector[2352] = { };
			if (!p_cd->read_data(start + lba, sector, cdrom_file::CD_TRACK_RAW_DONTCARE))
				return -1;
			memcpy(out, sector + skip[type], 2048);
			return 0;
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
