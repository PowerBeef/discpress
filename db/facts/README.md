# Facts about particular games

Tab-separated files, one fact per line: `sys`, `serial`, `fact`, `value` and `source`. Lines starting with `#` are comments. `scripts/assemble.py` checks every line and embeds the facts in the page (`GAME_FACTS` in `app/ident.js`). It refuses:
- a system the database doesn't have;
- a serial the database doesn't list for that system (as `canonKey` makes it: Sega's `MK-` dropped, Redump's suffixes as base serials);
- an unknown fact;
- a value other than `1`;
- a line without a source.

So after `scripts/update-db.sh`, a release whose serial left the database stops the build until its line is fixed or removed.

| File | Fact | What the page does with it |
|---|---|---|
| `libcrypt.tsv` | `libcrypt`: a PAL PlayStation disc protected by LibCrypt | warns when no `.sbi`, `.lsd` or CloneCD `.sub` came with it (rule `libcrypt-missing` in `app/quirks.js`) |

## Sourcing and licensing

Facts are kept by hand, each with where it comes from: a primary source (the disc, its packaging or manual, Redump's disc page) or a list built from them. Never copy from DuckStation's game database (CC BY-NC-ND), and use GPL or CC BY-SA sources only as checklists to look things up elsewhere.

- `libcrypt.tsv` comes from psxdatacenter's SBI list (2026-10-02), 197 serials of which the database has 195 (the German and French Hogs of War, SLES-02766 and SLES-02767, are not in it).
- Saturn games that need a RAM cartridge are not listed yet: no primary source checked so far.
