const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));
const m3u8 = require('m3u8-parser');
const { extractResolution, isLikelyFullVideoMp4 } = require('./media-utils');
const logger = require('../logger');

/* =========================
   🔥 ADDED (SAFE GLOBALS)
========================= */
const cache = new Map();     // 🧠 response cache
const pending = new Map();   // 🔁 request deduplication
/* ========================= */

class Provider {
  static LIMIT = 50;
  static TYPE = 'movie';

  static TRANSPORT_URL = '';

  constructor(baseUrl, name, limit) {
    this.baseUrl = baseUrl;
    this.name = name;
    this.limit = limit || Provider.LIMIT;
  }

  getName() {
    return this.name;
  }

  activate(catalogId) {
    return catalogId.indexOf(this.getName()) !== -1;
  }

  getInitialUrl() {
    return this.baseUrl;
  }

  static create() {
    return new Provider('', 'default');
  }

  /* =========================
     🚀 OPTIMIZED fetchHtml
  ========================= */
  async fetchHtml(url, requestOptions = {}) {
    console.info('fetching url', url);

    // ⚡ CACHE HIT (5 sec TTL)
    const cached = cache.get(url);
    if (cached && (Date.now() - cached.time < 5000)) {
      return cached.data;
    }

    // 🔁 PREVENT DUPLICATE PARALLEL REQUESTS
    if (pending.has(url)) {
      return pending.get(url);
    }

    const { headers: overrideHeaders = {}, ...overrideOptions } = requestOptions;
    const defaultOrigin = (() => {
      try {
        return new URL(this.baseUrl).origin;
      } catch {
        return this.baseUrl;
      }
    })();

    const request = client.get(url, {
      ...overrideOptions,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": this.baseUrl,
        "Origin": defaultOrigin,
        "Connection": "keep-alive",
        ...overrideHeaders
      },
      timeout: requestOptions.timeout ?? 15000
    })
    .then(response => {
      // 💾 SAVE TO CACHE
      cache.set(url, {
        data: response.data,
        time: Date.now()
      });

      pending.delete(url);
      return response.data;
    })
    .catch(error => {
      pending.delete(url);
      console.error(error);
      return '';
    });

    pending.set(url, request);

    return request;
  }

  /* ========================= */

  async fetchJson(url) {

    try {
      const response = await client.get(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Referer": this.baseUrl
        },
        timeout: 15000
      });

      return response.data;

    } catch (error) {
      console.error("fetchJson error", error);
      return null;
    }
  }

  cleanUrl(url) {
    if (!url) return url;

    return url
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&');
  }

  page(skip) {
    if (skip) {
      const page = Math.ceil((skip || 0) / this.limit);
      if (page === 0) return '';
      return `${page}`;
    }
    return '';
  }

  handleSearch({ extra: { search: keyword } }) {
    return `/search/${keyword}/`;
  }

  handleGenre({ extra: { genre } }) {
    return '?genre=' + genre;
  }

  handlePagination(url, { extra: { skip } }) {
    return `?skip=${skip}`;
  }

  getCatalogMetas() {
    return [];
  }

  getAnalyticEvent(event, id) {
    if (id) return `${event}-${id}`;
    return `${event}-${this.getName()}`;
  }

  async handleCatalog(args) {
    if (args.type === Provider.TYPE && this.activate(args.id)) {

      logger.info({ args }, 'handleCatalog');

      let url = this.getInitialUrl(args.id);

      if (args.extra) {

        if (args.extra.search) {
          url = this.handleSearch(args);
        }

        if (args.extra.genre) {
  url = this.handleGenre(args);
}

      }

      if (args.extra.skip) {
        const paginated = this.handlePagination(url, args);

        if (paginated.startsWith('http')) {
          url = paginated;
        } else {
          url += paginated;
        }
      }

      if (url.match(/https?:\/\/.*https?:\/\//)) {
        logger.error("❌ Broken URL detected:", url);
        return { metas: [] };
      }

      const html = await this.fetchHtml(url).catch(() => '');
      const metas = this.getCatalogMetas.length >= 2
  ? this.getCatalogMetas(html, url)   // only Spankbang uses this
  : this.getCatalogMetas(html);       // all others unchanged

      logger.debug({ metasSize: metas.length }, 'catalog');

      return { metas };
    }

    return { metas: [] };
  }

  async handleMeta(args) {

    if (args.type === Provider.TYPE && this.activate(args.id)) {
      const meta = await this.getMetadata(args);
      return { meta };
    }

    return { meta: {} };
  }

  async getMetadata(args) {

    logger.info({ args }, 'getMetadata');

    const { id } = args;

    const result = await this.fetchHtml(id)
      .then(html => this.parseVideoPage({ id, html }));

    if (result && result.metaResponse) {
      return result.metaResponse;
    }

    return result;
  }

  async handleStream(args) {

    const { id } = args;

    if (args.type === Provider.TYPE && this.activate(id)) {

      logger.info({ args }, 'handleStream');

      return this.processStreams(args);
    }

    return { streams: [] };
  }

  async processStreams({ id }) {

    const html = await this.fetchHtml(id);

    const hls = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
    if (hls) {
      return this.getStreams({ videoPageUrl: this.cleanUrl(hls[0]) });
    }

    const dash = html.match(/https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*/i);
    if (dash) {
      return {
        streams: [{
          type: 'movie',
          url: this.cleanUrl(dash[0]),
          name: 'DASH'
        }]
      };
    } 

    const meta = await this.parseVideoPage({ id, html });

if (!meta) {
  return { streams: [] };
}

// 🔥 USE CUSTOM STREAMS IF AVAILABLE
if (meta.streams && meta.streams.length) {
  return { streams: meta.streams };
}

    if (meta.videoPageUrl && meta.videoPageUrl.includes('/embed/')) {

      const embedHtml = await this.fetchHtml(meta.videoPageUrl);

      const m3u8 = embedHtml.match(/(?:https?:)?\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);

      if (m3u8) {

        let url = m3u8[0];

        if (url.startsWith("//")) {
          url = "https:" + url;
        }

        meta.videoPageUrl = this.cleanUrl(url);
      }
    }

    const result = await this.getStreams(meta);

    if (result.streams && result.streams.length) {
      return result;
    }

    const mp4Matches =
      html.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/gi) || [];

    const mp4 = mp4Matches
      .map(candidate => this.cleanUrl(candidate))
      .find(candidate =>
        isLikelyFullVideoMp4(candidate, { allowKnownVideoPath: true })
      );

    if (mp4) {
      const resolution = extractResolution(mp4);

      return {
        streams: [{
          type: 'movie',
          url: mp4,
          name: resolution ? `${resolution} MP4` : 'MP4',
          behaviorHints: {
            notWebReady: false
          }
        }]
      };
    }

    return { streams: [] };
  }

  getStreams(meta) {

    if (!meta.videoPageUrl) {
      return Promise.resolve({ streams: [] });
    }

    if (/\.mp4(\?|$)/i.test(meta.videoPageUrl)) {
      return Promise.resolve({
        streams: [{
          type: 'movie',
          url: meta.videoPageUrl,
          name: 'MP4'
        }]
      });
    }

    return this.fetchHtml(meta.videoPageUrl)

      .then(content => {

        if (content.includes("#EXTM3U")) {
          return this.parseM3u8(content);
        }

        return [];

      })

      .then(streams =>
        streams.map(stream =>
          this.transformStream(meta.videoPageUrl, stream)
        )
      )

      .then(streams => ({ streams }));
  }

  transformStream(baseUrl, stream) {

    if (!stream.url) return stream;

    try {
      return {
        ...stream,
        url: new URL(stream.url, baseUrl).toString()
      };
    } catch (error) {
      logger.warn(
        { baseUrl, streamUrl: stream.url, error: error.message },
        'Unable to resolve stream URL'
      );
      return stream;
    }
  }

  parseM3u8(content) {

    const streams = [];

    const parser = new m3u8.Parser();

    parser.push(content);
    parser.end();

    try {

      parser.manifest.playlists.forEach(playlist => {

        const height =
          playlist.attributes?.RESOLUTION?.height || 'auto';

        streams.push({
          resolution: height + 'p',
          url: playlist.uri
        });

      });

      streams.sort(
        (a, b) =>
          parseInt(b.resolution) -
          parseInt(a.resolution)
      );

      logger.debug({ streams }, 'streams', streams.length);

      return streams.map(stream => ({
        type: 'movie',
        url: stream.url,
        name: stream.resolution,
        behaviorHints: {
          notWebReady: true
        }
      }));

    } catch (e) {

      console.error('parseM3u8 error', e);

      return streams;
    }
  }

  parseVideoPage() {
    return {};
  }

  track() {}

}

module.exports = Provider;