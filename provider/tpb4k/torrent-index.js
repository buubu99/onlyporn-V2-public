'use strict';

const crypto = require('node:crypto');
const { SourceHttpClient } = require('./source-http');
const { createPosterEnricher, extractTitleDate } = require('./poster-enrichment');

const DEFAULT_TPB_MIRRORS = Object.freeze([
  'https://thehiddenbay.com',
  'https://thepiratebay0.org',
  'https://piratebay.live',
]);
const TPB_UHD_CATEGORY = '507';
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
  const text = String(value || '');
  const match = text.match(/(?:^|[?&])xt=urn:btih:([a-z0-9]{32}|[a-f0-9]{40})(?:&|$)/i);
  return match ? match[1].toLowerCase() : '';
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

function isExplicitLowerResolution(title) {
  return ['1080p', '720p', '480p'].includes(detectResolution(title));
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
    return url.toString();
  } catch {
    return '';
  }
}

function parseInteger(value) {
  const number = Number.parseInt(String(value || '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(number) && number >= 0 ? number : 0;
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

function publicTorrentItem(record, catalog) {
  const studio = compactText(catalog?.studio);
  const resolution = record.resolution || '4K';
  const details = [
    'TPB 4K studio result',
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
    releaseDate,
    detailUrl: record.detailUrl,
    metadataProvider: `hiddenbay:${new URL(record.mirror).hostname}`,
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
    retryBaseDelayMs: options.retryBaseDelayMs ?? 400,
    now: options.now,
    sleep: options.sleep,
  };
  const clients = mirrors.map((origin, index) => ({
    origin,
    client: new SourceHttpClient({ ...common, id: `torrent-index-${index + 1}`, endpoint: `${origin}/` }),
  }));
  const privateIndex = createPrivateIndex();
  const posterEnricher = createPosterEnricher({
    clients: options.metadataClients,
    config,
    now: options.now,
  });
  let lastDiagnostic = Object.freeze({});

  async function fetchSearchPage(path, cacheKey) {
    const attempts = [];
    for (const entry of clients) {
      let html = '';
      try {
        html = await entry.client.fetchText(`${entry.origin}${path}`, {
          cacheKey: `${entry.origin}:${cacheKey}`,
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

  async function loadWindow(catalog, skip, limit) {
    const normalizedSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);
    let page = Math.floor(normalizedSkip / TPB_PAGE_SIZE) + 1;
    let offset = normalizedSkip % TPB_PAGE_SIZE;
    const output = [];
    const seen = new Set();
    const diagnostics = [];

    while (output.length < normalizedLimit) {
      const path = buildStudioSearchPath(catalog.studio, page, {
        category: config.torrentIndex?.category || TPB_UHD_CATEGORY,
        sort: config.torrentIndex?.sort || TPB_TOP_SORT,
      });
      const result = await fetchSearchPage(path, `${catalog.id}:page:${page}`);
      diagnostics.push({ page, path, mirror: result.mirror, records: result.records.length, attempts: result.attempts });
      const usable = result.records.filter(record => !isExplicitLowerResolution(record.title));
      const pageWindow = usable.slice(offset);
      offset = 0;
      for (const record of pageWindow) {
        if (seen.has(record.sourceId)) continue;
        seen.add(record.sourceId);
        privateIndex.remember(record, catalog);
        output.push(publicTorrentItem(record, catalog));
        if (output.length >= normalizedLimit) break;
      }
      if (result.records.length < TPB_PAGE_SIZE || result.records.length === 0) break;
      page += 1;
    }

    output.sort((left, right) => right.seeders - left.seeders || left.title.localeCompare(right.title));
    const selected = output.slice(0, normalizedLimit);
    const enrichment = await posterEnricher.enrichItems(selected);
    lastDiagnostic = Object.freeze({
      catalogId: catalog.id,
      studio: catalog.studio,
      skip: normalizedSkip,
      limit: normalizedLimit,
      pages: Object.freeze(diagnostics),
      returned: enrichment.items.length,
      enrichment: enrichment.stats,
    });
    return enrichment.items;
  }

  return Object.freeze({
    id: 'torrent-index',
    configured: true,
    mirrors,
    category: config.torrentIndex?.category || TPB_UHD_CATEGORY,
    sort: config.torrentIndex?.sort || TPB_TOP_SORT,
    async catalog({ catalog, skip, limit }) {
      if (!compactText(catalog?.studio)) return [];
      return loadWindow(catalog, skip, limit);
    },
    async meta({ sourceId }) {
      const record = privateIndex.get(sourceId);
      if (!record) return null;
      const enrichment = await posterEnricher.enrichItems([
        publicTorrentItem(record, { studio: record.studio }),
      ]);
      return enrichment.items[0] || null;
    },
    async resolve() {
      return [];
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
  DEFAULT_TPB_MIRRORS,
  TPB_PAGE_SIZE,
  TPB_TOP_SORT,
  TPB_UHD_CATEGORY,
  buildStudioSearchPath,
  createTorrentIndexAdapter,
  detectResolution,
  extractInfoHash,
  normalizeMirrorOrigins,
  parseTpbSearchPage,
  stableTorrentId,
};
