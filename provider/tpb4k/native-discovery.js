
'use strict';

const { hasStrongChallengeMarker } = require('../challenge-detection');
const { SourceHttpClient } = require('./source-http');
const {
  absoluteHttps,
  anchorRecords,
  attribute,
  blocksByStart,
  cleanText,
  decodeStablePathId,
  firstContent,
  firstTag,
  imageUrl,
  metaContent,
  parseDurationSeconds,
  sameOriginPath,
  stablePathId,
  uniqueBy,
} = require('./native-html');

const SOURCES = Object.freeze({
  pornrips: Object.freeze({ origin: 'https://pornrips.to', allowedPrefixes: ['/'] }),
  yesporn: Object.freeze({ origin: 'https://yesporn.vip', allowedPrefixes: ['/video/'] }),
  hentai: Object.freeze({ origin: 'https://hentaimama.io', allowedPrefixes: ['/tvshows/', '/hentai-series/'] }),
});

const NATIVE_MIN_REQUEST_INTERVAL_MS = 350;
const NATIVE_MAX_RETRIES = 1;

function createNativeClient(id, config, options = {}) {
  const source = SOURCES[id];
  return new SourceHttpClient({
    id,
    endpoint: source.origin,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    allowHtml: true,
    accept: 'text/html, application/xhtml+xml;q=0.9',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    minRequestIntervalMs: options.minRequestIntervalMs ?? NATIVE_MIN_REQUEST_INTERVAL_MS,
    maxRetries: options.maxRetries ?? NATIVE_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs,
    now: options.now,
    sleep: options.sleep,
  });
}

function pageNumber(skip, limit) {
  return Math.floor(Math.max(Number(skip) || 0, 0) / Math.max(Number(limit) || 1, 1)) + 1;
}

function hasNativeCatalogEvidence(source, html) {
  const body = String(html || '');
  if (!body) return false;
  if (source === 'pornrips') {
    return /<article\b/i.test(body) && /href=[\"'][^\"']+\/[\"']/i.test(body);
  }
  if (source === 'yesporn') {
    return /href=[\"'][^\"']*\/video\/\d+\/[^\"'?#]+\/?(?:[?#][^\"']*)?[\"']/i.test(body);
  }
  if (source === 'hentai') {
    return /href=[\"'][^\"']*\/tvshows\/[^\"'?#]+\/?(?:[?#][^\"']*)?[\"']/i.test(body)
      && /<article\b[^>]*class=[\"'][^\"']*\b(?:item|tvshows)\b[^\"']*[\"']/i.test(body);
  }
  return false;
}

function safeHtml(payload, source) {
  const html = String(payload || '');
  if (!html) return '';
  if (!hasStrongChallengeMarker(html)) return html;
  return hasNativeCatalogEvidence(source, html) ? html : '';
}

function descriptionFromBlock(block, labels = []) {
  const text = cleanText(block);
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*:?\\s*([^|]{2,180})`, 'i'));
    if (match) return cleanText(match[1]);
  }
  return text.slice(0, 500);
}

function exactPath(base, href, prefix, pattern) {
  const path = sameOriginPath(base, href, [prefix]);
  if (!path) return '';
  const url = new URL(path, base);
  return pattern.test(url.pathname) ? url.pathname : '';
}

function imageTextFromBlock(block) {
  const img = firstTag(block, 'img');
  return cleanText(attribute(img, 'alt') || attribute(img, 'title'));
}

function slugTitle(path) {
  const slug = String(path || '').split('/').filter(Boolean).at(-1) || '';
  return cleanText(slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()));
}

function usefulStudio(value) {
  const text = cleanText(value);
  if (!text || /^(?:announcements?|uncategorized|news|updates?|featured|homepage)$/i.test(text)) return '';
  if (/\b(?:1080p|2160p|4k|720p|hevc|x265|x264)\b/i.test(text)) return '';
  return text;
}

function parsePornripsCatalog(html) {
  const base = SOURCES.pornrips.origin;
  const blocks = blocksByStart(html, /<article\b[^>]*>/gi);
  const candidates = blocks.length ? blocks : blocksByStart(html, /<h[12]\b[^>]*class=["'][^"']*(?:entry-title|post-title)[^"']*["'][^>]*>/gi);
  return uniqueBy(candidates.map((block, index) => {
    const anchors = anchorRecords(block);
    const link = anchors.find(item => /(?:entry-title|post-title)/i.test(item.className))
      || anchors.find(item => item.href && !/\/(?:category|tag|author)\//i.test(item.href));
    const path = sameOriginPath(base, link?.href, ['/']);
    const title = cleanText(link?.title || link?.text || firstContent(block));
    if (!path || !title || path === '/') return null;
    const text = cleanText(block);
    const size = text.match(/\b(?:file\s*size|size)\s*:?\s*([0-9.]+\s*(?:KB|MB|GB|TB))/i)?.[1]
      || text.match(/\b([0-9.]+\s*(?:GB|MB))\b/i)?.[1]
      || '';
    const timeTag = String(block).match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] || '';
    const category = anchors
      .filter(item => /\/(?:category|studios?|network)\//i.test(item.href))
      .map(item => usefulStudio(item.text))
      .find(Boolean) || '';
    const duration = parseDurationSeconds(text);
    return {
      sourceId: stablePathId('pornrips', path),
      title,
      poster: imageUrl(base, block),
      background: imageUrl(base, block),
      description: [size && `Size: ${size}`, duration && `Duration: ${duration}s`].filter(Boolean).join(' · '),
      studio: category,
      releaseDate: cleanText(timeTag),
      duration,
      size,
      detailUrl: absoluteHttps(base, path),
      upstreamId: path,
      _path: path,
      _index: index,
    };
  }).filter(Boolean), item => item.sourceId);
}

function parseYespornCatalog(html) {
  const base = SOURCES.yesporn.origin;
  const links = anchorRecords(html)
    .map((link, index) => ({
      link,
      index,
      path: exactPath(base, link.href, '/video/', /^\/video\/\d+\/[^/?#]+\/?$/i),
    }))
    .filter(item => item.path);

  return uniqueBy(links.map(({ link, index, path }) => {
    const title = cleanText(
      imageTextFromBlock(link.tag)
      || link.title
      || firstContent(link.tag, ['strong', 'h2', 'h3'])
      || link.text
      || slugTitle(path)
    );
    if (!title) return null;
    const poster = imageUrl(base, link.tag);
    return {
      sourceId: stablePathId('yesporn', path),
      title,
      poster,
      background: poster,
      description: '',
      duration: parseDurationSeconds(link.text),
      detailUrl: absoluteHttps(base, path),
      upstreamId: path,
      _path: path,
      _index: index,
    };
  }).filter(Boolean), item => item.sourceId);
}

function enclosingArticle(source, offset) {
  const html = String(source || '');
  const start = html.lastIndexOf('<article', offset);
  if (start < 0) return '';
  const close = html.indexOf('</article>', offset);
  if (close < 0 || close - start > 180_000) return '';
  return html.slice(start, close + '</article>'.length);
}

function hentaiPathOccurrences(html) {
  const base = SOURCES.hentai.origin;
  const source = String(html || '');
  const records = [];
  const regex = /<a\b[^>]*href\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(regex)) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    const path = exactPath(base, href, '/tvshows/', /^\/tvshows\/[^/?#]+\/?$/i);
    if (!path) continue;
    records.push({
      path,
      index: match.index ?? 0,
      tag: match[0],
      label: cleanText(attribute(match[0], 'title') || match[4]),
    });
  }
  return records;
}

function parseHentaiCatalog(html) {
  const base = SOURCES.hentai.origin;
  const source = String(html || '');
  const occurrences = hentaiPathOccurrences(source);
  const grouped = new Map();

  for (const occurrence of occurrences) {
    const existing = grouped.get(occurrence.path) || {
      path: occurrence.path,
      index: occurrence.index,
      labels: [],
      blocks: [],
      tags: [],
    };
    if (occurrence.label) existing.labels.push(occurrence.label);
    existing.tags.push(occurrence.tag);
    const block = enclosingArticle(source, occurrence.index);
    if (block && !existing.blocks.includes(block)) existing.blocks.push(block);
    grouped.set(occurrence.path, existing);
  }

  const items = [];
  for (const entry of grouped.values()) {
    const block = entry.blocks.sort((left, right) => right.length - left.length)[0]
      || source.slice(Math.max(entry.index - 4_000, 0), Math.min(entry.index + 16_000, source.length));
    const samePathLabels = anchorRecords(block)
      .filter(link => exactPath(base, link.href, '/tvshows/', /^\/tvshows\/[^/?#]+\/?$/i) === entry.path)
      .map(link => cleanText(link.title || link.text))
      .filter(Boolean);
    const title = cleanText(
      samePathLabels[0]
      || entry.labels[0]
      || firstContent(block, ['h3', 'h2', 'h1'])
      || imageTextFromBlock(block)
      || slugTitle(entry.path)
    );
    if (!title) continue;
    const text = cleanText(block);
    const rating = text.match(/\b([0-9](?:\.[0-9])?)\s*(?:\/\s*10)?\b/)?.[1] || '';
    const year = text.match(/\b((?:19|20)\d{2})\b/)?.[1] || '';
    const poster = imageUrl(base, block);
    items.push({
      sourceId: stablePathId('hentai', entry.path),
      title,
      poster,
      background: poster,
      description: [rating && `Rating: ${rating}/10`, year && `Year: ${year}`].filter(Boolean).join(' · '),
      releaseDate: year,
      detailUrl: absoluteHttps(base, entry.path),
      upstreamId: entry.path,
      _path: entry.path,
      _index: entry.index,
    });
  }

  return uniqueBy(items.sort((left, right) => left._index - right._index), item => item.sourceId);
}

function parseDetail(source, html, sourceId) {
  const base = SOURCES[source].origin;
  const path = decodeStablePathId(source, sourceId);
  if (!path) return null;
  const title = metaContent(html, 'og:title') || firstContent(html, ['h1', 'h2']);
  if (!title) return null;
  const poster = absoluteHttps(base, metaContent(html, 'og:image')) || imageUrl(base, html);
  const description = metaContent(html, 'og:description') || metaContent(html, 'description') || descriptionFromBlock(html, ['Description', 'Synopsis']);
  const anchors = anchorRecords(html);
  const performers = uniqueBy(anchors
    .filter(item => /\/(?:pornstar|performer|model|actor|actress)\//i.test(item.href))
    .map(item => cleanText(item.text))
    .filter(Boolean), item => item).slice(0, 30);
  const studio = anchors
    .filter(item => /\/(?:studio|network|category)\//i.test(item.href))
    .map(item => usefulStudio(item.text))
    .find(Boolean) || '';
  const releaseDate = String(html).match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1]
    || metaContent(html, 'video:release_date')
    || '';
  return {
    sourceId,
    title,
    poster,
    background: poster,
    description: cleanText(description).slice(0, 2_000),
    studio,
    performers,
    releaseDate: cleanText(releaseDate),
    duration: parseDurationSeconds(metaContent(html, 'video:duration') || html),
    detailUrl: absoluteHttps(base, path),
    upstreamId: path,
  };
}

function buildCatalogUrl(source, catalog, page) {
  if (source === 'pornrips') return page === 1 ? `${SOURCES.pornrips.origin}/` : `${SOURCES.pornrips.origin}/page/${page}/`;
  if (source === 'yesporn') return `${SOURCES.yesporn.origin}/latest-updates/${page}/`;
  const suffix = page === 1 ? '/hentai-series/' : `/hentai-series/page/${page}/`;
  const mode = String(catalog?.mode || '').toLowerCase();
  const query = mode === 'top' ? '?filter=rating' : mode === 'new' ? '?filter=latest' : '';
  return `${SOURCES.hentai.origin}${suffix}${query}`;
}

function createNativeAdapter(source, options = {}) {
  const client = createNativeClient(source, options.config, options);
  const index = new Map();
  const parser = source === 'pornrips' ? parsePornripsCatalog : source === 'yesporn' ? parseYespornCatalog : parseHentaiCatalog;
  return Object.freeze({
    id: source,
    configured: true,
    native: true,
    origin: SOURCES[source].origin,
    async catalog({ catalog, skip = 0, limit = 40 }) {
      const page = pageNumber(skip, limit);
      const url = buildCatalogUrl(source, catalog, page);
      const payload = safeHtml(await client.fetchText(url, { cacheKey: `${source}:${catalog?.mode || 'recent'}:${page}` }), source);
      if (!payload) return [];
      const records = parser(payload).slice(0, limit);
      for (const record of records) index.set(record.sourceId, record);
      return records;
    },
    async meta({ sourceId }) {
      const remembered = index.get(String(sourceId || ''));
      const path = decodeStablePathId(source, sourceId);
      if (!path) return remembered || null;
      const url = absoluteHttps(SOURCES[source].origin, path);
      const payload = safeHtml(await client.fetchText(url, { cacheKey: `${source}:detail:${path}` }), source);
      const detailed = payload ? parseDetail(source, payload, sourceId) : null;
      return detailed || remembered || null;
    },
    async resolve() {
      return [];
    },
  });
}

module.exports = {
  NATIVE_MAX_RETRIES,
  NATIVE_MIN_REQUEST_INTERVAL_MS,
  SOURCES,
  buildCatalogUrl,
  createNativeAdapter,
  parseDetail,
  parseHentaiCatalog,
  parsePornripsCatalog,
  parseYespornCatalog,
};
