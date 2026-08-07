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
const logger = require('./logger');
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

  icon: 'https://raw.githubusercontent.com/Mast3rCh1ef/addon-asset/main/op.png',
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

builder.defineCatalogHandler(async args => {
  try {
    args = normalizeCatalogSearchArgs(args);
    const tpb4kSearch = isTpb4kSearchRequest(args);
    const providerArgs = tpb4kSearch ? args : toProviderCatalogArgs(args);
    const response = await loadProvider(args.id).handleCatalog(providerArgs);
    const searched = tpb4kSearch ? response : applyTpb4kCatalogSearch(response, args);
    const filtered = filterCatalogResponse(searched, contentFilter);
    logFiltered('catalog', args, filtered);
    return filtered.response;
  } catch (error) {
    logger.error({ error: error.message, catalogId: args.id }, 'Catalog handler failed');
    return { metas: [] };
  }
});

builder.defineStreamHandler(async args => {
  try {
    const provider = loadProvider(args.id);
    try {
      const metadata = await provider.handleMeta(args);
      const preflight = filterMetaResponse(metadata, contentFilter);
      if (preflight.removed) {
        logFiltered('stream', args, preflight);
        return { streams: [] };
      }
    } catch {
      // Metadata preflight is best-effort. Explicit labels on the returned
      // stream candidates are still filtered below.
    }
    const response = await provider.handleStream(args);
    const filtered = filterStreamResponse(response, contentFilter);
    logFiltered('stream', args, filtered);
    return filtered.response;
  } catch (error) {
    logger.error({ error: error.message, contentId: args.id }, 'Stream handler failed');
    return { streams: [] };
  }
});

builder.defineMetaHandler(async args => {
  try {
    const response = await loadProvider(args.id).handleMeta(args);
    const filtered = filterMetaResponse(response, contentFilter);
    logFiltered('meta', args, filtered);
    return filtered.response;
  } catch (error) {
    logger.error({ error: error.message, contentId: args.id }, 'Metadata handler failed');
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
