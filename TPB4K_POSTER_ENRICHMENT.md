# TPB4K poster enrichment — alpha.11

Version: `2.7.0-alpha.11`

## Defect repaired

The 19 `tpb4k.studio.*.top` catalogs were populated from TPB-compatible search pages, but their catalog records contained no `poster` or `background`. The Stremio provider passed that empty field through unchanged, and the live smoke gate did not require poster coverage. Stremio therefore displayed a generic video placeholder for nearly every studio item.

Alpha.11 completes the missing Phase 2 presentation layer without changing torrent identity or playback behavior.

## Enrichment flow

For each studio torrent result:

1. Preserve the original opaque `sourceId`, title, studio binding, TPB detail URL, seeders, and private torrent record.
2. Remove studio/date/release tags from the torrent title and derive a strict metadata search query.
3. Search configured StashDB and TPDB metadata clients with bounded concurrency and per-lookup deadlines.
4. Accept artwork only when the candidate has a safe HTTPS poster, the studio does not conflict, and title overlap exceeds the configured threshold.
5. Merge presentation metadata while preserving the original scene identity.
6. Cache successful matches and briefly negative-cache misses.
7. Use a local branded portrait poster when no reliable metadata match exists.

A metadata mismatch can never redirect playback to another scene. TPDB and StashDB remain metadata providers only.

## Complete poster guarantee

All returned TPB4K cards now receive a safe HTTPS poster:

- Studio torrent catalogs use a verified metadata poster or a studio-specific fallback asset.
- TPDB Recent, PornRips, YesPorn, Hentai, Sukebei, and future source cards receive a source-specific fallback if their upstream record omits artwork.
- The fallback assets are committed under `assets/tpb4k/studios/` as 600×900 PNG files.
- Catalog and meta responses consistently use `posterShape: "poster"`.

## Configuration

Optional Render environment variables:

- `TPB4K_METADATA_ENRICHMENT_CONCURRENCY` — default `4`, range `1–8`.
- `TPB4K_METADATA_ENRICHMENT_LIMIT` — default `8`, range `1–24`; only the first visible records wait for live matching and all remaining records receive fallback posters immediately.
- `TPB4K_METADATA_LOOKUP_TIMEOUT_MS` — default `2000`, range `1000–10000`.
- `TPB4K_METADATA_MATCH_THRESHOLD` — default `72`, range `50–98`.
- `TPB4K_POSTER_ASSET_BASE_URL` — credential-free HTTPS base for the committed fallback PNG files.

Existing variables remain unchanged:

- `TPDB_API_KEY`
- `STASHDB_API_KEY`
- optional API endpoint overrides

Keys must remain in Render environment variables and must never appear in GitHub, ZIP contents, logs, manifests, or Stremio IDs.

## Acceptance gates

Alpha.11 adds or strengthens tests for:

- title/date cleanup;
- TPDB `q`/`site`/`year` search parameters and Bearer authentication;
- StashDB title plus parent-studio search input;
- conflicting-studio rejection;
- metadata identity preservation;
- positive and negative poster caching;
- all 26 fallback PNG files and dimensions;
- provider-level fallback for posterless records;
- 100% poster coverage for every non-empty studio catalog and TPDB Recent;
- portrait poster shape;
- fallback/metadata provenance diagnostics;
- Render poster URL reachability;
- the existing 37-catalog manifest remaining below the SDK 8 KiB limit.

TPB4K streams remain intentionally empty at this Phase 2 repair checkpoint.
