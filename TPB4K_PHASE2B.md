# TPB4K Phase 2B — discovery records and Render preview readiness

Version: 2.7.0-alpha.10

Phase 2B adds metadata-only discovery adapters for PornRips, YesPorn, Hentai, and Sukebei. Each adapter is optional, bounded, HTTPS-only, rejects HTML placeholders, produces stable metadata identities, and deliberately returns no streams.

Stripchat remains an explicit Phase 7 gate. No model catalog is emitted until MOUFLON v2 keys and live playback are independently proven.

## Optional discovery environment variables

- `TPB4K_SUKEBEI_RSS_URL` (defaults to the public Sukebei RSS endpoint)

The three catalog URLs must return metadata JSON (`metas`, `items`, `results`, `scenes`, or an array). They must not contain credentials.

## First Render checkpoint

After alpha.4 is pushed, deploy the feature branch to a separate Render preview/staging service. Validate Node 20 build behavior, environment injection, outbound metadata access, 28 catalog routes, pagination, latency, cache behavior, and redacted logs. Production `main` remains unchanged.

No Phase 2B source is allowed to return a playable stream.

## Superseded acquisition boundary

The temporary external JSON-feed inputs were removed in alpha.5. PornRips, YesPorn, and HentaiMama now use clean-room native HTML acquisition with fixed exact origins.
