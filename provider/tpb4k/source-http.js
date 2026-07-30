
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
    this.serializeRequests = options.serializeRequests !== false;
    this.maxRetries = Math.min(Math.max(Number(options.maxRetries ?? 0), 0), 2);
    this.maxRedirects = Math.min(Math.max(Number(options.maxRedirects ?? 3), 0), 5);
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

  async requestOnce(safeUrl, signal) {
    return this.fetchImpl(safeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        Accept: this.accept,
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': this.userAgent,
      },
    });
  }

  async requestFollowingRedirects(initialUrl, signal) {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      const response = await this.requestOnce(currentUrl, signal);
      const status = Number(response?.status || 0);
      if (status < 300 || status >= 400) return response;

      const location = response?.headers?.get?.('location');
      try {
        if (typeof response?.body?.cancel === 'function') await response.body.cancel();
      } catch {
        // Redirect headers are sufficient; body cancellation is best effort.
      }
      if (!location) return response;
      if (redirects >= this.maxRedirects) {
        throw new Error('TPB4K source exceeded the safe redirect limit');
      }

      const target = new URL(String(location), currentUrl).toString();
      const safeTarget = await assertSafeHttpsUrl(target, {
        allowedHosts: this.allowedHosts,
        checkDns: this.checkDns,
      });
      if (new URL(safeTarget).origin !== this.origin) {
        throw new Error('TPB4K source redirect changed origin unexpectedly');
      }
      currentUrl = safeTarget;
    }
    throw new Error('TPB4K source exceeded the safe redirect limit');
  }

  async fetchWithRetry(safeUrl, key, options = {}) {
    const requestedTimeoutMs = Number.parseInt(String(options.timeoutMs || ''), 10);
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.min(Math.max(requestedTimeoutMs, 250), this.timeoutMs)
      : this.timeoutMs;
    const deadlineAt = Date.now() + timeoutMs;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        this.cache.setNegative(key, this.negativeTtlMs);
        throw new Error('TPB4K source request deadline exceeded');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(remainingMs, 1));
      let response;
      try {
        response = await this.requestFollowingRedirects(safeUrl, controller.signal);
      } catch (error) {
        clearTimeout(timer);
        const retryDelayMs = Math.min(
          this.retryBaseDelayMs * (2 ** attempt),
          Math.max(deadlineAt - Date.now(), 0)
        );
        if (attempt < this.maxRetries && retryDelayMs > 0) {
          await this.sleep(retryDelayMs);
          continue;
        }
        this.cache.setNegative(key, this.negativeTtlMs);
        throw error;
      }

      const status = Number(response?.status || 0);
      if (status >= 500 && status <= 599 && attempt < this.maxRetries) {
        clearTimeout(timer);
        const retryDelayMs = Math.min(
          this.retryBaseDelayMs * (2 ** attempt),
          Math.max(deadlineAt - Date.now(), 0)
        );
        if (retryDelayMs > 0) {
          await this.sleep(retryDelayMs);
          continue;
        }
      }
      if (!response || status < 200 || status >= 300) {
        clearTimeout(timer);
        this.cache.setNegative(key, this.negativeTtlMs);
        return '';
      }

      try {
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
      } catch (error) {
        const retryDelayMs = Math.min(
          this.retryBaseDelayMs * (2 ** attempt),
          Math.max(deadlineAt - Date.now(), 0)
        );
        if (attempt < this.maxRetries && retryDelayMs > 0) {
          await this.sleep(retryDelayMs);
          continue;
        }
        this.cache.setNegative(key, this.negativeTtlMs);
        throw error;
      } finally {
        clearTimeout(timer);
      }
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

    const execute = () => this.fetchWithRetry(safeUrl, key, options);
    const request = (this.serializeRequests ? this.schedule(execute) : execute())
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
