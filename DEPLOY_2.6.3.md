# Deploy OnlyPorn 2.6.3

OnlyPorn 2.6.3 restores Hardening Phase 0 on top of the production-verified 2.6.2 JAVHDPorn hotfix.

Before commit and push, run:

```bash
npm install
npm run test:phase0
npm run test:hotfix262
EXPECTED_VERSION=2.6.3 npm run validate:release
npm run smoke:jav262
```

The live JAV smoke must pass for both investigated `vdcdn.xyz` titles before deployment. After Render is live, verify those two titles again and perform one long-video seek test.
