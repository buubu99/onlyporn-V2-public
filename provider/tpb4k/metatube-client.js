'use strict';

const crypto = require('node:crypto');
const { BoundedTtlCache } = require('./cache');
const { validateImageResponse } = require('./sukebei-image-validator');

const EXCLUDED_PROVIDER = /^(?:theporndb|tpdb)$/i;
const DEFAULT_INTERNAL_BASE = 'http://127.0.0.1:18080';
const DEFAULT_PUBLIC_BASE = 'https://onlyporn-v2-public-k143.onrender.com';

function compactText(value, max = 500) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactCode(value) {
  return compactText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function providerName(row = {}) {
  return compactText(
    row.provider?.name ||
    row.provider ||
    row.source?.name ||
    row.source ||
    ''
  );
}

function isExactMetaTubeCode(requested, row = {}) {
  const wanted = compactCode(requested);
  const number = compactCode(row.number || row.code);
  const id = compactCode(row.id);
  if (!wanted) return false;
  if (number === wanted) return true;
  if (wanted.startsWith('FC2PPV')) {
    const digits = wanted.replace(/\D+/g, '');
    return Boolean(digits) && [number, id]
      .map(value => value.replace(/\D+/g, ''))
      .includes(digits);
  }
  return false;
}

function collectRows(value, depth = 0, seen = new Set()) {
  if (depth > 6 || value === null || value === undefined || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    const direct = value.filter(item => item && typeof item === 'object' &&
      (item.id !== undefined || item.number !== undefined || item.code !== undefined));
    if (direct.length) return direct;
    return value.flatMap(item => collectRows(item, depth + 1, seen));
  }
  for (const candidate of [value.data, value.results, value.movies, value.items, value.list]) {
    const rows = collectRows(candidate, depth + 1, seen);
    if (rows.length) return rows;
  }
  return Object.values(value).flatMap(item => collectRows(item, depth + 1, seen));
}

function normalizeList(values) {
  if (!Array.isArray(values)) return [];
  return values.map(value => compactText(value?.name || value)).filter(Boolean);
}

function parseInternalBase(value) {
  try {
    const url = new URL(compactText(value) || DEFAULT_INTERNAL_BASE);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function parsePublicBase(value) {
  try {
    const url = new URL(compactText(value) || DEFAULT_PUBLIC_BASE);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function encodeToken(value) {
  return Buffer.from(compactText(value, 300), 'utf8').toString('base64url');
}

function proxySignature(secret, provider, id) {
  return crypto.createHmac('sha256', compactText(secret, 500))
    .update(`${compactText(provider, 300)}\0${compactText(id, 300)}`, 'utf8')
    .digest('base64url');
}

function posterProxyUrl(publicBase, provider, id, secret) {
  return `${publicBase}/onlyporn/poster/metatube/${encodeToken(provider)}/${encodeToken(id)}/${proxySignature(secret, provider, id)}`;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs || 0), 250));
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    return typeof consume === 'function' ? await consume(response) : response;
  } finally {
    clearTimeout(timer);
  }
}

function createMetaTubeClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const enabled = String(env.TPB4K_METATUBE_ENABLED || '').toLowerCase() === 'true';
  const internalBase = parseInternalBase(env.TPB4K_METATUBE_URL || DEFAULT_INTERNAL_BASE);
  const publicBase = parsePublicBase(
    env.TPB4K_METATUBE_PUBLIC_URL ||
    env.ONLYPORN_PUBLIC_BASE_URL ||
    env.RENDER_EXTERNAL_URL ||
    DEFAULT_PUBLIC_BASE
  );
  const proxySecret = compactText(env.TPB4K_METATUBE_PROXY_SECRET, 500);
  const searchTimeoutMs = Math.min(Math.max(Number(env.TPB4K_METATUBE_SEARCH_TIMEOUT_MS || 210_000), 5_000), 300_000);
  const imageTimeoutMs = Math.min(Math.max(Number(env.TPB4K_METATUBE_IMAGE_TIMEOUT_MS || 30_000), 5_000), 90_000);
  const positiveTtlMs = Math.min(Math.max(Number(env.TPB4K_METATUBE_CACHE_TTL_MS || 6 * 60 * 60 * 1000), 60_000), 24 * 60 * 60 * 1000);
  const negativeTtlMs = Math.min(Math.max(Number(env.TPB4K_METATUBE_NEGATIVE_TTL_MS || 15_000), 5_000), 60 * 60 * 1000);
  const cache = new BoundedTtlCache({ maxEntries: 500 });
  const inFlight = new Map();

  async function searchExact(code, requestedTimeoutMs) {
    const key = compactCode(code);
    if (!key || !enabled || !internalBase || !publicBase || proxySecret.length < 32) return null;
    const cached = cache.getEntry(key);
    if (cached) return cached.negative ? null : cached.value;
    if (inFlight.has(key)) return inFlight.get(key);

    const operation = (async () => {
      const timeoutMs = Math.min(
        Math.max(Number(requestedTimeoutMs || searchTimeoutMs), 5_000),
        searchTimeoutMs
      );
      const searchUrl = `${internalBase}/v1/movies/search?${new URLSearchParams({
        q: compactText(code, 100),
        fallback: 'true',
      })}`;
      const payload = await fetchWithTimeout(fetchImpl, searchUrl, {
        redirect: 'follow',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'OnlyPorn-MetaTube-Sukebei/1.0',
        },
      }, timeoutMs, async response => {
        if (!response.ok) throw new Error(`MetaTube search returned HTTP ${response.status}`);
        return response.json();
      });
      const exactRows = collectRows(payload).filter(row => isExactMetaTubeCode(code, row));

      for (const row of exactRows) {
        const provider = providerName(row);
        const id = compactText(row.id, 300);
        const title = compactText(row.title || row.name, 500);
        if (!provider || !id || !title || EXCLUDED_PROVIDER.test(provider.replace(/[\s_-]+/g, ''))) continue;

        const imageUrl = `${internalBase}/v1/images/primary/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
        let validation;
        try {
          validation = await fetchWithTimeout(fetchImpl, imageUrl, {
            redirect: 'follow',
            headers: {
              Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5',
              'User-Agent': 'OnlyPorn-MetaTube-Sukebei/1.0',
            },
          }, Math.min(imageTimeoutMs, timeoutMs), async response => {
            if (!response.ok) return null;
            return validateImageResponse(response, {
              url: imageUrl,
              maxResponseBytes: 2_000_000,
            });
          });
        } catch {
          continue;
        }
        if (!validation?.valid) continue;

        const poster = posterProxyUrl(publicBase, provider, id, proxySecret);
        const scene = Object.freeze({
          id: `${provider}:${id}`,
          title,
          code: compactText(row.number || row.code || code, 100),
          poster,
          background: poster,
          studio: { name: compactText(row.maker?.name || row.studio?.name || row.maker || row.studio, 200) },
          performers: normalizeList(row.actors || row.performers),
          tags: normalizeList(row.genres || row.tags),
          release_date: compactText(row.release_date || row.releaseDate || row.date, 80),
          url: compactText(row.homepage || row.url, 500),
        });
        cache.set(key, scene, positiveTtlMs);
        return scene;
      }

      cache.setNegative(key, negativeTtlMs);
      return null;
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, operation);
    return operation;
  }

  return Object.freeze({
    configured: Boolean(enabled && internalBase && publicBase && proxySecret.length >= 32),
    async queryScenes(request = {}) {
      const scene = await searchExact(request.query, request.timeoutMs);
      return scene ? [scene] : [];
    },
    searchExact,
    diagnostics() {
      return Object.freeze({ configured: Boolean(enabled && internalBase && publicBase && proxySecret.length >= 32), cacheSize: cache.size, inFlight: inFlight.size });
    },
  });
}

module.exports = {
  collectRows,
  compactCode,
  createMetaTubeClient,
  encodeToken,
  isExactMetaTubeCode,
  posterProxyUrl,
  proxySignature,
};
