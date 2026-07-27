# OnlyPorn 2.2.0 — Phase 2 provider reliability release

This package builds on the live-tested 2.1.0 Phase 1 release. It keeps the same addon ID, manifest URL, seven catalogs, Node.js 20 runtime, and Render start process.

## Included improvements

1. **Eporner routing and playback**
   - Genre and sort selections now map to actual Eporner routes.
   - Metadata extraction uses safer patterns and JSON-LD fallbacks.
   - Genuine direct MP4 files are preferred before HLS.

2. **SpankBang stability**
   - Catalog IDs are based on canonical video URLs instead of page position.
   - Existing legacy composite IDs remain accepted.
   - `stream_data` is parsed without `eval` and without unsafe global quote replacement.
   - Shared preview filtering rejects thumbnail, trailer, teaser, sample, and sprite media.

3. **xHamster catalog recovery**
   - Challenge or incomplete HTML is detected before caching.
   - Failed catalog pages are retried and are not cached as valid pages.
   - The catalog aggregation/backfill path is now connected to the live handler.
   - Global skip slicing reduces duplicate windows across Load More requests.
   - Direct MP4 remains preferred; known-broken nested HLS is not exposed.

4. **XVideos and XNXX playback**
   - Direct MP4 candidates are preferred before HLS.
   - JSON-LD `contentUrl`, arrays, and `@graph` entries are usable fallbacks.
   - Relative media URLs are resolved against the video page correctly.
   - Shared preview filtering applies to direct media candidates.

5. **XNXX poster consistency**
   - Poster-frame selection is deterministic rather than random, so the same item keeps the same poster across refreshes.

6. **Shared parsing utilities**
   - Centralized media URL normalization, resolution extraction, MP4 selection, preview rejection, JSON-LD extraction, deterministic poster frames, and JavaScript-literal parsing.

## Offline validation completed

- Every JavaScript file passes `node --check`.
- Phase 1 and Phase 2 test suites pass together: 15 tests, 0 failures.
- `package.json` parses and reports version `2.2.0`.
- No trailing whitespace is present.
- No `.git`, `.env`, private key, password, API token, or deployment credential is included.
- No dependency was added, so the existing Render installation command remains unchanged.

## Required live validation

Third-party provider HTML, redirects, media URLs, regional behavior, and anti-bot systems cannot be fully verified offline. After Render reports **Live**, verify the manifest version and test all seven catalogs through AIOStreams/Stremio. Keep the GitHub backup branch `backup-v2.1.0-before-phase2` until live testing is complete.
