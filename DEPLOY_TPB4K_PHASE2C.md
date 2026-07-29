# Deploy TPB4K Phase 2C alpha.7

Base feature commit: `57f17fc`

Alpha.7 preserves the working PornRips and YesPorn native acquisition and hardens HentaiMama live-page acceptance and article extraction after the alpha.6 smoke returned zero Hentai metadata. The guarded deployment script preserves any uncommitted alpha.5/alpha.6 attempt in a Git safety stash, installs alpha.7 on `feature/tpb4k-v2.7.0`, runs every retained test, performs the two-title JAVHDPorn smoke, and requires all five native catalog routes to pass before commit or push.

Production `main` remains v2.6.4 and is never pushed by this phase.
