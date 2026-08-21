# Persistent Real-Debrid and MetaTube catalogue

Only V2 can import the read-only JSON audit produced by the resumable Sukebei
monthly curator. The imported data lives at
`/tmp/onlyporn-runtime/rd-catalog/rd-catalog-v1.sqlite`, which is a Docker volume
path on OVH rather than container-local storage.

## Playback rules

- Only rows proved `COMPLETE` and `downloaded` are advertised as verified RD
  candidates.
- A verified replacement hash is returned before the hash carried by the live
  Sukebei result.
- The live Sukebei hash remains as a fallback when it differs.
- Pending, missing, and terminal audit rows never become cached streams.
- Later monthly imports preserve older verified alternatives while marking the
  latest downloaded hash as preferred.

No RD API token, unrestricted URL, or account credential is stored in this
database. AIOStreams continues to perform the actual Real-Debrid resolution.

## Poster rules

The poster warmer requests exact JAV codes through MetaTube's supported HTTP
API. That warms MetaTube's own persistent `metatube.db`; Only V2 separately
stores the validated code-to-poster association in `rd-catalog-v1.sqlite`.
Positive matches are reused for every later Sukebei result with the same code.
Confirmed misses are checkpointed so a resumed run does not repeat them unless
`--retry-missing` is supplied.

## Commands inside the container

```sh
node scripts/import-rd-catalog-report.js /import/final-audit.json
node scripts/inspect-rd-catalog.js --minimum-codes 2160 --minimum-complete 2140 --minimum-modified 53
node scripts/warm-rd-metatube-posters.js --all --concurrency 3 --timeout-ms 90000
node scripts/inspect-rd-catalog.js --minimum-poster-decisions 2140 --maximum-poster-errors 0
```

Production sets both `ONLYPORN_RD_CATALOG_ENABLED=true` and
`ONLYPORN_RD_CATALOG_REQUIRED=true`. The readiness gate then refuses a candidate
whose RD catalogue is missing or not a genuine SQLite file.
