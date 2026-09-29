// license:BSD-3-Clause
// copyright-holders:Aaron Giles,R. Belmont
/***************************************************************************

    cdrom.c

    Generic MAME CD-ROM utilties - build IDE and SCSI CD-ROMs on top of this

****************************************************************************

    IMPORTANT:
    "physical" block addresses are the actual addresses on the emulated CD.
    "chd" block addresses are the block addresses in the CHD file.
    Because we pad each track to a 4-frame boundary, these addressing
    schemes will differ after track 1!

***************************************************************************/

#include "cdrom.h"

#include "corestr.h"
#include "multibyte.h"
#include "osdfile.h"
#include "path.h"
#include "strformat.h"

#include <cassert>
#include <cstdlib>
#include <cstring>
#include <tuple>
#include <utility>
#include <vector>


/***************************************************************************
    DEBUGGING
***************************************************************************/

/** @brief  The verbose. */
#define VERBOSE (0)
#define EXTRA_VERBOSE (0)

/**
 * @def LOG(x) do
 *
 * @brief   A macro that defines log.
 *
 * @param   x   The void to process.
 */

#define LOG(x) do { if (VERBOSE) { osd_printf_info x; } } while (0)



/***************************************************************************
    INLINE FUNCTIONS
***************************************************************************/

/*-------------------------------------------------
    physical_to_chd_lba - find the CHD LBA
    and the track number
-------------------------------------------------*/

/**
 * @fn  static inline uint32_t physical_to_chd_lba(uint32_t physlba, uint32_t &tracknum)
 *
 * @brief   Physical to chd lba.
 *
 * @param   physlba             The physlba.
 * @param [in,out]  tracknum    The tracknum.
 *
 * @return  An uint32_t.
 */

uint32_t cdrom_file::physical_to_chd_lba(uint32_t physlba, uint32_t &tracknum) const
{
	// loop until our current LBA is less than the start LBA of the next track
	for (int track = 0; track < cdtoc.numtrks; track++)
		if (physlba < cdtoc.tracks[track + 1].physframeofs)
		{
			uint32_t chdlba = physlba - cdtoc.tracks[track].physframeofs + cdtoc.tracks[track].chdframeofs;
			tracknum = track;
			return chdlba;
		}

	return physlba;
}

/*-------------------------------------------------
    logical_to_chd_lba - find the CHD LBA
    and the track number
-------------------------------------------------*/

/**
 * @fn  uint32_t logical_to_chd_lba(uint32_t loglba, uint32_t &tracknum)
 *
 * @brief   Logical to chd lba.
 *
 * @param   loglba              The loglba.
 * @param [in,out]  tracknum    The tracknum.
 *
 * @return  An uint32_t.
 */

uint32_t cdrom_file::logical_to_chd_lba(uint32_t loglba, uint32_t &tracknum) const
{
	// loop until our current LBA is less than the start LBA of the next track
	for (int track = 0; track < cdtoc.numtrks; track++)
	{
		if (loglba < cdtoc.tracks[track + 1].logframeofs)
		{
			// convert to physical and proceed
			uint32_t physlba = cdtoc.tracks[track].physframeofs + (loglba - cdtoc.tracks[track].logframeofs);
			uint32_t chdlba = physlba - cdtoc.tracks[track].physframeofs + cdtoc.tracks[track].chdframeofs;
			tracknum = track;
			return chdlba;
		}
	}

	return loglba;
}


/***************************************************************************
    BASE FUNCTIONALITY
***************************************************************************/

/**
 * @fn  constructor
 *
 * @brief   Open a cdrom for a file.
 *
 * @param   inputfile   The inputfile.
 */

cdrom_file::cdrom_file(std::string_view inputfile)
{
	// set up the CD-ROM module and get the disc info
	std::error_condition err = parse_toc(inputfile, cdtoc, cdtrack_info);
	if (err)
	{
		osd_printf_error("Error reading input file: %s\n", err.message());
		throw nullptr;
	}

	// fill in the data
	chd = nullptr;

	LOG(("CD has %d tracks\n", cdtoc.numtrks));

	for (int i = 0; i < cdtoc.numtrks; i++)
	{
		osd_file::ptr file;
		std::uint64_t length;
		std::error_condition const filerr = osd_file::open(cdtrack_info.track[i].fname, OPEN_FLAG_READ, file, length);
		if (filerr)
		{
			osd_printf_error("Unable to open file: %s\n", cdtrack_info.track[i].fname);
			throw nullptr;
		}
		fhandle[i] = util::osd_file_read(std::move(file));
		if (!fhandle[i])
		{
			osd_printf_error("Unable to open file: %s\n", cdtrack_info.track[i].fname);
			throw nullptr;
		}
	}

	/* calculate the starting frame for each track, keeping in mind that CHDMAN
	   pads tracks out with extra frames to fit 4-frame size boundries
	*/
	uint32_t physofs = 0, logofs = 0;
	for (int i = 0; i < cdtoc.numtrks; i++)
	{
		track_info &track = cdtoc.tracks[i];
		track.logframeofs = 0;

		if (track.pgdatasize == 0)
		{
			logofs += track.pregap;
		}
		else
		{
			track.logframeofs = track.pregap;
		}

		if ((cdtoc.flags & CD_FLAG_MULTISESSION) && (cdtrack_info.track[i].leadin != -1))
			logofs += cdtrack_info.track[i].leadin;

		track.physframeofs = physofs;
		track.chdframeofs = 0;
		track.logframeofs += logofs;
		track.logframes = track.frames - track.pregap;

		// postgap adds to the track length
		logofs += track.postgap;

		physofs += track.frames;
		logofs  += track.frames;

		if ((cdtoc.flags & CD_FLAG_MULTISESSION) && cdtrack_info.track[i].leadout != -1)
			logofs += cdtrack_info.track[i].leadout;

		if (EXTRA_VERBOSE)
		{
			osd_printf_verbose("session %d track %02d is format %d subtype %d datasize %d subsize %d frames %d extraframes %d pregap %d pgmode %d presize %d postgap %d logofs %d physofs %d chdofs %d logframes %d pad %d\n",
					track.session + 1,
					i + 1,
					track.trktype,
					track.subtype,
					track.datasize,
					track.subsize,
					track.frames,
					track.extraframes,
					track.pregap,
					track.pgtype,
					track.pgdatasize,
					track.postgap,
					track.logframeofs,
					track.physframeofs,
					track.chdframeofs,
					track.logframes,
					track.padframes);
		}
	}

	// fill out dummy entries for the last track to help our search
	track_info &track = cdtoc.tracks[cdtoc.numtrks];
	track.physframeofs = physofs;
	track.logframeofs = logofs;
	track.chdframeofs = 0;
	track.logframes = 0;
}

/*-------------------------------------------------
    constructor - "open" a CD-ROM file from an
    already-opened CHD file
-------------------------------------------------*/

/**
 * @fn  cdrom_file *cdrom_open(chd_file *chd)
 *
 * @brief   Queries if a given cdrom open.
 *
 * @param [in,out]  chd If non-null, the chd.
 *
 * @return  null if it fails, else a cdrom_file*.
 */

cdrom_file::cdrom_file(chd_file *_chd)
{
	chd = _chd;

	/* validate the CHD information */
	if (chd->hunk_bytes() % FRAME_SIZE != 0)
		throw nullptr;
	if (chd->unit_bytes() != FRAME_SIZE)
		throw nullptr;

	/* read the CD-ROM metadata */
	std::error_condition err = parse_metadata(chd, cdtoc);
	if (err)
		throw nullptr;

	LOG(("CD has %d tracks\n", cdtoc.numtrks));

	/* calculate the starting frame for each track, keeping in mind that CHDMAN
	   pads tracks out with extra frames to fit 4-frame size boundries
	*/
	uint32_t physofs = 0, chdofs = 0, logofs = 0;
	for (int i = 0; i < cdtoc.numtrks; i++)
	{
		track_info &track = cdtoc.tracks[i];
		track.logframeofs = 0;

		if (track.pgdatasize == 0)
		{
			// Anything that isn't cue.
			// toc (cdrdao): Pregap data seems to be included at the end of previous track.
			// START/PREGAP is only issued in special cases, for instance alongside ZERO commands.
			// ZERO and SILENCE commands are supposed to generate additional data that's not included
			// in the image directly, so the total logofs value must be offset to point to index 1.
			logofs += track.pregap;
		}
		else
		{
			// cues: Pregap is the difference between index 0 and index 1 unless PREGAP is specified.
			// The data is assumed to be in the bin and not generated separately, so the pregap should
			// only be added to the current track's lba to offset it to index 1.
			track.logframeofs = track.pregap;
		}

		track.physframeofs = physofs;
		track.chdframeofs = chdofs;
		track.logframeofs += logofs;
		track.logframes = track.frames - track.pregap;

		// postgap counts against the next track
		logofs += track.postgap;

		physofs += track.frames;
		chdofs  += track.frames;
		chdofs  += track.extraframes;
		logofs  += track.frames;

		if (EXTRA_VERBOSE)
		{
			osd_printf_verbose("session %d track %02d is format %d subtype %d datasize %d subsize %d frames %d extraframes %d pregap %d pgmode %d presize %d postgap %d logofs %d physofs %d chdofs %d logframes %d pad %d\n",
					track.session + 1,
					i + 1,
					track.trktype,
					track.subtype,
					track.datasize,
					track.subsize,
					track.frames,
					track.extraframes,
					track.pregap,
					track.pgtype,
					track.pgdatasize,
					track.postgap,
					track.logframeofs,
					track.physframeofs,
					track.chdframeofs,
					track.logframes,
					track.padframes);
		}
	}

	// fill out dummy entries for the last track to help our search
	track_info &track = cdtoc.tracks[cdtoc.numtrks];
	track.physframeofs = physofs;
	track.logframeofs = logofs;
	track.chdframeofs = chdofs;
	track.logframes = 0;
}


/*-------------------------------------------------
    destructor - "close" a CD-ROM file
-------------------------------------------------*/

cdrom_file::~cdrom_file()
{
	if (chd == nullptr)
	{
		for (int i = 0; i < cdtoc.numtrks; i++)
		{
			fhandle[i].reset();
		}
	}
}



/***************************************************************************
    CORE READ ACCESS
***************************************************************************/

/**
 * @fn  std::error_condition read_partial_sector(void *dest, uint32_t lbasector, uint32_t chdsector, uint32_t tracknum, uint32_t startoffs, uint32_t length, bool phys)
 *
 * @brief   Reads partial sector.
 *
 * @param [in,out]  dest    If non-null, destination for the.
 * @param   lbasector       The lbasector.
 * @param   chdsector       The chdsector.
 * @param   tracknum        The tracknum.
 * @param   startoffs       The startoffs.
 * @param   length          The length.
 * @param   phys            true to physical.
 *
 * @return  The partial sector.
 */

std::error_condition cdrom_file::read_partial_sector(void *dest, uint32_t lbasector, uint32_t chdsector, uint32_t tracknum, uint32_t startoffs, uint32_t length, bool phys)
{
	std::error_condition result;
	bool needswap = false;

	// if this is pregap info that isn't actually in the file, just return blank data
	if (!phys)
	{
		if ((cdtoc.tracks[tracknum].pgdatasize == 0) && (lbasector < cdtoc.tracks[tracknum].logframeofs))
		{
			if (EXTRA_VERBOSE)
				osd_printf_verbose("PG missing sector: LBA %d, trklog %d\n", lbasector, cdtoc.tracks[tracknum].logframeofs);
			memset(dest, 0, length);
			return result;
		}
	}

	// if a CHD, just read
	if (chd != nullptr)
	{
		if (!phys && cdtoc.tracks[tracknum].pgdatasize != 0)
		{
			// chdman (phys=true) relies on chdframeofs to point to index 0 instead of index 1 for extractcd.
			// Actually playing CDs requires it to point to index 1 instead of index 0, so adjust the offset when phys=false.
			chdsector += cdtoc.tracks[tracknum].pregap;
		}

		result = chd->read_bytes(uint64_t(chdsector) * uint64_t(FRAME_SIZE) + startoffs, dest, length);

		// swap CDDA in the case of LE GDROMs
		if ((cdtoc.flags & CD_FLAG_GDROMLE) && (cdtoc.tracks[tracknum].trktype == CD_TRACK_AUDIO))
			needswap = true;
	}
	else
	{
		// else read from the appropriate file
		util::random_read &srcfile = *fhandle[tracknum];

		int bytespersector = cdtoc.tracks[tracknum].datasize + cdtoc.tracks[tracknum].subsize;
		uint64_t sourcefileoffset = cdtrack_info.track[tracknum].offset;

		if (cdtoc.tracks[tracknum].pgdatasize != 0)
			chdsector += cdtoc.tracks[tracknum].pregap;

		sourcefileoffset += chdsector * bytespersector + startoffs;

		if (EXTRA_VERBOSE)
			osd_printf_verbose("Reading %u bytes from sector %d from track %d at offset %lu\n", (unsigned)length, chdsector, tracknum + 1, (unsigned long)sourcefileoffset);

		result = srcfile.seek(sourcefileoffset, SEEK_SET);
		size_t actual;
		if (!result)
			std::tie(result, actual) = read(srcfile, dest, length);
		// FIXME: if (!result && (actual < length)) report error

		needswap = cdtrack_info.track[tracknum].swap;
	}

	if (needswap)
	{
		uint8_t *buffer = (uint8_t *)dest - startoffs;
		for (int swapindex = startoffs; swapindex < 2352; swapindex += 2)
		{
			using std::swap;
			swap(buffer[ swapindex ], buffer[ swapindex + 1 ]);
		}
	}
	return result;
}


/*-------------------------------------------------
    cdrom_read_data - read one or more sectors
    from a CD-ROM
-------------------------------------------------*/

/**
 * @fn  bool read_data(uint32_t lbasector, void *buffer, uint32_t datatype, bool phys)
 *
 * @brief   Cdrom read data.
 *
 * @param   lbasector       The lbasector.
 * @param [in,out]  buffer  If non-null, the buffer.
 * @param   datatype        The datatype.
 * @param   phys            true to physical.
 *
 * @return  An uint32_t.
 */

bool cdrom_file::read_data(uint32_t lbasector, void *buffer, uint32_t datatype, bool phys)
{
	// compute CHD sector and tracknumber
	uint32_t tracknum = 0;
	uint32_t chdsector;

	if (phys)
	{
		chdsector = physical_to_chd_lba(lbasector, tracknum);
	}
	else
	{
		chdsector = logical_to_chd_lba(lbasector, tracknum);
	}

	// copy out the requested sector
	uint32_t tracktype = cdtoc.tracks[tracknum].trktype;

	if ((datatype == tracktype) || (datatype == CD_TRACK_RAW_DONTCARE))
	{
		assert(cdtoc.tracks[tracknum].datasize != 0);
		return !read_partial_sector(buffer, lbasector, chdsector, tracknum, 0, cdtoc.tracks[tracknum].datasize, phys);
	}
	else
	{
		// return 2048 bytes of mode 1 data from a 2352 byte mode 1 raw sector
		if ((datatype == CD_TRACK_MODE1) && (tracktype == CD_TRACK_MODE1_RAW))
		{
			return !read_partial_sector(buffer, lbasector, chdsector, tracknum, 16, 2048, phys);
		}

		// return 2352 byte mode 1 raw sector from 2048 bytes of mode 1 data
		if ((datatype == CD_TRACK_MODE1_RAW) && (tracktype == CD_TRACK_MODE1))
		{
			auto *bufptr = (uint8_t *)buffer;
			uint32_t msf = lba_to_msf(lbasector);

			static const uint8_t syncbytes[12] = {0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00};
			memcpy(bufptr, syncbytes, 12);
			put_u24be(&bufptr[12], msf);
			bufptr[15] = 1; // mode 1
			LOG(("CDROM: promotion of mode1/form1 sector to mode1 raw is not complete!\n"));
			return !read_partial_sector(bufptr+16, lbasector, chdsector, tracknum, 0, 2048, phys);
		}

		// return 2048 bytes of mode 1 data from a mode2 form1 or raw sector
		if ((datatype == CD_TRACK_MODE1) && ((tracktype == CD_TRACK_MODE2_FORM1)||(tracktype == CD_TRACK_MODE2_RAW)))
		{
			return !read_partial_sector(buffer, lbasector, chdsector, tracknum, 24, 2048, phys);
		}

		// return 2048 bytes of mode 1 data from a mode2 form2 or XA sector
		if ((datatype == CD_TRACK_MODE1) && (tracktype == CD_TRACK_MODE2_FORM_MIX))
		{
			return !read_partial_sector(buffer, lbasector, chdsector, tracknum, 8, 2048, phys);
		}

		// return mode 2 2336 byte data from a 2352 byte mode 1 or 2 raw sector (skip the header)
		if ((datatype == CD_TRACK_MODE2) && ((tracktype == CD_TRACK_MODE1_RAW) || (tracktype == CD_TRACK_MODE2_RAW)))
		{
			return !read_partial_sector(buffer, lbasector, chdsector, tracknum, 16, 2336, phys);
		}

		LOG(("CDROM: Conversion from type %d to type %d not supported!\n", tracktype, datatype));
		return 0;
	}
}


/*-------------------------------------------------
    read_subcode - read subcode data for
    a sector
-------------------------------------------------*/

/**
 * @fn  bool read_subcode(uint32_t lbasector, void *buffer, bool phys)
 *
 * @brief   Cdrom read subcode.
 *
 * @param   lbasector       The lbasector.
 * @param [in,out]  buffer  If non-null, the buffer.
 * @param   phys            true to physical.
 *
 * @return  false on failure.
 */

bool cdrom_file::read_subcode(uint32_t lbasector, void *buffer, bool phys)
{
	// compute CHD sector and tracknumber
	uint32_t tracknum = 0;
	uint32_t chdsector;

	if (phys)
	{
		chdsector = physical_to_chd_lba(lbasector, tracknum);
	}
	else
	{
		chdsector = logical_to_chd_lba(lbasector, tracknum);
	}

	if (cdtoc.tracks[tracknum].subsize == 0)
		return false;

	// read the data
	std::error_condition err = read_partial_sector(buffer, lbasector, chdsector, tracknum, cdtoc.tracks[tracknum].datasize, cdtoc.tracks[tracknum].subsize, phys);
	return !err;
}



/***************************************************************************
    HANDY UTILITIES
***************************************************************************/

/*-------------------------------------------------
    get_track - get the track number
    for a physical frame number
-------------------------------------------------*/

/**
 * @fn  uint32_t get_track(uint32_t frame)
 *
 * @brief   Cdrom get track.
 *
 * @param   frame           The frame.
 *
 * @return  An uint32_t.
 */

uint32_t cdrom_file::get_track(uint32_t frame) const
{
	uint32_t track = 0;

	/* convert to a CHD sector offset and get track information */
	logical_to_chd_lba(frame, track);

	return track;
}

uint32_t cdrom_file::get_track_index(uint32_t frame) const
{
	const uint32_t track = get_track(frame);
	const uint32_t track_start = get_track_start(track);
	const uint32_t index_offset = frame - track_start;
	int index = 0;

	for (int i = 0; i < std::size(cdtrack_info.track[track].idx); i++)
	{
		if (index_offset >= cdtrack_info.track[track].idx[i])
			index = i;
		else
			break;
	}

	if (cdtrack_info.track[track].idx[index] == -1)
		index = 1; // valid index not found, default to index 1

	return index;
}


/***************************************************************************
    EXTRA UTILITIES
***************************************************************************/

/*-------------------------------------------------
    get_info_from_type_string
    take a string and convert it into track type
    and track data size
-------------------------------------------------*/

/**
 * @fn  static void get_info_from_type_string(const char *typestring, uint32_t *trktype, uint32_t *datasize)
 *
 * @brief   Cdrom get information from type string.
 *
 * @param   typestring          The typestring.
 * @param [in,out]  trktype     If non-null, the trktype.
 * @param [in,out]  datasize    If non-null, the datasize.
 */

void cdrom_file::get_info_from_type_string(const char *typestring, uint32_t *trktype, uint32_t *datasize)
{
	if (!strcmp(typestring, "MODE1"))
	{
		*trktype = CD_TRACK_MODE1;
		*datasize = 2048;
	}
	else if (!strcmp(typestring, "MODE1/2048"))
	{
		*trktype = CD_TRACK_MODE1;
		*datasize = 2048;
	}
	else if (!strcmp(typestring, "MODE1_RAW"))
	{
		*trktype = CD_TRACK_MODE1_RAW;
		*datasize = 2352;
	}
	else if (!strcmp(typestring, "MODE1/2352"))
	{
		*trktype = CD_TRACK_MODE1_RAW;
		*datasize = 2352;
	}
	else if (!strcmp(typestring, "MODE2"))
	{
		*trktype = CD_TRACK_MODE2;
		*datasize = 2336;
	}
	else if (!strcmp(typestring, "MODE2/2336"))
	{
		*trktype = CD_TRACK_MODE2;
		*datasize = 2336;
	}
	else if (!strcmp(typestring, "MODE2_FORM1"))
	{
		*trktype = CD_TRACK_MODE2_FORM1;
		*datasize = 2048;
	}
	else if (!strcmp(typestring, "MODE2/2048"))
	{
		*trktype = CD_TRACK_MODE2_FORM1;
		*datasize = 2048;
	}
	else if (!strcmp(typestring, "MODE2_FORM2"))
	{
		*trktype = CD_TRACK_MODE2_FORM2;
		*datasize = 2324;
	}
	else if (!strcmp(typestring, "MODE2/2324"))
	{
		*trktype = CD_TRACK_MODE2_FORM2;
		*datasize = 2324;
	}
	else if (!strcmp(typestring, "MODE2_FORM_MIX"))
	{
		*trktype = CD_TRACK_MODE2_FORM_MIX;
		*datasize = 2336;
	}
	else if (!strcmp(typestring, "MODE2_RAW"))
	{
		*trktype = CD_TRACK_MODE2_RAW;
		*datasize = 2352;
	}
	else if (!strcmp(typestring, "MODE2/2352"))
	{
		*trktype = CD_TRACK_MODE2_RAW;
		*datasize = 2352;
	}
	else if (!strcmp(typestring, "CDI/2352"))
	{
		*trktype = CD_TRACK_MODE2_RAW;
		*datasize = 2352;
	}
	else if (!strcmp(typestring, "AUDIO"))
	{
		*trktype = CD_TRACK_AUDIO;
		*datasize = 2352;
	}
}

/*-------------------------------------------------
    convert_type_string_to_track_info -
    take a string and convert it into track type
    and track data size
-------------------------------------------------*/

/**
 * @fn  void convert_type_string_to_track_info(const char *typestring, track_info *info)
 *
 * @brief   Convert type string to track information.
 *
 * @param   typestring      The typestring.
 * @param [in,out]  info    If non-null, the information.
 */

void cdrom_file::convert_type_string_to_track_info(const char *typestring, track_info *info)
{
	get_info_from_type_string(typestring, &info->trktype, &info->datasize);
}

/*-------------------------------------------------
    convert_type_string_to_pregap_info -
    take a string and convert it into pregap type
    and pregap data size
-------------------------------------------------*/

/**
 * @fn  void convert_type_string_to_pregap_info(const char *typestring, track_info *info)
 *
 * @brief   Convert type string to pregap information.
 *
 * @param   typestring      The typestring.
 * @param [in,out]  info    If non-null, the information.
 */

void cdrom_file::convert_type_string_to_pregap_info(const char *typestring, track_info *info)
{
	get_info_from_type_string(typestring, &info->pgtype, &info->pgdatasize);
}

/*-------------------------------------------------
    convert_subtype_string_to_track_info -
    take a string and convert it into track subtype
    and track subcode data size
-------------------------------------------------*/

/**
 * @fn  void convert_subtype_string_to_track_info(const char *typestring, track_info *info)
 *
 * @brief   Convert subtype string to track information.
 *
 * @param   typestring      The typestring.
 * @param [in,out]  info    If non-null, the information.
 */

void cdrom_file::convert_subtype_string_to_track_info(const char *typestring, track_info *info)
{
	if (!strcmp(typestring, "RW"))
	{
		info->subtype = CD_SUB_NORMAL;
		info->subsize = 96;
	}
	else if (!strcmp(typestring, "RW_RAW"))
	{
		info->subtype = CD_SUB_RAW;
		info->subsize = 96;
	}
}

/*-------------------------------------------------
    convert_subtype_string_to_pregap_info -
    take a string and convert it into track subtype
    and track subcode data size
-------------------------------------------------*/

/**
 * @fn  void convert_subtype_string_to_pregap_info(const char *typestring, track_info *info)
 *
 * @brief   Convert subtype string to pregap information.
 *
 * @param   typestring      The typestring.
 * @param [in,out]  info    If non-null, the information.
 */

void cdrom_file::convert_subtype_string_to_pregap_info(const char *typestring, track_info *info)
{
	if (!strcmp(typestring, "RW"))
	{
		info->pgsub = CD_SUB_NORMAL;
		info->pgsubsize = 96;
	}
	else if (!strcmp(typestring, "RW_RAW"))
	{
		info->pgsub = CD_SUB_RAW;
		info->pgsubsize = 96;
	}
}

/*-------------------------------------------------
    get_type_string - get the string
    associated with the given type
-------------------------------------------------*/

/**
 * @fn  const char *get_type_string(uint32_t trktype)
 *
 * @brief   Get type string.
 *
 * @param   trktype The trktype.
 *
 * @return  null if it fails, else a char*.
 */

const char *cdrom_file::get_type_string(uint32_t trktype)
{
	switch (trktype)
	{
		case CD_TRACK_MODE1:            return "MODE1";
		case CD_TRACK_MODE1_RAW:        return "MODE1_RAW";
		case CD_TRACK_MODE2:            return "MODE2";
		case CD_TRACK_MODE2_FORM1:      return "MODE2_FORM1";
		case CD_TRACK_MODE2_FORM2:      return "MODE2_FORM2";
		case CD_TRACK_MODE2_FORM_MIX:   return "MODE2_FORM_MIX";
		case CD_TRACK_MODE2_RAW:        return "MODE2_RAW";
		case CD_TRACK_AUDIO:            return "AUDIO";
		default:                        return "UNKNOWN";
	}
}


/*-------------------------------------------------
    get_subtype_string - get the string
    associated with the given subcode type
-------------------------------------------------*/

/**
 * @fn  const char *get_subtype_string(uint32_t subtype)
 *
 * @brief   Get subtype string.
 *
 * @param   subtype The subtype.
 *
 * @return  null if it fails, else a char*.
 */

const char *cdrom_file::get_subtype_string(uint32_t subtype)
{
	switch (subtype)
	{
		case CD_SUB_NORMAL:             return "RW";
		case CD_SUB_RAW:                return "RW_RAW";
		default:                        return "NONE";
	}
}



/***************************************************************************
    INTERNAL UTILITIES
***************************************************************************/

/*-------------------------------------------------
    parse_metadata - parse metadata into the
    TOC structure
-------------------------------------------------*/

/**
 * @fn  std::error_condition cdrom_parse_metadata(chd_file *chd, toc *toc)
 *
 * @brief   Parse metadata.
 *
 * @param [in,out]  chd If non-null, the chd.
 * @param [in,out]  toc If non-null, the TOC.
 *
 * @return  A std::error_condition.
 */

std::error_condition cdrom_file::parse_metadata(chd_file *chd, toc &toc)
{
	std::string metadata;
	std::error_condition err;

	/* clear structures */
	memset(&toc, 0, sizeof(toc));

	toc.numsessions = 1;

	/* start with no tracks */
	for (toc.numtrks = 0; toc.numtrks < MAX_TRACKS; toc.numtrks++)
	{
		int tracknum, frames, pregap, postgap, padframes;
		char type[16], subtype[16], pgtype[16], pgsub[16];
		track_info *track;

		tracknum = -1;
		frames = pregap = postgap = padframes = 0;
		std::fill(std::begin(type), std::end(type), 0);
		std::fill(std::begin(subtype), std::end(subtype), 0);
		std::fill(std::begin(pgtype), std::end(pgtype), 0);
		std::fill(std::begin(pgsub), std::end(pgsub), 0);

		// fetch the metadata for this track
		if (!chd->read_metadata(CDROM_TRACK_METADATA_TAG, toc.numtrks, metadata))
		{
			if (sscanf(metadata.c_str(), CDROM_TRACK_METADATA_FORMAT, &tracknum, type, subtype, &frames) != 4)
				return chd_file::error::INVALID_DATA;
		}
		else if (!chd->read_metadata(CDROM_TRACK_METADATA2_TAG, toc.numtrks, metadata))
		{
			if (sscanf(metadata.c_str(), CDROM_TRACK_METADATA2_FORMAT, &tracknum, type, subtype, &frames, &pregap, pgtype, pgsub, &postgap) != 8)
				return chd_file::error::INVALID_DATA;
		}
		else
		{
			// fall through to GD-ROM detection
			err = chd->read_metadata(GDROM_OLD_METADATA_TAG, toc.numtrks, metadata);
			if (!err)
				toc.flags |= CD_FLAG_GDROMLE; // legacy GDROM track was detected
			else
				err = chd->read_metadata(GDROM_TRACK_METADATA_TAG, toc.numtrks, metadata);

			if (err)
				break;

			if (sscanf(metadata.c_str(), GDROM_TRACK_METADATA_FORMAT, &tracknum, type, subtype, &frames, &padframes, &pregap, pgtype, pgsub, &postgap) != 9)
				return chd_file::error::INVALID_DATA;

			toc.flags |= CD_FLAG_GDROM;
		}

		if (tracknum == 0 || tracknum > MAX_TRACKS)
			return chd_file::error::INVALID_DATA;

		track = &toc.tracks[tracknum - 1];

		// extract the track type and determine the data size
		track->trktype = CD_TRACK_MODE1;
		track->datasize = 0;
		convert_type_string_to_track_info(type, track);
		if (track->datasize == 0)
			return chd_file::error::INVALID_DATA;

		// extract the subtype and determine the subcode data size
		track->subtype = CD_SUB_NONE;
		track->subsize = 0;
		convert_subtype_string_to_track_info(subtype, track);

		// set the frames and extra frames data
		track->frames = frames;
		track->padframes = padframes;
		int padded = (frames + TRACK_PADDING - 1) / TRACK_PADDING;
		track->extraframes = padded * TRACK_PADDING - frames;

		// set the pregap info
		track->pregap = pregap;
		track->pgtype = CD_TRACK_MODE1;
		track->pgsub = CD_SUB_NONE;
		track->pgdatasize = 0;
		track->pgsubsize = 0;
		if (track->pregap > 0)
		{
			if (pgtype[0] == 'V')
			{
				convert_type_string_to_pregap_info(&pgtype[1], track);
			}

			convert_subtype_string_to_pregap_info(pgsub, track);
		}

		/* set the postgap info */
		track->postgap = postgap;
	}

	/* if we got any tracks this way, we're done */
	if (toc.numtrks > 0)
		return std::error_condition();

	osd_printf_info("toc.numtrks = %u?!\n", toc.numtrks);

	/* look for old-style metadata */
	std::vector<uint8_t> oldmetadata;
	err = chd->read_metadata(CDROM_OLD_METADATA_TAG, 0, oldmetadata);
	if (err)
		return err;

	/* reconstruct the TOC from it */
	auto *mrp = reinterpret_cast<uint32_t *>(&oldmetadata[0]);
	toc.numtrks = *mrp++;

	toc.numsessions = 1;

	for (int i = 0; i < MAX_TRACKS; i++)
	{
		toc.tracks[i].session = 0;
		toc.tracks[i].trktype = *mrp++;
		toc.tracks[i].subtype = *mrp++;
		toc.tracks[i].datasize = *mrp++;
		toc.tracks[i].subsize = *mrp++;
		toc.tracks[i].frames = *mrp++;
		toc.tracks[i].extraframes = *mrp++;
		toc.tracks[i].pregap = 0;
		toc.tracks[i].postgap = 0;
		toc.tracks[i].pgtype = 0;
		toc.tracks[i].pgsub = 0;
		toc.tracks[i].pgdatasize = 0;
		toc.tracks[i].pgsubsize = 0;
	}

	/* TODO: I don't know why sometimes the data is one endian and sometimes another */
	if (toc.numtrks > MAX_TRACKS)
	{
		toc.numtrks = swapendian_int32(toc.numtrks);
		for (int i = 0; i < MAX_TRACKS; i++)
		{
			toc.tracks[i].trktype = swapendian_int32(toc.tracks[i].trktype);
			toc.tracks[i].subtype = swapendian_int32(toc.tracks[i].subtype);
			toc.tracks[i].datasize = swapendian_int32(toc.tracks[i].datasize);
			toc.tracks[i].subsize = swapendian_int32(toc.tracks[i].subsize);
			toc.tracks[i].frames = swapendian_int32(toc.tracks[i].frames);
			toc.tracks[i].padframes = swapendian_int32(toc.tracks[i].padframes);
			toc.tracks[i].extraframes = swapendian_int32(toc.tracks[i].extraframes);
		}
	}

	return std::error_condition();
}


/*-------------------------------------------------
    write_metadata - write metadata
-------------------------------------------------*/

/**
 * @fn  std::error_condition write_metadata(chd_file *chd, const toc *toc)
 *
 * @brief   Write metadata.
 *
 * @param [in,out]  chd If non-null, the chd.
 * @param   toc         The TOC.
 *
 * @return  A std::error_condition.
 */

std::error_condition cdrom_file::write_metadata(chd_file *chd, const toc &toc)
{
	std::error_condition err;

	/* write the metadata */
	for (int i = 0; i < toc.numtrks; i++)
	{
		std::string metadata;
		if (toc.flags & CD_FLAG_GDROM)
		{
			metadata = util::string_format(GDROM_TRACK_METADATA_FORMAT, i + 1, get_type_string(toc.tracks[i].trktype),
					get_subtype_string(toc.tracks[i].subtype), toc.tracks[i].frames, toc.tracks[i].padframes,
					toc.tracks[i].pregap, get_type_string(toc.tracks[i].pgtype),
					get_subtype_string(toc.tracks[i].pgsub), toc.tracks[i].postgap);

			err = chd->write_metadata(GDROM_TRACK_METADATA_TAG, i, metadata);
		}
		else
		{
			char submode[32];

			if (toc.tracks[i].pgdatasize > 0)
			{
				strcpy(&submode[1], get_type_string(toc.tracks[i].pgtype));
				submode[0] = 'V';   // indicate valid submode
			}
			else
			{
				strcpy(submode, get_type_string(toc.tracks[i].pgtype));
			}

			metadata = util::string_format(CDROM_TRACK_METADATA2_FORMAT, i + 1, get_type_string(toc.tracks[i].trktype),
					get_subtype_string(toc.tracks[i].subtype), toc.tracks[i].frames, toc.tracks[i].pregap,
					submode, get_subtype_string(toc.tracks[i].pgsub),
					toc.tracks[i].postgap);
			err = chd->write_metadata(CDROM_TRACK_METADATA2_TAG, i, metadata);
		}
		if (err)
			return err;
	}
	return std::error_condition();
}

/**
 * @brief   -------------------------------------------------
 *            ECC lookup tables pre-calculated tables for ECC data calcs
 *          -------------------------------------------------.
 */

const uint8_t cdrom_file::ecclow[256] =
{
	0x00, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0c, 0x0e, 0x10, 0x12, 0x14, 0x16, 0x18, 0x1a, 0x1c, 0x1e,
	0x20, 0x22, 0x24, 0x26, 0x28, 0x2a, 0x2c, 0x2e, 0x30, 0x32, 0x34, 0x36, 0x38, 0x3a, 0x3c, 0x3e,
	0x40, 0x42, 0x44, 0x46, 0x48, 0x4a, 0x4c, 0x4e, 0x50, 0x52, 0x54, 0x56, 0x58, 0x5a, 0x5c, 0x5e,
	0x60, 0x62, 0x64, 0x66, 0x68, 0x6a, 0x6c, 0x6e, 0x70, 0x72, 0x74, 0x76, 0x78, 0x7a, 0x7c, 0x7e,
	0x80, 0x82, 0x84, 0x86, 0x88, 0x8a, 0x8c, 0x8e, 0x90, 0x92, 0x94, 0x96, 0x98, 0x9a, 0x9c, 0x9e,
	0xa0, 0xa2, 0xa4, 0xa6, 0xa8, 0xaa, 0xac, 0xae, 0xb0, 0xb2, 0xb4, 0xb6, 0xb8, 0xba, 0xbc, 0xbe,
	0xc0, 0xc2, 0xc4, 0xc6, 0xc8, 0xca, 0xcc, 0xce, 0xd0, 0xd2, 0xd4, 0xd6, 0xd8, 0xda, 0xdc, 0xde,
	0xe0, 0xe2, 0xe4, 0xe6, 0xe8, 0xea, 0xec, 0xee, 0xf0, 0xf2, 0xf4, 0xf6, 0xf8, 0xfa, 0xfc, 0xfe,
	0x1d, 0x1f, 0x19, 0x1b, 0x15, 0x17, 0x11, 0x13, 0x0d, 0x0f, 0x09, 0x0b, 0x05, 0x07, 0x01, 0x03,
	0x3d, 0x3f, 0x39, 0x3b, 0x35, 0x37, 0x31, 0x33, 0x2d, 0x2f, 0x29, 0x2b, 0x25, 0x27, 0x21, 0x23,
	0x5d, 0x5f, 0x59, 0x5b, 0x55, 0x57, 0x51, 0x53, 0x4d, 0x4f, 0x49, 0x4b, 0x45, 0x47, 0x41, 0x43,
	0x7d, 0x7f, 0x79, 0x7b, 0x75, 0x77, 0x71, 0x73, 0x6d, 0x6f, 0x69, 0x6b, 0x65, 0x67, 0x61, 0x63,
	0x9d, 0x9f, 0x99, 0x9b, 0x95, 0x97, 0x91, 0x93, 0x8d, 0x8f, 0x89, 0x8b, 0x85, 0x87, 0x81, 0x83,
	0xbd, 0xbf, 0xb9, 0xbb, 0xb5, 0xb7, 0xb1, 0xb3, 0xad, 0xaf, 0xa9, 0xab, 0xa5, 0xa7, 0xa1, 0xa3,
	0xdd, 0xdf, 0xd9, 0xdb, 0xd5, 0xd7, 0xd1, 0xd3, 0xcd, 0xcf, 0xc9, 0xcb, 0xc5, 0xc7, 0xc1, 0xc3,
	0xfd, 0xff, 0xf9, 0xfb, 0xf5, 0xf7, 0xf1, 0xf3, 0xed, 0xef, 0xe9, 0xeb, 0xe5, 0xe7, 0xe1, 0xe3
};

/** @brief  The ecchigh[ 256]. */
const uint8_t cdrom_file::ecchigh[256] =
{
	0x00, 0xf4, 0xf5, 0x01, 0xf7, 0x03, 0x02, 0xf6, 0xf3, 0x07, 0x06, 0xf2, 0x04, 0xf0, 0xf1, 0x05,
	0xfb, 0x0f, 0x0e, 0xfa, 0x0c, 0xf8, 0xf9, 0x0d, 0x08, 0xfc, 0xfd, 0x09, 0xff, 0x0b, 0x0a, 0xfe,
	0xeb, 0x1f, 0x1e, 0xea, 0x1c, 0xe8, 0xe9, 0x1d, 0x18, 0xec, 0xed, 0x19, 0xef, 0x1b, 0x1a, 0xee,
	0x10, 0xe4, 0xe5, 0x11, 0xe7, 0x13, 0x12, 0xe6, 0xe3, 0x17, 0x16, 0xe2, 0x14, 0xe0, 0xe1, 0x15,
	0xcb, 0x3f, 0x3e, 0xca, 0x3c, 0xc8, 0xc9, 0x3d, 0x38, 0xcc, 0xcd, 0x39, 0xcf, 0x3b, 0x3a, 0xce,
	0x30, 0xc4, 0xc5, 0x31, 0xc7, 0x33, 0x32, 0xc6, 0xc3, 0x37, 0x36, 0xc2, 0x34, 0xc0, 0xc1, 0x35,
	0x20, 0xd4, 0xd5, 0x21, 0xd7, 0x23, 0x22, 0xd6, 0xd3, 0x27, 0x26, 0xd2, 0x24, 0xd0, 0xd1, 0x25,
	0xdb, 0x2f, 0x2e, 0xda, 0x2c, 0xd8, 0xd9, 0x2d, 0x28, 0xdc, 0xdd, 0x29, 0xdf, 0x2b, 0x2a, 0xde,
	0x8b, 0x7f, 0x7e, 0x8a, 0x7c, 0x88, 0x89, 0x7d, 0x78, 0x8c, 0x8d, 0x79, 0x8f, 0x7b, 0x7a, 0x8e,
	0x70, 0x84, 0x85, 0x71, 0x87, 0x73, 0x72, 0x86, 0x83, 0x77, 0x76, 0x82, 0x74, 0x80, 0x81, 0x75,
	0x60, 0x94, 0x95, 0x61, 0x97, 0x63, 0x62, 0x96, 0x93, 0x67, 0x66, 0x92, 0x64, 0x90, 0x91, 0x65,
	0x9b, 0x6f, 0x6e, 0x9a, 0x6c, 0x98, 0x99, 0x6d, 0x68, 0x9c, 0x9d, 0x69, 0x9f, 0x6b, 0x6a, 0x9e,
	0x40, 0xb4, 0xb5, 0x41, 0xb7, 0x43, 0x42, 0xb6, 0xb3, 0x47, 0x46, 0xb2, 0x44, 0xb0, 0xb1, 0x45,
	0xbb, 0x4f, 0x4e, 0xba, 0x4c, 0xb8, 0xb9, 0x4d, 0x48, 0xbc, 0xbd, 0x49, 0xbf, 0x4b, 0x4a, 0xbe,
	0xab, 0x5f, 0x5e, 0xaa, 0x5c, 0xa8, 0xa9, 0x5d, 0x58, 0xac, 0xad, 0x59, 0xaf, 0x5b, 0x5a, 0xae,
	0x50, 0xa4, 0xa5, 0x51, 0xa7, 0x53, 0x52, 0xa6, 0xa3, 0x57, 0x56, 0xa2, 0x54, 0xa0, 0xa1, 0x55
};

//-------------------------------------------------
//  Discpress: P and Q are computed for eight vectors at a time, a byte each in 64-bit words.
//  The results are those of 0.289's byte-at-a-time loops over tables of offsets (poffsets and
//  qoffsets, removed), about 3.4 times faster.
//
//  The ECC covers a sector from its header (zeros in Mode 2) up to its P: 26 rows of 43 16-bit
//  words, the last two rows being P. P protects the 86 byte columns of the first 24 rows; Q the
//  52 byte diagonals of all 26 rows, 43 words each, one per column and a row further down per
//  column, wrapping around. For a vector x[0..n), with a = sum x[k] * 2^(n-k) and b = sum x[k]
//  over GF(2^8), the parity pair is p0 = (a * 2 + b) / 3 and p1 = p0 + b (ecclow multiplies
//  by 2, ecchigh divides by 3).
//-------------------------------------------------

namespace {

constexpr int ECC_REGION_BYTES = 2236; // the header, the 2,060 bytes after it, and P

inline uint64_t ecc_load64(const uint8_t *p)
{
	uint64_t v;
	memcpy(&v, p, 8);
	return v;
}

// eight bytes, each multiplied by 2 in GF(2^8)
inline uint64_t ecc_mul2x8(uint64_t a)
{
	uint64_t const high = a & 0x8080808080808080ull;
	return ((a & 0x7f7f7f7f7f7f7f7full) << 1) ^ ((high >> 7) * 0x1d);
}

} // anonymous namespace

/**
 * @fn  void ecc_region(const uint8_t *sector, uint8_t *region)
 *
 * @brief   Discpress: what the ECC covers of a sector, from its header (zeros in Mode 2) up to
 *          and including its P.
 */

void cdrom_file::ecc_region(const uint8_t *sector, uint8_t *region)
{
	if (sector[MODE_OFFSET] == 2)
		memset(region, 0, 4);
	else
		memcpy(region, &sector[SYNC_OFFSET + SYNC_NUM_BYTES], 4);
	memcpy(region + 4, &sector[SYNC_OFFSET + SYNC_NUM_BYTES + 4], ECC_REGION_BYTES - 4);
}

/**
 * @fn  void ecc_parity(const uint8_t *region, bool q, uint8_t *parity)
 *
 * @brief   Discpress: the P (2 x 86 bytes) or Q (2 x 52 bytes) parity of a region.
 */

void cdrom_file::ecc_parity(const uint8_t *region, bool q, uint8_t *parity)
{
	uint64_t a[11] = { }, b[11] = { };
	int const count = q ? ECC_Q_NUM_BYTES : ECC_P_NUM_BYTES;
	if (!q)
	{
		// the columns of the first 24 rows (a row's last word also reads 2 bytes of the next row, unused)
		for (int row = 0; row < ECC_P_COMP; row++)
			for (int l = 0; l < 11; l++)
			{
				uint64_t const x = ecc_load64(&region[ECC_P_NUM_BYTES * row + 8 * l]);
				a[l] = ecc_mul2x8(a[l] ^ x);
				b[l] ^= x;
			}
	}
	else
	{
		uint8_t v[56] = { };
		for (int col = 0; col < ECC_Q_COMP; col++)
		{
			// diagonal d crosses this column at row d + col: the column's words in that order
			int row = col % 26;
			for (int d = 0; d < 26; d++)
			{
				memcpy(&v[2 * d], &region[ECC_P_NUM_BYTES * row + 2 * col], 2);
				if (++row == 26)
					row = 0;
			}
			for (int l = 0; l < 7; l++)
			{
				uint64_t const x = ecc_load64(&v[8 * l]);
				a[l] = ecc_mul2x8(a[l] ^ x);
				b[l] ^= x;
			}
		}
	}
	uint8_t av[sizeof(a)], bv[sizeof(b)];
	memcpy(av, a, sizeof(a));
	memcpy(bv, b, sizeof(b));
	for (int i = 0; i < count; i++)
	{
		uint8_t const p0 = ecchigh[ecclow[av[i]] ^ bv[i]];
		parity[i] = p0;
		parity[count + i] = p0 ^ bv[i];
	}
}

/**
 * @fn  bool ecc_verify(const uint8_t *sector)
 *
 * @brief   -------------------------------------------------
 *            ecc_verify - verify the P and Q ECC codes in a sector
 *          -------------------------------------------------.
 *
 * @param   sector  The sector.
 *
 * @return  true if it succeeds, false if it fails.
 */

bool cdrom_file::ecc_verify(const uint8_t *sector)
{
	uint8_t region[ECC_REGION_BYTES], parity[2 * ECC_P_NUM_BYTES];
	ecc_region(sector, region);

	// first verify P bytes
	ecc_parity(region, false, parity);
	if (memcmp(parity, &sector[ECC_P_OFFSET], 2 * ECC_P_NUM_BYTES) != 0)
		return false;

	// then verify Q bytes
	ecc_parity(region, true, parity);
	return memcmp(parity, &sector[ECC_Q_OFFSET], 2 * ECC_Q_NUM_BYTES) == 0;
}

/**
 * @fn  void ecc_generate(uint8_t *sector)
 *
 * @brief   -------------------------------------------------
 *            ecc_generate - generate the P and Q ECC codes for a sector, overwriting any
 *            existing codes
 *          -------------------------------------------------.
 *
 * @param [in,out]  sector  If non-null, the sector.
 */

void cdrom_file::ecc_generate(uint8_t *sector)
{
	uint8_t region[ECC_REGION_BYTES];
	ecc_region(sector, region);

	// first P, then Q, which covers the new P
	ecc_parity(region, false, &sector[ECC_P_OFFSET]);
	memcpy(&region[ECC_REGION_BYTES - 2 * ECC_P_NUM_BYTES], &sector[ECC_P_OFFSET], 2 * ECC_P_NUM_BYTES);
	ecc_parity(region, true, &sector[ECC_Q_OFFSET]);
}

/**
 * @fn  void ecc_clear(uint8_t *sector)
 *
 * @brief   -------------------------------------------------
 *            ecc_clear - erase the ECC P and Q cods to 0 within a sector
 *          -------------------------------------------------.
 *
 * @param [in,out]  sector  If non-null, the sector.
 */

void cdrom_file::ecc_clear(uint8_t *sector)
{
	memset(&sector[ECC_P_OFFSET], 0, 2 * ECC_P_NUM_BYTES);
	memset(&sector[ECC_Q_OFFSET], 0, 2 * ECC_Q_NUM_BYTES);
}

/***************************************************************************

    TOC parser
    Handles CDRDAO .toc, CDRWIN .cue, Nero .nrg, and Sega GDROM .gdi

***************************************************************************/

/***************************************************************************
    CONSTANTS & DEFINES
***************************************************************************/

/**
 * @def TOKENIZE();
 *
 * @brief   A macro that defines tokenize.
 *
 * @param   linebuffer             The linebuffer.
 * @param   i                      Zero-based index of the.
 * @param   std::size(linebuffer)  The std::size(linebuffer)
 * @param   token                  The token.
 * @param   std::size(token)       The std::size(token)
 */

#define TOKENIZE i = tokenize( linebuffer, i, std::size(linebuffer), token, std::size(token) );


/***************************************************************************
    IMPLEMENTATION
***************************************************************************/

/**
 * @fn  std::string get_file_path(std::string &path)
 *
 * @brief   Gets file path.
 *
 * @param [in,out]  path    Full pathname of the file.
 *
 * @return  The file path.
 */

std::string cdrom_file::get_file_path(std::string &path)
{
	int pos = path.find_last_of('\\');
	if (pos!=-1)
	{
		path = path.substr(0,pos+1);
	}
	else
	{
		pos = path.find_last_of('/');
		path = path.substr(0,pos+1);
	}
	return path;
}
/*-------------------------------------------------
    get_file_size - get the size of a file
-------------------------------------------------*/

/**
 * @fn  static uint64_t get_file_size(std::string_view filename)
 *
 * @brief   Gets file size.
 *
 * @param   filename    Filename of the file.
 *
 * @return  The file size.
 */

uint64_t cdrom_file::get_file_size(std::string_view filename)
{
	osd_file::ptr file;
	std::uint64_t filesize = 0;

	osd_file::open(std::string(filename), OPEN_FLAG_READ, file, filesize); // FIXME: allow osd_file to accept std::string_view

	return filesize;
}


/*-------------------------------------------------
    tokenize - get a token from the line buffer
-------------------------------------------------*/

/**
 * @fn  static int tokenize( const char *linebuffer, int i, int linebuffersize, char *token, int tokensize )
 *
 * @brief   Tokenizes.
 *
 * @param   linebuffer      The linebuffer.
 * @param   i               Zero-based index of the.
 * @param   linebuffersize  The linebuffersize.
 * @param [in,out]  token   If non-null, the token.
 * @param   tokensize       The tokensize.
 *
 * @return  An int.
 */

int cdrom_file::tokenize(const char *linebuffer, int i, int linebuffersize, char *token, int tokensize)
{
	int j = 0;
	bool singlequote = false;
	bool doublequote = false;

	while ((i < linebuffersize) && isspace((uint8_t)linebuffer[i]))
	{
		i++;
	}

	while ((i < linebuffersize) && (j < tokensize) && (linebuffer[i] != '\0'))
	{
		if (!singlequote && linebuffer[i] == '"')
		{
			doublequote = !doublequote;
		}
		else if (!doublequote && linebuffer[i] == '\'')
		{
			singlequote = !singlequote;
		}
		else if (!singlequote && !doublequote && isspace((uint8_t)linebuffer[i]))
		{
			break;
		}
		else
		{
			token[j] = linebuffer[i];
			j++;
		}

		i++;
	}

	token[j] = '\0';

	return i;
}


/*-------------------------------------------------
    msf_to_frames - convert m:s:f into a number of frames
-------------------------------------------------*/

/**
 * @fn  static int msf_to_frames( char *token )
 *
 * @brief   Msf to frames.
 *
 * @param [in,out]  token   If non-null, the token.
 *
 * @return  An int.
 */

int cdrom_file::msf_to_frames(const char *token)
{
	int m = 0;
	int s = 0;
	int f = 0;

	if (sscanf(token, "%d:%d:%d", &m, &s, &f) == 1)
	{
		f = m;
	}
	else
	{
		// convert to just frames
		s += (m * 60);
		f += (s * 75);
	}

	return f;
}

/*-------------------------------------------------
    parse_wav_sample - takes a .WAV file, verifies
    that the file is 16 bits, and returns the
    length in bytes of the data and the offset in
    bytes to where the data starts in the file.
-------------------------------------------------*/

/**
 * @fn  static uint32_t parse_wav_sample(std::string_view filename, uint32_t *dataoffs)
 *
 * @brief   Parse WAV sample.
 *
 * @param   filename            Filename of the file.
 * @param [in,out]  dataoffs    If non-null, the dataoffs.
 *
 * @return  An uint32_t.
 */

uint32_t cdrom_file::parse_wav_sample(std::string_view filename, uint32_t *dataoffs)
{
	unsigned long offset = 0;
	uint32_t length, rate, filesize;
	uint16_t bits, temp16;
	char buf[32];
	osd_file::ptr file;
	uint64_t fsize = 0;
	std::uint32_t actual;

	std::string fname = std::string(filename);
	std::error_condition const filerr = osd_file::open(fname, OPEN_FLAG_READ, file, fsize);
	if (filerr)
	{
		osd_printf_error("ERROR: could not open (%s)\n", fname);
		return 0;
	}

	/* read the core header and make sure it's a WAVE file */
	file->read(buf, 0, 4, actual);
	offset += actual;
	if (offset < 4)
	{
		osd_printf_error("ERROR: unexpected RIFF offset %lu (%s)\n", offset, fname);
		return 0;
	}
	if (memcmp(&buf[0], "RIFF", 4) != 0)
	{
		osd_printf_error("ERROR: could not find RIFF header (%s)\n", fname);
		return 0;
	}

	/* get the total size */
	file->read(&filesize, offset, 4, actual);
	offset += actual;
	if (offset < 8)
	{
		osd_printf_error("ERROR: unexpected size offset %lu (%s)\n", offset, fname);
		return 0;
	}
	filesize = little_endianize_int32(filesize);

	/* read the RIFF file type and make sure it's a WAVE file */
	file->read(buf, offset, 4, actual);
	offset += actual;
	if (offset < 12)
	{
		osd_printf_error("ERROR: unexpected WAVE offset %lu (%s)\n", offset, fname);
		return 0;
	}
	if (memcmp(&buf[0], "WAVE", 4) != 0)
	{
		osd_printf_error("ERROR: could not find WAVE header (%s)\n", fname);
		return 0;
	}

	/* seek until we find a format tag */
	while (true)
	{
		file->read(buf, offset, 4, actual);
		offset += actual;
		file->read(&length, offset, 4, actual);
		offset += actual;
		length = little_endianize_int32(length);
		if (memcmp(&buf[0], "fmt ", 4) == 0)
			break;

		/* seek to the next block */
		offset += length;
		if (offset >= filesize)
		{
			osd_printf_error("ERROR: could not find fmt tag (%s)\n", fname);
			return 0;
		}
	}

	/* read the format -- make sure it is PCM */
	file->read(&temp16, offset, 2, actual);
	offset += actual;
	temp16 = little_endianize_int16(temp16);
	if (temp16 != 1)
	{
		osd_printf_error("ERROR: unsupported format %u - only PCM is supported (%s)\n", temp16, fname);
		return 0;
	}

	/* number of channels -- only stereo is supported */
	file->read(&temp16, offset, 2, actual);
	offset += actual;
	temp16 = little_endianize_int16(temp16);
	if (temp16 != 2)
	{
		osd_printf_error("ERROR: unsupported number of channels %u - only stereo is supported (%s)\n", temp16, fname);
		return 0;
	}

	/* sample rate */
	file->read(&rate, offset, 4, actual);
	offset += actual;
	rate = little_endianize_int32(rate);
	if (rate != 44100)
	{
		osd_printf_error("ERROR: unsupported samplerate %u - only 44100 is supported (%s)\n", rate, fname);
		return 0;
	}

	/* bytes/second and block alignment are ignored */
	file->read(buf, offset, 6, actual);
	offset += actual;

	/* bits/sample */
	file->read(&bits, offset, 2, actual);
	offset += actual;
	bits = little_endianize_int16(bits);
	if (bits != 16)
	{
		osd_printf_error("ERROR: unsupported bits/sample %u - only 16 is supported (%s)\n", bits, fname);
		return 0;
	}

	/* seek past any extra data */
	offset += length - 16;

	/* seek until we find a data tag */
	while (true)
	{
		file->read(buf, offset, 4, actual);
		offset += actual;
		file->read(&length, offset, 4, actual);
		offset += actual;
		length = little_endianize_int32(length);
		if (memcmp(&buf[0], "data", 4) == 0)
			break;

		/* seek to the next block */
		offset += length;
		if (offset >= filesize)
		{
			osd_printf_error("ERROR: could not find data tag (%s)\n", fname);
			return 0;
		}
	}

	/* if there was a 0 length data block, we're done */
	if (length == 0)
	{
		osd_printf_error("ERROR: empty data block (%s)\n", fname);
		return 0;
	}

	*dataoffs = offset;

	return length;
}

/**
 * @fn  uint16_t read_uint16(FILE *infile)
 *
 * @brief   Reads uint 16.
 *
 * @param [in,out]  infile  If non-null, the infile.
 *
 * @return  The uint 16.
 */

uint16_t cdrom_file::read_uint16(FILE *infile)
{
	unsigned char buffer[2];

	fread(buffer, 2, 1, infile);

	return get_u16be(buffer);
}

/**
 * @fn  uint32_t read_uint32(FILE *infile)
 *
 * @brief   Reads uint 32.
 *
 * @param [in,out]  infile  If non-null, the infile.
 *
 * @return  The uint 32.
 */

uint32_t cdrom_file::read_uint32(FILE *infile)
{
	unsigned char buffer[4];

	fread(buffer, 4, 1, infile);

	return get_u32be(buffer);
}

/**
 * @fn  uint64_t read_uint64(FILE *infile)
 *
 * @brief   Reads uint 64.
 *
 * @param [in,out]  infile  If non-null, the infile.
 *
 * @return  The uint 64.
 */

uint64_t cdrom_file::read_uint64(FILE *infile)
{
	unsigned char buffer[8];

	fread(buffer, 8, 1, infile);

	return get_u64be(buffer);
}

/*-------------------------------------------------
    parse_nero - parse a Nero .NRG file
-------------------------------------------------*/

/**
 * @fn  std::error_condition parse_nero(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
 *
 * @brief   Chdcd parse nero.
 *
 * @param   tocfname        The tocfname.
 * @param [in,out]  outtoc  The outtoc.
 * @param [in,out]  outinfo The outinfo.
 *
 * @return  A std::error_condition.
 */

std::error_condition cdrom_file::parse_nero(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
{
	unsigned char buffer[12];
	uint32_t chain_offs, chunk_size;
	int done = 0;

	std::string path = std::string(tocfname);

	FILE *infile = fopen(path.c_str(), "rb");
	if (!infile)
	{
		return std::error_condition(errno, std::generic_category());
	}

	path = get_file_path(path);

	/* clear structures */
	memset(&outtoc, 0, sizeof(outtoc));
	outinfo.reset();

	outtoc.numsessions = 1;

	// seek to 12 bytes before the end (Discpress: a file shorter than that isn't one either)
	fseek(infile, 0, SEEK_END);
	uint64_t const filesize = ftell(infile);
	fseek(infile, -12, SEEK_END);
	if (filesize < 12 || fread(buffer, 12, 1, infile) != 1 || memcmp(buffer, "NER5", 4))
	{
		osd_printf_error("ERROR: Not a Nero 5.5 or later image!\n");
		fclose(infile);
		return chd_file::error::UNSUPPORTED_FORMAT;
	}

	chain_offs = get_u32be(&buffer[8]);

	if ((buffer[7] != 0) || (buffer[6] != 0) || (buffer[5] != 0) || (buffer[4] != 0))
	{
		osd_printf_error("ERROR: File size is > 4GB, this version of CHDMAN cannot handle it.");
		fclose(infile);
		return chd_file::error::UNSUPPORTED_FORMAT;
	}

//  printf("NER5 detected, chain offset: %x\n", chain_offs);

	while (!done)
	{
		// Discpress: a chain of chunks without END!, or one that leaves the file, made 0.289 loop forever
		if (uint64_t(chain_offs) + 8 > filesize || fseek(infile, chain_offs, SEEK_SET) || fread(buffer, 8, 1, infile) != 1)
		{
			osd_printf_error("ERROR: NRG image's chunks end without an END! chunk\n");
			fclose(infile);
			return chd_file::error::INVALID_DATA;
		}

		chunk_size = get_u32be(&buffer[4]);

//      printf("Chunk type: %c%c%c%c, size %x\n", buffer[0], buffer[1], buffer[2], buffer[3], chunk_size);

		// we want the DAOX chunk, which has the TOC information
		if (!memcmp(buffer, "DAOX", 4))
		{
			// skip second chunk size and UPC code
			fseek(infile, 20, SEEK_CUR);

			uint8_t start = 0, end = 0; // Discpress: 0 (refused below) if the file ends here
			fread(&start, 1, 1, infile);
			fread(&end, 1, 1, infile);

//          printf("Start track %d  End track: %d\n", start, end);

			outtoc.numtrks = (end-start) + 1;
			if (start < 1 || end < start || outtoc.numtrks > MAX_TRACKS || end > MAX_TRACKS) // Discpress: 0.289 wrote outside its track table
			{
				fclose(infile);
				osd_printf_error("ERROR: NRG image has tracks %d to %d, only 1 to %d are possible\n", start, end, MAX_TRACKS);
				return chd_file::error::INVALID_DATA;
			}

			uint32_t offset = 0;
			for (int track = start; track <= end; track++)
			{
				uint32_t size, mode;
				uint64_t index0, index1, track_end;

				fseek(infile, 12, SEEK_CUR);    // skip ISRC code
				size = read_uint16(infile);
				mode = read_uint16(infile);
				fseek(infile, 2, SEEK_CUR);
				index0 = read_uint64(infile);
				index1 = read_uint64(infile);
				track_end = read_uint64(infile);

//              printf("Track %d: sector size %d mode %x index0 %llx index1 %llx track_end %llx (pregap %d sectors, length %d sectors)\n", track, size, mode, index0, index1, track_end, (uint32_t)(index1-index0)/size, (uint32_t)(track_end-index1)/size);
				outinfo.track[track-1].fname.assign(tocfname);
				outinfo.track[track-1].offset = offset + (uint32_t)(index1-index0);
				outinfo.track[track-1].idx[0] = outinfo.track[track-1].idx[1] = 0;

				switch (mode)
				{
					case 0x0000:    // 2048 byte data
						outtoc.tracks[track-1].trktype = CD_TRACK_MODE1;
						outinfo.track[track-1].swap = false;
						break;

					case 0x0300:    // Mode 2 Form 1
						osd_printf_error("ERROR: Mode 2 Form 1 tracks not supported\n");
						fclose(infile);
						return chd_file::error::UNSUPPORTED_FORMAT;

					case 0x0500:    // raw data
						osd_printf_error("ERROR: Raw data tracks not supported\n");
						fclose(infile);
						return chd_file::error::UNSUPPORTED_FORMAT;

					case 0x0600:    // 2352 byte mode 2 raw
						outtoc.tracks[track-1].trktype = CD_TRACK_MODE2_RAW;
						outinfo.track[track-1].swap = false;
						break;

					case 0x0700:    // 2352 byte audio
						outtoc.tracks[track-1].trktype = CD_TRACK_AUDIO;
						outinfo.track[track-1].swap = true;
						break;

					case 0x0f00:    // raw data with sub-channel
						osd_printf_error("ERROR: Raw data tracks with sub-channel not supported\n");
						fclose(infile);
						return chd_file::error::UNSUPPORTED_FORMAT;

					case 0x1000:    // audio with sub-channel
						osd_printf_error("ERROR: Audio tracks with sub-channel not supported\n");
						fclose(infile);
						return chd_file::error::UNSUPPORTED_FORMAT;

					case 0x1100:    // raw Mode 2 Form 1 with sub-channel
						osd_printf_error("ERROR: Raw Mode 2 Form 1 tracks with sub-channel not supported\n");
						fclose(infile);
						return chd_file::error::UNSUPPORTED_FORMAT;

					default:
						osd_printf_error("ERROR: Unknown track type %x, contact MAMEDEV!\n", mode);
						fclose(infile);
						return chd_file::error::UNSUPPORTED_FORMAT;
				}

				// Discpress: 0.289 divided by it
				if (size == 0)
				{
					osd_printf_error("ERROR: NRG image's track %d has a sector size of 0\n", track);
					fclose(infile);
					return chd_file::error::INVALID_DATA;
				}
				outtoc.tracks[track-1].datasize = size;

				outtoc.tracks[track-1].subtype = CD_SUB_NONE;
				outtoc.tracks[track-1].subsize = 0;

				outtoc.tracks[track-1].pregap = (uint32_t)(index1-index0)/size;
				outtoc.tracks[track-1].frames = (uint32_t)(track_end-index1)/size;
				outtoc.tracks[track-1].postgap = 0;
				outtoc.tracks[track-1].pgtype = 0;
				outtoc.tracks[track-1].pgsub = CD_SUB_NONE;
				outtoc.tracks[track-1].pgdatasize = 0;
				outtoc.tracks[track-1].pgsubsize = 0;
				outtoc.tracks[track-1].padframes = 0;

				offset += (uint32_t)track_end-index1;
			}
		}

		if (!memcmp(buffer, "END!", 4))
		{
			done = 1;
		}
		else
		{
			// Discpress: each chunk must lead further into the file
			uint64_t const next = uint64_t(chain_offs) + chunk_size + 8;
			if (next + 8 > filesize || next > UINT32_MAX)
			{
				osd_printf_error("ERROR: NRG image's chunks end without an END! chunk\n");
				fclose(infile);
				return chd_file::error::INVALID_DATA;
			}
			chain_offs = uint32_t(next);
		}
	}

	fclose(infile);

	return std::error_condition();
}

/*-------------------------------------------------
    parse_iso - parse a .ISO file
-------------------------------------------------*/

/**
 * @fn  std::error_condition parse_iso(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
 *
 * @brief   Parse ISO.
 *
 * @param   tocfname        The tocfname.
 * @param [in,out]  outtoc  The outtoc.
 * @param [in,out]  outinfo The outinfo.
 *
 * @return  A std::error_condition.
 */

std::error_condition cdrom_file::parse_iso(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
{
	std::string path = std::string(tocfname);

	FILE *infile = fopen(path.c_str(), "rb");
	if (!infile)
	{
		return std::error_condition(errno, std::generic_category());
	}

	path = get_file_path(path);

	/* clear structures */
	memset(&outtoc, 0, sizeof(outtoc));
	outinfo.reset();

	uint64_t size = get_file_size(tocfname);
	fclose(infile);


	outtoc.numtrks = 1;
	outtoc.numsessions = 1;

	outinfo.track[0].fname = tocfname;
	outinfo.track[0].offset = 0;
	outinfo.track[0].idx[0] = outinfo.track[0].idx[1] = 0;

	if ((size % 2048) == 0)
	{
		outtoc.tracks[0].trktype = CD_TRACK_MODE1;
		outtoc.tracks[0].frames = size / 2048;
		outtoc.tracks[0].datasize = 2048;
		outinfo.track[0].swap = false;
	}
	else if ((size % 2336) == 0)
	{
		// 2352 byte mode 2
		outtoc.tracks[0].trktype = CD_TRACK_MODE2;
		outtoc.tracks[0].frames = size / 2336;
		outtoc.tracks[0].datasize = 2336;
		outinfo.track[0].swap = false;
	}
	else if ((size % 2352) == 0)
	{
		// 2352 byte mode 2 raw
		outtoc.tracks[0].trktype = CD_TRACK_MODE2_RAW;
		outtoc.tracks[0].frames = size / 2352;
		outtoc.tracks[0].datasize = 2352;
		outinfo.track[0].swap = false;
	}
	else
	{
		osd_printf_error("ERROR: Unrecognized track type\n");
		return chd_file::error::UNSUPPORTED_FORMAT;
	}

	outtoc.tracks[0].subtype = CD_SUB_NONE;
	outtoc.tracks[0].subsize = 0;

	outtoc.tracks[0].pregap = 0;

	outtoc.tracks[0].postgap = 0;
	outtoc.tracks[0].pgtype = 0;
	outtoc.tracks[0].pgsub = CD_SUB_NONE;
	outtoc.tracks[0].pgdatasize = 0;
	outtoc.tracks[0].pgsubsize = 0;
	outtoc.tracks[0].padframes = 0;


	return std::error_condition();
}

/*-------------------------------------------------
    parse_gdi - parse a Sega GD-ROM rip
-------------------------------------------------*/

/**
 * @fn  static std::error_condition parse_gdi(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
 *
 * @brief   Chdcd parse GDI.
 *
 * @param   tocfname        The tocfname.
 * @param [in,out]  outtoc  The outtoc.
 * @param [in,out]  outinfo The outinfo.
 *
 * @return  A std::error_condition.
 */

std::error_condition cdrom_file::parse_gdi(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
{
	char token[512];
	int i = 0;
	int trackcnt = 0;

	std::string path = std::string(tocfname);

	FILE *infile = fopen(path.c_str(), "rt");
	if (!infile)
	{
		return std::error_condition(errno, std::generic_category());
	}

	path = get_file_path(path);

	/* clear structures */
	memset(&outtoc, 0, sizeof(outtoc));
	outinfo.reset();

	outtoc.flags = CD_FLAG_GDROM;

	char linebuffer[512];
	memset(linebuffer, 0, sizeof(linebuffer));

	if (!fgets(linebuffer,511,infile))
	{
		osd_printf_error("GDI doesn't have track count (blank file?)\n");
		return chd_file::error::INVALID_DATA;
	}

	i = 0;
	TOKENIZE

	const int numtracks = atoi(token);

	if (numtracks > int(std::size(outinfo.track))) // Discpress: 0.289 let 100 tracks through, then aborted
	{
		osd_printf_error("GDI expects too many tracks. Expected %d tracks but only up to %zu tracks allowed\n", numtracks, std::size(outinfo.track) + 1);
		return chd_file::error::INVALID_DATA;
	}

	if (numtracks == 0)
	{
		osd_printf_error("GDI header specifies no tracks\n");
		return chd_file::error::INVALID_DATA;
	}

	while (!feof(infile))
	{
		int paramcnt = 0;

		if (!fgets(linebuffer,511,infile))
			break;

		i = 0;
		TOKENIZE

		// Ignore empty lines so they're not countered toward the total track count
		if (!token[0])
			continue;

		paramcnt++;
		const int trknum = atoi(token) - 1;

		if (trknum < 0 || trknum >= int(std::size(outinfo.track)) || trknum + 1 > numtracks)
		{
			osd_printf_error("Track %d is out of expected range of 1 to %d\n", trknum + 1, numtracks);
			return chd_file::error::INVALID_DATA;
		}

		if (outtoc.tracks[trknum].datasize != 0)
			osd_printf_warning("Track %d defined multiple times?\n", trknum + 1);
		else
			trackcnt++;

		outinfo.track[trknum].swap = false;
		outinfo.track[trknum].offset = 0;

		outtoc.tracks[trknum].datasize = 0;
		outtoc.tracks[trknum].subtype = CD_SUB_NONE;
		outtoc.tracks[trknum].subsize = 0;
		outtoc.tracks[trknum].pgsub = CD_SUB_NONE;

		TOKENIZE
		if (token[0])
			paramcnt++;
		outtoc.tracks[trknum].physframeofs = atoi(token);

		TOKENIZE
		if (token[0])
			paramcnt++;
		const int trktype = atoi(token);

		TOKENIZE
		if (token[0])
			paramcnt++;
		const int trksize = atoi(token);

		if (trktype == 4 && trksize == 2352)
		{
			outtoc.tracks[trknum].trktype = CD_TRACK_MODE1_RAW;
			outtoc.tracks[trknum].datasize = 2352;
		}
		else if (trktype == 4 && trksize == 2048)
		{
			outtoc.tracks[trknum].trktype = CD_TRACK_MODE1;
			outtoc.tracks[trknum].datasize = 2048;
		}
		else if (trktype == 0 && trksize > 0) // Discpress: 0.289 divided by a size of 0
		{
			outtoc.tracks[trknum].trktype = CD_TRACK_AUDIO;
			outtoc.tracks[trknum].datasize = 2352;
			outinfo.track[trknum].swap = true;
		}
		else
		{
			osd_printf_error("Unknown track type %d and track size %d combination encountered\n", trktype, trksize);
			return chd_file::error::INVALID_DATA;
		}

		// skip to start of next token
		int pi = i;
		while (pi < std::size(linebuffer) && isspace((uint8_t)linebuffer[pi]))
			pi++;

		if (linebuffer[pi] == '"' && strchr(linebuffer + pi + 1, '"') == nullptr)
		{
			osd_printf_error("Track %d filename does not having closing quotation mark: '%s'\n", trknum + 1, linebuffer + pi);
			return chd_file::error::INVALID_DATA;
		}

		TOKENIZE
		if (token[0])
			paramcnt++;

		outinfo.track[trknum].fname.assign(path).append(token);

		const uint64_t sz = get_file_size(outinfo.track[trknum].fname);
		if (sz == 0) // Discpress: as a cue sheet does (0.289 made the track empty and went on)
		{
			fclose(infile);
			osd_printf_error("ERROR: couldn't find bin file [%s]\n", outinfo.track[trknum].fname);
			return std::errc::no_such_file_or_directory;
		}
		outtoc.tracks[trknum].frames = sz / trksize;
		outtoc.tracks[trknum].padframes = 0;

		if (trknum != 0)
		{
			const int dif = outtoc.tracks[trknum].physframeofs - (outtoc.tracks[trknum-1].frames + outtoc.tracks[trknum-1].physframeofs);
			outtoc.tracks[trknum-1].frames += dif;
			outtoc.tracks[trknum-1].padframes = dif;
		}

		TOKENIZE
		// offset parameter, not used
		if (token[0])
			paramcnt++;

		// check if there are any extra parameters that shouldn't be there
		while (token[0])
		{
			TOKENIZE
			if (token[0])
				paramcnt++;
		}

		if (paramcnt != 6)
		{
			osd_printf_error("GDI track entry should have 6 parameters, found %d\n", paramcnt);
			return chd_file::error::INVALID_DATA;
		}
	}

	bool missing_tracks = trackcnt != numtracks;
	for (int i = 0; i < numtracks; i++)
	{
		if (outtoc.tracks[i].datasize == 0)
		{
			osd_printf_warning("Could not find track %d\n", i + 1);
			missing_tracks = true;
		}
	}

	if (missing_tracks)
	{
		osd_printf_error("GDI is missing tracks\n");
		return chd_file::error::INVALID_DATA;
	}

	if (EXTRA_VERBOSE)
		for (int i = 0; i < numtracks; i++)
		{
			osd_printf_verbose("'%s' %d %d %d (true %d)\n", outinfo.track[i].fname, outtoc.tracks[i].frames, outtoc.tracks[i].padframes, outtoc.tracks[i].physframeofs, outtoc.tracks[i].frames - outtoc.tracks[i].padframes);
		}

	/* close the input TOC */
	fclose(infile);

	/* store the number of tracks found */
	outtoc.numtrks = numtracks;
	outtoc.numsessions = 1;

	return std::error_condition();
}

/*-------------------------------------------------
    parse_cue - parse a .CUE file
-------------------------------------------------*/

/**
 * @fn  std::error_condition parse_cue(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
 *
 * @brief   Chdcd parse cue.
 *
 * @param   tocfname        The tocfname.
 * @param [in,out]  outtoc  The outtoc.
 * @param [in,out]  outinfo The outinfo.
 *
 * @return  A std::error_condition.
 *
 * Redump multi-CUE for Dreamcast GDI:
 * Dreamcast discs have two images on a single disc. The first image is SINGLE-DENSITY and the second image
 * is HIGH-DENSITY. The SINGLE-DENSITY area starts 0 LBA and HIGH-DENSITY area starts 45000 LBA.
 */

std::error_condition cdrom_file::parse_cue(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
{
	int i, trknum, sessionnum, session_pregap;
	char token[512];
	std::string lastfname;
	uint32_t wavlen, wavoffs;
	std::string path = std::string(tocfname);
	const bool is_gdrom = is_gdicue(tocfname);
	enum gdi_area current_area = SINGLE_DENSITY;
	bool is_multibin = false;
	int leadin = -1;
	// Discpress: per track, whether its FILE is MOTOROLA (big-endian audio), and where the samples of its
	// .WAV file are (offset, length; 0 for other files), for .WAV files that hold several tracks
	bool curmotorola = false;
	uint32_t curwavoffs = 0, curwavlen = 0;
	std::vector<bool> motorola(MAX_TRACKS + 1);
	std::vector<std::pair<uint32_t, uint32_t> > wavdata(MAX_TRACKS + 1);

	FILE *infile = fopen(path.c_str(), "rt");
	if (!infile)
	{
		return std::error_condition(errno, std::generic_category());
	}

	path = get_file_path(path);

	/* clear structures */
	memset(&outtoc, 0, sizeof(outtoc));
	outinfo.reset();

	trknum = -1;
	wavoffs = wavlen = 0;
	sessionnum = 0;
	session_pregap = 0;

	if (is_gdrom)
	{
		outtoc.flags = CD_FLAG_GDROM;
	}

	char linebuffer[512];
	memset(linebuffer, 0, sizeof(linebuffer));

	// Discpress: a line that belongs to a track, before the first TRACK, wrote before the track table
	auto const before_track = [&infile] (const char *what)
	{
		fclose(infile);
		osd_printf_error("ERROR: %s before the first TRACK\n", what);
		return std::error_condition(chd_file::error::INVALID_DATA);
	};

	while (!feof(infile))
	{
		/* get the next line */
		if (!fgets(linebuffer, 511, infile))
			break;

		i = 0;

		TOKENIZE

		if (!strcmp(token, "REM"))
		{
			/* skip to actual data of REM command */
			while (i < std::size(linebuffer) && isspace((uint8_t)linebuffer[i]))
				i++;

			if (!strncmp(linebuffer+i, "SESSION", 7))
			{
				/* IsoBuster extension */
				TOKENIZE

				/* get the session number */
				TOKENIZE

				sessionnum = strtoul(token, nullptr, 10) - 1;

				if (sessionnum >= 1) /* don't consider it a multisession CD unless there's actually more than 1 session */
					outtoc.flags |= CD_FLAG_MULTISESSION;
			}
			else if ((outtoc.flags & CD_FLAG_MULTISESSION) && !strncmp(linebuffer+i, "PREGAP", 6))
			{
				/*
				Redump extension? PREGAP associated with the session instead of the track

				DiscImageCreator - Older versions would write a bogus value here (and maybe session lead-in and lead-out).
				These should be considered bad dumps and will not be supported.
				*/
				TOKENIZE

				/* get pregap time */
				TOKENIZE
				session_pregap = msf_to_frames(token);
			}
			else if (!strncmp(linebuffer+i, "LEAD-OUT", 8))
			{
				/*
				IsoBuster and ImgBurn (single bin file) - Lead-out time is the start of the lead-out
				lead-out time - MSF of last track of session = size of last track

				Redump and DiscImageCreator (multiple bins) - Lead-out time is the duration of just the lead-out
				*/
				TOKENIZE

				/* get lead-out time */
				TOKENIZE
				int leadout_offset = msf_to_frames(token);
				if (trknum < 0)
					return before_track("REM LEAD-OUT");
				outinfo.track[trknum].leadout = leadout_offset;
			}
			else if (!strncmp(linebuffer+i, "LEAD-IN", 7))
			{
				/*
				IsoBuster and ImgBurn (single bin file) - Not used?
				Redump and DiscImageCreator (multiple bins) - Lead-in time is the duration of just the lead-in
				*/
				TOKENIZE

				/* get lead-in time */
				TOKENIZE
				leadin = msf_to_frames(token);
			}
			else if (is_gdrom && !strncmp(linebuffer+i, "SINGLE-DENSITY AREA", 19))
			{
				/* single-density area starts LBA = 0 */
				current_area = SINGLE_DENSITY;
			}
			else if (is_gdrom && !strncmp(linebuffer+i, "HIGH-DENSITY AREA", 17))
			{
				/* high-density area starts LBA = 45000 */
				current_area = HIGH_DENSITY;
			}
		}
		else if (!strcmp(token, "FILE"))
		{
			/* found the data file for a track */
			TOKENIZE

			/* keep the filename */
			if (!is_multibin)
			{
				std::string prevfname(std::move(lastfname));
				lastfname.assign(path).append(token);
				is_multibin = !prevfname.empty() && lastfname != prevfname;
			}
			else
			{
				lastfname.assign(path).append(token);
			}

			/* get the file type */
			TOKENIZE

			curmotorola = false;
			curwavoffs = curwavlen = 0;
			if (!strcmp(token, "BINARY"))
			{
				if (trknum + 1 < int(MAX_TRACKS))
					outinfo.track[trknum+1].swap = false;
			}
			else if (!strcmp(token, "MOTOROLA"))
			{
				if (trknum + 1 < int(MAX_TRACKS))
					outinfo.track[trknum+1].swap = true;
				curmotorola = true;
			}
			else if (!strcmp(token, "WAVE"))
			{
				wavlen = parse_wav_sample(lastfname, &wavoffs);
				if (!wavlen)
				{
					fclose(infile);
					osd_printf_error("ERROR: couldn't read [%s] or not a valid .WAV\n", lastfname);
					return chd_file::error::INVALID_DATA;
				}
				curwavoffs = wavoffs;
				curwavlen = wavlen;
			}
			else
			{
				fclose(infile);
				osd_printf_error("ERROR: Unhandled track type %s\n", token);
				return chd_file::error::UNSUPPORTED_FORMAT;
			}
		}
		else if (!strcmp(token, "TRACK"))
		{
			/* get the track number */
			TOKENIZE
			trknum = strtoul(token, nullptr, 10) - 1;
			if (trknum < 0 || trknum >= int(MAX_TRACKS)) // Discpress: TRACK 00 or 100 wrote outside the track table
			{
				fclose(infile);
				osd_printf_error("ERROR: track number %s is not between 1 and %d\n", token, MAX_TRACKS);
				return chd_file::error::INVALID_DATA;
			}

			/* next token on the line is the track type */
			TOKENIZE

			outtoc.tracks[trknum].session = sessionnum;
			outtoc.tracks[trknum].subtype = CD_SUB_NONE;
			outtoc.tracks[trknum].subsize = 0;
			outtoc.tracks[trknum].pgsub = CD_SUB_NONE;
			outtoc.tracks[trknum].pregap = 0;
			outtoc.tracks[trknum].padframes = 0;
			outtoc.tracks[trknum].datasize = 0;
			outtoc.tracks[trknum].multicuearea = is_gdrom ? current_area : 0;
			outinfo.track[trknum].offset = 0;
			std::fill(std::begin(outinfo.track[trknum].idx), std::end(outinfo.track[trknum].idx), -1);

			outinfo.track[trknum].leadout = -1;
			outinfo.track[trknum].leadin = leadin; /* use previously saved lead-in value */
			leadin = -1;

			if (session_pregap != 0)
			{
				/*
				associated the pregap from the session transition with the lead-in to simplify things for now.
				setting it as the proper pregap for the track causes logframeofs of the last dummy entry in the TOC
				to become 2s later than it should. this might be an issue with how pgdatasize = 0 pregaps are handled.
				*/
				if (outinfo.track[trknum].leadin == -1)
					outinfo.track[trknum].leadin = session_pregap;
				else
					outinfo.track[trknum].leadin += session_pregap;
				session_pregap = 0;
			}

			if (wavlen != 0)
			{
				outtoc.tracks[trknum].frames = wavlen/2352;
				outinfo.track[trknum].offset = wavoffs;
				wavoffs = wavlen = 0;
			}
			motorola[trknum] = curmotorola;
			wavdata[trknum] = std::make_pair(curwavoffs, curwavlen);

			outinfo.track[trknum].fname.assign(lastfname); /* default filename to the last one */

			if (EXTRA_VERBOSE)
			{
				if (is_gdrom)
				{
					osd_printf_verbose("trk %d: fname %s offset %d area %d\n", trknum, outinfo.track[trknum].fname, outinfo.track[trknum].offset, outtoc.tracks[trknum].multicuearea);
				}
				else
				{
					osd_printf_verbose("trk %d: fname %s offset %d\n", trknum, outinfo.track[trknum].fname, outinfo.track[trknum].offset);
				}
			}

			convert_type_string_to_track_info(token, &outtoc.tracks[trknum]);
			if (outtoc.tracks[trknum].datasize == 0)
			{
				fclose(infile);
				osd_printf_error("ERROR: Unknown track type [%s].  Contact MAMEDEV.\n", token);
				return chd_file::error::UNSUPPORTED_FORMAT;
			}

			/* next (optional) token on the line is the subcode type */
			TOKENIZE

			convert_subtype_string_to_track_info(token, &outtoc.tracks[trknum]);
		}
		else if (!strcmp(token, "INDEX"))
		{
			int idx, frames;

			/* get index number */
			TOKENIZE
			idx = strtoul(token, nullptr, 10);

			/* get index */
			TOKENIZE
			frames = msf_to_frames(token);

			if (idx < 0 || idx > MAX_INDEX)
			{
				osd_printf_error("ERROR: encountered invalid index %d\n", idx);
				return chd_file::error::INVALID_DATA;
			}
			if (trknum < 0)
				return before_track("INDEX");

			outinfo.track[trknum].idx[idx] = frames;

			if (idx == 1)
			{
				if (outtoc.tracks[trknum].pregap == 0 && outinfo.track[trknum].idx[0] != -1)
				{
					outtoc.tracks[trknum].pregap = frames - outinfo.track[trknum].idx[0];
					outtoc.tracks[trknum].pgtype = outtoc.tracks[trknum].trktype;
					outtoc.tracks[trknum].pgdatasize = outtoc.tracks[trknum].datasize;
				}
				else if (outinfo.track[trknum].idx[0] == -1) /* pregap sectors not in file, but we're always using idx 0 for track length calc now */
				{
					outinfo.track[trknum].idx[0] = frames;
				}
			}
		}
		else if (!strcmp(token, "PREGAP"))
		{
			int frames;

			/* get index */
			TOKENIZE
			frames = msf_to_frames(token);
			if (trknum < 0)
				return before_track("PREGAP");

			outtoc.tracks[trknum].pregap = frames;
		}
		else if (!strcmp(token, "POSTGAP"))
		{
			int frames;

			/* get index */
			TOKENIZE
			frames = msf_to_frames(token);
			if (trknum < 0)
				return before_track("POSTGAP");

			outtoc.tracks[trknum].postgap = frames;
		}
		else if (!strcmp(token, "FLAGS"))
		{
			if (trknum < 0)
				return before_track("FLAGS");
			outtoc.tracks[trknum].control_flags = 0;

			/* keep looping over remaining tokens in FLAGS line until there's no more to read */
			while (i < std::size(linebuffer))
			{
				int last_idx = i;

				TOKENIZE

				if (i == last_idx)
					break;

				if (!strcmp(token, "DCP"))
					outtoc.tracks[trknum].control_flags |= CD_FLAG_CONTROL_DIGITAL_COPY_PERMITTED;
				else if (!strcmp(token, "4CH"))
					outtoc.tracks[trknum].control_flags |= CD_FLAG_CONTROL_4CH;
				else if (!strcmp(token, "PRE"))
					outtoc.tracks[trknum].control_flags |= CD_FLAG_CONTROL_PREEMPHASIS;
			}
		}
	}

	/* close the input CUE */
	fclose(infile);

	/* store the number of tracks found */
	outtoc.numtrks = trknum + 1;
	outtoc.numsessions = sessionnum + 1;

	/* now go over the files again and set the lengths */
	for (trknum = 0; trknum < outtoc.numtrks; trknum++)
	{
		uint64_t tlen = 0;

		if (outinfo.track[trknum].idx[1] == -1)
		{
			/* index 1 should always be set */
			osd_printf_error("ERROR: track %d is missing INDEX 01 marker\n", trknum+1);
			return chd_file::error::INVALID_DATA;
		}

		/* this is true for cue/bin and cue/iso, and we need it for cue/wav since .WAV is little-endian */
		/* Discpress: but not for MOTOROLA files, whose audio is big-endian already (0.289 swapped it) */
		if (outtoc.tracks[trknum].trktype == CD_TRACK_AUDIO)
		{
			outinfo.track[trknum].swap = !motorola[trknum];
		}
		else
		{
			/* Discpress: and never data, which isn't samples (0.289 swapped a data track that opens a MOTOROLA file) */
			outinfo.track[trknum].swap = false;
		}

		const bool sameasprev = trknum > 0 && outinfo.track[trknum].fname.compare(outinfo.track[trknum-1].fname) == 0;
		const bool sameasnext = trknum + 1 < outtoc.numtrks && outinfo.track[trknum].fname.compare(outinfo.track[trknum+1].fname) == 0;

		/* Discpress: a .WAV file with several tracks is split at their INDEX points, like a .bin (0.289 gave
		   the first track all of its samples and read the others from past its end) */
		if (wavdata[trknum].second != 0 && (sameasprev || sameasnext))
		{
			const uint32_t framesize = outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize;
			if (sameasprev)
				outinfo.track[trknum].offset = outinfo.track[trknum-1].offset + outtoc.tracks[trknum-1].frames * (outtoc.tracks[trknum-1].datasize + outtoc.tracks[trknum-1].subsize);
			else
				outinfo.track[trknum].offset = wavdata[trknum].first + outinfo.track[trknum].idx[0] * framesize;
			if (sameasnext)
				outtoc.tracks[trknum].frames = outinfo.track[trknum+1].idx[0] - outinfo.track[trknum].idx[0];
			else
				outtoc.tracks[trknum].frames = (wavdata[trknum].first + wavdata[trknum].second - outinfo.track[trknum].offset) / framesize;
			continue;
		}

		/* don't do this for .WAV tracks, we already have their length and offset filled out */
		if (outinfo.track[trknum].offset != 0)
			continue;

		if (sameasprev && !sameasnext)
		{
			/* if the last track's filename is the same as the previous track */
			/* Discpress: or the last track in a file that another file follows (0.289 gave it the whole file) */
			tlen = get_file_size(outinfo.track[trknum].fname);
			if (tlen == 0)
			{
				osd_printf_error("ERROR: couldn't find bin file [%s]\n", outinfo.track[trknum].fname);
				return std::errc::no_such_file_or_directory;
			}

			outinfo.track[trknum].offset = outinfo.track[trknum-1].offset + outtoc.tracks[trknum-1].frames * (outtoc.tracks[trknum-1].datasize + outtoc.tracks[trknum-1].subsize);
			outtoc.tracks[trknum].frames = (tlen - outinfo.track[trknum].offset) / (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);
		}
		else if (trknum+1 < outtoc.numtrks && outinfo.track[trknum].fname.compare(outinfo.track[trknum+1].fname) == 0)
		{
			/* if the current filename is the same as the next track */
			outtoc.tracks[trknum].frames = outinfo.track[trknum+1].idx[0] - outinfo.track[trknum].idx[0];

			if (outtoc.tracks[trknum].frames == 0)
			{
				osd_printf_error("ERROR: unable to determine size of track %d, missing INDEX 01 markers?\n", trknum+1);
				return chd_file::error::INVALID_DATA;
			}

			if (sameasprev)
			{
				const uint32_t previous_track_raw_size = outtoc.tracks[trknum-1].frames * (outtoc.tracks[trknum-1].datasize + outtoc.tracks[trknum-1].subsize);
				outinfo.track[trknum].offset = outinfo.track[trknum-1].offset + previous_track_raw_size;
			}
			else if (trknum > 0)
			{
				/* Discpress: the first of several tracks in a file that follows another file starts at its own
				   INDEX point in it (0.289 went on from the previous file's offsets) */
				outinfo.track[trknum].offset = outinfo.track[trknum].idx[0] * (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);
			}
		}
		else if (outtoc.tracks[trknum].frames == 0)
		{
			/* if the filenames between tracks are different */
			tlen = get_file_size(outinfo.track[trknum].fname);
			if (tlen == 0)
			{
				osd_printf_error("ERROR: couldn't find bin file [%s]\n", outinfo.track[trknum].fname);
				return std::errc::no_such_file_or_directory;
			}

			outtoc.tracks[trknum].frames = tlen / (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);
			outinfo.track[trknum].offset = 0;
		}

		if (outtoc.flags & CD_FLAG_MULTISESSION)
		{
			if (is_multibin)
			{
				if (outinfo.track[trknum].leadout == -1 && trknum + 1 < outtoc.numtrks && outtoc.tracks[trknum].session != outtoc.tracks[trknum+1].session)
				{
					/* add a standard lead-out to the last track before changing sessions */
					outinfo.track[trknum].leadout = outtoc.tracks[trknum].session == 0 ? 6750 : 2250; /* first session lead-out (1m30s0f) is longer than the rest (0m30s0f) */
				}

				if (outinfo.track[trknum].leadin == -1 && trknum > 0 && outtoc.tracks[trknum].session != outtoc.tracks[trknum-1].session)
				{
					/* add a standard lead-in to the first track of a new session */
					outinfo.track[trknum].leadin = 4500; /* lead-in (1m0s0f) */
				}
			}
			else
			{
				if (outinfo.track[trknum].leadout != -1)
				{
					/*
					if a lead-out time is specified in a multisession CD then the size of the previous track needs to be trimmed
					to use the lead-out time instead of the idx 0 of the next track
					*/
					const int endframes = outinfo.track[trknum].leadout - outinfo.track[trknum].idx[0];
					if (outtoc.tracks[trknum].frames >= endframes)
					{
						outtoc.tracks[trknum].frames = endframes; /* trim track length */

						if (trknum + 1 < outtoc.numtrks)
						{
							/* lead-out value becomes just the duration between the lead-out to the pre-gap of the next track */
							outinfo.track[trknum].leadout = outinfo.track[trknum+1].idx[0] - outinfo.track[trknum].leadout;
						}
					}
				}

				if (trknum > 0 && outinfo.track[trknum-1].leadout != -1)
				{
					/*
					ImgBurn bin/cue have dummy data to pad between the lead-out and the start of the next track.
					DiscImageCreator img/cue does not have any data between the lead-out and the start of the next track.

					Detecting by extension is an awful way to handle this but there's no other way to determine what format
					the data will be in since we don't know the exact length of the last track just from the cue.
					*/
					if (!core_filename_ends_with(outinfo.track[trknum-1].fname, ".img"))
					{
						outtoc.tracks[trknum-1].padframes += outinfo.track[trknum-1].leadout;
						outtoc.tracks[trknum].frames -= outinfo.track[trknum-1].leadout;
						outinfo.track[trknum].offset += outinfo.track[trknum-1].leadout * (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);
					}
				}
			}
		}
	}

	if (is_gdrom)
	{
		/*
		* Strip pregaps from Redump tracks and adjust the LBA offset to match TOSEC layout
		*/
		for (trknum = 1; trknum < outtoc.numtrks; trknum++)
		{
			uint32_t this_pregap = outtoc.tracks[trknum].pregap;
			uint32_t this_offset = this_pregap * (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);

			outtoc.tracks[trknum-1].frames += this_pregap;
			outtoc.tracks[trknum-1].splitframes += this_pregap;

			outinfo.track[trknum].offset += this_offset;
			outtoc.tracks[trknum].frames -= this_pregap;
			outinfo.track[trknum].idx[1] -= this_pregap;

			outtoc.tracks[trknum].pregap = 0;
			outtoc.tracks[trknum].pgtype = 0;
		}

		/*
		* TOC now matches TOSEC layout, set LBA for every track with HIGH-DENSITY area @ LBA 45000
		*/
		for (trknum = 1; trknum < outtoc.numtrks; trknum++)
		{
			if (outtoc.tracks[trknum].multicuearea == HIGH_DENSITY && outtoc.tracks[trknum-1].multicuearea == SINGLE_DENSITY)
			{
				outtoc.tracks[trknum].physframeofs = 45000;
				int dif=outtoc.tracks[trknum].physframeofs-(outtoc.tracks[trknum-1].frames+outtoc.tracks[trknum-1].physframeofs);
				outtoc.tracks[trknum-1].frames += dif;
				outtoc.tracks[trknum-1].padframes = dif;
			}
			else
			{
				outtoc.tracks[trknum].physframeofs = outtoc.tracks[trknum-1].physframeofs + outtoc.tracks[trknum-1].frames;
			}
		}
	}

	if (EXTRA_VERBOSE)
	{
		for (trknum = 0; trknum < outtoc.numtrks; trknum++)
		{
			osd_printf_verbose("session %d trk %d: %d frames @ offset %d, pad=%d, split=%d, area=%d, phys=%d, pregap=%d, pgtype=%d, pgdatasize=%d, idx0=%d, idx1=%d, dataframes=%d\n",
					outtoc.tracks[trknum].session + 1,
					trknum + 1,
					outtoc.tracks[trknum].frames,
					outinfo.track[trknum].offset,
					outtoc.tracks[trknum].padframes,
					outtoc.tracks[trknum].splitframes,
					outtoc.tracks[trknum].multicuearea,
					outtoc.tracks[trknum].physframeofs,
					outtoc.tracks[trknum].pregap,
					outtoc.tracks[trknum].pgtype,
					outtoc.tracks[trknum].pgdatasize,
					outinfo.track[trknum].idx[0],
					outinfo.track[trknum].idx[1],
					outtoc.tracks[trknum].frames - outtoc.tracks[trknum].padframes);
		}
	}

	return std::error_condition();
}

/*---------------------------------------------------------------------------------------
    is_gdicue - determine if CUE contains Redump multi-CUE format for Dreamcast GDI
----------------------------------------------------------------------------------------*/

/**
 * Dreamcast GDI has two images on one disc, SINGLE-DENSITY and HIGH-DENSITY.
 *
 * Redump stores both images in a single .cue with a REM comment separating the images.
 * This multi-cue format replaces the old flawed .gdi format.
 *
 *    http://forum.redump.org/topic/19969/done-sega-dreamcast-multicue-gdi/
 *
 * This function looks for strings "REM SINGLE-DENSITY AREA" & "REM HIGH-DENSITY AREA"
 * indicating the Redump multi-cue format and therefore a Dreamcast GDI disc.
 */

bool cdrom_file::is_gdicue(std::string_view tocfname)
{
	char token[512];
	bool has_rem_singledensity = false;
	bool has_rem_highdensity = false;
	std::string path = std::string(tocfname);

	FILE *infile = fopen(path.c_str(), "rt");
	if (!infile)
	{
		return false;
	}

	path = get_file_path(path);

	char linebuffer[512];
	memset(linebuffer, 0, sizeof(linebuffer));

	while (!feof(infile))
	{
		if (!fgets(linebuffer, 511, infile))
			break;

		int i = 0;

		TOKENIZE

		if (!strcmp(token, "REM"))
		{
			/* skip to actual data of REM command */
			while (i < std::size(linebuffer) && isspace((uint8_t)linebuffer[i]))
				i++;

			if (!strncmp(linebuffer+i, "SINGLE-DENSITY AREA", 19))
				has_rem_singledensity = true;
			else if (!strncmp(linebuffer+i, "HIGH-DENSITY AREA", 17))
				has_rem_highdensity = true;
		}
	}

	fclose(infile);

	return has_rem_singledensity && has_rem_highdensity;
}

/*-------------------------------------------------
    parse_toc - parse a CDRDAO format TOC file
-------------------------------------------------*/

/**
 * @fn  std::error_condition parse_toc(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
 *
 * @brief   Chdcd parse TOC.
 *
 * @param   tocfname        The tocfname.
 * @param [in,out]  outtoc  The outtoc.
 * @param [in,out]  outinfo The outinfo.
 *
 * @return  A std::error_condition.
 */

std::error_condition cdrom_file::parse_toc(std::string_view tocfname, toc &outtoc, track_input_info &outinfo)
{
	char token[512];

	auto pos = tocfname.rfind('.');
	std::string tocfext = pos == std::string_view::npos ? std::string() : strmakelower(tocfname.substr(pos + 1));

	if (tocfext == "gdi")
	{
		return parse_gdi(tocfname, outtoc, outinfo);
	}

	if (tocfext == "cue")
	{
		return parse_cue(tocfname, outtoc, outinfo);
	}

	if (tocfext == "nrg")
	{
		return parse_nero(tocfname, outtoc, outinfo);
	}

	if (tocfext == "iso" || tocfext == "cdr" || tocfext == "toast")
	{
		return parse_iso(tocfname, outtoc, outinfo);
	}

	std::string path = std::string(tocfname);

	FILE *infile = fopen(path.c_str(), "rt");
	if (!infile)
	{
		return std::error_condition(errno, std::generic_category());
	}

	path = get_file_path(path);

	/* clear structures */
	memset(&outtoc, 0, sizeof(outtoc));
	outinfo.reset();

	int trknum = -1;

	char linebuffer[512];
	memset(linebuffer, 0, sizeof(linebuffer));

	// Discpress: a line that belongs to a track, before the first TRACK, wrote before the track table
	auto const before_track = [&infile] (const char *what)
	{
		fclose(infile);
		osd_printf_error("ERROR: %s before the first TRACK\n", what);
		return std::error_condition(chd_file::error::INVALID_DATA);
	};

	while (!feof(infile))
	{
		/* get the next line */
		if (!fgets(linebuffer, 511, infile))
			break;

		int i = 0;

		TOKENIZE

		/*
		Samples: https://github.com/cdrdao/cdrdao/tree/master/testtocs

		Unimplemented:
		CD_TEXT
		SILENCE
		ZERO
		FIFO
		PREGAP
		CATALOG
		ISRC
		*/
		if (!strcmp(token, "NO"))
		{
			if (trknum < 0)
				return before_track("NO");
			TOKENIZE
			if (!strcmp(token, "COPY"))
				outtoc.tracks[trknum].control_flags &= ~CD_FLAG_CONTROL_DIGITAL_COPY_PERMITTED;
			else if (!strcmp(token, "PRE_EMPHASIS"))
				outtoc.tracks[trknum].control_flags &= ~CD_FLAG_CONTROL_PREEMPHASIS;
		}
		else if (!strcmp(token, "COPY"))
		{
			if (trknum < 0)
				return before_track("COPY");
			outtoc.tracks[trknum].control_flags |= CD_FLAG_CONTROL_DIGITAL_COPY_PERMITTED;
		}
		else if (!strcmp(token, "PRE_EMPHASIS"))
		{
			if (trknum < 0)
				return before_track("PRE_EMPHASIS");
			outtoc.tracks[trknum].control_flags |= CD_FLAG_CONTROL_PREEMPHASIS;
		}
		else if (!strcmp(token, "TWO_CHANNEL_AUDIO"))
		{
			if (trknum < 0)
				return before_track("TWO_CHANNEL_AUDIO");
			outtoc.tracks[trknum].control_flags &= ~CD_FLAG_CONTROL_4CH;
		}
		else if (!strcmp(token, "FOUR_CHANNEL_AUDIO"))
		{
			if (trknum < 0)
				return before_track("FOUR_CHANNEL_AUDIO");
			outtoc.tracks[trknum].control_flags |= CD_FLAG_CONTROL_4CH;
		}
		else if ((!strcmp(token, "DATAFILE")) || (!strcmp(token, "AUDIOFILE")) || (!strcmp(token, "FILE")))
		{
			int f;
			if (trknum < 0)
				return before_track(token);

			/* found the data file for a track */
			TOKENIZE

			/* keep the filename */
			outinfo.track[trknum].fname.assign(path).append(token);

			/* get either the offset or the length */
			TOKENIZE

			if (!strcmp(token, "SWAP"))
			{
				TOKENIZE

				outinfo.track[trknum].swap = true;
			}
			else
			{
				outinfo.track[trknum].swap = false;
			}

			if (token[0] == '#')
			{
				/* it's a decimal offset, use it */
				f = strtoul(&token[1], nullptr, 10);
			}
			else if (isdigit((uint8_t)token[0]))
			{
				/* convert the time to an offset */
				f = msf_to_frames(token);

				f *= (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);
			}
			else
			{
				f = 0;
			}

			outinfo.track[trknum].offset = f;

			TOKENIZE

			if (isdigit((uint8_t)token[0]))
			{
				// this could be the length or an offset from the previous field.
				f = msf_to_frames(token);

				TOKENIZE

				if (isdigit((uint8_t)token[0]))
				{
					// it was an offset.
					f *= (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);

					outinfo.track[trknum].offset += f;

					// this is the length.
					f = msf_to_frames(token);
				}
			}
			else if (trknum == 0 && outinfo.track[trknum].offset != 0)
			{
				/* the 1st track might have a length with no offset */
				f = outinfo.track[trknum].offset / (outtoc.tracks[trknum].datasize + outtoc.tracks[trknum].subsize);
				outinfo.track[trknum].offset = 0;
			}
			else
			{
				/* guesstimate the track length? */
				f = 0;
			}

			outtoc.tracks[trknum].frames = f;
		}
		else if (!strcmp(token, "TRACK"))
		{
			trknum++;
			if (trknum >= int(MAX_TRACKS)) // Discpress: 0.289 wrote past its track table
			{
				fclose(infile);
				osd_printf_error("ERROR: more than %d tracks\n", MAX_TRACKS);
				return chd_file::error::INVALID_DATA;
			}

			/* next token on the line is the track type */
			TOKENIZE

			outtoc.tracks[trknum].trktype = CD_TRACK_MODE1;
			outtoc.tracks[trknum].datasize = 0;
			outtoc.tracks[trknum].subtype = CD_SUB_NONE;
			outtoc.tracks[trknum].subsize = 0;
			outtoc.tracks[trknum].pgsub = CD_SUB_NONE;
			outtoc.tracks[trknum].padframes = 0;

			convert_type_string_to_track_info(token, &outtoc.tracks[trknum]);
			if (outtoc.tracks[trknum].datasize == 0)
			{
				fclose(infile);
				osd_printf_error("ERROR: Unknown track type [%s].  Contact MAMEDEV.\n", token);
				return chd_file::error::UNSUPPORTED_FORMAT;
			}

			/* next (optional) token on the line is the subcode type */
			TOKENIZE

			convert_subtype_string_to_track_info(token, &outtoc.tracks[trknum]);
		}
		else if (!strcmp(token, "START"))
		{
			if (trknum < 0)
				return before_track("START");
			int frames;

			/* get index */
			TOKENIZE
			frames = msf_to_frames(token);

			outtoc.tracks[trknum].pregap = frames;
		}
	}

	/* close the input TOC */
	fclose(infile);

	/* store the number of tracks found */
	outtoc.numtrks = trknum + 1;
	outtoc.numsessions = 1;

	return std::error_condition();
}
