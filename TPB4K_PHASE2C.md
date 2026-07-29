# TPB4K Phase 2C — Native catalog acquisition

Version: 2.7.0-alpha.7

This release replaces the temporary external-feed placeholders with clean-room native metadata acquisition:

- PornRips recent pages from the exact `pornrips.to` origin.
- YesPorn latest-update pages from the exact `yesporn.vip` origin.
- HentaiMama All, New, and Top series pages from the exact `hentaimama.io` origin.
- Opaque path-derived source IDs; raw URLs are not used as Stremio IDs.
- Exact-origin HTTPS checks, no redirects, bounded HTML responses, and challenge-page rejection.
- Native detail-page metadata enrichment.
- Deterministic page mapping from Stremio `skip` values.
- No magnets, info hashes, direct media, or playable streams in Phase 2C.

The three former catalog URL environment variables are intentionally removed. Only Sukebei retains an optional RSS mirror override.

Before this feature can be tested on Render, `npm run smoke:tpb4k-native` must return non-empty first and second pages for all five native catalog routes and confirm empty streams.

## Alpha.6 correction

Live selector validation established exact YesPorn `/video/<id>/<slug>/` cards and HentaiMama `/tvshows/<slug>/` article records. Alpha.6 uses article/card-level extraction and conservative per-source request scheduling.

## Alpha.7 hardening

The live alpha.6 smoke proved PornRips and YesPorn but returned zero Hentai records. Alpha.7 makes page rejection evidence-aware and groups duplicate Hentai poster/title anchors by exact `/tvshows/<slug>/` path before extracting the enclosing article.
