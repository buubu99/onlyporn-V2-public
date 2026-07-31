# TPB4K metadata-first poster/playback hotfix

## Root cause

Commit `0e16aac8204e86b582563c22fd2e1a184521bfa6` changed all 19 professional studio catalogue definitions to `source: 'torrent-index'`. That made the visible cards depend on torrent-title enrichment. When TPDB or StashDB enrichment was unavailable or could not match a title, the catalogue returned generic studio artwork instead of the real metadata poster.

## Correct architecture

- The 18 conventional studio rows use `source: 'studio-metadata'`.
- OnlyFans uses `source: 'platform-hybrid'`.
- All 19 rows retain `lookupSource: 'torrent-index'`.
- The card ID therefore preserves the metadata identity and real poster.
- The Phase 3 stream handler uses `lookupSource` to resolve the selected metadata card to approved torrent results and valid info hashes.

The hotfix does not remove or roll back Phase 3. It restores the separation between catalogue presentation and torrent playback resolution.

## Files applied

- `catalog/tpb4k.js`: restores metadata-first source definitions.
- `provider/tpb4k-torrent-index.test.js`: restores the three Phase 3 metadata-first regression cases from the pre-regression parent commit.
- `provider/tpb4k-metadata-first-playback-regression.test.js`: permanently rejects a return to torrent-first studio cards.

## Deployment safety

The matching shell script:

1. Requires GitHub `main` to be the known regressed alpha.15 commit before modifying it.
2. Creates and pushes a backup branch.
3. Applies only the catalogue/test correction while preserving the current Phase 3 implementation.
4. Runs syntax, retained TPB4K tests, release validation, metadata-poster smoke tests, and manifest-size validation.
5. Pushes the exact tested commit to a candidate branch before updating `main`.
6. Waits for Render and verifies both real metadata posters and playable torrent streams from the same cards.

## R2 packaging correction

The test-restoration helper now normalizes the modified test file to exactly one newline at EOF. This prevents `git diff --check` from stopping after all functional and live gates have passed.
