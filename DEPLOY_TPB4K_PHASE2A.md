# Deploy TPB4K Phase 2A

Phase 2A is deployed only to `feature/tpb4k-v2.7.0`.

Required base:

- Feature commit: `0a3df7b`
- Production main: `771dba7` / `2.6.4`
- Candidate version: `2.7.0-alpha.10`

The guarded deployment script verifies the base commit, preserves `main`, runs focused Phase 1 and Phase 2A tests, runs the complete retained release suite, rechecks both live JAVHDPorn regression titles, scans for secrets, commits, and pushes only the feature branch.

Do not include API keys in the ZIP, Git history, shell script, test fixtures, logs, or documentation. Set rotated keys as environment variables only when running optional live metadata checks or configuring a future staging service.
