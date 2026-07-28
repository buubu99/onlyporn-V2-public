# OnlyPorn 2.4.1 — playback relay hotfix

Version 2.4.1 keeps the successful SpankBang Safari transport from 2.4.0 and corrects the two remaining playback failures observed through AIOStreams.

## Eporner

The Eporner source API returns signed CDN URLs tied to the requester context. In the captured production path, OnlyPorn obtained the URL on Render, but AIOStreams later fetched it from another egress address. Eporner redirected that request to `static.eporner.com/na.mp4`, which is the restriction placeholder shown by Stremio.

Eporner streams now use a short-lived, opaque OnlyPorn relay URL. The relay:

- fetches the signed media from the same Render service that obtained it;
- preserves Referer, Origin, User-Agent, Range, and available Eporner session cookies;
- supports MP4 byte ranges;
- rejects the known `na.mp4` fallback instead of returning it as a valid stream;
- never exposes upstream cookies in logs or Stremio stream objects.

## XVideos

The captured XVideos stream was a valid HLS variant, but AIOStreams served the `.m3u8` as partial `text/plain` responses. Stremio Web repeatedly requested the playlist but never requested media segments, resulting in “Video is not supported.”

XVideos HLS variants now use the same internal relay. The relay:

- fetches playlists without forwarding browser Range or conditional-cache headers;
- always returns playlists as HTTP 200 with `application/vnd.apple.mpegurl`;
- rewrites variant, segment, initialization-map, and encryption-key URIs to absolute relay URLs;
- relays segments and keys with byte-range support and CORS headers;
- retains the required XVideos Referer, Origin, and User-Agent upstream.

## Security and operations

- Relay links are random, opaque, short-lived tokens held only in the single Render process.
- Tokens cannot be used to choose an arbitrary URL.
- Eporner tokens accept only Eporner HTTPS hosts.
- XVideos tokens accept only XVideos/XVideos-CDN HTTPS hosts.
- The existing `WEB_CONCURRENCY=1` Render deployment is compatible with the in-memory token store.
- No new npm or Python dependency was added.
