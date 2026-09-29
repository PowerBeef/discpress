// A native test tool for tests/ui/engine.spec.js (built by `make -C wasm T=native cdprobe`): reads a CD CHD
// the way the page's identification does (wasm/wasm_helper.cpp, wasm_probe_read), with cdrom_file's logical
// reads, which no chdman command uses. It writes every LBA from 0 to the lead-out as read_data returns it (raw,
// audio big-endian), and prints each track's start, pregap and INDEX 01, then the LBAs where get_track() changes
// and those that fail to read (written as zeros).
//
//   cdprobe <in.chd> <out.raw>

#include "cdrom.h"
#include "chd.h"

#include <cstdio>
#include <vector>

int main(int argc, char **argv)
{
	if (argc != 3)
	{
		std::fprintf(stderr, "usage: cdprobe <in.chd> <out.raw>\n");
		return 2;
	}
	chd_file chd;
	if (chd.open(argv[1]))
	{
		std::fprintf(stderr, "can't open %s\n", argv[1]);
		return 1;
	}
	try
	{
		cdrom_file cd(&chd);
		const cdrom_file::toc &toc = cd.get_toc();
		for (int t = 0; t < toc.numtrks; t++)
			std::printf("track %d index01 %u pregap %u stored %d frames %u\n", t + 1, cd.get_track_start(t), toc.tracks[t].pregap, toc.tracks[t].pgdatasize != 0, toc.tracks[t].frames);
		uint32_t const leadout = cd.get_track_start(0xaa);
		std::printf("leadout %u\n", leadout);
		std::FILE *out = std::fopen(argv[2], "wb");
		if (!out)
			return 1;
		std::vector<uint8_t> sector(cdrom_file::MAX_SECTOR_DATA);
		uint32_t track = ~0U;
		for (uint32_t lba = 0; lba < leadout; lba++)
		{
			std::fill(sector.begin(), sector.end(), 0);
			if (cd.get_track(lba) != track)
			{
				track = cd.get_track(lba);
				std::printf("lba %u track %u\n", lba, track + 1);
			}
			if (!cd.read_data(lba, sector.data(), cdrom_file::CD_TRACK_RAW_DONTCARE))
			{
				std::printf("fail %u\n", lba);
				std::fill(sector.begin(), sector.end(), 0);
			}
			std::fwrite(sector.data(), 1, toc.tracks[track].datasize, out);
		}
		std::fclose(out);
	}
	catch (...)
	{
		std::fprintf(stderr, "not a CD\n");
		return 1;
	}
	return 0;
}
