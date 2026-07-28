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
