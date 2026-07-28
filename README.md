# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, and JAV HD Porn providers.

## Current release: 2.5.2

Phase 5 preserves the fully working v2.4.2 provider recovery and adds JAV HD Porn as the seventh provider and eighth catalog.

- JAV HD Porn catalog, search, categories, pagination, JSON-LD metadata, actors, runtime, and tags.
- HAR-derived version-2 player bootstrap decoding and `/api/play/` POST transport.
- Safari `curl_cffi` transport for JAV HD Porn catalog, metadata, search, pagination, and player API requests on Render.
- Dynamic numbered player-host support plus isolated JWPlayer `data-config` capture for protected HLS discovery.
- Protected Render relay for `streamhls.click` playlists and PNG-wrapped TikTok CDN MPEG-TS segments.
- SpankBang direct Safari requests without the blocked homepage bootstrap; Eporner/XVideos/XNXX relays remain intact.

See `HOTFIX_2.5.2.md` and `DEPLOY_2.5.2.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:hotfix252
npm run test:phase5
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.5.2
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. The live smoke test expects eight catalogs.
