#!/usr/bin/env node
'use strict';

const { catalogDefinitions } = require('../catalog/tpb4k');
const { evaluateContent, readContentFilterConfig } = require('../provider/content-filter');
const { Tpb4kProvider } = require('../provider/tpb4k');
const { readTpb4kConfig } = require('../provider/tpb4k/config');
const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');
const { clearAdapters, getAdapter, installBuiltInAdapters } = require('../provider/tpb4k/index');

const FALLBACK_PATH = '/assets/tpb4k/studios/';
const REQUIRED_STUDIOS = new Set([
  'BrazzersExxtra', 'Cum4K', 'DigitalPlayground', 'DorcelClub', 'MetArt',
  'MetArtX', 'Milfy', 'PlayboyPlus', 'SexArt', 'TheLifeErotic', 'Vixen',
  'WowGirls', 'OnlyFans',
]);

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function fallbackPoster(value) {
  const poster = safeHttps(value);
  if (!poster) return false;
  return new URL(poster).pathname.includes(FALLBACK_PATH);
}

async function main() {
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
  if (!config.tpdb.configured) throw new Error('TPDB_API_KEY is not configured');

  const filterConfig = readContentFilterConfig(env);
  const studios = catalogDefinitions.filter(item => item.mode === 'studio-top');
  if (studios.length !== 18) throw new Error(`Expected 18 studio catalogs, found ${studios.length}`);
  const architectureValid = studios.every(item =>
    item.lookupSource === 'torrent-index' &&
    (item.source === 'studio-metadata' || (item.studio === 'OnlyFans' && item.source === 'platform-hybrid'))
  );
  if (!architectureValid) {
    throw new Error('The 18 studio definitions do not preserve metadata-first/hybrid catalog architecture with torrent lookup provenance');
  }

  clearAdapters();
  installBuiltInAdapters({ env });
  const metadataAdapter = getAdapter('studio-metadata');
  const torrentAdapter = getAdapter('torrent-index');
  if (!metadataAdapter?.configured) throw new Error('studio-metadata adapter is not configured');
  if (!torrentAdapter || torrentAdapter.category !== '507' || torrentAdapter.sort !== '7') {
    throw new Error('The retained Phase 3 torrent-index contract is missing');
  }
  const provider = new Tpb4kProvider({ env, installBuiltIns: false });
  const failures = [];
  const warnings = [];
  const results = [];

  const recentStarted = Date.now();
  const recentPayload = await provider.handleCatalog({ type: 'movie', id: recent.id, extra: { skip: 0 } });
  const recentMetas = Array.isArray(recentPayload?.metas) ? recentPayload.metas : [];
  const recentPosters = recentMetas.filter(item => safeHttps(item.poster)).length;
  const recentSummary = {
    id: recent.id,
    name: recent.name,
    source: 'tpdb',
    records: recentMetas.length,
    posters: recentPosters,
    posterPercent: percent(recentPosters, recentMetas.length),
    uniqueIds: new Set(recentMetas.map(item => item.id)).size,
    elapsedMs: Date.now() - recentStarted,
  };
  results.push(recentSummary);
  console.log(JSON.stringify(recentSummary, null, 2));
  if (!recentMetas.length) failures.push(`${recent.name}: zero records`);
  if (recentPosters !== recentMetas.length) failures.push(`${recent.name}: incomplete HTTPS poster coverage`);
  if (recentSummary.uniqueIds !== recentMetas.length) failures.push(`${recent.name}: duplicate IDs`);

  for (const definition of studios) {
    const started = Date.now();
    const definitionAdapter = getAdapter(definition.source);
    if (!definitionAdapter?.configured) throw new Error(`${definition.name}: source adapter is not configured`);
    const raw = await definitionAdapter.catalog({
      catalog: definition,
      skip: 0,
      limit: config.catalogLimit,
      config,
    });
    const payload = await provider.handleCatalog({
      type: 'movie',
      id: definition.id,
      extra: { skip: 0 },
    });
    const metas = Array.isArray(payload?.metas) ? payload.metas : [];
    const decoded = metas.map(item => decodeTpb4kId(item.id));
    const adapterDiagnostics = definitionAdapter.diagnostics?.() || {};
    const diagnostics = adapterDiagnostics.metadataCatalog || {};
    const platformHybrid = adapterDiagnostics.platformHybrid || {};
    const safePosters = metas.filter(item => safeHttps(item.poster)).length;
    const genericPosters = metas.filter(item => fallbackPoster(item.poster)).length;
    const blockedVisible = metas.filter(item => evaluateContent(item, filterConfig).excluded).length;
    const correctIds = decoded.filter(item =>
      item?.source === definition.source &&
      (definition.source === 'platform-hybrid'
        ? /^(?:tpdb|stashdb|hiddenbay):/.test(String(item.sourceId || ''))
        : /^(?:tpdb|stashdb):/.test(String(item.sourceId || '')))
    ).length;
    const correctStudio = metas.filter(item => Array.isArray(item.genres) && item.genres.includes(definition.studio)).length;
    const summary = {
      id: definition.id,
      name: definition.name,
      studio: definition.studio,
      source: definition.source,
      lookupSource: definition.lookupSource,
      records: raw.length,
      visibleCards: metas.length,
      safeHttpsPosters: safePosters,
      realMetadataPosters: safePosters - genericPosters,
      genericPosters,
      correctOpaqueIds: correctIds,
      correctStudioGenres: correctStudio,
      explicitFilteredContentVisible: blockedVisible,
      metadataCatalog: diagnostics,
      platformHybrid,
      elapsedMs: Date.now() - started,
      first: metas.slice(0, 3).map(item => ({
        title: item.name,
        poster: item.poster,
        tags: item.tags || [],
      })),
    };
    results.push(summary);
    console.log(JSON.stringify(summary, null, 2));

    if (REQUIRED_STUDIOS.has(definition.studio) && !metas.length) {
      failures.push(`${definition.name}: required metadata catalog returned zero records`);
    } else if (!metas.length) {
      warnings.push(`${definition.name}: metadata provider returned zero records in this live run`);
    }
    if (raw.length !== metas.length) failures.push(`${definition.name}: adapter/provider count mismatch`);
    if (safePosters !== metas.length) failures.push(`${definition.name}: missing safe HTTPS poster`);
    if (genericPosters && definition.studio !== 'OnlyFans') failures.push(`${definition.name}: generic studio fallback leaked into metadata-first row`);
    if (correctIds !== metas.length) failures.push(`${definition.name}: wrong metadata-first opaque IDs`);
    if (correctStudio !== metas.length) failures.push(`${definition.name}: wrong studio label`);
    if (blockedVisible) failures.push(`${definition.name}: explicitly excluded content remained visible`);
  }

  const nonEmptyStudios = results.filter(item => item.studio && item.records > 0).length;
  if (nonEmptyStudios < 13) {
    failures.push(`Only ${nonEmptyStudios}/18 studio catalogs were non-empty; expected at least 13`);
  }

  const vixen = studios.find(item => item.studio === 'Vixen');
  let pagination = { tested: false };
  if (vixen) {
    const first = await metadataAdapter.catalog({ catalog: vixen, skip: 0, limit: 12, config });
    const second = await metadataAdapter.catalog({ catalog: vixen, skip: 12, limit: 12, config });
    const firstIds = new Set(first.map(item => item.sourceId));
    const overlap = second.filter(item => firstIds.has(item.sourceId)).length;
    pagination = { tested: true, first: first.length, second: second.length, overlap };
    if (first.length && second.length && overlap === second.length) {
      failures.push('Vixen metadata pagination repeated the complete first page');
    }
  }

  const output = {
    version: require('../package.json').version,
    status: failures.length ? 'failed' : 'passed',
    architecture: 'metadata-first catalog -> retained torrent lookup',
    testedCatalogs: results.length,
    nonEmptyStudioCatalogs: nonEmptyStudios,
    globalExplicitTagFilter: {
      enabled: filterConfig.enabled,
      gay: filterConfig.blockGay,
      interracial: filterConfig.blockInterracial,
      imageAnalysis: false,
    },
    retainedTorrentContract: { category: torrentAdapter.category, sort: torrentAdapter.sort },
    pagination,
    warnings,
    failures,
    catalogs: results,
  };
  console.log(JSON.stringify(output, null, 2));
  for (const warning of warnings) console.warn(`TPB4K catalog warning: ${warning}`);
  if (failures.length) throw new Error(`${failures.length} metadata-first catalog validation failure(s)`);
}

main().catch(error => {
  console.error(`TPB4K catalog smoke failed: ${error.message}`);
  process.exit(1);
});
