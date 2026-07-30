# TPB4K studio catalogs — alpha.13

Version: `2.7.0-alpha.14`

The 19 selected `tpb4k.studio.*.top` rows are metadata-first catalogs. TPDB and
StashDB provide the visible scene identity, title, date, performers, tags and
real HTTPS artwork. Unmatched torrent filenames and generic fallback cards are
not displayed in these rows.

Each returned scene keeps:

- a provider-scoped metadata ID;
- normalized studio, title, code and release date;
- provider tags for the global explicit-label filter;
- `lookupSource: torrent-index` and a bounded query for Phase 3;
- no magnet, info hash, secret or assumed playable URL.

StashDB studio aliases are resolved to exact studio IDs before scenes are
queried. TPDB uses the selected site/studio alias. Cross-provider duplicates are
merged before filtering and pagination, allowing StashDB tags to classify a
TPDB scene without changing its visible identity.

A row may legitimately contain fewer than 40 entries when metadata coverage is
smaller, the provider has no real poster, or the explicit-label filter removes
records. It must never be padded with another scene's artwork or a purple
placeholder.

The original TPB category `507`, top-by-seeders sort `7` and mirror chain remain
available for later torrent resolution. They no longer act as the catalog
listing transport.
