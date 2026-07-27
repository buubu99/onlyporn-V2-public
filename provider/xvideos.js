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

const DEFAULT_POSTER = 'https://thumb-cdn77.xvideos-cdn.com/default.jpg';
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
  thumb: /html5player\.setThumbUrl\(['"]([^'"]+)['"]\)/,
  thumbCdn: /(https:\/\/thumb-cdn\d+\.xvideos-cdn\.com\/[^'"]+xv_\d+_p\.avif)/,
};

function cleanTitle(title = '') {
  return title
    .replace(/^xvideos\s*video\s*/i, '')
    .replace(/^xvideos\s*/i, '')
    .trim();
}

function normalizePoster(value, baseUrl) {
  const url = normalizeAbsoluteUrl(value, baseUrl);
  if (!url) return DEFAULT_POSTER;
  if (!url.includes('xvideos-cdn.com')) return url;
  if (url.includes('thumb-cdn77')) return url;

  return url
    .replace(/thumbs?-cdn\d+\.xvideos-cdn\.com/, 'thumb-cdn77.xvideos-cdn.com')
    .replace(/thumbs\d*\.xvideos-cdn\.com/, 'thumb-cdn77.xvideos-cdn.com');
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

class XvideosProvider extends Provider {
  constructor() {
    super('https://www.xvideos.com', 'xvideos', 50);
  }

  static create() {
    return new XvideosProvider();
  }

  async fetchHtml(url) {
    const cached = htmlCache.get(url);
    if (cached !== undefined) return cached;
    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
      const html = await super.fetchHtml(url, { cache: false });
      if (/cf-chl|just a moment|captcha|access denied/i.test(html)) {
        throw new Error('XVideos returned a challenge page');
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
    return this.baseUrl;
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/?k=${encodeURIComponent(keyword)}`;
  }

  handleGenre(args) {
    return this.handleSearch({ ...args, extra: { search: args.extra.genre } });
  }

  handlePagination(url, { extra: { skip } }) {
    const page = Math.floor(Number(skip || 0) / this.limit);
    const parsed = new URL(url);

    if (parsed.searchParams.has('k')) {
      parsed.searchParams.set('p', page);
      return parsed.toString();
    }

    return page === 0 ? this.baseUrl : `${this.baseUrl}/new/${page}`;
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

      const parent = $(element).closest('div.thumb-block');
      const image = parent.find('img').first();
      const titleAnchor = parent.find('.thumb-under p > a').first();
      let thumb =
        image.attr('data-thumb_url169') ||
        image.attr('data-thumb_url') ||
        image.attr('data-thumb') ||
        image.attr('data-src') ||
        image.attr('src');

      if (thumb?.includes('THUMBNUM')) {
        const frameSource = [
          image.attr('data-thumb'),
          image.attr('data-src'),
          image.attr('src'),
        ]
          .filter(Boolean)
          .find(value => /xv_(\d+)_t\.jpg/.test(value));
        const frame = frameSource?.match(/xv_(\d+)_t\.jpg/)?.[1] || '15';
        thumb = thumb.replace(/THUMBNUM/g, frame);
      }

      const title =
        $(element).attr('title') ||
        image.attr('alt') ||
        titleAnchor.attr('title') ||
        titleAnchor.text() ||
        'Video';

      metadatas.push(
        new meta.MetaPreview(
          id,
          Provider.TYPE,
          cleanTitle(title),
          normalizePoster(thumb, this.baseUrl),
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
      name: `XVideos ${sourceLabel(candidate)}`,
      behaviorHints: { notWebReady: false },
    }));

    const hlsCandidates = [
      hls,
      ...structuredMedia.map(candidate => candidate.url),
    ]
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
    $('div.video-tags > a').each((_, element) => {
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
    const thumbMatch =
      html.match(REGEX.thumb169) || html.match(REGEX.thumbCdn) || html.match(REGEX.thumb);
    const poster = normalizePoster(
      thumbMatch?.[1] || ogImage || firstString(videoObject?.thumbnailUrl) || firstString(videoObject?.image),
      this.baseUrl
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
          name: `XVideos ${resolution}`,
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

const create = XvideosProvider.create;
create._test = { cleanTitle, normalizePoster, structuredDataFromPage };
module.exports = create;
