# OnlyPorn
The Hotfixed Version of the Original Onlyporn Addon authored by Mast3rCh1ef in his Original Repo:(https://github.com/Mast3rCh1ef/onlyporn)

This build contains four major websites as its provider for streams directly from their domains...which are...
Eporner, Porntrex, Spankbang, Xvideos, XNXX and Xhamster.

Supports Playback upto 4k depending on the video...

Has stable personal logging for the user and has no analytics to protect privacy...

Currently self-deployment ready...

## Testing
You need `yarn`
[testing.md#testing-in-stremio-app](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/testing.md#testing-in-stremio-app)

https://github.com/Stremio/stremio-addon-sdk

## 2.3.0 verification commands

```bash
npm run validate:release
npm run smoke:live -- https://onlyporn-v2-public-k143.onrender.com 2.3.0
```

The release validator runs syntax, packaging, secret-file, whitespace, manifest, and all regression tests before deployment. The live smoke test checks the Render manifest, catalog output, metadata completeness, duplicate IDs, and page-2 repetition. SpankBang remains in the manifest, but Render requests are currently blocked upstream by Cloudflare in both tested Render regions.
