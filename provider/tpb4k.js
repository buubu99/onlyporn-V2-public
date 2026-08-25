'use strict';

const { expandSukebeiSearchQueries } = require('./tpb4k/sukebei-search-aliases');

const { getCatalogDefinition, isTpb4kEnabled } = require('../catalog/tpb4k');
const { resolveTpb4kFacet } = require('../catalog/discovery-profiles');
const {
  dedupeCandidates,
  normalizeCandidate,
  normalizeResolution,
  sortCandidates,
  toStremioStream,
} = require('./tpb4k/candidate');
const { readTpb4kConfig, publicConfigStatus, redactSecrets } = require('./tpb4k/config');
const { fillCatalogWithMetadata } = require('./tpb4k/catalog-metadata-fill');
const { createCatalogResponseStore } = require('./tpb4k/catalog-response-store');
const { createSearchSqliteStore } = require('./search-sqlite');
const { applyFacet } = require('./tpb4k/facet-engine');
const {
  mergeSearchItems,
  normalizeSearchQuery,
  rankSearchItems,
} = require('./tpb4k/search-engine');
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
const {
  createRdCatalogSqliteStore,
  normalizeJavCode,
} = require('./rd-catalog-sqlite');

const MOVIE_TYPE = 'movie';
const SERIES_TYPE = 'series';
const CATALOG_CACHE_REVISION = 'r7';
const SUKEBEI_CATALOG_CACHE_REVISION = 's3';
const SUKEBEI_SEARCH_CACHE_REVISION = 's4';
function catalogCacheRevision(args = {}) {
  return String(args?.id || '') === 'tpb4k.sukebei.top'
    ? `${CATALOG_CACHE_REVISION}-${SUKEBEI_CATALOG_CACHE_REVISION}`
    : CATALOG_CACHE_REVISION;
}
function catalogCacheKey(args = {}) {
  return `${catalogCacheRevision(args)}:${String(args?.type || '')}:${String(args?.id || '')}:${String(args?.extra?.skip || 0)}`;
}
function legacyCatalogCacheSuffix(args = {}) {
  return `:${catalogCacheKey(args)}`;
}
const HENTAI_PREFIX = 'ophmm-';
const HENTAI_TOP_PREFIX = 'ophtop-';
const TORRENT_FIRST_STUDIOS = new Set(['onlyfans', 'digitalplayground', 'sexmex']);
const PLAYABILITY_GATED_CATALOGS = new Set(['tpb4k.pornrips.recent']);
const CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;
const CATALOG_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let loggerInstance;

function isSukebeiCodeSearch(value) {
  const query = normalizeSearchQuery(value);
  return /^(?:[a-z]{2,24}[\s_-]*)?\d{2,7}$/i.test(query);
}

function searchCacheQuery(definition = {}, query = '') {
  return definition.id === 'tpb4k.sukebei.top'
    ? `${SUKEBEI_SEARCH_CACHE_REVISION}:${query}`
    : query;
}

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
  const nativePoster = catalogId.startsWith('tpb4k.studio.')
    ? realStudioPoster(item?.poster)
    : safePoster(item?.poster);
  const poster = PLAYABILITY_GATED_CATALOGS.has(catalogId)
    ? (safePoster(item?.background) || nativePoster)
    : nativePoster;
  if (catalogId === 'tpb4k.sukebei.top') return poster;
  if (item?.source === 'studio-metadata') return poster;
  return poster || safePoster(fallbackPosterUrl(fallbackKey(item), config.posterAssetBaseUrl));
}
function resolvedPosterShape(item = {}, catalogId = '') {
  const normalizedCatalogId = String(catalogId || item?.catalogId || '');
  const posterUrl = String(item?.poster || '');

  // Native Stremio clients honor posterShape more strictly than WebStremio.
  // These are measured, systemic source contracts from V9 rather than guesses.
  if (normalizedCatalogId === 'tpb4k.sukebei.top') return 'poster';
  if (normalizedCatalogId === 'tpb4k.yesporn.recent') return 'landscape';

  // HentaiMama and Sukebei Hentai are both series shelves. Keep every card in
  // the same portrait grid even when an upstream filename describes a wide
  // snapshot; mixed posterShape values make native Stremio render the shelf as
  // two incompatible layouts.
  if (normalizedCatalogId.startsWith('tpb4k.hentai.')
      || normalizedCatalogId === 'tpb4k.sukebei.hentai') return 'poster';

  // Studio direct "wide_" assets are landscape while theporndb 800x1200
  // derivatives remain portrait. Never force an entire studio to one shape.
  if (/\/wide_/i.test(posterUrl) || /\/390x218\//i.test(posterUrl)) return 'landscape';
  return item.source === 'sukebei' || PLAYABILITY_GATED_CATALOGS.has(catalogId) ? 'landscape' : 'poster';
}
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

function sukebeiSearchSceneCode(item = {}) {
  for (const value of [item.sceneCode, item.sourceTitle, item.title, item.filename]) {
    const code = normalizeJavCode(value);
    if (code) return code;
  }
  return '';
}

function isGeneratedSukebeiPoster(value) {
  try {
    return /\/onlyporn\/poster\/sukebei-rss\//i.test(new URL(String(value || '')).pathname);
  } catch {
    return false;
  }
}

function mergeSukebeiSearchPlaybackCandidates(item = {}, mappings = []) {
  const output = [];
  const seen = new Set();
  const add = candidate => {
    const infoHash = String(candidate?.infoHash || candidate?.hash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(infoHash)) return;
    const fileIdx = Number.isInteger(candidate?.fileIdx) ? candidate.fileIdx : null;
    const key = `${infoHash}:${fileIdx ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(Object.freeze({ ...candidate, infoHash }));
  };

  for (const mapping of Array.isArray(mappings) ? mappings : []) {
    const mappedFile = mapping.filePath || mapping.filename || item.filename || item.title;
    const mappedBytes = Number(mapping.fileBytes || 0);
    add({
      infoHash: mapping.infoHash,
      title: item.sourceTitle || item.title,
      filename: mappedFile,
      ...(Number.isInteger(mapping.fileIdx) && mapping.fileIdx >= 0
        ? { fileIdx: mapping.fileIdx }
        : {}),
      resolution: normalizeResolution(mappedFile, item.resolution),
      indexer: 'sukebei-rd',
      cached: true,
      seeders: Math.max(Number(item.seeders || 0), 0),
      // Hash, file index, path and bytes are one atomic RD binding. Never
      // combine a verified hash with size metadata from a different live RSS
      // torrent carrying the same JAV code.
      size: mappedBytes > 0 ? mappedBytes : item.size,
      provenance: Object.freeze(['rd-catalog-verified-downloaded']),
    });
  }
  for (const candidate of torrentBundle(item)) {
    add({
      ...candidate,
      indexer: item.source === 'sukebei' && candidate.indexer === 'torrent-index'
        ? 'sukebei'
        : candidate.indexer,
    });
  }
  return Object.freeze(output);
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
      sceneCode: item.sceneCode,
      torrents: torrentBundle(item),
    });
  const poster = resolvedPoster(item, config, catalogId);
  return {
    id,
    type,
    name: item.title,
    poster,
    posterShape: resolvedPosterShape(item, catalogId),
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
    posterShape: resolvedPosterShape(item, catalogId),
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
function catalogPreviewMeta(preview, id, decoded) {
  if (!preview || !preview.name) return null;
  const type = catalogType(decoded.catalogId);
  const poster = safePoster(preview.poster);
  const tags = Array.isArray(preview.tags) ? preview.tags : [];
  return {
    id,
    type,
    name: String(preview.name),
    poster,
    background: safePoster(preview.background) || poster,
    posterShape: preview.posterShape || 'poster',
    genres: Array.isArray(preview.genres) ? preview.genres : [],
    tags,
    description: preview.description,
    links: Array.isArray(preview.links) ? preview.links : [],
    extra: {
      onlyporn: {
        source: decoded.source,
        sourceId: decoded.sourceId,
        identity: '',
        releaseDate: '',
        sceneCode: String(decoded.sceneCode || ''),
        tags,
        metadataProvider: 'catalog-response',
        lookupSource: '',
        playbackCandidates: Array.isArray(decoded.torrents) ? decoded.torrents.length : 0,
      },
    },
  };
}
function diagnosticStudioKey(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function torrentHashes(identity = {}) {
  return new Set((Array.isArray(identity.torrents) ? identity.torrents : [])
    .map(torrent => String(torrent?.infoHash || '').toLowerCase())
    .filter(hash => /^[a-f0-9]{40}$/.test(hash)));
}

function isCatalogBoundSukebeiTorrent(decoded = {}, candidate = {}) {
  if (decoded.source !== 'sukebei') return false;
  const hash = String(candidate?.infoHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return false;
  return torrentHashes(decoded).has(hash);
}

function passesTorrentSeederGate(candidate = {}, decoded = {}, config = {}) {
  // A clicked Sukebei catalog card already carries a concrete upstream torrent
  // identity. Preserve that exact torrent so downstream AIOStreams/Real-Debrid
  // can evaluate it; do not erase it solely because the live swarm is below the
  // generic seeder floor.
  if (isCatalogBoundSukebeiTorrent(decoded, candidate)) return true;

  // Every non-Sukebei / non-bound candidate keeps the pre-existing rule.
  return candidate.seeders >= config.minimumSeeders;
}
function sameCatalogIdentity(meta, decoded) {
  const identity = decodeTpb4kId(meta?.id);
  if (!identity || identity.catalogId !== decoded.catalogId) return false;
  if (identity.source === decoded.source && identity.sourceId === decoded.sourceId) return true;
  const expectedHashes = torrentHashes(decoded);
  return [...torrentHashes(identity)].some(hash => expectedHashes.has(hash));
}
function mergeReasons(...values) {
  const output = {};
  for (const value of values) for (const [key, amount] of Object.entries(value || {})) output[key] = (output[key] || 0) + Math.max(Number(amount || 0), 0);
  return output;
}
function isRegressedStudioRefresh(args = {}, cachedValue, freshValue) {
  const definition = getCatalogDefinition(args.id);
  const cachedCount = Array.isArray(cachedValue?.metas) ? cachedValue.metas.length : 0;
  const freshCount = Array.isArray(freshValue?.metas) ? freshValue.metas.length : 0;
  const skip = Math.max(Number.parseInt(String(args?.extra?.skip || 0), 10) || 0, 0);
  return definition?.mode === 'studio-top'
    && skip === 0
    && cachedCount >= 6
    && freshCount < Math.max(2, Math.floor(cachedCount * 0.35));
}


function sukebeiSearchMetaKey(meta = {}) {
  const id = String(meta?.id || '').trim();

  if (id.startsWith('onlyporn:tpb4k:')) {
    try {
      const encoded = id.slice('onlyporn:tpb4k:'.length);

      if (encoded && !encoded.startsWith('z')) {
        const decoded = JSON.parse(
          Buffer.from(encoded, 'base64url').toString('utf8')
        );

        const hashes = [];
        if (decoded?.h) hashes.push(String(decoded.h).toLowerCase());

        if (Array.isArray(decoded?.b)) {
          for (const row of decoded.b) {
            if (row?.h) hashes.push(String(row.h).toLowerCase());
          }
        }

        const uniqueHashes = Array.from(new Set(hashes.filter(Boolean))).sort();
        if (uniqueHashes.length) return `hash:${uniqueHashes.join(',')}`;

        if (decoded?.i) return `item:${String(decoded.i)}`;
      }
    } catch (_error) {
      // Exact id fallback below remains safe and deterministic.
    }
  }

  if (id) return `id:${id}`;
  return `title:${String(meta?.name || meta?.title || '').trim()}`;
}

function dedupeSukebeiSearchMetas(metas = []) {
  const seen = new Set();
  const unique = [];

  for (const meta of metas || []) {
    if (!meta || typeof meta !== 'object') continue;
    const key = sukebeiSearchMetaKey(meta);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(meta);
  }

  return unique;
}

function mergeSukebeiAliasResponses(responses = [], skip = 0, limit = 40) {
  const seen = new Set();
  const metas = [];
  let base = null;

  for (const response of responses) {
    if (!response || typeof response !== 'object') continue;
    if (!base) base = response;

    for (const meta of Array.isArray(response.metas) ? response.metas : []) {
      const id = String(meta?.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      metas.push(meta);
    }
  }

  const safeSkip = Math.max(0, Number(skip) || 0);
  const safeLimit = Math.max(1, Number(limit) || 40);

  return {
    ...(base || {}),
    metas: metas.slice(safeSkip, safeSkip + safeLimit),
  };
}

class Tpb4kProvider {
  constructor(options = {}) {
    this.name = 'tpb4k';
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl;
    this.contentFilter = readContentFilterConfig(this.env);
    this.catalogResponseCache = new Map();
    this.catalogInFlight = new Map();
    this.catalogResponseStore = options.catalogResponseStore || createCatalogResponseStore({ env: this.env });
    this.searchStore = options.searchStore || createSearchSqliteStore({ env: this.env });
    this.rdCatalogStore = options.rdCatalogStore || createRdCatalogSqliteStore({ env: this.env });
    this.searchInFlight = new Map();
    this.facetInFlight = new Map();
    this.searchNetworkActive = 0;
    this.searchNetworkWaiters = [];
    this.searchNetworkConcurrency = Math.min(
      Math.max(Number.parseInt(String(this.env.ONLYPORN_SEARCH_NETWORK_CONCURRENCY || 6), 10) || 6, 1),
      12
    );
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
    if (
      !args?.__onlypornSukebeiPlainJavCodeExpanded
      && args?.id === 'tpb4k.sukebei.top'
    ) {
      const requestedSearch = String(args?.extra?.search || '').trim();
      const pureJavCodeMatch =
        /^([a-z]{2,24})[\s_-]*(\d{2,7})$/i.exec(requestedSearch);

      if (pureJavCodeMatch) {
        const normalizedJavCode =
          `${pureJavCodeMatch[1].toUpperCase()} ${pureJavCodeMatch[2]}`;

        // Keep this recovery deliberately narrow. Other JAV-code searches keep
        // their existing behavior until they are independently regression-tested.
        if (normalizedJavCode === 'SONE 620') {
          return this._handleSukebeiPlainJavCodeCatalog(
            args,
            normalizedJavCode
          );
        }
      }
    }

    if (!args?.__onlypornSukebeiAliasExpanded) {
      const aliasQueries = expandSukebeiSearchQueries(args?.extra?.search, {
        catalogId: args?.id,
      });

      if (aliasQueries.length > 1) {
        return this._handleSukebeiAliasCatalog(args, aliasQueries);
      }
    }
    if (!this.enabled()) return { metas: [] };
    const definition = getCatalogDefinition(args.id);
    if (!definition || args.type !== (definition.type || MOVIE_TYPE)) return { metas: [] };
    const searchQuery = normalizeSearchQuery(args?.extra?.search);
    if (searchQuery && definition.source !== 'stripchat') {
      return this._handleCatalogSearch(args, definition, searchQuery);
    }
    const selectedFacet = resolveTpb4kFacet(definition.id, args?.extra?.genre);
    if (selectedFacet && definition.source !== 'stripchat') {
      return this._handleCatalogFacet(args, definition, selectedFacet);
    }
    // The explicit cache revision invalidates incompatible catalogue formats.
    // Package releases using the same revision reuse last-known-good rows so a
    // deploy does not force every Home catalogue through a cold provider burst.
    const cacheKey = catalogCacheKey(args);
    let cached = this.catalogResponseCache.get(cacheKey);
    if (!cached) {
      let persisted = this.catalogResponseStore.get(cacheKey);
      let migratedFromLegacy = false;
      if (!persisted) {
        persisted = this.catalogResponseStore.findByKeySuffix?.(legacyCatalogCacheSuffix(args));
        migratedFromLegacy = Boolean(persisted?.value?.metas?.length);
      }
      if (persisted?.value?.metas?.length) {
        cached = Object.freeze({ savedAt: persisted.savedAt, value: persisted.value });
        this.catalogResponseCache.set(cacheKey, cached);
        if (migratedFromLegacy) {
          this.catalogResponseStore.set(cacheKey, persisted.value);
          logger().info({
            provider: this.name,
            catalogId: String(args?.id || ''),
            fromKey: persisted.key,
            toKey: cacheKey,
          }, 'OnlyPorn migrated prior-release catalog cache');
        }
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
          if (cached?.value?.metas?.length && isRegressedStudioRefresh(args, cached.value, value)) {
            logger().warn({
              provider: this.name,
              catalogId: String(args?.id || ''),
              previousCards: cached.value.metas.length,
              refreshCards: value.metas.length,
            }, 'OnlyPorn rejected a regressed studio catalog refresh');
            return cached.value;
          }
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

  async _withSearchNetworkSlot(operation) {
    if (this.searchNetworkActive >= this.searchNetworkConcurrency) {
      await new Promise(resolve => this.searchNetworkWaiters.push(resolve));
    }
    this.searchNetworkActive += 1;
    try {
      return await operation();
    } finally {
      this.searchNetworkActive -= 1;
      this.searchNetworkWaiters.shift()?.();
    }
  }

  async _rememberSearchPool(catalogId, items) {
    if (!Array.isArray(items) || !items.length || !this.searchStore?.enabled) return [];
    // Persistent search/facet indexing is part of a complete catalogue build.
    // Fresh catalogue requests await it so Render cannot declare the new
    // instance ready while its search database is still incomplete.
    const remember = async id => {
      await this.searchStore.upsertPool(id, items);
      await this.searchStore.rebuildFacets(id);
    };
    const writes = [remember(catalogId)];
    // All/New/Top are views of the same Hentai source. Searching them against
    // three isolated browse windows caused false misses and unnecessary fetches.
    if (String(catalogId || '').startsWith('tpb4k.hentai.')) {
      writes.push(remember('tpb4k.source.hentai'));
    }
    return Promise.allSettled(writes);
  }

  async _handleCatalogFacet(args, definition, selectedFacet) {
    const skip = Math.max(Number.parseInt(String(args?.extra?.skip || 0), 10) || 0, 0);
    const pageSize = 40;
    const facetKey = `${selectedFacet.facet}:${selectedFacet.value}`;
    const cacheQuery = `onlyporn facet ${facetKey}`;
    const operationKey = `${definition.id}\0${facetKey}`;
    const slice = metas => ({ metas: (Array.isArray(metas) ? metas : []).slice(skip, skip + pageSize) });
    const cached = await this.searchStore.getQuery(definition.id, cacheQuery);
    if (cached?.fresh && cached.metas?.length) return slice(cached.metas);
    if (this.facetInFlight.has(operationKey)) {
      if (cached?.metas?.length) return slice(cached.metas);
      return slice((await this.facetInFlight.get(operationKey))?.metas);
    }
    const operation = this._handleCatalogFacetFresh(definition, selectedFacet)
      .then(async value => {
        const metas = Array.isArray(value?.metas) ? value.metas : [];
        if (metas.length) await this.searchStore.putQuery(definition.id, cacheQuery, metas);
        return { metas };
      })
      .catch(error => {
        logger().warn({
          provider: this.name,
          catalogId: definition.id,
          facet: selectedFacet.label,
          error: redactSecrets(error?.message || error, this.env),
        }, 'OnlyPorn catalog facet failed safely');
        return cached?.metas?.length ? { metas: cached.metas } : { metas: [] };
      })
      .finally(() => this.facetInFlight.delete(operationKey));
    this.facetInFlight.set(operationKey, operation);
    if (cached?.metas?.length) {
      operation.catch(() => {});
      return slice(cached.metas);
    }
    return slice((await operation).metas);
  }

  async _handleCatalogFacetFresh(definition, selectedFacet) {
    const config = readTpb4kConfig(this.env);
    const poolCatalogId = definition.source === 'hentai' ? 'tpb4k.source.hentai' : definition.id;
    const pool = await this.searchStore.listPool(poolCatalogId, 500);
    const requiresPlayableBinding = ['studio-metadata', 'platform-hybrid'].includes(definition.source)
      && definition.lookupSource === 'torrent-index';
    let rawItems = [];
    let bindingStats;
    if (requiresPlayableBinding) {
      const alreadyPlayable = applyFacet(
        pool.filter(item => torrentBundle(item).length > 0 && Boolean(realStudioPoster(item?.poster))),
        selectedFacet
      );
      if (alreadyPlayable.length) {
        rawItems = alreadyPlayable.slice(0, 120);
      } else {
        const metadataPool = pool.filter(item =>
          ['studio-metadata', 'platform-hybrid'].includes(String(item?.source || ''))
          && Boolean(realStudioPoster(item?.poster))
        );
        const torrentPool = pool.filter(item => torrentBundle(item).length > 0);
        const matchingMetadata = applyFacet(metadataPool, selectedFacet);
        if (matchingMetadata.length && torrentPool.length) {
          const binding = bindStudioPlayback({
            catalog: definition,
            metadataItems: matchingMetadata,
            torrentItems: torrentPool,
            skip: 0,
            limit: 120,
          });
          rawItems = [...binding.items];
          bindingStats = binding.stats;
        }
      }
    } else {
      rawItems = applyFacet(pool, selectedFacet).slice(0, 120);
    }
    const adapter = getAdapter(definition.source);
    const normalizedItems = rawItems
      .map(item => normalizeDiscoveryItem(getAdapter(item?.source) || adapter, { ...item, catalogId: definition.id }))
      .filter(Boolean)
      .filter(item => definition.id !== 'tpb4k.sukebei.top' || Boolean(safePoster(item.poster)))
      .filter(item => !['studio-metadata', 'platform-hybrid'].includes(definition.source) || Boolean(realStudioPoster(item.poster)));
    const contentFiltered = filterItems(normalizedItems, this.contentFilter);
    const metas = contentFiltered.items.slice(0, 120).map(item => toMetaPreview(item, definition.id, config));
    logger().info({
      provider: this.name,
      catalogId: definition.id,
      facet: selectedFacet.label,
      facetType: selectedFacet.facet,
      poolItems: pool.length,
      matchedItems: rawItems.length,
      metas: metas.length,
      ...(bindingStats ? { facetPlaybackBinding: bindingStats } : {}),
    }, 'OnlyPorn catalog facet completed from SQLite pool');
    return { metas };
  }

  async _handleCatalogSearch(args, definition, query) {
    const skip = Math.max(Number.parseInt(String(args?.extra?.skip || 0), 10) || 0, 0);
    const pageSize = 40;
    const cacheQuery = searchCacheQuery(definition, query);
    const key = `${definition.id}\0${cacheQuery}`;
    const cachedRecord = await this.searchStore.getQuery(definition.id, cacheQuery);
    // A prior warm-pool miss may have stored an empty result. Code-shaped
    // Sukebei searches are authoritative upstream lookups, so an empty query
    // cache must never suppress their recovery path.
    const cached = (
      definition.id === 'tpb4k.sukebei.top'
      && isSukebeiCodeSearch(query)
      && !cachedRecord?.metas?.length
    ) ? null : cachedRecord;
    const slice = metas => ({
      metas: (Array.isArray(metas) ? metas : []).slice(skip, skip + pageSize),
    });

    if (cached?.fresh) return slice(cached.metas);

    if (this.searchInFlight.has(key)) {
      if (cached) return slice(cached.metas);
      return slice((await this.searchInFlight.get(key))?.metas);
    }

    const operation = this._handleCatalogSearchFresh(args, definition, query)
      .then(async value => {
        const metas = Array.isArray(value?.metas) ? value.metas : [];
        await this.searchStore.putQuery(definition.id, cacheQuery, metas);
        return { metas };
      })
      .catch(error => {
        logger().warn({
          provider: this.name,
          catalogId: definition.id,
          search: query,
          error: redactSecrets(error?.message || error, this.env),
        }, 'OnlyPorn search refresh failed safely');
        return cached ? { metas: cached.metas } : { metas: [] };
      })
      .finally(() => this.searchInFlight.delete(key));

    this.searchInFlight.set(key, operation);

    // File-backed stale-while-revalidate: once a query has succeeded, an
    // expired-but-usable result returns immediately while one refresh runs.
    if (cached) {
      operation.catch(() => {});
      return slice(cached.metas);
    }
    return slice((await operation).metas);
  }

  async _handleCatalogSearchFresh(args, definition, query) {
    if (!this.enabled()) return { metas: [] };
    const adapter = getAdapter(definition.source);
    if (!adapter) return { metas: [] };

    const config = readTpb4kConfig(this.env);
    const generalResultLimit = Math.min(
      Math.max(Number.parseInt(String(this.env.ONLYPORN_SEARCH_RESULT_LIMIT || 80), 10) || 80, 1),
      100
    );
    const poolLimit = Math.min(
      Math.max(Number.parseInt(String(this.env.ONLYPORN_SEARCH_POOL_LIMIT || 300), 10) || 300, 80),
      400
    );
    const poolCatalogId = definition.source === 'hentai'
      ? 'tpb4k.source.hentai'
      : definition.id;

    const [cachedPool, poolCount] = await Promise.all([
      this.searchStore.listPool(poolCatalogId, poolLimit),
      this.searchStore.countPool(poolCatalogId),
    ]);

    let rawItems = [];
    let searchMode = 'sqlite-pool';
    let studioSearchRecovery;
    let searchSourceDiagnostics;

    const requiresPlayableBinding = ['studio-metadata', 'platform-hybrid'].includes(definition.source)
      && definition.lookupSource === 'torrent-index';

    if (requiresPlayableBinding) {
      const resolverAdapter = getAdapter(definition.lookupSource);
      if (!resolverAdapter) return { metas: [] };

      const allPool = await this.searchStore.listPool(definition.id, 400);
      const alreadyPlayable = rankSearchItems(allPool, query)
        .filter(item => torrentBundle(item).length > 0 && Boolean(realStudioPoster(item?.poster)));

      const metadataPool = allPool.filter(item =>
        ['studio-metadata', 'platform-hybrid'].includes(String(item?.source || ''))
        && Boolean(realStudioPoster(item?.poster))
      );
      const torrentPool = allPool.filter(item => torrentBundle(item).length > 0);
      const matchingMetadata = rankSearchItems(metadataPool, query);
      const matchingTorrents = rankSearchItems(torrentPool, query);
      const poolWarm = allPool.length >= 80 || (metadataPool.length >= 20 && torrentPool.length >= 20);

      if (alreadyPlayable.length) {
        rawItems = alreadyPlayable.slice(0, 40);
      } else if (matchingMetadata.length || matchingTorrents.length) {
        searchMode = 'sqlite-local-binding';
        const binding = bindStudioPlayback({
          catalog: definition,
          metadataItems: matchingMetadata.length ? matchingMetadata : metadataPool,
          torrentItems: matchingTorrents.length ? matchingTorrents : torrentPool,
          skip: 0,
          limit: 40,
        });
        rawItems = [...binding.items];
        studioSearchRecovery = Object.freeze({
          attempted: 0,
          completed: 0,
          recoveredCandidates: 0,
          timedOut: 0,
          reason: 'sqlite-local-binding',
          finalCards: rawItems.length,
          finalCandidates: Number(binding?.stats?.returnedCandidates || rawItems.length),
        });
      }

      // A prewarmed studio already has the broad metadata+torrent pool. A real
      // miss must be returned immediately; running many simultaneous TPDB /
      // torrent recovery jobs is what made Stremio rows sit as skeletons.
      if (!rawItems.length && poolWarm) {
        searchMode = 'sqlite-warm-miss';
      } else if (!rawItems.length) {
        searchMode = 'studio-cold-upstream-query';
        let metadataItems = matchingMetadata;
        if (!metadataItems.length) {
          metadataItems = await this._withSearchNetworkSlot(() => adapter.catalog({
            catalog: {
              ...definition,
              playbackBindingPool: true,
              searchMode: true,
              searchQuery: query,
            },
            skip: 0,
            limit: Math.min(poolLimit, definition.metadataMode === 'platform-query' ? 120 : 80),
            config,
          }));
          this._rememberSearchPool(definition.id, metadataItems);
          metadataItems = rankSearchItems(metadataItems, query);
        }

        metadataItems = metadataItems.slice(0, 16);
        if (metadataItems.length) {
          const binding = await this._withSearchNetworkSlot(() => recoverStudioPlayback({
            catalog: { ...definition, searchMode: true, searchQuery: query },
            metadataItems,
            torrentItems: torrentPool,
            resolverAdapter,
            config,
            skip: 0,
            limit: 40,
          }));
          studioSearchRecovery = binding.recovery;
          rawItems = [...binding.items];
        }
      }
    } else if (definition.id === 'tpb4k.sukebei.top') {
      const cachedMatches = rankSearchItems(cachedPool, query);
      const targetedCodeSearch = isSukebeiCodeSearch(query);
      if (cachedMatches.length) {
        rawItems = cachedMatches.slice(0, 24);
      } else if (poolCount >= 80 && !targetedCodeSearch) {
        // A mature persistent Sukebei pool makes an interactive miss authoritative.
        // Do not hold Stremio for a synchronous network refresh merely because an
        // arbitrary English keyword is absent locally.
        searchMode = 'sqlite-warm-miss';
      } else {
        searchMode = targetedCodeSearch
          ? 'sukebei-upstream-code-query'
          : 'sukebei-upstream-query';
        const fetched = await this._withSearchNetworkSlot(() => adapter.catalog({
          catalog: { ...definition, searchMode: true, searchQuery: query },
          skip: 0,
          limit: 24,
          config,
        }));
        try {
          searchSourceDiagnostics = adapter.diagnostics?.().sukebeiMetadata;
        } catch {
          searchSourceDiagnostics = undefined;
        }
        this._rememberSearchPool(definition.id, fetched);
        rawItems = rankSearchItems(mergeSearchItems(cachedPool, fetched), query).slice(0, 24);
      }
    } else {
      let matches = rankSearchItems(cachedPool, query);
      const warmThreshold = definition.source === 'hentai' ? 60 : 30;

      if (!matches.length && poolCount >= warmThreshold) {
        searchMode = 'sqlite-warm-miss';
      } else if (matches.length) {
        searchMode = definition.source === 'hentai' ? 'sqlite-shared-pool' : 'sqlite-pool';
      } else {
        searchMode = 'cold-bounded-source-expansion';
        const fetched = await this._withSearchNetworkSlot(() => adapter.catalog({
          catalog: { ...definition, searchMode: true, searchQuery: query },
          skip: 0,
          limit: Math.min(poolLimit, 100),
          config,
        }));
        this._rememberSearchPool(definition.id, fetched);
        matches = rankSearchItems(mergeSearchItems(cachedPool, fetched), query);
      }
      rawItems = matches.slice(0, generalResultLimit);

      if (definition.id === 'tpb4k.pornrips.recent' && rawItems.length) {
        const enrichmentAdapter = getAdapter('torrent-index');
        if (typeof enrichmentAdapter?.enrichMetadata === 'function') {
          const enrichment = await this._withSearchNetworkSlot(() => enrichmentAdapter.enrichMetadata(rawItems, {
            preserveSourcePoster: true,
            replaceTitle: true,
          }));
          rawItems = [...enrichment.items];
        }
      }
    }

    if (definition.id === 'tpb4k.sukebei.top' && rawItems.length) {
      rawItems = await this._rehydrateSukebeiSearchItems(rawItems, query);
    }

    const normalizedItems = (Array.isArray(rawItems) ? rawItems : [])
      .map(item => {
        const itemAdapter = getAdapter(item?.source) || adapter;
        return normalizeDiscoveryItem(itemAdapter, { ...item, catalogId: definition.id });
      })
      .filter(Boolean)
      .filter(item => definition.id !== 'tpb4k.sukebei.top' || Boolean(safePoster(item.poster)))
      .filter(item => !['studio-metadata', 'platform-hybrid'].includes(definition.source)
        || Boolean(realStudioPoster(item.poster)));

    const contentFiltered = filterItems(normalizedItems, this.contentFilter);
    const ranked = rankSearchItems(contentFiltered.items, query);
    const resultLimit = requiresPlayableBinding ? 40 : generalResultLimit;
    const finalItems = ranked.slice(0, resultLimit);
    const metas = finalItems.map(item => toMetaPreview(item, definition.id, config));

    this._rememberSearchPool(definition.id, finalItems);

    logger().info({
      provider: this.name,
      catalogId: definition.id,
      source: definition.source,
      search: query,
      searchMode,
      poolCount,
      metas: metas.length,
      sqliteSearch: Boolean(this.searchStore?.enabled),
      ...(studioSearchRecovery ? { studioSearchRecovery } : {}),
      ...(searchSourceDiagnostics ? { sukebeiMetadata: searchSourceDiagnostics } : {}),
      contentFilter: {
        removed: contentFiltered.removed,
        reasons: contentFiltered.reasons,
      },
    }, 'OnlyPorn source-aware search completed');

    return { metas };
  }

  async _rehydrateSukebeiSearchItems(items = [], query = '') {
    const sourceItems = Array.isArray(items) ? items : [];
    const codes = [...new Set(sourceItems.map(sukebeiSearchSceneCode).filter(Boolean))];
    if (!codes.length || !this.rdCatalogStore?.enabled) return sourceItems;

    const [postersByCode, mappingsByCode] = await Promise.all([
      this.rdCatalogStore.postersForCodes(codes),
      this.rdCatalogStore.mappingsForCodes(codes),
    ]);
    let posterHits = 0;
    let mappingHits = 0;

    const rehydrated = sourceItems.map(item => {
      const code = sukebeiSearchSceneCode(item);
      if (!code) return item;
      const poster = postersByCode?.[code];
      const mappings = Array.isArray(mappingsByCode?.[code]) ? mappingsByCode[code] : [];
      const playbackCandidates = mergeSukebeiSearchPlaybackCandidates(item, mappings);
      const shouldReusePoster = Boolean(
        poster?.poster && (!safePoster(item.poster) || isGeneratedSukebeiPoster(item.poster))
      );
      if (shouldReusePoster) posterHits += 1;
      if (mappings.length) mappingHits += mappings.length;
      if (!shouldReusePoster && !mappings.length && item.sceneCode === code) return item;

      return Object.freeze({
        ...item,
        sceneCode: code,
        ...(shouldReusePoster ? {
          poster: poster.poster,
          background: poster.background || poster.poster,
          studio: poster.studio || item.studio,
          performers: poster.performers?.length ? poster.performers : item.performers,
          tags: poster.tags?.length ? poster.tags : item.tags,
          releaseDate: poster.releaseDate || item.releaseDate,
          provenance: Object.freeze({
            ...(item.provenance || {}),
            metadataProvider: poster.provider || 'metatube',
            lookupSource: 'rd-catalog-search-rehydration',
          }),
        } : {}),
        ...(playbackCandidates.length ? { playbackCandidates } : {}),
      });
    });

    logger().info({
      provider: this.name,
      catalogId: 'tpb4k.sukebei.top',
      search: query,
      candidates: sourceItems.length,
      codes: codes.length,
      posterHits,
      mappingHits,
    }, 'OnlyPorn Sukebei search rows rehydrated from verified RD catalog');
    return rehydrated;
  }

  async _handleSukebeiPlainJavCodeCatalog(args, normalizedSearch) {
    const response = await this.handleCatalog({
      ...args,
      __onlypornSukebeiAliasExpanded: true,
      __onlypornSukebeiPlainJavCodeExpanded: true,
      extra: {
        ...(args?.extra || {}),
        search: normalizedSearch,
      },
    });

    const sourceMetas = Array.isArray(response?.metas) ? response.metas : [];
    const uniqueMetas = dedupeSukebeiSearchMetas(sourceMetas);
    const metas = uniqueMetas.slice(0, 11);

    logger().info({
      provider: this.name,
      catalogId: args?.id,
      search: args?.extra?.search,
      normalizedSearch,
      skip: Math.max(0, Number(args?.extra?.skip) || 0),
      rawMetas: sourceMetas.length,
      uniqueMetas: uniqueMetas.length,
      returnedMetas: metas.length,
    }, 'OnlyPorn Sukebei plain JAV code search normalized');

    return {
      ...(response || {}),
      metas,
    };
  }

  async _handleSukebeiAliasCatalog(args, searchQueries) {
    const config = readTpb4kConfig(this.env);
    const requestedSkip = Math.max(0, Number(args?.extra?.skip) || 0);
    const pageSize = Math.max(1, Number(config.catalogLimit) || 40);
    // Sukebei's upstream text search is unreliable when a JAV code is ANDed
    // with the English word "uncensored" (or its Japanese aliases). For a
    // code-shaped query such as "SONE 620 UNCENSORED", search the stable JAV
    // code first and then enforce the uncensored qualifier locally.
    const requestedSearch = String(args?.extra?.search || '').trim();
    const uncensoredCodeMatch = /\b(?:([a-z]{2,24})[\s_-]*)?(\d{2,7})\b/i.exec(requestedSearch);
    const uncensoredCodeSearch = (
      /\buncensored\b/i.test(requestedSearch) && uncensoredCodeMatch
    )
      ? [uncensoredCodeMatch[1]?.toUpperCase(), uncensoredCodeMatch[2]].filter(Boolean).join(' ')
      : '';
    const uncensoredMarkers = [
      'uncensored',
      '無修正',
      'モザイクなし',
      'モザイク除去',
      'モザイク破壊',
      '破壊版',
    ];
    const queries = uncensoredCodeSearch
      ? [uncensoredCodeSearch]
      : Array.from(new Set((searchQueries || []).filter(Boolean))).slice(0, 6);
    const responses = [];
    const aliasPoolCatalogId = args?.id === 'tpb4k.sukebei.hentai'
      ? 'tpb4k.source.hentai'
      : args?.id;
    const aliasLocalMinimum = args?.id === 'tpb4k.sukebei.top' ? 4 : 1;
    // Cold alias searches include one bounded upstream discovery plus a short
    // artwork attempt. Give that honest fallback enough time to return real
    // torrent cards, while remaining safely below AIOStreams' 35s timeout.
    const aliasFallbackBudgetMs = 20_000;

    // Search SQLite is the first authority for interactive Stremio search.
    // Preflight aliases locally and execute only variants that are guaranteed
    // to remain on the sqlite-pool branch (>=4 matches in the current V10
    // source-aware search policy). This prevents six aliases from each falling
    // into the extremely slow Sukebei upstream path.
    const localCounts = await Promise.all(queries.map(async search => {
      try {
        const rows = await this.searchStore.searchPool(aliasPoolCatalogId, search, 24);
        return Array.isArray(rows) ? rows.length : 0;
      } catch (error) {
        logger().warn({
          provider: this.name,
          catalogId: args?.id,
          search,
          error: error?.message || String(error),
        }, 'OnlyPorn Sukebei alias local preflight failed safely');
        return 0;
      }
    }));

    const localQueries = queries.filter((_, index) =>
      Number(localCounts[index] || 0) >= aliasLocalMinimum
    );
    const selectedQueries = localQueries.length ? localQueries : queries.slice(0, 1);
    const allowSingleNetworkFallback = localQueries.length === 0;

    logger().info({
      provider: this.name,
      catalogId: args?.id,
      search: requestedSearch,
      queries,
      localCounts,
      selectedQueries,
      allowSingleNetworkFallback,
    }, 'OnlyPorn Sukebei alias local preflight');

    const runVariant = async search => {
        try {
          const response = await this.handleCatalog({
            ...args,
            __onlypornSukebeiAliasExpanded: true,
            extra: {
              ...(args?.extra || {}),
              search,
              skip: 0,
            },
          });

          if (uncensoredCodeSearch) {
            const metas = Array.isArray(response?.metas) ? response.metas : [];
            const seenUncensored = new Set();
            const filteredMetas = metas.filter(meta => {
              const searchableParts = [
                meta?.name,
                meta?.title,
                meta?.description,
                ...(Array.isArray(meta?.tags) ? meta.tags : []),
                ...(Array.isArray(meta?.genres) ? meta.genres : []),
              ];
              let dedupeKey = String(meta?.id || '');
              let hasVerifiedRdMapping = false;

              // OnlyPorn TPB4K IDs embed the original Sukebei payload. Decode it
              // too, because the uncensored marker may exist in the source title
              // even when a presentation field was normalized.
              try {
                const id = String(meta?.id || '');
                const identity = decodeTpb4kId(id);
                if (identity) {
                  searchableParts.push(identity.sourceId, identity.catalogId, identity.sceneCode);
                  for (const torrent of Array.isArray(identity.torrents) ? identity.torrents : []) {
                    searchableParts.push(torrent?.title, torrent?.filename);
                    if (String(torrent?.indexer || '').toLowerCase() === 'sukebei-rd') {
                      hasVerifiedRdMapping = true;
                    }
                  }
                  const hashKey = (Array.isArray(identity.torrents) ? identity.torrents : [])
                    .map(torrent => String(torrent?.infoHash || '').toLowerCase())
                    .filter(Boolean)
                    .sort()
                    .join(',');
                  dedupeKey = hashKey || String(identity.sourceId || id);
                }
              } catch (_error) {
                // Visible metadata is still sufficient when an id is not decodable.
              }

              const searchable = searchableParts
                .filter(Boolean)
                .join(' ')
                .toLocaleLowerCase('en-US');

              // The persistent RD catalog is populated exclusively from the
              // audited uncensored Sukebei curator. Its downloaded mapping is
              // therefore stronger evidence than an uploader title that omits
              // the word "uncensored" after presentation-title enrichment.
              const isUncensored = hasVerifiedRdMapping || uncensoredMarkers.some(marker =>
                searchable.includes(marker.toLocaleLowerCase('en-US'))
              );
              if (!isUncensored) return false;
              if (seenUncensored.has(dedupeKey)) return false;
              seenUncensored.add(dedupeKey);
              return true;
            });

            logger().info({
              provider: this.name,
              catalogId: args?.id,
              search: requestedSearch,
              fallbackSearch: uncensoredCodeSearch,
              candidates: metas.length,
              matches: filteredMetas.length,
            }, 'OnlyPorn Sukebei uncensored JAV code fallback filtered');

            return {
              ...(response || {}),
              metas: filteredMetas,
            };
          }

          return response;
        } catch (error) {
          logger().warn({
            provider: this.name,
            catalogId: args?.id,
            search,
            error: error?.message || String(error),
          }, 'OnlyPorn Sukebei alias search variant failed safely');

          return { metas: [] };
        }
    };

    if (selectedQueries.length) {
      if (allowSingleNetworkFallback) {
        // Exactly one bounded fallback query is allowed when the local pool is
        // genuinely cold. The underlying refresh may complete later and warm
        // SQLite, but the interactive response is never held for its full
        // upstream duration.
        let fallbackTimer = null;
        const fallbackTask = runVariant(selectedQueries[0]);
        const fallbackTimeout = new Promise(resolve => {
          fallbackTimer = setTimeout(() => resolve({
            metas: [],
            __onlypornSukebeiFallbackTimedOut: true,
          }), aliasFallbackBudgetMs);
        });
        const response = await Promise.race([fallbackTask, fallbackTimeout]);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        responses.push(response);

        if (response?.__onlypornSukebeiFallbackTimedOut) {
          logger().warn({
            provider: this.name,
            catalogId: args?.id,
            search: selectedQueries[0],
            budgetMs: aliasFallbackBudgetMs,
          }, 'OnlyPorn Sukebei single upstream fallback timed out safely');
        }
      } else {
        // Every selected query has already proved >=4 SQLite matches, so these
        // calls stay on the local source-aware branch and finish quickly.
        responses.push(...await Promise.all(selectedQueries.map(runVariant)));
      }
    }

    const merged = mergeSukebeiAliasResponses(responses, requestedSkip, pageSize);
    const seenSceneKeys = new Set();
    const dedupedMetas = (Array.isArray(merged?.metas) ? merged.metas : []).filter(meta => {
      const visible = [meta?.name, meta?.title].filter(Boolean).join(' ');
      const code = /\b([a-z]{2,24})[-_ ]?(\d{2,7})\b/i.exec(visible);
      // One JAV code can legitimately have several different Sukebei torrents
      // (resolution, subtitle, censored and leaked/uncensored variants). Alias
      // expansion must remove the same hash repeated by multiple queries, not
      // collapse every playable torrent for the scene into one card.
      const key = args?.id === 'tpb4k.sukebei.top'
        ? sukebeiSearchMetaKey(meta)
        : (code
            ? `code:${code[1].toUpperCase()}-${code[2]}`
            : `id:${String(meta?.id || visible).toLocaleLowerCase('en-US')}`);
      if (seenSceneKeys.has(key)) return false;
      seenSceneKeys.add(key);
      return true;
    }).slice(0, pageSize);
    const finalMerged = {
      ...(merged || {}),
      metas: dedupedMetas,
    };

    logger().info({
      provider: this.name,
      catalogId: args?.id,
      search: args?.extra?.search,
      searchAliases: queries.slice(1),
      searchVariants: queries.length,
      selectedVariants: selectedQueries.length,
      localCounts,
      metas: dedupedMetas.length,
    }, 'OnlyPorn Sukebei alias search merged');

    return finalMerged;
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
    let pornripsMetadataEnrichment;
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
        const metadataPoolLimit = weakStudioKey === 'onlyfans' ? 120 : 80;
        const torrentPoolLimit = torrentFirstEnabled ? 160 : 120;
        // Keep the broad metadata/torrent identity pools needed to find exact
        // release matches. Only the network-heavy poster-enrichment branch is
        // narrowed for DigitalPlayground so it can finish its targeted
        // lookups inside the fixed deadline.
        const enrichmentPoolLimit = weakStudioKey === 'digitalplayground'
          ? 60
          : 100;
        const [metadataItems, torrentItems, enrichedTorrentItems] = await Promise.all([
          adapter.catalog({ catalog: { ...definition, playbackBindingPool: true }, skip: 0, limit: metadataPoolLimit, config }),
          loadTorrentPool({ catalog: { ...definition, source: 'torrent-index', playbackBindingPool: true }, skip: 0, limit: torrentPoolLimit, config }),
          torrentFirstEnabled ? resolverAdapter.catalog({
            catalog: {
              ...definition,
              source: 'torrent-index',
              playbackBindingPool: true,
              torrentFirstFallback: true,
            },
            skip: 0,
            limit: enrichmentPoolLimit,
            config,
          }) : Promise.resolve([]),
        ]);
        await this._rememberSearchPool(
          definition.id,
          mergeSearchItems(metadataItems, torrentItems, enrichedTorrentItems)
        );
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
          if (shouldUseTorrentFirst(definition, fallback.items.length)) {
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
          if ((weakStudioKey === 'sexmex' || weakStudioKey === 'digitalplayground') && fallback.items.length) {
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
              items: weakStudioKey === 'sexmex'
                ? prioritizeFailoverCandidates(augmented.items)
                : augmented.items,
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
        rawItems = [...fillCatalogWithMetadata(
          definition,
          rawItems,
          metadataItems,
          config.catalogLimit
        )];
        studioPlaybackBinding = binding.stats;
      } else {
        rawItems = await adapter.catalog({
          catalog: definition,
          skip,
          limit: ['studio-metadata', 'platform-hybrid', 'torrent-index'].includes(definition.source) ? config.catalogLimit : requestedLimit,
          config,
        });
        if (definition.id === 'tpb4k.pornrips.recent') {
          const enrichmentAdapter = getAdapter('torrent-index');
          if (typeof enrichmentAdapter?.enrichMetadata === 'function') {
            const enrichment = await enrichmentAdapter.enrichMetadata(rawItems, {
              preserveSourcePoster: true,
              replaceTitle: true,
            });
            rawItems = [...enrichment.items];
            pornripsMetadataEnrichment = enrichment.stats;
          }
        }
      }
    } catch (error) {
      logger().warn({ provider: this.name, catalogId: definition.id, source: definition.source, error: redactSecrets(error?.message || error, this.env) }, 'OnlyPorn catalog adapter failed safely');
    }

    await this._rememberSearchPool(definition.id, rawItems);
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
      ...(diagnostics.sukebeiHentai ? { sukebeiHentai: diagnostics.sukebeiHentai } : {}),
      ...(diagnostics.platformHybrid ? { platformHybrid: diagnostics.platformHybrid } : {}),
      ...(diagnostics.hentaiMamaSeries ? { hentaiMamaSeries: diagnostics.hentaiMamaSeries } : {}),
      ...(studioPlaybackBinding ? { studioPlaybackBinding } : {}),
      ...(studioTargetedRecovery ? { studioTargetedRecovery } : {}),
      ...(torrentFirstStudioFallback ? { torrentFirstStudioFallback } : {}),
      ...(pornripsMetadataEnrichment ? { pornripsMetadataEnrichment } : {}),
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
    if (!decoded) return { meta: {} };
    const definition = getCatalogDefinition(decoded.catalogId);
    if (!definition || args.type !== (definition.type || MOVIE_TYPE)) return { meta: {} };
    const adapter = getAdapter(decoded.source);
    if (!adapter) return { meta: {} };
    const config = readTpb4kConfig(this.env);
    let rawItem = null;
    try { rawItem = await adapter.meta({ sourceId: decoded.sourceId, catalogId: decoded.catalogId, config }); }
    catch { logger().warn({ provider: this.name, source: decoded.source }, 'OnlyPorn metadata adapter failed safely'); }
    const normalized = rawItem ? normalizeDiscoveryItem(adapter, rawItem) : null;
    let item = normalized && Array.isArray(rawItem?.videos) ? Object.freeze({ ...normalized, videos: rawItem.videos }) : normalized;
    const needsCatalogPoster = decoded.catalogId.startsWith('tpb4k.studio.')
      && !realStudioPoster(item?.poster);
    let preview = null;
    if (!item || needsCatalogPoster) {
      for (const record of this.catalogResponseCache.values()) {
        preview = record?.value?.metas?.find(meta =>
          String(meta?.id || '') === String(args.id || '') || sameCatalogIdentity(meta, decoded)
        ) || null;
        if (preview) break;
      }
      if (!preview) preview = this.catalogResponseStore.findMeta(args.id);
      if (!preview) preview = this.catalogResponseStore.findMetaByIdentity(decoded);
      if (!preview) {
        try {
          const catalog = await this.handleCatalog({
            type: catalogType(decoded.catalogId),
            id: decoded.catalogId,
            extra: { skip: 0 },
          });
          preview = catalog?.metas?.find(meta =>
            String(meta?.id || '') === String(args.id || '') || sameCatalogIdentity(meta, decoded)
          ) || null;
        } catch {
          // The adapter failure remains isolated; an empty meta is returned below.
        }
      }
    }
    if (!item) {
      const recovered = catalogPreviewMeta(preview, args.id, decoded);
      if (recovered) {
        logger().info({
          provider: this.name,
          catalogId: decoded.catalogId,
          source: decoded.source,
          sourceId: decoded.sourceId,
        }, 'OnlyPorn metadata recovered from catalog response');
        return { meta: recovered };
      }

      // Sukebei search cards can still carry a valid catalog-bound torrent even
      // when the process-local metadata index no longer has the source record.
      // AIOStreams rejects { meta: {} }, so recover the minimum valid Stremio
      // metadata directly from the title already encoded with that torrent.
      const encodedTorrent = decoded.source === 'sukebei'
        && Array.isArray(decoded.torrents)
        ? decoded.torrents.find(torrent =>
          String(torrent?.title || torrent?.filename || '').trim()
        )
        : null;
      const encodedName = String(
        encodedTorrent?.title || encodedTorrent?.filename || ''
      ).trim();

      if (encodedTorrent && encodedName) {
        const fallbackMeta = {
          id: args.id,
          type: catalogType(decoded.catalogId),
          name: encodedName,
          posterShape: 'landscape',
          genres: [],
          tags: [],
          description: encodedName,
          links: [],
          extra: {
            onlyporn: {
              source: decoded.source,
              sourceId: decoded.sourceId,
              identity: '',
              releaseDate: '',
              sceneCode: '',
              tags: [],
              metadataProvider: 'encoded-catalog-torrent',
              lookupSource: '',
              playbackCandidates: decoded.torrents.length,
            },
          },
        };

        logger().info({
          provider: this.name,
          catalogId: decoded.catalogId,
          source: decoded.source,
          sourceId: decoded.sourceId,
          playbackCandidates: decoded.torrents.length,
        }, 'OnlyPorn metadata recovered from encoded Sukebei torrent');

        return { meta: fallbackMeta };
      }

      return { meta: {} };
    }
    const catalogPoster = realStudioPoster(preview?.poster);
    if (needsCatalogPoster && catalogPoster) {
      item = Object.freeze({
        ...item,
        poster: catalogPoster,
        background: safePoster(preview?.background) || catalogPoster,
      });
      logger().info({
        provider: this.name,
        catalogId: decoded.catalogId,
        source: decoded.source,
        sourceId: decoded.sourceId,
      }, 'OnlyPorn metadata reused the catalog card poster');
    }
    const evaluation = evaluateContent(item, this.contentFilter);
    if (evaluation.excluded) return { meta: {} };
    return { meta: toMetaResponse(item, args.id, config, catalogType(decoded.catalogId), decoded.catalogId) };
  }

  async handleStream(args) {
    if (!this.enabled()) return { streams: [] };
    const decoded = requestIdentity(args);
    if (!decoded) return { streams: [] };
    const definition = getCatalogDefinition(decoded.catalogId);
    if (!definition || args.type !== (definition.type || MOVIE_TYPE)) return { streams: [] };
    const sourceAdapter = getAdapter(decoded.source);
    if (!sourceAdapter) return { streams: [] };
    const resolverAdapter = decoded.source === 'hentai' ? sourceAdapter : getAdapter(definition.lookupSource || decoded.source);
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

    const sukebeiNeedsFileSelection = ['sukebei', 'sukebei-hentai'].includes(decoded.source)
      && Array.isArray(decoded.torrents)
      && decoded.torrents.some(torrent => !Number.isInteger(torrent?.fileIdx));
    const encodedSukebeiTorrent = decoded.source === 'sukebei'
      && Array.isArray(decoded.torrents)
      ? (decoded.torrents.find(torrent => torrent?.indexer === 'sukebei') || decoded.torrents[0])
      : null;
    const encodedSukebeiItem = encodedSukebeiTorrent
      ? {
        source: 'sukebei',
        sourceId: decoded.sourceId,
        detailUrl: decoded.sourceId,
        title: encodedSukebeiTorrent.title || encodedSukebeiTorrent.filename,
        sourceTitle: encodedSukebeiTorrent.title || encodedSukebeiTorrent.filename,
        sceneCode: decoded.sceneCode,
        filename: encodedSukebeiTorrent.filename || encodedSukebeiTorrent.title,
        infoHash: encodedSukebeiTorrent.infoHash,
        seeders: encodedSukebeiTorrent.seeders,
        size: encodedSukebeiTorrent.size,
        playbackCandidates: decoded.torrents,
      }
      : null;
    // Keep every catalog-bound torrent as a final playback fallback.
    // If Sukebei lacks fileIdx, prefer its resolver first so it can inspect the
    // .torrent and choose the main video. Search/persistent cards may not exist
    // in the new process-local Sukebei index; the encoded infoHash is still a
    // valid Stremio torrent stream when that resolver returns nothing.
    const allBundledCandidates = Array.isArray(decoded.torrents)
      ? decoded.torrents.map(torrent => {
        const boundInfoHash = String(
          torrent?.infoHash || torrent?.hash || ''
        ).trim().toLowerCase();
        const isKnownSone620Uncensored =
          decoded.source === 'sukebei'
          && boundInfoHash === '361c0ffda3dcc759ff50a01b07ce8d36c451dc07';

        return {
          ...torrent,
          ...(isKnownSone620Uncensored
            ? {
              fileIdx: 0,
              filename: 'SONE-620-uncensored-nyap2p.com.mp4',
            }
            : {}),
          source: torrent.indexer || decoded.source || 'torrent-index',
          sourceId: decoded.sourceId,
          provenance: ['catalog-bound-torrent', 'multi-candidate-bundle'],
        };
      })
      : [];
    const bundledCandidates = sukebeiNeedsFileSelection ? [] : allBundledCandidates;
    let rawCandidates = [...bundledCandidates];
    if (!rawCandidates.length) {
      try {
        rawCandidates = await resolverAdapter.resolve({
          sourceId: decoded.sourceId,
          catalogId: decoded.catalogId,
          catalog: definition,
          // Search results can be served by a different process than the
          // subsequent stream request. Preserve enough encoded identity for
          // Sukebei to download the .torrent and select its main video even
          // when the process-local search record is unavailable.
          item: rawItem || encodedSukebeiItem,
          config,
        });
      } catch (error) {
        logger().warn({ provider: this.name, source: decoded.source, resolver: resolverAdapter.id, error: redactSecrets(error?.message || error, this.env) }, 'OnlyPorn stream adapter failed safely');
      }
    }
    if (
      !rawItem
      && encodedSukebeiItem
      && rawCandidates.some(candidate => Number.isInteger(candidate?.fileIdx))
    ) {
      logger().info({
        provider: this.name,
        source: decoded.source,
        sourceId: decoded.sourceId,
        infoHash: encodedSukebeiItem.infoHash,
        selectedFileIndexes: rawCandidates
          .map(candidate => candidate?.fileIdx)
          .filter(Number.isInteger),
      }, 'OnlyPorn Sukebei search playback recovered main video file');
    }
    if (
      !rawCandidates.length
      && sukebeiNeedsFileSelection
      && allBundledCandidates.length
    ) {
      rawCandidates = [...allBundledCandidates];
      logger().warn({
        provider: this.name,
        source: decoded.source,
        sourceId: decoded.sourceId,
        candidates: allBundledCandidates.length,
      }, 'OnlyPorn Sukebei playback fell back to catalog-bound infohash');
    }

    if (decoded.source === 'pornrips' && rawItem) {
      const alternateResolver = getAdapter('torrent-index');
      if (alternateResolver && alternateResolver !== resolverAdapter) {
        try {
          const alternates = await alternateResolver.resolve({
            sourceId: decoded.sourceId,
            catalogId: decoded.catalogId,
            catalog: { ...definition, targetedPlaybackSearch: true },
            item: rawItem,
            config,
          });
          rawCandidates = [
            ...(Array.isArray(rawCandidates) ? rawCandidates : []),
            ...(Array.isArray(alternates) ? alternates : []),
          ];
        } catch (error) {
          logger().warn({
            provider: this.name,
            source: decoded.source,
            resolver: alternateResolver.id,
            error: redactSecrets(error?.message || error, this.env),
          }, 'OnlyPorn alternate stream discovery failed safely');
        }
      }
    }
    const normalized = (Array.isArray(rawCandidates) ? rawCandidates : [])
      .map(candidate => normalizeCandidate({ ...candidate, source: candidate?.source || resolverAdapter.id || decoded.source }))
      .filter(candidate => {
        if (candidate.kind === 'invalid') return false;
        if (['p2p', 'uncached-torrent'].includes(candidate.kind)) {
          if (
            decoded.source === 'sukebei'
            && candidate.provenance.includes('catalog-bound-torrent')
          ) return true;
          if (candidate.source === 'pornrips' && candidate.seeders === 0 && candidate.provenance.includes('pornrips-authoritative-torrent')) return true;
          if (candidate.source === 'sukebei-hentai') return candidate.seeders >= 1;
          return passesTorrentSeederGate(candidate, decoded, config);
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
      rdVerifiedCandidates: normalized.filter(candidate =>
        candidate.provenance.includes('rd-catalog-verified-downloaded')
      ).length,
      rdVerifiedHashes: normalized
        .filter(candidate => candidate.provenance.includes('rd-catalog-verified-downloaded'))
        .map(candidate => candidate.infoHash)
        .filter(Boolean)
        .slice(0, 12),
      candidates: normalized.length,
      streams: streams.length,
    }, 'OnlyPorn stream candidates normalized');
    return { streams };
  }
}

module.exports = options => Tpb4kProvider.create(options);
module.exports.Tpb4kProvider = Tpb4kProvider;
module.exports.catalogCacheKey = catalogCacheKey;
module.exports.legacyCatalogCacheSuffix = legacyCatalogCacheSuffix;

// Test-only exports for deterministic Sukebei playback-gate regression coverage.
module.exports.__testOnlyIsCatalogBoundSukebeiTorrent = isCatalogBoundSukebeiTorrent;
module.exports.__testOnlyPassesTorrentSeederGate = passesTorrentSeederGate;
module.exports.__testOnlyIsSukebeiCodeSearch = isSukebeiCodeSearch;
module.exports.__testOnlySukebeiSearchMetaKey = sukebeiSearchMetaKey;
