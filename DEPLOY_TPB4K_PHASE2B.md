# Deploy TPB4K Phase 2B alpha.4

Run the guarded deployment script from Mac Terminal. It verifies the Phase 2A base commit, preserves production main, runs all focused and retained tests, reruns the JAVHDPorn live smoke, scans for secrets, commits, and pushes only `feature/tpb4k-v2.7.0`.

After the feature push, create or update a separate Render preview/staging service for the feature branch and run `npm run smoke:tpb4k-render` with `TPB4K_RENDER_BASE_URL` set to its HTTPS origin.
