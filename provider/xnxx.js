const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');
const BoundedTtlCache = require('./cache');
const {
  extractResolution,
  isHls,
  normalizeAbsoluteUrl,
  selectDirectMp4Candidates,
} = require('./media-utils');
const {
  collectStructuredMediaUrls,
  findVideoObject,
  firstString,
  parseStructuredDataBlocks,
} = require('./structured-data');
const { resolveTemplateFrame, stableFrame } = require('./poster-utils');

const DEFAULT_POSTER = 'https://thumb-cdn77.xnxx-cdn.com/default.jpg';
const HTML_TTL = 1000 * 60 * 5;
const META_TTL = 1000 * 60 * 5;
const htmlCache = new BoundedTtlCache({ maxEntries: 300, ttlMs: HTML_TTL });
const metaCache = new BoundedTtlCache({ maxEntries: 300, ttlMs: META_TTL });
const inFlight = new Map();

const REGEX = {
  videoHLS: /html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/,
  videoHigh: /html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/,
  videoLow: /html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/,
  thumb169: /html5player\.setThumbUrl169\(['"]([^'"]+)['"]\)/,
};

function cleanTitle(title = '') {
  return title.replace(/^xnxx\s*/i, '').trim();
}

function resolveThumbNum(url, seed) {
  return resolveTemplateFrame(url, seed);
}

function upgradeThumbQuality(url) {
  if (!url) return url;
  return url
    .replace(/\/thumbs169xnxx\//g, '/thumbs169ll/')
    .replace(/\/thumbs169\//g, '/thumbs169ll/')
    .replace(/\/thumbs\//g, '/thumbs169ll/');
}

function normalizePoster(value, baseUrl, seed) {
  let url = normalizeAbsoluteUrl(value, baseUrl);
  if (!url) return DEFAULT_POSTER;
  url = resolveThumbNum(url, seed);
  url = upgradeThumbQuality(url);
  return url || DEFAULT_POSTER;
}

function structuredDataFromPage($) {
  return parseStructuredDataBlocks(
    $('script[type="application/ld+json"]')
      .toArray()
      .map(element => $(element).text())
  );
}

function sourceLabel(candidate) {
  if (candidate.resolution) return `${candidate.resolution} MP4`;
  return `${candidate.label || 'Direct'} MP4`;
}

class XnxxProvider extends Provider {
  constructor() {
    super('https://www.xnxx.com', 'xnxx', 48);
  }

  static create() {
    return new XnxxProvider();
  }

  async fetchHtml(url) {
    const cached = htmlCache.get(url);
    if (cached !== undefined) return cached;
    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
      const html = await super.fetchHtml(url, { cache: false });
      if (/cf-chl|just a moment|captcha|access denied/i.test(html)) {
        throw new Error('XNXX returned a challenge page');
      }
      htmlCache.set(url, html);
      return html;
    })();

    inFlight.set(url, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(url);
    }
  }

  getInitialUrl() {
    return `${this.baseUrl}/todays-selection`;
  }

  handleSearch({ extra: { search } }) {
    const formatted = encodeURIComponent(search).replace(/%20/g, '+');
    return `${this.baseUrl}/search/${formatted}/`;
  }

  handleGenre(args) {
    if (args.extra.genre === 'hits') return `${this.baseUrl}/hits`;
    return this.handleSearch({ ...args, extra: { search: args.extra.genre } });
  }

  handlePagination(url, { extra: { skip, search } }) {
    const page = Math.floor(Number(skip || 0) / this.limit);

    if (search) {
      const formatted = encodeURIComponent(search).replace(/%20/g, '+');
      return page === 0
        ? `${this.baseUrl}/search/${formatted}/`
        : `${this.baseUrl}/search/${formatted}/${page}`;
    }

    if (url.includes('/hits')) {
      return page === 0 ? `${this.baseUrl}/hits` : `${this.baseUrl}/hits/${page}`;
    }

    return page === 0
      ? `${this.baseUrl}/todays-selection`
      : `${this.baseUrl}/todays-selection/${page}`;
  }

  getCatalogMetas(html) {
    const $ = load(html);
    const metadatas = [];
    const seen = new Set();

    $('div.thumb-block a').each((_, element) => {
      const href = $(element).attr('href');
      if (!href || !href.startsWith('/video')) return;

      const id = new URL(href, this.baseUrl).toString().split('?')[0].replace(/\/$/, '');
      if (seen.has(id)) return;
      seen.add(id);

      const parent = $(element).closest('.thumb-block');
      const image = parent.find('img').first();
      let thumb =
        image.attr('data-src') ||
        image.attr('data-lazy-src') ||
        image.attr('data-original') ||
        image.attr('data-preview') ||
        image.attr('data-thumb') ||
        image.attr('src');

      if (!thumb) {
        const srcset = image.attr('data-srcset') || image.attr('srcset');
        if (srcset) thumb = srcset.split(',')[0].trim().split(/\s+/)[0];
      }
      if (!thumb) thumb = parent.attr('data-src') || parent.attr('data-lazy-src');
      if (!thumb) {
        const style = $(element).attr('style') || parent.attr('style');
        thumb = style?.match(/url\(["']?(.*?)["']?\)/)?.[1];
      }
      if (!thumb) {
        thumb = parent.html()?.match(/https?:\/\/[^"']+_t\.jpg/)?.[0];
      }
      if (thumb?.includes('lightbox-blank')) thumb = null;

      const titleAnchor = parent.find('.thumb-under p > a').first();
      const title = (
        titleAnchor.text().trim() ||
        titleAnchor.attr('title') ||
        image.attr('alt') ||
        $(element).attr('title') ||
        'Video'
      )
        .replace(/\s+/g, ' ')
        .trim();

      metadatas.push(
        new meta.MetaPreview(
          id,
          Provider.TYPE,
          cleanTitle(title),
          normalizePoster(thumb, this.baseUrl, id),
          { posterShape: 'landscape' }
        )
      );
    });

    return metadatas;
  }

  async getMetadata(args) {
    const cached = metaCache.get(args.id);
    if (cached !== undefined) return cached.metaResponse;

    const html = await this.fetchHtml(args.id);
    const parsed = this.parseVideoPage({ id: args.id, html });
    if (parsed?.metaResponse) metaCache.set(args.id, parsed);
    return parsed.metaResponse;
  }

  parseVideoPage({ id, html }) {
    const $ = load(html);
    const structured = structuredDataFromPage($);
    const videoObject = findVideoObject(structured);
    const structuredMedia = collectStructuredMediaUrls(structured);
    const high = html.match(REGEX.videoHigh)?.[1];
    const low = html.match(REGEX.videoLow)?.[1];
    const hls = html.match(REGEX.videoHLS)?.[1];

    const directCandidates = selectDirectMp4Candidates(
      [
        { url: high, label: 'High', context: 'player high', priority: 0 },
        ...structuredMedia.map((candidate, index) => ({
          ...candidate,
          label: 'JSON-LD',
          priority: 10 + index,
        })),
        { url: low, label: 'Low', context: 'player low', priority: 50 },
      ],
      { baseUrl: id, allowKnownVideoPath: true }
    );

    const directMp4Streams = directCandidates.map(candidate => ({
      type: Provider.TYPE,
      url: candidate.url,
      name: `XNXX ${sourceLabel(candidate)}`,
      behaviorHints: { notWebReady: false },
    }));

    const hlsCandidates = [hls, ...structuredMedia.map(candidate => candidate.url)]
      .map(value => normalizeAbsoluteUrl(value, id))
      .filter(value => value && isHls(value));
    const videoPageUrl = hlsCandidates[0] || null;

    const hasPlayer = directMp4Streams.length || videoPageUrl || html.includes('html5player');
    if (!hasPlayer) {
      return {
        metaResponse: new meta.MetaResponse(id, Provider.TYPE, 'Unavailable Video', {
          links: [],
          description: '',
          poster: DEFAULT_POSTER,
          background: DEFAULT_POSTER,
          posterShape: 'landscape',
          genres: [],
        }),
        videoPageUrl: null,
        directMp4Streams: [],
      };
    }

    const links = [];
    $('a[href*="/search/"]').each((_, element) => {
      const tag = $(element);
      const href = tag.attr('href');
      if (!href) return;
      links.push(
        new meta.MetaLink(tag.text().trim(), 'Genre', new URL(href, this.baseUrl).toString())
      );
    });

    const title = $('meta[property="og:title"]').attr('content') || videoObject?.name;
    const description =
      $('meta[name="description"]').attr('content') || videoObject?.description || title;
    const ogImage = $('meta[property="og:image"]').attr('content');
    const keywords = $('meta[name="keywords"]').attr('content');
    const thumb = html.match(REGEX.thumb169)?.[1];
    const videoPoster = $('video').attr('poster');
    const poster = normalizePoster(
      thumb || ogImage || videoPoster || firstString(videoObject?.thumbnailUrl) || firstString(videoObject?.image),
      this.baseUrl,
      id
    );

    return {
      metaResponse: new meta.MetaResponse(id, Provider.TYPE, cleanTitle(title || 'Video'), {
        links,
        description,
        background: poster,
        poster,
        posterShape: 'landscape',
        genres: keywords ? keywords.split(',').map(value => value.trim()).filter(Boolean) : [],
      }),
      videoPageUrl,
      directMp4Streams,
    };
  }

  async processStreams({ id }) {
    let parsed = metaCache.get(id);
    if (parsed === undefined) {
      const html = await this.fetchHtml(id);
      parsed = this.parseVideoPage({ id, html });
      if (parsed?.metaResponse) metaCache.set(id, parsed);
    }

    if (parsed?.directMp4Streams?.length) {
      return { streams: parsed.directMp4Streams };
    }

    if (!parsed?.videoPageUrl) return { streams: [] };
    const response = await super.getStreams({ videoPageUrl: parsed.videoPageUrl });
    response.streams = (response.streams || [])
      .map(stream => {
        const resolution =
          stream.resolution || extractResolution(stream.name, stream.url) || 'unknown';
        return {
          ...stream,
          name: `XNXX ${resolution}`,
          quality: resolution,
        };
      })
      .sort(
        (left, right) =>
          (Number.parseInt(right.quality, 10) || 0) -
          (Number.parseInt(left.quality, 10) || 0)
      );
    return response;
  }
}

const create = XnxxProvider.create;
create._test = {
  cleanTitle,
  normalizePoster,
  resolveThumbNum,
  stableFrame,
  structuredDataFromPage,
};
module.exports = create;
