# TPB4K Phase 2A — Metadata Core

Version: `2.7.0-alpha.4`

Phase 2A is an isolated metadata release on `feature/tpb4k-v2.7.0`. It must not be merged into production `main`.

## Implemented

- Environment-only ThePornDB and StashDB GraphQL clients.
- `ApiKey` authentication kept in request headers only.
- HTTPS-only metadata endpoints with redirects disabled.
- Bounded positive cache and short negative cache.
- Response content-type and size validation.
- ThePornDB recent metadata catalog.
- All 19 studio metadata catalog definitions queried without resolution filters.
- Deterministic skip/page windows.
- Poster/background selection by image dimensions.
- Studio and performer normalization.
- Cross-provider metadata deduplication by scene identity.
- Source IDs and playback identity remain stable when artwork is enriched.
- Metadata adapter failures degrade to empty results.
- Phase 2A adapters intentionally return no streams.

## Intentionally not implemented

Phase 2A does not claim completion of the full Phase 2 catalog-ingestion scope. PornRips, Hentai, Stripchat, YesPorn, and Sukebei discovery adapters remain isolated follow-up work. Their catalogs continue to return empty results rather than invented metadata or unresolved pages.

Torrent resolution, Real-Debrid, direct VOD playback, and live HLS remain later phases.

## Environment variables

- `TPDB_API_KEY`
- `TPDB_API_URL` (default `https://theporndb.net/graphql`)
- `STASHDB_API_KEY`
- `STASHDB_API_URL` (default `https://stashdb.org/graphql`)
- `TPB4K_METADATA_CACHE_TTL_MS`
- `TPB4K_METADATA_NEGATIVE_TTL_MS`
- `TPB4K_METADATA_CACHE_MAX_ENTRIES`

Keys are optional. Missing keys produce empty metadata catalogs without errors or secret exposure.
