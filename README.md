# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Stable provider baseline: 2.6.4

## Current TPB4K candidate: 2.7.0-alpha.11

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

Version `2.7.0-alpha.11` retains the original TPB4K foundation and all 28 selected unified-resolution catalogs. The feature is controlled by `TPB4K_ENABLED`; with it enabled the addon exposes 37 total catalogs, including the 28 TPB4K catalogs. Alpha.11 completes the missing poster-enrichment layer while TPB4K stream resolution remains intentionally empty until Phase 3.

## TPB4K Phase 2A

Version `2.7.0-alpha.11` retains the alpha.10 TPB-compatible studio architecture: each of the 19 selected studio catalogs searches UHD category 507, sorted by seeders with order code 7, using the fixed TheHiddenBay / ThePirateBay0 / PirateBay Live chain. It now enriches those torrent records with strictly matched StashDB/TPDB artwork while preserving the original torrent identity. Every returned TPB4K card is guaranteed a safe HTTPS poster through committed source/studio fallback PNGs when upstream artwork is missing. Magnets and info hashes remain private, and TPB4K stream resolution remains intentionally empty until Phase 3.

See `TPB4K_POSTER_ENRICHMENT.md` and `DEPLOY_TPB4K_POSTER_ENRICHMENT.md`.

## TPB4K Phase 2B

Alpha.4 adds optional metadata-only discovery feeds for PornRips, YesPorn, Hentai, and Sukebei plus a Render preview smoke suite. Stripchat remains gated to Phase 7.

### TPB4K native metadata acquisition

PornRips, YesPorn, and HentaiMama catalog metadata is acquired directly from fixed audited HTTPS origins. No external JSON feed URLs are required. Playback resolution begins in later TPB4K phases.

### TPB studio catalog transport

The 19 `tpb4k.studio.*.top` catalogs do not come from StashDB. They use TPB-style HTML search paths `/search/{studio}/{page}/7/507`. `TPB4K_TPB_MIRRORS` may override the comma-separated mirror order for operations, but only bare credential-free HTTPS origins are accepted.
