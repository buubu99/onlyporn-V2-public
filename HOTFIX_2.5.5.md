# OnlyPorn Hotfix 2.5.5

## Confirmed production faults

Render testing established two independent failures in v2.5.4:

1. SpankBang `/` returned a Cloudflare challenge while `/trending_videos/` returned HTTP 200 with valid catalog HTML. The helper incorrectly treated homepage bootstrap as mandatory and aborted before requesting the working route.
2. JAV HD Porn successfully decoded the primary JWPlayer source, but that source resolved to `s1.maxstream.org`, which returned HTTP 403 from Render. The `/api/play/` response also contained encrypted reserve-player values that the provider had not decrypted a second time.

## Corrections

- SpankBang homepage bootstrap is best effort. The requested catalog/video route is authoritative, and any successful non-challenge route marks the persistent session usable.
- JAV HD Porn decrypts each inner `reserve[i].data` value with the captured video ID and player version.
- Reserve players are evaluated before the primary player. Live testing showed `reserve[0]` resolves through `video1.javhdporn.net` to the already supported `streamhls.click` and TikTok CDN relay path.
- Media candidates rejected by the protected relay return `null` and are filtered from the Stremio stream response. OnlyPorn no longer exposes an inaccessible raw HLS fallback.

## Live acceptance gates

After deployment:

- `/catalog/movie/spankbang.json` must return a non-empty `metas` array even when the SpankBang homepage is challenged.
- JAV HD Porn logs must show `reservePlayers` greater than zero, `jwSources` greater than zero, and at least one media relay token.
- The returned JAV HD Porn stream URL must start with the OnlyPorn `/media/` route, not `maxstream.org`.
- A relayed TikTok segment must be returned as `video/mp2t` with MPEG-TS sync byte `0x47`.
