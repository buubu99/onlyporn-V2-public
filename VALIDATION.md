# Validation report

Validated on 2026-07-26:

- Every JavaScript file passed `node --check`.
- `package.json` parsed successfully as JSON.
- Static playback tests passed for:
  - xHamster variant URL resolution and proxy headers.
  - SpankBang proxy headers and custom catalog ID resolution.
  - XVideos and XNXX relative HLS URL resolution.
  - Shared relative and root-relative HLS URL resolution.
- No `.env` file or embedded API key/password/token was found in the repository.

Live requests to the third-party provider websites were not executed in the validation environment. Final verification must be performed after deploying the fork on Render and testing through AIOStreams/Stremio.


## 2.0.2 validation

- `node --check provider/xhamster.js`
- Offline parser test: multiline `window.initials` metadata and HLS source extraction.
- Offline transform test: relative HLS variant resolves against the master playlist and retains proxy headers.
- Live provider access still requires deployment validation because third-party provider sites are not reachable from the build sandbox.
