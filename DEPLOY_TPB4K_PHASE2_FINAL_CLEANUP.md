# Deploy TPB4K Phase 2 Final Cleanup — 2.7.0-alpha.14

Use the guarded deployment script supplied with the release ZIP.

The script requires GitHub `main` to still be `2.7.0-alpha.13`, creates a backup branch, installs the candidate, runs the complete retained release suite, verifies the 8 KiB manifest limit, executes the live metadata and Sukebei/OnlyFans gates, reruns JAVHDPorn regression smokes, pushes a candidate branch, and only then fast-forwards `main` to trigger Render.

Required Render environment variables remain:

- `TPB4K_ENABLED=true`
- `TPDB_API_KEY=<rotated value>`
- `STASHDB_API_KEY=<rotated value>`

Optional resilience setting:

- `TPB4K_METADATA_PROVIDER_CIRCUIT_TTL_MS=300000`

Do not place API keys in source, ZIP files, shell scripts, logs, catalog IDs, or documentation.


Runtime defaults are included in `.env.example` for the 24-second Sukebei
metadata budget, 40 exact-code lookups, four controlled title lookups, and the
five-minute metadata-provider circuit breaker. The deployment script runs live
Sukebei and OnlyFans gates before pushing `main`.


## Fixed candidate

Use `DEPLOY_TPB4K_SUKEBEI_EXACT_CODE_FIX.md` and the fixed resume script. The corrected `searchScene` schema probe now runs before the full catalog suite.
