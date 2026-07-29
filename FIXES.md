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

## 2.2.0 — Phase 2 provider reliability improvements

- Implemented functional Eporner genre/sort routing and safer metadata/source extraction.
- Added direct-MP4 preference for Eporner, XVideos, and XNXX, with HLS retained as fallback.
- Added JSON-LD media extraction supporting arrays and `@graph` structures.
- Replaced SpankBang catalog-position IDs with stable canonical video IDs while preserving legacy-ID compatibility.
- Replaced SpankBang's fragile `stream_data` quote conversion with a constrained JavaScript-literal parser that does not use `eval`.
- Connected xHamster's catalog aggregation/backfill code to the live catalog handler, added challenge-page detection before caching, and sliced results by global Stremio skip.
- Centralized provider-wide direct-MP4 selection and preview/thumbnail/trailer/sample rejection.
- Corrected root-relative and protocol-relative media URL handling.
- Made XNXX poster-frame selection deterministic.
- Added eight Phase 2 regression tests; the combined Phase 1 and Phase 2 suite contains 15 passing tests.

## 2.2.1 — Catalog visibility hotfix

- Restored xHamster to the proven single-page catalog path after Phase 2 aggregation caused rows to disappear during upstream challenge or latency events.
- Narrowed challenge detection so ordinary pages are not rejected merely for containing generic words such as `captcha` or `access denied` in scripts.
- Retained strict detection of verified Cloudflare challenge documents.

## 2.3.0 — Phase 3 verification and operations

- Added provider fixtures and complete parser/metadata/stream regression tests.
- Added deterministic route and pagination tests for all providers.
- Added HLS variant ordering and relative-URL resolution tests.
- Added retry recovery and concurrent-request deduplication tests.
- Added a release validator and live deployment smoke-test command.
- Made production logging configurable through environment values.
- Corrected optional local launch/install support by loading `opn`.

## 2.4.0 — SpankBang, Eporner, XVideos, and Porntrex recovery

- Added a persistent `curl_cffi==0.15.0` Safari-impersonation helper for SpankBang page requests; the helper is installed permanently during package `postinstall` and is restricted to approved SpankBang HTTPS hosts.
- Added Eporner Referer/Origin/User-Agent proxy headers, forced protected playback, and H.264/AVC preference over AV1/HEVC/VP9 at equal resolution.
- Repaired malformed XVideos catalog links containing `/THUMBNUM/`, added 404-only canonical URL retries, and forced Referer-aware protected playback for direct MP4 and HLS streams.
- Rebuilt Porntrex source extraction for current KVS page shapes, including assigned flashvars objects, quoted source keys, HTML sources, Open Graph, JSON-LD, and safe media fallbacks.
- Added Phase 4 regression tests and Python-aware release validation.


## Phase 4 R2 validation correction

- XVideos catalog parsing now accepts both relative and same-origin absolute HTTPS video hrefs while rejecting external hosts and non-HTTPS URLs. This preserves malformed `THUMBNUM` template context so canonical retry candidates can be attempted.

## 2.4.1 — Eporner and XVideos playback relay hotfix

- Added an opaque, short-lived, allowlisted media relay served by OnlyPorn before the Stremio addon router.
- Routed Eporner MP4/HLS through Render so signed CDN URLs, cookies, and request headers remain in the same provider context instead of redirecting to `na.mp4`.
- Routed XVideos HLS through Render, normalized playlist responses to HTTP 200 with the HLS MIME type, and rewrote variant/segment/key/map URIs.
- Preserved Range support for MP4 files and HLS segments while deliberately ignoring Range and conditional caching for playlists.
- Added six focused hotfix regression tests.

## v2.4.2

- Completed XNXX malformed URL repair and protected HLS/MP4 media relay.

## Phase 5 — v2.5.0

- Added the JAV HD Porn provider and eighth catalog with search, category filters, pagination, landscape posters, and opaque provider-scoped IDs.
- Added JSON-LD metadata extraction for runtime, release year, actors, descriptions, tags, and provider links.
- Implemented the site's versioned RC4-compatible player bootstrap decoder and form-encoded `/api/play/` request path without executing obfuscated browser JavaScript.
- Added recursive player-page discovery for MP4/HLS sources, reserve-source handling, explicit unavailable-player rejection, and aggressive banner/preview-media filtering.
- Extended the protected media relay to approved JAV HD Porn, PornFHD, and StorageXHD domain suffixes while retaining public-address and HTTPS validation.
- Added request-body support and body-aware request deduplication to the central provider transport.

## Hotfix 2.5.1

- Production Render testing showed Node/Axios received HTTP 403 for the JAV HD Porn censored catalog while `curl_cffi` Safari impersonation returned HTTP 200 with 76,683 bytes and 44 `/video/` links.
- Routes JAV HD Porn catalog, search, genres, pagination, metadata, video pages, and `/api/play/` POST requests through the persistent Safari helper.
- Keeps separate SpankBang and JAV HD Porn Safari sessions so cookies and anti-bot state cannot cross providers.
- Forwards the JAV HD Porn Safari-session cookies to protected media relay requests when available.
- Preserves the working live catalog parser, which returned 22 metadata entries from the successful Safari response.
## Hotfix 2.5.2

- Removed the SpankBang homepage bootstrap that returned HTTP 403.
- Added dynamic numbered JAV HD Porn player-host support.
- Added isolated JWPlayer configuration capture for encrypted `data-config` pages.
- Added `streamhls.click` playlist relay and strict TikTok CDN segment relay.
- Added PNG-container removal and MPEG-TS validation for JAV HD Porn HLS segments.

## Hotfix 2.5.3

- Restored the exact isolated v2.4.2 SpankBang Safari helper, persistent session, age cookies, homepage bootstrap, and Referer flow.
- Moved JAV HD Porn to a completely separate Python helper and Node client.
- Replaced the incompatible production JWPlayer browser stubs with the minimal Render-proven JSDOM environment.
- Retained dynamic player hosts, encrypted configuration capture, HLS relay rewriting, and PNG-wrapped MPEG-TS decoding.
- Added explicit live production gates so fixture-only success cannot be reported as a completed provider repair.
## 2.5.4
- Made the JAVHDPorn JWPlayer decoder child protocol immune to console-output pollution.
- The decoder now emits one marked result and exits immediately after writing it.

## Hotfix 2.5.5

- Made SpankBang homepage bootstrap best effort so a Cloudflare challenge on `/` cannot block a working catalog or video route.
- Added second-layer decryption for JAV HD Porn `reserve[i].data` player values.
- Prioritized reserve players before the primary player after live testing showed the primary Maxstream CDN returned HTTP 403 from Render while reserve player zero resolved to `streamhls.click`.
- Removed raw JAV HLS fallback behavior; candidates rejected by the protected relay are now omitted.

## Phase 6 — 2.6.0

- Added Pornhub as the eighth provider and ninth catalog.
- Added a provider-isolated persistent `curl_cffi` Chrome helper with public-access disclaimer cookies.
- Added same-origin `viewkey` catalog IDs, catalog/search/pagination parsing, Open Graph/JSON-LD metadata, and duplicate filtering.
- Added complete `mediaDefinitions` parsing for every signed HLS resolution.
- Added optional `/video/get_media` expansion for direct MP4 resolutions without treating an empty array as a failure.
- Added protected `phncdn.com` HLS/MP4 relay support with Origin, Referer, User-Agent, Range support, relative child rewriting, and exact signed-query preservation.
- Stream extraction always refreshes the video page so temporary CDN signatures are not reused from stale HTML.
- Updated older regression tests to accept later semantic versions while retaining their original behavior assertions.

## Hotfix 2.6.2 — JAVHDPorn vdcdn playback

- Added exact and subdomain approval for `vdcdn.xyz` only inside the JAVHDPorn protected media profile.
- Kept lookalike domains, unrelated `.xyz` hosts, and use by other providers blocked.
- Preserved the existing three-layer JAVHDPorn decoder, Safari cookies and headers, reserve-player ordering, Maxstream rejection, and custom HLS token lines.
- Added byte-level normalization for `.webp`-named segments that are already aligned MPEG-TS at byte zero, returning them as `video/mp2t` without removing bytes.
- Retained existing PNG-wrapped MPEG-TS removal, including the production-observed 70-byte wrapper path.
- Added focused offline regression coverage and a live two-title smoke command.
- Deliberately did not restore Hardening Phase 0; relay tokens remain on the stable v2.6.0 45-minute model until Phase 0 is reintroduced separately.

## Hardening Phase 0 restoration — 2.6.3

- Restored the eight-hour media-relay session lifetime on top of the verified v2.6.2 JAVHDPorn hotfix.
- Replaced one-cache-entry-per-HLS-child behavior with authenticated stateless child tokens tied to the original playback session.
- Nested playlists, keys, maps, and segments reuse the same provider headers and session.
- Preserved `vdcdn.xyz` approval, custom `#EXT-X-TOKEN` lines, raw `.webp` MPEG-TS normalization, and PNG-wrapper removal.
- Preserved the three-layer JAVHDPorn decoding pipeline and 30-second AIOStreams timeout.
- Render restarts still invalidate process-local sessions; restart-safe relay state remains a later hardening phase.

## Hardening Phase 1 — 2.6.4

- Removed the HLS playlist fail-open path that returned a resolved raw upstream URL when a child could not be protected by the relay.
- Added a dedicated `HLS_CHILD_REJECTED` error for invalid, non-HTTPS, unapproved, or otherwise unrelayable playlist children.
- Applied the same fail-closed rule to bare URI lines and quoted `URI="..."` attributes.
- Added a controlled HTTP 502 response with no raw child URL or signed query leakage.
- Preserved Phase 0 eight-hour sessions, stateless child tokens, one-session cache behavior, and tamper rejection.
- Preserved the v2.6.2 JAVHDPorn `vdcdn.xyz` hotfix, custom token lines, raw `.webp` MPEG-TS normalization, PNG-wrapper decoding, and all three decoder layers.

## 2.7.0-alpha.1 — TPB4K Phase 1 foundation

- Added the exact 28 TPB4K catalogs selected for the first OnlyPorn implementation.
- Added strict candidate normalization so unresolved HTML/detail pages cannot become streams.
- Added standard `infoHash`/tracker output for torrent candidates and explicit validation for direct media.
- Added ranking and deduplication favoring validated direct and cached high-resolution results.
- Added environment-only TPDB/StashDB configuration and secret-redacted status reporting.
- Kept the feature disabled by default while source adapters are developed and validated.
