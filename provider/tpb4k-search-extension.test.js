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
const {
  applyTpb4kCatalogSearch,
  searchMetas,
  toProviderCatalogArgs,
} = require('./tpb4k/catalog-search');

test('exactly 25 TPB4K catalogs advertise search and the 2 Stripchat rows remain browse-only', () => {
  const targetDefinitions = catalogDefinitions.filter(
    item => item.source !== 'stripchat'
  );
  const stripchatDefinitions = catalogDefinitions.filter(
    item => item.source === 'stripchat'
  );

  assert.equal(catalogDefinitions.length, 27);
  assert.equal(targetDefinitions.length, 25);
  assert.equal(stripchatDefinitions.length, 2);
  assert.equal(tpb4kCatalogs.length, 27);

  const sourceSearchable = tpb4kCatalogs.filter(catalog =>
    catalog.extra?.some(item => item.name === 'search')
  );
  assert.equal(sourceSearchable.length, 25);

  for (const definition of targetDefinitions) {
    const catalog = tpb4kCatalogs.find(item => item.id === definition.id);
    assert.ok(catalog, definition.id);
    assert.equal(
      catalog.extra.some(item => item.name === 'search'),
      true,
      definition.id
    );
    assert.equal(
      catalog.extra.some(item => item.name === 'skip'),
      true,
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

  assert.equal(finalTpb4k.length, 27);
  assert.equal(finalSearchable.length, 25);
  assert.equal(
    finalSearchable.some(item => item.id.startsWith('tpb4k.stripchat.')),
    false
  );
});

test('final Stremio manifest contains all 25 search rows and remains below 8192 bytes', () => {
  const manifest = addon.manifest;
  const serialized = JSON.stringify(manifest);
  const tpb4k = manifest.catalogs.filter(item =>
    item.id.startsWith('tpb4k.')
  );
  const searchable = tpb4k.filter(item =>
    item.extra?.some(extra => extra.name === 'search')
  );

  assert.equal(tpb4k.length, 27);
  assert.equal(searchable.length, 25);
  assert.equal(
    searchable.some(item => item.id.startsWith('tpb4k.stripchat.')),
    false
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
