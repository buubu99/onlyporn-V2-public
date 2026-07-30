'use strict';

const { getCatalogDefinition, isTpb4kEnabled } = require('../catalog/tpb4k');
const {
  dedupeCandidates,
  normalizeCandidate,
  sortCandidates,
  toStremioStream,
} = require('./tpb4k/candidate');
const { readTpb4kConfig, publicConfigStatus, redactSecrets } = require('./tpb4k/config');
const { decodeTpb4kId, encodeTpb4kId } = require('./tpb4k/id-codec');
const { buildSceneIdentity } = require('./tpb4k/identity');
const { getAdapter, installBuiltInAdapters } = require('./tpb4k/index');
const { normalizeDiscoveryItem } = require('./tpb4k/source-contract');
const { fallbackPosterUrl } = require('./tpb4k/poster-enrichment');
const {
  evaluateContent,
  filterItems,
  readContentFilterConfig,
} = require('./content-filter');

const TYPE = 'movie';
let loggerInstance;

function logger() {
  if (loggerInstance) return loggerInstance;
  try {
    loggerInstance = require('../logger');
  } catch {
    loggerInstance = { info() {}, warn() {}, error() {}, debug() {} };
  }
  return loggerInstance;
}

function safePoster(value) {
  const text = String(value || '').trim();
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function toLinks(identity) {
  return identity.performers.map(name => ({
    name,
    category: 'Cast',
    url: `stremio:///search?search=${encodeURIComponent(name)}`,
  }));
}

function fallbackKey(item = {}) {
  if (['torrent-index', 'studio-metadata'].includes(item.source) && item.studio) return item.studio;
  return item.source || 'tpb4k';
}

function resolvedPoster(item, config = {}) {
  const poster = safePoster(item?.poster);
  // Metadata-first studio rows deliberately omit records without real artwork.
  // Never reintroduce the purple generic card for these 19 catalogs.
  if (item?.source === 'studio-metadata') return poster;
  return poster || safePoster(fallbackPosterUrl(fallbackKey(item), config.posterAssetBaseUrl));
}

function resolvedPosterShape(item = {}) {
  return item.source === 'sukebei' ? 'landscape' : 'poster';
}

function toMetaPreview(item, catalogId, config) {
  const identity = buildSceneIdentity(item);
  const id = encodeTpb4kId({
    source: item.source,
    sourceId: item.sourceId,
    catalogId,
  });
  const poster = resolvedPoster(item, config);

  return {
    id,
    type: TYPE,
    name: item.title,
    poster,
    posterShape: resolvedPosterShape(item),
    genres: [
      item.studio,
      item.resolution,
      item.quality,
      ...(Array.isArray(item.tags) ? item.tags.slice(0, 20) : []),
    ].filter(Boolean),
    tags: Array.isArray(item.tags) ? item.tags : [],
    description: item.description,
    links: toLinks(identity),
  };
}

function toMetaResponse(item, id, config) {
  const identity = buildSceneIdentity(item);
  const poster = resolvedPoster(item, config);
  return {
    id,
    type: TYPE,
    name: item.title,
    poster,
    background: safePoster(item.background) || poster,
    posterShape: resolvedPosterShape(item),
    genres: [
      item.studio,
      item.resolution,
      item.quality,
      ...(Array.isArray(item.tags) ? item.tags.slice(0, 30) : []),
    ].filter(Boolean),
    tags: Array.isArray(item.tags) ? item.tags : [],
    description: item.description,
    links: toLinks(identity),
    extra: {
      tpb4k: {
        source: item.source,
        sourceId: item.sourceId,
        identity: item.sceneIdentity || identity.digest,
        releaseDate: identity.releaseDate,
        sceneCode: identity.sceneCode,
        tags: Array.isArray(item.tags) ? item.tags : [],
        metadataProvider: item.provenance?.metadataProvider || '',
        lookupSource: item.provenance?.lookupSource || '',
      },
    },
  };
}

class Tpb4kProvider {
  constructor(options = {}) {
    this.name = 'tpb4k';
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl;
    this.contentFilter = readContentFilterConfig(this.env);
    if (options.installBuiltIns !== false) {
      installBuiltInAdapters({ env: this.env, fetchImpl: this.fetchImpl });
    }
  }

  static create(options) {
    return new Tpb4kProvider(options);
  }

  getName() {
    return this.name;
  }

  activate(id) {
    const value = String(id || '');
    return value.startsWith('tpb4k.') || value.startsWith('onlyporn:tpb4k:');
  }

  enabled() {
    return isTpb4kEnabled(this.env);
  }

  async handleCatalog(args) {
    if (args.type !== TYPE || !this.enabled()) return { metas: [] };
    const definition = getCatalogDefinition(args.id);
    if (!definition) return { metas: [] };

    const adapter = getAdapter(definition.source);
    if (!adapter) {
      logger().info(
        {
          provider: this.name,
          catalogId: definition.id,
          source: definition.source,
          phase: 'foundation',
        },
        'TPB4K catalog source is not installed yet'
      );
      return { metas: [] };
    }

    const config = readTpb4kConfig(this.env);
    const skip = Math.max(Number.parseInt(String(args.extra?.skip || 0), 10) || 0, 0);
    let rawItems = [];
    try {
      const requestedLimit = this.contentFilter.enabled
        ? Math.min(config.catalogLimit * config.contentFilterOverscanFactor, 100)
        : config.catalogLimit;
      rawItems = await adapter.catalog({
        catalog: definition,
        skip,
        limit: ['studio-metadata', 'platform-hybrid'].includes(definition.source) ? config.catalogLimit : requestedLimit,
        config,
      });
    } catch (error) {
      logger().warn(
        {
          provider: this.name,
          catalogId: definition.id,
          source: definition.source,
          error: redactSecrets(error?.message || error, this.env),
        },
        'TPB4K catalog adapter failed safely'
      );
    }

    const normalizedItems = (Array.isArray(rawItems) ? rawItems : [])
      .map(item => normalizeDiscoveryItem(adapter, { ...item, catalogId: definition.id }))
      .filter(Boolean)
      .filter(item => definition.source !== 'studio-metadata' || Boolean(safePoster(item.poster)));
    const contentFiltered = filterItems(normalizedItems, this.contentFilter);
    const metas = [...contentFiltered.items]
      .slice(0, config.catalogLimit)
      .map(item => toMetaPreview(item, definition.id, config));

    let enrichment;
    let metadataCatalog;
    let sukebeiMetadata;
    let platformHybrid;
    try {
      const diagnostics = adapter.diagnostics?.() || {};
      enrichment = diagnostics.enrichment;
      metadataCatalog = diagnostics.metadataCatalog;
      sukebeiMetadata = diagnostics.sukebeiMetadata;
      platformHybrid = diagnostics.platformHybrid;
    } catch {
      enrichment = undefined;
      metadataCatalog = undefined;
      sukebeiMetadata = undefined;
      platformHybrid = undefined;
    }

    logger().info(
      {
        provider: this.name,
        catalogId: definition.id,
        source: definition.source,
        metas: metas.length,
        config: publicConfigStatus(config),
        ...(enrichment ? { enrichment } : {}),
        ...(metadataCatalog ? { metadataCatalog } : {}),
        ...(sukebeiMetadata ? { sukebeiMetadata } : {}),
        ...(platformHybrid ? { platformHybrid } : {}),
        contentFilter: {
          removed: contentFiltered.removed,
          reasons: contentFiltered.reasons,
        },
      },
      'TPB4K catalog normalized'
    );
    return { metas };
  }

  async handleMeta(args) {
    if (args.type !== TYPE || !this.enabled()) return { meta: {} };
    const decoded = decodeTpb4kId(args.id);
    if (!decoded) return { meta: {} };
    const adapter = getAdapter(decoded.source);
    if (!adapter) return { meta: {} };

    const config = readTpb4kConfig(this.env);
    let rawItem = null;
    try {
      rawItem = await adapter.meta({
        sourceId: decoded.sourceId,
        catalogId: decoded.catalogId,
        config,
      });
    } catch {
      logger().warn(
        { provider: this.name, source: decoded.source },
        'TPB4K metadata adapter failed safely'
      );
    }
    const item = normalizeDiscoveryItem(adapter, rawItem);
    if (!item) return { meta: {} };
    const evaluation = evaluateContent(item, this.contentFilter);
    if (evaluation.excluded) {
      logger().info(
        { provider: this.name, source: decoded.source, reason: evaluation.reason },
        'TPB4K metadata blocked by global explicit-tag filter'
      );
      return { meta: {} };
    }
    return { meta: toMetaResponse(item, args.id, config) };
  }

  async handleStream(args) {
    if (args.type !== TYPE || !this.enabled()) return { streams: [] };
    const decoded = decodeTpb4kId(args.id);
    if (!decoded) return { streams: [] };
    const adapter = getAdapter(decoded.source);
    if (!adapter) return { streams: [] };

    const config = readTpb4kConfig(this.env);
    try {
      const rawItem = await adapter.meta({
        sourceId: decoded.sourceId,
        catalogId: decoded.catalogId,
        config,
      });
      const item = normalizeDiscoveryItem(adapter, rawItem);
      const evaluation = item ? evaluateContent(item, this.contentFilter) : null;
      if (evaluation?.excluded) {
        logger().info(
          { provider: this.name, source: decoded.source, reason: evaluation.reason },
          'TPB4K stream blocked by global explicit-tag filter'
        );
        return { streams: [] };
      }
    } catch {
      // Stream resolution may continue when metadata is unavailable. The
      // central stream filter still removes explicitly labelled candidates.
    }
    let rawCandidates = [];
    try {
      rawCandidates = await adapter.resolve({
        sourceId: decoded.sourceId,
        catalogId: decoded.catalogId,
        config,
      });
    } catch {
      logger().warn(
        { provider: this.name, source: decoded.source },
        'TPB4K stream adapter failed safely'
      );
    }

    const normalized = (Array.isArray(rawCandidates) ? rawCandidates : [])
      .map(candidate => normalizeCandidate({ ...candidate, source: decoded.source }))
      .filter(candidate => {
        if (candidate.kind === 'invalid') return false;
        if (['p2p', 'uncached-torrent'].includes(candidate.kind)) {
          return candidate.seeders >= config.minimumSeeders;
        }
        return true;
      });

    const streams = sortCandidates(dedupeCandidates(normalized))
      .map(toStremioStream)
      .filter(Boolean);

    logger().info(
      {
        provider: this.name,
        source: decoded.source,
        sourceId: decoded.sourceId,
        candidates: normalized.length,
        streams: streams.length,
      },
      'TPB4K stream candidates normalized'
    );
    return { streams };
  }
}

module.exports = options => Tpb4kProvider.create(options);
module.exports.Tpb4kProvider = Tpb4kProvider;
