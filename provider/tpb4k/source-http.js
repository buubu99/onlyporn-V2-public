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
    this.checkDns = options.checkDns !== false;
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(safeUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, application/rss+xml, application/xml, text/xml;q=0.9',
          'User-Agent': 'OnlyPorn-TPB4K/2.7',
        },
      });
      if (!response || response.status < 200 || response.status >= 300) {
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
      if (/^\s*<!doctype\s+html|^\s*<html\b/i.test(text)) {
        this.cache.setNegative(key, this.negativeTtlMs);
        return '';
      }
      this.cache.set(key, text, this.cacheTtlMs);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  SourceHttpClient,
  normalizeContentType,
  validateConfiguredEndpoint,
};
