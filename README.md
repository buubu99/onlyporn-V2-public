# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, and xHamster providers.

## Current release: 2.4.2

This release keeps the Phase 4 provider recovery, preserves the Eporner and XVideos media relay fixes, and completes XNXX malformed-link and protected HLS/MP4 playback handling.

- Eporner signed MP4 playback stays on the Render egress IP and preserves provider cookies/headers.
- XVideos HLS playlists are normalized to HTTP 200, the correct MIME type, and absolute relayed segment/key URLs.
- SpankBang Safari `curl_cffi` playback remains unchanged and operational.

See `HOTFIX_2.4.1.md` for the diagnosis and implementation details and `DEPLOY_2.4.1.md` for deployment.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.4.1
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and provider regression tests. The live smoke test requires all seven catalogs to return data unless an explicit `KNOWN_EMPTY_CATALOGS` override is supplied.
