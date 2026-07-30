#!/usr/bin/env node
'use strict';

const { catalogDefinitions } = require('../catalog/tpb4k');
const { Tpb4kProvider } = require('../provider/tpb4k');
const { readTpb4kConfig } = require('../provider/tpb4k/config');
const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');
const { clearAdapters, getAdapter, installBuiltInAdapters } = require('../provider/tpb4k/index');

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function unique(values) {
  return [...new Set(values)];
}

function explicitLowerQuality(title) {
  return /\b(?:1080p|720p|480p)\b/i.test(String(title || ''));
}

async function main() {
  const env = {
    ...process.env,
    TPB4K_ENABLED: 'true',
    TPB4K_CATALOG_LIMIT: process.env.TPB4K_CATALOG_LIMIT || '12',
    TPB4K_REQUEST_TIMEOUT_MS: process.env.TPB4K_REQUEST_TIMEOUT_MS || '30000',
  };
  const config = readTpb4kConfig(env);
  if (!config.tpdb.configured) throw new Error('TPDB_API_KEY is not configured');

  const recent = catalogDefinitions.find(item => item.id === 'tpb4k.tpdb.recent');
  const studios = catalogDefinitions.filter(item => item.mode === 'studio-top');
  if (!recent) throw new Error('TPDB Recent catalog is missing');
  if (studios.length !== 19) throw new Error(`Expected 19 studio catalogs, found ${studios.length}`);

  clearAdapters();
  installBuiltInAdapters({ env });
  const torrentAdapter = getAdapter('torrent-index');
  if (!torrentAdapter) throw new Error('torrent-index adapter is not installed');
  if (torrentAdapter.category !== '507' || torrentAdapter.sort !== '7') {
    throw new Error(`Wrong TPB contract: category=${torrentAdapter.category} sort=${torrentAdapter.sort}`);
  }
  const provider = new Tpb4kProvider({ env, installBuiltIns: false });
  const failures = [];
  const warnings = [];
  const catalogResults = [];

  const tpdbStarted = Date.now();
  const recentResult = await provider.handleCatalog({
    type: 'movie',
    id: recent.id,
    extra: { skip: 0 },
  });
  const recentMetas = Array.isArray(recentResult?.metas) ? recentResult.metas : [];
  const recentDecoded = recentMetas.map(item => decodeTpb4kId(item.id));
  const recentPosters = recentMetas.filter(item => /^https:\/\//i.test(String(item.poster || ''))).length;
  const recentSummary = {
    id: recent.id,
    name: recent.name,
    transport: 'TPDB REST Bearer',
    records: recentMetas.length,
    titles: recentMetas.filter(item => String(item.name || '').trim()).length,
    posters: recentPosters,
    posterPercent: percent(recentPosters, recentMetas.length),
    uniqueIds: new Set(recentMetas.map(item => item.id)).size,
    correctSourceIds: recentDecoded.filter(item => item?.source === 'tpdb' && String(item.sourceId).startsWith('tpdb:')).length,
    elapsedMs: Date.now() - tpdbStarted,
    first: recentMetas.slice(0, 3).map(item => ({ title: item.name, poster: item.poster || '', genres: item.genres || [] })),
  };
  catalogResults.push(recentSummary);
  console.log(JSON.stringify(recentSummary, null, 2));
  if (!recentMetas.length) failures.push(`${recent.name}: zero records`);
  if (recentSummary.titles !== recentMetas.length) failures.push(`${recent.name}: missing titles`);
  if (recentSummary.uniqueIds !== recentMetas.length) failures.push(`${recent.name}: duplicate IDs`);
  if (recentSummary.correctSourceIds !== recentMetas.length) failures.push(`${recent.name}: wrong opaque IDs`);
  if (recentSummary.posters !== recentMetas.length) failures.push(`${recent.name}: poster coverage is not 100%`);

  for (const definition of studios) {
    const started = Date.now();
    let raw = [];
    try {
      raw = await torrentAdapter.catalog({
        catalog: definition,
        skip: 0,
        limit: Number(env.TPB4K_CATALOG_LIMIT),
        config,
      });
    } catch (error) {
      failures.push(`${definition.name}: ${error.message}`);
    }
    const visible = await provider.handleCatalog({
      type: 'movie',
      id: definition.id,
      extra: { skip: 0 },
    });
    const metas = Array.isArray(visible?.metas) ? visible.metas : [];
    const decoded = metas.map(item => decodeTpb4kId(item.id));
    const diagnostics = torrentAdapter.diagnostics();
    const mirrors = unique((diagnostics.pages || []).map(page => page.mirror).filter(Boolean));
    const sourceIds = raw.map(item => item.sourceId);
    const positiveSeeders = raw.filter(item => Number(item.seeders) > 0).length;
    const sortedBySeeders = raw.every((item, index) => index === 0 || raw[index - 1].seeders >= item.seeders);
    const privateFieldsLeaked = raw.some(item => ['magnet', 'magnetLink', 'infoHash'].some(key => Object.hasOwn(item, key)));
    const lowerQuality = raw.filter(item => explicitLowerQuality(item.title)).length;
    const validDetails = raw.filter(item => {
      try {
        const url = new URL(item.detailUrl);
        return url.protocol === 'https:' && torrentAdapter.mirrors.includes(url.origin);
      } catch {
        return false;
      }
    }).length;
    const correctMetaIds = decoded.filter(item => item?.source === 'torrent-index' && String(item.sourceId).startsWith('hiddenbay:')).length;
    const correctGenres = metas.filter(item => Array.isArray(item.genres) && item.genres.includes(definition.studio)).length;
    const posters = raw.filter(item => /^https:\/\//i.test(String(item.poster || ''))).length;
    const realMetadataPosters = raw.filter(item => String(item.posterSource || '').startsWith('metadata:')).length;
    const fallbackPosters = raw.filter(item => item.posterSource === 'fallback:studio').length;
    const portraitCards = metas.filter(item => item.posterShape === 'poster').length;
    const summary = {
      id: definition.id,
      name: definition.name,
      studio: definition.studio,
      transport: 'TPB mirror HTML',
      category: torrentAdapter.category,
      sort: torrentAdapter.sort,
      mirrors,
      records: raw.length,
      visibleCards: metas.length,
      uniqueSourceIds: new Set(sourceIds).size,
      positiveSeeders,
      sortedBySeeders,
      lowerQuality,
      validDetailUrls: validDetails,
      correctOpaqueIds: correctMetaIds,
      correctStudioGenres: correctGenres,
      posters,
      posterPercent: percent(posters, raw.length),
      realMetadataPosters,
      fallbackPosters,
      portraitCards,
      enrichment: diagnostics.enrichment || {},
      privateFieldsLeaked,
      elapsedMs: Date.now() - started,
      first: raw.slice(0, 3).map(item => ({
        title: item.title,
        seeders: item.seeders,
        size: item.size,
        resolution: item.resolution,
        poster: item.poster || '',
        posterSource: item.posterSource || '',
        mirror: (() => { try { return new URL(item.detailUrl).hostname; } catch { return ''; } })(),
      })),
      diagnosticPages: diagnostics.pages || [],
    };
    catalogResults.push(summary);
    console.log(JSON.stringify(summary, null, 2));

    if (!raw.length) failures.push(`${definition.name}: zero TPB 4K results`);
    if (metas.length !== raw.length) failures.push(`${definition.name}: provider/raw count mismatch`);
    if (new Set(sourceIds).size !== raw.length) failures.push(`${definition.name}: duplicate source IDs`);
    // ZERO_SEED_CATALOG_WARNING: a non-empty 4K catalog is valid even when a mirror reports zero current seeders.
    if (positiveSeeders === 0) warnings.push(`${definition.name}: mirror currently reports zero seeders`);
    if (!sortedBySeeders) failures.push(`${definition.name}: results are not sorted by seeders`);
    if (lowerQuality) failures.push(`${definition.name}: explicit lower-resolution rows leaked into 4K catalog`);
    if (validDetails !== raw.length) failures.push(`${definition.name}: invalid detail URLs`);
    if (correctMetaIds !== metas.length) failures.push(`${definition.name}: invalid opaque IDs`);
    if (correctGenres !== metas.length) failures.push(`${definition.name}: wrong studio labels`);
    if (posters !== raw.length) failures.push(`${definition.name}: poster coverage is not 100%`);
    if (portraitCards !== metas.length) failures.push(`${definition.name}: non-portrait poster shape`);
    if (realMetadataPosters + fallbackPosters !== raw.length) failures.push(`${definition.name}: unknown poster provenance`);
    const enrichment = diagnostics.enrichment || {};
    if (Number(enrichment.eligible) !== raw.length) {
      failures.push(`${definition.name}: not every returned card was eligible for metadata enrichment`);
    }
    if (Number(enrichment.skipped || 0) !== 0) {
      failures.push(`${definition.name}: fixed-limit poster skipping is still active`);
    }
    if (config.tpdb.configured || config.stashdb.configured) {
      const evaluated = Number(enrichment.attempted || 0) + Number(enrichment.cacheHits || 0);
      if (evaluated !== raw.length) {
        failures.push(`${definition.name}: enrichment did not evaluate every returned card`);
      }
      if (Number(enrichment.deadlineFallbacks || 0) > 0) {
        warnings.push(`${definition.name}: ${enrichment.deadlineFallbacks} card(s) reached the metadata deadline`);
      }
      if (raw.length && realMetadataPosters === 0) {
        warnings.push(`${definition.name}: no real metadata posters matched in this live run`);
      }
    }
    if (privateFieldsLeaked) failures.push(`${definition.name}: magnet/info-hash leaked from catalog adapter`);
  }

  const vixen = studios.find(item => item.studio === 'Vixen');
  let pagination = { tested: false };
  if (vixen) {
    const pageOne = await torrentAdapter.catalog({ catalog: vixen, skip: 0, limit: 12, config });
    const pageTwo = await torrentAdapter.catalog({ catalog: vixen, skip: 30, limit: 12, config });
    const firstIds = new Set(pageOne.map(item => item.sourceId));
    const overlap = pageTwo.filter(item => firstIds.has(item.sourceId)).length;
    pagination = {
      tested: true,
      catalog: vixen.id,
      pageOne: pageOne.length,
      pageTwo: pageTwo.length,
      overlap,
      fullRepeat: pageOne.length > 0 && pageTwo.length === pageOne.length && overlap === pageOne.length,
    };
    if (pagination.fullRepeat) failures.push('Vixen pagination repeated the entire first page');
  }

  const output = {
    version: require('../package.json').version,
    status: failures.length ? 'failed' : 'passed',
    expectedCatalogs: 20,
    testedCatalogs: catalogResults.length,
    nonEmptyCatalogs: catalogResults.filter(item => item.records > 0).length,
    tpdbCatalogs: 1,
    tpbStudioCatalogs: 19,
    studioContract: { category: '507', quality: '4K/UHD', sort: '7', order: 'seeders descending' },
    mirrors: torrentAdapter.mirrors,
    pagination,
    metaCalls: 0,
    streamCalls: 0,
    warnings,
    failures,
    catalogs: catalogResults,
  };
  console.log(JSON.stringify(output, null, 2));
  for (const warning of warnings) console.warn(`TPB4K catalog warning: ${warning}`);
  if (failures.length) throw new Error(`${failures.length} catalog validation failure(s)`);
}

main().catch(error => {
  console.error(`TPB4K catalog smoke failed: ${error.message}`);
  process.exit(1);
});
