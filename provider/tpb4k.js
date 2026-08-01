'use strict';

const { getCatalogDefinition, isTpb4kEnabled } = require('../catalog/tpb4k');
const {
  dedupeCandidates,
  normalizeCandidate,
  sortCandidates,
  toStremioStream,
} = require('./tpb4k/candidate');
const { readTpb4kConfig, publicConfigStatus, redactSecrets } = require('./tpb4k/config');
const { createCatalogResponseStore } = require('./tpb4k/catalog-response-store');
const { decodeTpb4kId, encodeTpb4kId } = require('./tpb4k/id-codec');
const { buildSceneIdentity } = require('./tpb4k/identity');
const { getAdapter, installBuiltInAdapters } = require('./tpb4k/index');
const { normalizeDiscoveryItem } = require('./tpb4k/source-contract');
const { fallbackPosterUrl } = require('./tpb4k/poster-enrichment');
const { bindStudioPlayback } = require('./tpb4k/studio-playback-binding');
const {
  augmentStudioPlayback,
  prioritizeFailoverCandidates,
  recoverStudioPlayback,
} = require('./tpb4k/studio-targeted-recovery');
const { mergeTorrentFirstStudio, shouldUseTorrentFirst } = require('./tpb4k/torrent-first-studio');
const {
  evaluateContent,
  filterItems,
  readContentFilterConfig,
} = require('./content-filter');

const MOVIE_TYPE = 'movie';
const SERIES_TYPE = 'series';
const RELEASE_VERSION = require('../package.json').version;
const HENTAI_PREFIX = 'ophmm-';
const HENTAI_TOP_PREFIX = 'ophtop-';
const TORRENT_FIRST_STUDIOS = new Set(['onlyfans', 'digitalplayground', 'xvideosred', 'sexmex']);
const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const CATALOG_STALE_TTL_MS = 24 * 60 * 60 * 1000;
let loggerInstance;

function logger() {
  if (loggerInstance) return loggerInstance;
  try { loggerInstance = require('../logger'); }
  catch { loggerInstance = { info() {}, warn() {}, error() {}, debug() {} }; }
  return loggerInstance;
}
function safePoster(value) {
  const text = String(value || '').trim();
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined;
    if (host === 'imagetwist.com' || host.endsWith('.imagetwist.com')
      || host === 'imgtwist.com' || host.endsWith('.imgtwist.com')) return undefined;
    if (/(?:hotlink|hot-link|placeholder|deleted|not[-_ ]?found|error[-_ ]?image)/i.test(path)) return undefined;
    return parsed.toString();
  } catch { return undefined; }
}
function realStudioPoster(value) {
  const poster = safePoster(value);
  if (!poster) return undefined;
  try {
    const path = new URL(poster).pathname;
    if (/\/assets\/tpb4k\/studios\//i.test(path)
      || /\/onlyporn\/poster\/studio-release\//i.test(path)) return undefined;
    return poster;
  } catch { return undefined; }
}
function catalogType(catalogId) {
  const definition = getCatalogDefinition(catalogId);
  return definition?.type || (String(catalogId || '').startsWith('tpb4k.hentai.') ? SERIES_TYPE : MOVIE_TYPE);
}
function isHentaiResourceId(id) {
  const value = String(id || '');
  return value.startsWith(HENTAI_PREFIX) || value.startsWith(HENTAI_TOP_PREFIX);
}
function requestIdentity(args = {}) {
  if (args.type === SERIES_TYPE && isHentaiResourceId(args.id)) {
    return Object.freeze({
      source: 'hentai',
      sourceId: String(args.id),
      catalogId: String(args.id).startsWith(HENTAI_TOP_PREFIX) ? 'tpb4k.hentai.top' : 'tpb4k.hentai.all',
    });
  }
  return decodeTpb4kId(args.id);
}
function toLinks(identity) {
  return identity.performers.map(name => ({ name, category: 'Cast', url: `stremio:///search?search=${encodeURIComponent(name)}` }));
}
function fallbackKey(item = {}) {
  if (['torrent-index', 'studio-metadata'].includes(item.source) && item.studio) return item.studio;
  return item.source || 'onlyporn';
}
function resolvedPoster(item, config = {}, catalogId = '') {
  const poster = catalogId.startsWith('tpb4k.studio.')
    ? realStudioPoster(item?.poster)
    : safePoster(item?.poster);
  if (catalogId === 'tpb4k.sukebei.top') return poster;
  if (item?.source === 'studio-metadata') return poster;
  return poster || safePoster(fallbackPosterUrl(fallbackKey(item), config.posterAssetBaseUrl));
}
function resolvedPosterShape(item = {}) { return item.source === 'sukebei' ? 'landscape' : 'poster'; }
function torrentBundle(item = {}) {
  if (Array.isArray(item.playbackCandidates) && item.playbackCandidates.length) return item.playbackCandidates;
  return item.infoHash ? [{
    infoHash: item.infoHash,
    title: item.title,
    filename: item.filename || item.title,
    resolution: item.resolution,
    indexer: item.indexer || 'torrent-index',
    seeders: item.seeders,
    size: item.size,
    fileIdx: item.fileIdx,
  }] : [];
}
function toMetaPreview(item, catalogId, config) {
  const type = catalogType(catalogId);
  const identity = buildSceneIdentity(item);
  const id = type === SERIES_TYPE && isHentaiResourceId(item.sourceId)
    ? item.sourceId
    : encodeTpb4kId({
      source: item.source,
      sourceId: item.sourceId,
      catalogId,
      torrents: torrentBundle(item),
    });
  const poster = resolvedPoster(item, config, catalogId);
  return {
    id,
    type,
    name: item.title,
    poster,
    posterShape: resolvedPosterShape(item),
    genres: [item.studio, item.resolution, item.quality, ...(Array.isArray(item.tags) ? item.tags.slice(0, 20) : [])].filter(Boolean),
    tags: Array.isArray(item.tags) ? item.tags : [],
    description: item.description,
    links: toLinks(identity),
  };
}
function toMetaResponse(item, id, config, type = MOVIE_TYPE, catalogId = '') {
  const identity = buildSceneIdentity(item);
  const poster = resolvedPoster(item, config, catalogId);
  return {
    id,
    type,
    name: item.title,
    poster,
    background: safePoster(item.background) || poster,
    posterShape: resolvedPosterShape(item),
    genres: [item.studio, item.resolution, item.quality, ...(Array.isArray(item.tags) ? item.tags.slice(0, 30) : [])].filter(Boolean),
    tags: Array.isArray(item.tags) ? item.tags : [],
    description: item.description,
    links: toLinks(identity),
    ...(type === SERIES_TYPE && Array.isArray(item.videos) ? { videos: item.videos } : {}),
    extra: {
      onlyporn: {
        source: item.source,
        sourceId: item.sourceId,
        identity: item.sceneIdentity || identity.digest,
        releaseDate: identity.releaseDate,
        sceneCode: identity.sceneCode,
        tags: Array.isArray(item.tags) ? item.tags : [],
        metadataProvider: item.provenance?.metadataProvider || '',
        lookupSource: item.provenance?.lookupSource || '',
        playbackCandidates: torrentBundle(item).length,
      },
    },
  };
}
function diagnosticStudioKey(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function mergeReasons(...values) {
  const output = {};
  for (const value of values) for (const [key, amount] of Object.entries(value || {})) output[key] = (output[key] || 0) + Math.max(Number(amount || 0), 0);
  return output;
}

class Tpb4kProvider {
  constructor(options = {}) {
    this.name = 'tpb4k';
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl;
    this.contentFilter = readContentFilterConfig(this.env);
    this.catalogResponseCache = new Map();
    this.catalogInFlight = new Map();
    this.catalogResponseStore = createCatalogResponseStore({ env: this.env });
    if (options.installBuiltIns !== false) installBuiltInAdapters({ env: this.env, fetchImpl: this.fetchImpl });
  }
  static create(options) { return new Tpb4kProvider(options); }
  getName() { return this.name; }
  activate(id) {
    const value = String(id || '');
    return value.startsWith('tpb4k.') || value.startsWith('onlyporn:tpb4k:')
      || value.startsWith(HENTAI_PREFIX) || value.startsWith(HENTAI_TOP_PREFIX);
  }
  enabled() { return isTpb4kEnabled(this.env); }

  async handleCatalog(args) {
    if (!this.enabled()) return { metas: [] };
    // A deploy must never rehydrate a last-known-good catalogue produced by a
    // previous release. Keeping the version in the key prevents a stale disk
    // entry from undoing a new poster, identity, or failover policy.
    const cacheKey = `${RELEASE_VERSION}:${String(args?.type || '')}:${String(args?.id || '')}:${String(args?.extra?.skip || 0)}`;
    let cached = this.catalogResponseCache.get(cacheKey);
    if (!cached) {
      const persisted = this.catalogResponseStore.get(cacheKey);
      if (persisted?.value?.metas?.length) {
        cached = Object.freeze({ savedAt: persisted.savedAt, value: persisted.value });
        this.catalogResponseCache.set(cacheKey, cached);
      }
    }
    const age = cached ? Date.now() - cached.savedAt : Infinity;
    if (cached && age < CATALOG_CACHE_TTL_MS) return cached.value;
    if (cached && age > CATALOG_STALE_TTL_MS) {
      this.catalogResponseCache.delete(cacheKey);
      cached = null;
    }
    if (this.catalogInFlight.has(cacheKey)) {
      if (cached?.value?.metas?.length) return cached.value;
      return this.catalogInFlight.get(cacheKey);
    }
    const operation = this._handleCatalogFresh(args)
      .then(value => {
        if (Array.isArray(value?.metas) && value.metas.length) {
          const record = Object.freeze({ savedAt: Date.now(), value });
          this.catalogResponseCache.set(cacheKey, record);
          this.catalogResponseStore.set(cacheKey, value);
        } else if (cached?.value?.metas?.length) return cached.value;
        return value;
      })
      .catch(error => {
        if (cached?.value?.metas?.length) return cached.value;
        throw error;
      })
      .finally(() => this.catalogInFlight.delete(cacheKey));
    this.catalogInFlight.set(cacheKey, operation);
    if (cached?.value?.metas?.length) {
      operation.catch(() => {});
      return cached.value;
    }
    return operation;
  }

  async _handleCatalogFresh(args) {
    if (!this.enabled()) return { metas: [] };
    const definition = getCatalogDefinition(args.id);
    if (!definition || args.type !== (definition.type || MOVIE_TYPE)) return { metas: [] };
    const adapter = getAdapter(definition.source);
    if (!adapter) return { metas: [] };

    const config = readTpb4kConfig(this.env);
    const skip = Math.max(Number.parseInt(String(args.extra?.skip || 0), 10) || 0, 0);
    let rawItems = [];
    let studioPlaybackBinding;
    let studioTargetedRecovery;
    let torrentFirstStudioFallback;
    try {
      const requestedLimit = this.contentFilter.enabled
        ? Math.min(config.catalogLimit * config.contentFilterOverscanFactor, 100)
        : config.catalogLimit;
      const requiresPlayableBinding = ['studio-metadata', 'platform-hybrid'].includes(definition.source)
        && definition.lookupSource === 'torrent-index';
      if (requiresPlayableBinding) {
        const resolverAdapter = getAdapter(definition.lookupSource);
        if (!resolverAdapter) throw new Error('OnlyPorn studio torrent resolver is unavailable');
        const loadTorrentPool = typeof resolverAdapter.catalogTorrents === 'function'
          ? resolverAdapter.catalogTorrents.bind(resolverAdapter)
          : resolverAdapter.catalog.bind(resolverAdapter);
        const weakStudioKey = diagnosticStudioKey(definition.studio);
        const torrentFirstEnabled = TORRENT_FIRST_STUDIOS.has(weakStudioKey)
          && shouldUseTorrentFirst(definition, 0)
          && typeof resolverAdapter.catalog === 'function';
        const discoveryPoolLimit = weakStudioKey === 'onlyfans' ? 600 : (torrentFirstEnabled ? 400 : 300);
        const [metadataItems, torrentItems, enrichedTorrentItems] = await Promise.all([
          adapter.catalog({ catalog: { ...definition, playbackBindingPool: true }, skip: 0, limit: discoveryPoolLimit, config }),
          loadTorrentPool({ catalog: { ...definition, source: 'torrent-index', playbackBindingPool: true }, skip: 0, limit: discoveryPoolLimit, config }),
          torrentFirstEnabled ? resolverAdapter.catalog({
            catalog: {
              ...definition,
              source: 'torrent-index',
              playbackBindingPool: true,
              torrentFirstFallback: true,
            },
            skip: 0,
            limit: discoveryPoolLimit,
            config,
          }) : Promise.resolve([]),
        ]);
        let binding = bindStudioPlayback({
          catalog: definition,
          metadataItems,
          torrentItems,
          skip,
          limit: config.catalogLimit,
        });
        if (torrentFirstEnabled) {
          let fallback = mergeTorrentFirstStudio({
            catalog: definition,
            existingItems: binding.items,
            metadataItems,
            torrentItems: enrichedTorrentItems,
            limit: config.catalogLimit,
            config,
            env: this.env,
            requireRealPoster: true,
          });
          if (weakStudioKey === 'onlyfans' && shouldUseTorrentFirst(definition, fallback.items.length)) {
            binding = await recoverStudioPlayback({
              catalog: definition,
              metadataItems,
              torrentItems,
              resolverAdapter,
              config,
              skip,
              limit: config.catalogLimit,
            });
            fallback = mergeTorrentFirstStudio({
              catalog: definition,
              existingItems: binding.items,
              metadataItems,
              torrentItems: enrichedTorrentItems,
              limit: config.catalogLimit,
              config,
              env: this.env,
              requireRealPoster: true,
            });
            studioTargetedRecovery = binding.recovery;
          } else {
            studioTargetedRecovery = Object.freeze({
              attempted: 0,
              completed: 0,
              recoveredCandidates: 0,
              timedOut: 0,
              reason: 'torrent-first-minimum-satisfied',
              finalCards: fallback.items.length,
            });
          }
          if (weakStudioKey === 'sexmex' && fallback.items.length) {
            const augmented = await augmentStudioPlayback({
              catalog: definition,
              items: fallback.items,
              resolverAdapter,
              config,
            });
            fallback = Object.freeze({
              // AIOStreams can only fail over after a multi-hash scene is
              // selected. Put the already-discovered reliable SexMex scenes
              // first instead of burying them below one-hash queued results.
              items: prioritizeFailoverCandidates(augmented.items),
              stats: Object.freeze({ ...fallback.stats, failoverAugmentation: augmented.stats }),
            });
          }
          rawItems = [...fallback.items];
          torrentFirstStudioFallback = fallback.stats;
        } else {
          binding = await recoverStudioPlayback({
            catalog: definition,
            metadataItems,
            torrentItems,
            resolverAdapter,
            config,
            skip,
            limit: config.catalogLimit,
          });
          rawItems = [...binding.items];
          studioTargetedRecovery = binding.recovery;
        }
        studioPlaybackBinding = binding.stats;
      } else {
        rawItems = await adapter.catalog({
          catalog: definition,
          skip,
          limit: ['studio-metadata', 'platform-hybrid', 'torrent-index'].includes(definition.source) ? config.catalogLimit : requestedLimit,
          config,
        });
      }
    } catch (error) {
      logger().warn({ provider: this.name, catalogId: definition.id, source: definition.source, error: redactSecrets(error?.message || error, this.env) }, 'OnlyPorn catalog adapter failed safely');
    }

    const normalizedItems = (Array.isArray(rawItems) ? rawItems : [])
      .map(item => {
        const itemAdapter = getAdapter(item?.source) || adapter;
        return normalizeDiscoveryItem(itemAdapter, { ...item, catalogId: definition.id });
      })
      .filter(Boolean)
      .filter(item => definition.id !== 'tpb4k.sukebei.top' || Boolean(safePoster(item.poster)))
      .filter(item => !['studio-metadata', 'platform-hybrid'].includes(definition.source) || Boolean(realStudioPoster(item.poster)));
    const contentFiltered = filterItems(normalizedItems, this.contentFilter);
    const metas = [...contentFiltered.items].slice(0, config.catalogLimit).map(item => toMetaPreview(item, definition.id, config));

    let diagnostics = {};
    try { diagnostics = adapter.diagnostics?.({ catalog: definition, skip, limit: config.catalogLimit }) || {}; } catch { diagnostics = {}; }
    let metadataCatalog = diagnostics.metadataCatalog;
    let diagnosticsStale = false;
    if (metadataCatalog?.studio && definition.studio && diagnosticStudioKey(metadataCatalog.studio) !== diagnosticStudioKey(definition.studio)) {
      metadataCatalog = undefined;
      diagnosticsStale = true;
    }
    const metadataFiltered = Math.max(Number(metadataCatalog?.filtered || 0), 0);
    logger().info({
      provider: this.name,
      catalogId: definition.id,
      source: definition.source,
      metas: metas.length,
      config: publicConfigStatus(config),
      ...(diagnostics.enrichment ? { enrichment: diagnostics.enrichment } : {}),
      ...(metadataCatalog ? { metadataCatalog } : {}),
      ...(diagnostics.sukebeiMetadata ? { sukebeiMetadata: diagnostics.sukebeiMetadata } : {}),
      ...(diagnostics.platformHybrid ? { platformHybrid: diagnostics.platformHybrid } : {}),
      ...(diagnostics.hentaiMamaSeries ? { hentaiMamaSeries: diagnostics.hentaiMamaSeries } : {}),
      ...(studioPlaybackBinding ? { studioPlaybackBinding } : {}),
      ...(studioTargetedRecovery ? { studioTargetedRecovery } : {}),
      ...(torrentFirstStudioFallback ? { torrentFirstStudioFallback } : {}),
      ...(diagnosticsStale ? { diagnosticsStale: true } : {}),
      contentFilter: {
        removed: metadataFiltered + contentFiltered.removed,
        metadataStageRemoved: metadataFiltered,
        providerStageRemoved: contentFiltered.removed,
        reasons: mergeReasons(metadataCatalog?.filterReasons, contentFiltered.reasons),
      },
    }, 'OnlyPorn catalog normalized');
    return { metas };
  }

  async handleMeta(args) {
    if (!this.enabled()) return { meta: {} };
    const decoded = requestIdentity(args);
    if (!decoded || args.type !== catalogType(decoded.catalogId)) return { meta: {} };
    const adapter = getAdapter(decoded.source);
    if (!adapter) return { meta: {} };
    const config = readTpb4kConfig(this.env);
    let rawItem = null;
    try { rawItem = await adapter.meta({ sourceId: decoded.sourceId, catalogId: decoded.catalogId, config }); }
    catch { logger().warn({ provider: this.name, source: decoded.source }, 'OnlyPorn metadata adapter failed safely'); }
    const normalized = normalizeDiscoveryItem(adapter, rawItem);
    const item = normalized && Array.isArray(rawItem?.videos) ? Object.freeze({ ...normalized, videos: rawItem.videos }) : normalized;
    if (!item) return { meta: {} };
    const evaluation = evaluateContent(item, this.contentFilter);
    if (evaluation.excluded) return { meta: {} };
    return { meta: toMetaResponse(item, args.id, config, catalogType(decoded.catalogId), decoded.catalogId) };
  }

  async handleStream(args) {
    if (!this.enabled()) return { streams: [] };
    const decoded = requestIdentity(args);
    if (!decoded || args.type !== catalogType(decoded.catalogId)) return { streams: [] };
    const sourceAdapter = getAdapter(decoded.source);
    if (!sourceAdapter) return { streams: [] };
    const definition = getCatalogDefinition(decoded.catalogId);
    const resolverAdapter = decoded.source === 'hentai' ? sourceAdapter : getAdapter(definition?.lookupSource || decoded.source);
    if (!resolverAdapter) return { streams: [] };
    const config = readTpb4kConfig(this.env);
    let rawItem = null;
    try {
      rawItem = await sourceAdapter.meta({ sourceId: decoded.sourceId, catalogId: decoded.catalogId, config });
      const item = normalizeDiscoveryItem(sourceAdapter, rawItem);
      const evaluation = item ? evaluateContent(item, this.contentFilter) : null;
      if (evaluation?.excluded) return { streams: [] };
    } catch {
      // Metadata is a best-effort preflight; returned candidates are filtered below.
    }

    let rawCandidates = Array.isArray(decoded.torrents)
      ? decoded.torrents.map(torrent => ({
        ...torrent,
        source: torrent.indexer || 'torrent-index',
        sourceId: decoded.sourceId,
        provenance: ['catalog-bound-torrent', 'multi-candidate-bundle'],
      }))
      : [];
    if (!rawCandidates.length) {
      try {
        rawCandidates = await resolverAdapter.resolve({
          sourceId: decoded.sourceId,
          catalogId: decoded.catalogId,
          catalog: definition,
          item: rawItem,
          config,
        });
      } catch (error) {
        logger().warn({ provider: this.name, source: decoded.source, resolver: resolverAdapter.id, error: redactSecrets(error?.message || error, this.env) }, 'OnlyPorn stream adapter failed safely');
      }
    }
    const normalized = (Array.isArray(rawCandidates) ? rawCandidates : [])
      .map(candidate => normalizeCandidate({ ...candidate, source: candidate?.source || resolverAdapter.id || decoded.source }))
      .filter(candidate => {
        if (candidate.kind === 'invalid') return false;
        if (['p2p', 'uncached-torrent'].includes(candidate.kind)) {
          if (candidate.source === 'pornrips' && candidate.seeders === 0 && candidate.provenance.includes('pornrips-authoritative-torrent')) return true;
          return candidate.seeders >= config.minimumSeeders;
        }
        return true;
      });
    const episode = decoded.source === 'hentai' ? Number(String(decoded.sourceId).match(/:1:(\d+)$/)?.[1] || 1) : 0;
    const streams = sortCandidates(dedupeCandidates(normalized)).map(candidate => {
      const stream = toStremioStream(candidate);
      if (!stream || decoded.source !== 'hentai' || !stream.url) return stream;
      const label = `OnlyPorn Hentai E${episode}`;
      return {
        ...stream,
        name: label,
        title: label,
        description: label,
        behaviorHints: {
          ...(stream.behaviorHints || {}),
          bingeGroup: `onlyporn-hentai:${String(decoded.sourceId).split(':')[0]}`,
        },
      };
    }).filter(Boolean);

    logger().info({
      provider: this.name,
      source: decoded.source,
      resolver: resolverAdapter.id,
      sourceId: decoded.sourceId,
      bundledCandidates: Array.isArray(decoded.torrents) ? decoded.torrents.length : 0,
      candidates: normalized.length,
      streams: streams.length,
    }, 'OnlyPorn stream candidates normalized');
    return { streams };
  }
}

module.exports = options => Tpb4kProvider.create(options);
module.exports.Tpb4kProvider = Tpb4kProvider;
