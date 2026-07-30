# OnlyPorn

A self-hosted Stremio addon fork with Eporner, Porntrex, SpankBang, XVideos, XNXX, xHamster, JAV HD Porn, and Pornhub providers.

## Stable provider baseline: 2.6.4

## Current TPB4K candidate: 2.7.0-alpha.12

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

Version `2.7.0-alpha.13` retains the 28 selected unified-resolution TPB4K
catalogs and the 37-catalog enabled manifest. The 19 professional studio rows
are now metadata-first TPDB/StashDB catalogs with real scene posters; torrent
search remains stored only as Phase 3 lookup provenance. Generic purple cards
are no longer returned in those rows.

Alpha.13 also installs one global explicit-label content filter at the addon
boundary. It filters catalog/search results, metadata, posters and streams using
provided tags/categories and strong explicit text labels. It never analyzes an
image or infers a person's attributes. The default configuration blocks
explicit male-male/gay or bisexual-male labels and explicit
interracial/black-male/African-American-male/BBC labels.

The feature remains controlled by `TPB4K_ENABLED`. TPB4K playback resolution is
still intentionally empty until Phase 3 produces verified torrent identities.

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
