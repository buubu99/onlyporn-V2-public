#!/usr/bin/env node
'use strict';

const { Tpb4kProvider } = require('../provider/tpb4k');
const { publicConfigStatus, readTpb4kConfig } = require('../provider/tpb4k/config');

async function main() {
  const env = { ...process.env, TPB4K_ENABLED: 'true', TPB4K_CATALOG_LIMIT: '5' };
  const config = readTpb4kConfig(env);
  const provider = new Tpb4kProvider({ env });
  const output = {
    ...publicConfigStatus(config),
    tpdbRecentMetas: null,
    studioMetas: null,
  };

  if (config.tpdb.configured) {
    const result = await provider.handleCatalog({
      type: 'movie',
      id: 'tpb4k.tpdb.recent',
      extra: { skip: 0 },
    });
    output.tpdbRecentMetas = result.metas.length;
    if (!result.metas.length) throw new Error('Configured TPDB returned no recent metadata');
  }

  if (config.tpdb.configured || config.stashdb.configured) {
    const result = await provider.handleCatalog({
      type: 'movie',
      id: 'tpb4k.studio.vixen.top',
      extra: { skip: 0 },
    });
    output.studioMetas = result.metas.length;
    if (!result.metas.length) throw new Error('Configured metadata providers returned no Vixen metadata');
  }

  if (!config.tpdb.configured && !config.stashdb.configured) output.status = 'skipped-no-keys';
  else output.status = 'passed';
  console.log(JSON.stringify(output, null, 2));
}

main().catch(error => {
  console.error(`TPB4K metadata smoke failed: ${error.message}`);
  process.exit(1);
});
