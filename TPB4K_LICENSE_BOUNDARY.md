# TPB4K License Boundary

OnlyPorn remains MIT-licensed.

## Allowed components

- Existing OnlyPorn source code.
- Original code written for this TPB4K integration.
- Stremio Addon SDK, already used by OnlyPorn under the MIT license.
- MIT-licensed ideas or source only when separately reviewed, attributed, and adapted without bringing incompatible dependencies into the release.

## Reference-only projects

The public `ghostyshell/tpb-adult-stremio-addon` and `ghostyshell/torrent-search-go` repositories are GPL-3.0 projects. Phase 1 does not copy their implementation code. Their public documentation and externally observable Stremio behavior may be used to define requirements and interoperability tests.

The public `mralanbourne/Yomi` repository is MIT-licensed. Phase 1 does not copy Yomi source. It is retained as a possible later engineering reference for Sukebei/P2P behavior after a file-by-file review and attribution pass.

## Prohibited

- Copying GPL implementation files into OnlyPorn.
- Embedding TPDB, StashDB, Real-Debrid, AIOStreams proxy, or other credentials.
- Encoding secrets in manifest URLs, catalog IDs, metadata IDs, fixtures, logs, or documentation.
- Returning source HTML/detail pages as playable URLs.
