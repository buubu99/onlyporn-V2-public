# OnlyPorn 2.4.0 — provider playback recovery

Version 2.4.0 addresses the four failures captured from the 2.3.0 Render deployment.

## SpankBang

- Replaces the blocked Axios/fetch page transport with a persistent Python `curl_cffi` session.
- Pins `curl_cffi==0.15.0` and uses Safari impersonation, matching the successful test from the live Singapore Render instance.
- Keeps cookies and Cloudflare state across catalog, search, metadata, and video-page requests.
- Restricts the helper to HTTPS requests for `spankbang.com` and `www.spankbang.com` only.
- Installs Python dependencies into `.python-venv` during the normal package `postinstall` lifecycle.

## Eporner

- Marks direct MP4 and HLS streams as protected (`notWebReady: true`).
- Supplies the exact video-page Referer, Eporner Origin, and browser User-Agent through standard Stremio proxy headers.
- Prefers H.264/AVC when multiple codecs exist at the same resolution, avoiding AV1/HEVC/VP9 compatibility failures.

## XVideos

- Repairs malformed catalog links containing `/THUMBNUM/` before metadata requests.
- Retries alternative canonical page forms only when the first candidate returns HTTP 404.
- Marks direct MP4 and HLS streams as protected and supplies Referer, Origin, and User-Agent playback headers.

## Porntrex

- Expands KVS source extraction beyond the old inline `kt_player({...})` shape.
- Reads quoted or unquoted `video_url`, `video_alt_urlN`, and companion quality labels.
- Supports assigned `flashvars`, `player_data`, `playerConfig`, and `video_data` objects.
- Adds HTML `<video>/<source>`, Open Graph, JSON-LD, and bounded media-URL fallbacks.
- Keeps preview/screenshot MP4 assets excluded and retains the original signed URL when a CDN rejects HEAD requests.

## Packaging

The production Python dependency is declared in `requirements.txt`. The package lifecycle runs `scripts/install-python-deps.js`, which creates `.python-venv` with `python3 -m venv` and installs the pinned dependency through that environment's pip.

The temporary `/tmp/spankbang-curlcffi` diagnostic environment is not used by this release.
