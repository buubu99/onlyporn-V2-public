# Deploy TPB4K poster enrichment — alpha.11

Use the supplied guarded Mac Terminal script:

`DEPLOY_ONLYPORN_TPB4K_POSTER_ENRICHMENT_2.7.0_ALPHA11.sh`

The script requires the matching source ZIP in `~/Downloads`, verifies its SHA-256, verifies GitHub `main` is still the expected alpha.10 manifest-hotfix commit, creates and pushes a backup branch, installs the candidate, runs syntax and regression gates, performs live catalog checks with rotated metadata keys, commits the exact tested tree, pushes GitHub `main`, waits for Render, and validates live poster coverage.

Run one command block:

```bash
chmod +x "$HOME/Downloads/DEPLOY_ONLYPORN_TPB4K_POSTER_ENRICHMENT_2.7.0_ALPHA11.sh"
bash "$HOME/Downloads/DEPLOY_ONLYPORN_TPB4K_POSTER_ENRICHMENT_2.7.0_ALPHA11.sh"
```

The script aborts without pushing when:

- `main` is not the expected base commit;
- the working tree is dirty;
- the ZIP checksum or required-file inventory differs;
- generated/private files are staged;
- any deterministic or live gate fails;
- an active secret value is found in the source tree;
- the Render manifest does not publish alpha.11 with 37 total / 28 TPB4K catalogs;
- a live returned TPB4K card lacks a safe HTTPS poster.

Do not enter the previously exposed TPDB or StashDB values. Rotate them first and use only the replacements when the script prompts.
