# TPB4K Sukebei root-cause fix R5

## What actually failed

Alpha.14 R4 did not prove that the deployed catalogue was healthy. Its local
gate returned three records in 41,222 ms, then the deployed verifier aborted at
30 seconds. A direct deployed request reproduced HTTP 200 after about 35
seconds; a following cached request returned `{"metas":[]}`.

Four defects combined to create that result:

1. The 24-second timer started only after RSS collection. RSS time was outside
   the advertised budget.
2. The official rolling RSS feed was requested four times. The deployment log
   read 300 rows but normalized only 75, proving the requests were duplicates.
3. Detail-page fallback jobs entered one serialized HTTP queue after their
   deadline check. Already-admitted jobs continued beyond the deadline.
4. Live detail pages publish covers as plain HTTPS URLs inside markdown text.
   The parser accepted only `<img>` tags, so it discarded valid native covers.

StashDB indexing lag then exposed all four defects. When today's new codes had
not been indexed yet, the metadata stage returned no matches, the broken native
fallback returned no covers, and fail-closed filtering produced an empty
catalogue.

## What R5 changes

- Starts one end-to-end deadline before the first RSS request.
- Uses one page for the official rolling RSS endpoint and stops duplicate
  pagination on custom mirrors.
- Keeps network timeout signals active through response-body reads.
- Passes the remaining deadline into StashDB, TPDB, RSS, and detail requests.
- Reserves a bounded final window for native artwork.
- Prioritizes detail pages with real scene codes.
- Uses two detail requests at a time: enough parallelism to avoid the old
  serial overrun without triggering Sukebei's burst protection.
- Accepts safe plaintext JPEG, PNG, WebP, and AVIF cover URLs in the torrent
  description.
- Makes deployed smoke-test timeout errors identify the exact endpoint.

No generic purple poster is reintroduced, no playable URL is invented, and no
API credential is stored in source.

## Verification

- `npm run validate:release`: passed.
- JavaScript syntax validation: 108 files passed.
- Repository validation: 229 files inspected; no forbidden secret files or
  trailing whitespace.
- Release tests: 204 passed, 0 failed.
- Added regressions cover duplicate RSS pages, plaintext cover URLs, bounded
  response-body timeouts, and non-serialized-but-rate-limited detail fetching.
- Final packaged-source live test with both TPDB and StashDB disabled returned
  a native HTTPS-poster record in 12,587 ms instead of an empty catalogue. It
  fetched one official RSS window and exceeded the end-to-end deadline by 0 ms.

## Safe deployment

Apply the accompanying patch only to commit
`6dc5f45 Fix TPB4K Sukebei staged metadata batch alpha.14`.

```bash
git switch main
git pull --ff-only
git apply --check ONLYPORN-ALPHA14-SUKEBEI-ROOT-CAUSE-FIX-R5.patch
git apply ONLYPORN-ALPHA14-SUKEBEI-ROOT-CAUSE-FIX-R5.patch
npm run validate:release
git diff --check
```

Review the diff, commit it, and push only after those checks pass. After Render
publishes, run:

```bash
TPB4K_RENDER_BASE_URL="https://onlyporn-v2-public-k143.onrender.com" \
  npm run smoke:tpb4k-render
```

If a deployed verification fails, keep the failed commit for evidence and use
`git revert <commit>` rather than rewriting `main`.
