# Deploy OnlyPorn 2.4.0 on the existing Render service

## Replace the repository contents

Extract the ZIP, enter its root folder, and copy these files over the existing repository. Then run:

```bash
git status
git add .
git commit -m "OnlyPorn 2.4.0 provider playback recovery"
git push origin main
```

## Render settings

Keep the existing Node runtime and start command:

```text
Start Command: npm start
```

The existing `yarn install` or `npm install` build step is sufficient because `postinstall` now installs `curl_cffi` into `.python-venv` automatically. Do not add the temporary `/tmp/spankbang-curlcffi` commands to Render.

During the next build, confirm the logs include both the Node dependency installation and:

```text
curl_cffi==0.15.0
Successfully installed ... curl_cffi-0.15.0
```

After the service is Live, confirm:

```text
OnlyPorn manifest loaded
version: 2.4.0
catalogs: 7
```

## Validation

From a terminal in the deployed repository:

```bash
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.4.0
```

Then test one video from each affected provider in this order:

1. SpankBang catalog, metadata, and playback.
2. Eporner playback; the anti-hotlink placeholder must not appear.
3. XVideos playback from a newly opened catalog card; Render must not log a URL containing `THUMBNUM`.
4. Porntrex playback; Render must report at least one extracted stream rather than `no playable streams found`.

Keep `LOG_LEVEL=debug` only while testing. Restore `LOG_LEVEL=info` afterward.
