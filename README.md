# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Current release: 2.6.0

OnlyPorn v2.6.0 adds Pornhub as the eighth provider and ninth catalog while retaining the stable v2.5.5 SpankBang and JAV HD Porn fixes.

Pornhub support includes public catalog/search/pagination, metadata, every unique signed HLS resolution, optional direct MP4 resolutions from `/video/get_media`, a provider-isolated Chrome `curl_cffi` session, and protected `phncdn.com` HLS/MP4 relay handling with exact signed-query preservation.

See `PHASE6_RELEASE.md` and `DEPLOY_2.6.0.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:phase6
npm run test:hotfix255
npm run test:phase4
npm run test:phase5
EXPECTED_VERSION=2.6.0 npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.6.0
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. Live Render verification remains required because Cloudflare, temporary signatures, and media-CDN behavior are external runtime dependencies.
