'use strict';

const { BoundedTtlCache } = require('./cache');
const {
  mergeMetadataPreservingIdentity,
  normalizeScene,
  normalizeStudioName,
  safeHttpsUrl,
} = require('./metadata-normalize');

const DEFAULT_POSTER_ASSET_BASE_URL =
  'https://raw.githubusercontent.com/buubu99/onlyporn-V2-public/main/assets/tpb4k/studios';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the',
  'to', 'with', 'xxx', 'video', 'scene', 'full', 'movie', 'porn', 'adult',
]);

const TECHNICAL_WORDS = new Set([
  '4k', '8k', 'uhd', '2160p', '4320p', '1080p', '720p', '480p', 'hdr', 'sdr',
  'web', 'webrip', 'webdl', 'bluray', 'bdrip', 'hdtv', 'x264', 'x265', 'h264', 'h265',
  'hevc', 'av1', 'aac', 'ac3', 'ddp', 'mp4', 'mkv', 'wmv', 'mov', 'remux', 'proper',
  'repack', 'internal', 'uncensored', 'multi',
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

function extractTitleDate(title, studio = '') {
  let text = compactText(title);
  const studioText = compactText(studio);
  if (studioText) {
    const escaped = studioText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^${escaped}(?:[ ._\-]+|$)`, 'i'), '');
  }

  const match = text.match(
    /^(?:(20)?(\d{2})[ ._\-]+(0?[1-9]|1[0-2])[ ._\-]+(0?[1-9]|[12]\d|3[01]))(?:[ ._\-]+|$)/
  );
  if (!match) return Object.freeze({ releaseDate: '', remaining: text });

  const year = match[1] ? Number(`${match[1]}${match[2]}`) : 2000 + Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!valid) return Object.freeze({ releaseDate: '', remaining: text });

  return Object.freeze({
    releaseDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    remaining: compactText(text.slice(match[0].length)),
  });
}

function normalizeSearchTitle(title, studio = '') {
  const dated = extractTitleDate(title, studio);
  const cleaned = dated.remaining
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\b(?:xxx|porn)\b/gi, ' ')
    .replace(/\b(?:4320p|2160p|1080p|720p|480p|8k|4k|uhd|hdr|sdr)\b/gi, ' ')
    .replace(/\b(?:web[ ._-]?dl|webrip|bluray|bdrip|hdtv|remux|x26[45]|h26[45]|hevc|av1|aac|ac3|ddp)\b/gi, ' ')
    .replace(/\b(?:mp4|mkv|wmv|mov)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Object.freeze({
    query: cleaned.slice(0, 160),
    releaseDate: dated.releaseDate,
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

  const sourceTokens = significantTokens(sourceItem.title, sourceItem.studio);
  const candidateTokens = significantTokens(normalizedScene.title, normalizedScene.studio);
  const candidateSet = new Set(candidateTokens);
  const intersection = sourceTokens.filter(token => candidateSet.has(token)).length;
  const minSize = Math.max(Math.min(sourceTokens.length, candidateTokens.length), 1);
  const unionSize = Math.max(new Set([...sourceTokens, ...candidateTokens]).size, 1);
  const coverage = intersection / minSize;
  const jaccard = intersection / unionSize;

  const sourceCompact = sourceTokens.join(' ');
  const candidateCompact = candidateTokens.join(' ');
  const containment = Boolean(
    sourceCompact && candidateCompact &&
      (sourceCompact.includes(candidateCompact) || candidateCompact.includes(sourceCompact))
  );

  const sourceCode = compactKey(sourceItem.sceneCode);
  const candidateCode = compactKey(normalizedScene.sceneCode);
  const exactCode = Boolean(sourceCode && candidateCode && sourceCode === candidateCode);

  const sourceDate = compactText(sourceItem.releaseDate);
  const candidateDate = compactText(normalizedScene.releaseDate);
  const exactDate = Boolean(sourceDate && candidateDate && sourceDate === candidateDate);
  const sameYear = Boolean(dateYear(sourceDate) && dateYear(sourceDate) === dateYear(candidateDate));

  let score = coverage * 0.6 + jaccard * 0.2;
  if (!studioConflict && sourceStudio && studios.includes(sourceStudio)) score += 0.1;
  if (containment) score += 0.05;
  if (exactDate) score += 0.05;
  else if (sameYear) score += 0.02;
  if (exactCode) score = Math.max(score, 0.98);
  score = Math.min(score, 1);

  const enoughWords = intersection >= 2 || (intersection >= 1 && minSize === 1);
  const accepted = exactCode || (enoughWords && coverage >= 0.55);
  return Object.freeze({
    accepted,
    score,
    reason: accepted ? 'candidate' : 'insufficient-title-overlap',
    intersection,
    coverage,
    jaccard,
    exactDate,
    exactCode,
  });
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('metadata enrichment lookup timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function createPosterEnricher(options = {}) {
  const clients = options.clients || {};
  const config = options.config || {};
  const threshold = Math.min(Math.max(Number(config.metadataMatchThreshold || 72) / 100, 0.5), 0.98);
  const concurrency = Math.min(Math.max(Number(config.metadataEnrichmentConcurrency || 4), 1), 8);
  const lookupLimit = Math.min(Math.max(Number(config.metadataEnrichmentLimit || 8), 1), 24);
  const timeoutMs = Math.min(Math.max(Number(config.metadataLookupTimeoutMs || 2000), 1000), 10_000);
  const fallbackBase = safeAssetBase(config.posterAssetBaseUrl || DEFAULT_POSTER_ASSET_BASE_URL);
  const positiveTtlMs = Number(config.metadataCacheTtlMs || 600_000);
  const negativeTtlMs = Number(config.metadataNegativeTtlMs || 120_000);
  const cache = options.cache || new BoundedTtlCache({
    maxEntries: config.metadataCacheMaxEntries || 500,
    now: options.now,
  });

  const providers = ['stashdb', 'tpdb'].filter(id => clients[id]?.configured);

  async function searchProvider(provider, sourceItem, queryInfo) {
    const client = clients[provider];
    if (!client?.configured || !queryInfo.query) return [];
    const request = {
      page: 1,
      perPage: 12,
      title: queryInfo.query,
      text: queryInfo.query,
      query: queryInfo.query,
      studio: sourceItem.studio,
      year: Number(dateYear(queryInfo.releaseDate)) || undefined,
      sort: 'DATE',
      orderBy: 'date',
    };
    return withTimeout(client.queryScenes(request), timeoutMs);
  }

  async function findMatch(sourceItem, stats) {
    const queryInfo = normalizeSearchTitle(sourceItem.title, sourceItem.studio);
    if (queryInfo.releaseDate && !sourceItem.releaseDate) {
      sourceItem = Object.freeze({ ...sourceItem, releaseDate: queryInfo.releaseDate });
    }
    let best = null;

    for (const provider of providers) {
      stats.requests += 1;
      let scenes = [];
      try {
        scenes = await searchProvider(provider, sourceItem, queryInfo);
      } catch {
        stats.errors += 1;
        continue;
      }
      for (const rawScene of Array.isArray(scenes) ? scenes : []) {
        const normalized = normalizeScene(provider, rawScene);
        if (!normalized) continue;
        const scored = scoreMetadataCandidate(sourceItem, rawScene, normalized);
        if (!scored.accepted || scored.score < threshold) continue;
        if (!best || scored.score > best.score) {
          best = { provider, rawScene, normalized, score: scored.score };
        }
      }
      if (best && best.score >= Math.min(threshold + 0.12, 0.95)) break;
    }
    return { sourceItem, best };
  }

  async function enrichOne(originalItem, stats) {
    const cacheKey = `poster:${originalItem.sourceId}`;
    const cached = cache.getEntry(cacheKey);
    if (cached) {
      stats.cacheHits += 1;
      if (!cached.negative) return cached.value;
      return Object.freeze({
        ...originalItem,
        poster: fallbackPosterUrl(originalItem.studio, fallbackBase),
        background: fallbackPosterUrl(originalItem.studio, fallbackBase),
        posterSource: 'fallback:studio',
      });
    }

    stats.attempted += 1;
    const { sourceItem, best } = await findMatch(originalItem, stats);
    if (best) {
      const merged = mergeMetadataPreservingIdentity(sourceItem, best.normalized);
      const enriched = Object.freeze({
        ...merged,
        posterSource: `metadata:${best.provider}`,
        metadataMatchScore: Math.round(best.score * 100),
      });
      cache.set(cacheKey, enriched, positiveTtlMs);
      stats.matched += 1;
      stats.providerMatches[best.provider] = (stats.providerMatches[best.provider] || 0) + 1;
      return enriched;
    }

    cache.setNegative(cacheKey, negativeTtlMs);
    stats.fallback += 1;
    const poster = fallbackPosterUrl(sourceItem.studio, fallbackBase);
    return Object.freeze({
      ...sourceItem,
      poster,
      background: poster,
      posterSource: 'fallback:studio',
      metadataMatchScore: 0,
    });
  }

  async function enrichItems(items = []) {
    const stats = {
      configuredProviders: [...providers],
      attempted: 0,
      matched: 0,
      fallback: 0,
      cacheHits: 0,
      requests: 0,
      errors: 0,
      providerMatches: {},
      skipped: 0,
    };
    const input = Array.isArray(items) ? items : [];
    const lookupItems = input.slice(0, providers.length ? lookupLimit : 0);
    const enrichedLookupItems = await mapWithConcurrency(
      lookupItems,
      concurrency,
      item => enrichOne(item, stats)
    );
    const skippedItems = input.slice(lookupItems.length).map(item => {
      const poster = fallbackPosterUrl(item.studio, fallbackBase);
      stats.fallback += 1;
      stats.skipped += 1;
      return Object.freeze({
        ...item,
        poster,
        background: poster,
        posterSource: 'fallback:studio',
        metadataMatchScore: 0,
      });
    });
    const enriched = [...enrichedLookupItems, ...skippedItems];
    return Object.freeze({ items: Object.freeze(enriched), stats: Object.freeze(stats) });
  }

  return Object.freeze({
    configuredProviders: Object.freeze([...providers]),
    enrichItems,
    fallbackPosterUrl: studio => fallbackPosterUrl(studio, fallbackBase),
    cacheSize: () => cache.size,
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
