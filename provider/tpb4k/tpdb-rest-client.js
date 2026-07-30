'use strict';

const { BoundedTtlCache } = require('./cache');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function assertHttpsBase(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('TPDB REST endpoint must be a credential-free HTTPS base URL');
  }
  return url.toString().replace(/\/$/, '');
}

function positiveInteger(value, fallback, max = 100) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, 1), max);
}

function safeMessage(payload, fallback) {
  const message = String(
    payload?.message ||
      payload?.error ||
      payload?.errors?.[0]?.message ||
      fallback ||
      ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  return message.slice(0, 300);
}

function responseRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.scenes)) return payload.scenes;
  if (Array.isArray(payload?.data?.scenes)) return payload.data.scenes;
  return [];
}

function responseResource(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
    return payload.data;
  }
  if (payload.scene && typeof payload.scene === 'object' && !Array.isArray(payload.scene)) {
    return payload.scene;
  }
  if (payload.id || payload._id) return payload;
  return null;
}

class TpdbRestClient {
  constructor(options = {}) {
    this.name = 'tpdb';
    this.endpoint = assertHttpsBase(options.endpoint);
    this.apiKey = String(options.apiKey || '').trim();
    this.timeoutMs = Math.max(
      Number.parseInt(String(options.timeoutMs || 15_000), 10) || 15_000,
      1_000
    );
    this.cacheTtlMs = Math.max(
      Number.parseInt(String(options.cacheTtlMs || 600_000), 10) || 600_000,
      1_000
    );
    this.negativeTtlMs = Math.max(
      Number.parseInt(String(options.negativeTtlMs || 120_000), 10) || 120_000,
      1_000
    );
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.cache = options.cache || new BoundedTtlCache({ maxEntries: options.cacheMaxEntries || 500 });
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  buildUrl(pathname, params = {}) {
    const url = new URL(String(pathname || ''), `${this.endpoint}/`);
    const base = new URL(`${this.endpoint}/`);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error('TPDB REST request escaped the configured API base');
    }
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(name, String(value));
    }
    return url;
  }

  async request(pathname, params = {}, options = {}) {
    if (!this.configured) return null;
    const url = this.buildUrl(pathname, params);
    const cacheKey = url.toString();
    const cached = this.cache.getEntry(cacheKey);
    if (cached) return cached.negative ? null : cached.value;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'User-Agent': 'OnlyPorn-TPB4K/2.7.0',
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
    const declaredLength =
      Number.parseInt(String(response?.headers?.get?.('content-length') || '0'), 10) || 0;
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('tpdb REST response exceeded the size limit');
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('tpdb REST response exceeded the size limit');
    }

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('tpdb REST endpoint returned malformed JSON');
      }
    }

    if (!response?.ok) {
      const status = Number(response?.status || 0);
      if (status === 404 && options.negativeOn404) {
        this.cache.setNegative(cacheKey, this.negativeTtlMs);
        return null;
      }
      const detail = safeMessage(payload);
      throw new Error(
        `tpdb REST request failed with HTTP ${status || 'unknown'}${detail ? `: ${detail}` : ''}`
      );
    }

    if (!contentType.includes('application/json')) {
      throw new Error('tpdb REST endpoint returned a non-JSON response');
    }

    this.cache.set(cacheKey, payload, this.cacheTtlMs);
    return payload;
  }

  async queryScenes(options = {}) {
    const payload = await this.request('scenes', {
      q: String(options.query || options.title || options.text || '').replace(/\s+/g, ' ').trim(),
      page: positiveInteger(options.page, 1, 100_000),
      per_page: positiveInteger(options.perPage, 40, 100),
      site: String(options.studio || options.site || '').replace(/\s+/g, ' ').trim(),
      year: Number.parseInt(String(options.year || ''), 10) || undefined,
      order_by: String(options.orderBy || '').replace(/\s+/g, ' ').trim(),
    });
    return responseRecords(payload);
  }

  async findScene(id) {
    const upstreamId = String(id || '').trim();
    if (!this.configured || !upstreamId) return null;
    const payload = await this.request(
      `scenes/${encodeURIComponent(upstreamId)}`,
      {},
      { negativeOn404: true }
    );
    return responseResource(payload);
  }
}

module.exports = {
  MAX_RESPONSE_BYTES,
  TpdbRestClient,
  assertHttpsBase,
  positiveInteger,
  responseRecords,
  responseResource,
};
