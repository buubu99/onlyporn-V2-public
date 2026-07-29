# OnlyPorn Hardening Phase 1 — v2.6.4

## Scope

Phase 1 repairs the audited HLS fail-open behavior. Before this release, a playlist child that could not be validated or protected by the OnlyPorn relay could fall back to its resolved raw upstream URL. That bypassed the provider host policy, discarded the relay's browser context, and could expose signed media URLs directly to clients.

No provider parser, catalog route, provider host allowlist, stream ordering policy, decoding layer, or Phase 0 session architecture was changed.

## Repair

- Every non-comment HLS child URI must resolve to a valid URL and pass the provider-scoped HTTPS host policy.
- Every `URI="..."` attribute must pass the same validation and protected-relay registration.
- Invalid, non-HTTPS, unapproved, or otherwise unrelayable child URLs now raise a dedicated `HLS_CHILD_REJECTED` error.
- Playlist rewriting no longer returns a raw resolved URL from any error path.
- The HTTP relay converts the dedicated rewrite failure into a controlled HTTP 502 response with `X-OnlyPorn-Relay-Error: HLS_CHILD_REJECTED`.
- The 502 response contains no rejected child URL, signed query string, cookie, Referer, or Origin value.

## Preserved behavior

- Hardening Phase 0 remains active: eight-hour playback sessions and stateless signed child tokens use one cache entry per top-level stream.
- The v2.6.2 JAVHDPorn `vdcdn.xyz` repair remains active.
- JAVHDPorn custom `#EXT-X-TOKEN` lines are preserved unchanged.
- Raw `.webp` MPEG-TS and PNG-wrapped MPEG-TS normalization remain unchanged.
- Pornhub signed child query parameters remain protected inside relay URLs.
- Existing provider-specific browser headers remain attached to the parent playback session.

## Deliberate limitations

This phase does not persist playback sessions across Render restarts, add request-wide deadlines, add provider concurrency budgets, or alter unsupported-method handling. Those remain separate audited hardening items.

## Acceptance tests

- Approved relative and absolute playlist children rewrite to protected relay URLs.
- Unapproved bare child URLs fail closed.
- Unapproved `URI="..."` attributes fail closed.
- Non-HTTPS children fail closed.
- HTTP handling returns a controlled 502 and never returns the raw rejected URL.
- JAVHDPorn custom token lines and `vdcdn.xyz` segment handling remain intact.
- Phase 0 one-session behavior remains intact.
- The complete retained release suite passes.
