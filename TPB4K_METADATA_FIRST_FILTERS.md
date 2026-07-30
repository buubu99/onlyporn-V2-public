# TPB4K metadata-first studio catalogs and global explicit-label filter

Version: `2.7.0-alpha.13`

## Defects confirmed by alpha.12 production logs

Alpha.12 populated each studio row from a TPB torrent search and then tried to
reverse-match up to 40 torrent filenames against TPDB and StashDB. Production
logs showed 127–164 metadata requests for several catalogs, repeated StashDB
request failures, thousands of title-overlap rejections, and rows such as
DigitalPlayground 3/40, DorcelClub 4/40, NewSensations 2/40 and XVideosRED 0/40
real posters. The purple cards were honest fallbacks, but they proved that the
catalog identity was still torrent-first rather than metadata-first.

## Metadata-first studio architecture

All 19 `tpb4k.studio.*.top` catalogs now use `source: studio-metadata`.

1. Resolve the exact selected studio or site through TPDB and StashDB.
2. Query recent scenes by the provider's studio/site identity.
3. Normalize titles, release dates, performers, tags and artwork.
4. Merge provider duplicates by studio plus scene code, or studio/title/date.
5. Apply the global explicit-label filter before pagination.
6. Return only records with a real safe HTTPS scene poster.
7. Preserve `lookupSource: torrent-index` and a bounded `lookupQuery` for the
   later Phase 3 torrent-resolution step.

A studio row no longer contains a generic purple poster. When providers cannot
return a trustworthy scene or real poster, that record is omitted. Therefore a
row can contain fewer than 40 cards after filtering or incomplete provider
coverage, but every returned card is a real metadata scene rather than an
unmatched torrent placeholder.

TPDB and StashDB remain metadata providers only. They cannot redirect playback.
The later torrent lookup is still required to produce a real info hash and
playable source.

## StashDB query correction

Alpha.12 incorrectly used studio text in scene-title/parent-studio matching and
produced repeated GraphQL errors. Alpha.13 resolves exact studio IDs first using
`findStudio` and bounded `queryStudios`, then queries scenes with
`SceneQueryInput.studios`. Scene tags are requested and retained for filtering.
Schema-compatibility fallback remains for older fields.

## Global content filter

The filter is installed at the addon boundary, so it covers:

- home catalog rows and `See All` pagination;
- Stremio search catalog responses;
- metadata responses and posters;
- stream responses, with a best-effort metadata preflight;
- manifest genre options carrying an excluded explicit label.

Default exclusions are explicit labels for male-male/gay or bisexual-male
content, and explicit interracial/black-male/African-American-male/BBC labels.
The filter reads provider tags, genres, categories, labels, keywords and other
explicit classification fields. Strong explicit title/description phrases are
also enabled for sources that do not expose tags.

It does **not** inspect images, identify people, infer race, infer sexual
orientation, or exclude generic labels such as `Bisexual` or `Ebony` alone.

### Render configuration

```env
ONLYPORN_CONTENT_FILTER_ENABLED=true
ONLYPORN_FILTER_GAY=true
ONLYPORN_FILTER_INTERRACIAL=true
ONLYPORN_FILTER_UNKNOWN=false
ONLYPORN_FILTER_STRONG_TEXT=true
ONLYPORN_FILTER_EXCLUDED_TAGS=
TPB4K_METADATA_CATALOG_MAX_PAGES=3
TPB4K_METADATA_CATALOG_CONCURRENCY=4
ONLYPORN_FILTER_OVERSCAN_FACTOR=3
```

`ONLYPORN_FILTER_EXCLUDED_TAGS` accepts additional comma-separated exact tag
labels. `ONLYPORN_FILTER_UNKNOWN=true` is optional strict mode and can remove
items that explicitly report unknown classification; it is disabled by default
because many older providers do not supply tags.

## Identity and safety invariants

- Metadata source IDs are provider-scoped (`tpdb:<id>` or `stashdb:<id>`).
- Provider artwork or tags never become assumed playback.
- Opening a scene after a process restart rehydrates the provider record and
  restores the same torrent lookup provenance.
- API keys remain in headers/environment variables only.
- Logs contain counts and rejection reasons, not keys, authorization headers or
  secret-bearing URLs.
- JAVHDPorn decoding, vdcdn handling, Phase 0 sessions and Phase 1 fail-closed
  HLS rewriting are unchanged.

## Validation

Required gates include:

```bash
npm run test:content-filter
npm run test:tpb4k-studio-metadata
npm run test:tpb4k-phase1
npm run test:tpb4k-phase2a
npm run test:tpb4k-phase2b
npm run test:tpb4k-phase2c
npm run test:tpb4k-torrent-index
npm run test:tpb4k-poster-enrichment
TPB4K_ENABLED=true npm run smoke:tpb4k-catalog
TPB4K_ENABLED=true npm run smoke:tpb4k-metadata-first
EXPECTED_VERSION=2.7.0-alpha.13 npm run validate:release
npm run smoke:jav262
```

The deployment script executes these and the retained Hentai/native/live Render
checks before pushing production `main`.
