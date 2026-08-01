'use strict';

const { studioSearchQueries } = require('./studio-aliases');
const crypto = require('node:crypto');
const { buildSceneIdentity } = require('./identity');
const { normalizeInfoHash, parseMagnet } = require('./candidate');
const { createKnabenAdultClient } = require('./knaben');
const { SourceHttpClient } = require('./source-http');
const {
  createPosterEnricher,
  extractTitleDate,
  normalizeSearchTitle,
  significantTokens,
} = require('./poster-enrichment');

const DEFAULT_TPB_MIRRORS = Object.freeze([
  'https://thehiddenbay.com',
  'https://thepiratebay0.org',
  'https://piratebay.live',
]);
const DEFAULT_1337X_MIRRORS = Object.freeze([
  'https://1337x.to',
  'https://1337x.st',
  'https://x1337x.ws',
  'https://x1337x.eu',
  'https://x1337x.cc',
]);
const TPB_UHD_CATEGORY = '507';
const TPB_ADULT_CATEGORY = '500';
const TPB_TOP_SORT = '7';
const TPB_PAGE_SIZE = 30;

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function fixedHttpsOrigin(value) {
  const parsed = new URL(String(value || ''));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('TPB4K torrent mirrors must use credential-free HTTPS origins');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('TPB4K torrent mirrors must be bare HTTPS origins');
  }
  return parsed.origin;
}

function normalizeMirrorOrigins(values = DEFAULT_TPB_MIRRORS) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const origin = fixedHttpsOrigin(value);
    if (seen.has(origin)) continue;
    seen.add(origin);
    output.push(origin);
  }
  if (!output.length) throw new Error('At least one TPB4K torrent mirror is required');
  return Object.freeze(output);
}

function buildStudioSearchPath(studio, page = 1, options = {}) {
  const query = compactText(studio);
  if (!query) throw new Error('A studio search term is required');
  const normalizedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
  const category = String(options.category || TPB_UHD_CATEGORY);
  const sort = String(options.sort || TPB_TOP_SORT);
  if (!/^\d{3}$/.test(category) || !/^\d{1,2}$/.test(sort)) {
    throw new Error('Invalid TPB search category or sort code');
  }
  return `/search/${encodeURIComponent(query)}/${normalizedPage}/${sort}/${category}`;
}

function extractInfoHash(value) {
  return parseMagnet(value)?.infoHash || normalizeInfoHash(value);
}

function stableTorrentId(item = {}) {
  const infoHash = extractInfoHash(item.magnetLink || item.magnet);
  if (infoHash) {
    return `hiddenbay:${crypto.createHash('sha256').update(infoHash).digest('hex').slice(0, 40)}`;
  }
  const identity = [item.title, item.detailUrl, item.size, item.uploadedAt]
    .map(compactText)
    .join('|');
  return `hiddenbay:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

function detectResolution(title) {
  const text = String(title || '').toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(text)) return '8K';
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return '4K';
  if (/\b1080p\b/.test(text)) return '1080p';
  if (/\b720p\b/.test(text)) return '720p';
  if (/\b480p\b/.test(text)) return '480p';
  return '';
}

function parseDescriptionLine(value) {
  const text = compactText(value);
  const uploaded = text.match(/Uploaded\s+(.+?)(?:,|$)/i)?.[1] || '';
  const size = text.match(/(?:Size|ULed)\s+(.+?)(?:,|$)/i)?.[1] || '';
  const uploader = text.match(/\bby\s+(.+?)$/i)?.[1] || '';
  return Object.freeze({
    uploadedAt: compactText(uploaded),
    size: compactText(size),
    uploader: compactText(uploader),
  });
}

function absoluteHttpsUrl(value, baseOrigin) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, `${baseOrigin}/`);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (url.origin !== new URL(baseOrigin).origin) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function build1337SearchPath(query, page = 1) {
  const text = compactText(query);
  if (!text) throw new Error('A 1337x search term is required');
  const normalizedPage = Math.max(Number.parseInt(String(page), 10) || 1, 1);
  return `/search/${encodeURIComponent(text)}/${normalizedPage}/`;
}

function parseInteger(value) {
  const number = Number.parseInt(String(value || '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function torrentSizeBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = compactText(value).match(
    /([0-9]+(?:\.[0-9]+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)\b/i
  );
  if (!match) return 0;
  const powers = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
  };
  return Math.round(Number(match[1]) * 1024 ** powers[match[2].toLowerCase()]);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function stripHtml(value) {
  return compactText(decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ')));
}

function attribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  return decodeHtml(String(tag || '').match(pattern)?.[2] || '');
}

function tagBlocks(value, tagName) {
  return [...String(value || '').matchAll(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, 'gi'))]
    .map(match => match[0]);
}

function firstClassBlock(value, tagName, className) {
  for (const block of tagBlocks(value, tagName)) {
    const open = block.match(new RegExp(`^<${tagName}\\b[^>]*>`, 'i'))?.[0] || '';
    const classes = attribute(open, 'class').split(/\s+/);
    if (classes.includes(className)) return block;
  }
  return '';
}

function parseTpbSearchPage(html, baseOrigin) {
  const document = String(html || '');
  const tableMatch = document.match(/<table\b[^>]*\bid\s*=\s*(["'])searchResult\1[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return Object.freeze({ tablePresent: false, records: [] });

  const records = [];
  for (const row of tagBlocks(tableMatch[2], 'tr')) {
    let nameAnchor = '';
    for (const anchor of tagBlocks(row, 'a')) {
      const open = anchor.match(/^<a\b[^>]*>/i)?.[0] || '';
      if (attribute(open, 'class').split(/\s+/).includes('detLink')) {
        nameAnchor = anchor;
        break;
      }
    }
    if (!nameAnchor) continue;
    const nameOpen = nameAnchor.match(/^<a\b[^>]*>/i)?.[0] || '';
    const title = stripHtml(nameAnchor.replace(/^<a\b[^>]*>|<\/a>$/gi, ''));
    if (!title) continue;

    const detailUrl = absoluteHttpsUrl(attribute(nameOpen, 'href'), baseOrigin);
    let magnetLink = '';
    for (const anchor of tagBlocks(row, 'a')) {
      const open = anchor.match(/^<a\b[^>]*>/i)?.[0] || '';
      const href = attribute(open, 'href');
      if (href.startsWith('magnet:')) {
        magnetLink = href;
        break;
      }
    }
    const descBlock = firstClassBlock(row, 'font', 'detDesc');
    const desc = parseDescriptionLine(stripHtml(descBlock));
    const cells = tagBlocks(row, 'td');
    let seeders = parseInteger(stripHtml(cells[2] || ''));
    let leechers = parseInteger(stripHtml(cells[3] || ''));
    if (cells.length >= 2 && !seeders && !leechers) {
      seeders = parseInteger(stripHtml(cells.at(-2)));
      leechers = parseInteger(stripHtml(cells.at(-1)));
    }
    const category = stripHtml(cells.find(cell => /\bclass\s*=\s*(["'])[^"']*\bvertTh\b/i.test(cell)) || '');

    const record = {
      title,
      detailUrl,
      magnetLink,
      infoHash: extractInfoHash(magnetLink),
      seeders,
      leechers,
      size: desc.size,
      uploadedAt: desc.uploadedAt,
      uploader: desc.uploader,
      category,
      resolution: detectResolution(title),
      mirror: baseOrigin,
    };
    record.sourceId = stableTorrentId(record);
    records.push(Object.freeze(record));
  }

  return Object.freeze({ tablePresent: true, records: Object.freeze(records) });
}

function extractMagnetFromHtml(html) {
  for (const match of String(html || '').matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    for (const name of ['href', 'data-magnet', 'data-url']) {
      const magnetLink = attribute(tag, name);
      const parsed = parseMagnet(magnetLink);
      if (!parsed) continue;
      return Object.freeze({
        magnetLink,
        infoHash: parsed.infoHash,
        filename: parsed.displayName,
        trackers: Object.freeze(parsed.trackers),
      });
    }
  }
  return null;
}

function parseTorrentDetailPage(html) {
  return extractMagnetFromHtml(html);
}

function hasClass(block, className) {
  const open = String(block || '').match(/^<[a-z0-9]+\b[^>]*>/i)?.[0] || '';
  return attribute(open, 'class').split(/\s+/).includes(className);
}

function stableIndexerId(source, record = {}) {
  const hash = extractInfoHash(record.magnetLink || record.infoHash);
  const identity = hash || [
    compactText(record.detailUrl),
    compactText(record.title),
    compactText(record.size),
  ].join('|');
  return `${source}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

function parse1337SearchPage(html, baseOrigin) {
  const table = tagBlocks(String(html || ''), 'table')
    .find(block => hasClass(block, 'table-list'));
  if (!table) return Object.freeze({ tablePresent: false, records: [] });

  const records = [];
  for (const row of tagBlocks(table, 'tr')) {
    const cells = tagBlocks(row, 'td');
    if (!cells.length) continue;
    let nameAnchor = '';
    for (const anchor of tagBlocks(cells[0], 'a')) {
      const open = anchor.match(/^<a\b[^>]*>/i)?.[0] || '';
      const href = attribute(open, 'href');
      if (/\/torrent\//i.test(href)) {
        nameAnchor = anchor;
        break;
      }
    }
    if (!nameAnchor) continue;
    const open = nameAnchor.match(/^<a\b[^>]*>/i)?.[0] || '';
    const title = stripHtml(nameAnchor.replace(/^<a\b[^>]*>|<\/a>$/gi, ''));
    const detailUrl = absoluteHttpsUrl(attribute(open, 'href'), baseOrigin);
    if (!title || !detailUrl) continue;

    const cellByClass = className => cells.find(cell => hasClass(cell, className)) || '';
    const record = {
      title,
      detailUrl,
      magnetLink: '',
      infoHash: '',
      seeders: parseInteger(stripHtml(cellByClass('coll-2') || cellByClass('seeds'))),
      leechers: parseInteger(stripHtml(cellByClass('coll-3') || cellByClass('leeches'))),
      size: stripHtml(cellByClass('coll-4') || cellByClass('size')),
      uploadedAt: stripHtml(cellByClass('coll-date')),
      uploader: stripHtml(cellByClass('coll-5')),
      category: stripHtml(cells[0].match(/<span\b[\s\S]*?<\/span>/i)?.[0] || ''),
      resolution: detectResolution(title),
      mirror: baseOrigin,
      indexer: '1337x',
    };
    record.sourceId = stableIndexerId('1337x', record);
    records.push(Object.freeze(record));
  }
  return Object.freeze({ tablePresent: true, records: Object.freeze(records) });
}

function publicTorrentItem(record, catalog) {
  const studio = compactText(catalog?.studio);
  const resolution = record.resolution || '';
  const indexer = compactText(record.indexer || 'hiddenbay').toLowerCase();
  const details = [
    'Torrent-first studio result',
    studio && `Studio search: ${studio}`,
    Number.isFinite(record.seeders) && `Seeders: ${record.seeders}`,
    record.size && `Size: ${record.size}`,
    record.uploadedAt && `Uploaded: ${record.uploadedAt}`,
  ].filter(Boolean);

  const releaseDate = extractTitleDate(record.title, studio).releaseDate;

  return Object.freeze({
    sourceId: record.sourceId,
    title: record.title,
    description: details.join(' · '),
    studio,
    resolution,
    quality: 'Top by seeders',
    seeders: record.seeders,
    size: record.size,
    infoHash: extractInfoHash(record.infoHash || record.magnetLink),
    filename: record.title,
    indexer,
    releaseDate,
    detailUrl: record.detailUrl,
    metadataProvider: indexer === 'knaben'
      ? 'torrent-index:knaben'
      : `torrent-index:${new URL(record.mirror).hostname}`,
    lookupSource: 'torrent-index',
    upstreamId: '',
  });
}

function createPrivateIndex() {
  const records = new Map();
  return Object.freeze({
    remember(record, catalog) {
      records.set(record.sourceId, Object.freeze({ ...record, studio: compactText(catalog?.studio) }));
    },
    get(sourceId) {
      return records.get(String(sourceId || '')) || null;
    },
    size() {
      return records.size;
    },
  });
}

function createTorrentIndexAdapter(options = {}) {
  const config = options.config || {};
  const mirrors = normalizeMirrorOrigins(
    options.mirrors || config.torrentIndex?.mirrors || DEFAULT_TPB_MIRRORS
  );
  const x1337Mirrors = normalizeMirrorOrigins(
    options.x1337Mirrors || config.torrentIndex?.x1337Mirrors || DEFAULT_1337X_MIRRORS
  );
  const common = {
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowHtml: true,
    allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    minRequestIntervalMs: options.minRequestIntervalMs ?? 350,
    maxRetries: options.maxRetries ?? 1,
    maxRedirects: options.maxRedirects ?? 3,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 400,
    now: options.now,
    sleep: options.sleep,
  };
  const clients = mirrors.map((origin, index) => ({
    origin,
    client: new SourceHttpClient({ ...common, id: `torrent-index-${index + 1}`, endpoint: `${origin}/` }),
  }));
  const x1337Clients = x1337Mirrors.map((origin, index) => ({
    origin,
    client: new SourceHttpClient({
      ...common,
      id: `torrent-index-1337x-${index + 1}`,
      endpoint: `${origin}/`,
    }),
  }));
  const knabenClient = createKnabenAdultClient({
    enabled: config.torrentIndex?.knabenEnabled !== false,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    now: options.now,
  });
  const privateIndex = createPrivateIndex();
  const posterEnricher = createPosterEnricher({
    clients: options.metadataClients,
    config,
    now: options.now,
  });
  let lastDiagnostic = Object.freeze({});

  async function fetchSearchPage(path, cacheKey, deadlineAt = Infinity) {
    const attempts = [];
    for (const entry of clients) {
      const remainingMs = deadlineAt - Date.now();
      if (Number.isFinite(deadlineAt) && remainingMs <= 0) {
        attempts.push({ mirror: entry.origin, outcome: 'request-deadline' });
        break;
      }
      let html = '';
      try {
        html = await entry.client.fetchText(`${entry.origin}${path}`, {
          cacheKey: `${entry.origin}:${cacheKey}`,
          ...(Number.isFinite(deadlineAt) ? { timeoutMs: Math.max(remainingMs, 250) } : {}),
        });
      } catch (error) {
        attempts.push({ mirror: entry.origin, outcome: 'error', error: compactText(error?.message) });
        continue;
      }
      if (!html) {
        attempts.push({ mirror: entry.origin, outcome: 'empty-response' });
        continue;
      }
      const parsed = parseTpbSearchPage(html, entry.origin);
      if (!parsed.tablePresent) {
        attempts.push({ mirror: entry.origin, outcome: 'no-results-table' });
        continue;
      }
      attempts.push({ mirror: entry.origin, outcome: 'accepted', records: parsed.records.length });
      return { ...parsed, mirror: entry.origin, attempts };
    }
    const summary = attempts.map(item => `${item.mirror}:${item.outcome}`).join(' | ');
    throw new Error(`All TPB mirrors failed for ${path}${summary ? ` (${summary})` : ''}`);
  }

  async function fetch1337SearchPage(path, cacheKey, deadlineAt = Infinity) {
    const attempts = [];
    for (const entry of x1337Clients) {
      const remainingMs = deadlineAt - Date.now();
      if (Number.isFinite(deadlineAt) && remainingMs <= 0) {
        attempts.push({ mirror: entry.origin, outcome: 'request-deadline' });
        break;
      }
      let html = '';
      try {
        html = await entry.client.fetchText(`${entry.origin}${path}`, {
          cacheKey: `${entry.origin}:${cacheKey}`,
          ...(Number.isFinite(deadlineAt) ? { timeoutMs: Math.max(remainingMs, 250) } : {}),
        });
      } catch (error) {
        attempts.push({ mirror: entry.origin, outcome: 'error', error: compactText(error?.message) });
        continue;
      }
      if (!html) {
        attempts.push({ mirror: entry.origin, outcome: 'empty-response' });
        continue;
      }
      const parsed = parse1337SearchPage(html, entry.origin);
      if (!parsed.tablePresent) {
        attempts.push({ mirror: entry.origin, outcome: 'no-results-table' });
        continue;
      }
      attempts.push({ mirror: entry.origin, outcome: 'accepted', records: parsed.records.length });
      return { ...parsed, mirror: entry.origin, attempts };
    }
    const summary = attempts.map(item => `${item.mirror}:${item.outcome}`).join(' | ');
    throw new Error(`All 1337x mirrors failed for ${path}${summary ? ` (${summary})` : ''}`);
  }

  async function fetchDetail(record, deadlineAt = Infinity) {
    const entries = record.indexer === '1337x' ? x1337Clients : clients;
    let detail;
    try {
      detail = new URL(record.detailUrl);
    } catch {
      return null;
    }
    const primary = entries.find(candidate => candidate.origin === detail.origin);
    if (!primary) return null;
    const ordered = [primary, ...entries.filter(candidate => candidate !== primary)];
    for (const entry of ordered) {
      const remainingMs = deadlineAt - Date.now();
      if (Number.isFinite(deadlineAt) && remainingMs <= 0) break;
      const target = `${entry.origin}${detail.pathname}${detail.search}`;
      try {
        const html = await entry.client.fetchText(target, {
          cacheKey: `${record.indexer || 'hiddenbay'}:detail:${record.sourceId}:${entry.origin}`,
          ...(Number.isFinite(deadlineAt) ? { timeoutMs: Math.max(remainingMs, 250) } : {}),
        });
        if (!html) continue;
        const parsed = parseTorrentDetailPage(html);
        if (parsed) return parsed;
      } catch {
        // One mirror failing must not suppress a valid detail page elsewhere.
      }
    }
    return null;
  }

  async function loadWindow(catalog, skip, limit, options = {}) {
    const normalizedSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;
    const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), maximumLimit);
    let page = Math.floor(normalizedSkip / TPB_PAGE_SIZE) + 1;
    let offset = normalizedSkip % TPB_PAGE_SIZE;
    const output = [];
    const seen = new Set();
    const diagnostics = [];
    const minimumSeeders = Math.max(Number(config.minimumSeeders || 0), 0);
    const deadlineAt = Date.now() + Math.min(
      Math.max(Number(config.requestTimeoutMs || 15_000) + 5_000, 5_000),
      25_000
    );

    const knabenOrders = catalog?.playbackBindingPool ? ['seeders', 'date'] : ['seeders'];
    const knabenQueries = studioSearchQueries(catalog);
    const knabenJobs = knabenQueries.flatMap(query =>
      knabenOrders.map(orderBy => Object.freeze({ query, orderBy }))
    );
    const knabenResults = await Promise.allSettled(
      knabenJobs.map(job => knabenClient.searchStudio(job.query, { orderBy: job.orderBy }))
    );
    for (let orderIndex = 0; orderIndex < knabenResults.length; orderIndex += 1) {
      const { query, orderBy } = knabenJobs[orderIndex];
      const result = knabenResults[orderIndex];
      if (result.status === 'rejected') {
        diagnostics.push({
          source: 'knaben',
          query,
          orderBy,
          outcome: 'error',
          error: compactText(result.reason?.message || result.reason),
        });
        continue;
      }
      diagnostics.push({
        source: 'knaben',
        query,
        orderBy,
        outcome: 'accepted',
        records: result.value.length,
      });
      for (const record of result.value.slice(normalizedSkip)) {
        const infoHash = extractInfoHash(record.infoHash || record.magnetLink);
        if (!infoHash || Number(record.seeders || 0) < minimumSeeders || seen.has(infoHash)) continue;
        seen.add(infoHash);
        privateIndex.remember(record, catalog);
        output.push(publicTorrentItem(record, catalog));
        if (output.length >= normalizedLimit) break;
      }
      if (output.length >= normalizedLimit) break;
    }

    while (output.length < normalizedLimit && Date.now() < deadlineAt) {
      const path = buildStudioSearchPath(catalog.studio, page, {
        category: config.torrentIndex?.category || TPB_UHD_CATEGORY,
        sort: config.torrentIndex?.sort || TPB_TOP_SORT,
      });
      let result;
      try {
        result = await fetchSearchPage(path, `${catalog.id}:page:${page}`, deadlineAt);
      } catch (error) {
        diagnostics.push({
          source: 'hiddenbay',
          page,
          path,
          outcome: 'error',
          error: compactText(error?.message || error),
        });
        break;
      }
      diagnostics.push({
        source: 'hiddenbay',
        page,
        path,
        mirror: result.mirror,
        records: result.records.length,
        attempts: result.attempts,
      });
      const pageWindow = result.records.slice(offset);
      offset = 0;
      for (const record of pageWindow) {
        const infoHash = extractInfoHash(record.infoHash || record.magnetLink);
        const key = infoHash || record.sourceId;
        if (!key || Number(record.seeders || 0) < minimumSeeders || seen.has(key)) continue;
        seen.add(key);
        privateIndex.remember(record, catalog);
        output.push(publicTorrentItem(record, catalog));
        if (output.length >= normalizedLimit) break;
      }
      if (result.records.length < TPB_PAGE_SIZE || result.records.length === 0) break;
      page += 1;
    }

    // Some public indexes spell studio brands differently. After the canonical
    // HiddenBay window, query only approved aliases and keep the exact same
    // hash, seeder, deadline, and deduplication gates.
    if (catalog?.playbackBindingPool && output.length < normalizedLimit && Date.now() < deadlineAt) {
      const aliasQueries = studioSearchQueries(catalog).slice(1);
      for (const aliasQuery of aliasQueries) {
        if (output.length >= normalizedLimit || Date.now() >= deadlineAt) break;
        for (let aliasPage = 1; aliasPage <= 2; aliasPage += 1) {
          if (output.length >= normalizedLimit || Date.now() >= deadlineAt) break;
          const path = buildStudioSearchPath(aliasQuery, aliasPage, {
            category: config.torrentIndex?.category || TPB_UHD_CATEGORY,
            sort: config.torrentIndex?.sort || TPB_TOP_SORT,
          });
          let result;
          try {
            result = await fetchSearchPage(
              path,
              `${catalog.id}:alias:${compactComparable(aliasQuery)}:${aliasPage}`,
              deadlineAt
            );
          } catch (error) {
            diagnostics.push({
              source: 'hiddenbay-alias',
              query: aliasQuery,
              page: aliasPage,
              path,
              outcome: 'error',
              error: compactText(error?.message || error),
            });
            break;
          }
          diagnostics.push({
            source: 'hiddenbay-alias',
            query: aliasQuery,
            page: aliasPage,
            path,
            mirror: result.mirror,
            records: result.records.length,
            attempts: result.attempts,
          });
          for (const record of result.records) {
            const infoHash = extractInfoHash(record.infoHash || record.magnetLink);
            const key = infoHash || record.sourceId;
            if (!key || Number(record.seeders || 0) < minimumSeeders || seen.has(key)) continue;
            seen.add(key);
            privateIndex.remember(record, catalog);
            output.push(publicTorrentItem(record, catalog));
            if (output.length >= normalizedLimit) break;
          }
          if (result.records.length < TPB_PAGE_SIZE || result.records.length === 0) break;
        }
      }
    }

    output.sort((left, right) => right.seeders - left.seeders || left.title.localeCompare(right.title));
    const selected = output.slice(0, normalizedLimit);
    const enrichment = options.enrichPosters !== false
      ? await posterEnricher.enrichItems(selected)
      : Object.freeze({
        items: Object.freeze(selected),
        stats: Object.freeze({ mode: 'identity-only', skipped: selected.length }),
      });
    lastDiagnostic = Object.freeze({
      catalogId: catalog.id,
      studio: catalog.studio,
      skip: normalizedSkip,
      limit: normalizedLimit,
      pages: Object.freeze(diagnostics),
      returned: enrichment.items.length,
      indexers: Object.freeze({
        knaben: diagnostics
          .filter(item => item.source === 'knaben')
          .reduce((sum, item) => sum + Number(item.records || 0), 0),
        hiddenbay: diagnostics
          .filter(item => item.source === 'hiddenbay')
          .reduce((sum, item) => sum + Number(item.records || 0), 0),
      }),
      enrichment: enrichment.stats,
    });
    return enrichment.items;
  }

  function sceneQueries(item = {}, catalog = {}) {
    const identity = buildSceneIdentity(item);
    const studio = compactText(item.studio || catalog.studio);
    const studioKey = compactComparable(studio);
    const title = normalizeSearchTitle(item.title, studio).query;
    const identities = [
      item.creator, item.username, item.channel, item.account, item.model, item.performer,
      ...(Array.isArray(item.performers) ? item.performers : []),
    ].map(compactText).filter(value => value.length >= 3);
    const creator = identities[0] || '';
    const platform = studioKey === 'onlyfans';
    const values = [
      identity.sceneCode,
      platform ? [creator, title, 'OnlyFans'].map(compactText).filter(Boolean).join(' ') : [studio, title].map(compactText).filter(Boolean).join(' '),
      compactText(item.lookupQuery),
      platform ? [creator, title].map(compactText).filter(Boolean).join(' ') : '',
    ];
    const output = [];
    const seen = new Set();
    for (const value of values) {
      const query = compactText(value).slice(0, 180);
      const key = query.toLowerCase();
      if (query.length < 3 || seen.has(key)) continue;
      seen.add(key);
      output.push(query);
      if (output.length >= 3) break;
    }
    return output;
  }
  function compactComparable(value) {
    return compactText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function recordMatchesScene(record, item = {}, catalog = {}) {
    const identity = buildSceneIdentity(item);
    const recordKey = compactComparable(record.title);
    const codeKey = compactComparable(identity.sceneCode);
    if (codeKey) return recordKey.includes(codeKey);
    const studio = compactText(item.studio || catalog.studio);
    const studioKey = compactComparable(studio);
    const targeted = Boolean(catalog?.targetedPlaybackSearch);
    const platform = studioKey === 'onlyfans';
    const studioEvidence = Boolean(studioKey && recordKey.includes(studioKey));
    const expectedTokens = significantTokens(item.title, studio)
      .filter(token => !platform || !['onlyfans', 'only', 'fans', 'fansly', 'fanvue'].includes(String(token).toLowerCase()));
    const actualTokens = new Set(significantTokens(record.title, studio));
    const identityKeys = [
      item.creator, item.username, item.channel, item.account, item.model, item.performer,
      ...(Array.isArray(item.performers) ? item.performers : []),
    ].map(compactComparable).filter(value => value.length >= 4);
    const identityEvidence = identityKeys.some(value => recordKey.includes(value));
    if (!expectedTokens.length) return false;
    const overlap = expectedTokens.filter(token => actualTokens.has(token)).length;
    const coverage = overlap / expectedTokens.length;
    if (platform) return overlap >= 2 && coverage >= 0.45 && identityEvidence;
    if (expectedTokens.length === 1) return expectedTokens[0].length >= 3 && overlap === 1 && (studioEvidence || targeted);
    return coverage >= 0.75 && (studioEvidence || targeted || coverage === 1);
  }
  async function searchIndexers(query, catalogId, deadlineAt) {
    const key = crypto.createHash('sha256').update(query).digest('hex').slice(0, 16);
    const searches = [
      {
        source: 'knaben-targeted',
        run: async () => ({
          records: await knabenClient.searchStudio(query, { orderBy: 'seeders', targeted: true }),
          mirror: knabenClient.endpointOrigin,
        }),
      },
      {
        source: 'hiddenbay',
        run: () => fetchSearchPage(
          buildStudioSearchPath(query, 1, {
            category: config.torrentIndex?.resolutionCategory || TPB_ADULT_CATEGORY,
            sort: config.torrentIndex?.sort || TPB_TOP_SORT,
          }),
          `${catalogId || 'stream'}:resolve:${key}:hiddenbay`,
          deadlineAt
        ),
      },
      {
        source: '1337x',
        run: () => fetch1337SearchPage(
          build1337SearchPath(query, 1),
          `${catalogId || 'stream'}:resolve:${key}:1337x`,
          deadlineAt
        ),
      },
    ];
    const settled = await Promise.allSettled(searches.map(search => search.run()));
    const records = [];
    const diagnostics = [];
    settled.forEach((result, index) => {
      const source = searches[index].source;
      if (result.status === 'rejected') {
        diagnostics.push({
          source,
          outcome: 'error',
          error: compactText(result.reason?.message || result.reason),
        });
        return;
      }
      diagnostics.push({
        source,
        outcome: 'accepted',
        records: result.value.records.length,
        mirror: result.value.mirror,
      });
      for (const record of result.value.records) {
        records.push(Object.freeze({ ...record, indexer: source }));
      }
    });
    return Object.freeze({
      records: Object.freeze(records),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  async function mapLimited(values, limit, mapper) {
    const output = new Array(values.length);
    let next = 0;
    async function worker() {
      while (next < values.length) {
        const index = next;
        next += 1;
        output[index] = await mapper(values[index], index);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(Math.max(limit, 1), values.length) }, () => worker())
    );
    return output;
  }

  async function resolveRecord(record, deadlineAt = Infinity) {
    if (!record || Date.now() >= deadlineAt) return null;
    let parsed = parseMagnet(record.magnetLink);
    if (!parsed) {
      try {
        parsed = await fetchDetail(record, deadlineAt);
      } catch {
        return null;
      }
    }
    if (!parsed?.infoHash) return null;
    return Object.freeze({
      source: record.indexer || 'hiddenbay',
      sourceId: record.sourceId,
      title: record.title || parsed.filename,
      filename: parsed.filename || record.title,
      magnet: record.magnetLink || parsed.magnetLink,
      infoHash: parsed.infoHash,
      trackers: Object.freeze([...(parsed.trackers || [])]),
      seeders: record.seeders,
      size: record.size,
      resolution: record.resolution || detectResolution(record.title),
      detailUrl: record.detailUrl,
    });
  }

  function mergeExactTorrents(values) {
    const byHash = new Map();
    for (const value of values.filter(Boolean)) {
      const key = `${value.infoHash}:${value.fileIdx ?? ''}`;
      const previous = byHash.get(key);
      if (!previous) {
        byHash.set(key, value);
        continue;
      }
      const preferred = Number(value.seeders || 0) > Number(previous.seeders || 0)
        ? value
        : previous;
      byHash.set(key, Object.freeze({
        ...preferred,
        seeders: Math.max(Number(previous.seeders || 0), Number(value.seeders || 0)),
        size: torrentSizeBytes(previous.size) >= torrentSizeBytes(value.size)
          ? previous.size
          : value.size,
        trackers: Object.freeze([...new Set([
          ...(previous.trackers || []),
          ...(value.trackers || []),
        ])]),
        provenance: Object.freeze([...new Set([
          ...(previous.provenance || [previous.source]),
          ...(value.provenance || [value.source]),
        ].filter(Boolean))]),
      }));
    }
    return [...byHash.values()];
  }

  async function resolveScene({ sourceId, catalogId, catalog, item }) {
    const remembered = privateIndex.get(sourceId);
    const deadlineAt = Date.now() + Math.min(
      Math.max(Number(config.requestTimeoutMs || 15_000) + 5_000, 5_000),
      25_000
    );
    if (remembered) {
      const direct = await resolveRecord(remembered, deadlineAt);
      return direct ? [direct] : [];
    }
    if (!item?.title) return [];

    const queries = sceneQueries(item, catalog);
    const records = [];
    const searchDiagnostics = [];
    const seenRecords = new Set();
    for (const query of queries) {
      if (Date.now() >= deadlineAt) break;
      const result = await searchIndexers(query, catalogId, deadlineAt);
      searchDiagnostics.push({ query, indexers: result.diagnostics });
      for (const record of result.records) {
        if (!recordMatchesScene(record, item, catalog)) continue;
        const key = record.infoHash || record.detailUrl || record.sourceId;
        if (!key || seenRecords.has(key)) continue;
        seenRecords.add(key);
        records.push(record);
      }
    }

    const selected = records
      .sort((left, right) => Number(right.seeders || 0) - Number(left.seeders || 0))
      .slice(0, 18);
    const candidates = await mapLimited(
      selected,
      Math.min(Math.max(Number(config.torrentIndex?.detailConcurrency || 3), 1), 5),
      record => resolveRecord(record, deadlineAt)
    );
    const merged = mergeExactTorrents(candidates)
      .sort((left, right) => Number(right.seeders || 0) - Number(left.seeders || 0));
    lastDiagnostic = Object.freeze({
      ...lastDiagnostic,
      resolution: Object.freeze({
        sourceId,
        catalogId,
        queries: Object.freeze(queries),
        searches: Object.freeze(searchDiagnostics),
        matchedRecords: records.length,
        detailRecords: selected.length,
        returned: merged.length,
      }),
    });
    return merged;
  }

  return Object.freeze({
    id: 'torrent-index',
    configured: true,
    mirrors,
    x1337Mirrors,
    knabenOrigin: knabenClient.endpointOrigin,
    category: config.torrentIndex?.category || TPB_UHD_CATEGORY,
    sort: config.torrentIndex?.sort || TPB_TOP_SORT,
    async catalog({ catalog, skip, limit }) {
      if (!compactText(catalog?.studio)) return [];
      return loadWindow(catalog, skip, limit);
    },
    async catalogTorrents({ catalog, skip, limit }) {
      if (!compactText(catalog?.studio)) return [];
      return loadWindow(catalog, skip, limit, { enrichPosters: false });
    },
    async meta({ sourceId }) {
      const record = privateIndex.get(sourceId);
      if (!record) return null;
      const enrichment = await posterEnricher.enrichItems([
        publicTorrentItem(record, { studio: record.studio }),
      ]);
      return enrichment.items[0] || null;
    },
    async resolve(args = {}) {
      return resolveScene(args);
    },
    async enrichMetadata(items = [], behavior = {}) {
      return posterEnricher.enrichItems(items, behavior);
    },
    diagnostics() {
      return lastDiagnostic;
    },
    privateRecordCount() {
      return privateIndex.size();
    },
    posterCacheSize() {
      return posterEnricher.cacheSize();
    },
  });
}

module.exports = {
  DEFAULT_1337X_MIRRORS,
  DEFAULT_TPB_MIRRORS,
  TPB_ADULT_CATEGORY,
  TPB_PAGE_SIZE,
  TPB_TOP_SORT,
  TPB_UHD_CATEGORY,
  build1337SearchPath,
  buildStudioSearchPath,
  createTorrentIndexAdapter,
  detectResolution,
  extractMagnetFromHtml,
  extractInfoHash,
  normalizeMirrorOrigins,
  parse1337SearchPage,
  parseTpbSearchPage,
  parseTorrentDetailPage,
  stableTorrentId,
};
