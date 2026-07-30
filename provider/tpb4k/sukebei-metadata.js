'use strict';

const { BoundedTtlCache } = require('./cache');
const { normalizeFeedItem, parseRssFeed } = require('./discovery-normalize');
const {
  mergeMetadataPreservingIdentity,
  normalizeScene,
  normalizeTags,
  safeHttpsUrl,
} = require('./metadata-normalize');
const { normalizeSearchTitle, significantTokens } = require('./poster-enrichment');
const { SourceHttpClient } = require('./source-http');
const { evaluateContent, readContentFilterConfig } = require('../content-filter');

const CODE_EXCLUSIONS = new Set([
  'H264', 'H265', 'X264', 'X265', 'HEVC', 'AV1', 'AAC', 'AC3', 'DDP',
  '1080P', '2160P', '720P', '480P', '4K', '8K',
]);

const CODE_PREFIX_EXCLUSIONS = new Set([
  'RELEASE', 'SCENE', 'EPISODE', 'PART', 'VOL', 'VOLUME', 'DISC', 'DISK',
  'PACK', 'VIDEO', 'MOVIE', 'TITLE', 'DATE', 'UPDATE', 'COMPILATION',
  'PPV',
]);

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function compactKey(value) {
  return compactText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function extractSceneCodes(value) {
  const text = compactText(value).toUpperCase();
  const output = [];
  const seen = new Set();

  const fc2 = text.match(/\bFC2[\s._-]*(?:PPV[\s._-]*)?(\d{5,9})\b/g) || [];
  for (const raw of fc2) {
    const digits = raw.match(/\d{5,9}/)?.[0];
    if (!digits) continue;
    const code = `FC2-PPV-${digits}`;
    if (!seen.has(code)) {
      seen.add(code);
      output.push(code);
    }
  }

  const generic = text.match(/\b[A-Z]{2,12}[\s._-]+\d{2,7}\b/g) || [];
  for (const raw of generic) {
    const code = raw.replace(/[\s._-]+/g, '-');
    const key = compactKey(code);
    const prefix = code.split('-')[0];
    if (!key || CODE_EXCLUSIONS.has(key) || CODE_PREFIX_EXCLUSIONS.has(prefix) ||
        /^(?:19|20)\d{2}$/.test(key)) continue;
    if (!seen.has(code)) {
      seen.add(code);
      output.push(code);
    }
  }

  return Object.freeze(output.slice(0, 4));
}

function normalizedSceneCode(value) {
  const codes = extractSceneCodes(value);
  const code = String(codes[0] || '').toUpperCase();
  if (!code) return '';
  return code.replace(/\d+/g, digits => String(Number.parseInt(digits, 10) || 0));
}

function codesMatch(left, right) {
  const leftCodes = extractSceneCodes(left).map(normalizedSceneCode).filter(Boolean);
  const rightCodes = extractSceneCodes(right).map(normalizedSceneCode).filter(Boolean);
  if (!leftCodes.length || !rightCodes.length) return false;
  const rightSet = new Set(rightCodes);
  return leftCodes.some(code => rightSet.has(code));
}

function detailPageImage(html, detailUrl) {
  const document = String(html || '');
  if (!document || !detailUrl) return '';
  const candidates = [];
  const descriptionBlocks = [
    ...document.matchAll(/<div\b[^>]*\bid=["']torrent-description["'][^>]*>([\s\S]*?)(?:<\/div>|$)/gi),
    ...document.matchAll(/<div\b[^>]*\bclass=["'][^"']*torrent-description[^"']*["'][^>]*>([\s\S]*?)(?:<\/div>|$)/gi),
  ].map(match => match[1]);
  const scopes = descriptionBlocks.length ? descriptionBlocks : [document];
  for (const scope of scopes) {
    for (const match of scope.matchAll(/<img\b[^>]*\b(?:data-src|src)=["']([^"']+)["']/gi)) {
      candidates.push({ value: match[1], requireImageExtension: false });
    }
    // Live Sukebei descriptions are markdown rendered as text in the page.
    // Uploaders commonly paste cover URLs directly instead of using <img>.
    for (const match of scope.matchAll(/https:\/\/[^\s<>"'&]+/gi)) {
      candidates.push({ value: match[0], requireImageExtension: true });
    }
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(String(candidate.value || '').trim(), detailUrl);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      const path = url.pathname.toLowerCase();
      if (candidate.requireImageExtension &&
          !/\.(?:avif|jpe?g|png|webp)$/i.test(path)) continue;
      if (/\.(?:svg|gif)(?:$|\?)/i.test(url.toString())) continue;
      if (/(?:logo|favicon|avatar|icon|smiley|emoji|flag)/i.test(path)) continue;
      if (url.hostname.toLowerCase() === 'sukebei.nyaa.si' && /\/(?:static|img)\//.test(path)) continue;
      return url.toString();
    } catch {
      // Ignore malformed uploader-supplied image URLs.
    }
  }
  return '';
}

function titleOverlap(left, right) {
  const a = new Set(significantTokens(left));
  const b = new Set(significantTokens(right));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(Math.min(a.size, b.size), 1);
}

function dedupeAndRank(items = []) {
  const byIdentity = new Map();
  for (const item of items) {
    const key = compactKey(
      item.sourceId ||
      item.upstreamId ||
      item.detailUrl ||
      `${item.title}|${item.releaseDate || ''}`
    );
    if (!key) continue;
    const previous = byIdentity.get(key);
    if (!previous || Number(item.seeders || 0) > Number(previous.seeders || 0)) {
      byIdentity.set(key, item);
    }
  }
  return [...byIdentity.values()].sort((left, right) => {
    const seederDelta = Number(right.seeders || 0) - Number(left.seeders || 0);
    if (seederDelta) return seederDelta;
    return String(right.releaseDate || '').localeCompare(String(left.releaseDate || ''));
  });
}

function exactCodeEvidence(source, normalized) {
  return Boolean(
    codesMatch(source?.title, normalized?.sceneCode) ||
    codesMatch(source?.title, normalized?.title)
  );
}

function scoreCandidate(source, normalized) {
  if (!normalized?.poster) return 0;
  if (exactCodeEvidence(source, normalized)) return 140;
  const sourceCodes = extractSceneCodes(source.title);
  const candidateCode = compactKey(normalized.sceneCode);
  const candidateTitleKey = compactKey(normalized.title);
  for (const code of sourceCodes) {
    const key = compactKey(code);
    if (candidateCode && candidateCode === key) return 140;
    if (candidateTitleKey.includes(key)) return 125;
  }
  const overlap = titleOverlap(source.title, normalized.title);
  if (overlap >= 0.8) return 100;
  if (overlap >= 0.65) return 85;
  if (overlap >= 0.5) return 72;
  return 0;
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
  return run => new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    drain();
  });
}

function freezeDiagnostics(stats) {
  return Object.freeze({
    ...stats,
    providerRequests: Object.freeze({ ...stats.providerRequests }),
    providerMatches: Object.freeze({ ...stats.providerMatches }),
    providerErrors: Object.freeze({ ...stats.providerErrors }),
    filterReasons: Object.freeze({ ...stats.filterReasons }),
  });
}


function incrementCounter(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount;
}

async function queryExactCodeProvider(provider, metadataClient, source, code, options = {}) {
  const stats = options.stats || {
    exactCodeQueries: 0,
    exactCodeMisses: 0,
    providerRequests: {},
    providerErrors: {},
  };
  if (!metadataClient?.configured || !code) {
    return Object.freeze({ ok: false, provider, code, returned: 0, candidate: null });
  }

  incrementCounter(stats.providerRequests, provider);
  stats.exactCodeQueries += 1;
  try {
    let scenes = [];
    if (provider === 'stashdb' && typeof metadataClient.searchScenes === 'function') {
      scenes = await metadataClient.searchScenes(code, 20, {
        timeoutMs: options.timeoutMs,
      });
    } else if (typeof metadataClient.queryScenes === 'function') {
      scenes = await metadataClient.queryScenes({
        query: code,
        perPage: 20,
        page: 1,
      });
    }

    let best = null;
    for (const raw of Array.isArray(scenes) ? scenes : []) {
      const normalized = normalizeScene(provider, raw);
      if (!normalized || !safeHttpsUrl(normalized.poster) || !exactCodeEvidence(source, normalized)) {
        continue;
      }
      const score = scoreCandidate(source, normalized);
      if (!score) continue;
      const candidate = { provider, raw, normalized, score };
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best) stats.exactCodeMisses += 1;
    return Object.freeze({
      ok: true,
      provider,
      code,
      returned: Array.isArray(scenes) ? scenes.length : 0,
      candidate: best,
    });
  } catch (error) {
    incrementCounter(stats.providerErrors, provider);
    return Object.freeze({
      ok: false,
      provider,
      code,
      returned: 0,
      candidate: null,
      error: String(error?.message || error || 'metadata lookup failed'),
    });
  }
}

function createSukebeiMetadataAdapter(options = {}) {
  const config = options.config || {};
  const clients = options.metadataClients || {};
  const providers = ['stashdb', 'tpdb'].filter(name => clients[name]?.configured);
  const filterConfig = options.filterConfig || readContentFilterConfig(options.env || process.env);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const client = new SourceHttpClient({
    id: 'sukebei',
    endpoint: options.endpoint,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['application/rss+xml', 'application/xml', 'text/xml'],
  });
  const detailOrigin = (() => {
    try { return `${new URL(options.endpoint).origin}/`; } catch { return ''; }
  })();
  const detailClient = detailOrigin ? new SourceHttpClient({
    id: 'sukebei-detail',
    endpoint: detailOrigin,
    timeoutMs: Math.min(Number(config.metadataLookupTimeoutMs || 4_000), 6_000),
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    serializeRequests: false,
    allowHtml: true,
    allowedContentTypes: ['text/html'],
  }) : null;
  const cache = options.cache || new BoundedTtlCache({
    maxEntries: Math.max(Number(config.metadataCacheMaxEntries || 500), 50),
  });
  const index = new Map();
  const runLimited = createLimiter(Math.min(Number(config.sukebeiLookupConcurrency || 8), 10));
  // Sukebei rate-limits bursts of detail-page GETs much more aggressively than
  // metadata APIs. Two concurrent native requests avoid both the old serial
  // queue and the 429/timeout storm caused by reusing metadata concurrency.
  const detailConcurrency = Math.min(
    Math.max(Number(config.sukebeiLookupConcurrency || 8), 1),
    2
  );
  const runDetailLimited = createLimiter(detailConcurrency);
  const positiveTtlMs = Math.max(Number(config.metadataCacheTtlMs || 600_000), 5_000);
  const negativeTtlMs = Math.max(Number(config.metadataNegativeTtlMs || 120_000), 5_000);
  let lastDiagnostics = freezeDiagnostics({
    budgetMs: 0,
    rssRecords: 0,
    rssRecordsRead: 0,
    rssDuplicateRecords: 0,
    rssDuplicatePages: 0,
    rssPages: 0,
    rssPagesRequested: 0,
    rssPagesEffective: 0,
    rssElapsedMs: 0,
    rssCategory: '',
    codeCandidates: 0,
    codeStageJobs: 0,
    codeStageCompleted: 0,
    codeStageMatches: 0,
    codeStageDeadlineSkipped: 0,
    codeStageProvider: '',
    titleStageJobs: 0,
    titleStageCompleted: 0,
    detailStageJobs: 0,
    detailStageCompleted: 0,
    detailStageTarget: 0,
    inspected: 0,
    lookupEligible: 0,
    lookupSkipped: 0,
    deadlineSkipped: 0,
    returned: 0,
    matchedByCode: 0,
    matchedByTitle: 0,
    exactCodeQueries: 0,
    exactCodeMisses: 0,
    detailImageRequests: 0,
    detailImages: 0,
    detailImageErrors: 0,
    nativeImages: 0,
    filtered: 0,
    unmatched: 0,
    cacheHits: 0,
    providerRequests: {},
    providerMatches: {},
    providerErrors: {},
    filterReasons: {},
    detailReserveMs: 0,
    totalElapsedMs: 0,
    deadlineExceededMs: 0,
  });

  function remember(items) {
    for (const item of items) index.set(String(item.sourceId), item);
    return items;
  }

  async function queryProvider(provider, source, query, codeMode, stats, options = {}) {
    const metadataClient = clients[provider];
    if (!metadataClient?.configured || !query) return { candidates: [], ok: false };
    try {
      let scenes = [];
      if (provider === 'stashdb' && typeof metadataClient.searchScenes === 'function') {
        // The working TPB4K backend uses StashDB searchScene(term:) for JAV
        // product codes. SceneQueryInput.code returned no rows for the same
        // live feed, even though searchScene indexes the code column.
        const terms = codeMode
          ? [query, compactText(source.title)].filter((term, index, values) =>
              term && values.indexOf(term) === index)
          : [query];
        const byId = new Map();
        for (const term of terms) {
          stats.providerRequests[provider] = (stats.providerRequests[provider] || 0) + 1;
          if (codeMode) stats.exactCodeQueries += 1;
          const rows = await metadataClient.searchScenes(term, codeMode ? 20 : 10, {
            timeoutMs: options.timeoutMs,
          });
          for (const row of Array.isArray(rows) ? rows : []) {
            const key = String(row?.id || `${row?.code || ''}|${row?.title || ''}`);
            if (key) byId.set(key, row);
          }
          if ([...byId.values()].some(raw => {
            const candidate = normalizeScene(provider, raw);
            return candidate && (!codeMode || exactCodeEvidence(source, candidate));
          })) break;
        }
        scenes = [...byId.values()];
      } else {
        stats.providerRequests[provider] = (stats.providerRequests[provider] || 0) + 1;
        if (codeMode) stats.exactCodeQueries += 1;
        const request = provider === 'stashdb'
          ? {
              title: query,
              perPage: codeMode ? 20 : 10,
              page: 1,
              sort: 'DATE',
            }
          : {
              query,
              perPage: codeMode ? 20 : 30,
              page: 1,
            };
        scenes = await metadataClient.queryScenes({
          ...request,
          timeoutMs: options.timeoutMs,
        });
      }
      const output = [];
      for (const raw of Array.isArray(scenes) ? scenes : []) {
        const normalized = normalizeScene(provider, raw);
        if (codeMode && !exactCodeEvidence(source, normalized)) continue;
        const score = scoreCandidate(source, normalized);
        if (!score) continue;
        output.push({ provider, raw, normalized, score });
      }
      if (codeMode && !output.length) stats.exactCodeMisses += 1;
      return { candidates: output, ok: true };
    } catch {
      stats.providerErrors[provider] = (stats.providerErrors[provider] || 0) + 1;
      return { candidates: [], ok: false };
    }
  }

  async function metadataMatch(source, stats, options = {}) {
    const cacheKey = `sukebei:${source.sourceId}`;
    const cached = cache.getEntry(cacheKey);
    if (cached) {
      stats.cacheHits += 1;
      return cached.negative ? null : cached.value;
    }

    const codes = options.skipCodes ? [] : extractSceneCodes(source.title);
    let best = null;
    let successfulLookup = false;
    let lookupError = false;
    for (const code of codes) {
      for (const provider of providers) {
        if (Date.now() >= Number(options.deadlineAt || Infinity)) break;
        const remaining = Math.max(Number(options.deadlineAt || Infinity) - Date.now(), 250);
        const result = await queryProvider(provider, source, code, true, stats, {
          timeoutMs: Math.min(
            Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
            remaining
          ),
        });
        successfulLookup ||= result.ok;
        lookupError ||= !result.ok;
        for (const candidate of result.candidates) {
          if (!best || candidate.score > best.score) best = candidate;
        }
        if (best?.score >= 120) break;
      }
      if (best?.score >= 120 || Date.now() >= Number(options.deadlineAt || Infinity)) break;
    }
    if (best) stats.matchedByCode += 1;

    if (!best && options.allowTitle && Date.now() < Number(options.deadlineAt || Infinity)) {
      const query = normalizeSearchTitle(source.title).query.slice(0, 140);
      if (query.length >= 6) {
        for (const provider of providers) {
          if (Date.now() >= Number(options.deadlineAt || Infinity)) break;
          const remaining = Math.max(Number(options.deadlineAt || Infinity) - Date.now(), 250);
          const result = await queryProvider(provider, source, query, false, stats, {
            timeoutMs: Math.min(
              Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
              remaining
            ),
          });
          successfulLookup ||= result.ok;
          lookupError ||= !result.ok;
          for (const candidate of result.candidates) {
            if (!best || candidate.score > best.score) best = candidate;
          }
          if (best?.score >= 85) break;
        }
      }
      if (best) stats.matchedByTitle += 1;
    }

    if (!best) {
      // Cache only a confirmed metadata miss. A timeout/network/provider error
      // must be retried on the next request rather than becoming a false miss.
      if (successfulLookup && !lookupError) cache.setNegative(cacheKey, negativeTtlMs);
      return null;
    }

    stats.providerMatches[best.provider] = (stats.providerMatches[best.provider] || 0) + 1;
    const merged = mergeMetadataPreservingIdentity(source, {
      ...best.normalized,
      tags: normalizeTags(best.normalized.tags),
      contentTags: normalizeTags(best.normalized.contentTags || best.normalized.tags),
      metadataProvider: best.provider,
    });
    const enriched = Object.freeze({
      ...merged,
      metadataProvider: best.provider,
      lookupSource: 'sukebei',
      lookupQuery: compactText(codes[0] || normalizeSearchTitle(source.title).query).slice(0, 240),
      contentClassificationKnown: Array.isArray(merged.tags) && merged.tags.length > 0,
    });
    cache.set(cacheKey, enriched, positiveTtlMs);
    return enriched;
  }


  function mergeCandidateForSource(source, candidate, stats, lookupQuery) {
    if (!candidate?.normalized?.poster) return null;
    incrementCounter(stats.providerMatches, candidate.provider);
    const merged = mergeMetadataPreservingIdentity(source, {
      ...candidate.normalized,
      tags: normalizeTags(candidate.normalized.tags),
      contentTags: normalizeTags(candidate.normalized.contentTags || candidate.normalized.tags),
      metadataProvider: candidate.provider,
    });
    const enriched = Object.freeze({
      ...merged,
      metadataProvider: candidate.provider,
      lookupSource: 'sukebei',
      lookupQuery: compactText(lookupQuery || extractSceneCodes(source.title)[0] || '').slice(0, 240),
      contentClassificationKnown: Array.isArray(merged.tags) && merged.tags.length > 0,
    });
    cache.set(`sukebei:${source.sourceId}`, enriched, positiveTtlMs);
    return enriched;
  }

  async function nativeDetailMatch(source, stats, options = {}) {
    if (!detailClient?.configured || !safeHttpsUrl(source.detailUrl)) return null;
    const deadlineAt = Number(options.deadlineAt || Infinity);
    if (Date.now() >= deadlineAt) return null;
    stats.detailImageRequests += 1;
    try {
      const remaining = Math.max(deadlineAt - Date.now(), 250);
      const html = await detailClient.fetchText(source.detailUrl, {
        cacheKey: `sukebei:detail:${source.sourceId}`,
        timeoutMs: Math.min(detailClient.timeoutMs, remaining),
      });
      const poster = detailPageImage(html, source.detailUrl);
      if (!poster) return null;
      stats.detailImages += 1;
      return Object.freeze({
        ...source,
        poster,
        background: poster,
        lookupSource: 'sukebei-detail',
        contentClassificationKnown: Array.isArray(source.tags) && source.tags.length > 0,
      });
    } catch {
      stats.detailImageErrors += 1;
      return null;
    }
  }

  async function enrichOne(source, stats, options = {}) {
    if (safeHttpsUrl(source.poster)) {
      stats.nativeImages += 1;
      return Object.freeze({
        ...source,
        lookupSource: 'sukebei',
        contentClassificationKnown: Array.isArray(source.tags) && source.tags.length > 0,
      });
    }
    const metadata = options.allowMetadata === false
      ? null
      : await metadataMatch(source, stats, options);
    if (metadata) return metadata;
    return nativeDetailMatch(source, stats, options);
  }

  async function catalog({ skip = 0, limit = 40 }) {
    if (!client.configured) return [];
    const requestStartedAt = Date.now();
    const budgetMs = Math.min(
      Math.max(Number(config.sukebeiEnrichmentDeadlineMs || 24_000), 4_000),
      28_000
    );
    const deadlineAt = requestStartedAt + budgetMs;
    const rssDeadlineAt = Math.min(
      deadlineAt,
      requestStartedAt + Math.min(Math.max(Math.floor(budgetMs * 0.35), 4_000), 10_000)
    );
    const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);
    const feed = [];
    const requestedRssPages = Math.min(Math.max(Number(config.sukebeiRssPages || 4), 1), 8);
    const rssPages = (() => {
      try {
        return new URL(client.endpoint).hostname.toLowerCase() === 'sukebei.nyaa.si'
          ? 1
          : requestedRssPages;
      } catch {
        return requestedRssPages;
      }
    })();
    const seenFeedRecords = new Set();
    let fetchedPages = 0;
    let rssRecordsRead = 0;
    let rssDuplicateRecords = 0;
    let rssDuplicatePages = 0;
    for (let page = 1; page <= rssPages; page += 1) {
      if (Date.now() >= rssDeadlineAt) break;
      const pageUrl = new URL(client.endpoint);
      pageUrl.searchParams.set('p', String(page));
      const remaining = Math.max(rssDeadlineAt - Date.now(), 250);
      const payload = await client.fetchText(pageUrl.toString(), {
        cacheKey: `sukebei:rss:${page}`,
        timeoutMs: Math.min(client.timeoutMs, remaining),
      });
      const pageItems = parseRssFeed(payload);
      if (!pageItems.length) break;
      fetchedPages += 1;
      rssRecordsRead += pageItems.length;
      let newRecords = 0;
      for (const item of pageItems) {
        const key = compactText(item.id || item.guid || item.link || item.detailUrl);
        if (!key || seenFeedRecords.has(key)) {
          rssDuplicateRecords += 1;
          continue;
        }
        seenFeedRecords.add(key);
        feed.push(item);
        newRecords += 1;
      }
      // The official RSS endpoint currently ignores `p` and returns the same
      // rolling window. Stop once a later response is at least 90% duplicate.
      if (page > 1 && newRecords <= Math.max(Math.floor(pageItems.length * 0.1), 1)) {
        rssDuplicatePages += 1;
        break;
      }
    }

    const stats = {
      budgetMs,
      rssRecords: feed.length,
      rssRecordsRead,
      rssDuplicateRecords,
      rssDuplicatePages,
      rssPages: fetchedPages,
      rssPagesRequested: requestedRssPages,
      rssPagesEffective: rssPages,
      rssElapsedMs: Date.now() - requestStartedAt,
      rssCategory: (() => {
        try { return new URL(client.endpoint).searchParams.get('c') || ''; } catch { return ''; }
      })(),
      codeCandidates: 0,
      codeStageJobs: 0,
      codeStageCompleted: 0,
      codeStageMatches: 0,
      codeStageDeadlineSkipped: 0,
      codeStageProvider: '',
      titleStageJobs: 0,
      titleStageCompleted: 0,
      detailStageJobs: 0,
      detailStageCompleted: 0,
      detailStageTarget: 0,
      inspected: 0,
      lookupEligible: 0,
      lookupSkipped: 0,
      deadlineSkipped: 0,
      returned: 0,
      matchedByCode: 0,
      matchedByTitle: 0,
      exactCodeQueries: 0,
      exactCodeMisses: 0,
      detailImageRequests: 0,
      detailImages: 0,
      detailImageErrors: 0,
      nativeImages: 0,
      filtered: 0,
      unmatched: 0,
      cacheHits: 0,
      providerRequests: {},
      providerMatches: {},
      providerErrors: {},
      filterReasons: {},
      detailReserveMs: 0,
      totalElapsedMs: 0,
      deadlineExceededMs: 0,
    };

    const normalized = dedupeAndRank(
      feed
        .map((item, position) => normalizeFeedItem('sukebei', item, position))
        .filter(Boolean)
    );
    stats.inspected = normalized.length;
    stats.codeCandidates = normalized.filter(item => extractSceneCodes(item.title).length > 0).length;

    const codeLimit = Math.min(Math.max(Number(config.sukebeiCodeLookupLimit || 40), 1), 60);
    const titleLimit = Math.min(Math.max(Number(config.sukebeiTitleLookupLimit || 4), 0), 20);
    const detailLimit = Math.min(Math.max(Number(config.sukebeiDetailImageLimit || 20), 0), 40);
    const detailTargetLimit = Math.min(detailLimit, 8);
    const detailLookupTimeoutMs = Math.min(
      Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
      6_000
    );
    const detailWaves = detailTargetLimit ? Math.ceil(detailTargetLimit / detailConcurrency) : 0;
    const detailReserveMs = detailTargetLimit
      ? Math.min(
          Math.max((detailWaves * detailLookupTimeoutMs) + 500, 4_000),
          Math.floor(budgetMs / 2)
        )
      : 0;
    const metadataDeadlineAt = Math.max(Date.now(), deadlineAt - detailReserveMs);
    stats.detailReserveMs = detailReserveMs;
    stats.detailStageTarget = detailTargetLimit;
    const resolvedById = new Map();

    // Keep native RSS artwork immediately. A later metadata stage must never
    // overwrite or discard a source record that already has honest artwork.
    for (const item of normalized) {
      if (!safeHttpsUrl(item.poster)) continue;
      stats.nativeImages += 1;
      resolvedById.set(String(item.sourceId), Object.freeze({
        ...item,
        lookupSource: 'sukebei',
        contentClassificationKnown: Array.isArray(item.tags) && item.tags.length > 0,
      }));
    }

    // Rehydrate positive source matches before making any network request.
    for (const item of normalized) {
      if (resolvedById.has(String(item.sourceId))) continue;
      const cached = cache.getEntry(`sukebei:${item.sourceId}`);
      if (cached && !cached.negative && cached.value?.poster) {
        stats.cacheHits += 1;
        resolvedById.set(String(item.sourceId), cached.value);
      }
    }

    // Stage 1: scan every selected unique JAV code with exactly one request to
    // the primary metadata provider. R3 mixed code, full-title and TPDB calls
    // per item, so the deadline expired before reaching codes that the live
    // probe had already proved were matchable. This stage cannot be starved by
    // title fallback or detail-page work.
    const codeJobsByKey = new Map();
    for (const item of normalized) {
      if (resolvedById.has(String(item.sourceId))) continue;
      for (const code of extractSceneCodes(item.title)) {
        const key = normalizedSceneCode(code);
        if (!key) continue;
        let job = codeJobsByKey.get(key);
        if (!job) {
          if (codeJobsByKey.size >= codeLimit) break;
          job = { code, key, sources: [] };
          codeJobsByKey.set(key, job);
        }
        if (!job.sources.some(source => source.sourceId === item.sourceId)) job.sources.push(item);
      }
      if (codeJobsByKey.size >= codeLimit) continue;
    }
    const codeJobs = [...codeJobsByKey.values()];
    stats.codeStageJobs = codeJobs.length;
    const codeProvider = clients.stashdb?.configured
      ? 'stashdb'
      : (clients.tpdb?.configured ? 'tpdb' : '');
    stats.codeStageProvider = codeProvider;

    if (codeProvider) {
      const metadataClient = clients[codeProvider];
      await Promise.all(codeJobs.map(job => runLimited(async () => {
        if (Date.now() >= metadataDeadlineAt) {
          stats.codeStageDeadlineSkipped += 1;
          stats.deadlineSkipped += 1;
          return;
        }
        const remaining = Math.max(metadataDeadlineAt - Date.now(), 250);
        const lookupTimeoutMs = Math.min(
          Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
          remaining,
          3_500
        );
        const result = await queryExactCodeProvider(
          codeProvider,
          metadataClient,
          job.sources[0],
          job.code,
          { stats, timeoutMs: lookupTimeoutMs }
        );
        stats.codeStageCompleted += 1;
        if (result.candidate) {
          let newMatches = 0;
          for (const source of job.sources) {
            const sourceId = String(source.sourceId);
            if (resolvedById.has(sourceId)) continue;
            const enriched = mergeCandidateForSource(source, result.candidate, stats, job.code);
            if (!enriched) continue;
            resolvedById.set(sourceId, enriched);
            newMatches += 1;
          }
          stats.codeStageMatches += newMatches;
          stats.matchedByCode += newMatches;
        }
        if (onProgress && (
          stats.codeStageCompleted === stats.codeStageJobs ||
          stats.codeStageCompleted % 5 === 0
        )) {
          onProgress(Object.freeze({
            stage: 'code',
            completed: stats.codeStageCompleted,
            total: stats.codeStageJobs,
            matches: stats.codeStageMatches,
            provider: codeProvider,
          }));
        }
      })));
    }

    // Stage 2: a very small title fallback only after the complete code scan.
    // Exact-code matches already stored above remain available even if this
    // optional stage reaches the deadline.
    const titleJobs = normalized
      .filter(item => !resolvedById.has(String(item.sourceId)))
      .filter(item => {
        const query = normalizeSearchTitle(item.title).query;
        return (query.match(/[A-Za-z]{3,}/g) || []).length >= 2;
      })
      .slice(0, titleLimit);
    stats.titleStageJobs = titleJobs.length;
    await Promise.all(titleJobs.map(item => runLimited(async () => {
      if (Date.now() >= metadataDeadlineAt) {
        stats.deadlineSkipped += 1;
        return;
      }
      const result = await metadataMatch(item, stats, {
        allowTitle: true,
        skipCodes: true,
        deadlineAt: metadataDeadlineAt,
      });
      stats.titleStageCompleted += 1;
      if (result?.poster && !resolvedById.has(String(item.sourceId))) {
        resolvedById.set(String(item.sourceId), result);
      }
    })));

    // Stage 3: native detail-page images use a reserved final window inside
    // the one end-to-end deadline, so fallback work cannot extend the request.
    const unresolvedDetails = normalized
      .filter(item => !resolvedById.has(String(item.sourceId)) && safeHttpsUrl(item.detailUrl));
    const detailJobs = [
      ...unresolvedDetails.filter(item => extractSceneCodes(item.title).length > 0),
      ...unresolvedDetails.filter(item => extractSceneCodes(item.title).length === 0),
    ].slice(0, detailLimit);
    const detailDeadlineAt = Math.min(deadlineAt, Date.now() + detailReserveMs);
    stats.detailStageJobs = detailJobs.length;
    await Promise.all(detailJobs.map(item => runDetailLimited(async () => {
      if (resolvedById.size >= detailTargetLimit) return;
      if (Date.now() >= detailDeadlineAt) {
        stats.deadlineSkipped += 1;
        return;
      }
      const result = await nativeDetailMatch(item, stats, { deadlineAt: detailDeadlineAt });
      stats.detailStageCompleted += 1;
      if (result?.poster && !resolvedById.has(String(item.sourceId))) {
        resolvedById.set(String(item.sourceId), result);
      }
    })));

    stats.lookupEligible = normalized.filter(item =>
      safeHttpsUrl(item.poster) ||
      extractSceneCodes(item.title).length > 0 ||
      safeHttpsUrl(item.detailUrl)
    ).length;
    stats.lookupSkipped = normalized.length - stats.lookupEligible;
    stats.unmatched = Math.max(normalized.length - resolvedById.size, 0);

    const allowed = [];
    for (const source of normalized) {
      const item = resolvedById.get(String(source.sourceId));
      if (!item) continue;
      const evaluation = evaluateContent(item, filterConfig);
      if (!evaluation.excluded) {
        allowed.push(item);
        continue;
      }
      stats.filtered += 1;
      incrementCounter(stats.filterReasons, evaluation.reason);
    }

    const window = allowed.slice(safeSkip, safeSkip + safeLimit);
    stats.returned = window.length;
    stats.totalElapsedMs = Date.now() - requestStartedAt;
    stats.deadlineExceededMs = Math.max(Date.now() - deadlineAt, 0);
    lastDiagnostics = freezeDiagnostics(stats);
    return remember(window);
  }

  async function meta({ sourceId }) {
    return index.get(String(sourceId || '')) || null;
  }

  return Object.freeze({
    id: 'sukebei',
    configured: client.configured,
    catalog,
    meta,
    async resolve() {
      return [];
    },
    diagnostics() {
      return Object.freeze({ sukebeiMetadata: lastDiagnostics });
    },
  });
}

module.exports = {
  CODE_PREFIX_EXCLUSIONS,
  codesMatch,
  createSukebeiMetadataAdapter,
  dedupeAndRank,
  detailPageImage,
  exactCodeEvidence,
  extractSceneCodes,
  normalizedSceneCode,
  queryExactCodeProvider,
  scoreCandidate,
  titleOverlap,
};
