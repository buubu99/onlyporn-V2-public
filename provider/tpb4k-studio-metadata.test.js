'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeDiscoveryItem } = require('./tpb4k/source-contract');
const {
  createStudioMetadataAdapter,
  studioEvidence,
} = require('./tpb4k/studio-metadata');
const { sceneInput } = require('./tpb4k/stashbox-client');

function scene(id, options = {}) {
  const studio = options.studio === undefined ? 'Vixen' : options.studio;
  return {
    id,
    title: options.title || `Scene ${id}`,
    date: options.date || '2026-07-29',
    site: options.site === undefined ? { name: studio } : options.site,
    studio: options.studioObject,
    tags: (options.tags || ['Romantic']).map(name => ({ name })),
    images: options.images === undefined
      ? [{ url: `https://images.example/${id}.jpg`, width: 600, height: 900 }]
      : options.images,
    performers: options.performers || [{ name: 'Performer One' }],
  };
}

function client(records, calls, id = 'tpdb') {
  return {
    configured: true,
    async resolveStudioIds(names) {
      calls.push({ provider: id, operation: 'resolveStudioIds', names });
      return [`${id}-studio-id`];
    },
    async queryScenes(options) {
      calls.push({ provider: id, operation: 'queryScenes', ...options });
      return records;
    },
    async findScene(upstreamId) {
      return records.find(item => String(item.id) === String(upstreamId)) || null;
    },
  };
}

function adapterWith(options = {}) {
  const tpdbCalls = [];
  const stashdbCalls = [];
  const adapter = createStudioMetadataAdapter({
    env: {
      ONLYPORN_CONTENT_FILTER_ENABLED: 'true',
      ONLYPORN_FILTER_GAY: 'true',
      ONLYPORN_FILTER_INTERRACIAL: 'true',
      ONLYPORN_FILTER_UNKNOWN: 'false',
    },
    config: {
      metadataCatalogMaxPages: 3,
      contentFilterOverscanFactor: 3,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
    },
    metadataClients: {
      tpdb: options.tpdb === false ? { configured: false } : client(options.tpdbRecords || [], tpdbCalls, 'tpdb'),
      stashdb: options.stashdbRecords
        ? client(options.stashdbRecords, stashdbCalls, 'stashdb')
        : { configured: false },
    },
  });
  return { adapter, tpdbCalls, stashdbCalls };
}

test('metadata-first studio catalog returns real posters and metadata identities without generic cards', async () => {
  const records = [scene('1'), scene('2'), scene('3'), scene('4')];
  const { adapter, tpdbCalls } = adapterWith({ tpdbRecords: records });
  const items = await adapter.catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 4 });
  assert.equal(items.length, 4);
  const firstQuery = tpdbCalls.find(call => call.operation === 'queryScenes');
  assert.equal(firstQuery.studio, 'Vixen');
  assert.equal(firstQuery.text, undefined);
  for (const item of items) {
    assert.match(item.sourceId, /^tpdb:/);
    assert.match(item.poster, /^https:\/\/images\.example\//);
    assert.equal(item.lookupSource, 'torrent-index');
    assert.doesNotMatch(item.poster, /assets\/tpb4k\/studios/);
  }
  const normalized = normalizeDiscoveryItem(adapter, items[0]);
  assert.equal(normalized.source, 'studio-metadata');
  assert.equal(normalized.provenance.lookupSource, 'torrent-index');
});

test('TPDB site query can bind XVideos RED records whose raw site label is noncanonical', () => {
  const raw = scene('x1', { site: { name: 'XVideos' }, studio: '' });
  const normalized = {
    studio: 'XVideos',
  };
  assert.deepEqual(
    studioEvidence(raw, normalized, 'XVideosRED', 'XVideos RED', 'tpdb'),
    { accepted: true, reason: 'tpdb-site-query' }
  );
});

test('explicit conflicting canonical studio is rejected even when returned by a TPDB site query', () => {
  const raw = scene('bad', { studio: 'SexArt', site: { name: 'SexArt' } });
  assert.deepEqual(
    studioEvidence(raw, { studio: 'SexArt' }, 'Vixen', 'Vixen', 'tpdb'),
    { accepted: false, reason: 'studio-conflict' }
  );
});

test('explicit content tags are removed before pagination and overscan fills the visible window', async () => {
  const records = [
    scene('blocked-gay', { tags: ['Gay'] }),
    scene('blocked-interracial', { tags: ['Interracial'] }),
    scene('safe-1'),
    scene('safe-2'),
    scene('safe-3'),
    scene('safe-4'),
  ];
  const { adapter } = adapterWith({ tpdbRecords: records });
  const items = await adapter.catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 4 });
  assert.deepEqual(items.map(item => item.upstreamId), ['safe-1', 'safe-2', 'safe-3', 'safe-4']);
  const diagnostics = adapter.diagnostics().metadataCatalog;
  assert.equal(diagnostics.filtered, 2);
  assert.deepEqual(diagnostics.filterReasons, { gay: 1, interracial: 1 });
});

test('TPDB and StashDB duplicates merge richer tags without changing metadata source identity', async () => {
  const tpdbRecord = scene('tpdb-1', { title: 'Shared Scene', date: '2026-07-29', tags: ['Outdoor'] });
  const stashRecord = {
    ...scene('stash-1', { title: 'Shared Scene', date: '2026-07-29', tags: ['Romantic'] }),
    release_date: '2026-07-29',
    site: undefined,
    studio: { name: 'Vixen', parent: null },
  };
  const { adapter, stashdbCalls } = adapterWith({
    tpdbRecords: [tpdbRecord],
    stashdbRecords: [stashRecord],
  });
  const items = await adapter.catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 1 });
  assert.equal(items.length, 1);
  assert.equal(stashdbCalls.length > 0, true);
  assert.equal(items[0].sourceId, 'tpdb:tpdb-1');
  assert.deepEqual(items[0].tags, ['Outdoor', 'Romantic']);
});

test('supplemental StashDB tags can block a TPDB duplicate before it reaches the catalog', async () => {
  const tpdbRecord = scene('tpdb-filter', {
    title: 'Shared Filter Scene',
    date: '2026-07-29',
    tags: [],
  });
  const stashRecord = {
    ...scene('stash-filter', {
      title: 'Shared Filter Scene',
      date: '2026-07-29',
      tags: ['Interracial'],
    }),
    release_date: '2026-07-29',
    site: undefined,
    studio: { name: 'Vixen', parent: null },
  };
  const { adapter } = adapterWith({
    tpdbRecords: [tpdbRecord],
    stashdbRecords: [stashRecord],
  });
  const items = await adapter.catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 1 });
  assert.deepEqual(items, []);
  assert.deepEqual(adapter.diagnostics().metadataCatalog.filterReasons, { interracial: 1 });
});

test('studio metadata cache avoids repeating provider calls and meta reuses remembered content', async () => {
  const { adapter, tpdbCalls } = adapterWith({ tpdbRecords: [scene('cache-1')] });
  const first = await adapter.catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 1 });
  const callCount = tpdbCalls.length;
  const second = await adapter.catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 1 });
  assert.equal(tpdbCalls.length, callCount);
  assert.equal(adapter.diagnostics().metadataCatalog.cacheHit, true);
  assert.equal((await adapter.meta({ sourceId: first[0].sourceId })).title, second[0].title);
});



test('metadata can be rehydrated after restart with catalog binding and torrent lookup provenance', async () => {
  const records = [scene('rehydrate-1')];
  const { adapter } = adapterWith({ tpdbRecords: records });
  const item = await adapter.meta({
    sourceId: 'tpdb:rehydrate-1',
    catalogId: 'tpb4k.studio.vixen.top',
  });
  assert.equal(item.sourceId, 'tpdb:rehydrate-1');
  assert.equal(item.studio, 'Vixen');
  assert.equal(item.lookupSource, 'torrent-index');
  assert.match(item.lookupQuery, /Vixen/);
});

test('StashDB scene query uses resolved studio IDs without torrent-resolution constraints', () => {
  const input = sceneInput({
    page: 2,
    perPage: 40,
    studioIds: ['studio-digital-playground'],
  });
  assert.deepEqual(input.studios, {
    value: ['studio-digital-playground'],
    modifier: 'INCLUDES',
  });
  assert.equal(Object.hasOwn(input, 'text'), false);
  assert.equal(Object.hasOwn(input, 'parentStudio'), false);
  assert.doesNotMatch(JSON.stringify(input), /2160|1080|resolution|4k/i);
});
