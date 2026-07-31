'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { catalogDefinitions } = require('../catalog/tpb4k');
const { decodeTpb4kId, encodeTpb4kId } = require('./tpb4k/id-codec');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');
const { bindStudioPlayback } = require('./tpb4k/studio-playback-binding');

const HASHES = '0123456789abcdef0123456789abcdef01234567';

afterEach(() => {
  clearAdapters();
});

function metadataFor(definition, suffix = 'A') {
  return {
    sourceId: `tpdb:${definition.studio.toLowerCase()}-${suffix.toLowerCase()}`,
    title: `${definition.studio} Playable Scene ${suffix}`,
    studio: definition.studio,
    releaseDate: '2026-07-30',
    poster: `https://images.example/${definition.studio.toLowerCase()}-${suffix}.jpg`,
    lookupSource: 'torrent-index',
  };
}

function torrentFor(definition, suffix = 'A', infoHash = HASHES) {
  return {
    sourceId: `knaben:${definition.studio.toLowerCase()}-${suffix.toLowerCase()}`,
    title: `${definition.studio} 2026 07 30 Playable Scene ${suffix} 2160p`,
    studio: definition.studio,
    infoHash,
    filename: `${definition.studio}.Playable.Scene.${suffix}.2160p.mkv`,
    resolution: '4K',
    indexer: 'knaben',
    seeders: 25,
    size: 4_000_000_000,
  };
}

test('all 19 professional catalog definitions can emit metadata poster cards with version-2 bound torrents', () => {
  const studios = catalogDefinitions.filter(item => item.id.startsWith('tpb4k.studio.'));
  assert.equal(studios.length, 19);

  for (const definition of studios) {
    assert.ok(['studio-metadata', 'platform-hybrid'].includes(definition.source));
    assert.equal(definition.lookupSource, 'torrent-index');

    const metadata = metadataFor(definition);
    const binding = bindStudioPlayback({
      catalog: definition,
      metadataItems: [metadata],
      torrentItems: [torrentFor(definition)],
      limit: 40,
    });
    assert.equal(binding.items.length, 1, definition.id);
    assert.equal(binding.items[0].poster, metadata.poster, definition.id);

    const id = encodeTpb4kId({
      source: definition.source,
      sourceId: binding.items[0].sourceId,
      catalogId: definition.id,
      torrent: binding.items[0],
    });
    const decoded = decodeTpb4kId(id);
    assert.equal(decoded.version, 2, definition.id);
    assert.equal(decoded.source, definition.source, definition.id);
    assert.equal(decoded.torrent.infoHash, HASHES, definition.id);
    assert.equal(decoded.torrent.indexer, 'knaben', definition.id);
  }
});

test('unmatched metadata is omitted so visible studio cards cannot be dead version-1 cards', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.vixen.top');
  const result = bindStudioPlayback({
    catalog: definition,
    metadataItems: [metadataFor(definition, 'NoMatch')],
    torrentItems: [{
      ...torrentFor(definition, 'Different', 'fedcba9876543210fedcba9876543210fedcba98'),
      title: 'Vixen 2024 01 01 Unrelated Torrent Name 2160p',
    }],
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.stats.unmatchedMetadata, 1);
});



test('release date alone never binds an unrelated studio torrent', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.dorcelclub.top');
  const result = bindStudioPlayback({
    catalog: definition,
    metadataItems: [{ sourceId: 'tpdb:dorcel-date-only', title: 'Completely Different Editorial Title', studio: 'DorcelClub', releaseDate: '2026-07-21', poster: 'https://images.example/dorcel.jpg' }],
    torrentItems: [{ sourceId: 'knaben:date-only', title: 'DorcelClub 2026 07 21 Unrelated Release 2160p', studio: 'DorcelClub', infoHash: HASHES, seeders: 9, indexer: 'knaben' }],
  });
  assert.equal(result.items.length, 0);
});

test('OnlyFans hybrid torrent fallback rows cannot replace metadata poster identities', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.onlyfans.top');
  const result = bindStudioPlayback({
    catalog: definition,
    metadataItems: [{
      ...metadataFor(definition, 'Fallback'),
      sourceId: 'knaben:not-metadata',
    }],
    torrentItems: [torrentFor(definition, 'Fallback')],
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.stats.metadataRecords, 0);
});

test('provider wiring binds catalog identities before preview encoding and torrent adapter exposes identity-only catalog loading', () => {
  const providerSource = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  const torrentSource = fs.readFileSync(path.join(__dirname, 'tpb4k', 'torrent-index.js'), 'utf8');
  const knabenSource = fs.readFileSync(path.join(__dirname, 'tpb4k', 'knaben.js'), 'utf8');
  assert.match(providerSource, /bindStudioPlayback/);
  assert.match(providerSource, /catalogTorrents/);
  assert.match(providerSource, /studioPlaybackBinding/);
  assert.match(providerSource, /item\.infoHash[\s\S]*torrent/);
  assert.match(torrentSource, /async catalogTorrents\(/);
  assert.match(torrentSource, /enrichPosters:\s*false/);
  assert.match(torrentSource, /playbackBindingPool[\s\S]*'seeders', 'date'/);
  assert.match(knabenSource, /order_by:\s*orderBy/);
});


test('catalog-time join emits a metadata card with a bound hash and stream resolution never performs a second title search', async () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.vixen.top');
  const metadata = metadataFor(definition, 'Bound');
  const torrent = torrentFor(definition, 'Bound');
  let resolverCalls = 0;

  registerAdapter({
    id: 'studio-metadata',
    async catalog() {
      return [metadata];
    },
    async meta({ sourceId }) {
      return sourceId === metadata.sourceId ? metadata : null;
    },
    async resolve() {
      throw new Error('metadata adapter must never resolve playback');
    },
  });
  registerAdapter({
    id: 'torrent-index',
    async catalog() {
      return [torrent];
    },
    async catalogTorrents() {
      return [torrent];
    },
    async meta() {
      return null;
    },
    async resolve() {
      resolverCalls += 1;
      throw new Error('bound version-2 cards must not perform click-time title searches');
    },
  });

  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '40',
      TPB4K_MINIMUM_SEEDERS: '3',
      ONLYPORN_CONTENT_FILTER_ENABLED: 'false',
    },
  });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: definition.id,
    extra: { skip: 0 },
  });
  assert.equal(catalog.metas.length, 1);
  assert.equal(catalog.metas[0].poster, metadata.poster);
  const decoded = decodeTpb4kId(catalog.metas[0].id);
  assert.equal(decoded.version, 2);
  assert.equal(decoded.source, 'studio-metadata');
  assert.equal(decoded.sourceId, metadata.sourceId);
  assert.equal(decoded.torrent.infoHash, HASHES);

  const stream = await provider.handleStream({
    type: 'movie',
    id: catalog.metas[0].id,
  });
  assert.equal(stream.streams.length, 1);
  assert.equal(stream.streams[0].infoHash, HASHES);
  assert.equal(resolverCalls, 0);
});
