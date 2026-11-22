/* ============================================================
   per-console and per-disc rules: what an emulator needs or can't do, and what chdman 0.289 does
   wrong with a disc. Each rule has a stable id (data-quirk on its note), the systems it applies to
   (sys, or every system when it has none), and when(ctx) (does it apply to this job?). What it does:
   - act: 'nokeepcue' (createcd leaves out --keepcue; that gives chdman's own CHD) or 'norename'
     (the results keep their file's name);
   - text: shown on the card (a string, or a function of ctx), in the warning colour with warn.
   src: where the fact comes from (docs/chd, or an emulator's source).
   Compression never changes by itself: those warnings are in PROFILES (noZstd, noMister).
   ============================================================ */
function naomiSerial(s) {
  var m = /^(GD[LSTX])-?(\d{4}[A-Z]*)$/i.exec(String(s || '').trim());
  return m ? (m[1] + '-' + m[2]).toLowerCase() : '';
}
var QUIRKS = [
  {
    id: 'keepcue-strict', sys: ['saturn', 'segacd', 'pcecd'], act: 'nokeepcue',
    when: function (c) { return c.keepCue; },
    text: function (c) {
      return (c.sys === 'saturn' ? 'Kronos and Yabause reject' : 'jgenesis rejects') + ' CHDs that keep their cue sheet, so this one leaves it out (the setting \u201cKeep the cue sheet in CD CHDs\u201d is on).';
    },
    src: 'docs/chd/ecosystem-other.md §0 finding 4, §2.5, §3.2, §3.3: readers that fail on any metadata tag but a track\u2019s'
  },
  {
    id: 'naomi-name', sys: ['naomi', 'naomi2', 'triforce', 'chihiro'],
    act: function (c) { return naomiSerial(c.id.serial) ? 'serialname' : 'norename'; },
    chd: true,
    when: function () { return settings.rename; },
    text: function (c) {
      var sn = naomiSerial(c.id.serial);
      return sn
        ? 'MAME and Flycast find this arcade GD-ROM by its disc serial in the game\u2019s romset folder, so this CHD is named ' + sn + '.chd (place it next to the romset\u2019s .zip).'
        : 'MAME and Flycast find a NAOMI GD-ROM by its file name in the game\u2019s romset (such as gds-0014.chd), so this CHD keeps its file\u2019s name.';
    },
    src: 'docs/chd/ecosystem-sony-dreamcast.md §5.1 (Flycast gdcartridge.cpp: <romset>/<serial>.chd), §5.4'
  },
  {
    // Konami System 573 & Namco System 246/256 arcade CHDs must keep their MAME/Play! romset filename
    id: 'arcade-norename', sys: ['ks573', 'ns246'], act: 'norename', chd: true,
    when: function () { return settings.rename; },
    text: 'MAME and Play! look up this arcade CHD by its romset file name, so it keeps its file\u2019s name.',
    src: 'MAME ksys573 / namcos246 and Play! Arcade Wiki (romset filenames)'
  },
  {
    // Dreamcast Windows CE (0WINCEOS.BIN at IP.BIN 0x60): Redream 1.5.0 stable cannot boot WinCE titles
    id: 'dc-wince', sys: ['dc'],
    when: function (c) { return !!c.det.wince; },
    text: 'This Dreamcast game uses Windows CE (0WINCEOS.BIN): Redream 1.5.0 stable can\u2019t boot Windows CE titles. Use Flycast or a newer Redream dev build.',
    src: 'Marcus Comstedt IP0000.BIN spec (0x60 = 0WINCEOS.BIN); Redream 1.5.0 compatibility'
  },
  {
    // PS2 DVD-9 dual-layer image truncated to single layer (<= 4.70 GB while Redump entry > 4.70 GB)
    id: 'ps2-dvd9-truncated', sys: ['ps2'], warn: true,
    when: function (c) {
      return !!(c.id.entry && c.id.entry.size > 4700372992 && c.job.kind === 'create' && jobImageBytes(c.job) > 0 && jobImageBytes(c.job) <= 4700372992);
    },
    text: 'This is a dual-layer DVD-9 game, and this image appears to be ripped or truncated to a single layer (missing Layer 1 data).',
    src: 'PS2 DVD-5 2,295,104-sector ceiling (4,700,372,992 bytes) vs Redump DVD-9 entry size'
  },
  {
    // Sega Saturn mandatory expansion cartridges (db/facts/saturn-cart.tsv)
    id: 'saturn-rom-cart', sys: ['saturn'], warn: true, chd: true,
    when: function (c) { return !!c.facts.sat_rom_cart; },
    text: 'This Saturn game requires its dedicated 2 MB ROM cartridge image alongside the CHD in Beetle Saturn, Mednafen, Kronos or Ymir.',
    src: 'db/facts/saturn-cart.tsv (sat_rom_cart)'
  },
  {
    id: 'saturn-mpeg-card', sys: ['saturn'], warn: true, chd: true,
    when: function (c) { return !!c.facts.sat_mpeg_card; },
    text: 'This Saturn edition requires the Sega Saturn Video CD / MPEG Card (HSS-0119) enabled in the emulator.',
    src: 'db/facts/saturn-cart.tsv (sat_mpeg_card)'
  },
  {
    id: 'saturn-ram-4m', sys: ['saturn'], chd: true,
    when: function (c) { return !!c.facts.sat_ram_4m; },
    text: 'This Saturn game requires the 4 MB Extended RAM cartridge (HSS-0151). If it stops at a Japanese boot screen, enable the 4 MB RAM cart in your emulator.',
    src: 'db/facts/saturn-cart.tsv (sat_ram_4m)'
  },
  {
    id: 'saturn-ram-1m', sys: ['saturn'], chd: true,
    when: function (c) { return !!c.facts.sat_ram_1m; },
    text: 'This Saturn game requires the 1 MB Extended RAM cartridge (HSS-0150). Forcing a 4 MB cart can cause sprite corruption in SNK games; leave auto-detection on or select 1 MB.',
    src: 'db/facts/saturn-cart.tsv (sat_ram_1m)'
  },
  {
    // PCSX2's CHD reader (ChdFileReader) reads a CD's first track only
    id: 'ps2-cd-audio', sys: ['ps2'],
    when: function (c) { return c.disc && c.disc.audio; },
    text: 'PCSX2 plays only the first track of a CD CHD, so this game\u2019s music tracks won\u2019t play in it. They are kept in the CHD.',
    src: 'docs/chd/ecosystem-sony-dreamcast.md §3.1 (PCSX2 draft PR #12037)'
  },
  {
    // a GD-ROM (Redump's cue lists its high-density area) is laid out as chdman 0.289 does; a CD-based
    // Dreamcast disc with pregaps is rejected by Flycast up to 2.7 ("Unsupported subtype or pre/postgap")
    id: 'dc-cd-gaps', sys: ['dc'], repair: 'dcgaps',
    when: function (c) { return c.disc && c.job.disc === 'cd' && !c.disc.gd && c.disc.gaps; },
    text: 'Flycast 2.7 and earlier can\u2019t load CD-based Dreamcast CHDs whose tracks have pregaps, as this one\u2019s do; newer Flycast builds can. Keep the original files if you use an older one.',
    src: 'docs/chd/ecosystem-sony-dreamcast.md §5.1 (flycast #906)'
  },
  {
    // a PAL PlayStation disc protected by LibCrypt (db/facts/libcrypt.tsv), without its .sbi or .lsd
    // (paired by name: sbiJob) or an in-progress CloneCD .sub scan (scanSub)
    id: 'libcrypt-missing', sys: ['ps1'], warn: true,
    when: function (c) { return c.facts.libcrypt && !c.job.sbi && !c.job.subScanning; },
    text: 'This game is protected by LibCrypt: without its .sbi file next to the CHD, emulators stop it partway or make it misbehave. Add the game\u2019s .sbi file (Redump has one for each protected disc) with its other files, and it is saved with the CHD, under its name.',
    src: 'db/facts/libcrypt.tsv'
  },
  {
    // a UMD Video or UMD Audio disc (UMD_DATA.BIN with UMD_VIDEO or UMD_AUDIO, no PSP_GAME): PPSSPP plays games only
    id: 'umd-video', sys: ['psp'], warn: true,
    when: function (c) { return !!(c.det.video || c.det.umdAudio); },
    text: function (c) {
      return c.det.video
        ? 'This is a UMD Video (a film), not a game: PPSSPP doesn\u2019t play UMD Video discs.'
        : 'This is a UMD Audio (music) disc, not a game: PPSSPP doesn\u2019t play UMD Audio discs.';
    },
    src: 'PPSSPP plays PSP games only (UMD_DATA.BIN with PSP_GAME)'
  },
  {
    // every Jaguar CD is multi-session (Redump: 38 of 38); 0.289 writes no session data
    id: 'jagcd-sessions', sys: ['jagcd'], warn: true, repair: 'sessions',
    when: function () { return true; },
    text: 'Jaguar CD emulators may not load this CHD: BigPEmu doesn\u2019t take CHDs, MiSTer\u2019s Jaguar core loads .cdi only, and Virtual Jaguar (RetroArch) needs session data that chdman 0.289 doesn\u2019t write. Keep the original files too.',
    src: 'docs/chd/optical-media.md §3.5; docs/chd/ecosystem-other.md §0 findings 4 and 12'
  },
  {
    // a CHD keeps no session gap (about 11,400 sectors), so session 2 is read that much too early
    id: 'multisession', warn: true, repair: function (c) { return c.sys === 'pc' && c.disc && c.disc.sessions === 2 ? 'pcsession' : ''; },
    when: function (c) { return c.sys !== 'jagcd' && c.disc && c.disc.sessions > 1; },
    text: function (c) {
      return 'This disc has ' + c.disc.sessions + ' sessions. Its CHD doesn\u2019t keep where each starts, so emulators read the data after the first session from the wrong place' +
        (/^(dc|naomi2?|triforce|chihiro)$/.test(c.sys) ? ', except Flycast builds from September 2026 on, which guess it for MIL-CDs.' : '.') + ' Keep the original files too.';
    },
    src: 'docs/chd/optical-media.md §3.2, §3.5; docs/chd/ecosystem-sony-dreamcast.md §5.1 (Flycast 0abac34)'
  },
  {
    // chdman stores MODE2/2048, MODE2/2324 and MODE2_FORM_MIX tracks as Mode 2 Form 1/2/Mix, which Flycast refuses
    id: 'dc-mode2-form', sys: ['dc', 'naomi', 'naomi2', 'triforce', 'chihiro'], warn: true,
    repair: function (c) { return c.disc && c.disc.tracks.some(function (t) { return t.mode === 'MODE2/2048'; }) ? 'mode2' : ''; },
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return /^MODE2\/(2048|2324)$|^MODE2_FORM_MIX$/.test(t.mode); }); },
    text: 'Flycast can\u2019t load CHDs with MODE2/2048, MODE2/2324 or MODE2_FORM_MIX tracks, as this disc has (chdman stores them as Mode 2 Form 1/2/Mix). Keep the original files for Flycast.',
    src: 'docs/chd/ecosystem-sony-dreamcast.md §5.1 (core/imgread/chd.cpp: track types)'
  },
  {
    // a PlayStation disc is Mode 2 (XA); a 2,048-byte copy has lost its Form 2 sectors and headers
    id: 'ps1-cooked', sys: ['ps1'], warn: true,
    when: function (c) {
      var j = c.job;
      // (a CSO/ZSO, a lone 2,048-byte .iso/.bin/.img, or a descriptor/NRG with 2,048-byte tracks)
      return j.src === 'cso' ||
        (j.src === 'iso' && !j.autoCue && !j.files.some(function (f) { return f.ecm || f.pbp; })) ||
        (j.src === 'img' && !j.syncMode) ||
        j.autoCue === 'MODE1/2048' ||
        (c.disc && c.disc.tracks.some(function (t) { return /\/2048$/.test(t.mode) || t.mode === 'MODE1'; }));
    },
    text: 'This is a 2,048-byte copy of a PlayStation disc, without its raw sectors: the videos and sound stored in them may be missing, and Beetle PSX can\u2019t load its CHD (it takes only raw Mode 2 tracks). Convert the .bin and .cue dump instead, if you have it.',
    src: 'docs/chd/ecosystem-sony-dreamcast.md §2.3 (Beetle PSX accepts MODE2_RAW and AUDIO only)'
  },
  {
    // a Philips CD-i Green Book disc interleaves Mode 2 Form 1/2 sectors with subheaders
    id: 'cdi-cooked', sys: ['cdi'], warn: true,
    when: function (c) {
      var j = c.job;
      return j.src === 'cso' ||
        (j.src === 'iso' && !j.autoCue && !j.files.some(function (f) { return f.ecm; })) ||
        (j.src === 'img' && !j.syncMode) ||
        j.autoCue === 'MODE1/2048' ||
        (c.disc && c.disc.tracks.some(function (t) { return /\/2048$/.test(t.mode) || t.mode === 'MODE1'; }));
    },
    text: 'This is a 2,048-byte copy of a Philips CD-i disc, without its raw Mode 2 sectors: real-time audio, video and CD-RTOS subheaders are lost, and MAME, SAME_CDI and MiSTer CD-i can\u2019t boot it. Convert a raw 2,352-byte .bin and .cue dump instead.',
    src: 'docs/chd/optical-media.md (CDI/2352 Green Book Mode 2 subheaders)'
  },
  {
    // Sega CD 32X requires combined Mega-CD + 32X hardware: Genesis Plus GX and DE10-Nano MiSTer cannot run it
    id: 'segacd-32x', sys: ['segacd'], warn: true,
    when: function (c) { return !!(c.det.cd32x || /\b32X\b/i.test(c.id.name || '')); },
    text: 'This is a Sega CD 32X game: Genesis Plus GX and MiSTer FPGA can\u2019t play it. Use PicoDrive, jgenesis or ares.',
    src: 'Sega CD 32X ("SEGA 32X" at sector 0 offset 0x100)'
  },
  {
    // Redump lists ntrk (> 1) or a track number (> 0) for multi-track releases: warn if tracks are missing
    id: 'missing-audio-tracks', warn: true,
    when: function (c) {
      var e = c.id.entry;
      if (!e || c.job.disc === 'dvd') return false;
      var have = c.disc ? c.disc.tracks.length : (c.job.src === 'pbp' ? (c.job.pbpTracks || 1) : c.job.files.length);
      if (e.ntrk > 1) return have < e.ntrk;
      if (!(e.track > 0)) return false;
      return have === 1;
    },
    text: function (c) {
      var e = c.id.entry, have = c.disc ? c.disc.tracks.length : (c.job.src === 'pbp' ? (c.job.pbpTracks || 1) : c.job.files.length);
      if (e && e.ntrk > 1) {
        return 'Redump\u2019s release of this game has ' + e.ntrk + ' tracks (including music/CD-DA audio), but this image only has ' + have + '. Music may be missing, and some Sega CD and PC Engine CD games freeze without audio tracks. Convert the full multi-track .cue/.bin dump if you have it.';
      }
      return 'Redump\u2019s release of this game has multiple tracks (including music/CD-DA audio), but this image has only one track. Its music will be missing, and some Sega CD and PC Engine CD games freeze without audio tracks. Convert the full multi-track .cue/.bin dump if you have it.';
    },
    src: 'db/db.json.gz track count & track number metadata (e.ntrk > 1 or e.track > 0)'
  },
  {
    // Single-bin cue where Track 1 is data, Track 2 is AUDIO, and Track 2 omits both INDEX 00 and PREGAP (missing 2 s Yellow/Red Book pause)
    id: 'cue-missing-t2-pregap', sys: ['ps1', 'saturn', 'segacd', 'pcecd', 'ngcd'],
    when: function (c) {
      if (c.job.src !== 'cue' || c.job.fromCcd || c.job.files.length !== 1 || !c.disc || c.disc.tracks.length < 2) return false;
      var t1 = c.disc.tracks[0], t2 = c.disc.tracks[1];
      return t1.mode !== 'AUDIO' && t2.mode === 'AUDIO' && !(0 in t2.index) && !t2.pregap && !t1.postgap;
    },
    text: 'Track 2 (the first music track after data) has no INDEX 00 or PREGAP 2-second pause in this single-file .cue sheet, which can shift audio tracks 2 seconds early in emulators.',
    src: 'Yellow/Red Book mandatory 2-second data-to-audio transition pregap'
  },
  {
    // Genesis Plus GX stops its track list at the first data track after track 1
    id: 'segacd-data-tracks', sys: ['segacd'], warn: true,
    when: function (c) { return c.disc && c.disc.tracks.slice(1).some(function (t) { return t.mode !== 'AUDIO'; }); },
    text: function (c) {
      var t = c.disc.tracks.slice(1).find(function (x) { return x.mode !== 'AUDIO'; });
      return 'Genesis Plus GX reads a Sega CD disc\u2019s tracks only up to the first data track after track 1, here track ' + t.no + ', so it misses the tracks from there on.';
    },
    src: 'docs/chd/ecosystem-other.md §2.1 (cdd.c: every later track must be AUDIO)'
  },
  {
    id: 'segacd-long', sys: ['segacd'],
    when: function (c) { return c.disc && discMinutes(c.job, c.disc) >= 80; },
    text: function (c) {
      var m = discMinutes(c.job, c.disc);
      return 'PicoDrive doesn\u2019t load Sega CD images of 80 minutes or more, and this one is ' + Math.floor(m) + ' minutes long' + (m > 100 ? '; Genesis Plus GX takes up to 100.' : '. Genesis Plus GX takes up to 100.');
    },
    src: 'docs/chd/ecosystem-other.md §2.1 (over 100 minutes rejected), §2.2 (80 minutes or more rejected)'
  },
  {
    // libretro BlastEm reads PGTYPE backwards: a stored pregap (V...) is taken as virtual (from its code)
    id: 'segacd-index0', sys: ['segacd'],
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return t.no > 1 && 0 in t.index; }); },
    text: 'libretro BlastEm may start this disc\u2019s music tracks 2 seconds late: it misreads where their pregaps (kept in the CHD) end. Genesis Plus GX, PicoDrive and jgenesis read them right.',
    src: 'docs/chd/ecosystem-other.md §0 finding 3, §2.3 (chdimage.c: fake_pregap when PGTYPE starts with V)'
  },
  {
    // Beetle Saturn, Kronos and Yabause take every pregap as stored and leave postgaps out of the image; ares drops virtual PREGAP
    id: 'saturn-gapcmd', sys: ['saturn'], warn: true, repair: 'gaps',
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return (t.pregapCmd && t.pregap > 0) || t.postgap > 0; }); },
    text: 'Beetle Saturn, Kronos and Yabause read the tracks after a PREGAP or POSTGAP line from the wrong place, and this cue sheet has one (ares also drops virtual PREGAP lines from its track list). A Redump dump (with INDEX 00 lines instead) doesn\u2019t have this problem.',
    src: 'docs/chd/ecosystem-other.md §3.1 to §3.3, §11.2 (PGTYPE ignored, postgap ignored)'
  },
  {
    // the Beetle PCE family, Beetle PC-FX, Geargrafx and Beetle PSX count a postgap into the file offset;
    // jgenesis (Sega CD, PCE CD) ignores postgaps
    id: 'postgap', sys: ['pcecd', 'pcfx', 'ps1', 'segacd'], warn: true, repair: 'gaps',
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return t.postgap > 0; }); },
    text: function (c) {
      return (c.sys === 'segacd' ? 'jgenesis reads' : { pcecd: 'Beetle PCE, Geargrafx and jgenesis', pcfx: 'Beetle PC-FX', ps1: 'Beetle PSX' }[c.sys] + ' read') + ' the tracks after a POSTGAP line from the wrong place, and this cue sheet has one (chdman keeps no postgap data).';
    },
    src: 'docs/chd/ecosystem-other.md §2.5, §4.1 to §4.3; docs/chd/ecosystem-sony-dreamcast.md §2.3'
  },
  {
    // ares drops a virtual pregap of track 2 or later from its TOC; jgenesis (Sega CD, PCE CD) and
    // PCSX ReARMed (PS1) ignore PGTYPE and assume every pregap is stored
    id: 'ares-pregap', sys: ['pcecd', 'segacd', 'ps1'], repair: 'gaps',
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return t.pregapCmd && t.pregap > 0; }); },
    text: function (c) {
      var hasLater = c.disc.tracks.some(function (t) { return t.no > 1 && t.pregapCmd && t.pregap > 0; });
      var other = c.sys === 'ps1' ? 'PCSX ReARMed' : 'jgenesis';
      return hasLater
        ? 'ares leaves this disc\u2019s PREGAP lines out of its track list, and ' + other + ' reads tracks after a virtual PREGAP from the wrong place.'
        : other + ' reads tracks after a virtual PREGAP line from the wrong place, and this cue sheet has one.';
    },
    src: 'docs/chd/ecosystem-other.md §2.5, §11.2; docs/chd/ecosystem-sony-dreamcast.md §2.4'
  },
  {
    // NeoCD takes MODE1 and AUDIO tracks only, and misreads virtual pregaps from track 3 on
    id: 'ngcd-layout', sys: ['ngcd'], warn: true,
    repair: function (c) { return c.disc && !c.disc.tracks.some(function (t) { return /^MODE2/.test(t.mode); }) ? 'gaps' : ''; },
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return /^MODE2/.test(t.mode) || (t.no > 2 && t.pregapCmd && t.pregap > 0); }); },
    text: function (c) {
      return c.disc.tracks.some(function (t) { return /^MODE2/.test(t.mode); })
        ? 'NeoCD can\u2019t load this CHD: it takes only Mode 1 data tracks, and this disc has a Mode 2 one.'
        : 'NeoCD reads the tracks after a PREGAP line from track 3 on from the wrong place, and this cue sheet has one.';
    },
    src: 'docs/chd/ecosystem-other.md §5.1 (cdromtoc.cpp: track types, pregap heuristic)'
  },
  {
    // DOSBox Pure loads .zip directly (smaller than uncompressed -c none CHD)
    id: 'pc-zip-dosboxpure', sys: ['pc'],
    when: function (c) { return c.job.files.some(function (f) { return !!(f.file && f.file.fromZip); }); },
    text: 'DOSBox Pure loads .zip files like this one directly (often smaller than an uncompressed CHD); convert to CHD only for DOSBox-X, 86Box or MiSTer ao486.',
    src: 'DOSBox Pure recommends .zip/.dosz; CHD requires -c none'
  },
  {
    // DOSBox-X omits 4-frame CHD track padding on multi-track CDs
    id: 'dosbox-x-padding', sys: ['pc'],
    when: function (c) { return !!(c.disc && c.disc.tracks.length > 1 && c.disc.audio); },
    text: 'DOSBox-X omits CHD track padding, so music tracks on multi-track PC CDs can start a few frames early in DOSBox-X. 86Box and MiSTer ao486 read them accurately.',
    src: 'DOSBox-X src/dos/cdrom_image.cpp (omits 4-frame track padding)'
  }
];
// what the rules look at: the job's system and identification, its cue sheet or TOC, the settings
function quirkCtx(job) {
  var id = job.ident || {};
  var det = id.detected || {};
  var entrySerials = (id.entry && id.entry.serials) || [];
  // When a Sega disc has its own header serial and it matches one of the release's serials, don't pull
  // in shared box-set compilation serials (e.g. Saturn KOF '95+'96 Twin Pack T-3110G) for hardware facts
  var factSerials = det.serial && SEGA_SYS.test(id.sys || '') && entrySerials.some(function (s) { return sameSerial(id.sys, s, det.serial); })
    ? [det.serial]
    : [det.serial, id.serial].concat(entrySerials);
  return { job: job, id: id, sys: id.sys || '', det: det, disc: discModel(job), keepCue: keepCueWanted(job),
    facts: id.sys ? GameFacts.of(id.sys, factSerials) : {} };
}
// the rules that apply to a job: [{id, act, warn, repair, text}]
function quirks(job) {
  var ctx = quirkCtx(job);
  return QUIRKS.filter(function (r) {
    if (job.kind !== 'create' && !r.chd) return false;
    return (!r.sys || r.sys.indexOf(ctx.sys) >= 0) && r.when(ctx);
  }).map(function (r) {
    var act = typeof r.act === 'function' ? r.act(ctx) : r.act || '';
    var rep = typeof r.repair === 'function' ? r.repair(ctx) : r.repair || '';
    // cue-rewriting repairs require an editable .cue descriptor; --sessions also works on .toc
    if (rep && !(job.kind === 'create' && (rep === 'sessions' ? (job.src === 'cue' || job.src === 'toc') : (job.src === 'cue' && !job.fromCcd && !!job.descText)))) rep = '';
    return { id: r.id, act: act, warn: !!r.warn, repair: rep, text: typeof r.text === 'function' ? r.text(ctx) : r.text || '' };
  });
}
function quirkAct(job, act) { return quirks(job).some(function (q) { return q.act === act; }); }

/* ============================================================
   Milestone 7 reversible cue/disc layout repairs (Tier X) & DPRC0001 trailer
   Never active on Universal / Fast Universal unless explicitly clicked by the user.
   ============================================================ */
var REPAIR_INFO = {
  gaps:      { label: 'Fix PREGAP/POSTGAP layout',   short: 'Materialize virtual gaps', raOk: true,  rev: true },
  sessions:  { label: 'Add session tags (--sessions)', short: 'CHSE session metadata',   raOk: true,  rev: true },
  mode2:     { label: 'Remap MODE2/2048 \u2192 MODE1/2048', short: 'Flycast Mode 1 map', raOk: true,  rev: true },
  dcgaps:    { label: 'Absorb pregaps (Flycast \u2264 2.7)', short: 'Pregap absorption',  raOk: true,  rev: true },
  pcsession: { label: 'Insert 11,400-frame session gap', short: 'Session 2 LBA shift',   raOk: false, rev: true }
};
function repairEnabled(job, key) {
  if (!key) return false;
  if (job.repairs && key in job.repairs) return !!job.repairs[key];
  var tgt = typeof targetProfile === 'function' ? targetProfile() : null;
  return !!(tgt && tgt.repair);
}
function activeRepairs(job) {
  if (job.kind !== 'create') return [];
  var out = [];
  quirks(job).forEach(function (q) {
    if (q.repair && repairEnabled(job, q.repair) && out.indexOf(q.repair) < 0) out.push(q.repair);
  });
  return out;
}
function cueSectorSize(mode) {
  return /\/2048$|^MODE1$/.test(mode) ? 2048 : /\/2324$/.test(mode) ? 2324 : /\/2336$/.test(mode) ? 2336 : 2352;
}
function splitHeadSegs(segs, bytes) {
  var head = [], tail = [], rem = bytes;
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (rem <= 0) { tail.push(s); continue; }
    var slen = s.zero != null ? s.zero : s.len;
    if (slen <= rem) { head.push(s); rem -= slen; }
    else {
      if (s.zero != null) {
        head.push({ zero: rem });
        tail.push({ zero: slen - rem });
      } else {
        head.push({ ref: s.ref, start: s.start, len: rem });
        tail.push({ ref: s.ref, start: s.start + rem, len: slen - rem });
      }
      rem = 0;
    }
  }
  return { head: head, tail: tail };
}
function buildDpr1Trailer(ops, origCueText) {
  var cueBytes = new TextEncoder().encode(origCueText || '');
  var buf = new Uint8Array(10 + ops.length * 8 + cueBytes.length);
  var dv = new DataView(buf.buffer);
  buf[0] = 68; buf[1] = 80; buf[2] = 82; buf[3] = 49; // "DPR1"
  dv.setUint16(4, ops.length, true);
  dv.setUint32(6, cueBytes.length, true);
  for (var i = 0; i < ops.length; i++) {
    var o = 10 + i * 8;
    buf[o] = ops[i].kind & 255;
    buf[o + 1] = ops[i].trk1 & 255;
    dv.setUint32(o + 4, ops[i].frames >>> 0, true);
  }
  buf.set(cueBytes, 10 + ops.length * 8);
  return new Blob([buf], { type: 'application/octet-stream' });
}
// Builds repaired virtual cue, ConcatStore/ZeroStore inputs, extra args (--sessions, --trailer)
function buildRepairedCueJob(job) {
  var reps = activeRepairs(job);
  if (!reps.length) return null;
  var wantSessions = reps.indexOf('sessions') >= 0;
  var needCueRewrite = reps.some(function (k) { return k !== 'sessions'; });
  if (!needCueRewrite) return { extraArgs: wantSessions ? ['--sessions'] : [], extraDisp: wantSessions ? ['--sessions'] : [], inputs: null };
  if (job.src !== 'cue' || !job.descText) return null;

  var map = {};
  job.files.forEach(function (f) { if (f.ref) map[refKey(f.ref)] = f.name; });
  var normCue = rewriteRefs('cue', job.descText, map);
  var fileByName = Object.create(null);
  var rawInputs = [];
  job.files.forEach(function (f, idx) {
    var rname = '__raw_' + idx;
    var sz = f.ecm && f.imageSize ? f.imageSize : f.file.size;
    fileByName[f.name.toLowerCase()] = { ref: rname, size: sz, f: f };
    rawInputs.push({ name: rname, blob: f.file, ecm: f.ecm, hidden: true });
  });

  var catalog = '', curFile = null, session = 1, fileGroups = [], tracks = [], curTrack = null;
  var lines = normCue.split(/\r?\n/);
  for (var li = 0; li < lines.length; li++) {
    var ln = lines[li], m;
    if ((m = /^\s*CATALOG\s+(\S+)/i.exec(ln))) { catalog = m[1]; continue; }
    if ((m = /^\s*REM\s+SESSION\s+0*(\d+)/i.exec(ln))) { session = +m[1]; continue; }
    var fw = refWord('cue', ln);
    if (fw) {
      curFile = fileByName[fw.text.toLowerCase()] || null;
      fileGroups.push({ file: curFile, tracks: [] });
      continue;
    }
    if ((m = /^\s*TRACK\s+(\d+)\s+(\S+)/i.exec(ln))) {
      curTrack = { no: +m[1], mode: m[2].toUpperCase(), session: session, pregap: 0, postgap: 0, index: {}, flags: '', isrc: '', file: curFile };
      tracks.push(curTrack);
      if (fileGroups.length) fileGroups[fileGroups.length - 1].tracks.push(curTrack);
      continue;
    }
    if (!curTrack) continue;
    if ((m = /^\s*FLAGS\s+(.+)/i.exec(ln))) curTrack.flags = m[1].trim();
    else if ((m = /^\s*ISRC\s+(\S+)/i.exec(ln))) curTrack.isrc = m[1].trim();
    else if ((m = /^\s*PREGAP\s+(\d+:\d+:\d+)/i.exec(ln))) curTrack.pregap = msfFrames(m[1]);
    else if ((m = /^\s*POSTGAP\s+(\d+:\d+:\d+)/i.exec(ln))) curTrack.postgap = msfFrames(m[1]);
    else if ((m = /^\s*INDEX\s+(\d+)\s+(\d+:\d+:\d+)/i.exec(ln))) curTrack.index[+m[1]] = msfFrames(m[2]);
  }
  if (!tracks.length) return null;

  // Map every track to its exact byte slice inside its source file
  for (var gi = 0; gi < fileGroups.length; gi++) {
    var fg = fileGroups[gi];
    if (!fg.file || !fg.tracks.length) continue;
    if (fg.tracks.length === 1) {
      var t0 = fg.tracks[0];
      t0.baseFr = 0;
      t0.segs = [{ ref: fg.file.ref, start: 0, len: fg.file.size }];
    } else {
      var starts = fg.tracks.map(function (t, ti) {
        var fr = ti === 0 ? 0 : (0 in t.index ? t.index[0] : (t.index[1] || 0));
        return fr;
      });
      for (var ti = 0; ti < fg.tracks.length; ti++) {
        var tk = fg.tracks[ti], ss0 = cueSectorSize(tk.mode);
        var stB = starts[ti] * ss0;
        var enB = ti + 1 < starts.length ? starts[ti + 1] * ss0 : fg.file.size;
        tk.baseFr = starts[ti];
        tk.segs = enB > stB ? [{ ref: fg.file.ref, start: stB, len: enB - stB }] : [];
      }
    }
  }
  for (var i = 0; i < tracks.length; i++) {
    var tr = tracks[i];
    if (!tr.segs) return null;
    tr.relIdx = {};
    Object.keys(tr.index).forEach(function (k) { tr.relIdx[k] = Math.max(0, tr.index[k] - (tr.baseFr || 0)); });
  }

  var ops = [];
  var doGaps = reps.indexOf('gaps') >= 0;
  var doMode2 = reps.indexOf('mode2') >= 0;
  var doDcGaps = reps.indexOf('dcgaps') >= 0;
  var doPcSess = reps.indexOf('pcsession') >= 0;

  for (var i = 0; i < tracks.length; i++) {
    var tr = tracks[i], ss = cueSectorSize(tr.mode);
    if (doGaps && !doDcGaps) {
      if (tr.pregap > 0) {
        var pg = tr.pregap;
        tr.segs.unshift({ zero: pg * ss });
        var shifted = { 0: 0 };
        Object.keys(tr.relIdx).forEach(function (k) { if (+k > 0) shifted[k] = tr.relIdx[k] + pg; });
        if (!(1 in shifted)) shifted[1] = pg;
        tr.relIdx = shifted;
        tr.pregap = 0;
        ops.push({ kind: 1, trk1: tr.no, frames: pg });
      }
      if (tr.postgap > 0) {
        var post = tr.postgap;
        tr.segs.push({ zero: post * ss });
        tr.postgap = 0;
        ops.push({ kind: 2, trk1: tr.no, frames: post });
      }
    }
    if (doMode2 && tr.mode === 'MODE2/2048') {
      tr.mode = 'MODE1/2048';
      ops.push({ kind: 4, trk1: tr.no, frames: 0 });
    }
    if (doDcGaps && i > 0) {
      var prev = tracks[i - 1], prevSs = cueSectorSize(prev.mode);
      if (tr.pregap > 0) {
        var dpg = tr.pregap;
        prev.segs.push({ zero: dpg * prevSs });
        tr.pregap = 0;
        ops.push({ kind: 2, trk1: prev.no, frames: dpg });
      }
      if ((0 in tr.relIdx) && (1 in tr.relIdx) && tr.relIdx[1] > tr.relIdx[0]) {
        var moveFr = tr.relIdx[1] - tr.relIdx[0];
        var sp = splitHeadSegs(tr.segs, moveFr * ss);
        prev.segs = prev.segs.concat(sp.head);
        tr.segs = sp.tail;
        var sh2 = {};
        Object.keys(tr.relIdx).forEach(function (k) { if (+k > 0) sh2[k] = Math.max(0, tr.relIdx[k] - moveFr); });
        tr.relIdx = sh2;
        ops.push({ kind: 3, trk1: tr.no, frames: moveFr });
      }
    }
    if (doPcSess && i + 1 < tracks.length && tracks[i + 1].session > tr.session) {
      tr.segs.push({ zero: 11400 * ss });
      ops.push({ kind: 2, trk1: tr.no, frames: 11400 });
    }
  }
  if (!ops.length && !wantSessions) return null;

  var cueOut = [];
  if (catalog) cueOut.push('CATALOG ' + catalog);
  var outInputs = rawInputs.slice(), lastSess = 0;
  for (var i = 0; i < tracks.length; i++) {
    var tr = tracks[i];
    if (tr.session !== lastSess && tracks.some(function (x) { return x.session > 1; })) {
      cueOut.push('REM SESSION ' + (tr.session < 10 ? '0' : '') + tr.session);
      lastSess = tr.session;
    }
    var vname = '__trk' + (tr.no < 10 ? '0' : '') + tr.no + '.bin';
    outInputs.push({ name: vname, concat: tr.segs });
    cueOut.push('FILE "' + vname + '" BINARY');
    cueOut.push('  TRACK ' + (tr.no < 10 ? '0' : '') + tr.no + ' ' + tr.mode);
    if (tr.flags) cueOut.push('    FLAGS ' + tr.flags);
    if (tr.isrc) cueOut.push('    ISRC ' + tr.isrc);
    if (tr.pregap > 0) cueOut.push('    PREGAP ' + cueMsf(tr.pregap));
    Object.keys(tr.relIdx).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) {
      cueOut.push('    INDEX ' + (k < 10 ? '0' : '') + k + ' ' + cueMsf(tr.relIdx[k]));
    });
    if (tr.postgap > 0) cueOut.push('    POSTGAP ' + cueMsf(tr.postgap));
  }
  outInputs.unshift({ name: job.descName, blob: new Blob([cueOut.join('\n') + '\n'], { type: 'text/plain' }) });
  var extraArgs = [], extraDisp = [];
  if (wantSessions) { extraArgs.push('--sessions'); extraDisp.push('--sessions'); }
  if (ops.length) {
    outInputs.push({ name: '__dprc_trailer.bin', blob: buildDpr1Trailer(ops, job.descText) });
    extraArgs.push('--trailer', '/in/__dprc_trailer.bin');
    extraDisp.push('--trailer', '__dprc_trailer.bin');
  }
  return { inputs: outInputs, extraArgs: extraArgs, extraDisp: extraDisp, ops: ops };
}

/* ============================================================
   Existing CHD Library Health & Compatibility Auditor (12 checks)
   ============================================================ */
function auditChd(job) {
  if (job.kind !== 'chd' || !job.info) return [];
  var info = job.info, ins = job.chdInspect || null, tracks = job.chdTracks || [];
  var id = job.ident || {}, sys = id.sys || '', det = id.detected || {};
  var tags = (ins && ins.tags && ins.tags.length) ? ins.tags : (info.tags || []);
  var comps = (ins && ins.comps && ins.comps.length) ? ins.comps : (info.compression ? info.compression.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) : []);
  var ver = (ins && ins.version) || parseInt(info.version || '0', 10) || 0;
  var hb = (ins && ins.hunkbytes) || info.hunkBytes || 0;
  var compressed = ins ? !!ins.compressed : !!(info.compression && !/^none$/i.test(info.compression));
  var hasZstd = comps.some(function (c) { return c === 'cdzs' || c === 'zstd'; });
  var pf = typeof profile === 'function' ? profile(sys) : {};
  var tgt = typeof targetProfile === 'function' ? targetProfile() : { ps2cd: false };
  var findings = [];
  var CD_ONLY = /^(ps1|saturn|segacd|dc|pcecd|pcfx|ngcd|3do|cdi|cd32|cdtv|amigacd|jagcd)$/;

  // 1. Broken GD-ROM (MAME #15870: Track 3 logical offset != 45000)
  if (info.type === 'gdrom' && tracks.length >= 3 && tracks[2].logframeofs && tracks[2].logframeofs !== 45000) {
    findings.push({ id: 'chd-gdrom-broken', sev: 'err',
      text: 'Broken Dreamcast GD-ROM layout: Track 3 starts at LBA ' + tracks[2].logframeofs + ' instead of 45000 (caused by a buggy chdman build). Rebuilding restores the exact GD-ROM layout.',
      fix: { kind: 'rebuild', mode: 'gdi-to-cd', label: 'Rebuild GD-ROM CHD' } });
  }
  // 2. Flycast <= 2.7 unloadable GD-ROM (#15808: pregap or subcode on GD-ROM)
  if (info.type === 'gdrom' && tracks.some(function (t) { return t.pregap > 0 || t.subtype !== 0; })) {
    findings.push({ id: 'chd-gdrom-flycast', sev: 'warn',
      text: 'This GD-ROM CHD contains track pregaps or subcode metadata, which Flycast 2.7 and earlier refuse to load.',
      fix: { kind: 'rebuild', mode: 'gdi-to-cd', label: 'Rebuild clean GD-ROM' } });
  }
  // 3. Pre-0.227 Dreamcast GD-ROM packed as plain CD CHD
  if (sys === 'dc' && info.type === 'cd' && info.logical > 750 * 1048576) {
    findings.push({ id: 'chd-dc-legacy-cd', sev: 'warn',
      text: 'This Dreamcast GD-ROM (>750 MB) is stored as a plain CD CHD (pre-MAME 0.227 format). Modern Flycast and Redream expect a GD-ROM CHD (CHGD).' });
  }
  // 4. PSP wrong container (createcd) or wrong hunk size (!= 2048)
  if (sys === 'psp') {
    if (info.type === 'cd') {
      findings.push({ id: 'chd-psp-layout', sev: 'err',
        text: 'This PSP game was packed as a CD CHD instead of a DVD CHD with 2,048-byte hunks (PPSSPP requires DVD CHD with -hs 2048).',
        fix: { kind: 'rebuild', mode: 'cd-to-dvd-2048', label: 'Rebuild as PSP DVD CHD' } });
    } else if (info.type === 'dvd' && hb && hb !== 2048) {
      findings.push({ id: 'chd-psp-layout', sev: 'warn',
        text: 'This PSP DVD CHD uses ' + hb.toLocaleString('en-US') + '-byte hunks; PPSSPP recommends 2,048-byte hunks (-hs 2048) to avoid seek stutters.',
        fix: { kind: 'copy', extra: ['-hs', '2048'], label: 'Fix 2,048-byte hunks' } });
    }
  }
  // 5. CD-only console mistakenly packed as createdvd
  if (info.type === 'dvd' && CD_ONLY.test(sys)) {
    findings.push({ id: 'chd-cd-as-dvd', sev: 'err',
      text: sysName(sys) + ' games must be CD CHDs (createcd), not DVD CHDs: emulators cannot boot a DVD CHD for this system.',
      fix: { kind: 'rebuild', mode: 'dvd-to-cd', label: 'Rebuild as CD CHD' } });
  }
  // 6. PS2 DVD container mismatch for active Target
  if (sys === 'ps2') {
    if (info.type === 'dvd' && (settings.compat || tgt.ps2cd)) {
      findings.push({ id: 'chd-ps2-target', sev: 'warn',
        text: 'This PS2 game is a DVD CHD, which AetherSX2, NetherSX2 and older PCSX2 builds cannot open.',
        fix: { kind: 'rebuild', mode: 'dvd-to-cd', label: 'Convert to CD CHD' } });
    } else if (info.type === 'cd' && info.logical > 900 * 1048576 && !settings.compat && !tgt.ps2cd) {
      findings.push({ id: 'chd-ps2-target', sev: 'warn',
        text: 'This PS2 DVD game is stored as a legacy CD CHD (~7\u201310% larger than a DVD CHD on modern PCSX2).',
        fix: { kind: 'rebuild', mode: 'cd-to-dvd', label: 'Convert to DVD CHD' } });
    }
  }
  // 7. Incompatible Zstd compression for this console or Target
  if (hasZstd && (settings.compat || settings.target === 'legacy' || pf.noZstd)) {
    var zCodecs = (info.type === 'cd' || info.type === 'gdrom') ? 'cdlz,cdzl,cdfl' : 'lzma,zlib,huff,flac';
    var zWhy = pf.noZstd ? pf.noZstd + ' cannot read Zstd CHDs of ' + sysName(sys) + ' games.' : 'Older emulators cannot read Zstd CHDs.';
    findings.push({ id: 'chd-zstd-compat', sev: 'warn',
      text: zWhy + ' Re-encoding with standard codecs is lossless and keeps identical disc data.',
      fix: { kind: 'copy', extra: ['-c', zCodecs, '--codecplan', '--libdeflate'], label: 'Re-encode without Zstd' } });
  }
  // 8. Fatal non-track metadata (e.g., CUES/CHSE) on strict consoles (Saturn/Sega CD/PCE-CD)
  if (/^(saturn|segacd|pcecd)$/.test(sys)) {
    var badTags = tags.filter(function (t) { return !/^(CHT2|CHTR|CHGD|CHGT|CHCD)$/.test(t); });
    if (badTags.length) {
      findings.push({ id: 'chd-strict-meta', sev: 'err',
        text: (sys === 'saturn' ? 'Kronos and Yabause reject' : 'jgenesis rejects') + ' CHDs carrying extra metadata tags (' + badTags.join(', ') + '). Stripping them is lossless.',
        fix: { kind: 'copy', extra: ['--stripmeta'], label: 'Strip extra metadata' } });
    }
  }
  // 9. Subcode tracks on Beetle/Flycast systems or hunk size > 512 KiB (rchd cap)
  if (info.type === 'cd' && tracks.some(function (t) { return t.subtype !== 0; }) && /^(ps1|saturn|segacd|pcecd|dc)$/.test(sys)) {
    findings.push({ id: 'chd-subcode', sev: 'warn',
      text: 'This CHD stores raw subchannel data (RW/RW_RAW), which Beetle cores and Flycast can reject.' });
  }
  if (hb > 524288) {
    var stdHs = (info.type === 'cd' || info.type === 'gdrom') ? '19584' : '4096';
    findings.push({ id: 'chd-hunk-large', sev: 'warn',
      text: 'Hunk size (' + fmtBytes(hb) + ') exceeds 512 KB, which RetroAchievements (rchd) and many libretro cores reject.',
      fix: { kind: 'copy', extra: ['-hs', stdHs], label: 'Fix hunk size' } });
  }
  // 10. Legacy CHD v3 / v4 or old CHTR/CHGT metadata tags
  if ((ver > 0 && ver < 5) || tags.some(function (t) { return t === 'CHTR' || t === 'CHGT'; })) {
    findings.push({ id: 'chd-legacy-ver', sev: 'warn',
      text: 'This is a legacy CHD v' + (ver || 4) + ' file. Upgrading losslessly to CHD v5 shrinks it and improves emulator compatibility.',
      fix: { kind: 'copy', extra: ['--codecplan', '--libdeflate'], label: 'Upgrade to CHD v5' } });
  }
  // 11. Missing .sbi for PAL PS1 LibCrypt CHD
  if (sys === 'ps1' && !job.sbi) {
    var facts = quirkCtx(job).facts;
    if (facts.libcrypt) {
      findings.push({ id: 'chd-libcrypt-missing', sev: 'warn',
        text: 'This PAL PlayStation CHD is protected by LibCrypt and has no paired .sbi file. Drop its .sbi alongside this CHD so emulators can boot it.' });
    }
  }
  // 12. Compressed PC CHD on Legacy target (DOSBox Pure) or cooked 2048-byte PS1 CHD
  if (sys === 'pc' && compressed && settings.target === 'legacy') {
    findings.push({ id: 'chd-pc-compressed', sev: 'warn',
      text: 'DOSBox Pure requires uncompressed CD CHDs (-c none).',
      fix: { kind: 'copy', extra: ['-c', 'none'], label: 'Decompress for DOSBox Pure' } });
  }
  if (sys === 'ps1' && info.type === 'cd' && tracks.length && tracks.some(function (t) { return t.datasize === 2048; })) {
    findings.push({ id: 'chd-ps1-cooked', sev: 'warn',
      text: 'This PlayStation CHD has cooked 2,048-byte sectors instead of raw 2,352-byte Mode 2 sectors; Beetle PSX cannot load it.' });
  }
  return findings;
}
function auditState(job) {
  if (job.kind !== 'chd' || !job.info) return '';
  var f = auditChd(job);
  if (f.some(function (x) { return x.sev === 'err'; })) return 'err';
  if (f.some(function (x) { return x.sev === 'warn'; })) return 'warn';
  return 'ok';
}
// how long a CD job's disc is, in minutes (sector-size-aware for 2,048-byte vs raw tracks)
function discMinutes(job, disc) {
  if (disc && disc.tracks && disc.tracks.length) {
    if (job.files.length === disc.tracks.length && job.src !== 'nrg') {
      var frames = 0;
      for (var i = 0; i < disc.tracks.length; i++) {
        var f = job.files[i];
        var sz = f.ecm && f.imageSize ? f.imageSize : f.pbp ? f.pbp.sectors * 2352 : f.file.size;
        var mode = disc.tracks[i].mode;
        var ss = /\/2048$|^MODE1$/.test(mode) ? 2048 : /\/2324$/.test(mode) ? 2324 : /\/2336$/.test(mode) ? 2336 : 2352;
        frames += sz / ss;
      }
      return frames / 75 / 60;
    }
    if (disc.tracks.every(function (t) { return /\/2048$|^MODE1$/.test(t.mode); })) return jobImageBytes(job) / 2048 / 75 / 60;
  } else if (job.autoCue === 'MODE1/2048' || (job.src === 'iso' && !job.autoCue) || job.src === 'cso') {
    return jobImageBytes(job) / 2048 / 75 / 60;
  }
  return jobImageBytes(job) / 2352 / 75 / 60;
}
// the layout of the CD a cue sheet, TOC or Nero image describes; null for other jobs
function discModel(job) {
  if (job.kind !== 'create' || (job.disc !== 'cd' && job.disc !== 'gdrom')) return null;
  if (job.src === 'nrg' && job.nrgTracks) {
    if (job.discModelOf !== job.nrgTracks) { job.discModelOf = job.nrgTracks; job.discModelVal = nrgModel(job.nrgTracks); }
    return job.discModelVal;
  }
  if ((job.src !== 'cue' && job.src !== 'toc') || !job.descText) return null;
  if (job.discModelOf !== job.descText) { job.discModelOf = job.descText; job.discModelVal = job.src === 'cue' ? cueModel(job.descText) : tocModel(job.descText); }
  return job.discModelVal;
}
