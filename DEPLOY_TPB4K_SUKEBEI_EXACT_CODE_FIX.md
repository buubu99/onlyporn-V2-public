# Deploy alpha.14 R3 Sukebei reference-path correction

Use the R3 ZIP and R3 resume script only. The deployment script validates:

1. the all-category Sukebei RSS contract (`c=0_0`);
2. StashDB `searchScene(term:, limit:)` usage;
3. four-page RSS overscan and deduplication;
4. exact normalized JAV-code verification;
5. safe native detail-page artwork fallback;
6. no generic Sukebei cards;
7. the retained OnlyFans hybrid, global content filter, complete release suite,
   native/Hentai pagination, JAVHDPorn playback, GitHub push guards and Render
   post-deployment smoke.

The script starts from GitHub `2.7.0-alpha.13`. Nothing is pushed if source,
tests, credentials, GitHub state or deployment verification fails.
