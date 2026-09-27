// Per-hunk codec economics for CHD, using MAME's own codec classes (chdcodec.cpp).
//
//   harness cd  <raw 2352-byte sector file> [--audio] [--hs N] [--codecs a,b,c] [--limit N]
//   harness dvd <2048-byte sector file>              [--hs N] [--codecs a,b,c] [--limit N]
//
// For every hunk it runs every requested codec (compress + decompress + verify), timing each
// with per-thread CPU time, then reports what chdman's selection rule (smallest output, first
// codec wins ties, uncompressed if nothing is smaller than the hunk) would pick.
// CD hunks are built the way chdman builds them: 8 frames of 2352 data + 96 subcode (zero),
// audio byte-swapped to big endian. Identical hunks are counted once (chdman stores them as
// self-references) and excluded from codec statistics.
#include "chd.h"
#include "chdcodec.h"
#include "cdrom.h"
#include "hashing.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <map>
#include <set>
#include <string>
#include <vector>

static double cpu_now()
{
	timespec ts;
	clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts);
	return ts.tv_sec + ts.tv_nsec * 1e-9;
}

static chd_codec_type tag_of(const std::string &s)
{
	if (s == "none") return CHD_CODEC_NONE;
	return CHD_MAKE_TAG(s[0], s[1], s[2], s[3]);
}

struct codec_stats
{
	std::string name;
	chd_compressor::ptr comp;
	chd_decompressor::ptr decomp;
	double ctime = 0, dtime = 0;
	uint64_t bytes_alone = 0;   // total if this codec were used alone (uncompressed when it fails)
	uint64_t fails = 0, wins = 0, verify_errors = 0;
	double wintime = 0;         // compress time spent on hunks this codec won
};

int main(int argc, char **argv)
{
	if (argc < 3) { fprintf(stderr, "usage: harness cd|dvd file [--audio] [--hs N] [--codecs list] [--limit N]\n"); return 1; }
	std::string kind = argv[1], path = argv[2];
	bool audio = false; uint32_t hs = 0; size_t limit = 0; std::string codecs, dump;
	for (int i = 3; i < argc; i++)
	{
		std::string a = argv[i];
		if (a == "--audio") audio = true;
		else if (a == "--hs") hs = strtoul(argv[++i], nullptr, 0);
		else if (a == "--limit") limit = strtoull(argv[++i], nullptr, 0);
		else if (a == "--codecs") codecs = argv[++i];
		else if (a == "--dump") dump = argv[++i];
	}
	const bool cd = kind == "cd";
	if (!hs) hs = cd ? cdrom_file::FRAMES_PER_HUNK * cdrom_file::FRAME_SIZE : 4096;
	if (codecs.empty()) codecs = cd ? "cdlz,cdzl,cdfl" : "lzma,zlib,huff,flac";
	std::vector<std::string> names;
	for (size_t p = 0; p <= codecs.size(); )
	{
		size_t q = codecs.find(',', p); if (q == std::string::npos) q = codecs.size();
		names.push_back(codecs.substr(p, q - p)); p = q + 1;
	}

	// a throwaway CHD just to give the codecs their hunk size
	chd_codec_type comp4[4] = { 0, 0, 0, 0 };
	for (size_t i = 0; i < names.size() && i < 4; i++) comp4[i] = tag_of(names[i]);
	chd_file chd;
	std::string tmp = "/tmp/harness-" + std::to_string(getpid()) + ".chd";
	auto err = chd.create(tmp, uint64_t(hs) * 16, hs, cd ? cdrom_file::FRAME_SIZE : 2048, comp4);
	if (err) { fprintf(stderr, "create: %s\n", err.message().c_str()); return 1; }

	std::vector<codec_stats> st(names.size());
	for (size_t i = 0; i < names.size(); i++)
	{
		st[i].name = names[i];
		st[i].comp = chd_codec_list::new_compressor(tag_of(names[i]), chd);
		st[i].decomp = chd_codec_list::new_decompressor(tag_of(names[i]), chd);
	}

	FILE *f = fopen(path.c_str(), "rb");
	if (!f) { perror(path.c_str()); return 1; }
	const uint32_t in_unit = cd ? 2352 : 2048, out_unit = cd ? cdrom_file::FRAME_SIZE : 2048;
	const uint32_t units = hs / out_unit;
	std::vector<uint8_t> raw(size_t(units) * in_unit), hunk(hs), buf(hs + 1024), out(hs);
	std::set<std::string> seen;
	FILE *df = dump.empty() ? nullptr : fopen(dump.c_str(), "w");
	if (df) { fprintf(df, "hunk"); for (auto &n : names) fprintf(df, ",%s_len,%s_c,%s_d", n.c_str(), n.c_str(), n.c_str()); fprintf(df, "\n"); }
	uint64_t nhunks = 0, dups = 0, total_best = 0, uncompressed_hunks = 0;
	double total_trial = 0;
	std::map<std::string, uint64_t> best_bytes_by_winner;
	for (;;)
	{
		size_t got = fread(raw.data(), 1, raw.size(), f);
		if (!got) break;
		std::fill(raw.begin() + got, raw.end(), 0);
		std::fill(hunk.begin(), hunk.end(), 0);
		for (uint32_t u = 0; u < units; u++)
		{
			uint8_t *d = &hunk[u * out_unit];
			memcpy(d, &raw[u * in_unit], in_unit);
			if (cd && audio)
				for (uint32_t b = 0; b < 2352; b += 2) std::swap(d[b], d[b + 1]);
		}
		nhunks++;
		util::sha1_creator sh; sh.append(hunk.data(), hs);
		std::string key = sh.finish().as_string();
		if (!seen.insert(key).second) { dups++; if (limit && nhunks >= limit) break; continue; }

		uint32_t best = hs; int winner = -1;
		std::vector<long> lens(st.size(), -1); std::vector<double> cts(st.size(), 0), dts(st.size(), 0);
		for (size_t i = 0; i < st.size(); i++)
		{
			uint32_t len = hs;
			double t0 = cpu_now();
			bool ok = true;
			try { len = st[i].comp->compress(hunk.data(), hs, buf.data()); }
			catch (...) { ok = false; }
			double t1 = cpu_now();
			st[i].ctime += t1 - t0; total_trial += t1 - t0; cts[i] = t1 - t0;
			if (!ok || len >= hs) { st[i].fails++; st[i].bytes_alone += hs; continue; }
			st[i].bytes_alone += len; lens[i] = len;
			double t2 = cpu_now();
			bool vok = true;
			try { st[i].decomp->decompress(buf.data(), len, out.data(), hs); }
			catch (...) { vok = false; }
			dts[i] = cpu_now() - t2; st[i].dtime += dts[i];
			if (!vok || memcmp(out.data(), hunk.data(), hs) != 0) st[i].verify_errors++;
			if (len < best) { best = len; winner = int(i); }
		}
		if (winner < 0) { uncompressed_hunks++; best_bytes_by_winner["none"] += hs; }
		else
		{
			st[winner].wins++;
			best_bytes_by_winner[st[winner].name] += best;
		}
		total_best += best;
		if (df) { fprintf(df, "%llu", (unsigned long long)(nhunks - 1)); for (size_t i = 0; i < st.size(); i++) fprintf(df, ",%ld,%.7f,%.7f", lens[i], cts[i], dts[i]); fprintf(df, "\n"); }
		if (limit && nhunks >= limit) break;
	}
	fclose(f);
	if (df) fclose(df);
	remove(tmp.c_str());

	const uint64_t unique = nhunks - dups;
	const double mb = unique * double(hs) / 1e6;
	printf("{\"kind\":\"%s\",\"file\":\"%s\",\"audio\":%s,\"hunkbytes\":%u,\"hunks\":%llu,\"duplicates\":%llu,"
		"\"input_mb\":%.3f,\"best_bytes\":%llu,\"ratio\":%.4f,\"uncompressed_hunks\":%llu,\"trial_cpu_s\":%.3f,"
		"\"trial_mb_s\":%.3f,\"codecs\":[",
		kind.c_str(), path.c_str(), audio ? "true" : "false", hs, (unsigned long long)nhunks, (unsigned long long)dups,
		mb, (unsigned long long)total_best, total_best / (unique * double(hs)), (unsigned long long)uncompressed_hunks,
		total_trial, mb / total_trial);
	for (size_t i = 0; i < st.size(); i++)
		printf("%s{\"name\":\"%s\",\"wins\":%llu,\"fails\":%llu,\"verify_errors\":%llu,\"alone_bytes\":%llu,\"alone_ratio\":%.4f,"
			"\"compress_cpu_s\":%.3f,\"compress_mb_s\":%.3f,\"decompress_cpu_s\":%.3f,\"decompress_mb_s\":%.3f,\"won_bytes\":%llu}",
			i ? "," : "", st[i].name.c_str(), (unsigned long long)st[i].wins, (unsigned long long)st[i].fails,
			(unsigned long long)st[i].verify_errors, (unsigned long long)st[i].bytes_alone, st[i].bytes_alone / (unique * double(hs)),
			st[i].ctime, mb / st[i].ctime, st[i].dtime, st[i].dtime > 0 ? mb / st[i].dtime : 0.0,
			(unsigned long long)best_bytes_by_winner[st[i].name]);
	printf("]}\n");
	return 0;
}
