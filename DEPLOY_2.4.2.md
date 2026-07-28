# Deploy OnlyPorn v2.4.2

Deploy over v2.4.1 only after the complete release validation passes. Create a backup branch before replacing repository contents. Render should auto-deploy after pushing `main`.

After deployment, confirm:

- `OnlyPorn@2.4.2` starts successfully.
- Seven catalogs remain present.
- XNXX malformed catalog links log `XNXX repaired malformed catalog URL` instead of HTTP 404.
- XNXX playback registers `xnxx` media relay tokens.
- AIOStreams accesses the OnlyPorn `/media/.../index.m3u8` route rather than the raw XNXX CDN playlist.
