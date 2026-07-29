# TPB4K studio catalogs — alpha.10

Version: 2.7.0-alpha.10

The 19 selected `tpb4k.studio.*.top` catalogs are torrent-result catalogs. They are not StashDB studio-scene queries.

The implementation follows the original TPB4K backend contract:

- Search query: exact selected studio label.
- Adult quality category: `507` (UHD/4K movies).
- Sort code: `7` (seeders descending).
- Page mapping: Stremio `skip` values map to TPB pages of 30 rows.
- Mirror order: TheHiddenBay, ThePirateBay0, PirateBay Live.
- Failover: transport errors, non-2xx responses, challenge/interstitial HTML, or pages without `#searchResult` fall through to the next mirror.
- A real empty `#searchResult` table is accepted as a genuine empty search rather than hidden by failover.
- Catalog output includes title, studio, resolution scope, seeders, size, upload text, and a fixed-mirror detail URL.
- Magnet links and raw info hashes are retained only in the adapter's private in-memory index. Stremio IDs contain an irreversible SHA-256-derived opaque token.
- Stream resolution remains intentionally empty at this checkpoint.

TPDB Recent remains a separate catalog using ThePornDB REST with `Authorization: Bearer`.
StashDB remains available for later metadata enrichment and is not the source of the 19 TPB studio listings.
