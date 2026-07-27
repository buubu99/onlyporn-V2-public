# OnlyPorn 2.1.0 — Phase 1 Render deployment candidate

This package is built from the working 2.0.6 project and contains Phase 1 only. It intentionally does not include the larger Phase 2 provider-parser redesign.

## Included

1. Strict provider page URL validation, redirect validation, private/reserved-address blocking, and opaque provider-scoped Stremio IDs.
2. Porntrex pagination correction and real keyword-search routing.
3. XVideos JSON-LD stream fallback correction, removing the undefined-Cheerio crash path.
4. Shared pagination correction so the first full skip requests page 2 rather than repeating page 1.
5. One central HTTP request path with a 15-second timeout, status validation, controlled retries, Retry-After handling, redirect limits, and in-flight request deduplication.
6. Bounded TTL caches that reject empty/error responses and evict old entries.

## Compatibility

- The manifest URL and addon ID are unchanged.
- Existing raw provider URL IDs remain accepted only after exact provider-host validation.
- New catalog items use opaque IDs such as `onlyporn:xvideos:<encoded-value>`.
- No package dependency was added.
- The package remains configured for Node.js 20 and the existing Render start command.

## Validation completed before packaging

- Every JavaScript file passed `node --check`.
- All seven Phase 1 offline tests passed.
- Package metadata parses and reports version `2.1.0`.
- No raw `fetch()` calls remain in provider JavaScript; provider requests use the central request path.
- The package contains no `.env`, Git metadata, private keys, or deployment credentials.

Live provider pages cannot be fully validated offline. After Render reports **Live**, test every catalog and at least one stream from each provider because external websites can change their HTML, hostnames, redirects, and anti-bot behavior independently of this code.

## Deployment and rollback

Phase 1 was deployed from a verified local ZIP through the GitHub `main` branch. The historical backup branch is `backup-v2.0.6-before-phase1`.
