// What the page does for the engine in the browser, natively, for the fuzzers (tests/fuzz/README.md).
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace fuzzhost {

// how the stand-in for the page's helper workers handles the hunks that extract and verify read
// ahead (chd_file::wasm_read_ahead, app/worker.js's M.rdSubmit): none (chdman decompresses them by
// itself, as without helpers), each one decompressed, one in three failed (as by a helper that traps),
// or all of them answered in the reverse order
enum class helpers { none, all, fail_some, reversed };
void set_helpers(helpers mode);

// runs a chdman command line in this process as the job worker does (app/worker.js's runChdman:
// chdman_begin, then chdman_resume while it pauses, answering the hunks it read ahead in between)
// and returns its exit code. Aborts if chdman pauses again and again with nothing to wait for:
// in the browser it would spin forever.
int run(std::vector<std::string> const &args);

// a new folder of its own for a fuzzer's files, in $TMPDIR (else /dev/shm, else /tmp)
std::string make_dir(char const *name);
void write_file(std::string const &path, uint8_t const *data, size_t size);
void write_file(std::string const &path, std::vector<uint8_t> const &data);

} // namespace fuzzhost
