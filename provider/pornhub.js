'use strict';

const { load } = require('cheerio');
const logger = require('../logger');
const mediaRelay = require('../media-relay');
const { meta } = require('../model');
const Provider = require('./provider');
const pornhubChrome = require('./pornhub-safari-impersonation');
const {
  cleanMediaUrl,
  extractResolution,
  isDirectMp4,
  isHls,
  normalizeAbsoluteUrl,
} = require('./media-utils');
const {
  findVideoObject,
  firstString,
  parseStructuredDataBlocks,
} = require('./structured-data');
const { assertSafeHttpsUrl, sanitizeUrlForLogs } = require('./url-security');

const PLAYBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const CATALOG_URL = 'https://www.pornhub.com/video';
const PAGE_HOSTS = Object.freeze([
  'pornhub.com',
  'www.pornhub.com',
  'pornhub.org',
  'www.pornhub.org',
]);
const MEDIA_DEFINITIONS_KEY = '"mediaDefinitions"';
const VIEWKEY_RE = /(?:^|[?&])viewkey=([A-Za-z0-9]+)/i;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function canonicalVideoUrl(value, baseUrl = 'https://www.pornhub.com') {
  try {
    const parsed = new URL(value, baseUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!PAGE_HOSTS.includes(hostname)) return '';

    const viewkey = parsed.searchParams.get('viewkey') || parsed.href.match(VIEWKEY_RE)?.[1];
    if (!viewkey || !/^[A-Za-z0-9]+$/.test(viewkey)) return '';

    return `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`;
  } catch {
    return '';
  }
}

function normalizePoster(value, baseUrl = 'https://www.pornhub.com') {
  const firstValue = String(value || '').split(',')[0].trim().split(/\s+/)[0];
  const url = normalizeAbsoluteUrl(firstValue, baseUrl);
  if (!url || /^data:/i.test(url)) return '';
  if (/placeholder|blank\.(?:gif|png)|loading/i.test(url)) return '';
  return url;
}

function extractJsonArrayAfterKey(source, key = MEDIA_DEFINITIONS_KEY) {
  const text = String(source || '');
  const keyIndex = text.indexOf(key);
  if (keyIndex < 0) return [];

  const arrayStart = text.indexOf('[', keyIndex + key.length);
  if (arrayStart < 0) return [];

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(arrayStart, index + 1));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }

  return [];
}

function normalizeQuality(...values) {
  const resolution = extractResolution(...values);
  if (resolution) return resolution;

  for (const value of values) {
    const numeric = Number.parseInt(String(value || ''), 10);
    if (Number.isFinite(numeric) && numeric >= 100 && numeric <= 4320) {
      return `${numeric}p`;
    }
  }

  return null;
}

function normalizeDefinition(item, baseUrl) {
  if (!item || typeof item !== 'object') return null;

  const rawUrl = item.videoUrl || item.video_url || item.url || item.src || item.file;
  const url = normalizeAbsoluteUrl(cleanMediaUrl(rawUrl), baseUrl);
  if (!url) return null;

  const format = String(item.format || item.type || '').toLowerCase();
  const quality = normalizeQuality(item.quality, item.height, item.label, item.defaultQuality, url);
  const api = /\/video\/get_media(?:[?#]|$)/i.test(url);
  let kind = '';

  if (api) kind = 'api';
  else if (format.includes('hls') || isHls(url)) kind = 'hls';
  else if (format.includes('mp4') || isDirectMp4(url)) kind = 'mp4';

  if (!kind) return null;
  return { url, quality, kind, raw: item };
}

function collectMediaDefinitions(value, baseUrl, output = [], seen = new Set()) {
  if (!value) return output;

  if (Array.isArray(value)) {
    for (const item of value) collectMediaDefinitions(item, baseUrl, output, seen);
    return output;
  }

  if (typeof value !== 'object') return output;

  const normalized = normalizeDefinition(value, baseUrl);
  if (normalized && !seen.has(normalized.url)) {
    seen.add(normalized.url);
    output.push(normalized);
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      ['mediaDefinitions', 'media', 'data', 'sources', 'formats', 'result'].includes(key) ||
      Array.isArray(child)
    ) {
      collectMediaDefinitions(child, baseUrl, output, seen);
    }
  }

  return output;
}

function structuredDataFromPage($) {
  return parseStructuredDataBlocks(
    $('script[type="application/ld+json"]')
      .toArray()
      .map(element => $(element).text())
  );
}

function sortStreams(streams) {
  return [...streams].sort((left, right) => {
    const leftResolution = Number.parseInt(left.quality, 10) || 0;
    const rightResolution = Number.parseInt(right.quality, 10) || 0;
    if (rightResolution !== leftResolution) return rightResolution - leftResolution;

    const leftHls = /HLS$/i.test(left.name) ? 0 : 1;
    const rightHls = /HLS$/i.test(right.name) ? 0 : 1;
    return leftHls - rightHls || left.name.localeCompare(right.name);
  });
}

class PornhubProvider extends Provider {
  constructor() {
    super('https://www.pornhub.com', 'pornhub', 40, {
      // The public .com pages can redirect to their exact .org equivalents.
      // Keep this list explicit: unrelated hosts and wildcard subdomains stay blocked.
      allowedPageHosts: PAGE_HOSTS,
      htmlCacheTtlMs: 5_000,
      jsonCacheTtlMs: 5_000,
    });
  }

  static create() {
    return new PornhubProvider();
  }

  getInitialUrl() {
    return CATALOG_URL;
  }

  handleSearch({ extra: { search: keyword } }) {
    const url = new URL(`${this.baseUrl}/video/search`);
    url.searchParams.set('search', String(keyword || '').trim());
    return url.toString();
  }

  handleGenre({ extra: { genre } }) {
    return this.handleSearch({ extra: { search: genre } });
  }

  handlePagination(url, { extra: { skip } }) {
    const page = Math.floor(Number(skip || 0) / this.limit) + 1;
    if (page <= 1) return url;

    const parsed = new URL(url);
    parsed.searchParams.set('page', String(page));
    return parsed.toString();
  }

  async fetchPornhubText(url, options = {}) {
    const safeUrl = await assertSafeHttpsUrl(url, {
      allowedHosts: this.allowedPageHosts,
    });

    try {
      const response = await pornhubChrome.fetchText(safeUrl, {
        timeoutMs: options.timeoutMs || 30_000,
        maxBytes: options.maxBytes || 9 * 1024 * 1024,
        method: options.method || 'GET',
        data: options.data,
        headers: options.headers || {},
      });

      logger.debug(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(response.finalUrl || safeUrl),
          status: response.status,
          cfRay: response.headers?.['cf-ray'],
        },
        'Pornhub Chrome request succeeded'
      );
      return response.data;
    } catch (error) {
      logger.warn(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(safeUrl),
          error: error.message,
        },
        'Pornhub Chrome request failed'
      );
      throw error;
    }
  }

  async fetchPornhubJson(url, options = {}) {
    const safeUrl = await assertSafeHttpsUrl(url, {
      allowedHosts: this.allowedPageHosts,
    });
    const response = await pornhubChrome.fetchJson(safeUrl, {
      timeoutMs: options.timeoutMs || 30_000,
      maxBytes: options.maxBytes || 4 * 1024 * 1024,
      method: options.method || 'GET',
      data: options.data,
      headers: options.headers || {},
    });
    return response.data;
  }

  async fetchHtml(url) {
    return this.fetchPornhubText(url);
  }

  getCatalogMetas(html, currentUrl = CATALOG_URL) {
    const $ = load(html);
    const metadataList = [];
    const seen = new Set();

    $('a[href*="view_video.php"][href*="viewkey="]').each((_, element) => {
      const anchor = $(element);
      const videoPageUrl = canonicalVideoUrl(anchor.attr('href'), this.baseUrl);
      if (!videoPageUrl || seen.has(videoPageUrl)) return;

      let container = anchor.closest(
        'li, article, .pcVideoListItem, .videoBox, .video-item, .videoUList, .phimage'
      );
      if (!container.length) container = anchor.parent();
      const image = anchor.find('img').first().length
        ? anchor.find('img').first()
        : container.find('img').first();

      const posterCandidates = [
        image.attr('data-mediumthumb'),
        image.attr('data-thumb_url'),
        image.attr('data-thumb'),
        image.attr('data-src'),
        image.attr('data-original'),
        image.attr('data-image'),
        image.attr('data-srcset'),
        image.attr('srcset'),
        image.attr('src'),
      ];
      const poster = posterCandidates
        .map(value => normalizePoster(value, currentUrl))
        .find(Boolean);

      const title = cleanText(
        anchor.attr('title') ||
        anchor.attr('data-title') ||
        image.attr('alt') ||
        image.attr('title') ||
        container.find('.title, .videoTitle, .titleVideo, .video-title').first().text() ||
        anchor.text()
      );

      if (!title || !poster) return;
      seen.add(videoPageUrl);
      metadataList.push(
        new meta.MetaPreview(videoPageUrl, Provider.TYPE, title, poster, {
          videoPageUrl,
          posterShape: 'landscape',
        })
      );
    });

    logger.debug({ provider: this.name, count: metadataList.length }, 'Pornhub catalog items parsed');
    return metadataList;
  }

  mediaDefinitionsFromPage(html, pageUrl) {
    return collectMediaDefinitions(extractJsonArrayAfterKey(html), pageUrl);
  }

  metadataFromPage(id, html) {
    const $ = load(html);
    const structured = structuredDataFromPage($);
    const videoObject = findVideoObject(structured);
    const canonical = canonicalVideoUrl(
      $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || id,
      this.baseUrl
    ) || id;
    const title = cleanText(
      $('meta[property="og:title"]').attr('content') ||
      videoObject?.name ||
      $('title').text() ||
      'Pornhub video'
    ).replace(/\s*[-|]\s*Pornhub\s*$/i, '');
    const poster = normalizePoster(
      $('meta[property="og:image"]').attr('content') ||
      firstString(videoObject?.thumbnailUrl) ||
      firstString(videoObject?.image),
      this.baseUrl
    );
    const description = cleanText(
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      videoObject?.description ||
      title
    );
    const keywords = cleanText($('meta[name="keywords"]').attr('content'));

    return new meta.MetaResponse(canonical, Provider.TYPE, title, {
      poster,
      background: poster,
      description,
      posterShape: 'landscape',
      genres: keywords ? keywords.split(',').map(cleanText).filter(Boolean) : [],
      videoPageUrl: canonical,
    });
  }

  async getMetadata({ id }) {
    const html = await this.fetchPornhubText(id, {
      headers: { Referer: CATALOG_URL },
    });
    return this.metadataFromPage(id, html);
  }

  playbackHeaders(videoPageUrl) {
    return {
      Referer: videoPageUrl,
      Origin: this.baseUrl,
      'User-Agent': PLAYBACK_USER_AGENT,
      Accept: '*/*',
    };
  }

  async expandRemoteMedia(definitions, videoPageUrl) {
    const expanded = definitions.filter(item => item.kind !== 'api');
    const seen = new Set(expanded.map(item => item.url));

    for (const definition of definitions.filter(item => item.kind === 'api')) {
      try {
        const data = await this.fetchPornhubJson(definition.url, {
          headers: {
            Referer: videoPageUrl,
            Origin: this.baseUrl,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/plain, */*',
          },
        });

        for (const candidate of collectMediaDefinitions(data, videoPageUrl)) {
          if (candidate.kind === 'api' || seen.has(candidate.url)) continue;
          seen.add(candidate.url);
          expanded.push(candidate);
        }
      } catch (error) {
        logger.debug(
          { provider: this.name, error: error.message },
          'Pornhub MP4 media API returned no usable sources'
        );
      }
    }

    return expanded;
  }

  streamFromDefinition(definition, videoPageUrl) {
    if (!['hls', 'mp4'].includes(definition.kind)) return null;

    const quality = definition.quality || normalizeQuality(definition.url) ||
      (definition.kind === 'hls' ? 'HLS' : 'MP4');
    const format = definition.kind.toUpperCase();

    try {
      return {
        type: Provider.TYPE,
        url: mediaRelay.register({
          url: definition.url,
          headers: this.playbackHeaders(videoPageUrl),
          provider: this.name,
          kind: definition.kind,
        }),
        name: `Pornhub ${quality} ${format}`.replace(`${format} ${format}`, format),
        quality,
        behaviorHints: { notWebReady: false },
      };
    } catch (error) {
      logger.debug(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(definition.url),
          error: error.message,
        },
        'Pornhub media candidate rejected by protected relay'
      );
      return null;
    }
  }

  async processStreams({ id }) {
    try {
      // Always fetch a fresh page for temporary signed CDN URLs.
      const html = await this.fetchPornhubText(id, {
        headers: { Referer: CATALOG_URL },
      });
      const definitions = this.mediaDefinitionsFromPage(html, id);
      const expanded = await this.expandRemoteMedia(definitions, id);
      const seen = new Set();
      const streams = [];

      for (const definition of expanded) {
        if (seen.has(definition.url)) continue;
        seen.add(definition.url);
        const stream = this.streamFromDefinition(definition, id);
        if (stream) streams.push(stream);
      }

      logger.debug(
        {
          provider: this.name,
          mediaDefinitions: definitions.length,
          streams: streams.length,
        },
        'Pornhub media discovery completed'
      );
      return { streams: sortStreams(streams) };
    } catch (error) {
      logger.warn({ provider: this.name, error: error.message }, 'Pornhub stream extraction failed');
      return { streams: [] };
    }
  }
}

const create = PornhubProvider.create;
create._test = {
  canonicalVideoUrl,
  cleanText,
  collectMediaDefinitions,
  extractJsonArrayAfterKey,
  normalizeDefinition,
  normalizePoster,
  normalizeQuality,
  sortStreams,
  structuredDataFromPage,
};

module.exports = create;
