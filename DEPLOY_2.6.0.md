# Deploy OnlyPorn 2.6.0

Deploy only after `npm run test:phase6` and `EXPECTED_VERSION=2.6.0 npm run validate:release` pass on the Mac repository.

After Render becomes live:

1. Confirm `/manifest.json` reports `2.6.0`, eight providers, and nine catalogs.
2. Confirm the Pornhub catalog returns non-empty metadata with posters.
3. Open a Pornhub item and confirm all available HLS resolutions are returned.
4. When `/video/get_media` is non-empty, confirm direct MP4 resolutions are also returned.
5. Confirm every Pornhub stream URL begins with the OnlyPorn `/media/` relay route.
6. Play at least one HLS stream through AIOStreams/Stremio and verify Render serves the master, variant, and MPEG-TS segments without HTTP 410.
7. Recheck SpankBang and JAV HD Porn to ensure v2.5.5 behavior remains intact.
