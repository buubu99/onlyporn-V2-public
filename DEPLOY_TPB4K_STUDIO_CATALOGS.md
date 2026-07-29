# Deploy TPB4K alpha.10 studio-catalog correction

Base feature commit: `b7635c1` (`2.7.0-alpha.7`)

The deployment script preserves any uncommitted alpha.8/alpha.9/alpha.10 attempt in a Git safety stash, restores the clean alpha.7 feature base, installs alpha.10, and runs the mandatory catalog gate before any long regression smoke.

The mandatory gate requires:

- TPDB Recent through REST Bearer authentication.
- All 19 selected studio catalogs through TPB-compatible HTML search.
- Category `507`, sort `7`, unique opaque IDs, valid fixed-mirror detail URLs, positive seeder data, no explicit lower-resolution leakage, and no magnet/info-hash exposure.
- Zero meta calls and zero stream calls.

Only after that gate passes does the script run the full retained release suite, JAVHDPorn live smoke, Hentai six-route smoke, and native-source smoke. It commits and pushes only `feature/tpb4k-v2.7.0`. Production `main` and Render remain untouched.
