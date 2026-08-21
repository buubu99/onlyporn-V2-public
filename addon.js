const { addonBuilder } = require('stremio-addon-sdk');
const { loadProvider } = require('./provider');
const packageInfo = require('./package.json');
const {
  applyTpb4kCatalogSearch,
  isTpb4kSearchRequest,
  normalizeCatalogSearchArgs,
  toProviderCatalogArgs,
} = require('./provider/tpb4k/catalog-search');
const { catalogs: sourceCatalogs } = require('./catalog');
const { normalizeCatalogFacetArgs } = require('./catalog/discovery-profiles');
const logger = require('./logger');
const { normalizeStreamResponse } = require('./provider/stream-contract');
const {
  filterCatalogResponse,
  filterManifestCatalogs,
  filterMetaResponse,
  filterStreamResponse,
  readContentFilterConfig,
} = require('./provider/content-filter');

const contentFilter = readContentFilterConfig(process.env);
const manifestFilter = filterManifestCatalogs(sourceCatalogs, contentFilter);

const manifest = {
  id: 'org.masterchief.onlyporn',
  version: packageInfo.version,

  name: 'OnlyPorn',
  description: packageInfo.description,

  logo: 'https://raw.githubusercontent.com/Mast3rCh1ef/addon-asset/main/op.png',
  background:
    'https://cdni.pornpics.com/1280/5/188/87261714/87261714_013_3f11.jpg',

  resources: [
    'catalog',
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['onlyporn:', 'ophmm-', 'ophtop-'] },
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['onlyporn:', 'ophmm-', 'ophtop-'] },
  ],
  types: ['movie', 'series'],
  catalogs: [...manifestFilter.catalogs],

  behaviorHints: {
    adult: true,
    p2p: true,
  },
};

const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');

if (manifestBytes >= 8192) {
  throw new Error(`OnlyPorn manifest is ${manifestBytes} bytes; it must remain below 8192 bytes`);
}

const builder = new addonBuilder(manifest);

function logFiltered(resource, args, result) {
  if (!result.removed) return;
  logger.info(
    {
      resource,
      catalogId: resource === 'catalog' ? args.id : undefined,
      contentId: resource === 'catalog' ? undefined : args.id,
      removed: result.removed,
      reasons: result.reasons,
    },
    'Global explicit-tag content filter removed results'
  );
}

function capCatalogResponse(response, limit = 40) {
  const metas = Array.isArray(response?.metas) ? response.metas : [];
  return { ...(response || {}), metas: metas.slice(0, limit) };
}

function elapsedMs(startedAt) {
  return Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
}

function providerName(provider) {
  return String(provider?.name || provider?.getName?.() || 'unknown');
}

function catalogCounts(response) {
  const metas = Array.isArray(response?.metas) ? response.metas : [];
  return {
    results: metas.length,
    postersPresent: metas.filter(item => String(item?.poster || '').trim()).length,
    postersMissing: metas.filter(item => !String(item?.poster || '').trim()).length,
    landscapePosters: metas.filter(item => item?.posterShape === 'landscape').length,
    portraitPosters: metas.filter(item => item?.posterShape === 'poster').length,
  };
}

function streamCounts(response) {
  const streams = Array.isArray(response?.streams) ? response.streams : [];
  return {
    streams: streams.length,
    torrentStreams: streams.filter(item => Boolean(item?.infoHash)).length,
    urlStreams: streams.filter(item => Boolean(item?.url)).length,
    externalStreams: streams.filter(item => Boolean(item?.externalUrl)).length,
    fileSelectedStreams: streams.filter(item => Number.isInteger(item?.fileIdx)).length,
    notWebReadyStreams: streams.filter(item => item?.behaviorHints?.notWebReady === true).length,
    proxyHeaderStreams: streams.filter(item => Boolean(item?.behaviorHints?.proxyHeaders)).length,
  };
}

function logTiming(resource, provider, stages, totalMs, success = true) {
  logger.info(
    {
      event: 'ONLYV2_TIMING',
      resource,
      provider,
      success,
      ...stages,
      totalMs,
    },
    'ONLYV2_TIMING'
  );
}

function logStats(resource, provider, counts, success = true, extra = {}) {
  const level = success ? 'info' : 'warn';
  logger[level](
    {
      event: 'ONLYV2_STATS',
      resource,
      provider,
      success,
      ...counts,
      ...extra,
    },
    'ONLYV2_STATS'
  );
}

builder.defineCatalogHandler(async args => {
  const startedAt = process.hrtime.bigint();
  let provider = null;
  let providerStartedAt = startedAt;
  try {
    args = normalizeCatalogFacetArgs(args);
    args = normalizeCatalogSearchArgs(args);
    const tpb4kSearch = isTpb4kSearchRequest(args);
    const providerArgs = tpb4kSearch ? args : toProviderCatalogArgs(args);
    provider = loadProvider(args.id);
    providerStartedAt = process.hrtime.bigint();
    const response = await provider.handleCatalog(providerArgs);
    const providerMs = elapsedMs(providerStartedAt);
    const normalizeStartedAt = process.hrtime.bigint();
    const searched = tpb4kSearch ? response : applyTpb4kCatalogSearch(response, args);
    const filtered = filterCatalogResponse(searched, contentFilter);
    logFiltered('catalog', args, filtered);
    const capped = capCatalogResponse(filtered.response);
    const totalMs = elapsedMs(startedAt);
    const name = providerName(provider);
    logTiming(
      'catalog',
      name,
      { providerMs, normalizeFilterMs: elapsedMs(normalizeStartedAt) },
      totalMs
    );
    logStats('catalog', name, catalogCounts(capped), true, {
      providerResults: catalogCounts(response).results,
      searchedResults: catalogCounts(searched).results,
      filteredResults: catalogCounts(filtered.response).results,
      removed: Number(filtered.removed || 0),
      capped: catalogCounts(filtered.response).results > catalogCounts(capped).results,
      searchMode: Boolean(args?.extra?.search),
    });
    return capCatalogResponse(filtered.response);
  } catch (error) {
    const totalMs = elapsedMs(startedAt);
    const name = providerName(provider);
    logger.error(
      { event: 'ONLYV2_HANDLER_ERROR', resource: 'catalog', provider: name, error: error.message },
      'Catalog handler failed'
    );
    logTiming('catalog', name, {}, totalMs, false);
    logStats('catalog', name, { results: 0 }, false, { error: error.message });
    return { metas: [] };
  }
});

builder.defineStreamHandler(async args => {
  const startedAt = process.hrtime.bigint();
  let provider = null;
  let metaPreflightMs = 0;
  let metaPreflight = 'not-run';
  try {
    provider = loadProvider(args.id);
    const name = providerName(provider);
    const metaStartedAt = process.hrtime.bigint();
    try {
      const metadata = await provider.handleMeta(args);
      metaPreflightMs = elapsedMs(metaStartedAt);
      const preflight = filterMetaResponse(metadata, contentFilter);
      if (preflight.removed) {
        metaPreflight = 'blocked';
        logFiltered('stream', args, preflight);
        const totalMs = elapsedMs(startedAt);
        logTiming('stream', name, { metaPreflightMs, streamResolveMs: 0 }, totalMs);
        logStats('stream', name, streamCounts({ streams: [] }), true, {
          metaPreflight,
          removed: Number(preflight.removed || 0),
          empty: true,
        });
        return { streams: [] };
      }
      metaPreflight = metadata?.meta && Object.keys(metadata.meta).length ? 'available' : 'empty';
    } catch (error) {
      metaPreflightMs = elapsedMs(metaStartedAt);
      metaPreflight = 'failed-open';
      logger.warn(
        {
          event: 'META_PREFLIGHT_ERROR',
          resource: 'stream',
          provider: name,
          error: error.message,
        },
        'Metadata preflight failed open'
      );
      // Metadata preflight is best-effort. Explicit labels on the returned
      // stream candidates are still filtered below.
    }
    const streamStartedAt = process.hrtime.bigint();
    const response = await provider.handleStream(args);
    const streamResolveMs = elapsedMs(streamStartedAt);
    const filtered = filterStreamResponse(response, contentFilter);
    logFiltered('stream', args, filtered);
    const normalized = normalizeStreamResponse(filtered.response);
    const totalMs = elapsedMs(startedAt);
    const rawCounts = streamCounts(response);
    const normalizedCounts = streamCounts(normalized);
    logTiming('stream', name, { metaPreflightMs, streamResolveMs }, totalMs);
    logStats('stream', name, normalizedCounts, true, {
      candidateStreams: rawCounts.streams,
      filteredStreams: streamCounts(filtered.response).streams,
      removed: Number(filtered.removed || 0),
      metaPreflight,
      empty: normalizedCounts.streams === 0,
    });
    logger.info(
      {
        event: 'ONLYV2_COUNTS',
        resource: 'stream',
        provider: name,
        candidates: rawCounts,
        returned: normalizedCounts,
      },
      'ONLYV2_COUNTS'
    );
    if (normalizedCounts.streams === 0) {
      logger.warn(
        {
          event: 'ONLYV2_ZERO_STREAMS',
          resource: 'stream',
          provider: name,
          candidateStreams: rawCounts.streams,
          filteredStreams: streamCounts(filtered.response).streams,
          removed: Number(filtered.removed || 0),
          metaPreflight,
        },
        'Stream request completed without a playable candidate'
      );
    }
    return normalized;
  } catch (error) {
    const totalMs = elapsedMs(startedAt);
    const name = providerName(provider);
    logger.error(
      { event: 'ONLYV2_HANDLER_ERROR', resource: 'stream', provider: name, error: error.message },
      'Stream handler failed'
    );
    logTiming('stream', name, { metaPreflightMs }, totalMs, false);
    logStats('stream', name, streamCounts({ streams: [] }), false, {
      metaPreflight,
      error: error.message,
      empty: true,
    });
    return { streams: [] };
  }
});

builder.defineMetaHandler(async args => {
  const startedAt = process.hrtime.bigint();
  let provider = null;
  try {
    provider = loadProvider(args.id);
    const response = await provider.handleMeta(args);
    const filtered = filterMetaResponse(response, contentFilter);
    logFiltered('meta', args, filtered);
    const name = providerName(provider);
    const metaPresent = Boolean(filtered.response?.meta && Object.keys(filtered.response.meta).length);
    logTiming('meta', name, { providerMs: elapsedMs(startedAt) }, elapsedMs(startedAt));
    logStats('meta', name, {
      metaPresent,
      posterPresent: Boolean(filtered.response?.meta?.poster),
      backgroundPresent: Boolean(filtered.response?.meta?.background),
      removed: Number(filtered.removed || 0),
    });
    return filtered.response;
  } catch (error) {
    const totalMs = elapsedMs(startedAt);
    const name = providerName(provider);
    logger.error(
      { event: 'ONLYV2_HANDLER_ERROR', resource: 'meta', provider: name, error: error.message },
      'Metadata handler failed'
    );
    logTiming('meta', name, {}, totalMs, false);
    logStats('meta', name, { metaPresent: false }, false, { error: error.message });
    return { meta: {} };
  }
});

logger.info(
  {
    version: manifest.version,
    catalogs: manifest.catalogs.length,
    manifestBytes,
    contentFilter: {
      enabled: contentFilter.enabled,
      blockGay: contentFilter.blockGay,
      blockInterracial: contentFilter.blockInterracial,
      blockUnknown: contentFilter.blockUnknown,
      removedManifestOptions: manifestFilter.removedOptions,
    },
  },
  'OnlyPorn manifest loaded'
);

module.exports = builder.getInterface();
