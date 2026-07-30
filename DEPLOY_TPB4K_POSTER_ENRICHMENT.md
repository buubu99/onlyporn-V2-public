# Deploy TPB4K full poster matching — alpha.12

Candidate: `2.7.0-alpha.12`

The guarded deployment script must start from GitHub `main` at
`2.7.0-alpha.11`. It creates a remote backup branch, installs the exact
candidate ZIP, runs syntax and focused tests, runs the complete retained
release validation, performs live TPDB/StashDB studio catalog validation,
rechecks JAVHDPorn and native TPB4K smoke paths, commits, pushes `main`, and
then verifies Render.

The deployment aborts before pushing when:

- GitHub `main` does not report `2.7.0-alpha.11`;
- the ZIP checksum does not match;
- the working tree contains unexpected changes;
- any returned studio card is not eligible for enrichment;
- fixed-limit poster skipping is detected;
- poster coverage or identity validation fails;
- a secret-bearing file or entered key is detected in source;
- the manifest exceeds the SDK limit;
- any retained release test fails.

Use rotated TPDB and StashDB keys. The script accepts them through hidden
Terminal input and never writes their values to the repository.
