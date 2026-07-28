# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, and JAV HD Porn providers.

## Current release: 2.5.5

OnlyPorn v2.5.5 corrects two live-production regressions confirmed on Render:

- SpankBang homepage bootstrap is now best effort. A Cloudflare challenge on `/` no longer aborts a real catalog or video route that returns HTTP 200.
- JAV HD Porn now decrypts the inner `reserve[i].data` player values returned by `/api/play/` and evaluates reserve players before the primary player.
- Reserve player discovery can select the working `video1.javhdporn.net` → `streamhls.click` path when the primary player resolves to a Render-blocked Maxstream CDN.
- HLS candidates rejected by the protected relay are dropped instead of being exposed as raw, unsupported Stremio links.
- The existing protected HLS playlist rewriting and PNG-wrapped TikTok MPEG-TS decoding remain unchanged.

See `HOTFIX_2.5.5.md` and `DEPLOY_2.5.5.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:hotfix255
npm run test:phase4
npm run test:phase5
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.5.5
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. Live Render verification remains required because Cloudflare and media-CDN behavior are external runtime dependencies.
