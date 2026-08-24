const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const m3u8 = require('m3u8-parser');
const { extractResolution, isLikelyFullVideoMp4 } = require('./media-utils');
const BoundedTtlCache = require('./cache');
const {
  assertSafeHttpsUrl,
  decodeResourceId,
  encodeResourceId,
  normalizeAllowedHosts,
  sanitizeUrlForLogs,
} = require('./url-security');
const logger = require('../logger');
const {
  curateWebHome,
  shouldCurateWebHome,
} = require('./web-home-curator');

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Provider {
  static LIMIT = 50;
  static TYPE = 'movie';
  static TRANSPORT_URL = '';

  constructor(baseUrl, name, limit, options = {}) {
    this.baseUrl = baseUrl;
    this.name = name;
    this.limit = limit || Provider.LIMIT;

    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    const hostAliases = new Set([baseHost]);
    if (baseHost.startsWith('www.')) hostAliases.add(baseHost.slice(4));
    else hostAliases.add(`www.${baseHost}`);

    for (const host of options.allowedPageHosts || []) hostAliases.add(host);
    this.allowedPageHosts = normalizeAllowedHosts(hostAliases);

    this.jar = new CookieJar();
    this.client = wrapper(axios.create({ jar: this.jar }));
    this.htmlCache = new BoundedTtlCache({
      maxEntries: options.htmlCacheMax || 200,
      ttlMs: options.htmlCacheTtlMs || 5_000,
    });
    this.jsonCache = new BoundedTtlCache({
      maxEntries: options.jsonCacheMax || 100,
      ttlMs: options.jsonCacheTtlMs || 5_000,
    });
    this.pendingRequests = new Map();
  }

  getName() {
    return this.name;
  }

  activate(catalogId) {
    const id = String(catalogId || '');
    if (!id) return false;

    if (id === this.name || new RegExp(`^${this.name}(?:[.\-_:]|$)`, 'i').test(id)) {
      return true;
    }

    if (id.startsWith(`onlyporn:${this.name}:`)) return true;

    return this.isSafeLegacyContentId(id);
  }

  isSafeLegacyContentId(id) {
    if (id.includes('::')) {
      const [pageUrl, relativePath, index] = id.split('::');
      if (!pageUrl || !relativePath || !/^\d+$/.test(index || '')) return false;
      if (!relativePath.startsWith('/') || relativePath.includes('://')) return false;
      try {
        const parsed = new URL(pageUrl);
        return parsed.protocol === 'https:' && this.allowedPageHosts.has(parsed.hostname.toLowerCase());
      } catch {
        return false;
      }
    }

    try {
      const parsed = new URL(id);
      return parsed.protocol === 'https:' && this.allowedPageHosts.has(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  toStremioId(contentId) {
    const id = String(contentId || '');
    if (id.startsWith(`onlyporn:${this.name}:`)) return id;
    return encodeResourceId(this.name, id);
  }

  async resolveContentId(resourceId) {
    const id = String(resourceId || '');
    const decoded = decodeResourceId(id, this.name);
    const contentId = decoded === null ? id : decoded;

    if (contentId.includes('::')) {
      if (!this.isSafeLegacyContentId(contentId)) {
        throw new Error('Unsafe composite content ID');
      }

      const [pageUrl, relativePath, index] = contentId.split('::');
      const safePageUrl = await assertSafeHttpsUrl(pageUrl, {
        allowedHosts: this.allowedPageHosts,
      });
      return `${safePageUrl}::${relativePath}::${index}`;
    }

    return assertSafeHttpsUrl(contentId, {
      allowedHosts: this.allowedPageHosts,
    });
  }

  getInitialUrl() {
    return this.baseUrl;
  }

  static create() {
    return new Provider('https://invalid.example', 'default');
  }

  defaultHeaders(accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8') {
    let origin = this.baseUrl;
    try {
      origin = new URL(this.baseUrl).origin;
    } catch {
      // Keep the configured value as a fallback.
    }

    return {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: accept,
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: this.baseUrl,
      Origin: origin,
      Connection: 'keep-alive',
    };
  }

  retryDelay(attempt, response) {
    const retryAfter = response?.headers?.['retry-after'];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 10_000);

      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) {
        return Math.min(Math.max(dateMs - Date.now(), 0), 10_000);
      }
    }

    return Math.min(500 * 2 ** attempt, 4_000);
  }

  async request(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      timeout = 15_000,
      retries = 2,
      maxRedirects = 5,
      responseType = 'text',
      allowedHosts = this.allowedPageHosts,
      checkDns = true,
      cache,
      cacheKey,
      data,
    } = options;

    const normalizedMethod = method.toUpperCase();
    const requestBodyKey = data == null ? '' : `:${typeof data === 'string' ? data : JSON.stringify(data)}`;
    const key = cacheKey || `${normalizedMethod}:${url}${requestBodyKey}`;
    if (cache) {
      const cached = cache.get(key);
      if (cached !== undefined) {
        return { data: cached, status: 200, headers: {}, finalUrl: url };
      }
    }

    const pendingKey = `${responseType}:${key}`;
    if (this.pendingRequests.has(pendingKey)) {
      return this.pendingRequests.get(pendingKey);
    }

    const operation = (async () => {
      let currentUrl = url;
      let currentMethod = normalizedMethod;
      let currentData = data;
      let redirects = 0;
      let lastError;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          currentUrl = await assertSafeHttpsUrl(currentUrl, {
            allowedHosts,
            checkDns,
          });

          const response = await this.client.request({
            url: currentUrl,
            method: currentMethod,
            headers: {
              ...this.defaultHeaders(
                responseType === 'json'
                  ? 'application/json, text/plain, */*'
                  : undefined
              ),
              ...headers,
            },
            timeout,
            maxRedirects: 0,
            responseType,
            data: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentData,
            validateStatus: () => true,
          });

          if (REDIRECT_STATUS.has(response.status)) {
            if (redirects >= maxRedirects) throw new Error('Too many redirects');
            const location = response.headers.location;
            if (!location) throw new Error('Redirect response missing Location header');

            currentUrl = new URL(location, currentUrl).toString();
            if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
              currentMethod = 'GET';
              currentData = undefined;
            }
            redirects += 1;
            attempt -= 1;
            continue;
          }

          if (response.status >= 200 && response.status < 300) {
            const data = response.data;
            if (cache) cache.set(key, data);
            return {
              data,
              status: response.status,
              headers: response.headers,
              finalUrl: currentUrl,
            };
          }

          const error = new Error(`HTTP ${response.status}`);
          error.response = response;
          throw error;
        } catch (error) {
          lastError = error;
          const status = error.response?.status;
          const retryable = RETRYABLE_STATUS.has(status) || !error.response;

          if (!retryable || attempt >= retries) break;
          await delay(this.retryDelay(attempt, error.response));
        }
      }

      logger.warn(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(currentUrl),
          error: lastError?.message || 'Unknown request error',
        },
        'Provider request failed'
      );
      throw lastError || new Error('Provider request failed');
    })();

    this.pendingRequests.set(pendingKey, operation);
    try {
      return await operation;
    } finally {
      this.pendingRequests.delete(pendingKey);
    }
  }

  async fetchHtml(url, requestOptions = {}) {
    const { headers = {}, ...rest } = requestOptions;
    const result = await this.request(url, {
      ...rest,
      headers,
      responseType: 'text',
      allowedHosts: this.allowedPageHosts,
      cache: rest.cache === false ? null : this.htmlCache,
      cacheKey: rest.cacheKey || `html:${url}`,
    });

    return typeof result.data === 'string' ? result.data : String(result.data || '');
  }

  async fetchMediaText(url, requestOptions = {}) {
    const { headers = {}, ...rest } = requestOptions;
    const result = await this.request(url, {
      ...rest,
      headers,
      responseType: 'text',
      allowedHosts: null,
      cache: rest.cache || null,
      cacheKey: rest.cacheKey || `media:${url}`,
    });
    return typeof result.data === 'string' ? result.data : String(result.data || '');
  }

  async fetchJson(url, requestOptions = {}) {
    const { headers = {}, ...rest } = requestOptions;
    const result = await this.request(url, {
      ...rest,
      headers,
      responseType: 'json',
      allowedHosts: rest.allowedHosts === undefined ? this.allowedPageHosts : rest.allowedHosts,
      cache: rest.cache === false ? null : this.jsonCache,
      cacheKey: rest.cacheKey || `json:${url}`,
    });
    return result.data;
  }

  async mediaExists(url, requestOptions = {}) {
    try {
      await this.request(url, {
        ...requestOptions,
        method: 'HEAD',
        responseType: 'text',
        allowedHosts: null,
        cache: null,
        retries: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  async resolveMediaUrl(url, requestOptions = {}) {
    const result = await this.request(url, {
      ...requestOptions,
      method: 'HEAD',
      responseType: 'text',
      allowedHosts: null,
      cache: null,
      retries: 1,
    });
    return result.finalUrl;
  }

  cleanUrl(url) {
    if (!url) return url;
    return url
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&');
  }

  page(skip) {
    const numericSkip = Number(skip || 0);
    if (!Number.isFinite(numericSkip) || numericSkip <= 0) return '1';
    return String(Math.floor(numericSkip / this.limit) + 1);
  }

  handleSearch({ extra: { search: keyword } }) {
    return `/search/${encodeURIComponent(keyword)}/`;
  }

  handleGenre({ extra: { genre } }) {
    return `?genre=${encodeURIComponent(genre)}`;
  }

  handlePagination(url, { extra: { skip } }) {
    return `?skip=${encodeURIComponent(skip)}`;
  }

  getCatalogMetas() {
    return [];
  }

  getAnalyticEvent(event, id) {
    if (id) return `${event}-${id}`;
    return `${event}-${this.getName()}`;
  }

  async _fetchCatalogPage(args, options = {}) {
    let url = this.getInitialUrl(args.id);
    const extra = args.extra || {};

    if (extra.search) url = this.handleSearch(args);
    if (extra.genre) url = this.handleGenre(args);

    if (Number(extra.skip || 0) > 0) {
      const paginated = this.handlePagination(url, args);
      url = paginated.startsWith('http') ? paginated : url + paginated;
    }

    return this._fetchCatalogUrl(args, url, options);
  }

  async _fetchCatalogUrl(args, url, options = {}) {
    const { postProcess = true } = options;
    const html = await this.fetchHtml(url);
    const parsed = this.getCatalogMetas.length >= 2
      ? this.getCatalogMetas(html, url)
      : this.getCatalogMetas(html);
    const parsedMetas = Array.isArray(parsed) ? parsed : [];
    if (!postProcess || typeof this.postProcessCatalogMetas !== 'function') return parsedMetas;
    const processed = await this.postProcessCatalogMetas(parsedMetas, { args, url });
    return Array.isArray(processed) ? processed : [];
  }

  async handleCatalog(args) {
    if (args.type !== Provider.TYPE || !this.activate(args.id)) return { metas: [] };

    logger.info({ provider: this.name, catalogId: args.id }, 'handleCatalog');

    try {
      const parsedMetas = shouldCurateWebHome(this, args)
        ? await curateWebHome(this, args)
        : await this._fetchCatalogPage(args);
      const metas = parsedMetas.map(item => ({
        ...item,
        id: this.toStremioId(item.id),
      }));

      logger.debug({ provider: this.name, metasSize: metas.length }, 'catalog');
      return { metas };
    } catch (error) {
      logger.warn({ provider: this.name, error: error.message }, 'Catalog request failed');
      return { metas: [] };
    }
  }

  async handleMeta(args) {
    if (args.type !== Provider.TYPE || !this.activate(args.id)) return { meta: {} };

    try {
      const originalId = args.id;
      const contentId = await this.resolveContentId(originalId);
      const meta = await this.getMetadata({ ...args, id: contentId });
      if (meta && typeof meta === 'object') meta.id = originalId;
      return { meta: meta || {} };
    } catch (error) {
      logger.warn({ provider: this.name, error: error.message }, 'Metadata request rejected');
      return { meta: {} };
    }
  }

  async getMetadata(args) {
    logger.info({ provider: this.name }, 'getMetadata');
    const { id } = args;
    const html = await this.fetchHtml(id);
    const result = await this.parseVideoPage({ id, html });
    return result?.metaResponse || result;
  }

  async handleStream(args) {
    if (args.type !== Provider.TYPE || !this.activate(args.id)) return { streams: [] };

    try {
      const contentId = await this.resolveContentId(args.id);
      return await this.processStreams({ ...args, id: contentId });
    } catch (error) {
      logger.warn({ provider: this.name, error: error.message }, 'Stream request rejected');
      return { streams: [] };
    }
  }

  async processStreams({ id }) {
    const html = await this.fetchHtml(id);

    const hls = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    if (hls) return this.getStreams({ videoPageUrl: this.cleanUrl(hls[0]) });

    const dash = html.match(/https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*/i);
    if (dash) {
      const url = await assertSafeHttpsUrl(this.cleanUrl(dash[0]));
      return {
        streams: [{ type: Provider.TYPE, url, name: 'DASH' }],
      };
    }

    const parsed = await this.parseVideoPage({ id, html });
    if (!parsed) return { streams: [] };
    if (parsed.streams?.length) return { streams: parsed.streams };

    if (parsed.videoPageUrl?.includes('/embed/')) {
      const embedHtml = await this.fetchMediaText(parsed.videoPageUrl);
      const embedHls = embedHtml.match(/(?:https?:)?\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
      if (embedHls) {
        let url = embedHls[0];
        if (url.startsWith('//')) url = `https:${url}`;
        parsed.videoPageUrl = this.cleanUrl(url);
      }
    }

    const result = await this.getStreams(parsed);
    if (result.streams?.length) return result;

    const mp4Matches = html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi) || [];
    const mp4 = mp4Matches
      .map(candidate => this.cleanUrl(candidate))
      .find(candidate => isLikelyFullVideoMp4(candidate, { allowKnownVideoPath: true }));

    if (!mp4) return { streams: [] };
    const safeMp4 = await assertSafeHttpsUrl(mp4);
    const resolution = extractResolution(safeMp4);
    return {
      streams: [{
        type: Provider.TYPE,
        url: safeMp4,
        name: resolution ? `${resolution} MP4` : 'MP4',
        behaviorHints: { notWebReady: false },
      }],
    };
  }

  async getStreams(meta) {
    if (!meta.videoPageUrl) return { streams: [] };

    const mediaUrl = await assertSafeHttpsUrl(meta.videoPageUrl);
    if (/\.mp4(?:[?#]|$)/i.test(mediaUrl)) {
      return {
        streams: [{ type: Provider.TYPE, url: mediaUrl, name: 'MP4' }],
      };
    }

    const content = await this.fetchMediaText(mediaUrl);
    if (!content.includes('#EXTM3U')) return { streams: [] };

    const streams = this.parseM3u8(content)
      .map(stream => this.transformStream(mediaUrl, stream));
    return { streams };
  }

  transformStream(baseUrl, stream) {
    if (!stream.url) return stream;

    try {
      return { ...stream, url: new URL(stream.url, baseUrl).toString() };
    } catch (error) {
      logger.warn(
        { baseUrl: sanitizeUrlForLogs(baseUrl), error: error.message },
        'Unable to resolve stream URL'
      );
      return stream;
    }
  }

  parseM3u8(content) {
    const streams = [];
    const parser = new m3u8.Parser();

    try {
      parser.push(content);
      parser.end();

      for (const playlist of parser.manifest.playlists || []) {
        const height = playlist.attributes?.RESOLUTION?.height || 'auto';
        streams.push({ resolution: `${height}p`, url: playlist.uri });
      }

      streams.sort((a, b) => (parseInt(b.resolution, 10) || 0) - (parseInt(a.resolution, 10) || 0));
      return streams.map(stream => ({
        type: Provider.TYPE,
        url: stream.url,
        name: stream.resolution,
        behaviorHints: { notWebReady: true },
      }));
    } catch (error) {
      logger.warn({ error: error.message }, 'parseM3u8 failed');
      return [];
    }
  }

  parseVideoPage() {
    return {};
  }

  track() {}
}

module.exports = Provider;
