# OnlyPorn TPB4K Phase 1 — Foundation

Version: `2.7.0-alpha.2`

This phase creates the TPB4K integration boundary without changing the production behavior of OnlyPorn 2.6.4.

## Safety boundary

`TPB4K_ENABLED` defaults to `false`. With the default environment, OnlyPorn still exposes the existing 8 providers and 9 catalogs. The 28 TPB4K catalogs are added to the manifest only when the feature flag is explicitly enabled.

No live source scraper is installed in Phase 1. Catalog requests therefore return no entries until a source adapter is registered and validated. This prevents incomplete HTML/detail-page records from appearing as playable streams.

## Implemented

- Exact registry for the 28 TPB4K catalogs selected on the Stremio board.
- Source-adapter contract separating catalog discovery, metadata, and stream resolution.
- Opaque, versioned Stremio resource IDs containing no credentials or playable URLs.
- Torrent and magnet normalization, including hex and base32 BitTorrent hashes.
- Strict candidate classes: validated direct HLS/file, cached debrid URL, cached torrent, uncached torrent, P2P, invalid.
- HTML/detail-page rejection before a Stremio stream can be produced.
- Candidate deduplication and ranking: validated direct, cached, resolution, seeders, then size.
- Standard Stremio `infoHash`, `fileIdx`, and tracker source output.
- Stable scene-identity generation from studio, title, performers, release date, and scene code.
- Environment-only TPDB and StashDB configuration with public status redaction.
- Regression coverage preserving the v2.6.2 JAVHDPorn repair, Phase 0 sessions, and Phase 1 fail-closed HLS handling.


## Unified resolution policy

- Each source or studio has one catalog. There are no separate 4K, 1080p, or lower-resolution catalog variants.
- A single stream response may contain every valid resolution found for the scene.
- Results are never discarded merely because 2160p is unavailable.
- Ranking is tiered: ready streams first, then seeded P2P, then uncached torrents. Within each tier, resolution descends from 2160p through lower resolutions.
- For equal resolution, cached debrid is preferred, followed by validated HLS, validated direct files, and cached torrent objects.
- Low-resolution HTTP/HLS remains available only as fallback; unresolved HTML pages remain prohibited.

## Not implemented in Phase 1

- Live TPB/HiddenBay/1337x scraping.
- PornRips and YesPorn live adapters.
- Hentai/Sukebei live adapter.
- Stripchat HLS/MOUFLON handling.
- Real-Debrid API calls or server-side storage of debrid credentials.
- TPDB/StashDB network clients.

Those components must be introduced individually with fixtures and live validation. The feature flag remains off until the selected source adapters produce valid catalog, metadata, and playable stream results.
