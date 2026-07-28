# OnlyPorn v2.4.2 — XNXX Playback Completion

This hotfix completes the final reported provider recovery.

## Fixed

- Repairs XNXX catalog page URLs containing the literal `THUMBNUM` frame template.
- Tries frame `0` first, matching current valid XNXX page routes, with conservative fallback forms.
- Accepts absolute same-origin XNXX catalog links while rejecting unapproved hosts.
- Routes XNXX direct MP4 streams through the internal OnlyPorn media relay.
- Routes XNXX HLS playlists, child playlists, keys, maps, and media segments through the same relay.
- Converts XNXX CDN playlist responses from partial `206 text/plain` into web-ready `200 application/vnd.apple.mpegurl` responses.
- Preserves XNXX Referer, Origin, User-Agent, and signed playlist URLs on the Render egress path.

## Confirmed log causes

1. Some catalog entries generated URLs such as `/THUMBNUM/`, which returned HTTP 404 and caused an invalid empty metadata object.
2. Valid entries returned three streams to AIOStreams, but AIOStreams then proxied the raw XNXX CDN playlist, which repeatedly returned `206 text/plain`.

## Validation

Run:

```bash
npm run test:hotfix242
EXPECTED_VERSION=2.4.2 npm run validate:release
```
