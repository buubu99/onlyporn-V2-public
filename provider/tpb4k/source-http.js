
'use strict';

const { BoundedTtlCache } = require('./cache');
const { assertSafeHttpsUrl, parseHttpsUrl } = require('../url-security');

const SENSITIVE_QUERY = /(?:api[-_]?key|token|secret|password|authorization|auth)/i;

function validateConfiguredEndpoint(value, name = 'TPB4K source endpoint') {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = parseHttpsUrl(text);
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) {
      throw new Error(`${name} must not contain secret-bearing query parameters`);
    }
  }
  return parsed.toString();
}

function normalizeContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

class SourceHttpClient {
  constructor(options = {}) {
    this.id = String(options.id || 'source').trim();
    this.endpoint = validateConfiguredEndpoint(options.endpoint, `${this.id} endpoint`);
    this.timeoutMs = Math.max(Number(options.timeoutMs || 15_000), 1_000);
    this.maxResponseBytes = Math.max(Number(options.maxResponseBytes || 2_000_000), 1_024);
    this.cacheTtlMs = Math.max(Number(options.cacheTtlMs || 5 * 60 * 1000), 1_000);
    this.negativeTtlMs = Math.max(Number(options.negativeTtlMs || 60 * 1000), 1_000);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.allowHtml = options.allowHtml === true;
    this.accept = String(options.accept || 'application/json, application/rss+xml, application/xml, text/xml;q=0.9');
    this.userAgent = String(options.userAgent || 'OnlyPorn-TPB4K/2.7');
    this.checkDns = options.checkDns !== false;
    this.minRequestIntervalMs = Math.max(Number(options.minRequestIntervalMs ?? 0), 0);
    this.maxRetries = Math.min(Math.max(Number(options.maxRetries ?? 0), 0), 2);
    this.retryBaseDelayMs = Math.max(Number(options.retryBaseDelayMs ?? 500), 10);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    this.inflight = new Map();
    this.requestQueue = Promise.resolve();
    this.nextRequestAt = 0;
    this.cache = options.cache || new BoundedTtlCache({
      maxEntries: Math.max(Number(options.cacheMaxEntries || 250), 1),
    });
    this.allowedContentTypes = new Set(
      (options.allowedContentTypes || ['application/json', 'application/xml', 'text/xml', 'application/rss+xml'])
        .map(normalizeContentType)
        .filter(Boolean)
    );
    if (this.endpoint) {
      this.origin = new URL(this.endpoint).origin;
      this.allowedHosts = new Set([new URL(this.endpoint).hostname.toLowerCase()]);
    } else {
      this.origin = '';
      this.allowedHosts = new Set();
    }
  }

  get configured() {
    return Boolean(this.endpoint);
  }

  buildUrl({ skip = 0, limit = 40, mode = '' } = {}) {
    if (!this.endpoint) return '';
    const url = new URL(this.endpoint);
    url.searchParams.set('skip', String(Math.max(Number.parseInt(String(skip), 10) || 0, 0)));
    url.searchParams.set('limit', String(Math.min(Math.max(Number.parseInt(String(limit), 10) || 40, 1), 100)));
    if (mode) url.searchParams.set('mode', String(mode));
    return url.toString();
  }

  async schedule(task) {
    const previous = this.requestQueue;
    let release;
    this.requestQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(this.nextRequestAt - this.now(), 0);
      if (delay > 0) await this.sleep(delay);
      return await task();
    } finally {
      this.nextRequestAt = this.now() + this.minRequestIntervalMs;
      release();
    }
  }

  async requestOnce(safeUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(safeUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: this.accept,
          'Accept-Language': 'en-US,en;q=0.8',
          'User-Agent': this.userAgent,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchWithRetry(safeUrl, key) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response;
      try {
        response = await this.requestOnce(safeUrl);
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.retryBaseDelayMs * (2 ** attempt));
          continue;
        }
        this.cache.setNegative(key, this.negativeTtlMs);
        throw error;
      }

      const status = Number(response?.status || 0);
      if (status >= 500 && status <= 599 && attempt < this.maxRetries) {
        await this.sleep(this.retryBaseDelayMs * (2 ** attempt));
        continue;
      }
      if (!response || status < 200 || status >= 300) {
        this.cache.setNegative(key, this.negativeTtlMs);
        return '';
      }

      const contentLength = Number.parseInt(String(response.headers?.get?.('content-length') || 0), 10) || 0;
      if (contentLength > this.maxResponseBytes) {
        throw new Error('TPB4K source response exceeded the configured byte limit');
      }
      const contentType = normalizeContentType(response.headers?.get?.('content-type'));
      if (contentType && !this.allowedContentTypes.has(contentType)) {
        this.cache.setNegative(key, this.negativeTtlMs);
        return '';
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
        throw new Error('TPB4K source response exceeded the configured byte limit');
      }
      if (!this.allowHtml && /^(?:\s*<!doctype\s+html|\s*<html\b)/i.test(text)) {
        this.cache.setNegative(key, this.negativeTtlMs);
        return '';
      }
      if (!text) {
        this.cache.setNegative(key, this.negativeTtlMs);
        return '';
      }
      this.cache.set(key, text, this.cacheTtlMs);
      return text;
    }
    return '';
  }

  async fetchText(url, options = {}) {
    if (!this.configured) return '';
    const safeUrl = await assertSafeHttpsUrl(url, {
      allowedHosts: this.allowedHosts,
      checkDns: this.checkDns,
    });
    if (new URL(safeUrl).origin !== this.origin) throw new Error('TPB4K source origin changed unexpectedly');

    const key = String(options.cacheKey || safeUrl);
    const cached = this.cache.getEntry(key);
    if (cached) return cached.negative ? '' : cached.value;

    const active = this.inflight.get(key);
    if (active) return active;

    const request = this.schedule(() => this.fetchWithRetry(safeUrl, key))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }
}

module.exports = {
  SourceHttpClient,
  normalizeContentType,
  validateConfiguredEndpoint,
};
