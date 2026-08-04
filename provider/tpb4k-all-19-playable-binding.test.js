'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { catalogDefinitions } = require('../catalog/tpb4k');
const { BUNDLE_VERSION, decodeTpb4kId, encodeTpb4kId } = require('./tpb4k/id-codec');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');
const { bindStudioPlayback } = require('./tpb4k/studio-playback-binding');

const HASH_A = '0123456789abcdef0123456789abcdef01234567';
const HASH_B = '89abcdef0123456789abcdef0123456789abcdef';
const HASH_C = 'fedcba9876543210fedcba9876543210fedcba98';

afterEach(() => clearAdapters());

function metadataFor(definition, suffix = 'A') {
  const source = definition.source === 'platform-hybrid' ? 'tpdb' : 'tpdb';
  return {
    sourceId: `${source}:${definition.studio.toLowerCase()}-${suffix.toLowerCase()}`,
    title: definition.studio === 'OnlyFans'
      ? `Creator Alice Private Shower Adventure ${suffix}`
      : `${definition.studio} Playable Scene ${suffix}`,
    studio: definition.studio,
    releaseDate: '2026-07-30',
    performers: definition.studio === 'OnlyFans' ? ['Creator Alice'] : ['Performer Alice'],
    poster: `https://images.example/${definition.studio.toLowerCase()}-${suffix}.jpg`,
    lookupSource: 'torrent-index',
  };
}

function torrentFor(definition, suffix, infoHash, resolution = '2160p', seeders = 25) {
  const creator = definition.studio === 'OnlyFans' ? 'Creator Alice ' : '';
  const sceneTitle = definition.studio === 'OnlyFans'
    ? `Private Shower Adventure ${suffix}`
    : `Playable Scene ${suffix}`;
  return {
    sourceId: `knaben:${definition.studio.toLowerCase()}-${suffix.toLowerCase()}-${resolution}`,
    title: `${definition.studio} ${creator}${sceneTitle} 2026 07 30 ${resolution}`,
    studio: definition.studio,
    performers: definition.studio === 'OnlyFans' ? ['Creator Alice'] : ['Performer Alice'],
    releaseDate: '2026-07-30',
    infoHash,
    filename: `${definition.studio}.Playable.Scene.${suffix}.${resolution}.mkv`,
    resolution,
    indexer: 'knaben',
    seeders,
    size: 4_000_000_000,
  };
}

test('all 18 professional catalog definitions can emit version-3 cards with every distinct bound hash', () => {
  const studios = catalogDefinitions.filter(item => item.id.startsWith('tpb4k.studio.'));
  assert.equal(studios.length, 18);

  for (const definition of studios) {
    assert.ok(['studio-metadata', 'platform-hybrid'].includes(definition.source));
    assert.equal(definition.lookupSource, 'torrent-index');
    const metadata = metadataFor(definition);
    const binding = bindStudioPlayback({
      catalog: definition,
      metadataItems: [metadata],
      torrentItems: [
        torrentFor(definition, 'A', HASH_A, '2160p', 20),
        torrentFor(definition, 'A', HASH_B, '1080p', 30),
      ],
      limit: 40,
    });
    assert.equal(binding.items.length, 1, definition.id);
    assert.equal(binding.items[0].poster, metadata.poster, definition.id);
    assert.equal(binding.items[0].playbackCandidates.length, 2, definition.id);

    const id = encodeTpb4kId({
      source: definition.source,
      sourceId: binding.items[0].sourceId,
      catalogId: definition.id,
      torrents: binding.items[0].playbackCandidates,
    });
    const decoded = decodeTpb4kId(id);
    assert.equal(decoded.version, BUNDLE_VERSION, definition.id);
    assert.equal(decoded.source, definition.source, definition.id);
    assert.deepEqual(new Set(decoded.torrents.map(item => item.infoHash)), new Set([HASH_A, HASH_B]), definition.id);
  }
});

test('one hash can own only one poster while one poster can retain several hashes', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.vixen.top');
  const result = bindStudioPlayback({
    catalog: definition,
    metadataItems: [metadataFor(definition, 'A'), metadataFor(definition, 'B')],
    torrentItems: [
      torrentFor(definition, 'A', HASH_A, '2160p', 25),
      torrentFor(definition, 'A', HASH_B, '1080p', 20),
      { ...torrentFor(definition, 'B', HASH_A, '720p', 10), title: 'Vixen Playable Scene B 2026 07 30 720p' },
      torrentFor(definition, 'B', HASH_C, '720p', 15),
    ],
  });
  assert.equal(result.items.length, 2);
  const hashes = result.items.flatMap(item => item.playbackCandidates.map(candidate => candidate.infoHash));
  assert.equal(hashes.filter(hash => hash === HASH_A).length, 1);
  assert.ok(result.items.some(item => item.playbackCandidates.length > 1));
  assert.equal(result.stats.oneHashOneScene, true);
});

test('unmatched metadata and date-only lookalikes are omitted', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.dorcelclub.top');
  const result = bindStudioPlayback({
    catalog: definition,
    metadataItems: [{
      sourceId: 'tpdb:dorcel-date-only',
      title: 'Completely Different Editorial Title',
      studio: 'DorcelClub',
      releaseDate: '2026-07-21',
      poster: 'https://images.example/dorcel.jpg',
    }],
    torrentItems: [{
      sourceId: 'knaben:date-only',
      title: 'DorcelClub 2026 07 21 Unrelated Release 2160p',
      studio: 'DorcelClub',
      infoHash: HASH_A,
      seeders: 9,
      indexer: 'knaben',
    }],
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.stats.unmatchedMetadata, 1);
  assert.equal(result.stats.rejectedDateOnly, true);
});

test('OnlyFans requires metadata identity plus creator/title evidence', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.onlyfans.top');
  const invalidIdentity = bindStudioPlayback({
    catalog: definition,
    metadataItems: [{ ...metadataFor(definition), sourceId: 'knaben:not-metadata' }],
    torrentItems: [torrentFor(definition, 'A', HASH_A)],
  });
  assert.equal(invalidIdentity.items.length, 0);

  const platformWordOnly = bindStudioPlayback({
    catalog: definition,
    metadataItems: [metadataFor(definition)],
    torrentItems: [{
      ...torrentFor(definition, 'Different', HASH_A),
      title: 'OnlyFans random unrelated compilation 2026',
      performers: [],
    }],
  });
  assert.equal(platformWordOnly.items.length, 0);
});

test('provider wiring uses catalog-time recovery and returns every bundled hash without click-time search', async () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.vixen.top');
  const metadata = metadataFor(definition, 'Bound');
  const torrents = [
    torrentFor(definition, 'Bound', HASH_A, '2160p', 30),
    torrentFor(definition, 'Bound', HASH_B, '1080p', 20),
  ];
  let resolverCalls = 0;

  registerAdapter({
    id: 'studio-metadata',
    async catalog() { return [metadata]; },
    async meta({ sourceId }) { return sourceId === metadata.sourceId ? metadata : null; },
    async resolve() { throw new Error('metadata adapter must never resolve playback'); },
  });
  registerAdapter({
    id: 'torrent-index',
    async catalog() { return torrents; },
    async catalogTorrents() { return torrents; },
    async meta() { return null; },
    async resolve() { resolverCalls += 1; return []; },
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
  const catalog = await provider.handleCatalog({ type: 'movie', id: definition.id, extra: { skip: 0 } });
  assert.equal(catalog.metas.length, 1);
  const decoded = decodeTpb4kId(catalog.metas[0].id);
  assert.equal(decoded.version, BUNDLE_VERSION);
  assert.deepEqual(new Set(decoded.torrents.map(item => item.infoHash)), new Set([HASH_A, HASH_B]));
  const catalogResolverCalls = resolverCalls;

  const stream = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });
  assert.deepEqual(new Set(stream.streams.map(item => item.infoHash)), new Set([HASH_A, HASH_B]));
  assert.equal(resolverCalls, catalogResolverCalls, 'opening a bound card performed a new title search');
});

test('source wiring contains multi-candidate, targeted recovery, and no comparison-addon runtime reference', () => {
  const providerSource = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  const recoverySource = fs.readFileSync(path.join(__dirname, 'tpb4k', 'studio-targeted-recovery.js'), 'utf8');
  const codecSource = fs.readFileSync(path.join(__dirname, 'tpb4k', 'id-codec.js'), 'utf8');
  const addonSource = fs.readFileSync(path.join(__dirname, '..', 'addon.js'), 'utf8');
  assert.match(providerSource, /recoverStudioPlayback/);
  assert.match(providerSource, /Array\.isArray\(decoded\.torrents\)/);
  assert.match(recoverySource, /targetedPlaybackSearch/);
  assert.match(codecSource, /const BUNDLE_VERSION = 3/);
  assert.match(addonSource, /idPrefixes: \['onlyporn:', 'ophmm-', 'ophtop-'\]/);
  assert.doesNotMatch(addonSource, /tpb-adult-addon|TPB 4K IMPROVED|(['"`])hmm-/i);
});
