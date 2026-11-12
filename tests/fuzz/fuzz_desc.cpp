// Fuzzer: a disc descriptor or image chdman reads (tests/fuzz/README.md): a cue sheet, a cdrdao TOC,
// a GDI, a Nero image or an ISO. The first byte picks which, and the options; the rest is the file.
// It is parsed (cdrom_file::parse_toc), and if its tracks are short, made into a CD CHD with chdman,
// which is then verified and extracted again. The folder holds the track files the seeds name
// (tests/fuzz/seeds.cpp): t.bin, a.bin, a.wav, odd.bin and empty.bin.

#include "host.h"

#include "cdrom.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::string s_dir;

std::vector<uint8_t> pattern(size_t n, unsigned seed)
{
	std::vector<uint8_t> v(n);
	uint32_t x = seed * 2654435761u + 1;
	for (size_t i = 0; i < n; i++)
	{
		x = x * 1103515245u + 12345u;
		v[i] = uint8_t(x >> 16);
	}
	return v;
}

// a RIFF WAVE file: 16-bit stereo at 44.1 kHz, frames of CD audio
std::vector<uint8_t> wave(uint32_t frames)
{
	uint32_t const bytes = frames * 2352;
	std::vector<uint8_t> v{ 'R','I','F','F', 0,0,0,0, 'W','A','V','E', 'f','m','t',' ', 16,0,0,0, 1,0, 2,0, 0x44,0xac,0,0, 0x10,0xb1,2,0, 4,0, 16,0, 'd','a','t','a', 0,0,0,0 };
	auto put = [&v](size_t at, uint32_t n) { for (int i = 0; i < 4; i++) v[at + i] = uint8_t(n >> (8 * i)); };
	put(4, 36 + bytes);
	put(40, bytes);
	std::vector<uint8_t> const pcm = pattern(bytes, 7);
	v.insert(v.end(), pcm.begin(), pcm.end());
	return v;
}

} // anonymous namespace

extern "C" int LLVMFuzzerInitialize(int *, char ***)
{
	s_dir = fuzzhost::make_dir("desc");
	fuzzhost::write_file(s_dir + "/t.bin", pattern(40 * 2352, 1));
	fuzzhost::write_file(s_dir + "/a.bin", pattern(12 * 2352, 2));
	fuzzhost::write_file(s_dir + "/a.wav", wave(10));
	fuzzhost::write_file(s_dir + "/odd.bin", pattern(1000, 3));
	fuzzhost::write_file(s_dir + "/empty.bin", nullptr, 0);
	return 0;
}

extern "C" int LLVMFuzzerTestOneInput(uint8_t const *data, size_t size)
{
	if (size < 1)
		return 0;
	// a descriptor that names a device or a FIFO would block (the page only ever gives chdman files)
	std::string const text(reinterpret_cast<char const *>(data + 1), size - 1);
	if ((text.find("/dev") != std::string::npos) || (text.find("/proc") != std::string::npos) || (text.find("/sys") != std::string::npos))
		return 0;

	// byte 0: bits 0-2 the kind of file, bit 3 --keepcue, bits 4-5 what extractcd writes, bit 6 compression
	static char const *const kinds[] = { "cue", "toc", "gdi", "nrg", "iso", "cue", "toc", "cue" };
	std::string const kind = kinds[data[0] & 7];
	std::string const in = s_dir + "/in." + kind;
	fuzzhost::write_file(in, data + 1, size - 1);

	cdrom_file::toc toc = {};
	cdrom_file::track_input_info info;
	if (cdrom_file::parse_toc(in, toc, info) || (toc.numtrks == 0))
		return 0;
	// chdman writes every frame the descriptor says the tracks have: only a few of them
	uint64_t frames = 0;
	for (uint32_t t = 0; t < toc.numtrks && t < cdrom_file::MAX_TRACKS; t++)
		frames += uint64_t(toc.tracks[t].frames) + toc.tracks[t].padframes + toc.tracks[t].extraframes + toc.tracks[t].splitframes + toc.tracks[t].pregap + toc.tracks[t].postgap;
	if (frames > 2000)
		return 0;

	std::string const chd = s_dir + "/out.chd", out = s_dir + "/x";
	std::vector<std::string> create{ "createcd", "-i", in, "-o", chd, "-f", "-np", "1", "-c", ((data[0] & 0x40) && frames <= 200) ? "cdlz,cdzl,cdfl" : "none" };
	if ((data[0] & 8) && (kind == "cue"))
		create.push_back("--keepcue");
	if (fuzzhost::run(create) != 0)
		return 0;
	fuzzhost::set_helpers(fuzzhost::helpers::all);
	fuzzhost::run({ "verify", "-i", chd });
	static char const *const outs[] = { ".cue", ".toc", ".gdi", "-r.cue" };
	int const o = (data[0] >> 4) & 3;
	std::vector<std::string> extract{ "extractcd", "-i", chd, "-o", out + outs[o], "-f" };
	if (o == 3)
		extract.insert(extract.end(), { "--redump", "-sb" });
	fuzzhost::run(extract);
	return 0;
}
