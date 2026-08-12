'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SEARCH_VARIANTS,
  expandSukebeiSearchQueries,
  isSukebeiAliasCatalog,
} = require('./tpb4k/sukebei-search-aliases');

test('uncensored expands to original plus the five curated Japanese Sukebei variants', () => {
  assert.deepEqual(
    expandSukebeiSearchQueries('SONE 620 uncensored', {
      catalogId: 'tpb4k.sukebei.top',
    }),
    [
      'SONE 620 uncensored',
      'SONE 620 無修正',
      'SONE 620 モザイクなし',
      'SONE 620 モザイク除去',
      'SONE 620 モザイク破壊',
      'SONE 620 破壊版',
    ]
  );
});

test('multiple ordinary English aliases combine into one Japanese query while preserving original', () => {
  assert.deepEqual(
    expandSukebeiSearchQueries('big breasts nurse', {
      catalogId: 'tpb4k.sukebei.top',
    }),
    [
      'big breasts nurse',
      '巨乳 ナース',
    ]
  );
});

test('uncensored plus another alias keeps the uncensored family and translates the other phrase', () => {
  assert.deepEqual(
    expandSukebeiSearchQueries('uncensored mature', {
      catalogId: 'tpb4k.sukebei.top',
    }),
    [
      'uncensored mature',
      '無修正 熟女',
      'モザイクなし 熟女',
      'モザイク除去 熟女',
      'モザイク破壊 熟女',
      '破壊版 熟女',
    ]
  );
});

test('unknown words pass through unchanged', () => {
  assert.deepEqual(
    expandSukebeiSearchQueries('SONE 620 xyzunknown', {
      catalogId: 'tpb4k.sukebei.top',
    }),
    ['SONE 620 xyzunknown']
  );
});

test('word boundaries prevent anal from matching analysis', () => {
  assert.deepEqual(
    expandSukebeiSearchQueries('analysis', {
      catalogId: 'tpb4k.sukebei.top',
    }),
    ['analysis']
  );
});

test('Hentai-only aliases apply only to Sukebei Hentai', () => {
  assert.deepEqual(
    expandSukebeiSearchQueries('tentacles hypnosis', {
      catalogId: 'tpb4k.sukebei.hentai',
    }),
    ['tentacles hypnosis', '触手 催眠']
  );

  assert.deepEqual(
    expandSukebeiSearchQueries('tentacles hypnosis', {
      catalogId: 'tpb4k.sukebei.top',
    }),
    ['tentacles hypnosis']
  );
});

test('feature is restricted to the two requested catalogs', () => {
  assert.equal(isSukebeiAliasCatalog('tpb4k.sukebei.top'), true);
  assert.equal(isSukebeiAliasCatalog('tpb4k.sukebei.hentai'), true);
  assert.equal(isSukebeiAliasCatalog('tpb4k.yesporn.recent'), false);

  assert.deepEqual(
    expandSukebeiSearchQueries('big breasts', {
      catalogId: 'tpb4k.yesporn.recent',
    }),
    ['big breasts']
  );
});

test('query expansion is hard capped', () => {
  const variants = expandSukebeiSearchQueries(
    'uncensored big breasts nurse mature wife cosplay',
    { catalogId: 'tpb4k.sukebei.top' }
  );
  assert.ok(variants.length <= MAX_SEARCH_VARIANTS);
  assert.equal(variants[0], 'uncensored big breasts nurse mature wife cosplay');
});

test('provider source wires the alias expander into handleCatalog and merge helper', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./tpb4k'), 'utf8');

  assert.match(source, /expandSukebeiSearchQueries/);
  assert.match(source, /_handleSukebeiAliasCatalog/);
  assert.match(source, /OnlyPorn Sukebei alias search merged/);
  assert.match(source, /__onlypornSukebeiAliasExpanded/);
});
