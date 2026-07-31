# OnlyPorn 2.7.0-alpha.17

This candidate contains two deliberately independent implementations.

## Track A — the 19 professional studio catalogues

- TPDB/StashDB metadata and posters remain the visible catalogue identity.
- Knaben seeded and recent windows plus the retained approved torrent fallbacks provide torrent identities.
- Metadata and torrent records are matched before a card is exposed.
- Every displayed card must use a version-2 OnlyPorn ID containing a validated 40-character infoHash.
- Unmatched metadata scenes are omitted instead of becoming dead cards.
- Clicking a displayed card returns its already-bound infoHash without repeating a title search.
- AIOStreams may then use its configured Real-Debrid service or retain the standard P2P result. OnlyPorn does not claim Phase 4 Real-Debrid ownership in this release.

## Track B — HentaiMama

Hentai is not passed through the studio/torrent matcher.

- Hentai All, New, and Top are Stremio `series` catalogues.
- Stable series IDs use `hmm-{slug}`.
- Metadata reads every `/episodes/{slug}` link and emits a full `videos` list.
- Exact episode IDs use `hmm-{slug}:1:{episode}`.
- Stream resolution fetches only the selected episode, runs the HentaiMama DooPlay AJAX player flow, checks direct iframe fallbacks, and retains every validated direct MP4/HLS source.
- HentaiMama streams do not use Real-Debrid or studio torrent binding.
- The resolver never emits an invented or null file size. It records a size only when the upstream media response supplies one.

## Acceptance

`scripts/tpb4k-alpha17-acceptance.js` performs two separate gates:

1. It opens every visible card in all 19 studio catalogues and requires the exact bound infoHash to be returned.
2. It verifies all three Hentai catalogues as series, checks episode metadata, and resolves the first and final episodes of the selected series to direct HentaiMama URLs.

Set `TPB4K_HENTAI_SERIES_TEST_LIMIT=0` for an exhaustive Hentai series pass.

## AIOStreams note

The exported AIOStreams configuration showed the OnlyPorn custom addon with result formatting enabled and an unguarded `stream.size::sbytes10` expression. Alpha.17 tries to obtain direct media sizes honestly, but AIOStreams should still guard optional sizes or enable result/format passthrough for OnlyPorn if you want the native `HentaiMama E{episode}` labels preserved. No AIOStreams credentials are stored in this package.

A local, credential-preserving helper is included at `tools/patch-aiostreams-config-alpha17.js`. It writes a separate mode-0600 JSON file, enables OnlyPorn result/format passthrough to mirror the comparison TPB4K preset, and makes the optional size formatter null-safe. It never prints credential values.

## R2 preflight correction

The HentaiMama catalog parser preserves the existing fail-closed challenge handling while accepting pages that contain a benign CDN challenge-script marker together with genuine `/tvshows/` article evidence. This restores compatibility with the retained Phase 2C fixtures and live HentaiMama catalogue HTML.

## R3 delivery fingerprint

This package must contain `R3_FINGERPRINT.txt` with `ONLYPORN-A17-R3-PHASE2C-FIRST-20260731`.
