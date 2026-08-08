'use strict';

const { BoundedTtlCache } = require('./cache');
const { normalizeInfoHash } = require('./candidate');
const { normalizeFeedItem, parseRssFeed } = require('./discovery-normalize');
const { encodeTpb4kId } = require('./id-codec');
const { decodeTorrent, readBoundedBuffer, safeNativeRequest } = require('./native-discovery');
const { SourceHttpClient, normalizeContentType } = require('./source-http');
const { sukebeiTorrentUrl } = require('./sukebei-metadata');
const { createSukebeiHentaiSqliteStore } = require('../sukebei-hentai-sqlite');
const { createAniListClient, createJikanClient } = require('./sukebei-hentai-metadata');
const {
  bestMetadataMatch,
  classifyRelease,
  cleanReleaseTitle,
  cleanText,
  metadataAliases,
  normalizedTitle,
  selectEpisodeFile,
} = require('./sukebei-hentai-title');

const CATALOG_ID = 'tpb4k.sukebei.hentai';
const SOURCE_ID = 'sukebei-hentai';
const MAX_TORRENT_BYTES = 2_000_000;
const DEFAULT_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BUILD_BUDGET_MS = 7 * 60 * 1000;
const DEFAULT_MINIMUM_CARDS = 18;
const DEFAULT_BUILD_CANDIDATES = 80;
const DEFAULT_STREAM_RESOLVE_BUDGET_MS = 12_000;
const DEFAULT_RESOLVE_CONCURRENCY = 4;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback;
}

function unique(values, limit = 100) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanText(value, 300))
    .filter(Boolean))].slice(0, limit);
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function releaseId(value = {}) {
  return normalizeInfoHash(value.infoHash) || cleanText(value.detailUrl || value.sourceId, 500);
}

function episodeSourceId(parentId, episode) {
  return `${String(parentId)}:episode:${Math.max(Number(episode || 1), 1)}`;
}

function episodeFromSourceId(sourceId) {
  const match = String(sourceId || '').match(/:episode:(\d{1,4})$/);
  return match ? Math.max(Number(match[1] || 1), 1) : 0;
}

function rssUrl(endpoint, query = '') {
  const url = new URL(String(endpoint));
  url.searchParams.set('page', 'rss');
  url.searchParams.set('c', '1_1');
  url.searchParams.set('f', '0');
  url.searchParams.delete('skip');
  url.searchParams.delete('limit');
  url.searchParams.delete('mode');
  url.searchParams.delete('p');
  if (query) url.searchParams.set('q', cleanText(query, 160));
  else url.searchParams.delete('q');
  return url.toString();
}

function normalizeRelease(raw = {}, position = 0) {
  const normalized = normalizeFeedItem(SOURCE_ID, raw, position);
  if (!normalized) return null;
  const infoHash = normalizeInfoHash(normalized.infoHash);
  const detailUrl = cleanText(normalized.detailUrl, 1_000);
  if (!infoHash || !detailUrl) return null;
  const classification = classifyRelease(normalized.title);
  return Object.freeze({
    sourceId: normalized.sourceId,
    title: normalized.title,
    cleanTitle: cleanReleaseTitle(normalized.title),
    infoHash,
    detailUrl,
    torrentUrl: sukebeiTorrentUrl(normalized),
    seeders: Math.max(Number(normalized.seeders || 0), 0),
    size: normalized.size,
    published: normalized.releaseDate,
    sortDate: timestamp(normalized.releaseDate),
    trackers: Object.freeze([...(normalized.trackers || [])]),
    classification,
  });
}

function releaseCandidate(release = {}) {
  return Object.freeze({
    infoHash: release.infoHash,
    title: release.title,
    filename: release.title,
    resolution: release.classification?.resolution || '',
    indexer: SOURCE_ID,
    seeders: Math.max(Number(release.seeders || 0), 0),
    size: release.size,
  });
}

function verifiedReleaseCandidate(release = {}, decoded = null, episode = 1) {
  if (!decoded) return null;
  const selected = selectEpisodeFile(decoded.files, episode, {
    releaseEpisode: release.classification?.episode,
    batchRange: release.classification?.batchRange,
  });
  if (!selected) return null;
  return Object.freeze({
    ...releaseCandidate(release),
    filename: selected.path,
    fileIdx: selected.index,
    size: selected.length || release.size,
    trackers: Object.freeze([...new Set([
      ...(release.trackers || []),
      ...(decoded.trackers || []),
    ])]),
  });
}

function rankMetadata(rows = []) {
  const score = item => {
    const ranks = item?.ranks || {};
    return (ranks.latest ? 4_000 - ranks.latest : 0)
      + (ranks.trending ? 3_000 - ranks.trending : 0)
      + (ranks.top ? 2_000 - ranks.top : 0)
      + Math.min(Number(item?.popularity || 0), 100_000) / 1_000
      + Number(item?.averageScore || 0);
  };
  return [...(Array.isArray(rows) ? rows : [])]
    .filter(item => item?.sourceId && item?.title && item?.poster && item?.adult !== false)
    .sort((left, right) => score(right) - score(left));
}

function matchReleases(metadata, releases, threshold = 0.72) {
  return (Array.isArray(releases) ? releases : [])
    .map(release => ({ release, match: bestMetadataMatch(release.title, metadata) }))
    .filter(value => value.match.score >= threshold)
    .sort((left, right) => right.match.score - left.match.score
      || right.release.seeders - left.release.seeders)
    .map(value => Object.freeze({ ...value.release, matchScore: value.match.score, matchedAlias: value.match.alias }));
}

function effectiveEpisodeCount(metadata, releases) {
  const declared = Math.min(Math.max(Number(metadata?.episodes || 0), 0), 500);
  let inferred = 0;
  for (const release of releases) {
    inferred = Math.max(inferred, Number(release?.classification?.episode || 0));
    inferred = Math.max(inferred, Number(release?.classification?.batchRange?.end || 0));
  }
  return Math.min(Math.max(declared, inferred, 1), 500);
}

function releasesForEpisode(releases, episode) {
  const exact = releases.filter(release => Number(release?.classification?.episode || 0) === episode);
  const batch = releases.filter(release => {
    const range = release?.classification?.batchRange;
    return range && episode >= Number(range.start) && episode <= Number(range.end);
  });
  const unknown = releases.filter(release => !release?.classification?.episode && !release?.classification?.batchRange);
  return [...exact, ...batch, ...unknown]
    .filter((release, index, values) => values.findIndex(other => releaseId(other) === releaseId(release)) === index)
    .sort((left, right) => right.seeders - left.seeders)
    .slice(0, 12);
}

function prioritizedHydrationReleases(discovered = [], alternativesPerSeries = 12) {
  const groups = (Array.isArray(discovered) ? discovered : [])
    .map(entry => (Array.isArray(entry?.matched) ? entry.matched : [])
      .filter(release => normalizeInfoHash(release?.infoHash))
      .slice(0, Math.max(Number(alternativesPerSeries || 0), 1)))
    .filter(group => group.length);
  const output = [];
  const seen = new Set();
  const depth = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < depth; index += 1) {
    for (const group of groups) {
      const release = group[index];
      const infoHash = normalizeInfoHash(release?.infoHash);
      if (!infoHash || seen.has(infoHash)) continue;
      seen.add(infoHash);
      output.push(release);
    }
  }
  return output;
}

function buildSeriesRecords(metadata, matchedReleases, options = {}) {
  const releases = [...(Array.isArray(matchedReleases) ? matchedReleases : [])]
    .filter(release => release?.infoHash)
    .sort((left, right) => right.seeders - left.seeders);
  if (!releases.length) return null;
  const episodeCount = effectiveEpisodeCount(metadata, releases);
  const allTags = unique([
    'Hentai',
    ...(metadata.genres || []),
    ...(metadata.tags || []),
    ...releases.flatMap(release => release.classification?.tags || []),
  ], 60);
  const releaseDate = String(metadata.releaseDate || releases[0]?.published || '');
  const studio = unique(metadata.studios || [], 1)[0] || '';
  const description = [
    metadata.description,
    `Indexed from ${releases.length} verified Sukebei Anime release${releases.length === 1 ? '' : 's'}.`,
  ].filter(Boolean).join('\n\n');
  const episodeItems = [];
  const videos = [];
  const decodedTorrents = options.decodedTorrents instanceof Map
    ? options.decodedTorrents
    : new Map();
  const requireResolved = options.requireResolved === true;
  for (let episode = 1; episode <= episodeCount; episode += 1) {
    const episodeReleases = releasesForEpisode(releases, episode);
    if (!episodeReleases.length) continue;
    const sourceId = episodeSourceId(metadata.sourceId, episode);
    const candidates = episodeReleases
      .map(release => verifiedReleaseCandidate(
        release,
        decodedTorrents.get(normalizeInfoHash(release.infoHash)),
        episode
      ) || (requireResolved ? null : releaseCandidate(release)))
      .filter(Boolean);
    if (!candidates.length) continue;
    const id = encodeTpb4kId({ source: SOURCE_ID, sourceId, catalogId: CATALOG_ID, torrents: candidates });
    const episodeTitle = `${metadata.title} · Episode ${episode}`;
    videos.push(Object.freeze({
      id,
      title: `Episode ${episode}`,
      season: 1,
      episode,
      released: releaseDate,
      thumbnail: metadata.poster,
      overview: episodeTitle,
    }));
    const item = Object.freeze({
      sourceId,
      title: episodeTitle,
      poster: metadata.poster,
      background: metadata.background || metadata.poster,
      description,
      studio,
      performers: [],
      tags: allTags,
      contentTags: allTags,
      contentClassificationKnown: true,
      releaseDate,
      seeders: Math.max(...episodeReleases.map(release => release.seeders), 0),
      resolution: episodeReleases.map(release => release.classification?.resolution).find(Boolean) || '',
      playbackCandidates: candidates,
      episode,
      seriesSlug: metadata.sourceId,
      metadataProvider: metadata.provider,
      upstreamId: metadata.externalId,
      lookupSource: SOURCE_ID,
      lookupQuery: episodeReleases[0]?.matchedAlias || metadata.title,
      sukebeiHentai: Object.freeze({
        parentId: metadata.sourceId,
        episode,
        releases: Object.freeze(episodeReleases),
      }),
    });
    episodeItems.push(Object.freeze({
      sourceId,
      parentId: metadata.sourceId,
      title: episodeTitle,
      searchText: unique([episodeTitle, ...metadataAliases(metadata), ...allTags, studio, ...episodeReleases.map(row => row.title)], 100).join(' '),
      sortDate: Math.max(timestamp(releaseDate), ...episodeReleases.map(row => row.sortDate || 0)),
      seeders: item.seeders,
      item,
    }));
  }
  if (!videos.length) return null;
  const seriesItem = Object.freeze({
    sourceId: metadata.sourceId,
    title: metadata.title,
    poster: metadata.poster,
    background: metadata.background || metadata.poster,
    description,
    studio,
    performers: [],
    tags: allTags,
    contentTags: allTags,
    contentClassificationKnown: true,
    releaseDate,
    seeders: Math.max(...releases.map(release => release.seeders), 0),
    resolution: releases.map(release => release.classification?.resolution).find(Boolean) || '',
    videos: Object.freeze(videos),
    metadataProvider: metadata.provider,
    upstreamId: metadata.externalId,
    lookupSource: SOURCE_ID,
    lookupQuery: metadata.title,
  });
  const seriesRecord = Object.freeze({
    sourceId: metadata.sourceId,
    parentId: metadata.sourceId,
    title: metadata.title,
    searchText: unique([
      metadata.title,
      ...metadataAliases(metadata),
      ...allTags,
      studio,
      ...releases.map(row => row.title),
    ], 160).join(' '),
    sortDate: Math.max(timestamp(releaseDate), ...releases.map(row => row.sortDate || 0)),
    seeders: seriesItem.seeders,
    item: seriesItem,
  });
  const releaseRecords = releases.map(release => Object.freeze({
    infoHash: release.infoHash,
    parentId: metadata.sourceId,
    episode: Number(release.classification?.episode || 0),
    title: release.title,
    release,
  }));
  return Object.freeze({ seriesRecord, episodeItems: Object.freeze(episodeItems), releaseRecords: Object.freeze(releaseRecords) });
}

function createSukebeiHentaiAdapter(options = {}) {
  const config = options.config || {};
  const env = options.env || process.env;
  const endpoint = config.discovery?.sukebeiHentai || 'https://sukebei.nyaa.si/?page=rss&c=1_1&f=0';
  const client = new SourceHttpClient({
    id: SOURCE_ID,
    endpoint,
    timeoutMs: Math.min(Math.max(Number(config.requestTimeoutMs || 15_000), 1_000), 20_000),
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['application/rss+xml', 'application/xml', 'text/xml'],
    minRequestIntervalMs: options.minRequestIntervalMs ?? 300,
    maxRetries: options.maxRetries ?? 1,
    retryBaseDelayMs: options.retryBaseDelayMs,
    now: options.now,
    sleep: options.sleep,
  });
  const metadata = options.sukebeiHentaiMetadataClients || Object.freeze({
    anilist: createAniListClient({ fetchImpl: options.fetchImpl, timeoutMs: config.requestTimeoutMs }),
    jikan: createJikanClient({ fetchImpl: options.fetchImpl, timeoutMs: config.requestTimeoutMs }),
  });
  const store = options.sukebeiHentaiStore || createSukebeiHentaiSqliteStore({ env });
  const memory = new Map();
  const torrentCache = new BoundedTtlCache({ maxEntries: 300 });
  const indexTtlMs = boundedInteger(env.ONLYPORN_SUKEBEI_HENTAI_INDEX_TTL_MS, DEFAULT_INDEX_TTL_MS, 60_000, 24 * 60 * 60 * 1000);
  const buildBudgetMs = boundedInteger(env.ONLYPORN_SUKEBEI_HENTAI_BUILD_BUDGET_MS, DEFAULT_BUILD_BUDGET_MS, 30_000, 10 * 60 * 1000);
  const minimumCards = boundedInteger(env.ONLYPORN_SUKEBEI_HENTAI_MIN_CARDS, DEFAULT_MINIMUM_CARDS, 6, 80);
  const buildCandidates = boundedInteger(env.ONLYPORN_SUKEBEI_HENTAI_BUILD_CANDIDATES, DEFAULT_BUILD_CANDIDATES, 20, 140);
  const matchThreshold = boundedInteger(env.ONLYPORN_SUKEBEI_HENTAI_MATCH_PERCENT, 72, 60, 95) / 100;
  const streamResolveBudgetMs = boundedInteger(
    env.ONLYPORN_SUKEBEI_HENTAI_STREAM_RESOLVE_BUDGET_MS,
    DEFAULT_STREAM_RESOLVE_BUDGET_MS,
    2_000,
    24_000
  );
  const resolveConcurrency = boundedInteger(
    env.ONLYPORN_SUKEBEI_HENTAI_RESOLVE_CONCURRENCY,
    DEFAULT_RESOLVE_CONCURRENCY,
    1,
    8
  );
  let buildInFlight = null;
  let lastDiagnostics = Object.freeze({ state: 'cold', cards: 0 });

  function rememberRecords(records) {
    if (!records) return;
    memory.set(records.seriesRecord.sourceId, records.seriesRecord.item);
    for (const row of records.episodeItems) memory.set(row.sourceId, row.item);
  }

  async function cachedMetadata(provider, key, loader) {
    try {
      const cached = await store.getMetadata(provider, key);
      if (cached) return cached;
    } catch {}
    const result = await loader();
    if (result) {
      try { await store.putMetadata(provider, key, result); } catch {}
    }
    return result;
  }

  async function fetchReleases(query, deadlineAt) {
    if (Date.now() >= deadlineAt) return [];
    const url = rssUrl(endpoint, query);
    const payload = await client.fetchText(url, {
      cacheKey: `sukebei-hentai:rss:${normalizedTitle(query)}`,
      timeoutMs: Math.min(Math.max(deadlineAt - Date.now(), 250), client.timeoutMs),
    });
    return parseRssFeed(payload).map(normalizeRelease).filter(Boolean);
  }

  async function releasesForMetadata(item, latestFeed, deadlineAt) {
    let releases = matchReleases(item, latestFeed, matchThreshold);
    const aliases = metadataAliases(item)
      .filter(alias => alias.length >= 3)
      .sort((left, right) => left.length - right.length)
      .slice(0, 2);
    for (const alias of aliases) {
      if (releases.length >= 12 || Date.now() >= deadlineAt) break;
      let rows = [];
      try { rows = await fetchReleases(alias, deadlineAt); } catch { rows = []; }
      releases = matchReleases(item, [...releases, ...rows], matchThreshold)
        .filter((release, index, values) => values.findIndex(other => other.infoHash === release.infoHash) === index);
    }
    return releases;
  }

  async function metadataCatalog() {
    const rows = await cachedMetadata('anilist', 'adult-catalog-v1', () => metadata.anilist.catalog());
    return rankMetadata(rows);
  }

  async function buildIndex() {
    const startedAt = Date.now();
    const deadlineAt = startedAt + buildBudgetMs;
    const hydrationReserveMs = Math.min(
      Math.max(Math.floor(buildBudgetMs * 0.30), 10_000),
      150_000,
      Math.max(buildBudgetMs - 10_000, 1_000)
    );
    const discoveryDeadlineAt = deadlineAt - hydrationReserveMs;
    const candidates = (await metadataCatalog()).slice(0, buildCandidates);
    if (!candidates.length) throw new Error('AniList returned no adult animation metadata');
    let latestFeed = [];
    try { latestFeed = await fetchReleases('', discoveryDeadlineAt); } catch { latestFeed = []; }
    const discovered = [];
    let metadataChecked = 0;
    let sourceQueries = 1;
    for (const item of candidates) {
      if (Date.now() >= discoveryDeadlineAt) break;
      metadataChecked += 1;
      const matched = await releasesForMetadata(item, latestFeed, discoveryDeadlineAt);
      sourceQueries += Math.min(metadataAliases(item).filter(alias => alias.length >= 3).length, 2);
      if (!matched.length) continue;
      discovered.push(Object.freeze({ item, matched }));
      if (discovered.length >= 60) break;
    }
    // Hydrate breadth before depth. Live Sukebei torrent downloads commonly
    // take several seconds, so processing every alternative for the first
    // title can exhaust the build budget before later series receive even one
    // verified file index. Round-robin ordering gives every discovered series
    // its best release first, then uses the remaining budget for alternatives.
    const hydrationQueue = prioritizedHydrationReleases(discovered, 12);
    const decodedTorrents = await decodeReleaseSet(hydrationQueue, deadlineAt, resolveConcurrency);
    const seriesItems = [];
    const episodeItems = [];
    const releases = [];
    for (const { item, matched } of discovered) {
      const records = buildSeriesRecords(item, matched, { decodedTorrents, requireResolved: true });
      if (!records) continue;
      rememberRecords(records);
      seriesItems.push(records.seriesRecord);
      episodeItems.push(...records.episodeItems);
      releases.push(...records.releaseRecords);
    }
    if (seriesItems.length < minimumCards) {
      throw new Error(
        `Sukebei Hentai built ${seriesItems.length}/${minimumCards} required playable series `
        + `(${discovered.length} matched, ${decodedTorrents.size}/${hydrationQueue.length} torrents hydrated)`
      );
    }
    const build = Object.freeze({
      status: 'complete',
      completedAt: Date.now(),
      startedAt,
      elapsedMs: Date.now() - startedAt,
      cards: seriesItems.length,
      episodes: episodeItems.length,
      releases: releases.length,
      hydratedTorrents: decodedTorrents.size,
      hydrationCandidates: hydrationQueue.length,
      metadataChecked,
      sourceQueries,
      category: '1_1',
      metadataProviders: Object.freeze(['anilist']),
      searchFallbackProviders: Object.freeze(['jikan']),
    });
    const write = await store.replaceIndex({ seriesItems, episodeItems, releases, build });
    if (store.enabled && write?.written !== true) {
      throw new Error(`Sukebei Hentai SQLite index was not written: ${write?.reason || 'unknown'}`);
    }
    lastDiagnostics = Object.freeze({ state: 'ready', ...build, db: write || null });
    return seriesItems.map(row => row.item);
  }

  async function storedRows(query = '', limit = 100, offset = 0) {
    try {
      const rows = await store.listSeries({ query, limit, offset });
      for (const item of rows) memory.set(String(item.sourceId), item);
      if (rows.length || store.enabled !== false) return rows;
    } catch {
      // The in-memory copy remains usable when the bounded helper process is
      // unavailable. It is never shared with MetaTube or another catalog.
    }
    const values = [...memory.values()].filter(item => !episodeFromSourceId(item.sourceId));
    const wanted = normalizedTitle(query);
    return values.filter(item => !wanted || normalizedTitle([item.title, ...(item.tags || [])].join(' ')).includes(wanted)).slice(offset, offset + limit);
  }

  async function ensureIndex({ waitForComplete = false } = {}) {
    let state = null;
    let rows = [];
    try {
      [state, rows] = await Promise.all([store.state(), storedRows('', 100, 0)]);
    } catch {}
    const age = Date.now() - Number(state?.updatedAt || 0);
    const complete = state?.value?.status === 'complete' && rows.length >= minimumCards;
    if (complete && age < indexTtlMs) {
      lastDiagnostics = Object.freeze({ state: 'ready-cache', ...state.value, cacheAgeMs: age });
      return rows;
    }
    if (!buildInFlight) {
      buildInFlight = buildIndex()
        .catch(error => {
          lastDiagnostics = Object.freeze({ state: 'failed', error: cleanText(error?.message || error, 500), cachedCards: rows.length });
          throw error;
        })
        .finally(() => { buildInFlight = null; });
    }
    if (rows.length >= minimumCards && !waitForComplete) {
      buildInFlight.catch(() => {});
      return rows;
    }
    return buildInFlight;
  }

  async function targetedSearch(query, deadlineAt) {
    let metadataRows = [];
    try { metadataRows = await metadata.anilist.search(query); } catch { metadataRows = []; }
    if (!metadataRows.length && Date.now() < deadlineAt) {
      try { metadataRows = await metadata.jikan.search(query); } catch { metadataRows = []; }
    }
    const discoveryDeadlineAt = Math.max(Date.now(), deadlineAt - streamResolveBudgetMs);
    const discovered = [];
    for (const item of rankMetadata(metadataRows).slice(0, 4)) {
      if (Date.now() >= discoveryDeadlineAt) break;
      const matched = await releasesForMetadata(item, [], discoveryDeadlineAt);
      if (!matched.length) continue;
      discovered.push(Object.freeze({ item, matched }));
    }
    const decodedTorrents = await decodeReleaseSet(
      prioritizedHydrationReleases(discovered, 12),
      deadlineAt,
      resolveConcurrency
    );
    const output = [];
    for (const { item, matched } of discovered) {
      const records = buildSeriesRecords(item, matched, { decodedTorrents, requireResolved: true });
      if (!records) continue;
      rememberRecords(records);
      output.push(records.seriesRecord.item);
    }
    return output;
  }

  async function catalog({ catalog: definition, skip = 0, limit = 40 }) {
    if (!client.configured) return [];
    const query = cleanText(definition?.searchQuery, 160);
    const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);
    await ensureIndex({ waitForComplete: true });
    let rows = await storedRows(query, safeLimit, safeSkip);
    if (query && !rows.length) {
      rows = await targetedSearch(query, Date.now() + Math.min(buildBudgetMs, 45_000));
    }
    return rows.slice(0, safeLimit);
  }

  async function meta({ sourceId }) {
    const key = String(sourceId || '');
    if (memory.has(key)) return memory.get(key);
    try {
      const item = await store.getItem(key);
      if (item) memory.set(key, item);
      return item || null;
    } catch {
      return null;
    }
  }

  async function decodeReleaseTorrent(release, deadlineAt = Number.POSITIVE_INFINITY) {
    const key = `torrent:${release.infoHash}`;
    const cached = torrentCache.getEntry(key);
    if (cached) return cached.negative ? null : cached.value;
    const torrentUrl = sukebeiTorrentUrl(release);
    if (!torrentUrl) {
      torrentCache.setNegative(key, 5 * 60 * 1000);
      return null;
    }
    let request;
    try {
      const remainingMs = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 8_000;
      if (remainingMs <= 250) return null;
      const parsed = new URL(torrentUrl);
      request = await safeNativeRequest(torrentUrl, {
        fetchImpl: options.fetchImpl,
        checkDns: options.checkDns,
        timeoutMs: Math.min(
          Math.min(Math.max(Number(config.requestTimeoutMs || 15_000), 1_000), 8_000),
          Math.max(remainingMs, 250)
        ),
        origin: parsed.origin,
        allowedHosts: new Set([parsed.hostname.toLowerCase()]),
        headers: {
          Accept: 'application/x-bittorrent, application/octet-stream;q=0.9',
          'User-Agent': 'OnlyPorn-Sukebei-Hentai/1.0',
        },
      });
      const status = Number(request.response?.status || 0);
      const type = normalizeContentType(request.response?.headers?.get?.('content-type'));
      if (status < 200 || status >= 300 || (type && !['application/x-bittorrent', 'application/octet-stream'].includes(type))) {
        throw new Error('Sukebei torrent download was rejected');
      }
      const decoded = decodeTorrent(await readBoundedBuffer(request.response, MAX_TORRENT_BYTES));
      if (normalizeInfoHash(decoded.infoHash) !== normalizeInfoHash(release.infoHash)) {
        throw new Error('Sukebei torrent hash did not match the RSS identity');
      }
      torrentCache.set(key, decoded, 24 * 60 * 60 * 1000);
      return decoded;
    } catch {
      if (!Number.isFinite(deadlineAt) || Date.now() + 250 < deadlineAt) {
        torrentCache.setNegative(key, 5 * 60 * 1000);
      }
      return null;
    } finally {
      request?.clearTimeout?.();
    }
  }

  async function decodeReleaseSet(releases, deadlineAt, concurrency = resolveConcurrency) {
    const uniqueRows = new Map();
    for (const release of Array.isArray(releases) ? releases : []) {
      const infoHash = normalizeInfoHash(release?.infoHash);
      if (infoHash && !uniqueRows.has(infoHash)) uniqueRows.set(infoHash, release);
    }
    const rows = [...uniqueRows.values()];
    const decoded = new Map();
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length && Date.now() < deadlineAt) {
        const release = rows[cursor];
        cursor += 1;
        const torrent = await decodeReleaseTorrent(release, deadlineAt);
        if (torrent) decoded.set(normalizeInfoHash(release.infoHash), torrent);
      }
    }
    const workers = Math.min(Math.max(Number(concurrency || 1), 1), rows.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return decoded;
  }

  async function resolve({ sourceId, item }) {
    const rawItem = item?.sukebeiHentai ? item : await meta({ sourceId });
    const episode = Number(rawItem?.sukebeiHentai?.episode || episodeFromSourceId(sourceId) || 1);
    const releases = Array.isArray(rawItem?.sukebeiHentai?.releases) ? rawItem.sukebeiHentai.releases : [];
    const wanted = releases.slice(0, 12);
    const decodedTorrents = await decodeReleaseSet(
      wanted,
      Date.now() + streamResolveBudgetMs,
      resolveConcurrency
    );
    return wanted.map(release => {
      const verified = verifiedReleaseCandidate(
        release,
        decodedTorrents.get(normalizeInfoHash(release.infoHash)),
        episode
      );
      if (!verified) return null;
      return Object.freeze({
        ...verified,
        source: SOURCE_ID,
        sourceId: String(sourceId || ''),
        detailUrl: release.detailUrl,
        provenance: Object.freeze(['sukebei-anime-rss', 'episode-file-verified']),
      });
    }).filter(Boolean);
  }

  return Object.freeze({
    id: SOURCE_ID,
    configured: client.configured && Boolean(metadata.anilist?.configured),
    catalog,
    meta,
    resolve,
    diagnostics() {
      return Object.freeze({ sukebeiHentai: lastDiagnostics });
    },
    store,
  });
}

module.exports = {
  CATALOG_ID,
  DEFAULT_BUILD_BUDGET_MS,
  DEFAULT_BUILD_CANDIDATES,
  DEFAULT_INDEX_TTL_MS,
  DEFAULT_MINIMUM_CARDS,
  DEFAULT_RESOLVE_CONCURRENCY,
  DEFAULT_STREAM_RESOLVE_BUDGET_MS,
  SOURCE_ID,
  buildSeriesRecords,
  createSukebeiHentaiAdapter,
  effectiveEpisodeCount,
  episodeFromSourceId,
  episodeSourceId,
  matchReleases,
  normalizeRelease,
  prioritizedHydrationReleases,
  releasesForEpisode,
  rssUrl,
  verifiedReleaseCandidate,
};
