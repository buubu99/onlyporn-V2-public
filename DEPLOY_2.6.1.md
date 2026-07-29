# Deploy OnlyPorn v2.6.1 — Hardening Phase 0

1. Back up the live v2.6.0 branch before replacing files.
2. Install the Phase 0 ZIP over the repository while preserving `.git`, `node_modules`, and `.python-venv`.
3. Run dependency installation with Node 20.x.
4. Run:

```bash
npm run test:phase0
EXPECTED_VERSION=2.6.1 npm run validate:release
```

5. Commit and push only after the complete release suite passes.
6. Verify Render starts `OnlyPorn@2.6.1` with 9 catalogs.
7. Test a long Pornhub or JAVHDPorn video, including seeking beyond 45 minutes.
