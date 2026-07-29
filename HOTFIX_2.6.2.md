# OnlyPorn 2.6.2 — JAVHDPorn vdcdn playback hotfix

## Scope

This release repairs JAVHDPorn titles whose only decoded media source is served by `vdcdn.xyz`. It is based on v2.6.0 and does not contain Hardening Phase 0.

## Production evidence

Live Render investigation completed the existing three-layer decoder for two failing titles:

- `fc2-ppv-3854676`
- `fc2-ppv-4730094`

For both titles:

1. the main-site player API decoded successfully;
2. the encrypted player configuration and dynamic `main.js` decoded successfully;
3. the isolated JWPlayer capture returned one HLS media candidate;
4. the fresh master playlist returned HTTP 200;
5. the first variant playlist returned HTTP 200;
6. the first `seg0.webp` object returned HTTP 200;
7. the object reported `image/webp` but its payload was aligned MPEG-TS from byte zero.

The missing Stremio playback link was caused by the protected relay rejecting the otherwise valid `vdcdn.xyz` candidate.

## Code change

- Approve `vdcdn.xyz` and legitimate subdomains only for the JAVHDPorn relay profile.
- Continue rejecting lookalikes such as `evilvdcdn.xyz` and `vdcdn.xyz.example.com`.
- Buffer JAVHDPorn transport segments from TikTok CDN or vdcdn, inspect their bytes, and return `video/mp2t`.
- Return raw aligned MPEG-TS unchanged when sync begins at byte zero.
- Continue removing a valid PNG container before MPEG-TS when present.
- Preserve all HLS lines not containing child URIs, including `#EXT-X-TOKEN`.

## Explicitly unchanged

- three-layer JAVHDPorn decoding;
- isolated Safari `curl_cffi` process and cookie store;
- reserve-player-first ordering;
- `streamhls.click` and TikTok CDN handling;
- Maxstream rejection;
- Pornhub Phase 6;
- 30-second upstream request timeout;
- 45-minute relay token lifetime and per-segment token cache from v2.6.0.

## Validation commands

```bash
npm run test:hotfix262
EXPECTED_VERSION=2.6.2 npm run validate:release
npm run smoke:jav262
```

The live smoke must pass before committing to `main`.
