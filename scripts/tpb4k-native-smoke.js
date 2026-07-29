#!/usr/bin/env node
'use strict';

process.env.TPB4K_ENABLED = 'true';

const assert = require('node:assert/strict');
const { clearAdapters } = require('../provider/tpb4k/index');
const { Tpb4kProvider } = require('../provider/tpb4k');

const catalogs = [
  'tpb4k.pornrips.recent',
  'tpb4k.yesporn.recent',
  'tpb4k.hentai.all',
  'tpb4k.hentai.new',
  'tpb4k.hentai.top',
];

async function main() {
  clearAdapters();
  const provider = new Tpb4kProvider({ env: process.env });
  const results = [];
  const firstPageSignatures = new Map();
  for (const id of catalogs) {
    const started = Date.now();
    const first = await provider.handleCatalog({ type: 'movie', id, extra: { skip: 0 } });
    assert.ok(first.metas.length > 0, `${id} returned no native metadata`);
    const second = await provider.handleCatalog({ type: 'movie', id, extra: { skip: 40 } });
    assert.ok(second.metas.length > 0, `${id} returned no native metadata on page two`);
    const firstIds = new Set(first.metas.map(item => item.id));
    const overlap = second.metas.filter(item => firstIds.has(item.id)).length;
    assert.ok(overlap < second.metas.length, `${id} page two completely repeated page one`);
    assert.equal(new Set(first.metas.map(item => item.id)).size, first.metas.length, `${id} page one contained duplicate identities`);
    assert.equal(new Set(second.metas.map(item => item.id)).size, second.metas.length, `${id} page two contained duplicate identities`);
    firstPageSignatures.set(id, first.metas.map(item => item.id).join('|'));
    const meta = await provider.handleMeta({ type: 'movie', id: first.metas[0].id });
    assert.ok(meta.meta?.name, `${id} first item returned no metadata`);
    const stream = await provider.handleStream({ type: 'movie', id: first.metas[0].id });
    assert.deepEqual(stream, { streams: [] }, `${id} produced a premature stream`);
    results.push({ id, first: first.metas.length, second: second.metas.length, overlap, elapsedMs: Date.now() - started });
  }
  assert.notEqual(firstPageSignatures.get('tpb4k.hentai.all'), firstPageSignatures.get('tpb4k.hentai.new'), 'Hentai All and New returned identical ordering');
  assert.notEqual(firstPageSignatures.get('tpb4k.hentai.all'), firstPageSignatures.get('tpb4k.hentai.top'), 'Hentai All and Top returned identical ordering');
  assert.notEqual(firstPageSignatures.get('tpb4k.hentai.new'), firstPageSignatures.get('tpb4k.hentai.top'), 'Hentai New and Top returned identical ordering');
  console.log(JSON.stringify({ version: require('../package.json').version, status: 'passed', catalogs: results }, null, 2));
}

main().catch(error => {
  console.error(`TPB4K native discovery smoke failed: ${error.message}`);
  process.exitCode = 1;
});
