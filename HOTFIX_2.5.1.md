# OnlyPorn Hotfix 2.5.1

OnlyPorn 2.5.0 declared the eighth JAV HD Porn catalog correctly, but the live Render catalog returned `{"metas":[]}` because the provider's Node/Axios request received HTTP 403.

Live Render diagnosis confirmed:

- Node/Axios: HTTP 403.
- `curl_cffi==0.15.0`, Safari impersonation: HTTP 200.
- Successful page size: 76,683 bytes.
- `/video/` occurrences: 44.
- Existing parser output: 22 metadata entries.

Version 2.5.1 therefore keeps the parser and manifest unchanged and moves JAV HD Porn's protected upstream requests to the persistent Safari helper:

- catalog, categories, search, and pagination;
- metadata and video pages;
- form-encoded `/api/play/` POST;
- approved `video.javhdporn.net` player-page probes;
- Safari-session cookie forwarding to the media relay.

The helper maintains separate sessions for SpankBang and JAV HD Porn.
