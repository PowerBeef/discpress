// Fuzzer: a CHD file, read the ways the page reads one it is given (tests/fuzz/README.md).
// Identification first (wasm/wasm_helper.cpp's probe functions, as app/ident.js uses them: the
// tracks, the first sectors, the volume descriptor and the directory it points to), then, for a
// CHD small enough to read whole quickly, the commands that read a CHD: info, verify and every
// extract command, with the hunks they read ahead going to helper workers in one of four ways
// (tests/fuzz/host.cpp).

#include "host.h"

#include "chd.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <string>

extern "C" {
int wasm_probe_open(const char *path, const char *parent);
int wasm_probe_tracks();
int wasm_probe_track_info(int track, uint32_t *out);
int wasm_probe_read(int track, uint32_t lba, uint8_t *out);
double wasm_probe_logical();
}

namespace {

std::string s_dir;

uint32_t get_le32(uint8_t const *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (uint32_t(p[3]) << 24); }
uint32_t get_be32(uint8_t const *p) { return (uint32_t(p[0]) << 24) | (p[1] << 16) | (p[2] << 8) | p[3]; }
uint64_t get_be64(uint8_t const *p) { return (uint64_t(get_be32(p)) << 32) | get_be32(p + 4); }

// The engine allocates a map entry for every hunk the header claims and buffers of a hunk's size. A
// claim larger than a phone's browser can allocate fails there with std::bad_alloc, an error; but
// AddressSanitizer reports any failed new as a crash, so such inputs are left out.
bool too_large(uint8_t const *d, size_t n)
{
	if ((n < 124) || std::memcmp(d, "MComprHD", 8))
		return false;
	uint64_t hunkbytes, hunks, entrybytes;
	switch (get_be32(&d[12]))
	{
	case 3: hunkbytes = get_be32(&d[76]); hunks = get_be32(&d[24]); entrybytes = 16; break;
	case 4: hunkbytes = get_be32(&d[44]); hunks = get_be32(&d[24]); entrybytes = 16; break;
	case 5:
		hunkbytes = get_be32(&d[56]);
		hunks = hunkbytes ? (get_be64(&d[32]) + hunkbytes - 1) / hunkbytes : 0;
		entrybytes = get_be32(&d[16]) ? 12 : 4;
		break;
	default: return false;
	}
	return (hunkbytes > (64 << 20)) || (hunks * entrybytes > (512 << 20));
}

// the ISO 9660 primary volume descriptor's root directory, as identification follows it
void probe_volume(int track)
{
	uint8_t sector[2048];
	for (uint32_t lba = 0; lba < 18; lba++)
		wasm_probe_read(track, lba, sector);
	if (!wasm_probe_read(track, 16, sector))
	{
		uint32_t const root = get_le32(&sector[158]);
		if (!wasm_probe_read(track, root, sector))
			wasm_probe_read(track, get_le32(&sector[2]), sector);
	}
}

void identify(std::string const &path)
{
	int const kind = wasm_probe_open(path.c_str(), nullptr);
	if (kind == 1)
	{
		int const tracks = std::min(wasm_probe_tracks(), 99);
		for (int t = 0; t < tracks; t++)
		{
			uint32_t info[5];
			if (wasm_probe_track_info(t, info))
				continue;
			probe_volume(t);
			uint8_t sector[2048];
			if (info[1])
				wasm_probe_read(t, info[1] - 1, sector);
			wasm_probe_read(t, info[1], sector);
		}
	}
	else if (kind == 2)
	{
		probe_volume(0);
		double const sectors = wasm_probe_logical() / 2048;
		uint8_t sector[2048];
		if (sectors >= 1)
			wasm_probe_read(0, uint32_t(std::min(sectors - 1, 4e9)), sector);
	}
	wasm_probe_open("", nullptr); // closes it
}

} // anonymous namespace

extern "C" int LLVMFuzzerInitialize(int *, char ***)
{
	s_dir = fuzzhost::make_dir("chd");
	return 0;
}

extern "C" int LLVMFuzzerTestOneInput(uint8_t const *data, size_t size)
{
	if (too_large(data, size))
		return 0;
	std::string const in = s_dir + "/in.chd";
	fuzzhost::write_file(in, data, size);
	identify(in);

	// the commands read all of it: only for a small CHD
	{
		chd_file chd;
		if (chd.open(in))
			return 0;
		if ((chd.logical_bytes() > (8 << 20)) || (chd.hunk_bytes() > (1 << 20)) || (chd.hunk_count() > 32768))
			return 0;
	}
	static fuzzhost::helpers const modes[] = { fuzzhost::helpers::none, fuzzhost::helpers::all, fuzzhost::helpers::fail_some, fuzzhost::helpers::reversed };
	fuzzhost::set_helpers(modes[size % 4]);
	std::string const out = s_dir + "/out";
	fuzzhost::run({ "info", "-i", in, "-v" });
	fuzzhost::run({ "verify", "-i", in });
	fuzzhost::run({ "extractraw", "-i", in, "-o", out + ".raw", "-f" });
	fuzzhost::run({ "extracthd", "-i", in, "-o", out + ".img", "-f" });
	fuzzhost::run({ "extractdvd", "-i", in, "-o", out + ".iso", "-f" });
	fuzzhost::run({ "extractcd", "-i", in, "-o", out + ".cue", "-ob", out + ".bin", "-f" });
	// the other descriptors, split tracks, and the cue sheet and checksums Redump has (app/ui.js's redumpCheck)
	fuzzhost::run({ "extractcd", "-i", in, "-o", out + ".toc", "-f" });
	fuzzhost::run({ "extractcd", "-i", in, "-o", out + ".gdi", "-f" });
	fuzzhost::run({ "extractcd", "-i", in, "-o", out + "-r.cue", "-sb", "--redump", "-f" });
	fuzzhost::run({ "extractld", "-i", in, "-o", out + ".avi", "-f" });
	return 0;
}
