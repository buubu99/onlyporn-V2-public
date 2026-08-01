'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { nestedPlayerUrls, mediaUrls } = require('./tpb4k/hentaimama-series');
const { mergeTorrentFirstStudio, shouldUseTorrentFirst } = require('./tpb4k/torrent-first-studio');
const { blockedHost, imageDimensions, validateImageResponse } = require('./tpb4k/sukebei-image-validator');

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';
function torrent(hash, title, poster, resolution = '1080p', seeders = 10, sourceId = '') {
  return {
    source: 'torrent-index', sourceId: sourceId || `knaben:${hash}`, infoHash: hash,
    title, filename: title, poster, background: poster, resolution, seeders,
    indexer: 'knaben', studio: 'OnlyFans', lookupSource: 'torrent-index-poster-enrichment',
  };
}

test('weak platform and studio catalogues activate torrent-first recovery thresholds', () => {
  assert.equal(shouldUseTorrentFirst({ studio: 'OnlyFans' }, 3), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'OnlyFans' }, 12), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'OnlyFans' }, 40), false);
  assert.equal(shouldUseTorrentFirst({ studio: 'DigitalPlayground' }, 0), true);
  assert.equal(shouldUseTorrentFirst({ studio: 'XVideos RED' }, 7), true);
});

test('torrent-first recovery creates playable cards and retains every release hash', () => {
  const poster = 'https://images.example/alice.jpg';
  const result = mergeTorrentFirstStudio({
    catalog: { id: 'tpb4k.studio.onlyfans.top', studio: 'OnlyFans' },
    existingItems: [],
    torrentItems: [
      torrent(H1, 'Alice Wonderland Private Shower OnlyFans 2160p', poster, '2160p', 20),
      torrent(H2, 'Alice Wonderland Private Shower OnlyFans 1080p', poster, '1080p', 50),
      torrent(H3, 'Beth Jones Morning Workout OnlyFans 1080p', 'https://images.example/beth.jpg', '1080p', 12),
    ],
    limit: 40,
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(new Set(result.items[0].playbackCandidates.map(item => item.infoHash)), new Set([H1, H2]));
  assert.equal(result.items[0].source, 'torrent-index');
  assert.equal(result.stats.multiCandidateScenes, 1);
});

test('Hentai second-layer parser follows escaped and lazy nested players and extensionless media', () => {
  const html = String.raw`<iframe data-src="https:\/\/player.example\/embed\/one"></iframe>
    <script>window.next={player:"https://nested.example/player/two",file:"https://cdn.example/media/stream?id=42"}</script>`;
  assert.deepEqual(nestedPlayerUrls(html, 'https://hentaimama.io/episodes/test/').sort(), [
    'https://nested.example/player/two', 'https://player.example/embed/one',
  ]);
  assert.deepEqual(mediaUrls(html), [
    'https://cdn.example/media/stream?id=42',
  ]);
});

test('Sukebei rejects ImageTwist hotlink-error hosts before accepting artwork', () => {
  assert.equal(blockedHost('https://imagetwist.com/images/error.jpg'), true);
  assert.equal(blockedHost('https://cdn.example/poster.jpg'), false);
});

test('Sukebei byte validator accepts a real-size PNG and rejects tiny or error responses', async () => {
  const png = Buffer.alloc(9000);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.writeUInt32BE(600, 16); png.writeUInt32BE(900, 20);
  assert.deepEqual(imageDimensions(png), { format: 'png', width: 600, height: 900 });
  const response = { headers: { get: name => name === 'content-length' ? String(png.length) : 'image/png' }, arrayBuffer: async () => png };
  const valid = await validateImageResponse(response, { url: 'https://cdn.example/poster.png' });
  assert.equal(valid.valid, true);
  const blocked = await validateImageResponse(response, { url: 'https://imagetwist.com/poster.png' });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.reason, 'blocked-hotlink-host');
});
