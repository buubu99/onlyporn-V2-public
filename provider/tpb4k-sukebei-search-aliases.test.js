'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SEARCH_VARIANTS,
  expandSukebeiSearchQueries,
  isSukebeiAliasCatalog,
} = require('./tpb4k/sukebei-search-aliases');
const { encodeTpb4kId } = require('./tpb4k/id-codec');
const { __testOnlySukebeiSearchMetaKey, Tpb4kProvider } = require('./tpb4k');

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

test('Sukebei aliases are SQLite-local-first with only one bounded cold fallback', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./tpb4k'), 'utf8');
  const start = source.indexOf('async _handleSukebeiAliasCatalog(args, searchQueries)');
  const end = source.indexOf('async _handleCatalogFresh(args)', start);
  assert.ok(start >= 0 && end > start);
  const method = source.slice(start, end);

  assert.match(method, /aliasPoolCatalogId/);
  assert.match(method, /aliasLocalMinimum = args\?\.id === 'tpb4k\.sukebei\.top' \? 4 : 1/);
  assert.match(method, /aliasFallbackBudgetMs = 20_000/);
  assert.match(method, /this\.searchStore\.searchPool\(aliasPoolCatalogId, search, 24\)/);
  assert.match(method, /const localQueries = queries\.filter/);
  assert.match(method, /selectedQueries = localQueries\.length \? localQueries : queries\.slice\(0, 1\)/);
  assert.match(method, /allowSingleNetworkFallback/);
  assert.match(method, /Promise\.race\(\[fallbackTask, fallbackTimeout\]\)/);
  assert.match(method, /OnlyPorn Sukebei alias local preflight/);
  assert.match(method, /OnlyPorn Sukebei single upstream fallback timed out safely/);
  assert.match(method, /seenSceneKeys/);
  assert.match(method, /sukebeiSearchMetaKey\(meta\)/);
  assert.doesNotMatch(method, /offset \+= 2/);
  assert.doesNotMatch(method, /queries\.slice\(offset/);
  assert.doesNotMatch(method, /aliasOverallBudgetMs/);
  assert.doesNotMatch(method, /aliasVariantBudgetMs/);
  assert.match(method, /OnlyPorn Sukebei uncensored JAV code fallback filtered/);
  assert.match(method, /mergeSukebeiAliasResponses/);
});

test('Sukebei alias dedupe preserves distinct torrent hashes for one JAV code', () => {
  const first = {
    id: encodeTpb4kId({
      source: 'sukebei',
      sourceId: 'https://sukebei.example/view/1',
      catalogId: 'tpb4k.sukebei.top',
      torrents: [{ infoHash: '1'.repeat(40) }],
    }),
    name: 'SONE-002 Uncensored Leaked',
  };
  const duplicate = { ...first };
  const second = {
    ...first,
    id: encodeTpb4kId({
      source: 'sukebei',
      sourceId: 'https://sukebei.example/view/2',
      catalogId: 'tpb4k.sukebei.top',
      torrents: [{ infoHash: '2'.repeat(40) }],
    }),
  };

  assert.equal(__testOnlySukebeiSearchMetaKey(first), __testOnlySukebeiSearchMetaKey(duplicate));
  assert.notEqual(__testOnlySukebeiSearchMetaKey(first), __testOnlySukebeiSearchMetaKey(second));
});

test('every JAV code plus uncensored keeps a bundled RD result after display-title enrichment', async () => {
  const sourceHash = '3'.repeat(40);
  const replacementHash = '4'.repeat(40);
  const meta = {
    id: encodeTpb4kId({
      source: 'sukebei',
      sourceId: 'https://sukebei.example/view/675',
      catalogId: 'tpb4k.sukebei.top',
      sceneCode: 'SONE-675',
      torrents: [
        {
          infoHash: replacementHash,
          title: 'SONE-675 verified downloaded replacement',
          indexer: 'sukebei-rd',
        },
        {
          infoHash: sourceHash,
          title: 'SONE-675 original source',
          indexer: 'sukebei',
        },
      ],
    }),
    name: 'Japanese presentation title without the code or marker',
    tags: [],
    genres: ['JAV'],
  };
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '40' },
    searchStore: {
      enabled: true,
      async searchPool() { return Array.from({ length: 4 }, () => ({ sourceId: 'fixture' })); },
    },
  });
  provider.handleCatalog = async args => {
    assert.equal(args.extra.search, 'SONE 675');
    return { metas: [meta] };
  };

  const response = await provider._handleSukebeiAliasCatalog({
    type: 'movie',
    id: 'tpb4k.sukebei.top',
    extra: { search: 'SONE 675 uncensored' },
  }, expandSukebeiSearchQueries('SONE 675 uncensored', {
    catalogId: 'tpb4k.sukebei.top',
  }));

  assert.equal(response.metas.length, 1);
  assert.equal(response.metas[0].id, meta.id);
});

test('Sukebei SQLite search rows reuse the verified RD portrait and mapped hash by JAV code', async () => {
  const sourceHash = '5'.repeat(40);
  const mappedHash = '6'.repeat(40);
  const provider = new Tpb4kProvider({
    installBuiltIns: false,
    env: { TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '40' },
    rdCatalogStore: {
      enabled: true,
      async postersForCodes(codes) {
        assert.deepEqual(codes, ['IPX-663']);
        return {
          'IPX-663': {
            poster: 'https://onlyporn.example/onlyporn/poster/metatube/IPX-663',
            background: 'https://onlyporn.example/onlyporn/poster/metatube/IPX-663-wide',
            provider: 'metatube',
          },
        };
      },
      async mappingsForCodes(codes) {
        assert.deepEqual(codes, ['IPX-663']);
        return {
          'IPX-663': [{
            infoHash: mappedHash, filename: 'IPX-663.mp4', fileIdx: 1,
            filePath: '/IPX-663-main.mp4',
            fileBytes: 9_013_991_542,
          }],
        };
      },
    },
  });

  const [item] = await provider._rehydrateSukebeiSearchItems([{
    source: 'sukebei',
    sourceId: 'https://sukebei.example/view/663',
    title: 'IPX663 Japanese title',
    sourceTitle: 'IPX663 Japanese title',
    poster: `https://onlyporn.example/onlyporn/poster/sukebei-rss/${sourceHash}.svg`,
    infoHash: sourceHash,
    filename: 'IPX663 source.mp4',
    size: 2_254_857_830,
  }], 'IPX 663');

  assert.equal(item.sceneCode, 'IPX-663');
  assert.equal(item.poster, 'https://onlyporn.example/onlyporn/poster/metatube/IPX-663');
  assert.equal(item.provenance.lookupSource, 'rd-catalog-search-rehydration');
  assert.deepEqual(
    item.playbackCandidates.map(candidate => [candidate.indexer, candidate.infoHash, candidate.fileIdx]),
    [
      ['sukebei-rd', mappedHash, 1],
      ['sukebei', sourceHash, undefined],
    ]
  );
  assert.equal(item.playbackCandidates[0].filename, '/IPX-663-main.mp4');
  assert.equal(item.playbackCandidates[0].size, 9_013_991_542);
  assert.deepEqual(
    item.playbackCandidates[0].provenance,
    ['rd-catalog-verified-downloaded']
  );
  assert.equal(item.playbackCandidates[1].size, 2_254_857_830);
});
