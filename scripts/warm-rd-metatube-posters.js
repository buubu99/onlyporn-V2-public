#!/usr/bin/env node
'use strict';

const { createRdCatalogSqliteStore } = require('../provider/rd-catalog-sqlite');
const { createMetaTubeClient } = require('../provider/tpb4k/metatube-client');

function numberArgument(name, fallback, minimum, maximum) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Math.min(Math.max(Number.isFinite(value) ? Math.floor(value) : fallback, minimum), maximum);
}

async function mapLimit(rows, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await operation(rows[index], index);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const all = process.argv.includes('--all');
  const retryMissing = process.argv.includes('--retry-missing');
  const limit = all ? 5000 : numberArgument('--limit', 250, 1, 5000);
  const concurrency = numberArgument('--concurrency', 3, 1, 4);
  const timeoutMs = numberArgument('--timeout-ms', 90_000, 5_000, 300_000);
  const store = createRdCatalogSqliteStore();
  const metatube = createMetaTubeClient({ env: process.env });
  if (!store.enabled) throw new Error('RD catalog persistent store is disabled');
  if (!metatube.configured) throw new Error('MetaTube client is not configured');

  const totals = { requested: 0, found: 0, missing: 0, errors: 0 };
  try {
    const rows = await store.codesNeedingPosters(limit, { retryMissing });
    totals.requested = rows.length;
    process.stdout.write(`${JSON.stringify({
      event: 'RD_METATUBE_WARM_START', requested: rows.length, concurrency, timeoutMs, retryMissing,
    })}\n`);
    await mapLimit(rows, concurrency, async (row, index) => {
      try {
        const scene = await metatube.searchExact(row.code, timeoutMs);
        if (scene?.poster) {
          await store.upsertPoster(row.code, scene);
          totals.found += 1;
          process.stdout.write(`${JSON.stringify({
            event: 'RD_METATUBE_POSTER_FOUND', position: index + 1, total: rows.length,
            code: row.code, provider: String(scene.id || '').split(':', 1)[0],
          })}\n`);
        } else {
          await store.recordPosterAttempt(row.code, 'missing');
          totals.missing += 1;
          process.stdout.write(`${JSON.stringify({
            event: 'RD_METATUBE_POSTER_MISSING', position: index + 1, total: rows.length, code: row.code,
          })}\n`);
        }
      } catch (error) {
        await store.recordPosterAttempt(row.code, 'error', error?.message || error);
        totals.errors += 1;
        process.stderr.write(`${JSON.stringify({
          event: 'RD_METATUBE_POSTER_ERROR', position: index + 1, total: rows.length,
          code: row.code, error: String(error?.message || error).slice(0, 500),
        })}\n`);
      }
    });
    const stats = await store.stats();
    process.stdout.write(`${JSON.stringify({ event: 'RD_METATUBE_WARM_COMPLETE', ...totals, stats })}\n`);
    if (totals.errors) process.exitCode = 2;
  } finally {
    await store.close();
  }
}

main().catch(error => {
  process.stderr.write(`RD MetaTube warm failed: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
