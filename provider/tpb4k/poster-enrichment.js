'use strict';

const { BoundedTtlCache } = require('./cache');
const {
  mergeMetadataPreservingIdentity,
  normalizeScene,
  normalizeStudioName,
  safeHttpsUrl,
  studioAliases,
} = require('./metadata-normalize');

const DEFAULT_POSTER_ASSET_BASE_URL =
  'https://raw.githubusercontent.com/buubu99/onlyporn-V2-public/main/assets/tpb4k/studios';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the',
  'to', 'with', 'xxx', 'video', 'scene', 'full', 'movie', 'porn', 'adult', 'part',
]);

const TECHNICAL_WORDS = new Set([
  '4k', '8k', 'uhd', '2160p', '4320p', '1080p', '720p', '480p', 'hdr', 'sdr',
  'web', 'webrip', 'webdl', 'bluray', 'bdrip', 'hdtv', 'x264', 'x265', 'h264', 'h265',
  'hevc', 'av1', 'aac', 'ac3', 'ddp', 'mp4', 'mkv', 'wmv', 'mov', 'remux', 'proper',
  'repack', 'internal', 'uncensored', 'multi', 'prt', 'nbq', 'nbg', 'rarbg', 'rip',
]);

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function compactKey(value) {
  return compactText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function slugify(value) {
  return compactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'onlyporn';
}

function safeAssetBase(value) {
  const raw = compactText(value || DEFAULT_POSTER_ASSET_BASE_URL);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('TPB4K poster asset base must be a credential-free HTTPS URL');
  }
  return url.toString().replace(/\/$/, '');
}

function fallbackPosterUrl(studio, baseUrl = DEFAULT_POSTER_ASSET_BASE_URL) {
  return `${safeAssetBase(baseUrl)}/${slugify(studio)}.png`;
}

function removeStudioPrefix(title, studio) {
  let text = compactText(title);
  const aliases = [...studioAliases(studio)].sort((left, right) => right.length - left.length);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const updated = text.replace(new RegExp(`^${escaped}(?:[ ._\\-:]+|$)`, 'i'), '');
    if (updated !== text) return compactText(updated);
  }
  return text;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function extractTitleDate(title, studio = '') {
  const text = removeStudioPrefix(title, studio);
  const fullDate = text.match(
    /^(?:(20)?(\d{2})[ ._\-]+(0?[1-9]|1[0-2])[ ._\-]+(0?[1-9]|[12]\d|3[01]))(?:[ ._\-:]+|$)/
  );
  if (fullDate) {
    const year = fullDate[1] ? Number(`${fullDate[1]}${fullDate[2]}`) : 2000 + Number(fullDate[2]);
    const month = Number(fullDate[3]);
    const day = Number(fullDate[4]);
    if (validDate(year, month, day)) {
      return Object.freeze({
        releaseDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        releaseYear: String(year),
        remaining: compactText(text.slice(fullDate[0].length)),
      });
    }
  }

  const compactDate = text.match(/^(20\d{2}|\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[ ._\-:]+|$)/);
  if (compactDate) {
    const year = compactDate[1].length === 4 ? Number(compactDate[1]) : 2000 + Number(compactDate[1]);
    const month = Number(compactDate[2]);
    const day = Number(compactDate[3]);
    if (validDate(year, month, day)) {
      return Object.freeze({
        releaseDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        releaseYear: String(year),
        remaining: compactText(text.slice(compactDate[0].length)),
      });
    }
  }

  const yearOnly = text.match(/^(20\d{2})(?:[ ._\-:]+|$)/);
  if (yearOnly) {
    return Object.freeze({
      releaseDate: '',
      releaseYear: yearOnly[1],
      remaining: compactText(text.slice(yearOnly[0].length)),
    });
  }

  return Object.freeze({ releaseDate: '', releaseYear: '', remaining: text });
}

function normalizeSearchTitle(title, studio = '') {
  const dated = extractTitleDate(title, studio);
  const cleaned = dated.remaining
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\b(?:xxx|porn)\b/gi, ' ')
    .replace(/\b(?:4320p|2160p|1080p|720p|480p|8k|4k|uhd|hdr|sdr)\b/gi, ' ')
    .replace(/\b(?:web[ ._-]?dl|webrip|bluray|bdrip|hdtv|remux|x26[45]|h26[45]|hevc|av1|aac|ac3|ddp)\b/gi, ' ')
    .replace(/\b(?:mp4|mkv|wmv|mov|prt|nbq|nbg|rarbg)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Object.freeze({
    query: cleaned.slice(0, 180),
    releaseDate: dated.releaseDate,
    releaseYear: dated.releaseYear,
  });
}

function significantTokens(value, studio = '') {
  const normalized = normalizeSearchTitle(value, studio).query.toLowerCase();
  const output = [];
  const seen = new Set();
  for (const token of normalized.match(/[\p{L}\p{N}]+/gu) || []) {
    if (token.length < 2 || STOP_WORDS.has(token) || TECHNICAL_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    output.push(token);
  }
  return output;
}

function dateYear(value) {
  const match = compactText(value).match(/\b(20\d{2})\b/);
  return match ? match[1] : '';
}

function candidateStudios(raw = {}, normalized = {}) {
  return [
    normalized.studio,
    raw?.studio?.name,
    raw?.studio?.parent?.name,
    raw?.site?.name,
    raw?.site?.short_name,
    raw?.studio,
    raw?.site,
  ]
    .map(normalizeStudioName)
    .map(compactText)
    .filter(Boolean);
}

function scoreMetadataCandidate(sourceItem, rawScene, normalizedScene) {
  if (!sourceItem || !normalizedScene || !safeHttpsUrl(normalizedScene.poster)) {
    return Object.freeze({ accepted: false, score: 0, reason: 'missing-poster' });
  }

  const sourceStudio = compactKey(normalizeStudioName(sourceItem.studio));
  const studios = candidateStudios(rawScene, normalizedScene).map(compactKey);
  const studioConflict = sourceStudio && studios.length && !studios.includes(sourceStudio);
  if (studioConflict) {
    return Object.freeze({ accepted: false, score: 0, reason: 'studio-conflict' });
  }

  const sourceQuery = normalizeSearchTitle(sourceItem.title, sourceItem.studio);
  const candidateQuery = normalizeSearchTitle(normalizedScene.title, normalizedScene.studio);
  const sourceTokens = significantTokens(sourceItem.title, sourceItem.studio);
  const candidateTokens = significantTokens(normalizedScene.title, normalizedScene.studio);
  const candidateSet = new Set(candidateTokens);
  const intersection = sourceTokens.filter(token => candidateSet.has(token)).length;
  const minSize = Math.max(Math.min(sourceTokens.length, candidateTokens.length), 1);
  const unionSize = Math.max(new Set([...sourceTokens, ...candidateTokens]).size, 1);
  const coverage = intersection / minSize;
  const jaccard = intersection / unionSize;

  const sourceCompact = compactKey(sourceQuery.query);
  const candidateCompact = compactKey(candidateQuery.query);
  const exactTitle = Boolean(sourceCompact && candidateCompact && sourceCompact === candidateCompact);
  const containment = Boolean(
    sourceCompact && candidateCompact &&
      (sourceCompact.includes(candidateCompact) || candidateCompact.includes(sourceCompact))
  );

  const sourceCode = compactKey(sourceItem.sceneCode);
  const candidateCode = compactKey(normalizedScene.sceneCode);
  const exactCode = Boolean(sourceCode && candidateCode && sourceCode === candidateCode);

  const sourceDate = compactText(sourceItem.releaseDate || sourceQuery.releaseDate);
  const candidateDate = compactText(normalizedScene.releaseDate);
  const sourceYear = dateYear(sourceDate) || sourceQuery.releaseYear;
  const candidateYear = dateYear(candidateDate);
  const exactDate = Boolean(sourceDate && candidateDate && sourceDate === candidateDate);
  const sameYear = Boolean(sourceYear && candidateYear && sourceYear === candidateYear);

  let score = coverage * 0.55 + jaccard * 0.2;
  if (sourceStudio && studios.includes(sourceStudio)) score += 0.1;
  if (containment) score += 0.05;
  if (exactTitle) score += 0.12;
  if (exactDate) score += 0.08;
  else if (sameYear) score += 0.03;
  if (exactCode) score = Math.max(score, 0.99);
  score = Math.min(score, 1);

  const multiTokenMatch = intersection >= 2 && coverage >= 0.5;
  const datedSingleTokenMatch = exactDate && intersection >= 1 && coverage >= 0.5;
  const accepted = exactCode || exactTitle || multiTokenMatch || datedSingleTokenMatch;
  return Object.freeze({
    accepted,
    score,
    reason: accepted ? 'candidate' : 'insufficient-title-overlap',
    intersection,
    coverage,
    jaccard,
    exactDate,
    exactCode,
    exactTitle,
    sameYear,
  });
}

function timeoutError() {
  const error = new Error('metadata enrichment lookup timed out');
  error.code = 'METADATA_TIMEOUT';
  return error;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
  const output = new Array(items.length);
  let cursor = 0;
  const shouldStart = typeof options.shouldStart === 'function' ? options.shouldStart : () => true;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      if (!shouldStart(items[index], index)) {
        output[index] = { deadline: true };
        continue;
      }
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function freezeStats(stats) {
  return Object.freeze({
    ...stats,
    configuredProviders: Object.freeze([...stats.configuredProviders]),
    providerMatches: Object.freeze({ ...stats.providerMatches }),
    providerErrors: Object.freeze({ ...stats.providerErrors }),
    rejectionReasons: Object.freeze({ ...stats.rejectionReasons }),
    aliasesTried: Object.freeze({ ...stats.aliasesTried }),
  });
}

function createPosterEnricher(options = {}) {
  const clients = options.clients || {};
  const config = options.config || {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const threshold = Math.min(Math.max(Number(config.metadataMatchThreshold || 72) / 100, 0.5), 0.98);
  const concurrency = Math.min(Math.max(Number(config.metadataEnrichmentConcurrency || 10), 1), 16);
  const timeoutMs = Math.min(Math.max(Number(config.metadataLookupTimeoutMs || 2500), 750), 8_000);
  const deadlineMs = Math.min(Math.max(Number(config.metadataEnrichmentDeadlineMs || 16_000), 4_000), 25_000);
  const poolSize = Math.min(Math.max(Number(config.metadataPoolSize || 100), 20), 100);
  const poolAliasLimit = Math.min(Math.max(Number(config.metadataPoolAliasLimit || 2), 1), 3);
  const targetedAliasLimit = Math.min(Math.max(Number(config.metadataTargetedAliasLimit || 2), 1), 3);
  const fallbackBase = safeAssetBase(config.posterAssetBaseUrl || DEFAULT_POSTER_ASSET_BASE_URL);
  const positiveTtlMs = Number(config.metadataCacheTtlMs || 600_000);
  const negativeTtlMs = Number(config.metadataNegativeTtlMs || 120_000);
  const cache = options.cache || new BoundedTtlCache({
    maxEntries: config.metadataCacheMaxEntries || 500,
    now,
  });
  const poolCache = options.poolCache || new BoundedTtlCache({
    maxEntries: Math.max(Number(config.metadataPoolCacheMaxEntries || 100), 10),
    now,
  });

  const providers = ['stashdb', 'tpdb'].filter(id => clients[id]?.configured);

  function remaining(deadlineAt) {
    return Math.max(deadlineAt - now(), 0);
  }

  function countAlias(stats, provider, alias) {
    const key = `${provider}:${alias}`;
    stats.aliasesTried[key] = (stats.aliasesTried[key] || 0) + 1;
  }

  function recordError(stats, provider, error) {
    stats.errors += 1;
    stats.providerErrors[provider] = (stats.providerErrors[provider] || 0) + 1;
    if (error?.code === 'METADATA_TIMEOUT' || /timed out|aborted/i.test(String(error?.message || ''))) {
      stats.timeouts += 1;
    }
  }

  function recordRejection(stats, reason) {
    stats.rejected += 1;
    stats.rejectionReasons[reason] = (stats.rejectionReasons[reason] || 0) + 1;
  }

  function behaviorKey(behavior = {}) {
    return behavior.preserveSourcePoster || behavior.replaceTitle
      ? `source-${behavior.preserveSourcePoster ? 1 : 0}-title-${behavior.replaceTitle ? 1 : 0}`
      : 'default';
  }

  function itemCacheKey(item, behavior = {}) {
    return `poster:${behaviorKey(behavior)}:${item.sourceId}`;
  }

  function fallbackItem(item, reason = 'not-found', behavior = {}) {
    const sourcePoster = safeHttpsUrl(item.poster);
    const preserveSource = Boolean(behavior.preserveSourcePoster && sourcePoster);
    const poster = preserveSource ? sourcePoster : fallbackPosterUrl(item.studio, fallbackBase);
    return Object.freeze({
      ...item,
      poster,
      background: preserveSource ? (safeHttpsUrl(item.background) || poster) : poster,
      posterSource: preserveSource ? 'source:preserved' : 'fallback:studio',
      posterFallbackReason: reason,
      metadataMatchScore: 0,
    });
  }

  function matchedItem(sourceItem, best, behavior = {}) {
    const merged = mergeMetadataPreservingIdentity(sourceItem, best.normalized);
    return Object.freeze({
      ...merged,
      ...(behavior.replaceTitle && best.normalized.title ? { title: best.normalized.title } : {}),
      posterSource: `metadata:${best.provider}`,
      metadataMatchScore: Math.round(best.score * 100),
    });
  }

  function bestCandidate(sourceItem, candidates, stats) {
    let best = null;
    for (const candidate of candidates) {
      const scored = scoreMetadataCandidate(sourceItem, candidate.rawScene, candidate.normalized);
      if (!scored.accepted || scored.score < threshold) {
        recordRejection(stats, scored.reason);
        continue;
      }
      if (!best || scored.score > best.score) best = { ...candidate, score: scored.score };
    }
    return best;
  }

  function normalizeCandidates(provider, scenes) {
    const output = [];
    const seen = new Set();
    for (const rawScene of Array.isArray(scenes) ? scenes : []) {
      const normalized = normalizeScene(provider, rawScene);
      if (!normalized || !safeHttpsUrl(normalized.poster)) continue;
      const key = `${provider}:${normalized.upstreamId || normalized.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(Object.freeze({ provider, rawScene, normalized }));
    }
    return output;
  }

  async function providerQuery(provider, request, stats, phase, deadlineAt, alias) {
    const budget = Math.min(timeoutMs, remaining(deadlineAt));
    if (budget < 100) return { deadline: true, scenes: [] };
    stats.requests += 1;
    stats[phase === 'pool' ? 'poolRequests' : 'targetedRequests'] += 1;
    countAlias(stats, provider, alias);
    try {
      const scenes = await withTimeout(clients[provider].queryScenes(request), budget);
      return { completed: true, scenes: Array.isArray(scenes) ? scenes : [] };
    } catch (error) {
      recordError(stats, provider, error);
      return { completed: false, error, scenes: [] };
    }
  }

  async function loadProviderPool(provider, studio, stats, deadlineAt) {
    const canonical = normalizeStudioName(studio);
    const cacheKey = `poster-pool:${provider}:${compactKey(canonical)}`;
    const cached = poolCache.getEntry(cacheKey);
    if (cached) {
      stats.poolCacheHits += 1;
      return cached.negative ? { candidates: [], complete: true } : cached.value;
    }

    const aliases = [...studioAliases(canonical)].slice(0, poolAliasLimit);
    let successfulCalls = 0;
    let hadError = false;
    for (const alias of aliases) {
      const response = await providerQuery(provider, {
        page: 1,
        perPage: poolSize,
        studio: alias,
        sort: 'DATE',
        orderBy: 'date',
      }, stats, 'pool', deadlineAt, alias);
      if (response.deadline) return { candidates: [], complete: false, deadline: true };
      if (!response.completed) {
        hadError = true;
        continue;
      }
      successfulCalls += 1;
      const candidates = normalizeCandidates(provider, response.scenes);
      if (candidates.length) {
        const value = Object.freeze({ candidates: Object.freeze(candidates), complete: true });
        poolCache.set(cacheKey, value, positiveTtlMs);
        stats.poolCandidates += candidates.length;
        return value;
      }
    }

    if (!hadError && successfulCalls === aliases.length) {
      poolCache.setNegative(cacheKey, negativeTtlMs);
      return { candidates: [], complete: true };
    }
    return { candidates: [], complete: false };
  }

  async function loadStudioPool(studio, stats, deadlineAt) {
    const results = await Promise.all(
      providers.map(provider => loadProviderPool(provider, studio, stats, deadlineAt))
    );
    return results.flatMap(result => result.candidates || []);
  }

  async function targetedProviderWave(provider, entries, stats, deadlineAt) {
    const results = await mapWithConcurrency(entries, concurrency, async entry => {
      const queryInfo = normalizeSearchTitle(entry.item.title, entry.item.studio);
      const aliases = [...studioAliases(entry.item.studio)].slice(0, targetedAliasLimit);
      if (!aliases.length) aliases.push('');
      let providerCompleted = false;
      let hadError = false;
      for (const alias of aliases) {
        const response = await providerQuery(provider, {
          page: 1,
          perPage: 20,
          title: queryInfo.query,
          text: queryInfo.query,
          query: queryInfo.query,
          studio: alias,
          year: Number(queryInfo.releaseYear) || undefined,
          sort: 'DATE',
          orderBy: 'date',
        }, stats, 'targeted', deadlineAt, alias);
        if (response.deadline) return { entry, deadline: true, hadError, providerCompleted };
        if (!response.completed) {
          hadError = true;
          continue;
        }
        providerCompleted = true;
        const candidates = normalizeCandidates(provider, response.scenes);
        const best = bestCandidate(entry.item, candidates, stats);
        if (best) return { entry, best, providerCompleted: true, hadError };
        if (response.scenes.length) break;
      }
      return { entry, best: null, providerCompleted, hadError };
    }, {
      shouldStart: () => remaining(deadlineAt) >= 100,
    });
    return results;
  }

  async function enrichItems(items = [], behavior = {}) {
    const startedAt = now();
    const deadlineAt = startedAt + deadlineMs;
    const input = Array.isArray(items) ? items : [];
    const stats = {
      configuredProviders: [...providers],
      records: input.length,
      eligible: input.length,
      attempted: 0,
      matched: 0,
      poolMatches: 0,
      targetedMatches: 0,
      fallback: 0,
      notFound: 0,
      unconfigured: 0,
      cacheHits: 0,
      negativeCacheHits: 0,
      poolCacheHits: 0,
      requests: 0,
      poolRequests: 0,
      targetedRequests: 0,
      poolCandidates: 0,
      errors: 0,
      timeouts: 0,
      deadlineFallbacks: 0,
      providerMatches: {},
      providerErrors: {},
      rejected: 0,
      rejectionReasons: {},
      aliasesTried: {},
      skipped: 0,
      elapsedMs: 0,
    };

    const output = new Array(input.length);
    const pending = [];
    for (let index = 0; index < input.length; index += 1) {
      const item = input[index];
      const cached = cache.getEntry(itemCacheKey(item, behavior));
      if (!cached) {
        pending.push({ index, item, state: { providersCompleted: new Set(), hadError: false, deadline: false } });
        continue;
      }
      stats.cacheHits += 1;
      if (cached.negative) {
        stats.negativeCacheHits += 1;
        stats.fallback += 1;
        stats.notFound += 1;
        output[index] = fallbackItem(item, 'negative-cache', behavior);
      } else {
        stats.matched += 1;
        const source = String(cached.value?.posterSource || '').replace(/^metadata:/, '');
        if (source) stats.providerMatches[source] = (stats.providerMatches[source] || 0) + 1;
        output[index] = cached.value;
      }
    }

    if (!pending.length) {
      stats.elapsedMs = now() - startedAt;
      return Object.freeze({ items: Object.freeze(output), stats: freezeStats(stats) });
    }

    if (!providers.length) {
      for (const entry of pending) output[entry.index] = fallbackItem(entry.item, 'metadata-unconfigured', behavior);
      stats.unconfigured = pending.length;
      stats.fallback += pending.length;
      stats.elapsedMs = now() - startedAt;
      return Object.freeze({ items: Object.freeze(output), stats: freezeStats(stats) });
    }

    stats.attempted = pending.length;
    const groups = new Map();
    for (const entry of pending) {
      const key = normalizeStudioName(entry.item.studio) || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    let unresolved = [];
    for (const [studio, entries] of groups) {
      const pool = remaining(deadlineAt) >= 100
        ? await loadStudioPool(studio, stats, deadlineAt)
        : [];
      for (const entry of entries) {
        const best = bestCandidate(entry.item, pool, stats);
        if (!best) {
          unresolved.push(entry);
          continue;
        }
        const enriched = matchedItem(entry.item, best, behavior);
        cache.set(itemCacheKey(entry.item, behavior), enriched, positiveTtlMs);
        output[entry.index] = enriched;
        stats.matched += 1;
        stats.poolMatches += 1;
        stats.providerMatches[best.provider] = (stats.providerMatches[best.provider] || 0) + 1;
      }
    }

    for (const provider of providers) {
      if (!unresolved.length) break;
      if (remaining(deadlineAt) < 100) {
        for (const entry of unresolved) entry.state.deadline = true;
        break;
      }
      const wave = await targetedProviderWave(provider, unresolved, stats, deadlineAt);
      const next = [];
      for (const result of wave) {
        const entry = result?.entry;
        if (!entry) continue;
        if (result.deadline) entry.state.deadline = true;
        if (result.hadError) entry.state.hadError = true;
        if (result.providerCompleted) entry.state.providersCompleted.add(provider);
        if (!result.best) {
          next.push(entry);
          continue;
        }
        const enriched = matchedItem(entry.item, result.best, behavior);
        cache.set(itemCacheKey(entry.item, behavior), enriched, positiveTtlMs);
        output[entry.index] = enriched;
        stats.matched += 1;
        stats.targetedMatches += 1;
        stats.providerMatches[result.best.provider] =
          (stats.providerMatches[result.best.provider] || 0) + 1;
      }
      unresolved = next;
    }

    for (const entry of unresolved) {
      const confirmedNotFound =
        !entry.state.hadError &&
        !entry.state.deadline &&
        entry.state.providersCompleted.size === providers.length;
      let reason = 'metadata-error';
      if (entry.state.deadline || remaining(deadlineAt) < 100) {
        reason = 'deadline';
        stats.deadlineFallbacks += 1;
      } else if (confirmedNotFound) {
        reason = 'not-found';
        cache.setNegative(itemCacheKey(entry.item, behavior), negativeTtlMs);
        stats.notFound += 1;
      }
      output[entry.index] = fallbackItem(entry.item, reason, behavior);
      stats.fallback += 1;
    }

    stats.elapsedMs = now() - startedAt;
    return Object.freeze({ items: Object.freeze(output), stats: freezeStats(stats) });
  }

  return Object.freeze({
    configuredProviders: Object.freeze([...providers]),
    enrichItems,
    fallbackPosterUrl: studio => fallbackPosterUrl(studio, fallbackBase),
    cacheSize: () => cache.size,
    poolCacheSize: () => poolCache.size,
  });
}

module.exports = {
  DEFAULT_POSTER_ASSET_BASE_URL,
  createPosterEnricher,
  extractTitleDate,
  fallbackPosterUrl,
  mapWithConcurrency,
  normalizeSearchTitle,
  scoreMetadataCandidate,
  significantTokens,
  slugify,
};
