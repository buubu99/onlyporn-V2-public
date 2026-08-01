# OnlyPorn 2.7.0-alpha.23

- Serializes metadata catalogue construction across concurrent AIOStreams consumers.
- Retries transient metadata-provider failures and never leaves established catalogues empty when playable torrent identities exist.
- Restores Sukebei title-card fallback for both Top and RSS.
- Preserves every catalogue-bound hash at stream time regardless of later seeder drift.
- Replaces repeated generic weak-catalogue artwork with title-specific portrait cards and attaches real metadata artwork when creator/title/date evidence is sufficient.
- Adds live poster uniqueness, external-artwork, catalogue reliability, Sukebei, Hentai and multi-hash acceptance gates.
