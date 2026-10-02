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
    id: 'keepcue-strict', sys: ['saturn', 'segacd'], act: 'nokeepcue',
    when: function (c) { return c.keepCue; },
    text: function (c) {
      return (c.sys === 'saturn' ? 'Kronos and Yabause reject' : 'jgenesis rejects') + ' CHDs that keep their cue sheet, so this one leaves it out (the setting \u201cKeep the cue sheet in CD CHDs\u201d is on).';
    },
    src: 'docs/chd/ecosystem-other.md §0 finding 4, §2.5, §3.2, §3.3: readers that fail on any metadata tag but a track\u2019s'
  },
  {
    id: 'naomi-name', sys: ['naomi', 'naomi2'], act: 'norename',
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
  }
];
// what the rules look at: the job's system and identification, its cue sheet or TOC, the settings
function quirkCtx(job) {
  var id = job.ident || {};
  return { job: job, id: id, sys: id.sys || '', det: id.detected || {}, disc: discModel(job), keepCue: keepCueWanted(job) };
}
// the rules that apply to a job: [{id, act, warn, text}]
function quirks(job) {
  if (job.kind !== 'create') return [];
  var ctx = quirkCtx(job);
  return QUIRKS.filter(function (r) { return (!r.sys || r.sys.indexOf(ctx.sys) >= 0) && r.when(ctx); }).map(function (r) {
    return { id: r.id, act: r.act || '', warn: !!r.warn, text: typeof r.text === 'function' ? r.text(ctx) : r.text || '' };
  });
}
function quirkAct(job, act) { return quirks(job).some(function (q) { return q.act === act; }); }
// the layout of the CD a cue sheet or TOC describes (cueModel), kept with the job; null for other jobs
function discModel(job) {
  if (job.kind !== 'create' || (job.disc !== 'cd' && job.disc !== 'gdrom') || (job.src !== 'cue' && job.src !== 'toc') || !job.descText) return null;
  if (job.discModelOf !== job.descText) { job.discModelOf = job.descText; job.discModelVal = job.src === 'cue' ? cueModel(job.descText) : tocModel(job.descText); }
  return job.discModelVal;
}
