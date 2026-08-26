'use strict';

const process = require('node:process');
const BoundedTtlCache = require('./cache');
const { evaluateContent, readContentFilterConfig } = require('./content-filter');
const logger = require('../logger');

const WEB_HOME_PROVIDERS = new Set([
  'xvideos',
  'xhamster',
  'eporner',
  'spankbang',
  'porntrex',
  'pornhub',
]);

const AI_HOME_PROVIDERS = new Set(['xvideos', 'xhamster', 'spankbang', 'pornhub']);
const HOME_LIMIT = 40;
const MIN_STRICT_RESULTS = 8;
const SOURCE_CONCURRENCY = 3;
const DETAIL_CONCURRENCY = Object.freeze({ spankbang: 4, pornhub: 4 });
const SOURCE_TIMEOUT_MS = 6_500;
const DETAIL_TIMEOUT_MS = 5_500;
// AIOStreams aborts catalog requests after 30 seconds. Keep a meaningful
// safety margin for JSON serialization, the reverse proxy, and the wrapper.
// Detail work must never be allowed to overrun this deadline.
const TOTAL_BUDGET_MS = 24_000;
const CACHE_TTL_MS = 10 * 60 * 1_000;
const LAST_KNOWN_GOOD_TTL_MS = 24 * 60 * 60 * 1_000;

const homeCache = new BoundedTtlCache({ maxEntries: 24, ttlMs: CACHE_TTL_MS });
const lastKnownGoodCache = new BoundedTtlCache({ maxEntries: 24, ttlMs: LAST_KNOWN_GOOD_TTL_MS });
const pendingHomes = new Map();

const AGE_SAFETY_PATTERN = /\b(?:minor|underage|child|children|kid|kids|preteen|teen|teens|teenager|barely[\s-]*legal|school[\s-]*(?:girl|boy)|schoolgirl|schoolboy|high[\s-]*school|loli|lolita|shota|freshly\s+18|(?:18|19)[\s-]*(?:yo|y\/o|year[\s-]*old))\b/i;
const OLDER_CONTENT_PATTERN = /\b(?:granny|grannies|grandma|grandmother|grandpa|grandfather|elderly|senior|old[\s-]*(?:woman|women|lady|ladies|man|men)|mature)\b/i;
const GRAPHIC_CONTENT_PATTERN = /\b(?:scat|toilet|vomit|puke|feces|faeces|prolapse|gore|bloodplay|injury|close[\s-]*up|extreme[\s-]*(?:gaping|insertion)|violent|forced|rape|hidden[\s-]*(?:cam|camera)|spy[\s-]*cam|bodily[\s-]*fluid)\b/i;
const EXCLUDED_PRESENTATION_PATTERN = /\b(?:transsexual|transgender|shemale|lady[\s-]*boy|t[\s-]*girl|tranny|futanari|futa)\b/i;
const PLACEHOLDER_POSTER_PATTERN = /(?:placeholder|no[\s_-]*image|image[\s_-]*not[\s_-]*found|default\.(?:gif|png|jpe?g|webp)|blank\.(?:gif|png)|loading(?:\.|[\s_-])|spacer\.(?:gif|png)|sprite|avatar|logo)/i;
const LOW_RESOLUTION_POSTER_PATTERN = /(?:\/tiny\/|\/small\/|[?&](?:w|width)=(?:[1-2]?\d\d)(?:&|$)|(?:^|[_-])(?:80x|120x|160x|180x|200x|240x)(?:[_-]|\.))/i;
const AI_EVIDENCE_PATTERN = /\b(?:a\.?i\.?|ai[\s-]*(?:generated|girl|model|video)|artificial[\s-]*intelligence|synthetic[\s-]*model)\b/i;

function source(kind, value, bucket, quota) {
  return Object.freeze({ kind, value, bucket, quota });
}

// These are deliberately made only from routes already supported by each
// provider. A provider with no native rating route does not pretend to have one.
const SOURCE_PLANS = Object.freeze({
  xvideos: Object.freeze([
    source('url', 'https://www.xvideos.com/best', 'best', 16),
    source('default', '', 'trending', 7),
    source('search', 'OnlyFans stars', 'creator-stars', 7),
    source('search', 'TikTok stars', 'social-stars', 4),
    source('search', '4K', '4k', 5),
    source('search', 'AI generated', 'ai', 1),
  ]),
  xhamster: Object.freeze([
    source('genre', 'Best (Weekly)', 'weekly-best', 16),
    source('genre', 'Best (Monthly)', 'monthly-best', 8),
    source('search', 'OnlyFans stars', 'creator-stars', 7),
    source('search', 'TikTok stars', 'social-stars', 4),
    source('genre', '4K', '4k', 4),
    source('search', 'AI generated', 'ai', 1),
  ]),
  eporner: Object.freeze([
    source('genre', 'HQ Porn (Weekly Top)', 'weekly-best', 16),
    source('genre', 'HQ Porn (Most Viewed)', 'most-viewed', 7),
    source('genre', 'HQ Porn (Top Rated)', 'top-rated', 7),
    source('search', 'OnlyFans stars', 'creator-stars', 6),
    source('search', 'TikTok stars', 'social-stars', 2),
    source('genre', '4k Porn (Weekly Top)', '4k', 2),
  ]),
  spankbang: Object.freeze([
    source('genre', 'Trending', 'trending', 14),
    source('genre', 'Popular', 'popular', 8),
    source('search', 'OnlyFans stars', 'creator-stars', 7),
    source('search', 'TikTok stars', 'social-stars', 4),
    source('genre', '4K (Popular)', '4k', 6),
    source('search', 'AI generated', 'ai', 1),
  ]),
  porntrex: Object.freeze([
    source('genre', 'Most Popular', 'most-popular', 17),
    source('genre', 'Top Rated', 'top-rated', 10),
    source('search', 'OnlyFans stars', 'creator-stars', 6),
    source('search', 'TikTok stars', 'social-stars', 3),
    source('genre', '4K porn', '4k', 4),
  ]),
  pornhub: Object.freeze([
    source('url', 'https://www.pornhub.com/video?o=ht&hd=1', 'trending-hd', 14),
    source('url', 'https://www.pornhub.com/video?o=tr', 'top-rated', 10),
    source('search', 'OnlyFans stars', 'creator-stars', 8),
    source('search', 'TikTok stars', 'social-stars', 4),
    source('search', '4K', '4k', 3),
    source('search', 'AI generated', 'ai', 1),
  ]),
});

function normalizedText(item = {}) {
  const values = [
    item.name,
    item.title,
    item.description,
    item.overview,
    ...(Array.isArray(item.genres) ? item.genres : []),
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item.categories) ? item.categories : []),
  ];
  return values.map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
}

function posterReason(poster) {
  const value = String(poster || '').trim();
  if (!value) return 'POSTER_MISSING';
  if (PLACEHOLDER_POSTER_PATTERN.test(value)) return 'PLACEHOLDER';
  if (LOW_RESOLUTION_POSTER_PATTERN.test(value)) return 'LOW_RESOLUTION';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return 'BROKEN_IMAGE';
    if (/\.(?:mp4|m3u8|webm)(?:$|[?#])/i.test(parsed.pathname)) return 'BROKEN_IMAGE';
  } catch {
    return 'BROKEN_IMAGE';
  }
  return '';
}

function evaluateHomeCandidate(item, config = readContentFilterConfig()) {
  const global = evaluateContent(item, config);
  if (global.excluded) {
    return Object.freeze({ excluded: true, reason: `PROHIBITED_TAG:${global.reason}` });
  }

  const text = normalizedText(item);
  if (!String(item?.name || item?.title || '').trim()) {
    return Object.freeze({ excluded: true, reason: 'TITLE_MISSING' });
  }
  if (AGE_SAFETY_PATTERN.test(text)) {
    return Object.freeze({ excluded: true, reason: 'PROHIBITED_AGE' });
  }
  if (OLDER_CONTENT_PATTERN.test(text)) {
    return Object.freeze({ excluded: true, reason: 'OLDER_CONTENT' });
  }
  if (GRAPHIC_CONTENT_PATTERN.test(text)) {
    return Object.freeze({ excluded: true, reason: 'GRAPHIC_CONTENT' });
  }
  if (EXCLUDED_PRESENTATION_PATTERN.test(text)) {
    return Object.freeze({ excluded: true, reason: 'EXCLUDED_PRESENTATION' });
  }
  const poster = posterReason(item?.poster);
  if (poster) return Object.freeze({ excluded: true, reason: poster });
  return Object.freeze({ excluded: false, reason: '' });
}

function shouldCurateWebHome(provider, args = {}) {
  const name = String(provider?.name || provider?.getName?.() || '').toLowerCase();
  const extra = args.extra || {};
  return WEB_HOME_PROVIDERS.has(name) &&
    !String(extra.search || '').trim() &&
    !String(extra.genre || '').trim() &&
    Number(extra.skip || 0) <= 0;
}

function sourceArgs(args, descriptor, provider) {
  const extra = {};
  if (descriptor.kind === 'search') extra.search = descriptor.value;
  if (descriptor.kind === 'genre') extra.genre = descriptor.value;
  if (descriptor.kind === 'page') extra.skip = Number(descriptor.value || 1) * Number(provider.limit || 40);
  return { ...args, extra };
}

function sourcePlanFor(provider, args = {}) {
  const plan = SOURCE_PLANS[provider.name] || [];
  // xHamster exposes two independent Home rows. Reserve the single xHamster
  // AI position for Trending so the six providers still contribute four AI
  // cards in total rather than counting xHamster twice.
  if (provider.name !== 'xhamster' || !String(args.id || '').toLowerCase().includes('best')) {
    return plan;
  }
  return plan
    .filter(item => item.bucket !== 'ai')
    .map(item => item.bucket === 'weekly-best'
      ? Object.freeze({ ...item, quota: item.quota + 1 })
      : item);
}

function canonicalCandidateKey(item = {}) {
  let id = String(item.id || item.videoPageUrl || '').trim();
  try {
    const parsed = new URL(id);
    parsed.hash = '';
    parsed.searchParams.delete('_onlyporn4k');
    id = parsed.toString().replace(/\/$/, '');
  } catch {
    // Opaque IDs are still safe to compare as normalized strings.
  }
  return id.toLowerCase();
}

function titleKey(item = {}) {
  return String(item.name || item.title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function incrementReason(reasons, reason) {
  reasons[reason] = (reasons[reason] || 0) + 1;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, run));
  return results;
}

async function fetchSources(provider, args, plan) {
  return mapConcurrent(plan, SOURCE_CONCURRENCY, async descriptor => {
    const request = descriptor.kind === 'url'
      ? provider._fetchCatalogUrl(args, descriptor.value, { postProcess: false })
      : provider._fetchCatalogPage(sourceArgs(args, descriptor, provider), { postProcess: false });
    const response = await withTimeout(
      request,
      SOURCE_TIMEOUT_MS,
      `${provider.name}:${descriptor.bucket}`
    );
    return {
      descriptor,
      metas: Array.isArray(response) ? response : [],
    };
  });
}

function arrangeCandidates(sourceResults, plan, config) {
  const reasons = {};
  const byBucket = new Map(plan.map(descriptor => [descriptor.bucket, []]));
  for (const result of sourceResults) {
    if (!result || result.error || !result.descriptor) continue;
    const bucket = byBucket.get(result.descriptor.bucket) || [];
    for (const meta of result.metas || []) {
      const evaluation = evaluateHomeCandidate(meta, config);
      if (evaluation.excluded) {
        incrementReason(reasons, evaluation.reason);
        continue;
      }
      if (result.descriptor.bucket === 'ai' && !AI_EVIDENCE_PATTERN.test(normalizedText(meta))) {
        incrementReason(reasons, 'AI_EVIDENCE_MISSING');
        continue;
      }
      bucket.push({ meta, descriptor: result.descriptor });
    }
    byBucket.set(result.descriptor.bucket, bucket);
  }

  const output = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  const add = candidate => {
    const id = canonicalCandidateKey(candidate.meta);
    const title = titleKey(candidate.meta);
    if (!id || seenIds.has(id) || (title && seenTitles.has(title))) {
      incrementReason(reasons, 'DUPLICATE');
      return false;
    }
    seenIds.add(id);
    if (title) seenTitles.add(title);
    output.push(candidate);
    return true;
  };

  for (const descriptor of plan) {
    let used = 0;
    for (const candidate of byBucket.get(descriptor.bucket) || []) {
      if (used >= descriptor.quota) break;
      if (add(candidate)) used += 1;
    }
  }

  for (const descriptor of plan) {
    for (const candidate of byBucket.get(descriptor.bucket) || []) add(candidate);
  }
  return { candidates: output, reasons };
}

function mergeDetail(candidate, detail) {
  if (!detail) return candidate;
  return {
    ...candidate,
    name: detail.name || candidate.name,
    poster: detail.poster || candidate.poster,
    description: detail.description || candidate.description,
    genres: Array.isArray(detail.genres) && detail.genres.length ? detail.genres : candidate.genres,
    links: Array.isArray(detail.links) && detail.links.length ? detail.links : candidate.links,
    videoPageUrl: candidate.videoPageUrl || detail.videoPageUrl,
    posterShape: 'landscape',
  };
}

async function inspectCandidate(provider, candidate) {
  const name = String(provider.name || '').toLowerCase();
  let id = candidate.id;
  let html;
  let parsed;
  let detail;
  let playable = false;

  if (name === 'spankbang') {
    const page = provider.getVideoPageDetails(id, {});
    id = page.videoPageUrl;
    html = await provider.fetchHtml(id);
    parsed = await provider.parseVideoPage({ id, html, is4kCategory: page.is4kCategory });
    detail = parsed?.metaResponse;
    playable = Boolean(parsed?.streams?.length);
  } else {
    html = await provider.fetchHtml(id);
    if (name === 'pornhub') {
      detail = provider.metadataFromPage(id, html);
      playable = provider.mediaDefinitionsFromPage(html, id).length > 0;
    } else {
      parsed = await provider.parseVideoPage({ id, html });
      if (name === 'xvideos') {
        detail = parsed?.metaResponse;
        playable = Boolean(parsed?.directMp4Streams?.length || parsed?.videoPageUrl);
      } else if (name === 'xhamster') {
        detail = parsed;
        playable = Boolean(parsed?.streams?.length || /\.mp4(?:[?#]|$)/i.test(parsed?.videoPageUrl || ''));
      } else if (name === 'eporner') {
        detail = parsed;
        const streams = await provider.getStreams(parsed);
        playable = Boolean(streams?.streams?.length);
      } else if (name === 'porntrex') {
        detail = parsed?.metaResponse;
        playable = Boolean(parsed?.streams?.length);
      }
    }
  }

  return { playable, meta: mergeDetail(candidate, detail) };
}

async function validateCandidates(provider, arranged, config, startedAt, options = {}) {
  const validated = [];
  const reasons = { ...arranged.reasons };
  const candidates = arranged.candidates;
  const concurrency = DETAIL_CONCURRENCY[provider.name] || 8;
  const totalBudgetMs = Number(options.totalBudgetMs || TOTAL_BUDGET_MS);
  const detailTimeoutMs = Number(options.detailTimeoutMs || DETAIL_TIMEOUT_MS);
  let cursor = 0;
  let deadlineReached = false;

  const worker = async () => {
    while (cursor < candidates.length && validated.length < HOME_LIMIT) {
      const remainingMs = totalBudgetMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        deadlineReached = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index].meta;
      try {
        const inspected = await withTimeout(
          inspectCandidate(provider, candidate),
          Math.max(1, Math.min(detailTimeoutMs, remainingMs)),
          `${provider.name}:detail`
        );
        if (!inspected.playable) {
          incrementReason(reasons, 'NO_PLAYABLE_STREAM');
          continue;
        }
        const evaluation = evaluateHomeCandidate(inspected.meta, config);
        if (evaluation.excluded) {
          incrementReason(reasons, evaluation.reason);
          continue;
        }
        if (validated.length < HOME_LIMIT) validated.push({ index, meta: inspected.meta });
      } catch (error) {
        if (Date.now() - startedAt >= totalBudgetMs) {
          deadlineReached = true;
          incrementReason(reasons, 'GLOBAL_DEADLINE');
        } else {
          incrementReason(reasons, /timed out/i.test(error.message) ? 'DETAIL_TIMEOUT' : 'METADATA_UNAVAILABLE');
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  validated.sort((left, right) => left.index - right.index);
  return {
    metas: validated.slice(0, HOME_LIMIT).map(item => item.meta),
    reasons,
    deadlineReached,
  };
}

async function buildCuratedHome(provider, args, cacheKey) {
  const startedAt = Date.now();
  const plan = sourcePlanFor(provider, args);
  const config = readContentFilterConfig(process.env);
  const sourceResults = await fetchSources(provider, args, plan);
  const sourceDurationMs = Date.now() - startedAt;
  const sourceFailures = sourceResults.filter(result => result?.error);
  const arranged = arrangeCandidates(sourceResults, plan, config);
  const validated = await validateCandidates(provider, arranged, config, startedAt);

  logger.info(
    {
      event: 'WEB_HOME_CURATED',
      provider: provider.name,
      catalogId: args.id,
      sourceRoutes: plan.length,
      sourceFailures: sourceFailures.length,
      candidates: arranged.candidates.length,
      published: validated.metas.length,
      strictMinimum: MIN_STRICT_RESULTS,
      totalBudgetMs: TOTAL_BUDGET_MS,
      sourceDurationMs,
      deadlineReached: validated.deadlineReached,
      reasons: validated.reasons,
      durationMs: Date.now() - startedAt,
    },
    'Strict curated web Home catalog completed'
  );

  if (validated.metas.length >= MIN_STRICT_RESULTS) {
    lastKnownGoodCache.set(cacheKey, validated.metas);
    return validated.metas;
  }

  const lastKnownGood = lastKnownGoodCache.get(cacheKey);
  if (lastKnownGood !== undefined) {
    logger.warn(
      {
        event: 'WEB_HOME_LAST_KNOWN_GOOD',
        provider: provider.name,
        freshlyVerified: validated.metas.length,
        published: lastKnownGood.length,
        reason: 'UPSTREAM_DETAIL_QUORUM_UNAVAILABLE',
      },
      'Web Home retained its previously verified strict catalog'
    );
    return lastKnownGood;
  }

  // Fail closed on first boot: every returned card remains detail-verified.
  // The guarded deployment readiness contract will keep the old generation
  // live if an upstream provider cannot verify even one card.
  return validated.metas;
}

async function curateWebHome(provider, args) {
  const cacheKey = `${provider.name}:${String(args.id || provider.name)}`;
  const cached = homeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (pendingHomes.has(cacheKey)) return pendingHomes.get(cacheKey);

  const operation = buildCuratedHome(provider, args, cacheKey);
  pendingHomes.set(cacheKey, operation);
  try {
    const result = await operation;
    if (result.length) homeCache.set(cacheKey, result);
    return result;
  } finally {
    pendingHomes.delete(cacheKey);
  }
}

module.exports = {
  AI_HOME_PROVIDERS,
  HOME_LIMIT,
  SOURCE_PLANS,
  WEB_HOME_PROVIDERS,
  arrangeCandidates,
  curateWebHome,
  evaluateHomeCandidate,
  inspectCandidate,
  posterReason,
  shouldCurateWebHome,
  sourcePlanFor,
  _test: {
    AI_EVIDENCE_PATTERN,
    AGE_SAFETY_PATTERN,
    GRAPHIC_CONTENT_PATTERN,
    EXCLUDED_PRESENTATION_PATTERN,
    OLDER_CONTENT_PATTERN,
    homeCache,
    lastKnownGoodCache,
    pendingHomes,
    TOTAL_BUDGET_MS,
    validateCandidates,
  },
};
