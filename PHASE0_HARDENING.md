# OnlyPorn Hardening Phase 0 — v2.6.1

## Scope

Phase 0 repairs the first urgent relay defect identified in the full v2.6.0 fork audit: long VOD playback could outlive the relay's 45-minute token lifetime, and each HLS segment consumed a separate in-memory cache entry.

No provider parser, catalog route, media host allowlist, or public stream-selection policy was changed.

## Repair

- Increased the default playback-session lifetime from 45 minutes to 8 hours.
- Replaced one-cache-entry-per-HLS-child behavior with one cache entry per top-level playback stream.
- HLS master, variant, key, map, and segment URLs now use signed stateless child tokens tied to the original playback session.
- Child tokens retain the original provider, approved-host validation, Referer, Origin, cookies, and User-Agent context through the parent session.
- Nested playlists reuse the same playback session instead of generating a new cache tree.
- Tampered child URLs are rejected because the encoded target and media kind are authenticated with HMAC-SHA256.

## Capacity effect

A 2-hour video with 5.12-second MPEG-TS segments contains roughly 1,400 segment references for one selected quality. Before Phase 0, rewriting that variant consumed roughly 1,400 cache entries and all of them expired 45 minutes after playlist creation.

After Phase 0, the same playlist consumes one playback-session entry. The 1,400 segment relay URLs are signed but not stored individually, and they remain valid while the 8-hour parent session is alive and the upstream provider signature remains valid.

## Deliberate limitations

This phase does not yet persist sessions across a Render restart or deployment. A restart still invalidates in-flight playback sessions because the session cache and child-token signing key are process-local. That separate reliability repair belongs to a later hardening phase using Redis or an environment-backed stateless session secret.

This phase also does not change the existing fail-open playlist-child behavior or introduce request-wide deadlines. Those are separate audited items and are intentionally excluded from Phase 0.

## Validation

- Existing provider and relay regression tests retained.
- Added an 8-hour session-lifetime test.
- Added a 2,000-segment multi-hour VOD test proving the cache remains at one session entry.
- Added nested master → variant → segment session-reuse coverage.
- Added HMAC tamper-rejection coverage.
