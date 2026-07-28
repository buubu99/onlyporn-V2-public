# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, and JAV HD Porn providers.

## Current release: 2.5.1

Phase 5 preserves the fully working v2.4.2 provider recovery and adds JAV HD Porn as the seventh provider and eighth catalog.

- JAV HD Porn catalog, search, categories, pagination, JSON-LD metadata, actors, runtime, and tags.
- HAR-derived version-2 player bootstrap decoding and `/api/play/` POST transport.
- Safari `curl_cffi` transport for JAV HD Porn catalog, metadata, search, pagination, and player API requests on Render.
- Recursive MP4/HLS discovery with advertisement and unavailable-player rejection.
- Protected Render media relay support for approved JAV HD Porn and PornFHD media hosts.
- Existing SpankBang Safari impersonation and Eporner/XVideos/XNXX playback relays remain unchanged.

See `HOTFIX_2.5.1.md` and `DEPLOY_2.5.1.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:phase5
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.5.1
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. The live smoke test expects eight catalogs.
