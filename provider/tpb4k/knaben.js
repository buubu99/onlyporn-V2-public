'use strict';

const crypto = require('node:crypto');
const { assertSafeHttpsUrl } = require('../url-security');
const { BoundedTtlCache } = require('./cache');
const { normalizeInfoHash, parseMagnet } = require('./candidate');

const KNABEN_ADULT_ENDPOINT = 'https://api.knaben.org/v1';
const KNABEN_MAX_RESULTS = 50;

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function compactComparable(value) {
  return compactText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
function searchTokens(value) {
  const noise = new Set([
    'the', 'and', 'for', 'with', 'from', 'onlyfans', 'fansly', 'fanvue',
    'xxx', 'porn', 'video', 'scene', 'episode', 'part', '1080p', '2160p',
    '720p', '4k', 'uhd', 'fhd', 'x264', 'x265', 'hevc',
  ]);
  return [...new Set(
    compactText(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
  )].filter(token => token.length >= 3 && !noise.has(token));
}
function nonNegativeInteger(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
function validBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}
function detectResolution(title) {
  const text = compactText(title).toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(text)) return '8K';
  if (/\b(?:2160p|4k|uhd)\b/.test(text)) return '4K';
  if (/\b(?:1080p|fhd)\b/.test(text)) return '1080p';
  if (/\b720p\b/.test(text)) return '720p';
  if (/\b480p\b/.test(text)) return '480p';
  return '';
}
function infoHashFromHit(hit = {}) {
  return normalizeInfoHash(hit.hash) || parseMagnet(hit.magnetUrl)?.infoHash || '';
}
function stableKnabenId(infoHash) {
  return `knaben:${crypto.createHash('sha256').update(infoHash).digest('hex').slice(0, 40)}`;
}
function normalizeKnabenHit(hit = {}, query = '', options = {}) {
  const infoHash = infoHashFromHit(hit);
  const title = compactText(hit.title).slice(0, 500);
  const queryKey = compactComparable(query);
  const titleKey = compactComparable(title);
  if (!infoHash || !title || !queryKey) return null;

  if (options.targeted === true) {
    const expected = searchTokens(query);
    const titleText = compactText(title).toLowerCase();
    const overlap = expected.filter(token => titleText.includes(token)).length;
    const required = expected.length <= 1 ? 1 : 2;
    if (!expected.length || overlap < required) return null;
  } else if (!titleKey.includes(queryKey)) {
    return null;
  }

  return Object.freeze({
    sourceId: stableKnabenId(infoHash),
    indexer: 'knaben',
    title,
    infoHash,
    magnetLink: '',
    detailUrl: '',
    seeders: nonNegativeInteger(hit.seeders),
    leechers: nonNegativeInteger(hit.peers),
    size: validBytes(hit.bytes),
    uploadedAt: compactText(hit.date || hit.created || ''),
    uploader: '',
    category: 'adult',
    resolution: detectResolution(title),
    mirror: new URL(KNABEN_ADULT_ENDPOINT).origin,
  });
}
function createKnabenAdultClient(options = {}) {
  const endpoint = String(options.endpoint || KNABEN_ADULT_ENDPOINT);
  if (endpoint !== KNABEN_ADULT_ENDPOINT) {
    throw new Error('Knaben endpoint is fixed to the approved public API');
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const checkDns = options.checkDns !== false;
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs || 15_000), 1_000), 30_000);
  const maxResponseBytes = Math.min(
    Math.max(Number(options.maxResponseBytes || 2_000_000), 64 * 1024),
    10 * 1024 * 1024
  );
  const cacheTtlMs = Math.max(Number(options.cacheTtlMs || 5 * 60 * 1000), 1_000);
  const negativeTtlMs = Math.max(Number(options.negativeTtlMs || 60 * 1000), 1_000);
  const cache = options.cache || new BoundedTtlCache({
    maxEntries: Math.max(Number(options.cacheMaxEntries || 250), 1),
    now: options.now,
  });
  const inflight = new Map();
  async function fetchStudio(queryValue, searchOptions = {}) {
    const query = compactText(queryValue).slice(0, 180);
    const orderBy = searchOptions.orderBy === 'date' ? 'date' : 'seeders';
    const targeted = searchOptions.targeted === true;
    if (query.length < 2) return [];
    const cacheKey = `knaben:${targeted ? 'targeted' : 'studio'}:${compactComparable(query)}:${orderBy}`;
    const cached = cache.getEntry(cacheKey);
    if (cached) return cached.negative ? [] : cached.value;
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    const request = (async () => {
      const safeUrl = await assertSafeHttpsUrl(endpoint, {
        allowedHosts: new Set([new URL(endpoint).hostname]),
        checkDns,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(safeUrl, {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'OnlyPorn/2.7',
          },
          body: JSON.stringify({
            query,
            search_type: '100%',
            order_by: orderBy,
            order_direction: 'desc',
            size: KNABEN_MAX_RESULTS,
            hide_unsafe: true,
            hide_xxx: false,
          }),
        });
        const status = Number(response?.status || 0);
        if (status < 200 || status >= 300) {
          cache.setNegative(cacheKey, negativeTtlMs);
          return [];
        }
        const contentType = String(response.headers?.get?.('content-type') || '')
          .split(';')[0].trim().toLowerCase();
        if (contentType && contentType !== 'application/json') {
          cache.setNegative(cacheKey, negativeTtlMs);
          return [];
        }
        const contentLength = Number.parseInt(String(response.headers?.get?.('content-length') || 0), 10) || 0;
        if (contentLength > maxResponseBytes) throw new Error('Knaben response exceeded the configured byte limit');
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) throw new Error('Knaben response exceeded the configured byte limit');
        const payload = JSON.parse(text);
        const records = (Array.isArray(payload?.hits) ? payload.hits : [])
          .map(hit => normalizeKnabenHit(hit, query, searchOptions))
          .filter(Boolean)
          .sort((left, right) => right.seeders - left.seeders || left.title.localeCompare(right.title));
        if (!records.length) {
          cache.setNegative(cacheKey, negativeTtlMs);
          return [];
        }
        const frozen = Object.freeze(records);
        cache.set(cacheKey, frozen, cacheTtlMs);
        return frozen;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, request);
    return request;
  }

  return Object.freeze({
    configured: options.enabled !== false,
    endpointOrigin: new URL(endpoint).origin,
    async searchStudio(query, searchOptions = {}) {
      if (options.enabled === false) return [];
      return fetchStudio(query, searchOptions);
    },
    cacheSize() { return cache.size; },
  });
}
module.exports = {
  KNABEN_ADULT_ENDPOINT,
  KNABEN_MAX_RESULTS,
  createKnabenAdultClient,
  infoHashFromHit,
  normalizeKnabenHit,
  searchTokens,
  stableKnabenId,
};
