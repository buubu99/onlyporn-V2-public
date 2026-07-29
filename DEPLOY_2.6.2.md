# Deploy OnlyPorn 2.6.2

1. Start from a clean GitHub `main` running OnlyPorn 2.6.0.
2. Create and push a backup branch before replacing files.
3. Verify the supplied ZIP SHA-256 and ZIP integrity.
4. Copy the release into the repository while preserving `.git`, `node_modules`, `.python-venv`, and local environment files.
5. Run `npm install` under Node 20.x.
6. Run `npm run test:hotfix262`.
7. Run `EXPECTED_VERSION=2.6.2 npm run validate:release`.
8. Run `npm run smoke:jav262` before commit and push.
9. Commit only after every offline and live check passes.
10. After Render deploys, verify manifest version 2.6.2, nine catalogs, the two vdcdn titles, one existing streamhls/TikTok JAV title, and one Pornhub title.

Do not combine this deployment with Hardening Phase 0. Restore Phase 0 only after 2.6.2 is live and regression-tested.
