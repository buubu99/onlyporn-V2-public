'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeCatalogSearchArgs,
} = require('./tpb4k/catalog-search');
const {
  rankSearchItems,
  scoreSearchItem,
} = require('./tpb4k/search-engine');
const {
  createSearchSqliteStore,
  searchDbPath,
} = require('./search-sqlite');
const {
  createStudioMetadataAdapter,
} = require('./tpb4k/studio-metadata');

function scene(id, options = {}) {
  const studio = options.studio === undefined ? 'Vixen' : options.studio;
  return {
    id,
    title: options.title || `Uncensored Scene ${id}`,
    date: options.date || '2026-08-07',
    site: options.site === undefined ? { name: studio } : options.site,
    studio: options.studioObject,
    tags: (options.tags || ['Uncensored']).map(name => ({ name })),
    images: options.images === undefined
      ? [{ url: `https://images.example/${id}.jpg`, width: 600, height: 900 }]
      : options.images,
    performers: options.performers || [{ name: 'Performer One' }],
  };
}

test('global search normalization trims and collapses whitespace before legacy providers receive it', () => {
  const args = normalizeCatalogSearchArgs({
    id: 'spankbang',
    type: 'movie',
    extra: { search: '  uncensored   ', skip: 0 },
  });
  assert.equal(args.extra.search, 'uncensored');
});

test('search ranking ignores hidden provenance and matches visible metadata', () => {
  const hidden = {
    id: 'hidden-only',
    name: 'Completely unrelated visible title',
    extra: {
      onlyporn: {
        source: 'uncensored',
        metadataProvider: 'uncensored',
        lookupSource: 'uncensored',
      },
    },
  };
  const visible = {
    id: 'visible',
    name: 'Actual Uncensored Scene',
    tags: ['JAV'],
  };
  assert.equal(scoreSearchItem(hidden, 'uncensored'), -1);
  assert.deepEqual(rankSearchItems([hidden, visible], 'uncensored').map(row => row.id), ['visible']);
});

test('studio search canonicalizes common customer intent aliases', () => {
  const items = [
    { id: 'one', name: 'Office Encounter', tags: ['Huge Tits', 'Secretary'] },
    { id: 'two', name: 'Different Scene', tags: ['Blonde'] },
  ];
  assert.deepEqual(rankSearchItems(items, 'big breasts').map(row => row.id), ['one']);
  assert.deepEqual(rankSearchItems(items, 'office lady').map(row => row.id), ['one']);
  assert.deepEqual(rankSearchItems(items, 'big boobs office lady').map(row => row.id), ['one']);
});

test('search SQLite is separate from MetaTube and persists exact-query + pool rows', async t => {
  const root = fs.mkdtempSync('/tmp/onlyporn-search-v7-');
  const env = {
    ...process.env,
    ONLYPORN_RUNTIME_DIR: root,
    ONLYPORN_DISABLE_PERSISTENT_CACHE: 'false',
    ONLYPORN_SEARCH_SQLITE_ENABLED: 'true',
    ONLYPORN_SEARCH_MIN_FREE_BYTES: '1',
    ONLYPORN_SEARCH_DB_MAX_BYTES: String(20 * 1024 * 1024),
  };
  const store = createSearchSqliteStore({ env });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const db = searchDbPath(env);
  assert.match(db, /search[/\\]search-v1\.sqlite$/);
  assert.doesNotMatch(db, /metatube[/\\]metatube\.db$/);

  const metas = [{ id: 'one', type: 'movie', name: 'Uncensored One' }];
  const write = await store.putQuery('tpb4k.test', 'uncensored', metas);
  assert.equal(write?.written, true);

  const query = await store.getQuery('tpb4k.test', '  uncensored ');
  assert.equal(query?.fresh, true);
  assert.deepEqual(query?.metas, metas);

  await store.upsertPool('tpb4k.test', [
    { source: 'fixture', sourceId: 'a', title: 'Uncensored Alpha', tags: ['JAV'] },
    { source: 'fixture', sourceId: 'b', title: 'Different Beta', tags: ['Other'] },
  ]);
  const pool = await store.searchPool('tpb4k.test', 'uncensored', 20);
  assert.deepEqual(pool.map(row => row.sourceId), ['a']);

  const stats = await store.stats();
  assert.equal(stats.queryRows >= 1, true);
  assert.equal(stats.poolRows >= 2, true);
  assert.equal(fs.existsSync(db), true);
});

test('studio metadata sends real user query to TPDB while retaining studio scope', async () => {
  const calls = [];
  const adapter = createStudioMetadataAdapter({
    env: {
      ONLYPORN_CONTENT_FILTER_ENABLED: 'false',
    },
    config: {
      metadataCatalogMaxPages: 1,
      contentFilterOverscanFactor: 1,
      metadataCacheMaxEntries: 20,
      metadataCacheTtlMs: 600000,
    },
    metadataClients: {
      tpdb: {
        configured: true,
        async queryScenes(options) {
          calls.push(options);
          return [scene('search-one')];
        },
        async findScene() { return null; },
      },
      stashdb: { configured: false },
    },
  });

  const items = await adapter.catalog({
    catalog: {
      studio: 'Vixen',
      searchMode: true,
      searchQuery: 'uncensored',
      playbackBindingPool: true,
    },
    skip: 0,
    limit: 10,
  });

  assert.equal(items.length, 1);
  assert.equal(calls.length >= 1, true);
  assert.equal(calls[0].studio, 'Vixen');
  assert.equal(calls[0].query, 'uncensored');
});

test('Sukebei search uses upstream q and cannot mutate deployment readiness state', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'tpb4k/sukebei-metadata.js'), 'utf8');
  assert.match(source, /topUrl\.searchParams\.set\('q', searchQuery\)/);
  assert.match(source, /if \(!searchMode && metatubeStrict && safeSkip === 0\)/);
  assert.match(source, /if \(!searchMode\) recordSukebeiResult/);
  assert.match(source, /ONLYPORN_SEARCH_SUKEBEI_BUDGET_MS/);
});

test('TPB4K search bypasses old browse-first-40 filtering while browse remains unchanged', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'tpb4k.js'), 'utf8');
  const addon = fs.readFileSync(path.resolve(__dirname, '../addon.js'), 'utf8');
  assert.match(source, /return this\._handleCatalogSearch\(args, definition, searchQuery\)/);
  assert.match(source, /createSearchSqliteStore/);
  assert.match(addon, /const providerArgs = tpb4kSearch \? args : toProviderCatalogArgs\(args\)/);
  assert.match(addon, /const searched = tpb4kSearch \? response : applyTpb4kCatalogSearch\(response, args\)/);
  assert.match(source, /const cacheKey = catalogCacheKey\(args\)/);
});

test('stable readiness/public-gate files are not dependencies of the new search modules', () => {
  const searchSqlite = fs.readFileSync(path.resolve(__dirname, 'search-sqlite.js'), 'utf8');
  const engine = fs.readFileSync(path.resolve(__dirname, 'tpb4k/search-engine.js'), 'utf8');
  for (const body of [searchSqlite, engine]) {
    assert.doesNotMatch(body, /runtime-readiness|catalog-prewarm|public-gate-proxy/);
  }
});
