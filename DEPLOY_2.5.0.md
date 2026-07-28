# Deploy OnlyPorn v2.5.0

1. Preserve the working v2.4.2 commit in a backup branch.
2. Replace the repository contents with this package, excluding `.git`, `node_modules`, and `.python-venv`.
3. Run:

```bash
npm install --no-package-lock --no-audit --no-fund
EXPECTED_VERSION=2.5.0 npm run validate:release
```

4. Commit and push to `main`; Render should deploy automatically.
5. Confirm the Render startup log reports:

```text
OnlyPorn@2.5.0
OnlyPorn manifest loaded
catalogs: 8
```

6. Validate all existing providers first, then JAV HD Porn:

- catalog page 1 and page 2;
- search;
- at least two category selections;
- metadata, poster, runtime, actors, and tags;
- one working direct/HLS video;
- one unavailable video, which should return no stream rather than an ad or fallback page.

Optional live catalog check:

```bash
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.5.0
```

The captured sample `SEO-001` returned the site's explicit unavailable-player fallback during browser investigation. Use a different currently playable item for the first production playback validation.
