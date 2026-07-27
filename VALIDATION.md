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
