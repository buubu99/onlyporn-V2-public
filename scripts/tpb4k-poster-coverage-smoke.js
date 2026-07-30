#!/usr/bin/env node
'use strict';

const { catalogDefinitions } = require('../catalog/tpb4k');
const { readTpb4kConfig } = require('../provider/tpb4k/config');
const { clearAdapters, getAdapter, installBuiltInAdapters } = require('../provider/tpb4k/index');

function requestedStudios() {
  const raw = String(process.env.TPB4K_POSTER_SMOKE_STUDIOS || 'Vixen,XVideosRED');
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

(async () => {
  const env = {
    ...process.env,
    TPB4K_ENABLED: 'true',
    TPB4K_CATALOG_LIMIT: process.env.TPB4K_CATALOG_LIMIT || '40',
    TPB4K_REQUEST_TIMEOUT_MS: process.env.TPB4K_REQUEST_TIMEOUT_MS || '30000',
  };
  const config = readTpb4kConfig(env);
  if (!config.tpdb.configured || !config.stashdb.configured) {
    throw new Error('TPDB_API_KEY and STASHDB_API_KEY are required');
  }

  const wanted = new Set(requestedStudios());
  const definitions = catalogDefinitions.filter(
    item => item.mode === 'studio-top' && wanted.has(item.studio)
  );
  if (definitions.length !== wanted.size) {
    throw new Error(`Could not resolve all requested studios: ${[...wanted].join(', ')}`);
  }

  clearAdapters();
  installBuiltInAdapters({ env });
  const adapter = getAdapter('torrent-index');
  if (!adapter) throw new Error('torrent-index adapter is not installed');

  const results = [];
  let totalReal = 0;
  for (const definition of definitions) {
    const started = Date.now();
    const items = await adapter.catalog({
      catalog: definition,
      skip: 0,
      limit: config.catalogLimit,
      config,
    });
    const diagnostics = adapter.diagnostics();
    const enrichment = diagnostics.enrichment || {};
    const posters = items.filter(item => /^https:\/\//i.test(String(item.poster || ''))).length;
    const real = items.filter(item => String(item.posterSource || '').startsWith('metadata:')).length;
    const fallback = items.filter(item => item.posterSource === 'fallback:studio').length;
    totalReal += real;

    if (!items.length) throw new Error(`${definition.studio}: returned zero records`);
    if (posters !== items.length) throw new Error(`${definition.studio}: incomplete poster coverage`);
    if (Number(enrichment.eligible) !== items.length) {
      throw new Error(`${definition.studio}: not every card was enrichment-eligible`);
    }
    if (Number(enrichment.skipped || 0) !== 0) {
      throw new Error(`${definition.studio}: fixed-limit skipping remains active`);
    }
    const evaluated = Number(enrichment.attempted || 0) + Number(enrichment.cacheHits || 0);
    if (evaluated !== items.length) {
      throw new Error(`${definition.studio}: ${evaluated}/${items.length} cards were evaluated`);
    }

    results.push({
      studio: definition.studio,
      records: items.length,
      realMetadataPosters: real,
      fallbackPosters: fallback,
      elapsedMs: Date.now() - started,
      enrichment,
      first: items.slice(0, 3).map(item => ({
        title: item.title,
        posterSource: item.posterSource,
        metadataMatchScore: item.metadataMatchScore || 0,
      })),
    });
  }

  if (totalReal === 0) {
    throw new Error('Selected 40-card live catalogs produced zero verified metadata posters');
  }

  console.log(JSON.stringify({
    version: require('../package.json').version,
    catalogLimit: config.catalogLimit,
    selectedStudios: [...wanted],
    allCardsEligible: true,
    fixedLimitSkipping: false,
    totalRealMetadataPosters: totalReal,
    results,
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K poster coverage smoke failed: ${error.message}`);
  process.exit(1);
});
