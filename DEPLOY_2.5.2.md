# Deploy OnlyPorn v2.5.2

The repository must currently be version `2.5.1` with a clean Git status.

Before committing:

```bash
npm install --no-package-lock --no-audit --no-fund
npm run test:hotfix252
npm run test:phase5
EXPECTED_VERSION=2.5.2 npm run validate:release
```

After Render reports Live, verify the manifest and both affected providers:

```bash
curl -fsS https://onlyporn-v2-public-k143.onrender.com/manifest.json
curl -fsS https://onlyporn-v2-public-k143.onrender.com/catalog/movie/spankbang.json
curl -fsS https://onlyporn-v2-public-k143.onrender.com/catalog/movie/javhdporn.json
```

Then open one JAV HD Porn item through Stremio and confirm the Render logs contain:

- `OnlyPorn@2.5.2`
- `catalogs: 8`
- `JAVHDPorn Safari request succeeded`
- `JAVHDPorn encrypted JWPlayer configuration decoded`
- `mediaCandidates` greater than zero
- no `spankbang bootstrap returned HTTP 403`

The HLS relay should return:

- master and variant playlists as `application/vnd.apple.mpegurl`;
- wrapped JAV HD Porn segments as `video/mp2t` after PNG removal.
