# OnlyPorn 2.7.0-alpha.24 recovery

- Removes the duplicate Sukebei RSS catalogue; Sukebei Top is the single public row.
- Caps Sukebei Top at eight cards, preferring verified artwork and using honest title-specific cards only when upstream artwork is unavailable.
- Rejects catalogue-level DP/ON/XR/SexMex assets, generated studio cards, and ImageTwist error hosts as scene artwork.
- Keeps weak-studio torrent releases in the polished row only when real per-release artwork is bound.
- Improves creator, date, scene-code, and title evidence used to bind weak-studio torrents to TPDB/StashDB metadata.
- Runs targeted multi-index failover augmentation for SexMex so AIOStreams can try another hash when Real-Debrid reports the first torrent as queued.
- Does not cache a zero-card metadata response produced by a transient provider failure.
- Gives Hentai Top a fresh `ophtop-` series identity so clients cannot reuse an older cached empty series shell; its episodes still use the proven All/New HentaiMama playback resolver.
- Leaves the eight established HTML/direct providers unchanged.
