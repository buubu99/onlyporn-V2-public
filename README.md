# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Current release: 2.6.2

OnlyPorn v2.6.2 is an isolated JAVHDPorn playback hotfix on top of the stable v2.6.0 release. It approves the production-proven `vdcdn.xyz` CDN only inside the JAVHDPorn relay profile and normalizes image-labelled `.webp` segments whose bytes are already valid MPEG-TS.

The three-layer JAVHDPorn decoder, Safari transport, reserve-player ordering, existing `streamhls.click` and TikTok CDN behavior, PNG-wrapper removal, Maxstream rejection, Pornhub provider, 45-minute relay-token model, and 30-second upstream request timeout are unchanged.

See `HOTFIX_2.6.2.md` and `DEPLOY_2.6.2.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:hotfix262
npm run test:phase6
npm run test:hotfix255
npm run test:phase4
npm run test:phase5
EXPECTED_VERSION=2.6.2 npm run validate:release
npm run smoke:jav262
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.6.2
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. Live Render verification remains required because Cloudflare, temporary signatures, and media-CDN behavior are external runtime dependencies.
