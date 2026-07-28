# OnlyPorn 2.3.0 — Phase 3 verification and operational hardening

Phase 3 preserves the live provider behavior from 2.2.1 and adds a repeatable release gate. It is designed to detect parser, metadata, pagination, stream-selection, security, and packaging regressions before a commit can reach Render.

## Included

- Saved offline HTML/JSON/M3U8 fixtures for Eporner, SpankBang, xHamster, Porntrex, XVideos, and XNXX.
- End-to-end fixture tests for catalog parsing, metadata, posters, direct MP4 selection, preview rejection, HLS parsing, URL resolution, provider route generation, pagination uniqueness, retry recovery, concurrent-request deduplication, and manifest/provider routing.
- A release validator that checks every JavaScript file, package version, trailing whitespace, forbidden secret files, catalog descriptors, and required test assets.
- A live smoke-test command that checks the deployed manifest, all seven catalogs, duplicate IDs, incomplete metadata, and page-2 repetition. The confirmed Render-to-SpankBang Cloudflare block is reported as a known warning rather than silently treated as a working provider.
- Production logging now respects `NODE_ENV`, `LOG_LEVEL`, and `LOG_ENABLED`.
- Addon handler errors use structured logging rather than raw `console.error` output.
- The optional local `--launch` and `--install` commands now load the existing `opn` dependency correctly.

## SpankBang status

SpankBang remains declared in the manifest as requested. Live tests from both Render Singapore (`SIN`) and Oregon (`PDX`) returned Cloudflare HTTP 403 before provider HTML reached the addon. Phase 3 does not remove the catalog and does not claim to bypass that upstream block.

## Commands

- `npm run test:phase3` — Phase 3 fixture tests only.
- `npm run test:release` — Phase 1, Phase 2, hotfix, and Phase 3 tests.
- `npm run validate:release` — static release checks followed by the complete test suite.
- `npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.3.0` — post-deployment live verification.
