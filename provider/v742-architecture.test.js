'use strict';

process.env.TPB4K_ENABLED = 'true';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyDiscoveryProfile,
  normalizeCatalogFacetArgs,
  profileOptions,
  resolveTpb4kFacet,
} = require('../catalog/discovery-profiles');
const { createSearchSqliteStore } = require('./search-sqlite');
const { applyFacet, itemMatchesFacet } = require('./tpb4k/facet-engine');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k.js');
const { scoreSearchItem } = require('./tpb4k/search-engine');
const {
  decodeSource,
  javPosterProxyUrl,
  normalizeSourceUrl,
} = require('./javhdporn-poster-proxy');

test('all nine legacy catalogs have six distinct source-native options', () => {
  const ids = ['pornhub', 'xvideos', 'xnxx', 'xhamster.trending', 'xhamster.best', 'eporner', 'spankbang', 'porntrex', 'javhdporn'];
  const menus = new Set();
  for (const id of ids) {
    const options = profileOptions(id);
    assert.equal(options.length, 6, id);
    menus.add(options.map(item => item.label).join('|'));
  }
  assert.equal(menus.size, ids.length);
});

test('24 TPB4K catalogs expose only evidence-backed profiles', () => {
  const generated = require('../catalog/discovery-profiles.generated.json');
  assert.equal(Object.keys(generated).length, 24);
  for (const [id, options] of Object.entries(generated)) {
    assert.equal(options.length, 6, id);
    for (const option of options) {
      assert.ok(option.count > 0, `${id}:${option.label}`);
      assert.notEqual(option.facet, 'fallback');
    }
  }
});

test('legacy labels map to native values while TPB4K browse facets remain genres', () => {
  const legacy = normalizeCatalogFacetArgs({ id: 'xnxx', type: 'movie', extra: { genre: 'Most Viewed' } });
  assert.equal(legacy.extra.genre, 'hits');
  const input = { id: 'tpb4k.studio.vixen.top', type: 'movie', extra: { genre: 'Blowjob' } };
  assert.deepEqual(normalizeCatalogFacetArgs(input), input);
  assert.deepEqual(
    { facet: resolveTpb4kFacet(input.id, input.extra.genre).facet, value: resolveTpb4kFacet(input.id, input.extra.genre).value },
    { facet: 'tag', value: 'Blowjob' }
  );
});

test('profile injection preserves independent search, genre, and skip extras', () => {
  const result = applyDiscoveryProfile({
    id: 'tpb4k.studio.vixen.top',
    type: 'movie',
    extra: [{ name: 'search' }, { name: 'skip' }],
  });
  assert.deepEqual(result.extra.map(item => item.name), ['search', 'genre', 'skip']);
});

test('facet engine uses exact metadata and catalog-specific technical rules', () => {
  const items = [
    { title: 'SNOS-334 FHD', tags: ['Real Life'], links: [{ name: 'A', category: 'Cast' }], seeders: 20 },
    { title: 'Other', tags: ['Outdoor'], seeders: 50 },
  ];
  assert.equal(itemMatchesFacet(items[0], { facet: 'tag', value: 'Real Life' }), true);
  assert.equal(itemMatchesFacet(items[1], { facet: 'tag', value: 'Real Life' }), false);
  assert.equal(applyFacet(items, { facet: 'rule', value: 'jav_code' }).length, 1);
  assert.equal(applyFacet(items, { facet: 'rule', value: 'cast_available' }).length, 1);
  assert.equal(applyFacet(items, { facet: 'sort', value: 'seeders_desc' })[0].seeders, 50);
});

test('TPB4K genre requests use the independent facet path and return matching cards', async t => {
  clearAdapters();
  t.after(() => clearAdapters());
  registerAdapter({ id: 'pornrips', async catalog() { return []; }, async meta() { return null; }, async resolve() { return []; } });
  const pool = [
    {
      source: 'pornrips', sourceId: 'one', title: 'Scene 1080p HEVC',
      poster: 'https://img.example/one.jpg', background: 'https://img.example/one.jpg',
      description: 'Size: 2 GB · Duration: 2200s', resolution: '1080p',
    },
    {
      source: 'pornrips', sourceId: 'two', title: 'Scene 720p',
      poster: 'https://img.example/two.jpg', background: 'https://img.example/two.jpg',
      description: 'Size: 300 MB · Duration: 900s', resolution: '720p',
    },
  ];
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { ...process.env, TPB4K_ENABLED: 'true', ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true' },
    searchStore: {
      enabled: true,
      async getQuery() { return null; },
      async putQuery() { return { written: true }; },
      async listPool() { return pool; },
    },
    catalogResponseStore: { get() { return null; }, set() {}, findByKeySuffix() { return null; } },
  });
  const result = await provider.handleCatalog({
    id: 'tpb4k.pornrips.recent', type: 'movie', extra: { genre: '1080p' },
  });
  assert.equal(result.metas.length, 1);
  assert.equal(result.metas[0].name, 'Scene 1080p HEVC');
});

test('quality and resolution participate in global search ranking', () => {
  assert.ok(scoreSearchItem({ title: 'A', resolution: '2160p', quality: '4K' }, '4k') >= 0);
  assert.ok(scoreSearchItem({ title: 'A', resolution: '1080p' }, '1080p') >= 0);
});

test('catalog_facets persists deduplicated metadata including cast links', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-v742-'));
  const store = createSearchSqliteStore({
    env: {
      ...process.env,
      ONLYPORN_RUNTIME_DIR: root,
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'false',
      ONLYPORN_SEARCH_SQLITE_ENABLED: 'true',
      ONLYPORN_SEARCH_MIN_FREE_BYTES: '1',
    },
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await store.upsertPool('tpb4k.test', [
    { source: 'studio-metadata', sourceId: 'a', title: 'A', tags: ['Outdoor'], genres: ['Outdoor', '4K'], links: [{ name: 'Performer', category: 'Cast' }] },
    { source: 'studio-metadata', sourceId: 'b', title: 'B', tags: ['Outdoor'], performers: ['Performer'], resolution: '1080p' },
  ]);
  await store.rebuildFacets('tpb4k.test');
  const facets = await store.facets('tpb4k.test', 50);
  assert.equal(facets.find(item => item.facet === 'tag' && item.value === 'Outdoor')?.itemCount, 2);
  assert.equal(facets.find(item => item.facet === 'performer' && item.value === 'Performer')?.itemCount, 2);
  assert.match(store.dbPath, /search[/\\]search-v1\.sqlite$/);
});

test('JAV poster relay only accepts HTTPS allowlisted image hosts', () => {
  const source = 'https://pics.pornfhd.com/poster.jpg';
  const relayed = javPosterProxyUrl(source, { ONLYPORN_PUBLIC_BASE_URL: 'https://onlyporn.example' });
  assert.match(relayed, /^https:\/\/onlyporn\.example\/onlyporn\/poster\/javhdporn\//);
  assert.equal(decodeSource(relayed.split('/').pop()), source);
  assert.equal(normalizeSourceUrl('https://evil.example/poster.jpg'), '');
  assert.equal(normalizeSourceUrl('http://pics.pornfhd.com/poster.jpg'), '');
});
