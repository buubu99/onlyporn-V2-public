# Deploy OnlyPorn v2.5.1

The repository must currently be version `2.5.0` with a clean Git status.

Before committing:

```bash
npm install --no-package-lock --no-audit --no-fund
npm run test:hotfix251
EXPECTED_VERSION=2.5.1 npm run validate:release
```

After Render reports Live, verify:

```bash
curl -fsS https://onlyporn-v2-public-k143.onrender.com/manifest.json
curl -fsS https://onlyporn-v2-public-k143.onrender.com/catalog/movie/javhdporn.json
```

Expected runtime evidence:

- `OnlyPorn@2.5.1`
- manifest `version: 2.5.1`
- `catalogs: 8`
- `provider: javhdporn`
- `JAVHDPorn Safari request succeeded`
- non-empty `metas`
