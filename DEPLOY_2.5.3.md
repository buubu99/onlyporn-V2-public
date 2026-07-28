# Deploy OnlyPorn v2.5.3

The repository must currently be version `2.5.2` with a clean Git status.

## Local gate

```bash
npm install --no-package-lock --no-audit --no-fund
npm run test:hotfix253
npm run test:phase4
npm run test:phase5
EXPECTED_VERSION=2.5.3 npm run validate:release
```

## Required live Render gate

After the service reports `OnlyPorn@2.5.3`:

1. Request `/catalog/movie/spankbang.json` and require a non-empty `metas` array.
2. Open one SpankBang item and require at least one stream.
3. Request `/catalog/movie/javhdporn.json` and require a non-empty `metas` array.
4. Open one JAV HD Porn item and require at least one OnlyPorn `/media/` stream URL.
5. Confirm logs show a decoded JWPlayer source and a PNG-wrapped MPEG-TS segment returned as `video/mp2t`.

Do not mark the release successful from fixture tests alone.
