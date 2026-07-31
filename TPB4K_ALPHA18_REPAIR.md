# OnlyPorn TPB4K 2.7.0-alpha.18

This candidate is a regression repair on top of the tested alpha.17 line.

## Preserved without redesign

- HentaiMama **All** and **New** keep the existing fast catalogue path. The live acceptance script samples both to prove they still return episode metadata and direct streams.
- Existing TPDB/StashDB poster identities remain the visible studio cards.
- The eight original OnlyPorn providers are not changed.
- PornRips remains unchanged.

## Hentai Top only

- Rejects taxonomy/category rows such as `3D` that were incorrectly transformed into `hmm-3d` series IDs.
- Preflights Top entries against a real series page and requires at least one exact episode before exposing the card.
- Preserves the exact upstream `/tvshows/` or `/hentai-series/` path.
- Accepts benign challenge-script markers only when page-specific series/episode evidence exists.
- Follows a small number of HTTPS redirects while revalidating every destination against the existing HentaiMama/player/media host allowlists.

## Nineteen studio catalogues

- Expands the catalogue-time torrent identity pool from 100 to 300.
- Searches approved aliases for studio brands, including Digital Playground and XVideos RED spellings, through Knaben and the existing Pirate Bay mirror fallback.
- Removes date-only and performer/date-only bindings. A visible card requires exact scene-code/title evidence or strong title evidence with studio support.
- The post-deploy gate decodes every visible version-2 card and requires the returned stream hash to equal the hash embedded in that card.

## Sukebei

- Keeps the metadata/poster pipeline when it succeeds.
- When metadata services temporarily fail, retains valid RSS torrent identities and uses the existing honest Sukebei-branded poster asset.
- Never invents scene artwork, a hash, or a debrid-ready claim.
- Reapplies the global explicit-label filter before any fallback card is exposed.

## Manifest, filtering and diagnostics

- Declares `hmm-` and `onlyporn:` ownership on OnlyPorn meta/stream resources so AIOStreams can route OnlyPorn Hentai requests correctly.
- Combines metadata-stage and provider-stage filter counters into one truthful log summary; filtering behavior itself is not weakened.
- Suppresses cross-studio diagnostic labels caused by concurrent mutable `lastDiagnostics` values.

## Deliberately not claimed here

- YesPorn playback remains its separate Phase 5 source-resolver task.
- Stripchat remains the Phase 7 task.
- Real-Debrid-native handling inside OnlyPorn remains Phase 4; studio cards expose exact torrent hashes for AIOStreams RD/P2P handling.

## Alpha.18 R3 compatibility correction

R2 preserves the strict Hentai Top episode preflight while restoring the existing All/New metadata contract when a detail page has valid metadata but no episode anchors. Episode resolution still requires a real episode list and remains fail closed. The retained Phase 2C version assertion is updated to alpha.18. No TPB4K comparison-addon dependency is introduced.

## R3 retained-release consistency gate

R3 updates every retained test assertion that pins the prior `2.7.0-alpha.17` package version, then audits all `*.test.js` files before the test suite runs. Deployment aborts before the long suite if any stale or mismatched package-version assertion remains.
