# TPB4K studio catalogs — alpha.12

Version: 2.7.0-alpha.12

The 19 selected `tpb4k.studio.*.top` catalogs are torrent-result catalogs. They are not StashDB studio-scene queries.

The implementation follows the original TPB4K backend contract:

- Search query: exact selected studio label.
- Adult quality category: `507` (UHD/4K movies).
- Sort code: `7` (seeders descending).
- Page mapping: Stremio `skip` values map to TPB pages of 30 rows.
- Mirror order: TheHiddenBay, ThePirateBay0, PirateBay Live.
- Failover: transport errors, non-2xx responses, challenge/interstitial HTML, or pages without `#searchResult` fall through to the next mirror.
- A real empty `#searchResult` table is accepted as a genuine empty search rather than hidden by failover.
- Catalog output includes title, studio, resolution scope, seeders, size, upload text, a fixed-mirror detail URL, and a safe HTTPS poster.
- Configured StashDB and TPDB clients enrich presentation metadata only after strict same-studio/title matching.
- Unmatched results receive a committed 600×900 studio fallback poster, so non-empty catalogs have 100% poster coverage.
- Magnet links and raw info hashes are retained only in the adapter's private in-memory index. Stremio IDs contain an irreversible SHA-256-derived opaque token.
- Stream resolution remains intentionally empty at this checkpoint.

TPDB Recent remains a separate catalog using ThePornDB REST with `Authorization: Bearer`.
StashDB and TPDB are now optional enrichment sources only; neither replaces the 19 TPB studio listing transport or the original torrent identity.
