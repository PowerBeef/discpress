// Dreamcast GD-ROM layout. Emulators rebuild the disc from the CHGD metadata, so the layout must be
// the one every reader accepts (chdman 0.264-0.289; see docs/chd/fork-plan.md §3):
// - no pregap, postgap or subcode on any track: every Flycast release up to 2.7 refuses the image otherwise;
// - the high-density area (track 3) at LBA 45000 when its start is computed the way MAME and Flycast do.
// Post-0.289 MAME master broke both (virtual pregaps for .gdi input, kept pregaps for Redump cues).
import { test, expect, fixture } from '../support/app.js';
import { chdman, nativeChdman } from '../support/native.js';

const CHGD = /TRACK:(\d+) TYPE:(\S+) SUBTYPE:(\S+) FRAMES:(\d+) PAD:(\d+) PREGAP:(\d+) PGTYPE:(\S+) PGSUB:(\S+) POSTGAP:(\d+)/g;

function gdTracks(chd) {
  return [...chdman(['info', '-v', '-i', chd]).matchAll(CHGD)].map(m =>
    ({ track: +m[1], subtype: m[3], frames: +m[4], pregap: +m[6], postgap: +m[9] }));
}

for (const key of ['dreamcast-gdi', 'dreamcast-cue']) {
  test(`GD-ROM from ${key}: no gaps, high-density area at LBA 45000`, async ({ app }) => {
    test.skip(!nativeChdman(), 'needs native chdman to read the metadata');
    await app.open();
    await app.add(fixture(key).add);
    const card = app.job('aerowings');
    await app.settled(card);
    await app.run(card);
    const [out] = await app.downloads(card);

    const tracks = gdTracks(out.path);
    expect(tracks.map(t => t.track)).toEqual([1, 2, 3]);
    for (const t of tracks) expect({ track: t.track, subtype: t.subtype, pregap: t.pregap, postgap: t.postgap })
      .toEqual({ track: t.track, subtype: 'NONE', pregap: 0, postgap: 0 });
    // without gaps a track starts where the frames of the tracks before it end
    expect(tracks[0].frames + tracks[1].frames).toBe(45000);
  });
}
