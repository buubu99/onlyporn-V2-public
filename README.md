# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Current release: 2.6.3

OnlyPorn v2.6.3 restores Hardening Phase 0 on top of the production-verified v2.6.2 JAVHDPorn `vdcdn.xyz` hotfix.

The relay now uses eight-hour top-level playback sessions and authenticated stateless child tokens for HLS variants, keys, maps, and segments. A multi-hour playlist therefore consumes one in-memory session instead of one cache entry per segment. The v2.6.2 JAVHDPorn host approval and raw `.webp` MPEG-TS normalization remain intact, and all three JAVHDPorn decoding layers remain unchanged.

Sessions are still process-local: a Render restart or redeploy invalidates active playback links. Upstream CDN signatures can also expire independently of the internal eight-hour session.

See `PHASE0_HARDENING.md`, `HOTFIX_2.6.2.md`, and `DEPLOY_2.6.3.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:phase0
npm run test:hotfix262
npm run test:phase6
npm run test:hotfix255
npm run test:phase4
npm run test:phase5
EXPECTED_VERSION=2.6.3 npm run validate:release
npm run smoke:jav262
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.6.3
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. Live Render verification remains required because Cloudflare, temporary signatures, and media-CDN behavior are external runtime dependencies.
