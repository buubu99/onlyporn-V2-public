'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  mediaUrls,
  nestedPlayerUrls,
} = require('./tpb4k/hentaimama-series');
const {
  mergeTorrentFirstStudio,
  metadataPosterMatch,
  shouldUseTorrentFirst,
} = require('./tpb4k/torrent-first-studio');
const {
  createSukebeiArtworkStore,
  STORE_VERSION,
} = require('./tpb4k/sukebei-artwork-store');

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';

test('Alpha.22 preserves the stable studio binder and limits torrent-first recovery to four isolated weak catalogues', () => {
  const provider = fs.readFileSync(require.resolve('./tpb4k'), 'utf8');
  assert.match(provider, /bindStudioPlayback/);
  assert.match(provider, /TORRENT_FIRST_STUDIOS = new Set\(\['onlyfans', 'digitalplayground', 'xvideosred', 'sexmex'\]\)/);
  assert.match(provider, /catalogResponseCache/);
  assert.match(provider, /catalogInFlight/);
  assert.equal(shouldUseTorrentFirst({ studio: 'OnlyFans' }, 0), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'DigitalPlayground' }, 0), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'XVideos RED' }, 0), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'SexMex' }, 0), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'Vixen' }, 0), false);
  assert.equal(shouldUseTorrentFirst({ studio: 'Cum4K' }, 0), false);
});

test('OnlyFans fallback uses matching metadata artwork and retains every distinct torrent hash', () => {
  const poster = 'https://images.example/alice-real.jpg';
  const metadata = [{
    source: 'studio-metadata',
    sourceId: 'tpdb:alice',
    title: 'Alice Wonderland Private Shower',
    performer: 'Alice Wonderland',
    performers: ['Alice Wonderland'],
    poster,
    background: poster,
    studio: 'OnlyFans',
  }];
  const torrents = [
    {
      source: 'torrent-index', sourceId: `knaben:${H1}`, infoHash: H1,
      title: 'Alice Wonderland Private Shower OnlyFans 2160p',
      filename: 'Alice Wonderland Private Shower OnlyFans 2160p',
      resolution: '2160p', seeders: 20, indexer: 'knaben', studio: 'OnlyFans',
    },
    {
      source: 'torrent-index', sourceId: `hiddenbay:${H2}`, infoHash: H2,
      title: 'Alice Wonderland Private Shower OnlyFans 1080p',
      filename: 'Alice Wonderland Private Shower OnlyFans 1080p',
      resolution: '1080p', seeders: 40, indexer: 'hiddenbay', studio: 'OnlyFans',
    },
  ];
  assert.equal(metadataPosterMatch(torrents[0], { studio: 'OnlyFans' }, metadata)?.poster, poster);
  const result = mergeTorrentFirstStudio({
    catalog: { id: 'tpb4k.studio.onlyfans.top', studio: 'OnlyFans' },
    existingItems: [],
    metadataItems: metadata,
    torrentItems: torrents,
    limit: 40,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].poster, poster);
  assert.deepEqual(new Set(result.items[0].playbackCandidates.map(item => item.infoHash)), new Set([H1, H2]));
});

test('Sukebei cache version is invalidated and ImageTwist can never be stored or rehydrated', () => {
  assert.equal(STORE_VERSION, 3);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'op-a22-sukebei-'));
  const filePath = path.join(directory, 'cache.json');
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    records: [{ sourceId: 'bad-old', poster: 'https://imagetwist.com/error.jpg', savedAt: Date.now() }],
  }));
  const store = createSukebeiArtworkStore({ filePath, enabled: true, env: {} });
  assert.equal(store.get('bad-old'), null);
  assert.equal(store.set({ sourceId: 'bad-new', poster: 'https://imagetwist.com/error.jpg', lookupSource: 'tpdb' }), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Hentai parser reads quoted, escaped, protocol-relative and extensionless nested media', () => {
  const html = String.raw`
    <iframe data-src='//player.example/embed/one'></iframe>
    <script>
      window.player = \`https:\/\/nested.example\/player\/two\`;
      window.file = 'https://cdn.example/media/stream?id=42';
    </script>`;
  assert.deepEqual(nestedPlayerUrls(html, 'https://hentaimama.io/hentai/test-episode-1/').sort(), [
    'https://nested.example/player/two',
    'https://player.example/embed/one',
  ]);
  assert.deepEqual(mediaUrls(html, 'https://hentaimama.io/hentai/test-episode-1/'), [
    'https://cdn.example/media/stream?id=42',
  ]);
});

test('Sukebei response boundary rejects ImageTwist and RSS uses OnlyPorn internal posters', () => {
  const provider = fs.readFileSync(require.resolve('./tpb4k'), 'utf8');
  assert.match(provider, /imagetwist\.com/);
  assert.match(provider, /tpb4k\.sukebei\.rss/);
  assert.match(provider, /sukebeiRssPosterUrl/);
  assert.match(provider, /tpb4k\.sukebei\.top/);
});
