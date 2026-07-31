# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Stable provider baseline: 2.6.4

## Current TPB4K candidate: 2.7.0-alpha.17

OnlyPorn v2.6.4 adds Hardening Phase 1 on top of the production-verified v2.6.3 relay-session repair and v2.6.2 JAVHDPorn `vdcdn.xyz` hotfix.

HLS playlist rewriting is now fail closed. Every bare child URI and every `URI="..."` attribute must resolve to an approved provider-scoped HTTPS host and must be converted to an authenticated OnlyPorn relay URL. Invalid, unsupported, or unapproved children return a controlled HTTP 502 instead of exposing a raw upstream URL.

Phase 0 remains active with eight-hour top-level playback sessions and stateless signed child tokens. The JAVHDPorn three-layer decoder, custom `#EXT-X-TOKEN` preservation, raw `.webp` MPEG-TS normalization, and PNG-wrapper decoding remain unchanged.

Sessions are still process-local: a Render restart or redeploy invalidates active playback links. Request-wide deadlines and provider concurrency budgets remain later hardening work.

See `HARDENING_PHASE1.md`, `PHASE0_HARDENING.md`, `HOTFIX_2.6.2.md`, and `DEPLOY_2.6.4.md`.

## Runtime

- Node.js 20.x
- Python 3 with `curl_cffi==0.15.0`, installed automatically in a project-local virtual environment by `postinstall`

## Commands

```bash
npm run test:hardening1
npm run test:phase0
npm run test:hotfix262
npm run test:phase6
npm run test:hotfix255
npm run test:phase4
npm run test:phase5
EXPECTED_VERSION=2.6.4 npm run validate:release
npm run smoke:jav262
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.6.4
npm start
```

The release validator checks JavaScript and Python syntax, packaging, secret-bearing files, whitespace, catalog descriptors, and all provider regression tests. Live Render verification remains required because Cloudflare, temporary signatures, and media-CDN behavior are external runtime dependencies.

## TPB4K integration development

Version `2.7.0-alpha.17` retains the 28 selected unified-resolution TPB4K
catalogs and the 37-catalog enabled manifest. The 19 professional studio rows
remain metadata-first TPDB/StashDB catalogs with real scene posters. Phase 3
now resolves those metadata identities through approved TPB/HiddenBay and
1337x torrent sources, while Sukebei RSS identities become honest P2P streams.
Generic purple cards are no longer returned in those rows.

Alpha.13 also installs one global explicit-label content filter at the addon
boundary. It filters catalog/search results, metadata, posters and streams using
provided tags/categories and strong explicit text labels. It never analyzes an
image or infers a person's attributes. The default configuration blocks
explicit male-male/gay or bisexual-male labels and explicit
interracial/black-male/African-American-male/BBC labels.

The feature remains controlled by `TPB4K_ENABLED`. Phase 3 returns only valid
BitTorrent info hashes and never labels an unverified torrent as cached.
PornRips, YesPorn and direct Hentai playback remain intentionally empty until
Phase 5; Stripchat remains gated to Phase 7.

See `TPB4K_METADATA_FIRST_FILTERS.md` and
`DEPLOY_TPB4K_METADATA_FIRST_FILTERS.md`.

## Metadata-first studio catalogs

The 19 `tpb4k.studio.*.top` definitions use `source: studio-metadata` and
`lookupSource: torrent-index`. TPDB is queried by site/studio identity, while
StashDB first resolves exact studio IDs and then uses the schema's studio-ID
criterion. Both providers contribute real posters, tags, performers and dates.
Records without a real poster are omitted rather than replaced by a placeholder.

The TPB/HiddenBay adapter, category `507`, sort `7`, opaque torrent identity and
mirror failover remain available for Phase 3 resolution and regression tests;
they no longer determine which cards are visible in the 19 metadata rows.

## Global explicit-label filter

Default Render variables are documented in `.env.example`. Unknown/unclassified
items remain allowed by default because some legacy providers do not expose
classification tags. Enable `ONLYPORN_FILTER_UNKNOWN=true` only for a strict
fail-closed policy that accepts the resulting loss of uncategorized content.


## Phase 2 final cleanup (alpha.14)

- Sukebei now keeps only cards with verified native or metadata artwork,
  preferring exact scene-code matches and applying the global tag filter after
  enrichment.
- OnlyFans uses an explicit platform-metadata query with an honest torrent
  fallback rather than a nonexistent studio binding.
- Metadata-provider network circuits prevent a failed StashDB route from
  repeatedly delaying otherwise healthy TPDB catalogs.
- Phase 2 is ready for its final live deployment gate before Phase 3 torrent
  detail-page and playable stream resolution begins.

## Phase 3 torrent resolution (alpha.15)

- Resolves TPB/HiddenBay search rows and approved mirror detail pages to valid
  magnets and 40-character hexadecimal info hashes.
- Aggregates 1337x results without ever exposing a detail page as playable.
- Preserves all valid resolutions and merges exact duplicate hashes with
  trackers, seeders, size and provenance.
- Converts Sukebei RSS info hashes into standards-compliant P2P streams.
- Adds AIOStreams-compatible filename, video-size, seeder and source metadata.
- Enforces exact-host redirects, private/lookalike rejection, per-source
  timeouts, a request-wide deadline and indexer error isolation.
- Leaves every existing direct HTML provider implementation unchanged.

## TPB4K all-19 playable binding (alpha.16)

Alpha.16 binds only verified torrent identities to metadata-first studio cards before those cards are exposed. Unmatched metadata records are omitted instead of becoming dead version-1 cards. The poster and metadata identity remain TPDB/StashDB-derived, while the encoded version-2 ID carries the validated infoHash used immediately by the stream handler.

## TPB4K alpha.17

Alpha.17 keeps the 19 studio catalogues on metadata-first, catalogue-bound torrent identities and treats HentaiMama independently as a Stremio series source. Hentai cards use `hmm-` IDs, metadata includes every discovered episode, and stream resolution targets the exact selected episode while retaining every validated direct player URL.
