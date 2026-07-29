'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const { catalogDefinitions } = require('../catalog/tpb4k');
const { BoundedTtlCache } = require('./tpb4k/cache');
const { StashBoxGraphqlClient } = require('./tpb4k/graphql-client');
const {
  mergeMetadataPreservingIdentity,
  normalizePerformers,
  normalizeScene,
  normalizeStudioName,
} = require('./tpb4k/metadata-normalize');
const {
  createMetadataAdapters,
  fetchWindow,
  parseSourceId,
} = require('./tpb4k/adapters/metadata');
const { readTpb4kConfig } = require('./tpb4k/config');
const { clearAdapters, listAdapters } = require('./tpb4k/index');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { buildSceneIdentity } = require('./tpb4k/identity');
const { sceneInput } = require('./tpb4k/stashbox-client');
const { Tpb4kProvider } = require('./tpb4k');

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name || '').toLowerCase();
        if (key === 'content-type') return 'application/json; charset=utf-8';
        if (key === 'content-length') return String(Buffer.byteLength(body));
        return null;
      },
    },
    async text() {
      return body;
    },
  };
}

function fixtureScene(id, overrides = {}) {
  return {
    id,
    title: `Fixture Scene ${id}`,
    details: `Description ${id}`,
    release_date: '2026-07-01',
    code: `FX-${String(id).replace(/\D/g, '') || '1'}`,
    duration: 1800,
    urls: [{ url: `https://metadata.example/scenes/${id}` }],
    studio: { id: 'studio-1', name: 'Digital Playground', parent: null },
    images: [
      { id: `${id}-poster`, url: `https://images.example/${id}-poster.jpg`, width: 600, height: 900 },
      { id: `${id}-bg`, url: `https://images.example/${id}-bg.jpg`, width: 1600, height: 900 },
    ],
    performers: [
      { as: '', performer: { id: 'p1', name: 'Performer One', aliases: [], images: [] } },
    ],
    ...overrides,
  };
}

function createGraphqlFetch(options = {}) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push({ url, request, body });
    if (body.query.includes('OnlyPornFindScene')) {
      return jsonResponse({ data: { findScene: fixtureScene(body.variables.id) } });
    }
    const input = body.variables.input;
    const provider = String(url).includes('stashdb') ? 'stashdb' : 'tpdb';
    const id = options.sameIdentity
      ? `${provider}-${input.page}`
      : `${provider}-${input.parentStudio || 'recent'}-${input.page}`;
    const overrides = options.sameIdentity
      ? {
          title: 'Shared Metadata Scene',
          release_date: '2026-07-02',
          studio: { id: 'studio-shared', name: input.parentStudio || 'Vixen', parent: null },
        }
      : {
          studio: {
            id: `studio-${provider}`,
            name: input.parentStudio || 'ThePornDB',
            parent: null,
          },
        };
    return jsonResponse({
      data: {
        queryScenes: {
          count: 200,
          scenes: [fixtureScene(id, overrides)],
        },
      },
    });
  };
  return { calls, fetchImpl };
}

test.afterEach(() => clearAdapters());

test('bounded metadata cache supports positive entries, negative entries, expiry, and eviction', () => {
  let now = 1000;
  const cache = new BoundedTtlCache({ maxEntries: 2, now: () => now });
  cache.set('one', { id: 1 }, 100);
  cache.setNegative('missing', 50);
  assert.deepEqual(cache.get('one'), { id: 1 });
  assert.equal(cache.hasNegative('missing'), true);
  cache.set('three', { id: 3 }, 100);
  assert.equal(cache.getEntry('one'), null);
  now += 60;
  assert.equal(cache.hasNegative('missing'), false);
  assert.equal(cache.size, 1);
});

test('GraphQL metadata client keeps API keys in the ApiKey header only and caches successful responses', async () => {
  const secret = 'fixture-api-key';
  const calls = [];
  const client = new StashBoxGraphqlClient({
    name: 'stashdb',
    endpoint: 'https://stashdb.example/graphql',
    apiKey: secret,
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return jsonResponse({ data: { ping: 'pong' } });
    },
  });
  const query = 'query Ping { ping }';
  assert.deepEqual(await client.request(query), { ping: 'pong' });
  assert.deepEqual(await client.request(query), { ping: 'pong' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.headers.ApiKey, secret);
  assert.doesNotMatch(calls[0].url, new RegExp(secret));
  assert.doesNotMatch(calls[0].request.body, new RegExp(secret));
});

test('scene query pagination and studio filters never add a resolution constraint', () => {
  const input = sceneInput({ page: 3, perPage: 40, studio: 'SexArt', sort: 'POPULARITY' });
  assert.deepEqual(input, {
    page: 3,
    per_page: 40,
    direction: 'DESC',
    sort: 'POPULARITY',
    parentStudio: 'SexArt',
  });
  assert.doesNotMatch(JSON.stringify(input), /2160|1080|resolution|4k/i);
});

test('metadata normalization selects portrait and landscape art and canonicalizes names', () => {
  const item = normalizeScene('tpdb', fixtureScene('42'));
  assert.equal(item.sourceId, 'tpdb:42');
  assert.equal(item.poster, 'https://images.example/42-poster.jpg');
  assert.equal(item.background, 'https://images.example/42-bg.jpg');
  assert.equal(item.studio, 'DigitalPlayground');
  assert.deepEqual(item.performers, ['Performer One']);
  assert.equal(normalizeStudioName('X Videos RED'), 'XVideosRED');
  assert.deepEqual(
    normalizePerformers(['Performer Two', 'performer two', { name: 'Performer One' }]),
    ['Performer One', 'Performer Two']
  );
});

test('poster enrichment cannot alter the original playback identity or source ID', () => {
  const source = {
    sourceId: 'pornrips:scene-1',
    title: 'Original Scene 2160p',
    studio: 'Vixen',
    performers: ['Performer One'],
    releaseDate: '2026-07-01',
    poster: 'https://source.example/poster.jpg',
  };
  const identity = buildSceneIdentity(source).digest;
  const merged = mergeMetadataPreservingIdentity(source, {
    title: 'Wrong Scene',
    studio: 'Wrong Studio',
    performers: ['Wrong Performer'],
    releaseDate: '2020-01-01',
    poster: 'https://metadata.example/better-poster.jpg',
    background: 'https://metadata.example/background.jpg',
  });
  assert.equal(merged.sourceId, source.sourceId);
  assert.equal(merged.title, source.title);
  assert.equal(merged.studio, source.studio);
  assert.deepEqual(merged.performers, source.performers);
  assert.equal(merged.sceneIdentity, identity);
  assert.equal(merged.poster, 'https://metadata.example/better-poster.jpg');
});

test('window pagination advances pages and never repeats an earlier page', async () => {
  const pages = [];
  const client = {
    configured: true,
    async queryScenes({ page, perPage }) {
      pages.push(page);
      return Array.from({ length: perPage }, (_, index) => ({ id: `p${page}-${index}` }));
    },
  };
  const first = await fetchWindow(client, { skip: 0, limit: 2 });
  const second = await fetchWindow(client, { skip: 2, limit: 2 });
  assert.deepEqual(first.map(item => item.id), ['p1-0', 'p1-1']);
  assert.deepEqual(second.map(item => item.id), ['p2-0', 'p2-1']);
  assert.deepEqual(pages, [1, 2]);
});

test('missing metadata keys degrade to empty catalogs and never create fake streams', async () => {
  const config = readTpb4kConfig({ TPB4K_ENABLED: 'true' });
  const bundle = createMetadataAdapters({ config, fetchImpl: async () => assert.fail('fetch called') });
  assert.deepEqual(await bundle.adapters[0].catalog({ skip: 0, limit: 40 }), []);
  assert.deepEqual(
    await bundle.adapters[1].catalog({ catalog: { studio: 'Vixen' }, skip: 0, limit: 40 }),
    []
  );
  assert.deepEqual(await bundle.adapters[0].resolve({}), []);
  assert.deepEqual(await bundle.adapters[1].resolve({}), []);
});

test('TPDB recent catalog and meta handlers return stable metadata while stream resolution remains empty', async () => {
  const { calls, fetchImpl } = createGraphqlFetch();
  const provider = new Tpb4kProvider({
    fetchImpl,
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '1',
      TPDB_API_KEY: 'tpdb-fixture',
      TPDB_API_URL: 'https://theporndb.example/graphql',
    },
  });
  assert.deepEqual(listAdapters(), ['torrent-index', 'tpdb']);

  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.tpdb.recent',
    extra: { skip: 0 },
  });
  assert.equal(catalog.metas.length, 1);
  const decoded = decodeTpb4kId(catalog.metas[0].id);
  assert.equal(decoded.source, 'tpdb');
  assert.match(decoded.sourceId, /^tpdb:/);

  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(meta.meta.extra.tpb4k.source, 'tpdb');
  assert.match(meta.meta.poster, /^https:\/\/images\.example\//);

  const streams = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });
  assert.deepEqual(streams, { streams: [] });
  assert.equal(calls.every(call => call.request.headers.ApiKey === 'tpdb-fixture'), true);
  assert.equal(calls.every(call => !call.url.includes('tpdb-fixture')), true);
});

test('nineteen studio definitions use both configured metadata providers and dedupe scene identity', async () => {
  const { calls, fetchImpl } = createGraphqlFetch({ sameIdentity: true });
  const provider = new Tpb4kProvider({
    fetchImpl,
    env: {
      TPB4K_ENABLED: 'true',
      TPB4K_CATALOG_LIMIT: '10',
      TPDB_API_KEY: 'tpdb-fixture',
      STASHDB_API_KEY: 'stash-fixture',
      TPDB_API_URL: 'https://theporndb.example/graphql',
      STASHDB_API_URL: 'https://stashdb.example/graphql',
    },
  });
  const studioDefinitions = catalogDefinitions.filter(item => item.mode === 'studio-top');
  assert.equal(studioDefinitions.length, 19);
  assert.equal(studioDefinitions.some(item => Object.hasOwn(item, 'targetResolution')), false);

  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.studio.vixen.top',
    extra: { skip: 0 },
  });
  assert.equal(catalog.metas.length, 1);
  const queryCalls = calls.filter(call => call.body.query.includes('OnlyPornQueryScenes'));
  assert.equal(queryCalls.length, 2);
  assert.equal(queryCalls.every(call => call.body.variables.input.parentStudio === 'Vixen'), true);
  assert.equal(queryCalls.every(call => call.body.variables.input.sort === 'POPULARITY'), true);
  assert.equal(queryCalls.every(call => !/2160|1080|resolution/i.test(JSON.stringify(call.body))), true);
});

test('Phase 2A release wiring preserves 28 catalogs, 37 feature catalogs, and prior hardening', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const relay = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');
  assert.equal(pkg.version, '2.7.0-alpha.3');
  assert.equal(catalogDefinitions.length, 28);
  assert.match(pkg.scripts['test:release'], /tpb4k-phase2a\.test\.js/);
  assert.match(relay, /const SESSION_TTL_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(relay, /PLAYLIST_CHILD_ERROR_CODE = 'HLS_CHILD_REJECTED'/);
  assert.match(relay, /'vdcdn\.xyz'/);

  const catalogIndex = fs.readFileSync(path.join(ROOT, 'catalog/index.js'), 'utf8');
  assert.match(catalogIndex, /\.\.\.\(isTpb4kEnabled\(\) \? tpb4kCatalogs : \[\]\)/);
  assert.equal(9 + catalogDefinitions.length, 37);
  assert.deepEqual(parseSourceId('tpdb:scene-1'), { provider: 'tpdb', upstreamId: 'scene-1' });
});
