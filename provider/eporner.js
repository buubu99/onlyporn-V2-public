require('dotenv').config();
const { load } = require('cheerio');
const logger = require('../logger');
const mediaRelay = require('../media-relay');
const { meta } = require('../model');
const Provider = require('./provider');
const {
  extractResolution,
  isHls,
  normalizeAbsoluteUrl,
  selectDirectMp4Candidates,
} = require('./media-utils');

const {
  buildEpornerGenreUrl,
  toSearchSlug,
} = require('./eporner-routing');
const { firstString } = require('./structured-data');

const PLAYBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function codecPenalty(...values) {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  if (/\b(?:av1|av01|hevc|h265|h\.265|vp9|vp09)\b/.test(text)) return 1000;
  if (/\b(?:h264|h\.264|avc|avc1)\b/.test(text)) return 0;
  return 100;
}

function firstJsonLdObject($) {
  let result = null;
  $('script[type="application/ld+json"]').each((_, element) => {
    if (result) return;
    try {
      const parsed = JSON.parse($(element).text());
      result = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      // Continue to the next JSON-LD block.
    }
  });
  return result;
}

class EpornerProvider extends Provider {
  constructor() {
    super('https://www.eporner.com', 'eporner', 60);
  }

  static create() {
    return new EpornerProvider();
  }

  getInitialUrl() {
    return this.baseUrl;
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/search/${toSearchSlug(keyword)}/`;
  }

  handleGenre({ extra: { genre } }) {
    return buildEpornerGenreUrl(this.baseUrl, genre);
  }

  handlePagination(url, { extra: { skip } }) {
    const page = this.page(skip);
    if (page === '1') return url;
    return `${url.replace(/\/$/, '')}/${page}/`;
  }

  getCatalogMetas(html) {
    const metadataList = [];
    const $ = load(html);
    const seen = new Set();

    $('div.mb').each((_, element) => {
      const $e = $(element).children('.mbimg').first();
      const $a = $e.children('.mbcontent').children().first();
      const $img = $a.children('img').first();
      const href = $a.attr('href');
      if (!href) return;

      const videoPageUrl = new URL(href, this.baseUrl).toString();
      if (seen.has(videoPageUrl)) return;
      seen.add(videoPageUrl);

      const poster = normalizeAbsoluteUrl(
        $img.attr('data-src') || $img.attr('src'),
        this.baseUrl
      );
      const title = $img.attr('alt') || $a.attr('title') || 'Video';

      metadataList.push(
        new meta.MetaPreview(videoPageUrl, Provider.TYPE, title, poster, {
          videoPageUrl,
          posterShape: 'landscape',
        })
      );
    });

    return metadataList;
  }

  async getMetadata(args) {
    const html = await this.fetchHtml(args.id);
    return this.parseVideoPage({ id: args.id, html });
  }

  parseVideoPage({ id, html }) {
    const hash = html.match(/EP\.video\.player\.hash\s*=\s*['"]([^'"]+)['"]\s*;/)?.[1];
    const videoId = html.match(/EP\.video\.player\.vid\s*=\s*['"]([^'"]+)['"]\s*;/)?.[1];
    const $ = load(html);
    const jsonLd = firstJsonLdObject($);
    const metaMap = {};

    $('meta').each((_, element) => {
      const name = element.attribs?.name || element.attribs?.property;
      if (name) metaMap[name] = element.attribs?.content;
    });

    const title = metaMap['og:title'] || jsonLd?.name || 'Eporner video';
    const poster = normalizeAbsoluteUrl(
      metaMap['og:image'] || firstString(jsonLd?.thumbnailUrl) || firstString(jsonLd?.image),
      this.baseUrl
    );

    return new meta.MetaResponse(id, Provider.TYPE, title, {
      description: metaMap['og:description'] || jsonLd?.description || title,
      poster,
      background: poster,
      posterShape: 'landscape',
      genres: [],
      links: [],
      extra: { hash, videoId },
    });
  }

  hash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{32,}$/i.test(value)) return null;
    return (
      Number.parseInt(value.substring(0, 8), 16).toString(36) +
      Number.parseInt(value.substring(8, 16), 16).toString(36) +
      Number.parseInt(value.substring(16, 24), 16).toString(36) +
      Number.parseInt(value.substring(24, 32), 16).toString(36)
    );
  }

  videoIdFromUrl(id) {
    try {
      const match = new URL(id).pathname.match(/\/video-([^/]+)/i);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  async processStreams({ id }) {
    try {
      const html = await this.fetchHtml(id);
      const metadata = this.parseVideoPage({ id, html });
      return await this.getStreams(metadata);
    } catch (error) {
      logger.warn({ error: error.message }, 'Eporner stream extraction failed');
      return { streams: [] };
    }
  }

  async getStreams(metadata) {
    const hash = this.hash(metadata.extra?.hash);
    const videoId = metadata.extra?.videoId || this.videoIdFromUrl(metadata.id);
    if (!hash || !videoId) return { streams: [] };

    const url = `${this.baseUrl}/xhr/video/${encodeURIComponent(videoId)}?hash=${encodeURIComponent(hash)}&domain=www.eporner.com&pixelRatio=2&playerWidth=0&playerHeight=0&fallback=false&embed=false&supportedFormats=hls,dash,h265,vp9,av1,mp4`;

    try {
      const data = await this.fetchJson(url, {
        cache: false,
        headers: {
          Referer: metadata.id,
          Origin: this.baseUrl,
        },
      });
      return await this.selectSources(data?.sources || {}, metadata.id);
    } catch (error) {
      logger.warn({ error: error.message }, 'Eporner source request failed');
      return { streams: [] };
    }
  }

  async playbackHeaders(videoPageUrl, mediaUrl = videoPageUrl) {
    const headers = {
      Referer: videoPageUrl || `${this.baseUrl}/`,
      Origin: this.baseUrl,
      'User-Agent': PLAYBACK_USER_AGENT,
    };

    if (typeof this.jar?.getCookieString === 'function') {
      try {
        const cookie = await this.jar.getCookieString(mediaUrl || this.baseUrl);
        if (cookie) headers.Cookie = cookie;
      } catch {
        // Cookie forwarding is a best-effort compatibility enhancement.
      }
    }

    return headers;
  }

  async relaySource(url, videoPageUrl, kind) {
    return mediaRelay.register({
      url,
      headers: await this.playbackHeaders(videoPageUrl, url),
      provider: this.name,
      kind,
    });
  }

  async selectSources(sources, videoPageUrl = `${this.baseUrl}/`) {
    const mp4Candidates = Object.entries(sources?.mp4 || {}).map(
      ([label, value], index) => ({
        url: value?.src,
        label: value?.labelShort || value?.label || label,
        context: [label, value?.codec, value?.type, value?.format].filter(Boolean).join(' '),
        priority: codecPenalty(label, value?.codec, value?.type, value?.format) + index,
      })
    );

    const direct = selectDirectMp4Candidates(mp4Candidates, {
      baseUrl: this.baseUrl,
      allowKnownVideoPath: true,
    });

    if (direct.length) {
      return {
        streams: await Promise.all(
          direct.map(async candidate => ({
            url: await this.relaySource(candidate.url, videoPageUrl, 'mp4'),
            name: `${candidate.resolution || extractResolution(candidate.label) || 'MP4'} MP4`.replace('MP4 MP4', 'MP4'),
            type: Provider.TYPE,
            behaviorHints: { notWebReady: false },
          }))
        ),
      };
    }

    const hlsCandidates = [
      sources?.hls?.auto?.src,
      sources?.hls?.src,
      typeof sources?.hls === 'string' ? sources.hls : null,
    ]
      .map(value => normalizeAbsoluteUrl(value, this.baseUrl))
      .filter(value => value && isHls(value));

    if (!hlsCandidates.length) return { streams: [] };

    const masterUrl = hlsCandidates[0];
    const playbackHeaders = await this.playbackHeaders(videoPageUrl, masterUrl);
    try {
      const content = await this.fetchMediaText(masterUrl, {
        cache: false,
        headers: playbackHeaders,
      });
      if (!content.includes('#EXTM3U')) return { streams: [] };

      const variants = await Promise.all(
        this.parseM3u8(content).map(async stream => {
          const transformed = this.transformStream(masterUrl, stream);
          return {
            ...transformed,
            url: await this.relaySource(transformed.url, videoPageUrl, 'hls'),
            behaviorHints: { notWebReady: false },
          };
        })
      );
      return {
        streams: variants.length
          ? variants
          : [{
              type: Provider.TYPE,
              url: await this.relaySource(masterUrl, videoPageUrl, 'hls'),
              name: 'HLS',
              behaviorHints: { notWebReady: false },
            }],
      };
    } catch (error) {
      logger.warn({ error: error.message }, 'Eporner HLS request failed');
      return { streams: [] };
    }
  }
}

module.exports = EpornerProvider.create;
