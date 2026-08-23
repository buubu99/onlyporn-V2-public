const { load } = require('cheerio');
const logger = require('../logger');
const mediaRelay = require('../media-relay');
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
const PLAYBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const HTML_TTL = 1000 * 60 * 5;
const META_TTL = 1000 * 60 * 15;
const CATALOG_PREFLIGHT_CONCURRENCY = 10;
const CATALOG_PREFLIGHT_TIMEOUT_MS = 4_500;
const htmlCache = new BoundedTtlCache({ maxEntries: 300, ttlMs: HTML_TTL });
const metaCache = new BoundedTtlCache({ maxEntries: 300, ttlMs: META_TTL });
const resolvedPageCache = new BoundedTtlCache({ maxEntries: 300, ttlMs: META_TTL });
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


function xvideosPageCandidates(value, baseUrl = 'https://www.xvideos.com') {
  let parsed;
  try {
    parsed = new URL(value, baseUrl);
  } catch {
    return [];
  }

  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const candidates = [];
  const add = pathname => {
    const candidate = new URL(parsed.toString());
    candidate.pathname = pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    const result = candidate.toString().replace(/\/$/, '');
    if (!candidates.includes(result)) candidates.push(result);
  };

  if (/\/THUMBNUM(?:\/|$)/i.test(parsed.pathname)) {
    // Current catalog HTML can embed a thumbnail template inside the href.
    // Try only repaired candidates; never send the literal template upstream.
    add(parsed.pathname.replace(/\/THUMBNUM(?:\/.*)?$/i, ''));
    add(parsed.pathname.replace(/\/THUMBNUM\//i, '/'));
    add(parsed.pathname.replace(/\/\d+\/THUMBNUM\//i, '/'));
  } else {
    add(parsed.pathname);
  }
  return candidates;
}

function normalizeXvideosPageUrl(value, baseUrl) {
  return xvideosPageCandidates(value, baseUrl)[0] || '';
}

function sourceLabel(candidate) {
  if (candidate.resolution) return `${candidate.resolution} MP4`;
  return `${candidate.label || 'Direct'} MP4`;
}

const { filterCatalogResponse } = require('./search-relevance');
const { evaluateContent, readContentFilterConfig } = require('./content-filter');

class XvideosProvider extends Provider {
  constructor() {
    super('https://www.xvideos.com', 'xvideos', 50);
    this.contentFilter = readContentFilterConfig(process.env);
  }

  static create() {
    return new XvideosProvider();
  }

  async handleCatalog(args) {
    const response = await super.handleCatalog(args);
    const search = String(args?.extra?.search || '').trim();
    return search ? filterCatalogResponse(response, search) : response;
  }

  async postProcessCatalogMetas(metas = []) {
    const candidates = Array.isArray(metas) ? metas : [];
    if (!candidates.length) return [];
    const decisions = new Array(candidates.length);
    let cursor = 0;

    const inspect = async index => {
      const candidate = candidates[index];
      try {
        let parsed = metaCache.get(candidate.id);
        if (parsed === undefined) {
          const html = await this.fetchHtml(candidate.id, {
            timeout: CATALOG_PREFLIGHT_TIMEOUT_MS,
            retries: 0,
          });
          const resolvedId = resolvedPageCache.get(candidate.id)
            || normalizeXvideosPageUrl(candidate.id, this.baseUrl);
          parsed = this.parseVideoPage({ id: resolvedId || candidate.id, html });
          if (parsed?.metaResponse) metaCache.set(candidate.id, parsed);
        }

        const playable = Boolean(parsed?.directMp4Streams?.length || parsed?.videoPageUrl);
        if (!playable) {
          decisions[index] = { keep: false, reason: 'unplayable' };
          return;
        }
        const evaluation = evaluateContent(parsed.metaResponse, this.contentFilter);
        decisions[index] = evaluation.excluded
          ? { keep: false, reason: evaluation.reason }
          : { keep: true, reason: '' };
      } catch (error) {
        // Never publish a card whose detail contract could not be verified.
        // Stremio turns the later {meta:{}} response into "Failed to parse
        // meta", which is worse than omitting the unusable card up front.
        decisions[index] = {
          keep: false,
          reason: 'metadata-unavailable',
          error: error?.message || String(error),
        };
      }
    };

    const worker = async () => {
      while (cursor < candidates.length) {
        const index = cursor;
        cursor += 1;
        await inspect(index);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(CATALOG_PREFLIGHT_CONCURRENCY, candidates.length) },
      worker
    ));

    const reasons = {};
    const kept = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const decision = decisions[index] || { keep: false, reason: 'metadata-unavailable' };
      if (decision.keep) {
        kept.push(candidates[index]);
        continue;
      }
      reasons[decision.reason] = (reasons[decision.reason] || 0) + 1;
    }
    logger.info({
      provider: this.name,
      candidates: candidates.length,
      validated: kept.length,
      removed: candidates.length - kept.length,
      reasons,
    }, 'XVideos catalog metadata preflight completed before publication');
    return kept;
  }

  async fetchHtml(url, requestOptions = {}) {
    const cached = htmlCache.get(url);
    if (cached !== undefined) return cached;
    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
      const candidates = xvideosPageCandidates(url, this.baseUrl);
      let lastError;

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        try {
          const html = await super.fetchHtml(candidate, { cache: false, ...requestOptions });
          if (/cf-chl|just a moment|captcha|access denied/i.test(html)) {
            throw new Error('XVideos returned a challenge page');
          }

          const hasVideoEvidence =
            /html5player\.|setVideo(?:Url|HLS)|["']VideoObject["']|<video\b/i.test(html);
          if (candidates.length > 1 && index < candidates.length - 1 && !hasVideoEvidence) {
            lastError = new Error('XVideos candidate returned a page without a video player');
            continue;
          }

          htmlCache.set(url, html);
          htmlCache.set(candidate, html);
          resolvedPageCache.set(url, candidate);
          resolvedPageCache.set(candidate, candidate);
          if (candidate !== url) {
            logger.info({ provider: this.name }, 'XVideos repaired malformed catalog URL');
          }
          return html;
        } catch (error) {
          lastError = error;
          if (error.response?.status !== 404 && !/HTTP 404/.test(error.message)) throw error;
        }
      }

      throw lastError || new Error('XVideos page request failed');
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
      if (!href) return;

      let rawId;
      try {
        const parsed = new URL(href, this.baseUrl);
        if (
          parsed.protocol !== 'https:' ||
          !this.allowedPageHosts.has(parsed.hostname.toLowerCase()) ||
          !parsed.pathname.startsWith('/video')
        ) {
          return;
        }
        parsed.search = '';
        parsed.hash = '';
        rawId = parsed.toString().replace(/\/$/, '');
      } catch {
        return;
      }

      const canonicalId = normalizeXvideosPageUrl(rawId, this.baseUrl);
      if (!canonicalId) return;
      if (seen.has(canonicalId)) return;
      seen.add(canonicalId);

      // Preserve malformed template IDs long enough for fetchHtml() to try every
      // canonical candidate. The public Stremio ID is opaque, so THUMBNUM is not
      // exposed as a direct request URL.
      const id = /\/THUMBNUM(?:\/|$)/i.test(rawId) ? rawId : canonicalId;

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
    const resolvedId = resolvedPageCache.get(args.id) || normalizeXvideosPageUrl(args.id, this.baseUrl);
    const parsed = this.parseVideoPage({ id: resolvedId || args.id, html });
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

    const playbackHeaders = {
      Referer: id,
      Origin: this.baseUrl,
      'User-Agent': PLAYBACK_USER_AGENT,
    };
    const directMp4Streams = directCandidates.map(candidate => ({
      type: Provider.TYPE,
      url: mediaRelay.register({
        url: candidate.url,
        headers: playbackHeaders,
        provider: this.name,
        kind: 'mp4',
      }),
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
      const resolvedId = resolvedPageCache.get(id) || normalizeXvideosPageUrl(id, this.baseUrl);
      parsed = this.parseVideoPage({ id: resolvedId || id, html });
      if (parsed?.metaResponse) metaCache.set(id, parsed);
    }

    if (parsed?.directMp4Streams?.length) {
      return { streams: parsed.directMp4Streams };
    }

    if (!parsed?.videoPageUrl) return { streams: [] };

    const requestHeaders = {
      Referer: resolvedPageCache.get(id) || normalizeXvideosPageUrl(id, this.baseUrl) || id,
      Origin: this.baseUrl,
      'User-Agent': PLAYBACK_USER_AGENT,
    };

    try {
      const content = await this.fetchMediaText(parsed.videoPageUrl, {
        cache: false,
        headers: requestHeaders,
      });
      if (!content.includes('#EXTM3U')) return { streams: [] };

      const parsedVariants = this.parseM3u8(content);
      const sourceStreams = parsedVariants.length
        ? parsedVariants.map(stream => this.transformStream(parsed.videoPageUrl, stream))
        : [{ type: Provider.TYPE, url: parsed.videoPageUrl, name: 'HLS' }];

      return {
        streams: sourceStreams
          .map(stream => {
            const resolution =
              stream.resolution || extractResolution(stream.name, stream.url) || 'HLS';
            return {
              ...stream,
              url: mediaRelay.register({
                url: stream.url,
                headers: requestHeaders,
                provider: this.name,
                kind: 'hls',
              }),
              name: `XVideos ${resolution}`,
              quality: resolution,
              behaviorHints: {
                notWebReady: false,
                proxyHeaders: {
                  response: {
                    'content-type': 'application/vnd.apple.mpegurl',
                  },
                },
              },
            };
          })
          .sort(
            (left, right) =>
              (Number.parseInt(right.quality, 10) || 0) -
              (Number.parseInt(left.quality, 10) || 0)
          ),
      };
    } catch (error) {
      logger.warn({ provider: this.name, error: error.message }, 'XVideos HLS request failed');
      return { streams: [] };
    }
  }
}

const create = XvideosProvider.create;
create._test = {
  cleanTitle,
  normalizePoster,
  normalizeXvideosPageUrl,
  structuredDataFromPage,
  xvideosPageCandidates,
};
module.exports = create;
