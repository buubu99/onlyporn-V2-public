# Historical checkpoint: alpha.11/alpha.12 torrent-poster enrichment

> Superseded for the 19 studio catalogs by `TPB4K_METADATA_FIRST_FILTERS.md` in alpha.13. This document remains for regression history and non-studio fallback behavior.

# TPB4K complete studio poster enrichment — alpha.12

Version: `2.7.0-alpha.12`

## Purpose

Alpha.12 fixes the partial poster behavior introduced by alpha.11. Alpha.11
only attempted live metadata matching for the first eight cards and assigned a
text-heavy fallback poster to every remaining card. Alpha.12 removes that
fixed item cap. Every returned studio card is eligible for strict metadata
matching while preserving the original torrent identity.

## Matching pipeline

For each studio catalog request:

1. Read positive and confirmed-not-found item cache entries.
2. Fetch a bounded, cached studio scene pool from each configured metadata
   provider.
3. Match every unresolved torrent title against those pools locally.
4. Run bounded targeted lookups for every still-unmatched card.
5. Stop metadata work at the request-wide enrichment deadline.
6. Use the clean studio fallback only when no verified metadata match is
   available.

No poster match can replace `sourceId`, title, detail URL, torrent identity, or
future playback identity.

## Title and studio normalization

Alpha.12 adds provider-facing aliases for all 19 studio catalogs, including:

- `XVideosRED` → `XVideos RED`, `XVideosRed`, `XVideos Red`
- `DigitalPlayground` → `Digital Playground`
- `BrazzersExxtra` → `Brazzers Exxtra`
- `NewSensations` → `New Sensations`
- `TheLifeErotic` → `The Life Erotic`

The title parser now understands:

- `26 07 16`
- `2026 07 16`
- `2026-07-16`
- `20260716`
- year-only prefixes such as `2025` and `2024`

Release/encode noise is removed before matching. Studio conflicts and
low-confidence title overlap remain rejected.

## Caching and failure behavior

- Successful metadata is cached.
- Confirmed not-found responses are negative-cached briefly.
- Timeouts, provider errors, and request-deadline exhaustion are **not**
  negative-cached.
- Studio pools use a separate bounded cache.
- Metadata work uses bounded concurrency and a request-wide deadline below the
  AIOStreams 30-second custom-addon timeout.

## Safe Render diagnostics

Studio catalog logs now include safe enrichment statistics such as:

```text
records=40
eligible=40
attempted=40
matched=31
poolMatches=19
targetedMatches=12
fallback=9
skipped=0
timeouts=0
deadlineFallbacks=0
providerMatches={stashdb:18,tpdb:13}
```

No API keys, authorization headers, query URLs, or credentials are logged.

## Configuration

- `TPB4K_METADATA_ENRICHMENT_CONCURRENCY` — default `10`, range `1–16`.
- `TPB4K_METADATA_LOOKUP_TIMEOUT_MS` — default `2500`, range `750–8000`.
- `TPB4K_METADATA_ENRICHMENT_DEADLINE_MS` — default `16000`, range `4000–25000`.
- `TPB4K_METADATA_POOL_SIZE` — default `100`, range `20–100`.
- `TPB4K_METADATA_POOL_ALIAS_LIMIT` — default `2`, range `1–3`.
- `TPB4K_METADATA_TARGETED_ALIAS_LIMIT` — default `2`, range `1–3`.
- `TPB4K_METADATA_POOL_CACHE_MAX_ENTRIES` — default `100`, range `10–500`.
- `TPB4K_METADATA_MATCH_THRESHOLD` — default `72`.
- `TPB4K_POSTER_ASSET_BASE_URL` — credential-free HTTPS base for committed
  fallback assets.

`TPB4K_METADATA_ENRICHMENT_LIMIT` is removed and ignored.

## Fallback posters

The 26 committed 600×900 fallback PNGs were redesigned without the alpha.11
“POSTER PENDING METADATA MATCH” message. They are clean studio/source branded
cards and remain an honest fallback, not a false scene match.

## Validation requirements

- Every returned studio card reports `eligible` coverage.
- `skipped` must remain zero.
- All cards retain safe HTTPS poster coverage.
- Every real metadata match preserves source identity.
- Timeout/error results remain retryable.
- The 37-total / 28-TPB4K manifest remains below 8 KiB.
- All retained OnlyPorn, JAVHDPorn, HLS hardening, and TPB4K tests remain green.
