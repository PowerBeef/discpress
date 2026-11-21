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
    id: 'naomi-name', sys: ['naomi', 'naomi2'], act: 'norename', chd: true,
    when: function () { return settings.rename; },
    text: 'MAME and Flycast find a NAOMI GD-ROM by its file name in the game\u2019s romset (such as gds-0014.chd), so this CHD keeps its file\u2019s name.',
    src: 'docs/chd/ecosystem-sony-dreamcast.md §5.1 (Flycast gdcartridge.cpp: <romset>/<gdrom>.chd), §5.4'
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
    id: 'dc-cd-gaps', sys: ['dc'],
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
    // a UMD Video (UMD_DATA.BIN and a UMD_VIDEO folder, no PSP_GAME): a film, which PPSSPP doesn't play
    id: 'umd-video', sys: ['psp'], warn: true,
    when: function (c) { return !!c.det.video; },
    text: 'This is a UMD Video (a film), not a game: PPSSPP doesn\u2019t play UMD Video discs.',
    src: 'PPSSPP plays PSP games only (UMD_DATA.BIN with PSP_GAME)'
  },
  {
    // every Jaguar CD is multi-session (Redump: 38 of 38); 0.289 writes no session data
    id: 'jagcd-sessions', sys: ['jagcd'], warn: true,
    when: function () { return true; },
    text: 'Jaguar CD emulators may not load this CHD: BigPEmu doesn\u2019t take CHDs, and Virtual Jaguar (RetroArch) needs session data that chdman 0.289 doesn\u2019t write. Keep the original files too.',
    src: 'docs/chd/optical-media.md §3.5; docs/chd/ecosystem-other.md §0 findings 4 and 12'
  },
  {
    // a CHD keeps no session gap (about 11,400 sectors), so session 2 is read that much too early
    id: 'multisession', warn: true,
    when: function (c) { return c.sys !== 'jagcd' && c.disc && c.disc.sessions > 1; },
    text: function (c) {
      return 'This disc has ' + c.disc.sessions + ' sessions. Its CHD doesn\u2019t keep where each starts, so emulators read the data after the first session from the wrong place' +
        (/^(dc|naomi2?)$/.test(c.sys) ? ', except Flycast builds from September 2026 on, which guess it for MIL-CDs.' : '.') + ' Keep the original files too.';
    },
    src: 'docs/chd/optical-media.md §3.2, §3.5; docs/chd/ecosystem-sony-dreamcast.md §5.1 (Flycast 0abac34)'
  },
  {
    // chdman stores MODE2/2048, MODE2/2324 and MODE2_FORM_MIX tracks as Mode 2 Form 1/2/Mix, which Flycast refuses
    id: 'dc-mode2-form', sys: ['dc', 'naomi', 'naomi2'], warn: true,
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
    // Beetle Saturn, Kronos and Yabause take every pregap as stored and leave postgaps out of the image
    id: 'saturn-gapcmd', sys: ['saturn'], warn: true,
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return (t.pregapCmd && t.pregap > 0) || t.postgap > 0; }); },
    text: 'Beetle Saturn, Kronos and Yabause read the tracks after a PREGAP or POSTGAP line from the wrong place, and this cue sheet has one. A Redump dump (with INDEX 00 lines instead) doesn\u2019t have this problem.',
    src: 'docs/chd/ecosystem-other.md §3.1 to §3.3 (PGTYPE ignored, postgap ignored)'
  },
  {
    // the Beetle PCE family, Beetle PC-FX, Geargrafx and Beetle PSX count a postgap into the file offset;
    // jgenesis (Sega CD, PCE CD) ignores postgaps
    id: 'postgap', sys: ['pcecd', 'pcfx', 'ps1', 'segacd'], warn: true,
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return t.postgap > 0; }); },
    text: function (c) {
      return (c.sys === 'segacd' ? 'jgenesis reads' : { pcecd: 'Beetle PCE, Geargrafx and jgenesis', pcfx: 'Beetle PC-FX', ps1: 'Beetle PSX' }[c.sys] + ' read') + ' the tracks after a POSTGAP line from the wrong place, and this cue sheet has one (chdman keeps no postgap data).';
    },
    src: 'docs/chd/ecosystem-other.md §2.5, §4.1 to §4.3; docs/chd/ecosystem-sony-dreamcast.md §2.3'
  },
  {
    // ares drops a virtual pregap of track 2 or later from its TOC; jgenesis (Sega CD, PCE CD) and
    // PCSX ReARMed (PS1) ignore PGTYPE and assume every pregap is stored
    id: 'ares-pregap', sys: ['pcecd', 'segacd', 'ps1'],
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
    when: function (c) { return c.disc && c.disc.tracks.some(function (t) { return /^MODE2/.test(t.mode) || (t.no > 2 && t.pregapCmd && t.pregap > 0); }); },
    text: function (c) {
      return c.disc.tracks.some(function (t) { return /^MODE2/.test(t.mode); })
        ? 'NeoCD can\u2019t load this CHD: it takes only Mode 1 data tracks, and this disc has a Mode 2 one.'
        : 'NeoCD reads the tracks after a PREGAP line from track 3 on from the wrong place, and this cue sheet has one.';
    },
    src: 'docs/chd/ecosystem-other.md §5.1 (cdromtoc.cpp: track types, pregap heuristic)'
  }
];
// what the rules look at: the job's system and identification, its cue sheet or TOC, the settings
function quirkCtx(job) {
  var id = job.ident || {};
  var det = id.detected || {};
  return { job: job, id: id, sys: id.sys || '', det: det, disc: discModel(job), keepCue: keepCueWanted(job),
    facts: id.sys ? GameFacts.of(id.sys, [det.serial, id.serial].concat(id.entry && id.entry.serials || [])) : {} };
}
// the rules that apply to a job: [{id, act, warn, text}]
function quirks(job) {
  var ctx = quirkCtx(job);
  return QUIRKS.filter(function (r) {
    if (job.kind !== 'create' && !r.chd) return false;
    return (!r.sys || r.sys.indexOf(ctx.sys) >= 0) && r.when(ctx);
  }).map(function (r) {
    return { id: r.id, act: r.act || '', warn: !!r.warn, text: typeof r.text === 'function' ? r.text(ctx) : r.text || '' };
  });
}
function quirkAct(job, act) { return quirks(job).some(function (q) { return q.act === act; }); }
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
