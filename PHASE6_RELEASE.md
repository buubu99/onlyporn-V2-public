# OnlyPorn Phase 6 — v2.6.0

Phase 6 adds Pornhub as the eighth provider and ninth catalog while preserving the stable v2.5.5 SpankBang and JAV HD Porn behavior.

## Pornhub integration

- Public catalog, search, genre-as-search, and deterministic `page` pagination.
- Same-origin `viewkey` validation and opaque OnlyPorn resource IDs.
- Landscape catalog cards with duplicate removal, title extraction, and lazy-poster normalization.
- Metadata from canonical/Open Graph/JSON-LD values.
- Fresh video-page retrieval for each stream request so temporary CDN signatures are not reused from stale HTML.
- Full `mediaDefinitions` parsing, including all signed HLS resolutions exposed by the page.
- Optional `/video/get_media` expansion for direct MP4 resolutions when the endpoint returns a non-empty result.
- Every unique playable HLS and MP4 resolution is returned; streams are not collapsed to one link.
- Playback is routed through the existing protected OnlyPorn media relay with Pornhub Origin, Referer, User-Agent, HLS child rewriting, Range support, and exact signed-query preservation.

## Live research incorporated

Mac and Render reconnaissance established the following production behavior:

- `/video` and public `view_video.php?viewkey=...` pages return HTTP 200 with Chrome impersonation.
- `mediaDefinitions` exposed 1080p, 720p, 480p, and 240p signed HLS masters in tested pages.
- `/video/get_media` may legitimately return an empty JSON array; HLS remains independently usable.
- Pornhub CDN hosts vary (`ev-h.phncdn.com`, `hv-h.phncdn.com`, and direct MP4 hosts), so the relay approves validated subdomains of `phncdn.com` rather than one hard-coded host.
- Master, variant, and MPEG-TS segment requests require fresh signed URLs and the correct Pornhub Origin and video-page Referer.
- A fresh Render segment returned HTTP 200 `video/MP2T` and began with MPEG-TS sync byte `0x47`.

## Security

- The Chrome helper accepts only HTTPS requests to `pornhub.com` and `www.pornhub.com`.
- It runs in its own persistent process and cookie store; Pornhub state cannot cross into SpankBang or JAV HD Porn.
- Only public-access age-disclaimer cookies are initialized; no account login, premium access, or user credentials are implemented.
- Media relay URLs remain tokenized and temporary.
- Relay host validation accepts only `phncdn.com` or a true subdomain and rejects lookalike domains.

## Validation

Run:

```bash
npm run test:phase6
EXPECTED_VERSION=2.6.0 npm run validate:release
```

Live Render acceptance remains mandatory because temporary signatures and CDN policy are external runtime behavior.
