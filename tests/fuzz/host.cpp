// The page's side of the engine's browser-only hooks (wasm/par_lib.js and app/worker.js), natively:
// the fuzzers build the engine with __EMSCRIPTEN__ defined (scripts/fuzz.sh) and link this instead of
// the JavaScript. Compression stays in the engine (no helper workers: wasm_par_enabled says no);
// extract and verify hand the hunks they read ahead to "helpers" here, which decompress them with
// wasm/wasm_helper.cpp's functions, as the page's helper workers do, when chdman pauses.

#include "host.h"

#include "chd.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

extern "C" {
// the engine's exports (chdman.cpp, chd.cpp, wasm_helper.cpp)
int chdman_begin(int argc, char *argv[]);
int chdman_resume();
uint8_t *wasm_rd_slot(chd_file *chd, uint32_t hunknum);
void wasm_rd_done(chd_file *chd, uint32_t hunknum, int ok);
int wasm_helper_dinit(uint32_t hunkbytes, uint32_t unitbytes, uint32_t c0, uint32_t c1, uint32_t c2, uint32_t c3);
uint8_t *wasm_helper_dinbuf();
uint8_t *wasm_helper_doutbuf();
int wasm_helper_decompress(uint32_t codec, uint32_t length);
}

namespace {

struct pending
{
	uint32_t hunk;
	uint32_t codec;
	std::vector<uint8_t> data;
};

fuzzhost::helpers s_mode = fuzzhost::helpers::all;
chd_file const *s_chd = nullptr; // the one CHD the helpers decompress for (M.rdSetup: one at a time)
uint32_t s_hunkbytes = 0;
bool s_dead = false; // the helpers' codec setup failed: every hunk comes back failed
std::vector<pending> s_queue;
unsigned s_count = 0;

// answers every hunk handed out so far (app/worker.js: rdDispatch, the helper role's dbatch, rdResult)
bool deliver()
{
	if (s_queue.empty())
		return false;
	std::vector<pending> queue = std::move(s_queue);
	s_queue.clear();
	if (s_mode == fuzzhost::helpers::reversed)
		std::reverse(queue.begin(), queue.end());
	for (pending const &p : queue)
	{
		bool ok = !s_dead && (p.data.size() <= s_hunkbytes);
		if (ok)
		{
			std::memcpy(wasm_helper_dinbuf(), p.data.data(), p.data.size());
			ok = wasm_helper_decompress(p.codec, uint32_t(p.data.size())) == 0;
		}
		if ((s_mode == fuzzhost::helpers::fail_some) && ((s_count++ % 3) == 0))
			ok = false;
		chd_file *const chd = const_cast<chd_file *>(s_chd);
		uint8_t *const slot = ok ? wasm_rd_slot(chd, p.hunk) : nullptr;
		if (slot)
			std::memcpy(slot, wasm_helper_doutbuf(), s_hunkbytes);
		wasm_rd_done(chd, p.hunk, slot ? 1 : 0);
	}
	return true;
}

} // anonymous namespace


// wasm/par_lib.js's functions, as the page answers them
extern "C" {

int wasm_par_enabled(uint32_t, uint32_t, const uint32_t *, uint32_t, uint32_t) { return 0; }

void wasm_par_submit(void *, const uint8_t *, uint32_t, uint32_t)
{
	std::fprintf(stderr, "wasm_par_submit without helpers\n");
	std::abort();
}

int wasm_par_active(void) { return 0; }

int wasm_out_full(void) { return 0; }

int wasm_rd_enabled(const void *chd, uint32_t hunkbytes, uint32_t unitbytes, const uint32_t *compression)
{
	if ((s_mode == fuzzhost::helpers::none) || s_chd)
		return 0;
	for (int i = 0; i < 4; i++)
		if (compression[i] == CHD_MAKE_TAG('a','v','h','u')) // the LaserDisc codec stays with chdman
			return 0;
	s_chd = static_cast<chd_file const *>(chd);
	s_hunkbytes = hunkbytes;
	s_queue.clear();
	// a helper whose setup fails is dropped, and the job worker gets every hunk back failed
	s_dead = wasm_helper_dinit(hunkbytes, unitbytes, compression[0], compression[1], compression[2], compression[3]) != 0;
	return 1;
}

void wasm_rd_submit(const void *chd, uint32_t hunknum, uint32_t codec, const uint8_t *data, uint32_t length)
{
	if (chd != s_chd)
		return;
	s_queue.push_back(pending{ hunknum, codec, std::vector<uint8_t>(data, data + length) });
}

void wasm_rd_close(const void *chd)
{
	if (chd != s_chd)
		return;
	s_queue.clear();
	s_chd = nullptr;
}

} // extern "C"


namespace fuzzhost {

void set_helpers(helpers mode)
{
	s_mode = mode;
}

int run(std::vector<std::string> const &args)
{
	std::vector<std::string> words{ "chdman" };
	words.insert(words.end(), args.begin(), args.end());
	std::vector<char *> argv;
	for (std::string &w : words)
		argv.push_back(w.data());
	argv.push_back(nullptr);
	int code = chdman_begin(int(words.size()), argv.data());
	unsigned idle = 0;
	while (code == -1)
	{
		if (deliver())
			idle = 0;
		else if (++idle > 1000)
		{
			std::fprintf(stderr, "chdman %s keeps pausing with no hunk to wait for\n", args.empty() ? "" : args[0].c_str());
			std::abort();
		}
		code = chdman_resume();
	}
	s_queue.clear();
	return code;
}

std::string make_dir(char const *name)
{
	char const *base = std::getenv("TMPDIR");
	struct stat st;
	if (!base || !*base)
		base = (stat("/dev/shm", &st) == 0) ? "/dev/shm" : "/tmp";
	std::string templ = std::string(base) + "/discpress-" + name + "-XXXXXX";
	if (!mkdtemp(templ.data()))
	{
		std::perror("mkdtemp");
		std::abort();
	}
	return templ;
}

void write_file(std::string const &path, uint8_t const *data, size_t size)
{
	std::FILE *f = std::fopen(path.c_str(), "wb");
	if (!f || (size && std::fwrite(data, 1, size, f) != size) || std::fclose(f))
	{
		std::perror(path.c_str());
		std::abort();
	}
}

void write_file(std::string const &path, std::vector<uint8_t> const &data)
{
	write_file(path, data.data(), data.size());
}

} // namespace fuzzhost
