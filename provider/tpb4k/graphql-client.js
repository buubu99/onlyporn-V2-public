'use strict';

const { BoundedTtlCache } = require('./cache');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function assertHttpsEndpoint(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('TPB4K GraphQL endpoint must be a credential-free HTTPS URL');
  }
  return url.toString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableValue(value[key])])
  );
}

function cacheKey(query, variables) {
  return JSON.stringify([String(query || ''), stableValue(variables || {})]);
}

class StashBoxGraphqlClient {
  constructor(options = {}) {
    this.name = String(options.name || 'metadata');
    this.endpoint = assertHttpsEndpoint(options.endpoint);
    this.apiKey = String(options.apiKey || '').trim();
    this.timeoutMs = Math.max(Number.parseInt(String(options.timeoutMs || 15_000), 10) || 15_000, 1_000);
    this.cacheTtlMs = Math.max(Number.parseInt(String(options.cacheTtlMs || 600_000), 10) || 600_000, 1_000);
    this.negativeTtlMs = Math.max(Number.parseInt(String(options.negativeTtlMs || 120_000), 10) || 120_000, 1_000);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.cache = options.cache || new BoundedTtlCache({ maxEntries: options.cacheMaxEntries || 500 });
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async request(query, variables = {}, options = {}) {
    if (!this.configured) return null;
    const key = cacheKey(query, variables);
    const cached = this.cache.getEntry(key);
    if (cached) return cached.negative ? null : cached.value;

    const controller = new AbortController();
    const requestedTimeoutMs = Number.parseInt(String(options.timeoutMs || ''), 10);
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.min(Math.max(requestedTimeoutMs, 250), this.timeoutMs)
      : this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ApiKey: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
    const declaredLength = Number.parseInt(String(response?.headers?.get?.('content-length') || '0'), 10) || 0;
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error(`${this.name} metadata response exceeded the size limit`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error(`${this.name} metadata response exceeded the size limit`);
    }

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${this.name} metadata endpoint returned malformed JSON`);
      }
    }

    const graphErrors = Array.isArray(payload?.errors) ? payload.errors : [];
    const graphDetail = graphErrors
      .map(error => String(error?.message || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(' | ');

    if (!response || !response.ok) {
      const status = Number(response?.status || 0);
      if (status === 404) this.cache.setNegative(key, this.negativeTtlMs);
      throw new Error(
        `${this.name} metadata request failed with HTTP ${status || 'unknown'}${
          graphDetail ? `: ${graphDetail}` : ''
        }`
      );
    }

    if (!contentType.includes('application/json')) {
      throw new Error(`${this.name} metadata endpoint returned a non-JSON response`);
    }

    if (graphErrors.length) {
      throw new Error(
        `${this.name} metadata GraphQL query failed${graphDetail ? `: ${graphDetail}` : ''}`
      );
    }

    const data = payload && typeof payload.data === 'object' ? payload.data : null;
    if (data === null && options.negativeOnNull) {
      this.cache.setNegative(key, this.negativeTtlMs);
      return null;
    }
    this.cache.set(key, data, this.cacheTtlMs);
    return data;
  }
}

module.exports = {
  StashBoxGraphqlClient,
  assertHttpsEndpoint,
  cacheKey,
};
