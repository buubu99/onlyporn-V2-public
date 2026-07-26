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
