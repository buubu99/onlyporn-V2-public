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

function buildSeriesRecords(metadata, matchedReleases) {
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
  for (let episode = 1; episode <= episodeCount; episode += 1) {
    const episodeReleases = releasesForEpisode(releases, episode);
    if (!episodeReleases.length) continue;
    const sourceId = episodeSourceId(metadata.sourceId, episode);
    const candidates = episodeReleases.map(releaseCandidate);
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
      if (releases.length >= 4 || Date.now() >= deadlineAt) break;
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
    const candidates = (await metadataCatalog()).slice(0, buildCandidates);
    if (!candidates.length) throw new Error('AniList returned no adult animation metadata');
    let latestFeed = [];
    try { latestFeed = await fetchReleases('', deadlineAt); } catch { latestFeed = []; }
    const seriesItems = [];
    const episodeItems = [];
    const releases = [];
    let metadataChecked = 0;
    let sourceQueries = 1;
    for (const item of candidates) {
      if (Date.now() >= deadlineAt) break;
      metadataChecked += 1;
      const matched = await releasesForMetadata(item, latestFeed, deadlineAt);
      sourceQueries += Math.min(metadataAliases(item).filter(alias => alias.length >= 3).length, 2);
      const records = buildSeriesRecords(item, matched);
      if (!records) continue;
      rememberRecords(records);
      seriesItems.push(records.seriesRecord);
      episodeItems.push(...records.episodeItems);
      releases.push(...records.releaseRecords);
      if (seriesItems.length >= 60) break;
    }
    if (seriesItems.length < minimumCards) {
      throw new Error(`Sukebei Hentai built ${seriesItems.length}/${minimumCards} required playable series`);
    }
    const build = Object.freeze({
      status: 'complete',
      completedAt: Date.now(),
      startedAt,
      elapsedMs: Date.now() - startedAt,
      cards: seriesItems.length,
      episodes: episodeItems.length,
      releases: releases.length,
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
    const output = [];
    for (const item of rankMetadata(metadataRows).slice(0, 4)) {
      if (Date.now() >= deadlineAt) break;
      const matched = await releasesForMetadata(item, [], deadlineAt);
      const records = buildSeriesRecords(item, matched);
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

  async function decodeReleaseTorrent(release) {
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
      const parsed = new URL(torrentUrl);
      request = await safeNativeRequest(torrentUrl, {
        fetchImpl: options.fetchImpl,
        checkDns: options.checkDns,
        timeoutMs: Math.min(Math.max(Number(config.requestTimeoutMs || 15_000), 1_000), 8_000),
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
      torrentCache.setNegative(key, 5 * 60 * 1000);
      return null;
    } finally {
      request?.clearTimeout?.();
    }
  }

  async function resolve({ sourceId, item }) {
    const rawItem = item?.sukebeiHentai ? item : await meta({ sourceId });
    const episode = Number(rawItem?.sukebeiHentai?.episode || episodeFromSourceId(sourceId) || 1);
    const releases = Array.isArray(rawItem?.sukebeiHentai?.releases) ? rawItem.sukebeiHentai.releases : [];
    const candidates = [];
    for (const release of releases.slice(0, 12)) {
      const decoded = await decodeReleaseTorrent(release);
      if (!decoded) continue;
      const selected = selectEpisodeFile(decoded.files, episode, {
        releaseEpisode: release.classification?.episode,
        batchRange: release.classification?.batchRange,
      });
      if (!selected) continue;
      candidates.push(Object.freeze({
        source: SOURCE_ID,
        sourceId: String(sourceId || ''),
        title: release.title,
        filename: selected.path,
        infoHash: release.infoHash,
        fileIdx: selected.index,
        trackers: Object.freeze([...(release.trackers || [])]),
        seeders: release.seeders,
        size: selected.length || release.size,
        resolution: release.classification?.resolution || '',
        detailUrl: release.detailUrl,
        provenance: Object.freeze(['sukebei-anime-rss', 'episode-file-verified']),
      }));
    }
    return candidates;
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
  SOURCE_ID,
  buildSeriesRecords,
  createSukebeiHentaiAdapter,
  effectiveEpisodeCount,
  episodeFromSourceId,
  episodeSourceId,
  matchReleases,
  normalizeRelease,
  releasesForEpisode,
  rssUrl,
};
