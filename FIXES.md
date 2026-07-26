# OnlyPorn V2 playback fixes

This fork contains targeted playback and compatibility fixes:

- Corrects xHamster HLS variant URL resolution so every quality no longer points to the same master playlist.
- Adds standard Stremio `behaviorHints.proxyHeaders.request` fields for xHamster, SpankBang, and Porntrex protected media.
- Preserves SpankBang custom stream arrays through a dedicated stream response without polluting metadata.
- Applies provider-specific request headers passed to the shared HTTP client.
- Resolves relative HLS variant URLs with the WHATWG `URL` resolver instead of fragile string concatenation.
- Bumps the addon version to `2.0.1`.

Deployment remains Node.js with `yarn install` and `npm start`.


## 2.0.2 — xHamster metadata and zero-stream regression

- Restored xHamster video-page fetching to the browser request profile used by the working upstream deployment.
- Added a balanced parser for multiline `window.initials` assignments and support for `JSON.parse(...)` assignments.
- Added Open Graph, JSON-LD and recursive media-URL fallbacks.
- Prevented invalid empty metadata objects from being returned to Stremio/AIOStreams.
- Avoided caching temporary fallback-only metadata responses.


## 2.0.3 — xHamster direct-MP4 playback compatibility

- Diagnoses the AIOStreams built-in proxy failure on nested xHamster HLS paths.
- xHamster media playlists referenced paths such as
  `480p.av1.mp4/init-v1-a1.mp4`; AIOStreams returned HTTP 404 before making an
  upstream request for those nested paths.
- Prefers and returns xHamster's direct MP4 sources when available.
- Keeps the required Referer, Origin, User-Agent and age-preference Cookie in
  standard Stremio `behaviorHints.proxyHeaders.request`.
- Keeps H.264 HLS ahead of AV1 HLS only as a fallback when no MP4 exists.
