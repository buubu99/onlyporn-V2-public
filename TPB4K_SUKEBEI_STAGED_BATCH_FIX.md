# TPB4K Sukebei staged-batch correction — alpha.14 R4

## Failure demonstrated by the R3 live run

The R3 schema probe found exact StashDB poster matches for `STARS-068` and
`SMRA-003`, but the real catalog returned zero records. The probe and catalog
were not executing the same schedule.

For each torrent, R3 performed a bare-code StashDB search, then often a second
full-title StashDB search, then TPDB fallback before advancing far enough through
the RSS list. The 24-second catalog deadline expired after only the early codes.
The known live matches appeared later in the unique-code sequence and were never
reached by the real catalog.

## R4 architecture

R4 uses three isolated stages:

1. **Complete unique-code stage** — up to 40 unique codes are scanned first.
   Each code gets exactly one request to the primary metadata provider, with
   bounded concurrency and an individual timeout. No title or TPDB fallback can
   run until this scan completes.
2. **Small title stage** — at most four unresolved records receive controlled
   title matching after all selected codes have been scanned.
3. **Native-detail stage** — verified uploader artwork is attempted last.

Exact-code results are stored immediately and cannot be discarded if a later
optional stage reaches the total deadline.

## Shared production path

The live probe and the catalog now call the same `queryExactCodeProvider()`
function. The deployment script also runs the actual `createSukebeiMetadataAdapter`
catalog from the extracted ZIP before it touches the Git working tree. That gate
prints progress every five completed code jobs and requires:

- all selected unique-code jobs completed;
- one exact-code request per completed job;
- at least one exact verified metadata match;
- at least one returned card after the global label filter;
- safe HTTPS artwork only;
- no generic purple fallback.

## Regression coverage

A deterministic test places the only matches at positions 21 and 23 after slow
early misses. It verifies that all 30 selected codes are scanned, those late
matches are returned, and TPDB/title fallback does not run before the code stage.
