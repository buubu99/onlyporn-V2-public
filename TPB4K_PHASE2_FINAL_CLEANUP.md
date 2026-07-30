# TPB4K Phase 2 Final Cleanup — 2.7.0-alpha.14

This release closes the remaining catalog-quality defects before Phase 3 torrent/detail resolution begins.

## Sukebei

The Sukebei catalog no longer fills missing artwork with the generic purple poster.

The adapter now:

- extracts native HTTPS artwork from RSS media/enclosure/description fields when present;
- extracts release codes such as `ADN-721`, `FNS-188`, and `FC2-PPV-1234567`;
- searches TPDB and StashDB by exact code before title matching;
- preserves the original Sukebei source ID and detail URL;
- applies the global explicit-label filter after metadata enrichment;
- omits unresolved records instead of showing a generic poster;
- exposes safe diagnostics for native images, code matches, title matches, filtered records, errors, and unmatched records.

## OnlyFans

OnlyFans is a platform label rather than a reliable TPDB/StashDB studio identity. Its catalog now uses a hybrid adapter:

1. query TPDB/StashDB for records explicitly labelled `OnlyFans` or `Only Fans`;
2. verify that the platform label is present in title, description, tags, or URLs;
3. if metadata coverage is insufficient, fill the remaining window from the retained TPB torrent-index catalog;
4. preserve torrent lookup provenance for Phase 3.

Metadata records always use real provider artwork. Torrent fallback records may use the clean branded OnlyFans poster when no verified scene artwork exists; this is intentional and does not substitute another scene's poster.

## StashDB resilience

Repeated transient StashDB network, timeout, or rate-limit failures now open a five-minute provider circuit. TPDB continues serving catalogs while the circuit is open, avoiding one failed StashDB request for every catalog row on the home screen.

## Phase 3 boundary

This release remains catalog/metadata only. It does not add playable TPB4K streams. Phase 3 can now begin from stable catalog identities, real artwork where verifiable, retained torrent lookup queries, and explicit-label filtering.


## Sukebei request budget

Sukebei enrichment is deliberately bounded so one RSS row cannot consume the
30-second AIOStreams custom-addon timeout:

- `TPB4K_SUKEBEI_ENRICHMENT_DEADLINE_MS` defaults to 24000 ms.
- `TPB4K_SUKEBEI_CODE_LOOKUP_LIMIT` defaults to 40 exact-code lookups.
- `TPB4K_SUKEBEI_TITLE_LOOKUP_LIMIT` defaults to 4 controlled title lookups.
- Native RSS images do not consume a metadata lookup.
- StashDB exact-code matching is attempted first; TPDB is used only after an exact-code miss and its network
  circuit breaker prevents repeated failures from slowing later catalogs.

Records that cannot obtain trustworthy artwork inside this budget are omitted.
They are not replaced with a purple fallback and no unrelated poster is used.


## Corrected Sukebei live implementation

See `TPB4K_SUKEBEI_EXACT_CODE_FIX.md`. R3 follows the working TPB4K reference path: all-category Sukebei RSS (`c=0_0`), StashDB `searchScene(term:)`, exact normalized code verification, multi-page overscan, and safe native detail-page artwork fallback.
