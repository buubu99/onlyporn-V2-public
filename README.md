# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Current release: 2.6.4

OnlyPorn v2.6.4 adds Hardening Phase 1 on top of the production-verified v2.6.3 relay-session repair and v2.6.2 JAVHDPorn `vdcdn.xyz` hotfix.

HLS playlist rewriting is now fail closed. Every bare child URI and every `URI="..."` attribute must resolve to an approved provider-scoped HTTPS host and must be converted to an authenticated OnlyPorn relay URL. Invalid, unsupported, or unapproved children return a controlled HTTP 502 instead of exposing a raw upstream URL.

Phase 0 remains active with eight-hour top-level playback sessions and stateless signed child tokens. The JAVHDPorn three-layer decoder, custom `#EXT-X-TOKEN` preservation, raw `.webp` MPEG-TS normalization, and PNG-wrapper decoding remain unchanged.

Sessions are still process-local: a Render restart or redeploy invalidates active playback links. Request-wide deadlines and provider concurrency budgets remain later hardening work.

See `HARDENING_PHASE1.md`, `PHASE0_HARDENING.md`, `HOTFIX_2.6.2.md`, and `DEPLOY_2.6.4.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:hardening1
npm run test:phase0
npm run test:hotfix262
npm run test:phase6
npm run test:hotfix255
npm run test:phase4
npm run test:phase5
EXPECTED_VERSION=2.6.4 npm run validate:release
npm run smoke:jav262
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.6.4
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. Live Render verification remains required because Cloudflare, temporary signatures, and media-CDN behavior are external runtime dependencies.

## TPB4K integration development

Version `2.7.0-alpha.2` contains the first TPB4K foundation phase. It defines the selected 28 catalogs, strict torrent/direct-media normalization, opaque IDs, scene identity, adapter contracts, and environment-only TPDB/StashDB configuration.

The feature is disabled by default with `TPB4K_ENABLED=false`. No live TPB4K source adapter is included in this phase, so the production 2.6.4 provider/catalog set remains unchanged until individual sources pass fixtures and live validation.
