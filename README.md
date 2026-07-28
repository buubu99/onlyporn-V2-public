# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, and xHamster providers.

## Current release: 2.4.0

This release adds:

- Persistent Safari `curl_cffi` transport for SpankBang Cloudflare access.
- Referer-aware protected playback and H.264 preference for Eporner.
- XVideos `/THUMBNUM/` catalog URL repair and protected playback headers.
- Modern KVS source extraction for Porntrex.

See `PHASE4_RELEASE.md` for the implementation details and `DEPLOY_2.4.0.md` for the existing Render-service deployment procedure.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.4.0
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and provider regression tests. The live smoke test requires all seven catalogs to return data unless an explicit `KNOWN_EMPTY_CATALOGS` override is supplied.
