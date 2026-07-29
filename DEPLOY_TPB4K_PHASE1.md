# Deploy TPB4K Phase 1 to a Feature Branch

This candidate is not intended for `main` or the production Render service.

The deployment script creates or updates:

`feature/tpb4k-v2.7.0`

It verifies that GitHub `main` is still OnlyPorn 2.6.4, installs the candidate, runs the focused TPB4K tests and the complete retained release suite, then pushes only the feature branch.

The default environment keeps `TPB4K_ENABLED=false`, so the existing production manifest remains unchanged even when the source is tested locally.
