# OnlyPorn Phase 5 — v2.5.0

Phase 5 adds JAV HD Porn as a seventh provider and eighth catalog while preserving the six working provider integrations from v2.4.2.

## JAV HD Porn integration

- Catalog cards, posters, titles, duration snippets, same-origin URL validation, and duplicate removal.
- Search using the site's WordPress search endpoint.
- Deterministic pagination and category routes for censored, uncensored, amateur, subtitle, FC2, Tokyo Hot, and most-viewed sections.
- JSON-LD metadata with title, description, poster/background, runtime, release year, actors, genres, and provider links.
- The site's versioned encrypted player bootstrap protocol is implemented without evaluating the obfuscated browser script.
- Player API responses and reserve sources are decrypted, then inspected recursively for direct MP4 or HLS media.
- Known advertisement MP4s, preview media, and the `black.html` unavailable-player fallback are rejected.
- Approved JAV HD Porn/PornFHD media can use the existing protected Render relay with cookies, Referer, Origin, User-Agent, Range support, and HLS child-resource rewriting.

## Security

- Only HTTPS provider pages on approved JAV HD Porn hosts are accepted.
- Player candidates still pass the central public-address/DNS checks.
- Relay access remains tokenized, temporary, and restricted to approved media-domain suffixes.
- No HAR file, cookies, browser identifiers, or captured credentials are included in the release.

## Validation

`npm run validate:release` checks the prior regression suites plus Phase 5 tests for the captured player decoder vector, catalog parsing, JSON-LD metadata, POST transport, ad filtering, relay allowlists, manifest wiring, search, categories, and pagination.
