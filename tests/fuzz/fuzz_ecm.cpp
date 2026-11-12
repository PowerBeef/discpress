// Fuzzer: the stored bytes of an ECM image, rebuilt into CD sectors as the job worker asks for a
// window of the image (wasm/ecm.cpp's wasm_ecm_decode; tests/fuzz/README.md). Byte 0 says where the
// window starts: at a chunk header, or inside a chunk of the type in bits 0-1 with byte 3 sectors
// (or bytes) left in it; bytes 1-2 the window's size in bytes. The rest are the stored bytes, in a
// buffer of exactly their size, as is the window, so that a read or write past either is caught.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

extern "C" {
int wasm_ecm_decode(uint8_t const *in, uint32_t in_len, uint8_t *out, uint32_t out_len, uint32_t type, uint32_t left);
uint32_t wasm_ecm_edc(uint32_t edc, uint8_t const *p, uint32_t n);
}

extern "C" int LLVMFuzzerTestOneInput(uint8_t const *data, size_t size)
{
	if (size < 4)
		return 0;
	uint32_t const type = data[0] & 3;
	uint32_t const left = (data[0] & 4) ? (1 + data[3]) : 0;
	uint32_t const out_len = data[1] | (data[2] << 8);
	std::vector<uint8_t> in(data + 4, data + size), out(out_len);
	int const used = wasm_ecm_decode(in.data(), uint32_t(in.size()), out.data(), out_len, type, left);
	if ((used < -1) || (used > int(in.size())))
	{
		std::fprintf(stderr, "wasm_ecm_decode used %d of %zu bytes\n", used, in.size());
		std::abort();
	}
	if (used >= 0)
		wasm_ecm_edc(0, out.data(), out_len);
	return 0;
}
