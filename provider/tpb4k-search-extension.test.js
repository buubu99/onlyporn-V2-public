'use strict';

process.env.TPB4K_ENABLED = 'true';
process.env.LOG_ENABLED = 'false';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  catalogDefinitions,
  tpb4kCatalogs,
} = require('../catalog/tpb4k');
const {
  catalogs,
} = require('../catalog');
const addon = require('../addon');
const { decodeTpb4kId } = require('./tpb4k/id-codec');
const { clearAdapters, registerAdapter } = require('./tpb4k/index');
const { Tpb4kProvider } = require('./tpb4k');
const {
  applyTpb4kCatalogSearch,
  searchMetas,
  toProviderCatalogArgs,
} = require('./tpb4k/catalog-search');

test('six TPB4K catalogs advertise focused search while Studio and Hentai Home rows remain browse-only', () => {
  const targetDefinitions = catalogDefinitions.filter(item =>
    ['studio-search', 'hentai-search', 'pornrips', 'yesporn', 'sukebei', 'sukebei-hentai'].includes(item.source)
  );
  const stripchatDefinitions = catalogDefinitions.filter(
    item => item.source === 'stripchat'
  );

  assert.equal(catalogDefinitions.length, 29);
  assert.equal(targetDefinitions.length, 6);
  assert.equal(stripchatDefinitions.length, 2);
  assert.equal(tpb4kCatalogs.length, 29);

  const sourceSearchable = tpb4kCatalogs.filter(catalog =>
    catalog.extra?.some(item => item.name === 'search')
  );
  assert.equal(sourceSearchable.length, 6);

  for (const definition of catalogDefinitions) {
    const catalog = tpb4kCatalogs.find(item => item.id === definition.id);
    assert.ok(catalog, definition.id);
    const expectedSearch = targetDefinitions.includes(definition);
    assert.equal(
      catalog.extra.some(item => item.name === 'search'),
      expectedSearch,
      definition.id
    );
    assert.equal(
      catalog.extra.some(item => item.name === 'skip'),
      !['studio-search', 'hentai-search'].includes(definition.source),
      definition.id
    );
  }

  for (const definition of stripchatDefinitions) {
    const catalog = tpb4kCatalogs.find(item => item.id === definition.id);
    assert.ok(catalog, definition.id);
    assert.equal(
      catalog.extra.some(item => item.name === 'search'),
      false,
      definition.id
    );
  }

  const finalTpb4k = catalogs.filter(item => item.id.startsWith('tpb4k.'));
  const finalSearchable = finalTpb4k.filter(catalog =>
    catalog.extra?.some(item => item.name === 'search')
  );

  assert.equal(finalTpb4k.length, 29);
  assert.equal(finalSearchable.length, 6);
  assert.equal(
    finalSearchable.some(item => item.id.startsWith('tpb4k.stripchat.')),
    false
  );
});

test('final Stremio manifest contains explicit Studios and Hentai search-only rows first', () => {
  const manifest = addon.manifest;
  const serialized = JSON.stringify(manifest);
  const tpb4k = manifest.catalogs.filter(item =>
    item.id.startsWith('tpb4k.')
  );
  const searchable = tpb4k.filter(item =>
    item.extra?.some(extra => extra.name === 'search')
  );

  assert.equal(tpb4k.length, 29);
  assert.equal(searchable.length, 6);
  assert.equal(
    searchable.some(item => item.id.startsWith('tpb4k.stripchat.')),
    false
  );
  const studiosSearch = searchable.find(item => item.id === 'tpb4k.studios.search');
  assert.deepEqual(studiosSearch.extra, [{ name: 'search', isRequired: true }]);
  assert.equal(studiosSearch.extra.some(item => item.name === 'skip'), false);
  const hentaiSearch = searchable.find(item => item.id === 'tpb4k.hentai.search');
  assert.deepEqual(hentaiSearch.extra, [{ name: 'search', isRequired: true }]);
  assert.equal(hentaiSearch.type, 'series');
  assert.deepEqual(
    manifest.catalogs.slice(0, 2).map(item => item.id),
    ['tpb4k.studios.search', 'tpb4k.hentai.search']
  );
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 8192);
});

test('matching covers title, tags, studio/genres, performers/links, description, and scene code', () => {
  const metas = [
    {
      id: 'one',
      name: 'City Lights',
      tags: ['Brunette', 'Romance'],
      genres: ['Sample Studio', '4K'],
      links: [
        { name: 'Alice Doe', category: 'Cast' },
      ],
      description: 'A night portrait in Paris',
      extra: {
        onlyporn: {
          sceneCode: 'ABC-123',
          tags: ['Editorial'],
        },
      },
    },
    {
      id: 'two',
      name: 'Summer Field',
      tags: ['Blonde'],
      genres: ['Another Studio', '1080p'],
      links: [
        { name: 'Beth Roe', category: 'Cast' },
      ],
      description: 'A daylight scene',
      extra: {
        onlyporn: {
          sceneCode: 'XYZ-999',
        },
      },
    },
  ];

  assert.deepEqual(
    searchMetas(metas, 'city').map(item => item.id),
    ['one']
  );
  assert.deepEqual(
    searchMetas(metas, 'brunette').map(item => item.id),
    ['one']
  );
  assert.deepEqual(
    searchMetas(metas, 'sample studio').map(item => item.id),
    ['one']
  );
  assert.deepEqual(
    searchMetas(metas, 'alice').map(item => item.id),
    ['one']
  );
  assert.deepEqual(
    searchMetas(metas, 'paris').map(item => item.id),
    ['one']
  );
  assert.deepEqual(
    searchMetas(metas, 'abc 123').map(item => item.id),
    ['one']
  );
  assert.deepEqual(searchMetas(metas, 'not present'), []);
});

test('search-only Studios row aggregates playable studio pools and preserves the original catalog identity', async () => {
  clearAdapters();
  registerAdapter({
    id: 'studio-metadata',
    async catalog() { return []; },
    async meta() { return null; },
    async resolve() { return []; },
  });
  const item = {
    source: 'studio-metadata',
    sourceId: 'tpdb:vixen-secretary',
    title: 'Vixen Secretary With Huge Tits',
    studio: 'Vixen',
    tags: ['Secretary', 'Huge Tits'],
    poster: 'https://cdn.theporndb.net/scene/vixen-secretary.jpg',
    playbackCandidates: [{
      infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      filename: 'Vixen Secretary 1080p.mp4',
      indexer: 'torrent-index',
    }],
  };
  const searchStore = {
    enabled: false,
    async listPool(catalogId) {
      return catalogId === 'tpb4k.studio.vixen.top' ? [item] : [];
    },
  };
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    searchStore,
    env: {
      TPB4K_ENABLED: 'true',
      ONLYPORN_CONTENT_FILTER_ENABLED: 'false',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
  });

  try {
    const response = await provider._handleCatalogSearchFresh(
      { id: 'tpb4k.studios.search', type: 'movie', extra: { search: 'big breasts office lady' } },
      catalogDefinitions.find(row => row.id === 'tpb4k.studios.search'),
      'big breasts office lady'
    );
    assert.equal(response.metas.length, 1);
    assert.equal(decodeTpb4kId(response.metas[0].id).catalogId, 'tpb4k.studio.vixen.top');
  } finally {
    clearAdapters();
  }
});

test('search-only Hentai row uses the shared Hentai pool and preserves playable Hentai identity', async () => {
  clearAdapters();
  registerAdapter({
    id: 'hentai',
    async catalog() { return []; },
    async meta() { return null; },
    async resolve() { return []; },
  });
  const item = {
    source: 'hentai',
    sourceId: 'hentai:school-days',
    title: 'School Days',
    tags: ['School'],
    poster: 'https://hentaimama.io/images/school-days.jpg',
  };
  const searchStore = {
    enabled: false,
    async listPool(catalogId) {
      return catalogId === 'tpb4k.source.hentai' ? [item] : [];
    },
    async countPool(catalogId) {
      return catalogId === 'tpb4k.source.hentai' ? 1 : 0;
    },
  };
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    searchStore,
    env: {
      TPB4K_ENABLED: 'true',
      ONLYPORN_CONTENT_FILTER_ENABLED: 'false',
      ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    },
  });

  try {
    const response = await provider._handleCatalogSearchFresh(
      { id: 'tpb4k.hentai.search', type: 'series', extra: { search: 'school' } },
      catalogDefinitions.find(row => row.id === 'tpb4k.hentai.search'),
      'school'
    );
    assert.equal(response.metas.length, 1);
    assert.equal(decodeTpb4kId(response.metas[0].id).catalogId, 'tpb4k.hentai.all');
  } finally {
    clearAdapters();
  }
});

test('TPB4K search is catalog-scoped and the established provider receives a normal page-zero browse request', () => {
  const request = {
    type: 'movie',
    id: 'tpb4k.studio.vixen.top',
    extra: {
      search: 'brunette',
      skip: 40,
    },
  };

  const providerArgs = toProviderCatalogArgs(request);

  assert.notStrictEqual(providerArgs, request);
  assert.equal(providerArgs.id, request.id);
  assert.equal(providerArgs.type, request.type);
  assert.equal(providerArgs.extra.search, undefined);
  assert.equal(providerArgs.extra.skip, 0);

  const response = {
    metas: [
      {
        id: 'one',
        name: 'First Brunette',
        tags: ['Brunette'],
      },
      {
        id: 'two',
        name: 'Second Blonde',
        tags: ['Blonde'],
      },
      {
        id: 'three',
        name: 'Third Brunette',
        tags: ['Brunette'],
      },
    ],
  };

  const firstPage = applyTpb4kCatalogSearch(
    response,
    {
      ...request,
      extra: { search: 'brunette', skip: 0 },
    }
  );
  assert.deepEqual(
    firstPage.metas.map(item => item.id),
    ['one', 'three']
  );

  const secondItem = applyTpb4kCatalogSearch(
    response,
    {
      ...request,
      extra: { search: 'brunette', skip: 1 },
    },
    { pageSize: 1 }
  );
  assert.deepEqual(
    secondItem.metas.map(item => item.id),
    ['three']
  );
});


test('Sukebei search preserves completed MetaTube poster URLs', () => {
  const result = applyTpb4kCatalogSearch({
    metas: [{
      id: 'sukebei-one',
      name: 'MIDA-762 fixture',
      poster: 'https://onlyporn.example/onlyporn/poster/metatube/abc/def',
      tags: ['JAV'],
    }, {
      id: 'sukebei-two',
      name: 'Unrelated fixture',
      poster: 'https://onlyporn.example/onlyporn/poster/metatube/ghi/jkl',
    }],
  }, {
    type: 'movie',
    id: 'tpb4k.sukebei.top',
    extra: { search: 'mida', skip: 0 },
  });
  assert.equal(result.metas.length, 1);
  assert.match(result.metas[0].poster, /\/onlyporn\/poster\/metatube\//);
});

test('legacy search arguments remain untouched and Stripchat cannot be searched directly', () => {
  const legacy = {
    type: 'movie',
    id: 'eporner',
    extra: { search: 'brunette', skip: 0 },
  };
  assert.strictEqual(toProviderCatalogArgs(legacy), legacy);

  const browse = {
    type: 'movie',
    id: 'tpb4k.studio.vixen.top',
    extra: { skip: 0 },
  };
  assert.strictEqual(toProviderCatalogArgs(browse), browse);

  const stripchat = applyTpb4kCatalogSearch(
    {
      metas: [
        { id: 'live-one', name: 'Brunette live room' },
      ],
    },
    {
      type: 'movie',
      id: 'tpb4k.stripchat.girls',
      extra: { search: 'brunette', skip: 0 },
    }
  );
  assert.deepEqual(stripchat, { metas: [] });
});

test('addon catalog handler applies search only after the current provider pipeline', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../addon.js'),
    'utf8'
  );

  assert.match(source, /toProviderCatalogArgs\(args\)/);
  assert.match(
    source,
    /applyTpb4kCatalogSearch\(response,\s*args\)/
  );
  assert.match(
    source,
    /filterCatalogResponse\(searched,\s*contentFilter\)/
  );
});
