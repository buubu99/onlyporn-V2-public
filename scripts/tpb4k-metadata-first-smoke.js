#!/usr/bin/env node
'use strict';

const { catalogDefinitions } = require('../catalog/tpb4k');
const { readTpb4kConfig } = require('../provider/tpb4k/config');
const { clearAdapters, getAdapter, installBuiltInAdapters } = require('../provider/tpb4k/index');

const FALLBACK_PATH = '/assets/tpb4k/studios/';

function requestedStudios() {
  const raw = String(
    process.env.TPB4K_POSTER_SMOKE_STUDIOS ||
      'Vixen,XVideosRED,DorcelClub,DigitalPlayground,NewSensations,SexArt'
  );
  return raw.split(',').map(value => value.trim()).filter(Boolean);
}

function isSafeRealPoster(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.pathname.includes(FALLBACK_PATH);
  } catch {
    return false;
  }
}

(async () => {
  const env = {
    ...process.env,
    TPB4K_ENABLED: 'true',
    TPB4K_CATALOG_LIMIT: process.env.TPB4K_CATALOG_LIMIT || '40',
    TPB4K_REQUEST_TIMEOUT_MS: process.env.TPB4K_REQUEST_TIMEOUT_MS || '30000',
    ONLYPORN_CONTENT_FILTER_ENABLED: process.env.ONLYPORN_CONTENT_FILTER_ENABLED || 'true',
    ONLYPORN_FILTER_GAY: process.env.ONLYPORN_FILTER_GAY || 'true',
    ONLYPORN_FILTER_INTERRACIAL: process.env.ONLYPORN_FILTER_INTERRACIAL || 'true',
  };
  const config = readTpb4kConfig(env);
  if (!config.tpdb.configured) throw new Error('TPDB_API_KEY is required');

  const wanted = new Set(requestedStudios());
  const definitions = catalogDefinitions.filter(item => item.mode === 'studio-top' && wanted.has(item.studio));
  if (definitions.length !== wanted.size) throw new Error(`Could not resolve all requested studios: ${[...wanted].join(', ')}`);

  clearAdapters();
  installBuiltInAdapters({ env });
  const adapter = getAdapter('studio-metadata');
  if (!adapter?.configured) throw new Error('studio-metadata adapter is not configured');

  const results = [];
  for (const definition of definitions) {
    const started = Date.now();
    const items = await adapter.catalog({ catalog: definition, skip: 0, limit: config.catalogLimit, config });
    const diagnostics = adapter.diagnostics().metadataCatalog || {};
    const real = items.filter(item => isSafeRealPoster(item.poster)).length;
    if (!items.length) throw new Error(`${definition.studio}: returned zero metadata records`);
    if (real !== items.length) throw new Error(`${definition.studio}: generic or unsafe poster remained`);
    results.push({
      studio: definition.studio,
      records: items.length,
      realMetadataPosters: real,
      genericPosters: 0,
      elapsedMs: Date.now() - started,
      metadataCatalog: diagnostics,
      first: items.slice(0, 3).map(item => ({ title: item.title, provider: item.metadataProvider, poster: item.poster })),
    });
  }

  console.log(JSON.stringify({
    version: require('../package.json').version,
    architecture: 'metadata-first',
    selectedStudios: [...wanted],
    allStudioCardsUseRealMetadataPosters: true,
    genericFallbackCards: 0,
    results,
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K metadata-first poster smoke failed: ${error.message}`);
  process.exit(1);
});
