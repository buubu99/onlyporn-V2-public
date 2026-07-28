const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');
const BoundedTtlCache = require('./cache');
const { parseAssignedObjectStringValues } = require('./js-literal');
const { isBlockedSpankbangHtml } = require('./challenge-detection');
const safariImpersonation = require('./safari-impersonation');
const { assertSafeHttpsUrl, sanitizeUrlForLogs } = require('./url-security');
const {
  cleanMediaUrl,
  extractResolution,
  isPlayableMediaUrl,
  isPreviewMediaCandidate,
  normalizeAbsoluteUrl,
} = require('./media-utils');

const CACHE_TTL = 1000 * 60 * 10;
const hlsCache = new BoundedTtlCache({ maxEntries: 200, ttlMs: CACHE_TTL });
const FOUR_K_MARKER = '_onlyporn4k';

const pathMappings = {
  trending: '/trending_videos/',
  new: '/new_videos/',
  popular: '/most_popular/',
  upcoming: '/upcoming/',
};

function markFourKUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set(FOUR_K_MARKER, '1');
  return parsed.toString();
}

function unmarkFourKUrl(url) {
  const parsed = new URL(url);
  const is4kCategory = parsed.searchParams.get(FOUR_K_MARKER) === '1';
  parsed.searchParams.delete(FOUR_K_MARKER);
  return { videoPageUrl: parsed.toString(), is4kCategory };
}

class SpankbangProvider extends Provider {
  constructor() {
    super('https://spankbang.com', 'spankbang', 80);
  }

  static create() {
    return new SpankbangProvider();
  }

  addPlaybackHeaders(stream) {
    return {
      ...stream,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
        notWebReady: true,
        proxyHeaders: {
          request: {
            Referer: 'https://spankbang.com/',
            Origin: 'https://spankbang.com',
            Cookie: 'sb=1; age_verified=1; hasVisited=1;',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          },
        },
      },
    };
  }

  getInitialUrl() {
    return this.baseUrl + pathMappings.trending;
  }

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/s/${encodeURIComponent(keyword)}/`;
  }

  async fetchHtml(url) {
    const safeUrl = await assertSafeHttpsUrl(url, {
      allowedHosts: this.allowedPageHosts,
    });

    try {
      const response = await safariImpersonation.fetchText(safeUrl, {
        timeoutMs: 30_000,
        maxBytes: 6 * 1024 * 1024,
      });

      const html = response.data;
      if (isBlockedSpankbangHtml(html)) {
        throw new Error('SpankBang returned a verified challenge page');
      }

      logger.debug(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(response.finalUrl || safeUrl),
          status: response.status,
          cfRay: response.headers?.['cf-ray'],
        },
        'SpankBang Safari request succeeded'
      );
      return html;
    } catch (error) {
      logger.warn(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(safeUrl),
          error: error.message,
        },
        'SpankBang Safari request failed'
      );
      throw error;
    }
  }

  handleGenre({ extra }) {
    const { genre } = extra;
    if (!genre) return this.getInitialUrl();

    let keyword = '';
    let order = '';
    let is4k = false;

    if (genre.includes('(')) {
      const [base, inside] = genre.split('(');
      keyword = base.trim();
      for (const part of inside.replace(')', '').split(/\s+/)) {
        const value = part.toLowerCase();
        if (value === '4k') is4k = true;
        else order = value;
      }
    } else {
      keyword = genre.trim();
    }

    keyword = keyword.toLowerCase();
    let url;

    if (pathMappings[keyword]) {
      url = this.baseUrl + pathMappings[keyword];
      const parsed = new URL(url);
      if (keyword !== 'upcoming' && order && !['trending', 'featured'].includes(order)) {
        parsed.searchParams.set('o', order);
      }
      if (is4k) parsed.searchParams.set('q', 'uhd');
      return parsed.toString();
    }

    if (keyword === '4k') {
      const parsed = new URL(this.baseUrl + pathMappings.trending);
      parsed.searchParams.set('q', 'uhd');
      if (order && order !== 'trending') parsed.searchParams.set('o', order);
      return parsed.toString();
    }

    url = `${this.baseUrl}/s/${encodeURIComponent(keyword)}/`;
    const parsed = new URL(url);
    if (order && order !== 'trending') parsed.searchParams.set('o', order);
    if (is4k) parsed.searchParams.set('q', 'uhd');
    return parsed.toString();
  }

  handlePagination(url, { extra: { skip } }) {
    const page = this.page(skip);
    if (page === '1') return url;

    const parsed = new URL(url);
    const base = `${parsed.origin}${parsed.pathname.replace(/\/$/, '').replace(/\/\d+$/, '')}`;
    return `${base}/${page}/${parsed.search}`;
  }

  getCatalogMetas(html, currentUrl) {
    const metadataList = [];
    const $ = load(html);
    const seen = new Set();
    const is4kCategory = new URL(currentUrl).searchParams.get('q') === 'uhd';
    const items = $('a.thumb, a.video-item, .video-item a, a[href*="/video"]');

    items.each((index, element) => {
      const $element = $(element);
      const link = $element.attr('href');
      if (!link) return;

      const videoPageUrl = new URL(link, this.baseUrl).toString();
      if (seen.has(videoPageUrl)) return;
      seen.add(videoPageUrl);

      if (index < 8 && currentUrl.includes('trending')) return;

      const image = $element.find('img').first();
      let poster =
        image.attr('data-src') ||
        image.attr('data-original') ||
        image.attr('src') ||
        image.attr('data-preview');

      if (poster) {
        poster = poster
          .replace('/small/', '/large/')
          .replace('/medium/', '/large/')
          .replace('/thumbs/', '/thumbs/large/')
          .replace('/large/', '/large_hd/');
        poster = normalizeAbsoluteUrl(poster, this.baseUrl);
      }

      const title =
        image.attr('alt') ||
        $element.attr('title') ||
        $element.find('.n').text() ||
        $element.text().trim();
      if (!title) return;

      if (is4kCategory) {
        const evidence = `${$element.text()} ${title}`.toLowerCase();
        if (!/4k|2160|uhd/.test(evidence)) return;
      }

      const contentId = is4kCategory ? markFourKUrl(videoPageUrl) : videoPageUrl;
      metadataList.push(
        new meta.MetaPreview(contentId, Provider.TYPE, title, poster, {
          videoPageUrl,
          posterShape: 'landscape',
        })
      );
    });

    logger.debug({ count: metadataList.length }, 'SpankBang catalog items parsed');
    return metadataList;
  }

  getVideoPageDetails(id, extra = {}) {
    const is4kFromExtra = Boolean(extra.is4kCategory);

    if (!id.includes('::')) {
      const details = unmarkFourKUrl(new URL(id, this.baseUrl).toString());
      return {
        videoPageUrl: details.videoPageUrl,
        is4kCategory: details.is4kCategory || is4kFromExtra,
      };
    }

    // Backward compatibility with the pre-2.2.0 page::link::index IDs.
    const [pageUrl, link] = id.split('::');
    if (!link) return { videoPageUrl: this.baseUrl, is4kCategory: is4kFromExtra };

    const cleanLink = link.split('/').slice(0, 3).join('/');
    return {
      videoPageUrl: new URL(`${cleanLink}/`, this.baseUrl).toString(),
      is4kCategory: is4kFromExtra || pageUrl.includes('q=uhd'),
    };
  }

  async getMetadata(args) {
    const { videoPageUrl, is4kCategory } = this.getVideoPageDetails(args.id, args.extra);
    const html = await this.fetchHtml(videoPageUrl);
    const parsed = await this.parseVideoPage({ id: videoPageUrl, html, is4kCategory });
    return parsed?.metaResponse || parsed;
  }

  async processStreams({ id, extra }) {
    const { videoPageUrl, is4kCategory } = this.getVideoPageDetails(id, extra);
    const html = await this.fetchHtml(videoPageUrl);
    const parsed = await this.parseVideoPage({ id: videoPageUrl, html, is4kCategory });
    return { streams: Array.isArray(parsed?.streams) ? parsed.streams : [] };
  }

  streamDataStreams(scripts) {
    const parsed = parseAssignedObjectStringValues(scripts, 'stream_data');
    const seenQualities = new Set();
    const seenUrls = new Set();
    const streams = [];

    for (const [qualityLabel, values] of Object.entries(parsed)) {
      const rawUrl = values.find(value => /^(?:https?:)?\/\//i.test(value));
      const streamUrl = normalizeAbsoluteUrl(rawUrl, this.baseUrl);
      const quality = extractResolution(qualityLabel, streamUrl);

      if (
        !streamUrl ||
        !isPlayableMediaUrl(streamUrl) ||
        isPreviewMediaCandidate(streamUrl, qualityLabel) ||
        !quality ||
        seenUrls.has(streamUrl) ||
        seenQualities.has(quality)
      ) {
        continue;
      }

      seenUrls.add(streamUrl);
      seenQualities.add(quality);
      streams.push(
        this.addPlaybackHeaders({
          name: quality,
          url: streamUrl,
          type: Provider.TYPE,
        })
      );
    }

    return streams.sort(
      (left, right) => (Number.parseInt(right.name, 10) || 0) - (Number.parseInt(left.name, 10) || 0)
    );
  }

  isFourKResult(streams) {
    return streams.some(stream => /2160|4k/i.test(`${stream.name} ${stream.url}`));
  }

  async parseVideoPage({ id, html, is4kCategory }) {
    const $ = load(html);
    const url = $('meta[property="og:url"]').attr('content') || id;
    const title = $('meta[property="og:title"]').attr('content') || 'SpankBang video';
    const poster = normalizeAbsoluteUrl(
      $('meta[property="og:image"]').attr('content'),
      this.baseUrl
    );
    const description = $('meta[property="og:description"]').attr('content') || title;
    const scripts = $('script')
      .toArray()
      .map(element => $(element).html() || '')
      .join('\n');

    let streams = this.streamDataStreams(scripts);
    if (streams.length) {
      if (is4kCategory && !this.isFourKResult(streams)) return {};
      return {
        metaResponse: new meta.MetaResponse(url, Provider.TYPE, title, {
          poster,
          background: poster,
          description,
          posterShape: 'landscape',
        }),
        streams,
      };
    }

    const cleanedScripts = this.cleanUrl(scripts);
    const masterUrl = cleanMediaUrl(
      cleanedScripts.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i)?.[0]
    );
    if (!masterUrl || isPreviewMediaCandidate(masterUrl)) return {};

    const cachedStreams = hlsCache.get(masterUrl);
    if (cachedStreams !== undefined) {
      if (is4kCategory && !this.isFourKResult(cachedStreams)) return {};
      return {
        metaResponse: new meta.MetaResponse(url, Provider.TYPE, title, {
          poster,
          background: poster,
          description,
          posterShape: 'landscape',
        }),
        streams: cachedStreams,
      };
    }

    const headers = {
      referer: 'https://spankbang.com/',
      origin: 'https://spankbang.com',
      cookie: 'sb=1; age_verified=1;',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    };

    const idMatch = masterUrl.match(/\/(\d+)-/);
    let forced4kUrl = null;
    if (!masterUrl.includes(',4k,') && idMatch && masterUrl.includes('/hls/')) {
      const videoId = idMatch[1];
      const base = `${masterUrl.split('/hls/')[0]}/hls/`;
      const pathParts = masterUrl.split('/hls/')[1].split('/');
      const folderPath = pathParts.slice(0, 2).join('/');
      forced4kUrl = `${base}${folderPath}/${videoId}-4k.mp4/index-v1-a1.m3u8`;
    }

    try {
      const [text, fourkAvailable] = await Promise.all([
        this.fetchMediaText(masterUrl, { headers, cache: false }),
        forced4kUrl ? this.mediaExists(forced4kUrl, { headers }) : Promise.resolve(false),
      ]);

      const variants = [];
      const lines = text.split('\n');

      for (let index = 0; index < lines.length && variants.length < 12; index += 1) {
        const line = lines[index];
        if (!line.includes('#EXT-X-STREAM-INF')) continue;

        const height = Number.parseInt(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] || '0', 10);
        const bitrate = Number.parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || '0', 10);
        const nextLine = lines[index + 1]?.trim();
        if (!nextLine || nextLine.startsWith('#')) continue;

        const streamUrl = new URL(nextLine, masterUrl).toString();
        if (isPreviewMediaCandidate(streamUrl)) continue;
        const realHeight =
          (bitrate > 12_000_000 && height === 1080) || /4k|2160/i.test(streamUrl)
            ? 2160
            : height;
        if (!realHeight) continue;

        variants.push({
          ...this.addPlaybackHeaders({
            name: `${realHeight}p`,
            url: streamUrl,
            type: Provider.TYPE,
          }),
          height: realHeight,
          bitrate,
        });
      }

      variants.sort((left, right) => right.height - left.height || right.bitrate - left.bitrate);
      streams = variants.map(({ height, bitrate, ...stream }) => stream);

      if (fourkAvailable) {
        streams.unshift(
          this.addPlaybackHeaders({
            name: '2160p 4K',
            url: forced4kUrl,
            type: Provider.TYPE,
          })
        );
      }

      if (streams.length) hlsCache.set(masterUrl, streams);
    } catch (error) {
      logger.warn({ error: error.message }, 'SpankBang HLS parsing failed');
      return {};
    }

    if (!streams.length || (is4kCategory && !this.isFourKResult(streams))) return {};

    return {
      metaResponse: new meta.MetaResponse(url, Provider.TYPE, title, {
        poster,
        background: poster,
        description,
        posterShape: 'landscape',
      }),
      streams,
    };
  }
}

const create = SpankbangProvider.create;
create._test = { FOUR_K_MARKER, isBlockedSpankbangHtml, markFourKUrl, unmarkFourKUrl };
module.exports = create;
