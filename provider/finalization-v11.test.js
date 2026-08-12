'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  filterCatalogResponse,
  metaMatchesSearch,
  searchTokens,
} = require('./search-relevance');

test('native relevance requires every meaningful query token across visible metadata', () => {
  const good = {
    name: 'Closeup scene',
    description: 'soft licking',
    tags: ['pussy'],
  };
  const bad = {
    name: 'Trending random scene',
    description: 'unrelated',
  };
  assert.deepEqual(searchTokens('Pussy  licking'), ['pussy', 'licking']);
  assert.equal(metaMatchesSearch(good, 'pussy licking'), true);
  assert.equal(metaMatchesSearch(bad, 'pussy licking'), false);
  assert.deepEqual(
    filterCatalogResponse({ metas: [bad, good] }, 'pussy licking').metas,
    [good]
  );
});

test('SpankBang and XVideos search responses pass through relevance filter', () => {
  const spank = fs.readFileSync(path.join(__dirname, 'spankbang.js'), 'utf8');
  const xv = fs.readFileSync(path.join(__dirname, 'xvideos.js'), 'utf8');
  assert.match(spank, /if \(extra\.search\) return filterCatalogResponse\(primary, extra\.search\)/);
  assert.match(xv, /return search \? filterCatalogResponse\(response, search\) : response/);
});

test('TPB4K general search ranks a broad local pool and mature misses stay local', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(src, /this\.searchStore\.listPool\(poolCatalogId, poolLimit\)/);
  assert.match(src, /allPool\.length >= 80 \|\| \(metadataPool\.length >= 20 && torrentPool\.length >= 20\)/);
  assert.match(src, /else if \(poolCount >= 80\)[\s\S]{0,450}searchMode = 'sqlite-warm-miss'/);
  assert.doesNotMatch(src, /if \(cachedMatches\.length >= 4\)/);
});

test('successful V7.1 Sukebei uncensored behavior remains wired', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  for (const text of [
    'OnlyPorn Sukebei uncensored JAV code fallback filtered',
    'OnlyPorn Sukebei alias local preflight',
    'allowSingleNetworkFallback',
    'mergeSukebeiAliasResponses',
  ]) assert.ok(src.includes(text), text);
});

test('measured TPB4K poster contracts are corrected centrally', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(src, /tpb4k\.sukebei\.top'\) return 'poster'/);
  assert.match(src, /tpb4k\.yesporn\.recent'\) return 'landscape'/);
  assert.match(src, /tpb4k\.studio\.dorcelclub\.top'\) return 'landscape'/);
  assert.match(src, /wide_/);
});

test('JAVHD no longer exposes explicit fallback poster cards as successful catalog art', () => {
  const src = fs.readFileSync(path.join(__dirname, 'javhdporn.js'), 'utf8');
  assert.match(src, /if \(\/\\\/fallback\\\.png\$\/i\.test\(poster\)\) return/);
});

test('Sukebei phase1 contract now declares portrait poster art as poster', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k-phase1.test.js'), 'utf8');
  assert.match(src, /assert\.equal\(catalog\.metas\[0\]\.posterShape, 'poster'\)/);
  assert.match(src, /assert\.equal\(meta\.meta\.posterShape, 'poster'\)/);
});
