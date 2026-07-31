'use strict';

const { getCatalogDefinition } = require('../../catalog/tpb4k');
const { BoundedTtlCache } = require('./cache');
const { buildSceneIdentity } = require('./identity');
const {
  CANONICAL_STUDIOS,
  normalizeScene,
  normalizeStudioName,
  normalizeTags,
  studioAliases,
} = require('./metadata-normalize');
const {
  evaluateContent,
  readContentFilterConfig,
} = require('../content-filter');

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function compactKey(value) {
  return compactText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function createLimiter(maxConcurrency = 4) {
  const limit = Math.max(Number.parseInt(String(maxConcurrency || 4), 10) || 4, 1);
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }
  return function runLimited(run) {
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      drain();
    });
  };
}

function metadataMergeKey(item = {}) {
  const studio = compactKey(item.studio);
  const code = compactKey(item.sceneCode);
  if (studio && code) return `code:${studio}:${code}`;
  const title = compactKey(item.title);
  const date = compactText(item.releaseDate).slice(0, 10);
  if (studio && title) return `title:${studio}:${title}:${date}`;
  return `source:${compactText(item.sourceId)}`;
}

function parseSourceId(value) {
  const text = compactText(value);
  const separator = text.indexOf(':');
  if (separator < 1 || separator === text.length - 1) return null;
  const provider = text.slice(0, separator).toLowerCase();
  const upstreamId = text.slice(separator + 1);
  if (!/^[a-z0-9_-]{1,32}$/.test(provider) || !upstreamId) return null;
  return Object.freeze({ provider, upstreamId });
}

function rawStudioNames(scene = {}) {
  return [
    scene?.studio?.name,
    scene?.studio?.parent?.name,
    scene?.site?.name,
    scene?.site?.short_name,
    scene?.studio,
    scene?.site,
  ]
    .map(value => compactText(typeof value === 'object' ? value?.name : value))
    .filter(Boolean);
}

function studioEvidence(scene, normalized, requestedStudio, queryAlias, provider) {
  const canonical = normalizeStudioName(requestedStudio);
  const canonicalKey = compactKey(canonical);
  const acceptedKeys = new Set(
    studioAliases(canonical)
      .map(compactKey)
      .filter(Boolean)
  );
  acceptedKeys.add(canonicalKey);

  const names = [normalized?.studio, ...rawStudioNames(scene)]
    .map(value => normalizeStudioName(value))
    .filter(Boolean);
  const nameKeys = names.map(compactKey).filter(Boolean);
  if (nameKeys.some(key => acceptedKeys.has(key))) {
    return Object.freeze({ accepted: true, reason: 'exact-studio' });
  }

  const conflictingCanonical = names
    .map(normalizeStudioName)
    .find(name => CANONICAL_STUDIOS.includes(name) && compactKey(name) !== canonicalKey);
  if (conflictingCanonical) {
    return Object.freeze({ accepted: false, reason: 'studio-conflict' });
  }

  // TPDB's `site` filter is authoritative for its returned page. Some TPDB
  // records omit a site/studio label even though the API filtered them by site.
  if (provider === 'tpdb' && compactKey(queryAlias) && acceptedKeys.has(compactKey(queryAlias))) {
    return Object.freeze({ accepted: true, reason: 'tpdb-site-query' });
  }

  return Object.freeze({ accepted: false, reason: 'studio-unverified' });
}

function platformEvidence(scene = {}, normalized = {}, queries = []) {
  const acceptedKeys = new Set((Array.isArray(queries) ? queries : [queries]).map(compactKey).filter(Boolean));
  const values = [
    normalized.title,
    normalized.description,
    normalized.studio,
    ...(Array.isArray(normalized.tags) ? normalized.tags : []),
    ...(Array.isArray(scene.tags) ? scene.tags.map(item => item?.name || item) : []),
    ...(Array.isArray(scene.urls) ? scene.urls.map(item => item?.url || item) : []),
    scene.title,
    scene.details,
    scene.description,
  ];
  const haystack = values.map(compactKey).filter(Boolean);
  if (haystack.some(value => [...acceptedKeys].some(key => value.includes(key)))) {
    return Object.freeze({ accepted: true, reason: 'explicit-platform-label' });
  }
  return Object.freeze({ accepted: false, reason: 'platform-unverified' });
}

function bindCatalogIdentity(provider, rawScene, normalized, studio) {
  const tags = normalizeTags([
    ...(Array.isArray(normalized.tags) ? normalized.tags : []),
    ...(Array.isArray(normalized.contentTags) ? normalized.contentTags : []),
  ]);
  const requestedStudio = normalizeStudioName(studio);
  const lookupQuery = [requestedStudio, normalized.releaseDate, normalized.sceneCode, normalized.title]
    .map(compactText)
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
  return Object.freeze({
    ...normalized,
    studio: requestedStudio,
    tags,
    contentTags: tags,
    contentClassificationKnown: tags.length > 0,
    sourceId: `${provider}:${normalized.upstreamId}`,
    metadataProvider: provider,
    lookupSource: 'torrent-index',
    lookupQuery,
    sceneIdentity: buildSceneIdentity({ ...normalized, studio: requestedStudio }).digest,
    _rawScene: rawScene,
  });
}

function completeness(item = {}) {
  return (
    (item.poster ? 10 : 0) +
    (item.background ? 3 : 0) +
    (Array.isArray(item.tags) ? Math.min(item.tags.length, 10) : 0) +
    (Array.isArray(item.performers) ? Math.min(item.performers.length, 8) : 0) +
    (item.description ? 1 : 0)
  );
}

function mergeDuplicate(current, candidate) {
  if (!current) return candidate;
  const primary = completeness(candidate) > completeness(current) ? candidate : current;
  const secondary = primary === candidate ? current : candidate;
  const tags = normalizeTags([...(primary.tags || []), ...(secondary.tags || [])]);
  const performers = [...new Set([...(primary.performers || []), ...(secondary.performers || [])])];
  return Object.freeze({
    ...primary,
    poster: primary.poster || secondary.poster,
    background: primary.background || secondary.background || primary.poster || secondary.poster,
    description: primary.description || secondary.description,
    tags,
    contentTags: tags,
    contentClassificationKnown: tags.length > 0,
    performers,
  });
}

function sortMetadata(items) {
  return [...items].sort((left, right) => {
    const leftDate = compactText(left.releaseDate);
    const rightDate = compactText(right.releaseDate);
    if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
    return compactText(left.title).localeCompare(compactText(right.title));
  });
}

function freezeDiagnostics(stats) {
  return Object.freeze({
    ...stats,
    providerRecords: Object.freeze({ ...stats.providerRecords }),
    providerErrors: Object.freeze({ ...stats.providerErrors }),
    providerErrorReasons: Object.freeze({ ...stats.providerErrorReasons }),
    rejected: Object.freeze({ ...stats.rejected }),
    filterReasons: Object.freeze({ ...stats.filterReasons }),
    providerCircuitOpen: Object.freeze({ ...(stats.providerCircuitOpen || {}) }),
  });
}

function classifyProviderError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (error?.name === 'AbortError' || /abort|timed?\s*out/.test(message)) return 'timeout';
  if (/http\s+429|rate\s*limit|too many requests/.test(message)) return 'rate-limit';
  if (/http\s+40[0134]/.test(message)) return 'authorization-or-request';
  if (/graphql|cannot query field|unknown field|not defined by type/.test(message)) return 'graphql';
  if (/fetch failed|network|econn|enotfound|dns/.test(message)) return 'network';
  return 'other';
}

function createStudioMetadataAdapter(options = {}) {
  const clients = options.metadataClients || {};
  const config = options.config || {};
  const env = options.env || process.env;
  const filterConfig = options.filterConfig || readContentFilterConfig(env);
  const providers = ['tpdb', 'stashdb'].filter(provider => clients[provider]?.configured);
  const cache = options.cache || new BoundedTtlCache({
    maxEntries: Math.max(Number(config.metadataCacheMaxEntries || 500), 20),
  });
  const cacheTtlMs = Math.max(Number(config.metadataCacheTtlMs || 600_000), 5_000);
  const maxPages = Math.min(Math.max(Number(config.metadataCatalogMaxPages || 3), 1), 5);
  const overscanFactor = Math.min(Math.max(Number(config.contentFilterOverscanFactor || 3), 1), 5);
  const runMetadataCall = createLimiter(config.metadataCatalogConcurrency || 4);
  const index = new Map();
  const providerCircuit = new Map();
  const providerCircuitTtlMs = Math.max(Number(config.metadataProviderCircuitTtlMs || 5 * 60 * 1000), 30_000);
  let lastDiagnostics = freezeDiagnostics({
    studio: '',
    records: 0,
    returned: 0,
    filtered: 0,
    requests: 0,
    cacheHit: false,
    providerRecords: {},
    providerErrors: {},
    providerErrorReasons: {},
    rejected: {},
    filterReasons: {},
    providerCircuitOpen: {},
  });

  function circuitOpen(provider) {
    const until = Number(providerCircuit.get(provider) || 0);
    if (!until) return false;
    if (until <= Date.now()) {
      providerCircuit.delete(provider);
      return false;
    }
    return true;
  }

  function recordProviderFailure(provider, reason) {
    if (provider === 'stashdb' && ['network', 'timeout', 'rate-limit'].includes(reason)) {
      providerCircuit.set(provider, Date.now() + providerCircuitTtlMs);
    }
  }

  function remember(items) {
    for (const item of items) index.set(item.sourceId, item);
    return items;
  }

  async function queryProvider(provider, catalog, studio, needed, stats) {
    const client = clients[provider];
    if (!client?.configured) return [];
    if (circuitOpen(provider)) {
      stats.providerCircuitOpen[provider] = (stats.providerCircuitOpen[provider] || 0) + 1;
      return [];
    }
    const platformMode = catalog?.metadataMode === 'platform-query';
    const aliases = platformMode
      ? [...new Set([...(catalog?.metadataQueries || []), studio].map(compactText).filter(Boolean))].slice(0, 3)
      : [...studioAliases(studio)].slice(0, 3);
    const output = [];
    const seenUpstream = new Set();

    let studioIds = [];
    if (provider === 'stashdb' && !platformMode) {
      try {
        studioIds = typeof client.resolveStudioIds === 'function'
          ? await runMetadataCall(() => client.resolveStudioIds(aliases))
          : [];
      } catch (error) {
        stats.providerErrors[provider] = (stats.providerErrors[provider] || 0) + 1;
        const reason = classifyProviderError(error);
        recordProviderFailure(provider, reason);
        stats.providerErrorReasons[`${provider}:${reason}`] =
          (stats.providerErrorReasons[`${provider}:${reason}`] || 0) + 1;
        return [];
      }
      if (!studioIds.length) {
        stats.rejected['stashdb-studio-not-found'] =
          (stats.rejected['stashdb-studio-not-found'] || 0) + 1;
        stats.providerRecords[provider] = 0;
        return [];
      }
    }

    const queryAliases = provider === 'stashdb' && !platformMode ? [aliases[0] || studio] : aliases;
    for (const alias of queryAliases) {
      for (let page = 1; page <= maxPages; page += 1) {
        if (output.length >= needed) break;
        stats.requests += 1;
        let scenes;
        try {
          scenes = await runMetadataCall(() => client.queryScenes(platformMode
            ? (provider === 'tpdb'
              ? { page, perPage: 100, query: alias, sort: 'DATE', orderBy: 'date' }
              : { page, perPage: 100, title: alias, sort: 'DATE' })
            : {
              page,
              perPage: 100,
              studio: alias,
              studioIds,
              sort: 'DATE',
              orderBy: 'date',
            }));
        } catch (error) {
          stats.providerErrors[provider] = (stats.providerErrors[provider] || 0) + 1;
          const reason = classifyProviderError(error);
          recordProviderFailure(provider, reason);
          stats.providerErrorReasons[`${provider}:${reason}`] =
            (stats.providerErrorReasons[`${provider}:${reason}`] || 0) + 1;
          break;
        }
        const records = Array.isArray(scenes) ? scenes : [];
        for (const rawScene of records) {
          const upstreamId = compactText(rawScene?.id || rawScene?._id);
          if (!upstreamId || seenUpstream.has(upstreamId)) continue;
          seenUpstream.add(upstreamId);
          const normalized = normalizeScene(provider, rawScene);
          if (!normalized?.poster) {
            stats.rejected['missing-poster'] = (stats.rejected['missing-poster'] || 0) + 1;
            continue;
          }
          const evidence = platformMode
            ? platformEvidence(rawScene, normalized, aliases)
            : studioEvidence(rawScene, normalized, studio, alias, provider);
          if (!evidence.accepted) {
            stats.rejected[evidence.reason] = (stats.rejected[evidence.reason] || 0) + 1;
            continue;
          }
          output.push(bindCatalogIdentity(provider, rawScene, normalized, studio));
        }
        if (records.length < 100) break;
      }
      if (output.length >= needed) break;
    }
    stats.providerRecords[provider] = output.length;
    return output;
  }

  async function catalog({ catalog, skip = 0, limit = 40 }) {
    const studio = normalizeStudioName(catalog?.studio);
    const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), maximumLimit);
    if (!studio || !providers.length) return [];

    const metadataMode = compactText(catalog?.metadataMode || 'studio');
    const cacheKey = `studio-metadata:${compactKey(studio)}:${compactKey(metadataMode)}:${safeSkip}:${safeLimit}:${filterConfig.enabled}:${filterConfig.blockGay}:${filterConfig.blockInterracial}:${filterConfig.blockUnknown}`;
    const cached = cache.getEntry(cacheKey);
    if (cached && !cached.negative) {
      lastDiagnostics = freezeDiagnostics({
        ...cached.value.diagnostics,
        cacheHit: true,
      });
      return remember(cached.value.items);
    }

    const stats = {
      studio,
      metadataMode,
      records: 0,
      returned: 0,
      filtered: 0,
      requests: 0,
      cacheHit: false,
      providerRecords: {},
      providerErrors: {},
      providerErrorReasons: {},
      rejected: {},
      filterReasons: {},
      providerCircuitOpen: {},
    };
    const needed = Math.min(Math.max((safeSkip + safeLimit) * overscanFactor, safeLimit), 300);
    const byIdentity = new Map();

    // TPDB is the primary catalog source, while StashDB supplements tags and
    // performer metadata. The two providers run concurrently behind one shared
    // limiter, preventing the home screen from creating a metadata request storm.
    const providerResults = await Promise.all(
      providers.map(provider => queryProvider(provider, catalog, studio, needed, stats))
    );
    for (const records of providerResults) {
      for (const item of records) {
        const identity = metadataMergeKey(item);
        byIdentity.set(identity, mergeDuplicate(byIdentity.get(identity), item));
      }
    }

    const merged = sortMetadata([...byIdentity.values()]);
    stats.records = merged.length;
    const allowed = [];
    for (const item of merged) {
      const evaluation = evaluateContent(item, filterConfig);
      if (!evaluation.excluded) {
        allowed.push(item);
        continue;
      }
      stats.filtered += 1;
      stats.filterReasons[evaluation.reason] = (stats.filterReasons[evaluation.reason] || 0) + 1;
    }
    const window = allowed.slice(safeSkip, safeSkip + safeLimit);
    stats.returned = window.length;
    lastDiagnostics = freezeDiagnostics(stats);
    const value = Object.freeze({
      items: Object.freeze(window),
      diagnostics: lastDiagnostics,
    });
    cache.set(cacheKey, value, cacheTtlMs);
    return remember(window);
  }

  async function meta({ sourceId, catalogId }) {
    const remembered = index.get(String(sourceId || ''));
    if (remembered) return remembered;
    const parsed = parseSourceId(sourceId);
    if (!parsed || !clients[parsed.provider]?.configured) return null;
    let rawScene;
    try {
      rawScene = await clients[parsed.provider].findScene(parsed.upstreamId);
    } catch {
      return null;
    }
    const normalized = normalizeScene(parsed.provider, rawScene);
    if (!normalized?.poster) return null;
    const definition = getCatalogDefinition(catalogId);
    const requestedStudio = normalizeStudioName(definition?.studio || normalized.studio);
    if (!requestedStudio) return null;
    const evidence = definition?.metadataMode === 'platform-query'
      ? platformEvidence(rawScene, normalized, definition?.metadataQueries || [requestedStudio])
      : studioEvidence(
        rawScene,
        normalized,
        requestedStudio,
        requestedStudio,
        parsed.provider
      );
    if (!evidence.accepted) return null;
    const bound = bindCatalogIdentity(parsed.provider, rawScene, normalized, requestedStudio);
    const evaluation = evaluateContent(bound, filterConfig);
    if (evaluation.excluded) return null;
    index.set(bound.sourceId, bound);
    return bound;
  }

  return Object.freeze({
    id: 'studio-metadata',
    configured: providers.length > 0,
    catalog,
    meta,
    async resolve() {
      return [];
    },
    diagnostics() {
      return Object.freeze({ metadataCatalog: lastDiagnostics });
    },
  });
}

module.exports = {
  classifyProviderError,
  createLimiter,
  bindCatalogIdentity,
  createStudioMetadataAdapter,
  metadataMergeKey,
  parseSourceId,
  platformEvidence,
  rawStudioNames,
  sortMetadata,
  studioEvidence,
};
