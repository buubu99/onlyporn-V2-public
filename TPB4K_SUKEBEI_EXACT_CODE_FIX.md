# TPB4K Sukebei reference-path correction — alpha.14 R3

## Failure corrected

The earlier alpha.14 candidates used the wrong live contract in two places:

1. They forced Sukebei RSS category `c=2_2`.
2. They queried StashDB through `queryScenes(input.code)`.

The working TPB4K backend instead browses Sukebei with the all-category RSS
contract (`page=rss&c=0_0&f=0`) and searches StashDB with
`searchScene(term:, limit:)`. Candidates are accepted only after the returned
scene code matches the torrent product code after normalization.

## R3 implementation

- Uses `c=0_0`, preserving local top-by-seeders ranking.
- Reads four RSS pages by default and deduplicates torrent identities.
- Extracts JAV product codes while rejecting codecs, resolutions, generic
  release words and false `PPV` fragments.
- Calls StashDB `searchScene` first with the bare code and then the complete
  torrent title when needed.
- Compares code variants while ignoring numeric zero-padding.
- Retains TPDB as a secondary metadata source.
- Uses genuine RSS or Sukebei detail-page images when metadata has no poster.
- Rejects site logos, icons, avatars and malformed/non-HTTPS image URLs.
- Applies the global explicit-label filter after enrichment.
- Omits unresolved records rather than displaying generic purple cards.

## Release-gate correction

The schema probe verifies that live `searchScene` requests succeed. A volatile
RSS snapshot with zero StashDB matches is reported as metadata coverage rather
than falsely classified as a code failure. The full Sukebei smoke still requires
at least one genuine poster from metadata, RSS, or a detail page and rejects all
generic fallback cards.
