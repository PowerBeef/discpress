// Writes the fuzzers' seed inputs (scripts/fuzz.sh runs it; tests/fuzz/README.md): small files of
// every kind each fuzzer reads, made with the engine itself, so that fuzzing starts from valid ones.
//
//   seeds <folder>    writes <folder>/chd, desc, codec and ecm

#include "host.h"

#include "cdrom.h"
#include "chd.h"
#include "chdcodec.h"
#include "hashing.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/stat.h>
#include <vector>

extern "C" {
int wasm_helper_init(uint32_t hunkbytes, uint32_t unitbytes, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3, uint32_t flags);
uint8_t *wasm_helper_inbuf();
uint8_t *wasm_helper_outbuf();
int wasm_helper_compress(uint32_t *result, uint8_t *sha1out, uint32_t codecs);
}

namespace {

using bytes = std::vector<uint8_t>;

std::string s_out, s_tmp;
int s_count = 0;

void seed(char const *fuzzer, std::string const &name, bytes const &data)
{
	fuzzhost::write_file(s_out + "/" + fuzzer + "/" + name, data);
	s_count++;
}

bytes text(std::string const &s) { return bytes(s.begin(), s.end()); }

bytes cat(std::initializer_list<bytes> parts)
{
	bytes v;
	for (bytes const &p : parts)
		v.insert(v.end(), p.begin(), p.end());
	return v;
}

bytes noise(size_t n, unsigned seed)
{
	bytes v(n);
	uint32_t x = seed * 2654435761u + 1;
	for (size_t i = 0; i < n; i++)
	{
		x = x * 1103515245u + 12345u;
		v[i] = uint8_t(x >> 16);
	}
	return v;
}

// CD audio: 16-bit stereo, a sine in each channel
bytes sine(size_t n, double hz)
{
	bytes v(n & ~size_t(3));
	for (size_t i = 0; i + 3 < v.size(); i += 4)
	{
		int16_t const l = int16_t(9000 * std::sin(2 * M_PI * hz * double(i / 4) / 44100));
		int16_t const r = int16_t(7000 * std::sin(2 * M_PI * hz * 1.5 * double(i / 4) / 44100));
		v[i] = uint8_t(l); v[i + 1] = uint8_t(l >> 8); v[i + 2] = uint8_t(r); v[i + 3] = uint8_t(r >> 8);
	}
	return v;
}

bytes prose(size_t n)
{
	std::string const s = "The quick brown fox jumps over the lazy dog; PACK YOUR BOX WITH FIVE DOZEN LIQUOR JUGS. ";
	bytes v(n);
	for (size_t i = 0; i < n; i++)
		v[i] = uint8_t(s[i % s.size()]);
	return v;
}

void put_le32(uint8_t *p, uint32_t n) { for (int i = 0; i < 4; i++) p[i] = uint8_t(n >> (8 * i)); }
void put_be32(uint8_t *p, uint32_t n) { for (int i = 0; i < 4; i++) p[i] = uint8_t(n >> (24 - 8 * i)); }
void put_be64(uint8_t *p, uint64_t n) { for (int i = 0; i < 8; i++) p[i] = uint8_t(n >> (56 - 8 * i)); }
uint8_t bcd(unsigned n) { return uint8_t(((n / 10) << 4) | (n % 10)); }

// 2048-byte sectors of an ISO 9660 volume: its primary volume descriptor at 16 and a root directory
// at 18 that names one file, as identification reads them (app/ident.js); at least 21 sectors
bytes iso(unsigned sectors)
{
	sectors = std::max(sectors, 21u);
	bytes v = prose(size_t(sectors) * 2048);
	std::fill(v.begin(), v.begin() + 16 * 2048, 0);
	uint8_t *const pvd = &v[16 * 2048];
	std::memset(pvd, ' ', 2048);
	pvd[0] = 1;
	std::memcpy(pvd + 1, "CD001", 5);
	pvd[6] = 1;
	std::memcpy(pvd + 40, "DISCPRESS_FUZZ", 14);
	put_le32(pvd + 80, sectors);
	uint8_t *const root = pvd + 156;
	std::memset(root, 0, 34);
	root[0] = 34;
	put_le32(root + 2, 18);
	put_le32(root + 10, 2048);
	root[25] = 2;
	root[32] = 1;
	uint8_t *const dir = &v[18 * 2048];
	std::memset(dir, 0, 2048);
	uint8_t const file[] = "SYSTEM.CNF;1";
	dir[0] = uint8_t(33 + sizeof(file) - 1 + 1);
	put_le32(dir + 2, 20);
	put_le32(dir + 10, 64);
	dir[32] = sizeof(file) - 1;
	std::memcpy(dir + 33, file, sizeof(file) - 1);
	std::memcpy(&v[20 * 2048], "BOOT2 = cdrom0:\\SLUS_999.99;1\r\n", 31);
	return v;
}

// raw Mode 1 sectors (2,352 bytes) of 2048-byte sectors, with their ECC, as on a CD image
bytes mode1(bytes const &user, unsigned first_lba = 150)
{
	size_t const n = user.size() / 2048;
	bytes v(n * 2352);
	for (size_t s = 0; s < n; s++)
	{
		uint8_t *const p = &v[s * 2352];
		p[0] = 0;
		std::memset(p + 1, 0xff, 10);
		p[11] = 0;
		unsigned const lba = first_lba + unsigned(s);
		p[12] = bcd(lba / 75 / 60);
		p[13] = bcd(lba / 75 % 60);
		p[14] = bcd(lba % 75);
		p[15] = 1;
		std::memcpy(p + 16, &user[s * 2048], 2048);
		cdrom_file::ecc_generate(p);
	}
	return v;
}

void make_chd(std::string const &name, std::vector<std::string> const &args)
{
	std::string const out = s_tmp + "/" + name;
	std::vector<std::string> full = args;
	full.insert(full.end(), { "-o", out, "-f" });
	if (fuzzhost::run(full) != 0)
	{
		std::fprintf(stderr, "seeds: chdman %s for %s failed\n", args[0].c_str(), name.c_str());
		std::exit(1);
	}
	std::FILE *f = std::fopen(out.c_str(), "rb");
	bytes v;
	int c;
	while ((c = std::fgetc(f)) != EOF)
		v.push_back(uint8_t(c));
	std::fclose(f);
	seed("chd", name, v);
}

// A v3 or v4 CHD, which chdman 0.289 can read but no longer writes: uncompressed hunks, a "mini"
// hunk (8 bytes repeated), and a copy of another hunk
bytes old_chd(int version, uint32_t hunkbytes)
{
	uint32_t const headerbytes = (version == 3) ? 120 : 108;
	bytes const data = cat({ prose(hunkbytes), noise(hunkbytes, 9) });
	uint32_t const hunks = 4;
	bytes v(headerbytes + 16 * hunks);
	std::memcpy(&v[0], "MComprHD", 8);
	put_be32(&v[8], headerbytes);
	put_be32(&v[12], version);
	put_be32(&v[16], 0);                      // flags
	put_be32(&v[20], 0);                      // no compression
	put_be32(&v[24], hunks);
	put_be64(&v[28], uint64_t(hunks) * hunkbytes);
	put_be64(&v[36], 0);                      // no metadata
	put_be32(&v[(version == 3) ? 76 : 44], hunkbytes);
	uint64_t const at = v.size();
	for (uint32_t h = 0; h < hunks; h++)
	{
		uint8_t *const e = &v[headerbytes + 16 * h];
		if (h < 2)
		{
			put_be64(e, at + uint64_t(h) * hunkbytes);
			put_be32(e + 8, util::crc32_creator::simple(&data[h * hunkbytes], hunkbytes));
			e[12] = uint8_t(hunkbytes >> 8);
			e[13] = uint8_t(hunkbytes);
			e[14] = uint8_t(hunkbytes >> 16);
			e[15] = 2;                            // uncompressed
		}
		else if (h == 2)
		{
			std::memcpy(e, "MINIMINI", 8);        // the data, repeated
			e[15] = 3 | 0x10;                     // mini, no CRC
		}
		else
		{
			put_be64(e, 0);                       // a copy of hunk 0
			e[15] = 4 | 0x10;
		}
	}
	v.insert(v.end(), data.begin(), data.end());
	return v;
}

void chd_seeds()
{
	// raw data of every kind a codec wins on, and a hunk that repeats one (a copy in the map)
	bytes const raw = cat({ bytes(4096, 0), prose(4096), sine(8192, 440), noise(4096, 1), prose(4096), iso(21) });
	fuzzhost::write_file(s_tmp + "/raw.bin", raw);
	for (char const *codec : { "none", "zlib", "zstd", "lzma", "huff", "flac", "lzma,zlib,huff,flac" })
	{
		std::string name = std::string("raw-") + codec + ".chd";
		std::replace(name.begin(), name.end(), ',', '+');
		make_chd(name, { "createraw", "-i", s_tmp + "/raw.bin", "-hs", "4096", "-us", "512", "-np", "1", "-c", codec });
	}
	make_chd("hd.chd", { "createhd", "-i", s_tmp + "/raw.bin", "-np", "1", "-c", "zlib" });
	fuzzhost::write_file(s_tmp + "/dvd.iso", iso(40));
	make_chd("dvd.chd", { "createdvd", "-i", s_tmp + "/dvd.iso", "-np", "1" });
	make_chd("dvd-zstd.chd", { "createdvd", "-i", s_tmp + "/dvd.iso", "-np", "1", "-c", "zstd" });

	// a CD: a data track with an ISO 9660 volume and an audio track
	fuzzhost::write_file(s_tmp + "/data.bin", mode1(iso(24)));
	fuzzhost::write_file(s_tmp + "/audio.bin", sine(12 * 2352, 330));
	fuzzhost::write_file(s_tmp + "/cd.cue", text("FILE \"data.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n"
		"FILE \"audio.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:02\n"));
	make_chd("cd.chd", { "createcd", "-i", s_tmp + "/cd.cue", "-np", "1" });
	make_chd("cd-keepcue.chd", { "createcd", "-i", s_tmp + "/cd.cue", "-np", "1", "--keepcue", "-c", "cdzl,cdfl" });
	make_chd("cd-zstd.chd", { "createcd", "-i", s_tmp + "/cd.cue", "-np", "1", "-c", "cdzs" });
	make_chd("cd-none.chd", { "createcd", "-i", s_tmp + "/cd.cue", "-np", "1", "-c", "none" });
	// a GD-ROM: its high-density area from LBA 45,000
	fuzzhost::write_file(s_tmp + "/gd.gdi", text("3\n1 0 4 2352 data.bin 0\n2 600 0 2352 audio.bin 0\n3 45000 4 2352 data.bin 0\n"));
	make_chd("gd.chd", { "createcd", "-i", s_tmp + "/gd.gdi", "-np", "1" });

	seed("chd", "v3.chd", old_chd(3, 1024));
	seed("chd", "v4.chd", old_chd(4, 2048));
}

// a Nero image: two tracks, then their list (a DAOX chunk) and the footer that points at it
bytes nero()
{
	bytes const t1 = mode1(iso(20)), t2 = sine(10 * 2352, 220);
	auto be = [](uint64_t n, int k) { bytes v(k); for (int i = 0; i < k; i++) v[i] = uint8_t(n >> (8 * (k - 1 - i))); return v; };
	uint64_t const end1 = t1.size(), end2 = t1.size() + t2.size();
	bytes body = cat({ be(0, 4), bytes(13), bytes(1), be(0x2001, 2), bytes{ 1, 2 } });
	struct { uint32_t mode; uint64_t i0, i1, end; } const tracks[] = { { 0x600, 0, 0, end1 }, { 0x700, end1, end1 + 2 * 2352, end2 } };
	for (auto const &t : tracks)
		body = cat({ body, bytes(12), be(2352, 2), be(t.mode, 2), bytes(2), be(t.i0, 8), be(t.i1, 8), be(t.end, 8) });
	bytes const chain = cat({ text("DAOX"), be(body.size(), 4), body, text("END!"), be(0, 4) });
	return cat({ t1, t2, chain, text("NER5"), be(end2, 8) });
}

void desc_seeds()
{
	// byte 0: the kind (0 cue, 1 toc, 2 gdi, 3 nrg, 4 iso), 8 --keepcue, 0x10-0x30 the extracted descriptor, 0x40 compression
	auto put = [](std::string const &name, uint8_t kind, std::string const &s) { seed("desc", name, cat({ bytes{ kind }, text(s) })); };
	put("two-files.cue", 0x00, "FILE \"t.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"a.bin\" BINARY\n  TRACK 02 AUDIO\n    PREGAP 00:00:02\n    INDEX 01 00:00:00\n");
	put("one-file.cue", 0x48, "FILE \"t.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:20\n    INDEX 01 00:00:30\n    POSTGAP 00:00:05\n");
	put("wave.cue", 0x10, "FILE \"a.wav\" WAVE\n  TRACK 01 AUDIO\n    FLAGS DCP PRE\n    INDEX 01 00:00:00\n");
	put("motorola.cue", 0x20, "FILE \"a.bin\" MOTOROLA\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n");
	put("sessions.cue", 0x30, "REM SESSION 01\nFILE \"a.bin\" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\nREM SESSION 02\nREM LEAD-OUT 00:00:02\nFILE \"t.bin\" BINARY\n  TRACK 02 MODE1/2352\n    INDEX 01 00:00:00\n");
	put("gdi.cue", 0x60, "REM SINGLE-DENSITY AREA\nFILE \"t.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"a.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:00:02\n"
		"REM HIGH-DENSITY AREA\nFILE \"t.bin\" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:00\n");
	put("cooked.cue", 0x00, "FILE \"odd.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\nFILE 'a.bin' BINARY\n  TRACK 02 MODE2/2336\n    INDEX 01 00:00:00\nFILE \"t.bin\" BINARY\n  TRACK 03 CDI/2352\n    INDEX 01 00:00:00\n");
	put("lower.cue", 0x40, "file \"a.bin\" binary\r\n  track 01 audio\r\n    index 01 00:00:00\r\n");
	put("cdrdao.toc", 0x01, "CD_ROM\n// a comment\nTRACK MODE1_RAW\nDATAFILE \"t.bin\" #0 00:00:20\nTRACK AUDIO\nTWO_CHANNEL_AUDIO\nSILENCE 00:00:10\nFILE \"a.bin\" 0 00:00:10\nSTART 00:00:05\n");
	put("xa.toc", 0x51, "CD_ROM_XA\nTRACK MODE2_RAW\nDATAFILE \"t.bin\"\nTRACK AUDIO\nPREGAP 00:00:02\nZERO 00:00:03\nFILE \"a.bin\" 0\n");
	put("da.toc", 0x21, "CD_DA\nTRACK AUDIO\nCOPY\nPRE_EMPHASIS\nFILE \"a.bin\" #2352 00:00:05\nINDEX 00:00:02\nTRACK AUDIO\nFILE \"a.wav\" 0\n");
	put("cooked.toc", 0x01, "CD_ROM\nTRACK MODE1\nDATAFILE \"odd.bin\"\nTRACK MODE1_RAW RW_RAW\nDATAFILE \"t.bin\" 00:00:04\n");
	put("three.gdi", 0x02, "3\n1 0 4 2352 t.bin 0\n2 600 0 2352 a.bin 0\n3 45000 4 2352 t.bin 0\n");
	put("quoted.gdi", 0x22, "2\r\n1 0 4 2048 \"odd.bin\" 0\r\n2 150 0 2352 \"a.bin\" 0\r\n");
	seed("desc", "image.nrg", cat({ bytes{ 0x03 }, nero() }));
	seed("desc", "image.iso", cat({ bytes{ 0x04 }, iso(20) }));
	seed("desc", "raw.iso", cat({ bytes{ 0x04 }, mode1(iso(20)) }));
}

void codec_seeds()
{
	// (the order of fuzz_codec.cpp's list)
	chd_codec_type const codecs[] = { CHD_CODEC_ZLIB, CHD_CODEC_ZSTD, CHD_CODEC_LZMA, CHD_CODEC_HUFFMAN, CHD_CODEC_FLAC,
		CHD_CODEC_CD_ZLIB, CHD_CODEC_CD_ZSTD, CHD_CODEC_CD_LZMA, CHD_CODEC_CD_FLAC };
	uint32_t const frames = 8, cdbytes = frames * 2448, bytes512 = 8 * 512;
	// CD hunks: frames of 2,352 bytes, each with 96 bytes of subchannel data
	auto cdhunk = [](bytes const &sectors) {
		bytes v;
		for (size_t f = 0; f + 2352 <= sectors.size(); f += 2352)
		{
			v.insert(v.end(), sectors.begin() + f, sectors.begin() + f + 2352);
			v.insert(v.end(), 96, 0);
		}
		return v;
	};
	bytes const sectors = mode1(iso(24)); // from the volume descriptor on
	std::vector<std::pair<char const *, bytes>> const cd = { { "data", cdhunk(bytes(sectors.begin() + 16 * 2352, sectors.end())) }, { "audio", cdhunk(sine(frames * 2352, 500)) } };
	std::vector<std::pair<char const *, bytes>> const other = { { "prose", prose(bytes512) }, { "audio", sine(bytes512, 440) }, { "mixed", cat({ bytes(1024, 0), prose(1024), noise(2048, 3) }) } };
	for (size_t c = 0; c < std::size(codecs); c++)
	{
		bool const iscd = c >= 5;
		for (auto const &[what, hunk] : iscd ? cd : other)
		{
			uint32_t const hunkbytes = iscd ? cdbytes : bytes512;
			if (wasm_helper_init(hunkbytes, iscd ? 2448 : 512, codecs[c], 0, 0, 0, 0))
				continue;
			std::memcpy(wasm_helper_inbuf(), hunk.data(), hunkbytes);
			uint32_t result[2];
			uint8_t sha1[20];
			if (wasm_helper_compress(result, sha1, 1) != 0)
				continue; // stored as it is: no seed
			bytes const comp(wasm_helper_outbuf(), wasm_helper_outbuf() + result[0]);
			char name[64];
			std::snprintf(name, sizeof(name), "%zu-%s", c, what);
			seed("codec", name, cat({ bytes{ uint8_t(c), uint8_t(frames - 1) }, comp }));
		}
	}
}

// an ECM chunk header: the type, then count - 1, 5 bits and then 7 at a time
bytes ecm_header(uint32_t type, uint32_t count)
{
	uint32_t n = count - 1;
	bytes v{ uint8_t(type | ((n & 0x1f) << 2)) };
	n >>= 5;
	while (n)
	{
		v.back() |= 0x80;
		v.push_back(uint8_t(n & 0x7f));
		n >>= 7;
	}
	return v;
}

void ecm_seeds()
{
	// bytes 0-3: the type and "inside a chunk" (4), the window's size, the sectors or bytes left
	auto put = [](std::string const &name, uint8_t mode, uint32_t window, uint8_t left, bytes const &stored) {
		seed("ecm", name, cat({ bytes{ mode, uint8_t(window), uint8_t(window >> 8), left }, stored }));
	};
	bytes const mode1x2 = noise(2 * (3 + 2048), 4), form1 = noise(4 + 2048, 5), form2 = noise(4 + 2324, 6);
	put("bytes", 0, 100, 0, cat({ ecm_header(0, 100), prose(100) }));
	put("mode1", 0, 2 * 2352, 0, cat({ ecm_header(1, 2), mode1x2 }));
	put("form1", 0, 2336, 0, cat({ ecm_header(2, 1), form1 }));
	put("form2", 0, 2336, 0, cat({ ecm_header(3, 1), form2 }));
	put("mixed", 0, 16 + 2336 + 2352, 0, cat({ ecm_header(0, 16), noise(16, 7), ecm_header(2, 1), form1, ecm_header(1, 1), bytes(mode1x2.begin(), mode1x2.begin() + 2051) }));
	put("inside", 4 | 1, 2 * 2352, 1, mode1x2);
	put("inside-bytes", 4, 50, 49, prose(50));
	put("end", 0, 2352, 0, cat({ bytes{ 0xfc, 0xff, 0xff, 0xff, 0x3f }, bytes(4, 0) }));
}

} // anonymous namespace

int main(int argc, char **argv)
{
	if (argc != 2)
	{
		std::fprintf(stderr, "usage: seeds <folder>\n");
		return 2;
	}
	s_out = argv[1];
	for (char const *d : { "", "/chd", "/desc", "/codec", "/ecm" })
		mkdir((s_out + d).c_str(), 0755);
	s_tmp = fuzzhost::make_dir("seeds");
	chd_seeds();
	desc_seeds();
	codec_seeds();
	ecm_seeds();
	std::printf("%d seeds in %s\n", s_count, s_out.c_str());
	return 0;
}
