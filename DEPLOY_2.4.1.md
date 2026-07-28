# Deploy OnlyPorn 2.4.1 over 2.4.0

The repository must currently be clean and report version `2.4.0`.

Recommended backup branch:

```text
backup-v2.4.0-before-hotfix-2.4.1
```

After copying this release into the repository, run:

```bash
npm install --no-package-lock --no-audit --no-fund
EXPECTED_VERSION=2.4.1 npm run validate:release
git diff --check
git add -A
git commit -m "Hotfix Eporner and XVideos playback relay"
git push origin main
```

Render should automatically deploy. Confirm startup contains:

```text
OnlyPorn@2.4.1
OnlyPorn manifest loaded
catalogs: 7
```

Then perform fresh playback attempts rather than selecting a stream cached before deployment:

1. Eporner: verify the player no longer receives `static.eporner.com/na.mp4`.
2. XVideos: verify the first media-relay request returns `application/vnd.apple.mpegurl` and that subsequent `/media/` segment requests appear.
3. SpankBang: verify the catalog and playback remain operational.

No new Render environment variable is required. The relay learns the public addon URL from the incoming Render request and also supports `ADDON_BASE_URL`, `PUBLIC_URL`, or `RENDER_EXTERNAL_URL` when present.
