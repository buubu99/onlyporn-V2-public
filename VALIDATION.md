
## TPB4K Phase 1 alpha.2 unified-resolution checks

- All 28 selected catalogs are source/studio catalogs, not resolution-specific catalogs.
- No catalog definition contains `targetResolution`.
- No studio catalog display name contains `4K · Top` or `1080p · Top`.
- One candidate set keeps 2160p, 1080p, and lower valid fallbacks together.
- Ready streams are ranked first; seeded P2P follows; uncached torrents are last.
- Resolution descends within each readiness tier.

# Validation report

Validated on 2026-07-26:

- Every JavaScript file passed `node --check`.
- `package.json` parsed successfully as JSON.
- Static playback tests passed for:
  - xHamster variant URL resolution and proxy headers.
  - SpankBang proxy headers and custom catalog ID resolution.
  - XVideos and XNXX relative HLS URL resolution.
  - Shared relative and root-relative HLS URL resolution.
- No `.env` file or embedded API key/password/token was found in the repository.

Live requests to the third-party provider websites were not executed in the validation environment. Final verification must be performed after deploying the fork on Render and testing through AIOStreams/Stremio.


## 2.0.2 validation

- `node --check provider/xhamster.js`
- Offline parser test: multiline `window.initials` metadata and HLS source extraction.
- Offline transform test: relative HLS variant resolves against the master playlist and retains proxy headers.
- Live provider access still requires deployment validation because third-party provider sites are not reachable from the build sandbox.


## 2.0.3 validation

- All JavaScript files pass `node --check`.
- Synthetic xHamster parser test confirms direct MP4 sources are selected ahead
  of AV1 HLS sources.
- Synthetic test confirms direct MP4 streams include standard Stremio playback
  headers and are not serialized into the metadata JSON.
- Live third-party playback still requires deployment testing because xHamster
  source availability varies by video and region.


## 2.0.4 regression check

A synthetic xHamster page containing both an AV1 HLS URL and direct MP4 URLs is used to verify that `processStreams()` returns MP4 streams and never short-circuits to the HLS URL.

## 2.0.6 xHamster stream hygiene
- Rejects animated thumbnail clips such as `526x298.*.t.mp4`.
- Requires a recognized resolution in the candidate path or URL.
- Emits at most one direct MP4 per resolution, sorted highest to lowest.

## 2.0.6 static provider audit

- JavaScript syntax checked for all provider files.
- Preview URL classifier tested against xHamster `.t.mp4`, Porntrex screenshot paths and common preview/trailer/sample naming.
- Full-video classifier tested against resolution-labelled MP4 paths and Porntrex `/contents/videos/` media paths.
- Live third-party provider playback still requires deployment testing because provider pages and CDN responses change independently.

## 2.1.0 Phase 1 validation — 2026-07-27

Completed offline:

- All JavaScript files passed `node --check`.
- `package.json` parsed successfully and reports version `2.1.0`.
- Seven Phase 1 tests passed with `node --test provider/phase1.test.js`:
  - bounded cache eviction;
  - expired-entry deletion;
  - rejection of empty/null cache values;
  - opaque provider-scoped ID round-trip;
  - HTTPS/credential/port/localhost validation;
  - private/reserved IPv4 and IPv6 rejection;
  - approved-host enforcement and source-level regression checks.
- Repository scan found no `.env` file, private key, password, API token, or Git metadata.
- No new npm dependency was added; the existing Render build/install process remains unchanged.

Not executable in the offline build environment:

- Live provider HTTP requests.
- Render build and deployment.
- Playback through AIOStreams/Stremio.

After deployment, verify all seven catalogs, search, page 2, metadata, and at least one stream per provider. Preserve the existing 2.0.6 Git commit so rollback is immediate if a provider has changed its live HTML or redirect behavior.

## 2.2.0 Phase 2 validation — 2026-07-27

Completed offline:

- All JavaScript files passed `node --check`.
- `package.json` parsed successfully and reports version `2.2.0`.
- Combined release tests passed with `node --test provider/phase1.test.js provider/phase2.test.js`: 15 passed, 0 failed.
- Phase 2 tests cover Eporner route generation, safe SpankBang JavaScript-literal parsing, shared preview rejection, direct-MP4 selection, relative URL resolution, JSON-LD arrays/`@graph`, deterministic XNXX poster frames, and source-level integration of the new provider paths.
- Phase 1 cache, scoped-ID, HTTPS, hostname, redirect, and private-network protections remain covered by regression tests.
- Repository scan found no `.env`, private key, password, API token, Git metadata, or deployment credential.
- No npm dependency was added.

Not executable in the offline build environment:

- Live third-party provider requests.
- Render build/deployment.
- Playback through AIOStreams/Stremio.

After deployment, verify manifest version `2.2.0`, all seven catalogs, Eporner sort differences, SpankBang metadata/playback, xHamster Load More uniqueness, XVideos/XNXX direct MP4 playback, and XNXX poster consistency. Preserve `backup-v2.1.0-before-phase2` until those checks pass.

## 2.3.0 Phase 3 validation — 2026-07-27

Phase 3 adds a dependency-backed offline fixture suite and a release-validation gate.

Static validation completed in the packaging environment:

- All 36 JavaScript files passed `node --check`.
- The release validator inspected 69 repository files.
- No trailing whitespace, `.env`, private key, Git metadata, or deployment credential was included.
- `package.json` parses and reports version `2.3.0`.
- Fixture assets are included for all six provider implementations plus HLS master-playlist resolution.

The packaging environment could not retrieve npm dependencies from its package gateway, so the dependency-backed Phase 3 fixture suite could not be executed there. The deployment command intentionally runs `npm install` and `npm run validate:release` before creating the Git commit. Any test failure stops the script before GitHub or Render is changed.

After Render becomes Live, run the included live smoke test. SpankBang is retained in the manifest but is currently a known empty catalog on Render because direct tests from both Singapore and Oregon received upstream Cloudflare HTTP 403 responses.

## 2.4.0 Phase 4 validation — 2026-07-28

Phase 4 targets the failures captured from the live 2.3.0 deployment:

- SpankBang catalog HTTP 403 from ordinary Node requests.
- Eporner anti-hotlink placeholder playback.
- XVideos metadata HTTP 404 caused by `/THUMBNUM/` in a catalog URL.
- Porntrex pages yielding no genuine stream candidates.

The release includes offline regression coverage for:

- XVideos canonical page-ID repair and protected direct-MP4 playback headers.
- Eporner H.264 preference and video-page Referer propagation.
- Porntrex modern `flashvars`/quoted-key source extraction and stream ordering.
- Permanent SpankBang `curl_cffi==0.15.0` Safari transport packaging.

Production evidence already established that Safari impersonation returns HTTP 200 for the SpankBang homepage and trending catalog from the live Singapore Render instance. Full catalog-to-playback verification must still be performed after deploying version 2.4.0 because provider HTML, CDN authorization, and AIOStreams proxy behavior are external runtime dependencies.

Packaging validation completed for the 2.4.0 ZIP:

- 39 JavaScript files passed `node --check`.
- The Python Safari helper passed AST syntax validation.
- The release validator inspected 76 source files and found no trailing whitespace, forbidden secret-bearing files, or missing release components.
- The Phase 1, Phase 2, and catalog-hotfix suites completed with 19 passing tests and no failures in the available offline environment.
- Targeted pure-logic checks passed for XVideos canonical retry order, Eporner codec selection and protected HLS headers, Porntrex literal decoding, the Python helper bootstrap/allowlist protocol, and the Node-to-Python JSON transport.
- The full Cheerio-backed Phase 3/Phase 4 fixture suites require the normal Node dependency installation and remain part of `npm run validate:release` on Render.

## 2.4.1 playback-relay validation — 2026-07-28

Production logs established two separate remaining failures after 2.4.0:

- Eporner signed media requests were redirected to `static.eporner.com/na.mp4` after the stream moved from Render extraction to the AIOStreams egress path.
- XVideos HLS playlists reached AIOStreams, but were served as partial `text/plain` responses; the client repeatedly fetched the playlist without requesting segments.

Packaging validation completed for 2.4.1:

- 41 JavaScript files and one Python helper passed syntax validation.
- The release validator inspected 78 repository files and found no forbidden secret files or trailing whitespace.
- Six focused media-relay tests passed, covering host allowlists, opaque token storage, HLS URI rewriting, MIME/status normalization, Eporner cookie/header preservation, XVideos relay integration, and route ordering.
- The available Phase 1, Phase 2, catalog-hotfix, and 2.4.1 focused suites completed with 25 passing tests and no failures.
- The full Cheerio-backed fixture suite remains part of `npm run validate:release` and is executed after normal dependency installation by the deployment script.

Live Render/AIOStreams playback remains the final validation because provider signatures, CDN redirects, and player behavior are external runtime dependencies.

## v2.4.2

- Added XNXX THUMBNUM canonicalization and protected media relay regression coverage.

## Phase 5 validation — v2.5.0

Phase 5 adds `provider/phase5.test.js`. It validates the captured JAV HD Porn version-2 player bootstrap vector, catalog host filtering, JSON-LD metadata, encrypted player API response handling, advertisement rejection, protected relay allowlists, eight-catalog manifest wiring, and deterministic search/category/pagination routes.

The HAR used during development is intentionally excluded from the package. The included fixture contains only minimal synthetic HTML and no browser cookies, analytics identifiers, or request headers.

## Hotfix 2.5.1 validation

Production diagnosis on the Singapore Render instance established the transport mismatch: Node/Axios returned HTTP 403 for `https://www.javhdporn.net/v3/category/censored/`, while `curl_cffi==0.15.0` with Safari impersonation returned HTTP 200, 76,683 response bytes, 44 `/video/` occurrences, and 22 parsed catalog entries. The hotfix adds an isolated persistent JAV HD Porn Safari session and uses it for page GETs, player-page HEAD/GET requests on approved JAV hosts, and the form-encoded `/api/play/` POST.

Run `npm run test:hotfix251`, then `EXPECTED_VERSION=2.5.1 npm run validate:release`. After Render becomes live, request `/catalog/movie/javhdporn.json`; it must return a non-empty `metas` array and logs must show `JAVHDPorn Safari request succeeded`.
## Hotfix 2.5.2 validation

Run `npm run test:hotfix252`, `npm run test:phase5`, then `EXPECTED_VERSION=2.5.2 npm run validate:release`. Live validation must show a non-empty SpankBang catalog without a bootstrap 403, a non-empty JAV HD Porn catalog, at least one decoded JWPlayer HLS source, relayed HLS playlists, and wrapped TikTok CDN segments returned as `video/mp2t`.

## Hotfix 2.5.3 validation

Run `npm run test:hotfix253`, `npm run test:phase4`, `npm run test:phase5`, then `EXPECTED_VERSION=2.5.3 npm run validate:release`. The focused tests verify byte-compatible SpankBang transport architecture, complete process separation, native browser API preservation in the JWPlayer sandbox, and live-style asynchronous setup capture.

The release is not considered complete until Render returns a non-empty SpankBang catalog, a playable SpankBang stream, a non-empty JAV HD Porn catalog, a decoded JWPlayer source, and a relayed JAV HD Porn stream whose wrapped MPEG-TS segment is served as `video/mp2t`.
## 2.5.4 validation
- Added a regression test with JSON-shaped console noise before and after JWPlayer setup.
- Requires full release validation and live Render confirmation of `jwSources > 0`.

## 2.5.5 validation

- The focused suite uses the captured SAMA-251 reserve ciphertext to verify all four second-layer player URLs, including `video1.javhdporn.net` and `hugstream.xyz`.
- It verifies SpankBang no longer throws when the homepage warmup is challenged.
- It verifies a blocked Maxstream candidate is not returned raw and a relay-compatible `streamhls.click` reserve candidate remains available.
- Live acceptance requires a non-empty SpankBang catalog and an OnlyPorn `/media/` JAV stream URL.

## 2.6.0 validation

- Mac reconnaissance: Pornhub catalog and video pages returned HTTP 200; 44 unique viewkeys were found; `mediaDefinitions` exposed four HLS resolutions.
- Render reconnaissance: catalog and video pages returned HTTP 200 through Chrome `curl_cffi`; 1080p/720p/480p/240p HLS definitions were parsed.
- Render `/video/get_media` returned `[]` for one sample and was treated as an optional MP4 source rather than a playback failure.
- Fresh Render HLS master and variant returned HTTP 200.
- Fresh Render MPEG-TS segment returned HTTP 200 `video/MP2T`, 168824 bytes, and began with sync byte `0x47`.
- Static release validator: JavaScript/Python syntax, catalog descriptors, required files, secret checks, and whitespace checks passed in the build environment.
- Core isolated Pornhub tests: media-definition parsing, all-resolution stream creation, relay allowlist, manifest counts, and signed HLS child-query preservation passed.
- Complete dependency-backed release tests remain mandatory in the supplied Mac deployment script before commit and push.

## 2.6.2 validation

Live Render investigation on v2.6.0 completed the full three-layer JAVHDPorn pipeline for `fc2-ppv-3854676` and `fc2-ppv-4730094`. Both titles decoded one fresh HLS source on `akamai-cache-p01.vdcdn.xyz`. For both titles, the master playlist, first variant playlist, and first segment returned HTTP 200 from Render with the saved Safari-session Cookie, Origin, Referer, and User-Agent headers. The segments were named `seg0.webp`, reported `image/webp`, and contained valid aligned MPEG-TS beginning at byte zero with no wrapper.

The focused hotfix suite validates:

- exact and subdomain `vdcdn.xyz` approval only for JAVHDPorn;
- rejection of lookalikes and unrelated `.xyz` hosts;
- preservation of custom `#EXT-X-TOKEN` playlist lines;
- `.webp` EXTINF objects classified as protected media segments;
- raw MPEG-TS returned byte-identically as `video/mp2t`;
- existing 70-byte PNG-wrapper removal remains operational;
- Safari playback headers remain attached to relayed requests;
- Hardening Phase 0 is absent from this release.

Run `npm run test:hotfix262`, then `EXPECTED_VERSION=2.6.2 npm run validate:release`. Before commit and push, run `npm run smoke:jav262` from a network environment that can reach JAVHDPorn. The smoke command repeats all three decoding layers for the two investigated titles, verifies master, variant, and segment HTTP responses, validates MPEG-TS bytes, and confirms protected relay registration without printing signed URLs or cookies.

## 2.6.3 validation

The combined release must pass the focused Phase 0 suite and the focused v2.6.2 JAVHDPorn suite. The Phase 0 tests verify an eight-hour session lifetime, one cache entry for a 2,000-segment VOD, nested-playlist session reuse, signed child-token HTTP resolution, and tamper rejection. The v2.6.2 tests verify `vdcdn.xyz` provider isolation, token-line preservation, raw `.webp` MPEG-TS normalization, and existing PNG-wrapper decoding.

Run `npm run test:phase0`, `npm run test:hotfix262`, and `EXPECTED_VERSION=2.6.3 npm run validate:release`. Before commit and push, `npm run smoke:jav262` must again pass both production-proven JAVHDPorn titles. After Render is live, both titles must play and one long video must seek beyond the previous 45-minute internal boundary.

## 2.6.4 validation

Hardening Phase 1 adds `provider/phase1-fail-closed.test.js`. The focused suite proves that approved playlist children still become authenticated relay URLs, while unapproved bare children, unapproved `URI="..."` attributes, and non-HTTPS children fail closed. The HTTP handler must return a controlled 502 with `X-OnlyPorn-Relay-Error: HLS_CHILD_REJECTED`, and the response body must not expose the rejected URL or signed query string.

The same release must retain the Phase 0 eight-hour one-session architecture and the production-verified v2.6.2 JAVHDPorn `vdcdn.xyz` repair. Run `npm run test:hardening1`, `npm run test:phase0`, `npm run test:hotfix262`, and `EXPECTED_VERSION=2.6.4 npm run validate:release`. Before commit and push, `npm run smoke:jav262` must again pass both production-proven JAVHDPorn titles. After Render is live, verify those titles plus one Pornhub HLS stream and confirm no playlist response contains a raw external media URL.

## TPB4K Phase 1 validation

Run:

```bash
npm run test:tpb4k-phase1
EXPECTED_VERSION=2.7.0-alpha.2 npm run validate:release
```

The focused suite verifies the 28-catalog registry, feature flag, magnet/hash normalization, HTML rejection, validated direct-media policy, ranking/deduplication, opaque IDs, scene identity, secret redaction, provider contract, and preservation of the v2.6.4 hardening markers.

## TPB4K Phase 2A validation

```bash
npm run test:tpb4k-phase2a
EXPECTED_VERSION=2.7.0-alpha.10 npm run validate:release
npm run smoke:jav262
```

Phase 2A acceptance requires deterministic pagination, header-only metadata authentication, bounded positive/negative caches, no resolution filters in studio queries, no secrets in output, 28 unique TPB4K catalogs, 37 feature-enabled catalogs, and zero fabricated streams.

## TPB4K Phase 2B alpha.4

- Discovery adapters are metadata-only and fixture-tested.
- Source endpoints are HTTPS-only, same-origin, bounded, non-redirecting, and reject HTML.
- Stripchat emits no partial catalog before Phase 7.
- Render preview smoke checks manifest count and all 28 catalog endpoints.

## TPB4K Phase 2C

Run `npm run test:tpb4k-phase2c` for offline parser/security coverage and `npm run smoke:tpb4k-native` for mandatory live non-empty catalog proof. All stream responses remain empty in this phase.

## TPDB + StashDB catalog-only production gate

With `TPDB_API_KEY` and `STASHDB_API_KEY` exported locally:

```bash
TPB4K_ENABLED=true npm run smoke:tpb4k-metadata
```

This must return non-empty listings for ThePornDB Recent and all 19 studio catalogs. It calls no metadata-detail or stream handlers.

## TPB4K Phase 2 poster enrichment — alpha.11

Run:

```bash
npm run test:tpb4k-poster-enrichment
npm run test:tpb4k-torrent-index
EXPECTED_VERSION=2.7.0-alpha.11 npm run validate:release
TPB4K_ENABLED=true npm run smoke:tpb4k-catalog
```

Acceptance requires 100% safe HTTPS poster coverage for every returned TPDB Recent and studio-catalog card, consistent portrait poster shape, no metadata studio conflict, no torrent identity mutation, valid committed 600×900 fallback PNGs, no secret-bearing poster URL, and preserved empty TPB4K stream behavior. The post-deploy Render smoke additionally verifies that a live poster URL returns an image response and that the manifest remains 37 total / 28 TPB4K catalogs.

## TPB4K full poster matching — alpha.12

```bash
npm run test:tpb4k-poster-enrichment
npm run test:tpb4k-torrent-index
TPB4K_ENABLED=true TPB4K_CATALOG_LIMIT=40 npm run smoke:tpb4k-catalog
EXPECTED_VERSION=2.7.0-alpha.12 npm run validate:release
```

Acceptance requires every returned studio card to be enrichment-eligible,
`skipped=0`, complete safe HTTPS poster coverage, preserved source identity,
and no negative caching of provider errors or timeouts.


## TPB4K metadata-first catalogs and content filtering — alpha.13

```bash
npm run test:content-filter
npm run test:tpb4k-studio-metadata
npm run test:tpb4k-phase1
npm run test:tpb4k-phase2a
npm run test:tpb4k-phase2b
npm run test:tpb4k-phase2c
npm run test:tpb4k-torrent-index
npm run test:tpb4k-poster-enrichment
TPB4K_ENABLED=true npm run smoke:tpb4k-catalog
TPB4K_ENABLED=true npm run smoke:tpb4k-metadata-first
EXPECTED_VERSION=2.7.0-alpha.14 npm run validate:release
```

Acceptance requires all 19 studio definitions to use `studio-metadata`, every returned studio card to carry real HTTPS provider artwork, zero generic fallback cards in those rows, provider-scoped metadata IDs, exact StashDB studio-ID filtering, preserved Phase 3 torrent lookup provenance, and global explicit-label filtering across catalog/search, metadata and stream responses. Filter tests must prove that no image analysis or performer-attribute inference is used. All retained JAVHDPorn and HLS hardening gates remain mandatory.


## Alpha.14 Phase 2 final-cleanup gates

- exact Sukebei scene-code extraction and metadata lookup;
- native Sukebei image retention;
- omission of unresolved Sukebei records with no generic artwork;
- filter-after-enrichment validation;
- non-empty OnlyFans platform-hybrid catalog;
- metadata-provider circuit-breaker regression;
- live Sukebei/OnlyFans smoke before commit and after Render deployment.
