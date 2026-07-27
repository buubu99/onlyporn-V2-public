require('dotenv').config();
const { load } = require('cheerio');
const logger = require('../logger');
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
      const data = await this.fetchJson(url, { cache: false });
      return await this.selectSources(data?.sources || {});
    } catch (error) {
      logger.warn({ error: error.message }, 'Eporner source request failed');
      return { streams: [] };
    }
  }

  async selectSources(sources) {
    const mp4Candidates = Object.entries(sources?.mp4 || {}).map(
      ([label, value], priority) => ({
        url: value?.src,
        label: value?.labelShort || value?.label || label,
        context: label,
        priority,
      })
    );

    const direct = selectDirectMp4Candidates(mp4Candidates, {
      baseUrl: this.baseUrl,
      allowKnownVideoPath: true,
    });

    if (direct.length) {
      return {
        streams: direct.map(candidate => ({
          url: candidate.url,
          name: `${candidate.resolution || extractResolution(candidate.label) || 'MP4'} MP4`.replace('MP4 MP4', 'MP4'),
          type: Provider.TYPE,
          behaviorHints: { notWebReady: false },
        })),
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
    return super.getStreams({ videoPageUrl: hlsCandidates[0] });
  }
}

module.exports = EpornerProvider.create;
