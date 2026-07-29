# Deploy OnlyPorn v2.6.4

1. Begin from GitHub `main` at the production-verified v2.6.3 commit.
2. Create and push a backup branch before replacing files.
3. Install the v2.6.4 release and dependencies.
4. Run `npm run test:hardening1`.
5. Run `npm run test:phase0` and `npm run test:hotfix262`.
6. Run `EXPECTED_VERSION=2.6.4 npm run validate:release`.
7. Run `npm run smoke:jav262` before commit and push.
8. Commit and push only after every check passes.
9. Confirm Render reports v2.6.4, then test the two production-proven JAVHDPorn titles and at least one Pornhub HLS stream.
