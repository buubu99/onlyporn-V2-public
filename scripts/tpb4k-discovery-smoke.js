#!/usr/bin/env node
'use strict';

process.env.TPB4K_ENABLED = 'true';
const { Tpb4kProvider } = require('../provider/tpb4k');
const { publicConfigStatus, readTpb4kConfig } = require('../provider/tpb4k/config');

const IDS = [
  'tpb4k.pornrips.recent',
  'tpb4k.hentai.all',
  'tpb4k.hentai.new',
  'tpb4k.hentai.top',
  'tpb4k.tpdb.recent',
  'tpb4k.yesporn.recent',
  'tpb4k.sukebei.top',
];

(async () => {
  const provider = new Tpb4kProvider({ env: process.env });
  const config = readTpb4kConfig(process.env);
  const results = [];
  for (const id of IDS) {
    const started = Date.now();
    const response = await provider.handleCatalog({ type: 'movie', id, extra: { skip: 0 } });
    results.push({ id, metas: response.metas.length, elapsedMs: Date.now() - started });
  }
  console.log(JSON.stringify({
    version: require('../package.json').version,
    status: publicConfigStatus(config),
    catalogs: results,
    streamsExpected: 0,
    stripchatPhaseRequired: 7,
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K discovery smoke failed: ${error.message}`);
  process.exit(1);
});
