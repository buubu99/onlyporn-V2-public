'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  catalogDefinitions,
  getCatalogDefinition,
  tpb4kCatalogs,
} = require('../catalog/tpb4k');
const { encodeTpb4kId } = require('./tpb4k/id-codec');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');

const ROOT = path.resolve(__dirname, '..');
const REMOVED = [
  'tpb4k.tpdb.recent',
  'tpb4k.studio.xvideosred.top',
];

test.afterEach(() => clearAdapters());

test('standalone TPDB Recent and XVideosRED catalogues are completely absent', () => {
  assert.equal(catalogDefinitions.length, 27);
  assert.equal(tpb4kCatalogs.length, 27);
  for (const id of REMOVED) {
    assert.equal(getCatalogDefinition(id), null);
    assert.equal(catalogDefinitions.some(item => item.id === id), false);
    assert.equal(tpb4kCatalogs.some(item => item.id === id), false);
  }
});

test('shared TPDB metadata infrastructure remains configured for other catalogues', () => {
  const indexSource = fs.readFileSync(
    path.join(ROOT, 'provider/tpb4k/index.js'),
    'utf8'
  );
  const configSource = fs.readFileSync(
    path.join(ROOT, 'provider/tpb4k/config.js'),
    'utf8'
  );
  const metadataSource = fs.readFileSync(
    path.join(ROOT, 'provider/tpb4k/studio-metadata.js'),
    'utf8'
  );
  assert.match(indexSource, /createMetadataAdapters/);
  assert.match(configSource, /TPDB_API_KEY/);
  assert.match(metadataSource, /tpdb/);
  assert.equal(fs.existsSync(path.join(ROOT, 'provider/tpb4k/tpdb-rest-client.js')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'provider/tpb4k/adapters/metadata.js')), true);
});

test('old saved IDs for removed catalogues fail closed before adapters run', async () => {
  let calls = 0;
  for (const id of ['tpdb', 'studio-metadata', 'torrent-index']) {
    registerAdapter({
      id,
      configured: true,
      async catalog() { calls += 1; return []; },
      async meta() { calls += 1; return null; },
      async resolve() { calls += 1; return []; },
    });
  }

  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: {
      TPB4K_ENABLED: 'true',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
  });

  assert.deepEqual(
    await provider.handleCatalog({
      type: 'movie',
      id: 'tpb4k.tpdb.recent',
      extra: {},
    }),
    { metas: [] }
  );

  const oldTpdbId = encodeTpb4kId({
    source: 'tpdb',
    sourceId: 'tpdb:old-card',
    catalogId: 'tpb4k.tpdb.recent',
  });
  const oldXvrId = encodeTpb4kId({
    source: 'studio-metadata',
    sourceId: 'tpdb:old-xvr-card',
    catalogId: 'tpb4k.studio.xvideosred.top',
  });

  assert.deepEqual(
    await provider.handleMeta({ type: 'movie', id: oldTpdbId }),
    { meta: {} }
  );
  assert.deepEqual(
    await provider.handleStream({ type: 'movie', id: oldTpdbId }),
    { streams: [] }
  );
  assert.deepEqual(
    await provider.handleMeta({ type: 'movie', id: oldXvrId }),
    { meta: {} }
  );
  assert.deepEqual(
    await provider.handleStream({ type: 'movie', id: oldXvrId }),
    { streams: [] }
  );
  assert.equal(calls, 0);
});

test('removed catalogues have no live ManyVids routing', () => {
  const providerSource = fs.readFileSync(
    path.join(ROOT, 'provider/tpb4k.js'),
    'utf8'
  );
  assert.doesNotMatch(providerSource, /AUTHORITATIVE_MANYVIDS_CATALOGS/);
  assert.doesNotMatch(providerSource, /resolveAuthoritativeManyVids/);
});
