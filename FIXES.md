# OnlyPorn V2 playback fixes

This fork contains targeted playback and compatibility fixes:

- Corrects xHamster HLS variant URL resolution so every quality no longer points to the same master playlist.
- Adds standard Stremio `behaviorHints.proxyHeaders.request` fields for xHamster, SpankBang, and Porntrex protected media.
- Preserves SpankBang custom stream arrays through a dedicated stream response without polluting metadata.
- Applies provider-specific request headers passed to the shared HTTP client.
- Resolves relative HLS variant URLs with the WHATWG `URL` resolver instead of fragile string concatenation.
- Bumps the addon version to `2.0.1`.

Deployment remains Node.js with `yarn install` and `npm start`.


## 2.0.2 — xHamster metadata and zero-stream regression

- Restored xHamster video-page fetching to the browser request profile used by the working upstream deployment.
- Added a balanced parser for multiline `window.initials` assignments and support for `JSON.parse(...)` assignments.
- Added Open Graph, JSON-LD and recursive media-URL fallbacks.
- Prevented invalid empty metadata objects from being returned to Stremio/AIOStreams.
- Avoided caching temporary fallback-only metadata responses.


## 2.0.3 — xHamster direct-MP4 playback compatibility

- Diagnoses the AIOStreams built-in proxy failure on nested xHamster HLS paths.
- xHamster media playlists referenced paths such as
  `480p.av1.mp4/init-v1-a1.mp4`; AIOStreams returned HTTP 404 before making an
  upstream request for those nested paths.
- Prefers and returns xHamster's direct MP4 sources when available.
- Keeps the required Referer, Origin, User-Agent and age-preference Cookie in
  standard Stremio `behaviorHints.proxyHeaders.request`.
- Keeps H.264 HLS ahead of AV1 HLS only as a fallback when no MP4 exists.


## 2.0.4

- Fixed the xHamster stream-handler ordering regression: the shared provider previously selected the first HLS URL before xHamster's direct-MP4 parser could run.
- xHamster now overrides `processStreams()` and returns direct MP4 sources first.
- Expanded direct-MP4 discovery across the full `window.initials` payload and escaped page source.
- Nested AV1 HLS is no longer returned as a broken fallback.

## 2.0.6
- Filters xHamster animated thumbnail/preview MP4 files (including `thumb-*` hosts and `.t.mp4` assets).
- Keeps only full direct MP4 files carrying a recognized resolution.
- Deduplicates xHamster streams to one entry per resolution and labels every entry explicitly (for example, `720p MP4`).

## 2.0.6 provider-wide preview filtering

- Audited every provider for thumbnail, preview, trailer, teaser, sample and sprite media contamination.
- Porntrex now bypasses the shared first-media fallback and returns only its provider-parsed streams.
- Porntrex broad MP4 fallback now rejects screenshot/preview assets and keeps at most one full stream per resolution.
- SpankBang `stream_data` now accepts only playable media URLs with a recognized resolution and rejects preview assets.
- Eporner MP4 API results are filtered and deduplicated by resolution.
- The shared provider fallback no longer returns the first arbitrary MP4 found in page HTML.
- XVideos and XNXX were audited and do not use broad page-wide MP4 scraping; no preview-filter change was required.

## 2.1.0 — Phase 1 reliability and security hardening

- Replaced substring-based content routing with provider-scoped opaque Stremio IDs while preserving strictly validated legacy URL IDs.
- Added exact provider-page hostname allowlists, HTTPS-only requests, private/reserved IP blocking, DNS validation, and validation of every redirect destination.
- Replaced scattered raw network calls with one shared HTTP path providing 15-second timeouts, HTTP status validation, bounded retries, Retry-After support, and redirect limits.
- Corrected shared page-number calculation so the first non-zero Stremio `skip` loads provider page 2 instead of repeating page 1.
- Corrected Porntrex pagination to use `this.limit` rather than the undefined `this.perPage` property.
- Implemented Porntrex keyword search through its `/search/<keyword>/` route.
- Corrected the XVideos JSON-LD fallback by promoting `contentUrl` during page parsing and removed the undefined Cheerio `$` reference from `processStreams()`.
- Added bounded TTL/LRU-style caches. Empty strings, null responses, failed requests, and empty provider pages are never inserted into shared caches.
- Routed Porntrex stream resolution, SpankBang page/HLS requests, SpankBang 4K probes, and xHamster API backfill through the validated shared HTTP client.
- Added offline Phase 1 regression tests for cache limits, cache expiry, scoped IDs, HTTPS/host validation, private-IP rejection, pagination source fixes, Porntrex fixes, and the XVideos fallback.
