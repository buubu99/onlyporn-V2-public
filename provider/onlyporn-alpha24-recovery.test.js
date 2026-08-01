'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { catalogDefinitions } = require('../catalog/tpb4k');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { fillCatalogWithMetadata } = require('./tpb4k/catalog-metadata-fill');
const {
  externalPosterValid,
  mergeTorrentFirstStudio,
  metadataPosterMatch,
} = require('./tpb4k/torrent-first-studio');
const { augmentStudioPlayback, prioritizeFailoverCandidates } = require('./tpb4k/studio-targeted-recovery');
const { Tpb4kProvider } = require('./tpb4k');

const ROOT = path.resolve(__dirname, '..');
const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GENERIC_ONLYFANS = 'https://raw.githubusercontent.com/buubu99/onlyporn-V2-public/main/assets/tpb4k/studios/onlyfans.png';

function torrent(hash, title) {
  return {
    source: 'torrent-index',
    sourceId: `knaben:${hash}`,
    infoHash: hash,
    title,
    filename: `${title}.mkv`,
    poster: GENERIC_ONLYFANS,
    studio: 'OnlyFans',
    lookupSource: 'torrent-index-poster-enrichment',
    seeders: 10,
  };
}

test('manifest exposes one Sukebei catalogue and removes the duplicate RSS row', () => {
  const sukebei = catalogDefinitions.filter(item => item.id.startsWith('tpb4k.sukebei.'));
  assert.deepEqual(sukebei.map(item => item.id), ['tpb4k.sukebei.top']);
  assert.equal(catalogDefinitions.length, 28);
});

test('generic studio assets, generated title cards, and ImageTwist are never real catalogue artwork', () => {
  assert.equal(externalPosterValid({ poster: GENERIC_ONLYFANS }), false);
  assert.equal(externalPosterValid({ poster: 'https://onlyporn.example/onlyporn/poster/studio-release/a.svg' }), false);
  assert.equal(externalPosterValid({ poster: 'https://imagetwist.com/error.jpg' }), false);
  assert.equal(externalPosterValid({ poster: 'https://cdn.theporndb.net/scene/ruth.jpg' }), true);
});

test('affected catalogs keep playable cards first and fill the row with real metadata cards', () => {
  const playable = [{ sourceId: 'tpdb:one', title: 'Scene One', studio: 'XVideosRED' }];
  const metadata = [
    { sourceId: 'tpdb:one', title: 'Scene One', studio: 'XVideosRED', poster: 'https://images.example/one.jpg' },
    { sourceId: 'tpdb:two', title: 'Scene Two', studio: 'XVideosRED', poster: 'https://images.example/two.jpg' },
  ];
  const filled = fillCatalogWithMetadata(
    { id: 'tpb4k.studio.xvideosred.top' },
    playable,
    metadata,
    40
  );
  assert.deepEqual(filled.map(item => item.sourceId), ['tpdb:one', 'tpdb:two']);
  assert.equal(filled[0], playable[0]);
});

test('healthy studio catalogs are not changed by the selective metadata fill policy', () => {
  const playable = [{ sourceId: 'tpdb:vixen-one', title: 'Vixen One', studio: 'Vixen' }];
  const metadata = [{ sourceId: 'tpdb:vixen-two', title: 'Vixen Two', studio: 'Vixen' }];
  const filled = fillCatalogWithMetadata(
    { id: 'tpb4k.studio.vixen.top' },
    playable,
    metadata,
    40
  );
  assert.deepEqual(filled, playable);
});

test('XVideosRED remains visible without pre-bound torrents and resolves playback when opened', async () => {
  const scenes = [1, 2, 3].map(index => ({
    source: 'studio-metadata',
    sourceId: `tpdb:xvr-${index}`,
    title: `XVideos RED Scene ${index}`,
    studio: 'XVideosRED',
    poster: `https://images.example/xvr-${index}.jpg`,
    background: `https://images.example/xvr-${index}.jpg`,
    releaseDate: `2026-07-${20 + index}`,
  }));
  clearAdapters();
  registerAdapter({
    id: 'studio-metadata', configured: true,
    async catalog() { return scenes; },
    async meta({ sourceId }) { return scenes.find(item => item.sourceId === sourceId) || null; },
    async resolve() { return []; },
  });
  registerAdapter({
    id: 'torrent-index', configured: true,
    async catalog() { return []; },
    async catalogTorrents() { return []; },
    async meta() { return null; },
    async resolve({ item }) {
      return [{
        source: 'knaben', sourceId: `knaben:${item.sourceId}`, infoHash: HASH_A,
        title: item.title, filename: `${item.title}.mp4`, seeders: 12,
      }];
    },
  });
  const provider = new Tpb4kProvider({
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '3',
      TPB4K_MINIMUM_SEEDERS: '3',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
    installBuiltIns: false,
  });
  const catalog = await provider.handleCatalog({
    type: 'movie', id: 'tpb4k.studio.xvideosred.top', extra: {},
  });
  assert.equal(catalog.metas.length, 3);
  const unboundMeta = catalog.metas.find(meta => {
    const decoded = decodeTpb4kId(meta.id);
    return !Array.isArray(decoded.torrents) || decoded.torrents.length === 0;
  });
  assert.ok(unboundMeta, 'metadata fill should preserve a card without catalog-time torrent binding');
  const stream = await provider.handleStream({ type: 'movie', id: unboundMeta.id });
  assert.equal(stream.streams.length, 1);
  assert.equal(stream.streams[0].infoHash, HASH_A);
});

test('weak-studio recovery keeps a torrent only when it can bind real per-release artwork', () => {
  const metadata = [{
    source: 'studio-metadata',
    sourceId: 'tpdb:ruth-morning',
    title: 'Ruth Morning Routine',
    creator: 'Ruth',
    performers: ['Ruth'],
    releaseDate: '2025-06-17',
    poster: 'https://cdn.theporndb.net/scene/ruth-morning.jpg',
    metadataProvider: 'tpdb',
  }];
  const matching = torrent(HASH_A, 'OnlyFans 2025 06 17 Ruth Morning Routine 2160p');
  const unmatched = torrent(HASH_B, 'OnlyFans 2024 01 01 Unknown Creator Random Pack 1080p');
  assert.equal(metadataPosterMatch(matching, { studio: 'OnlyFans' }, metadata)?.sourceId, 'tpdb:ruth-morning');

  const result = mergeTorrentFirstStudio({
    catalog: { id: 'tpb4k.studio.onlyfans.top', studio: 'OnlyFans' },
    metadataItems: metadata,
    torrentItems: [matching, unmatched],
    requireRealPoster: true,
    limit: 40,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].poster, metadata[0].poster);
  assert.equal(result.items[0].playbackCandidates[0].infoHash, HASH_A);
  assert.equal(result.stats.rejectedGenericPoster, 1);
});

test('SexMex special recovery adds a distinct failover hash when the first RD torrent may be queued', async () => {
  const primary = {
    ...torrent(HASH_A, 'SexMex Happy Hour For Three 720p'),
    sourceId: 'knaben:primary',
    studio: 'SexMex',
    poster: 'https://cdn.theporndb.net/scene/happy-hour.jpg',
    playbackCandidates: [{ infoHash: HASH_A, filename: 'SexMex Happy Hour For Three 720p.mp4', resolution: '720p', indexer: 'knaben', seeders: 20 }],
  };
  const calls = [];
  const result = await augmentStudioPlayback({
    catalog: { id: 'tpb4k.studio.sexmex.top', studio: 'SexMex' },
    items: [primary],
    config: { minimumSeeders: 3 },
    resolverAdapter: {
      async resolve(args) {
        calls.push(args);
        return [
          { infoHash: HASH_A, filename: primary.filename, indexer: 'knaben', seeders: 20 },
          { infoHash: HASH_B, filename: 'SexMex Happy Hour For Three 1080p.mp4', resolution: '1080p', indexer: '1337x', seeders: 8 },
        ];
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sourceId, /^catalog-failover:/);
  assert.deepEqual(result.items[0].playbackCandidates.map(item => item.infoHash), [HASH_A, HASH_B]);
  assert.equal(result.stats.multiCandidateScenes, 1);
});

test('SexMex puts existing multi-hash scenes before one-hash queued scenes', () => {
  const single = { sourceId: 'single', infoHash: HASH_A, seeders: 100, playbackCandidates: [{ infoHash: HASH_A }] };
  const multi = { sourceId: 'multi', infoHash: HASH_B, seeders: 5, playbackCandidates: [{ infoHash: HASH_B }, { infoHash: HASH_A }] };
  assert.deepEqual(prioritizeFailoverCandidates([single, multi]).map(item => item.sourceId), ['multi', 'single']);
});

test('runtime filters all known fake studio posters and avoids transient empty metadata cache poisoning', () => {
  const provider = fs.readFileSync(path.join(ROOT, 'provider/tpb4k.js'), 'utf8');
  const metadata = fs.readFileSync(path.join(ROOT, 'provider/tpb4k/studio-metadata.js'), 'utf8');
  const sukebei = fs.readFileSync(path.join(ROOT, 'provider/tpb4k/sukebei-metadata.js'), 'utf8');
  const hentai = fs.readFileSync(path.join(ROOT, 'provider/tpb4k/hentaimama-series.js'), 'utf8');
  const addon = fs.readFileSync(path.join(ROOT, 'addon.js'), 'utf8');
  assert.match(provider, /function realStudioPoster/);
  assert.match(provider, /assets\\\/tpb4k\\\/studios/);
  assert.match(provider, /onlyporn\\\/poster\\\/studio-release/);
  assert.match(provider, /requireRealPoster: true/);
  assert.match(provider, /weakStudioKey === 'sexmex'/);
  assert.match(provider, /augmentStudioPlayback/);
  assert.match(provider, /prioritizeFailoverCandidates/);
  assert.match(provider, /RELEASE_VERSION/);
  assert.match(provider, /CATALOG_CACHE_REVISION/);
  assert.match(metadata, /if \(window\.length \|\| !providerFailed\) cache\.set/);
  assert.match(sukebei, /catalog: catalogDefinition/);
  assert.match(sukebei, /catalogDefinition\?\.mode === 'top'/);
  assert.match(sukebei, /Math\.min\(safeSkip \+ safeLimit, 8\)/);
  assert.match(hentai, /TOP_SERIES_PREFIX = 'ophtop-'/);
  assert.match(addon, /'ophtop-'/);
});
