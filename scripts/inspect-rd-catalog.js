#!/usr/bin/env node
'use strict';

const { createRdCatalogSqliteStore } = require('../provider/rd-catalog-sqlite');

function expected(name, fallback = 0) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} requires a non-negative integer`);
  return value;
}

async function main() {
  const minimumCodes = expected('--minimum-codes');
  const minimumComplete = expected('--minimum-complete');
  const minimumModified = expected('--minimum-modified');
  const minimumPosters = expected('--minimum-posters');
  const store = createRdCatalogSqliteStore();
  try {
    if (!store.enabled) throw new Error('RD catalog persistent store is disabled');
    const stats = await store.stats();
    if (Number(stats.codes || 0) < minimumCodes) throw new Error(`codes ${stats.codes || 0} < ${minimumCodes}`);
    if (Number(stats.complete || 0) < minimumComplete) throw new Error(`complete ${stats.complete || 0} < ${minimumComplete}`);
    if (Number(stats.modifiedHashes || 0) < minimumModified) throw new Error(`modified ${stats.modifiedHashes || 0} < ${minimumModified}`);
    if (Number(stats.posters || 0) < minimumPosters) throw new Error(`posters ${stats.posters || 0} < ${minimumPosters}`);
    process.stdout.write(`${JSON.stringify({ event: 'RD_CATALOG_INSPECT_OK', ...stats })}\n`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  process.stderr.write(`RD catalog inspection failed: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
