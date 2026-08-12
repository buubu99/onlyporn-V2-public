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
  sceneImages,
} = require('./tpb4k/metadata-normalize');
const {
  createMetadataAdapters,
  fetchWindow,
  parseSourceId,
} = require('./tpb4k/adapters/metadata');
const { readTpb4kConfig } = require('./tpb4k/config');
const { clearAdapters, listAdapters, registerAdapter } = require('./tpb4k/index');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { buildSceneIdentity } = require('./tpb4k/identity');
const { QUERY_SCENES, SCENE_FIELDS, sceneInput } = require('./tpb4k/stashbox-client');
const { TpdbRestClient } = require('./tpb4k/tpdb-rest-client');
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

function createMetadataFetch(options = {}) {
  const calls = [];
  const fetchImpl = async (url, request = {}) => {
    const method = String(request.method || 'GET').toUpperCase();
    calls.push({ url, request, method });

    if (method === 'GET') {
      const parsed = new URL(url);
      const sceneMatch = parsed.pathname.match(/\/scenes\/([^/]+)$/);
      if (sceneMatch) {
        return jsonResponse({ data: fixtureScene(decodeURIComponent(sceneMatch[1])) });
      }
      const page = Number.parseInt(parsed.searchParams.get('page') || '1', 10);
      const perPage = Number.parseInt(parsed.searchParams.get('per_page') || '1', 10);
      const scenes = Array.from({ length: perPage }, (_, index) =>
        fixtureScene(`tpdb-recent-${page}-${index}`, {
          studio: { id: 'tpdb-studio', name: 'ThePornDB Recent', parent: null },
          poster: `https://images.example/tpdb-${page}-${index}-poster.jpg`,
          background: { large: `https://images.example/tpdb-${page}-${index}-bg.jpg` },
        })
      );
      return jsonResponse({ data: scenes, meta: { current_page: page } });
    }

    const body = JSON.parse(request.body);
    calls[calls.length - 1].body = body;
    if (body.query.includes('OnlyPornFindScene')) {
      return jsonResponse({ data: { findScene: fixtureScene(body.variables.id) } });
    }

    const input = body.variables.input;
    const id = options.sameIdentity
      ? `stashdb-${input.page}`
      : `stashdb-${input.text || 'recent'}-${input.page}`;
    const overrides = options.sameIdentity
      ? {
          title: 'Shared Metadata Scene',
          release_date: '2026-07-02',
          studio: { id: 'studio-shared', name: input.text || 'Vixen', parent: null },
        }
      : {
          studio: {
            id: 'studio-stashdb',
            name: input.text || 'StashDB',
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


test('TPDB REST client uses Bearer auth only and caches scene pages', async () => {
  const secret = 'tpdb-rest-secret';
  const calls = [];
  const client = new TpdbRestClient({
    endpoint: 'https://api.theporndb.example',
    apiKey: secret,
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return jsonResponse({ data: [fixtureScene('rest-1')] });
    },
  });
  assert.equal((await client.queryScenes({ page: 1, perPage: 5 })).length, 1);
  assert.equal((await client.queryScenes({ page: 1, perPage: 5 })).length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.headers.Authorization, `Bearer ${secret}`);
  assert.equal(Object.hasOwn(calls[0].request.headers, 'ApiKey'), false);
  assert.doesNotMatch(calls[0].url, new RegExp(secret));
});


test('live stash-box scene query selects URL object values and surfaces GraphQL errors', async () => {
  assert.match(SCENE_FIELDS, /urls\s*\{\s*url\s*\}/);

  const client = new StashBoxGraphqlClient({
    name: 'stashdb',
    endpoint: 'https://stashdb.example/graphql',
    apiKey: 'fixture-key',
    fetchImpl: async () => jsonResponse({
      errors: [{ message: 'Field urls requires a selection of subfields' }],
    }),
  });

  await assert.rejects(
    () => client.request(QUERY_SCENES, { input: sceneInput() }),
    /Field urls requires a selection/
  );
});

test('scene query pagination and studio filters never add a resolution constraint', () => {
  const studioId = '11111111-2222-3333-4444-555555555555';
  const input = sceneInput({ page: 3, perPage: 40, studioIds: [studioId], sort: 'POPULARITY' });
  assert.deepEqual(input, {
    page: 3,
    per_page: 40,
    direction: 'DESC',
    sort: 'POPULARITY',
    studios: { value: [studioId], modifier: 'INCLUDES' },
  });
  assert.doesNotMatch(JSON.stringify(input), /2160|1080|resolution|4k/i);
});

test('metadata normalization selects portrait and landscape art and canonicalizes names', () => {
  const item = normalizeScene('tpdb', fixtureScene('42'));
  assert.equal(item.sourceId, 'tpdb:42');
  assert.equal(item.poster, 'https://images.example/42-poster.jpg');
  assert.equal(item.background, 'https://images.example/42-bg.jpg');
  assert.equal(item.detailUrl, 'https://metadata.example/scenes/42');
  assert.equal(sceneImages({ poster: 'https://images.example/poster.jpg' }).length, 1);
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
  assert.equal(bundle.adapters.length, 1);
  assert.equal(bundle.adapters[0].id, 'tpdb');
  assert.deepEqual(await bundle.adapters[0].catalog({ skip: 0, limit: 40 }), []);
  assert.deepEqual(await bundle.adapters[0].resolve({}), []);
});


test('eighteen studio definitions are metadata-first catalogs with torrent lookup provenance', async () => {
  const { calls, fetchImpl } = createMetadataFetch({ sameIdentity: true });
  const bundle = createMetadataAdapters({
    config: readTpb4kConfig({
      TPB4K_ENABLED: 'true',
      TPDB_API_KEY: 'tpdb-fixture',
      STASHDB_API_KEY: 'stash-fixture',
      TPDB_REST_API_URL: 'https://api.theporndb.example',
      STASHDB_API_URL: 'https://stashdb.example/graphql',
    }),
    fetchImpl,
  });
  const studioDefinitions = catalogDefinitions.filter(item => item.mode === 'studio-top');
  assert.equal(studioDefinitions.length, 18);
  assert.equal(studioDefinitions.filter(item => item.studio !== 'OnlyFans').every(item => item.source === 'studio-metadata'), true);
  assert.equal(studioDefinitions.find(item => item.studio === 'OnlyFans')?.source, 'platform-hybrid');
  assert.equal(studioDefinitions.every(item => item.lookupSource === 'torrent-index'), true);
  assert.deepEqual(bundle.adapters.map(item => item.id), ['tpdb']);
  assert.equal(calls.length, 0);
});

test('Phase 2A release wiring preserves 27 internal catalogs, 36 feature catalogs, and prior hardening', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const relay = fs.readFileSync(path.join(ROOT, 'media-relay.js'), 'utf8');
  assert.match(pkg.version, /^2\.7\.0-alpha\.(?:2[5-9]|[3-9]\d|\d{3,})$/);
  assert.equal(catalogDefinitions.length, 27);
  assert.equal(pkg.scripts['test:release'], 'npm test');
  assert.match(relay, /const SESSION_TTL_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(relay, /PLAYLIST_CHILD_ERROR_CODE = 'HLS_CHILD_REJECTED'/);
  assert.match(relay, /'vdcdn\.xyz'/);

  const catalogIndex = fs.readFileSync(path.join(ROOT, 'catalog/index.js'), 'utf8');
  assert.match(catalogIndex, /\.\.\.\(isTpb4kEnabled\(\) \? tpb4kCatalogs : \[\]\)/);
  assert.equal(9 + catalogDefinitions.length, 36);
  assert.deepEqual(parseSourceId('tpdb:scene-1'), { provider: 'tpdb', upstreamId: 'scene-1' });
});
