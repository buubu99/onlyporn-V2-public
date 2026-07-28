# OnlyPorn Hotfix 2.5.2

OnlyPorn 2.5.1 restored the JAV HD Porn catalog through the persistent `curl_cffi` Safari transport, but live playback still returned zero streams. The same release also regressed SpankBang because the shared Safari helper attempted a homepage bootstrap that received HTTP 403.

## Live Render diagnosis

The complete JAV HD Porn playback chain was verified on Render:

- video metadata page: HTTP 200 through Safari;
- `/api/play/`: decoded successfully;
- dynamic player host such as `video1.javhdporn.net`: HTTP 200 through the same Safari session;
- player page: encrypted `#jwplayer[data-config]` plus obfuscated `/main.js`;
- intercepted JWPlayer setup: fresh `streamhls.click/.../master.m3u8` source;
- master playlist: 480p, 720p, and 1080p variants;
- variant entries: TikTok CDN objects reported as `image/png`;
- each object: a small PNG wrapper followed immediately by an aligned MPEG transport stream.

## Changes

### SpankBang

- Disable the blocked homepage bootstrap.
- Keep Safari impersonation, provider-isolated sessions, and age-verification cookies.
- Request catalog and video URLs directly.

### JAV HD Porn

- Accept strict dynamic player hosts matching `video<number>.javhdporn.net`.
- Fetch the player page and `main.js` through the persistent JAV HD Porn Safari session.
- Execute the protected player JavaScript in a short-lived, memory-limited child process.
- Intercept `jwplayer().setup(...)` and retain only playable HLS/MP4 sources.
- Relay `streamhls.click` playlists through OnlyPorn.
- Rewrite master, variant, key, map, and segment URIs with explicit HLS kinds.
- Permit only the required JAV HD Porn relay hosts, including `streamhls.click` and `tiktokcdn.com`.
- Detect PNG-wrapped TikTok CDN segments, remove the complete PNG container, verify 188-byte MPEG-TS synchronization, and return the payload as `video/mp2t`.
- Keep all signed upstream URLs short-lived and uncached.

The manifest remains seven providers and eight catalogs.
