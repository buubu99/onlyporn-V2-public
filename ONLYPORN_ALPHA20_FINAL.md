# OnlyPorn 2.7.0-alpha.20 — immutable handoff completion

Base commit: `ef1a7baa0e7a0cc5425a0ce02a56a2d5d3980717` (2.7.0-alpha.18 R3).

This release package completes the unresolved Alpha.18 handoff without a runtime dependency on any comparison addon.

- Version-3 studio cards retain every distinct high-confidence torrent hash.
- Candidate order uses resolution, seeders, and explicit indexer reliability.
- OnlyFans keeps creator/user/account identity through metadata normalization, search, and matching.
- Targeted recovery tries bounded batches until the minimum card target is reached or its budget is exhausted.
- SexMex keeps multiple standard P2P hashes so a queued debrid candidate cannot remove the alternative.
- Hentai emits only `ophmm-`, accepts legacy IDs internally, extracts direct AJAX media, follows verified iframes, and keeps stage diagnostics.
- Sukebei Top contains verified artwork only; unresolved playable RSS rows are isolated in Sukebei RSS with distinct title posters.
- Last-known-good Sukebei artwork uses a bounded atomic disk store. It cannot renew its age merely by being read back from the cache.
- All retained catalogue-count contracts use the intentional 38 total / 29 internal manifest, still below 8 KiB.
- The deployment runs focused gates, the full retained release suite, a direct OnlyPorn live gate, and automatic rollback.

The artwork store uses `ONLYPORN_PERSISTENT_CACHE_DIR`, `RENDER_DISK_PATH`, or `ONLYPORN_CACHE_DIR` when configured. Otherwise it uses `.onlyporn-cache` in the service working directory. Tests can explicitly disable persistence with `ONLYPORN_DISABLE_PERSISTENT_CACHE=1`.

## Immutable cache-isolation correction

The process-level `ONLYPORN_DISABLE_PERSISTENT_CACHE=1` release-test flag is authoritative even when an adapter supplies a narrower `env` object. This prevents parallel retained tests from sharing `.onlyporn-cache`. Explicit `filePath` stores remain enabled for isolated lifecycle testing.
