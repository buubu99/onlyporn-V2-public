const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');
const BoundedTtlCache = require('./cache');
const {
  cleanMediaUrl,
  extractResolution,
  isPlayableMediaUrl,
  isPreviewMediaUrl,
} = require('./media-utils');

const CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const hlsCache = new BoundedTtlCache({ maxEntries: 200, ttlMs: CACHE_TTL });

const pathMappings = {
  'trending': '/trending_videos/',
  'new': '/new_videos/',
  'popular': '/most_popular/',
  'upcoming': '/upcoming/',
};

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
    const html = await super.fetchHtml(url, {
      cache: false,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Referer: 'https://spankbang.com/',
        Origin: 'https://spankbang.com',
        Cookie: 'sb=1; age_verified=1; hasVisited=1;',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    if (html.includes('cf-chl') || html.includes('Just a moment')) {
      throw new Error('SpankBang returned a Cloudflare challenge page');
    }

    return html;
  }

  handleGenre({ extra }) {
  const { genre } = extra;

  if (!genre) return this.getInitialUrl();

  let keyword = '';
  let order = '';
  let is4k = false;

  // ✅ Extract parts safely
  if (genre.includes('(')) {
    const [base, inside] = genre.split('(');
    keyword = base.trim();

    const parts = inside.replace(')', '').split(' ');

    parts.forEach(p => {
      const val = p.toLowerCase();

      if (val === '4k') is4k = true;
      else order = val;
    });

  } else {
    keyword = genre.trim();
  }
keyword = keyword.toLowerCase();

  let url;

  const isBaseCategory = pathMappings[keyword];

  // =========================
  // ✅ CASE 1: BASE CATEGORY
  // =========================
  if (isBaseCategory) {
    url = this.baseUrl + pathMappings[keyword];

    const u = new URL(url);

    if (keyword !== 'upcoming') {
  if (order && order !== 'trending' && order !== 'featured') {
    u.searchParams.set('o', order);
  }
}

    if (is4k) {
      u.searchParams.set('q', 'uhd');
    }

    url = u.toString();
  }

  // =========================
  // ✅ CASE 2: PURE 4K (no keyword)
  // =========================
  else if (keyword === '4k') {
    url = this.baseUrl + pathMappings.trending;

    const u = new URL(url);
    u.searchParams.set('q', 'uhd');

    if (order && order !== 'trending') {
      u.searchParams.set('o', order);
    }

    url = u.toString();
  }

  // =========================
  // ✅ CASE 3: SEARCH KEYWORD
  // =========================
  else {
    url = `${this.baseUrl}/s/${encodeURIComponent(keyword)}/`;

    const u = new URL(url);

    if (order && order !== 'trending') {
      u.searchParams.set('o', order);
    }

    if (is4k) {
      u.searchParams.set('q', 'uhd');
    }

    url = u.toString();
  }

  console.log({ finalUrl: url }, 'catalog URL');
  return url;
}

  handlePagination(url, { extra: { skip } }) {
  const page = this.page(skip);
  if (!page) return url;

  const u = new URL(url);

  // SpankBang uses /{page}/ AFTER path, BEFORE query
  let base = u.origin + u.pathname.replace(/\/$/, '');
  let final = `${base}/${page}/`;

  if (u.search) {
    final += u.search;
  }

  return final;
}

  getCatalogMetas(html, currentUrl) {    
    const metadataList = [];    
    const $ = load(html);    
    
    const items = $('a.thumb, a.video-item, .video-item a, a[href*="/video"]');    
    
    const seen = new Set();    
    
items.each((index, element) => {    
  const $e = $(element);    
    
  const link = $e.attr('href');    
    
  if (!link) return;    
    
  // 🔥 1. Skip pinned/top repeated videos    
  if (index < 8 && currentUrl.includes('trending')) return;    
    
  // 🔥 2. Local dedupe (same page)    
  if (seen.has(link)) return;    
  seen.add(link);    
    
      const img = $e.find('img');    
    
      let poster =    
  img.attr('data-src') ||    
  img.attr('data-original') ||    
  img.attr('src') ||    
  img.attr('data-preview');    
    
      if (poster) {    
        poster = poster    
          .replace('/small/', '/large/')    
          .replace('/medium/', '/large/')    
          .replace('/thumbs/', '/thumbs/large/');    
    
        if (/\/large\//.test(poster)) {    
          poster = poster.replace('/large/', '/large_hd/');    
        }    
      }    
    
      const title =    
  img.attr('alt') ||    
  $e.attr('title') ||    
  $e.find('.n').text() ||    
  $e.text().trim();    
    
      if (!link || !title) return;    
    
      const videoPageUrl = this.baseUrl + link;    
    
const is4kCategory = currentUrl.includes('q=uhd');    
    
// 🚫 Skip pinned fake entries EARLY for 4K pages    
if (is4kCategory) {    
  const text = $e.text().toLowerCase();    
  const titleCheck = (title || '').toLowerCase();    
    
  const looks4k =    
    /4k|2160/.test(text) ||    
    /4k|2160/.test(titleCheck) ||    
    /uhd/.test(text);    
    
  if (!looks4k) {    
    return; // ❌ skip immediately    
  }    
}    
    
// 🔥 ADD THIS    
const uniqueId = `${currentUrl}::${link}::${index}`;    
    
metadataList.push(
  new meta.MetaPreview(
    uniqueId,
    'movie',
    title,
    poster,
    {
      videoPageUrl,
      is4kCategory,
      posterShape: 'landscape'
    }
  )
);    
    });    
    
    logger.debug({ count: metadataList.length }, 'catalog items parsed');    
    return metadataList;    
  }

  getVideoPageDetails(id, extra = {}) {
    const is4kCategory = extra.is4kCategory || id.includes('q=uhd');

    if (!id.includes('::')) {
      return {
        videoPageUrl: new URL(id, this.baseUrl).toString(),
        is4kCategory,
      };
    }

    const [, link] = id.split('::');
    if (!link) {
      return { videoPageUrl: this.baseUrl, is4kCategory };
    }

    const cleanLink = link.split('/').slice(0, 3).join('/');
    return {
      videoPageUrl: new URL(`${cleanLink}/`, this.baseUrl).toString(),
      is4kCategory,
    };
  }

  async getMetadata(args) {
    logger.debug({ args }, 'getMetadata');

    const { videoPageUrl, is4kCategory } = this.getVideoPageDetails(
      args.id,
      args.extra
    );

    return this.fetchHtml(videoPageUrl)
      .then(html =>
        this.parseVideoPage({ id: videoPageUrl, html, is4kCategory })
      )
      .then(parsed => parsed?.metaResponse || parsed)
      .catch(error => {
        logger.error({ error, args }, 'getMetadata error');
        throw error;
      });
  }

  async processStreams({ id, extra }) {
    const { videoPageUrl, is4kCategory } = this.getVideoPageDetails(id, extra);
    const html = await this.fetchHtml(videoPageUrl);
    const parsed = await this.parseVideoPage({
      id: videoPageUrl,
      html,
      is4kCategory,
    });

    return {
      streams: Array.isArray(parsed?.streams) ? parsed.streams : [],
    };
  }

  async parseVideoPage({ html, is4kCategory }) {
    const $ = load(html);

    const url = $('meta[property="og:url"]').attr('content');
    const title = $('meta[property="og:title"]').attr('content');
    const poster = $('meta[property="og:image"]').attr('content');

    const description =
      $('meta[property="og:description"]').attr('content') || title;

    const scripts = $('script')
      .toArray()
      .map(el => el.children?.[0]?.data || '')
      .join('\n');

    const regex = /stream_data\s*=\s*(\{[^;]+\})/;
    const match = scripts.match(regex);

    let streams = [];

    if (match) {
      try {
        console.log('⚡ Using stream_data');

        let jsonString = match[1];
        jsonString = jsonString
  .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":') // quote keys
  .replace(/'/g, '"'); // single → double quotes

        const streamsData = JSON.parse(jsonString);

        const seenQualities = new Set();
        const seenUrls = new Set();

        streams = Object.entries(streamsData)
          .map(([qualityLabel, value]) => {
            const rawUrl = Array.isArray(value)
              ? value.find(item => typeof item === 'string')
              : value;
            const streamUrl = cleanMediaUrl(rawUrl);
            const quality = extractResolution(qualityLabel, streamUrl);

            if (
              !streamUrl.startsWith('http') ||
              !isPlayableMediaUrl(streamUrl) ||
              isPreviewMediaUrl(streamUrl) ||
              !quality ||
              seenUrls.has(streamUrl) ||
              seenQualities.has(quality)
            ) {
              return null;
            }

            seenUrls.add(streamUrl);
            seenQualities.add(quality);

            return this.addPlaybackHeaders({
              name: quality,
              url: streamUrl,
              type: Provider.TYPE,
            });
          })
          .filter(Boolean);

      } catch (e) {
        console.log('❌ stream_data parse failed', e);
      }
    }

    if (streams.length) {
  console.log('✅ stream_data success');

  // ✅ STRICT 4K FILTER (ADD HERE ALSO)
  if (is4kCategory) {
    const has4k = streams.some(s =>
      /2160|4k/i.test(s.name) || /2160|4k/i.test(s.url)
    );

    if (!has4k) {
      console.log('🚫 Skipping non-4K video (stream_data)');
      return {};
    }
  }

  return {
    metaResponse: new meta.MetaResponse(url, 'movie', title, {
      poster,
      background: poster,
      description,
      posterShape: 'landscape'
    }),
    streams
  };
}

    const m3u8Match = scripts.match(/https?:\/\/[^"' ]+\.m3u8[^"' ]*/);

    if (!m3u8Match) {
      console.log('❌ No m3u8 found');
      return {};
    }

    const masterUrl = m3u8Match[0];

    const cachedStreams = hlsCache.get(masterUrl);
    if (cachedStreams !== undefined) {
      return {
        metaResponse: new meta.MetaResponse(url, 'movie', title, {
          poster,
          background: poster,
          description,
          posterShape: 'landscape'
        }),
        streams: cachedStreams
      };
    }

    console.log('🌐 HLS parsing started');

    const has4k = masterUrl.includes(',4k,');
    let forced4kStream = null;
    let forced4kUrl;

    if (!has4k) {
      const idMatch = masterUrl.match(/\/(\d+)-/);
      if (idMatch) {
        const videoId = idMatch[1];
        const base = masterUrl.split('/hls/')[0] + '/hls/';
        const pathParts = masterUrl.split('/hls/')[1].split('/');
        const folderPath = pathParts.slice(0, 2).join('/');

        forced4kUrl = `${base}${folderPath}/${videoId}-4k.mp4/index-v1-a1.m3u8`;
      }
    }

    try {
      const headers = {
        referer: 'https://spankbang.com/',
        origin: 'https://spankbang.com',
        'cookie': 'sb=1; age_verified=1;', // ✅ ALSO ADDED HERE
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      };

      const [text, fourkAvailable] = await Promise.all([
        this.fetchMediaText(masterUrl, { headers, cache: false }),
        forced4kUrl
          ? this.mediaExists(forced4kUrl, { headers })
          : Promise.resolve(false),
      ]);

      if (fourkAvailable) {
        console.log('🔥 4K FOUND');
        forced4kStream = this.addPlaybackHeaders({
          name: '2160p 4K',
          url: forced4kUrl,
          type: Provider.TYPE,
        });
      }

      const lines = text.split('\n');
      const variants = [];

      for (let i = 0; i < lines.length; i++) {
        if (variants.length >= 12) break;

        const line = lines[i];

        if (line.includes('#EXT-X-STREAM-INF')) {
          const height = parseInt(line.match(/RESOLUTION=\d+x(\d+)/)?.[1] || 0);
          const bitrate = parseInt(line.match(/BANDWIDTH=(\d+)/)?.[1] || 0);

          const nextLine = lines[i + 1]?.trim();
          if (!nextLine || nextLine.startsWith('#')) continue;

          const streamUrl = new URL(nextLine, masterUrl).toString();

          let realHeight = height;
          if ((bitrate > 12000000 && height === 1080) || /4k|2160/i.test(streamUrl)) {
            realHeight = 2160;
          }

          variants.push(
            this.addPlaybackHeaders({
              name: `${realHeight}p`,
              url: streamUrl,
              type: Provider.TYPE,
              height: realHeight,
              bitrate,
            })
          );
        }
      }

      variants.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);

      streams = variants.map(({ height, bitrate, ...rest }) => rest);

      if (forced4kStream) {
        streams.unshift(forced4kStream);
      }

      if (streams.length) hlsCache.set(masterUrl, streams);

      console.log('✅ STREAMS READY');

    } catch (err) {
      console.log('❌ HLS parsing failed', err);
    }

    if (!streams.length) {
      console.log('❌ No streams found after parsing');
      return {};
    }

// ✅ STRICT 4K FILTER
if (is4kCategory) {
  const has4k = streams.some(s =>
    /2160|4k/i.test(s.name) || /2160|4k/i.test(s.url)
  );

  if (!has4k) {
    console.log('🚫 Skipping non-4K video');
    return {}; // ❌ REMOVE from catalog
  }
}

    return {
      metaResponse: new meta.MetaResponse(url, 'movie', title, {
        poster,
        background: poster,
        description,
        posterShape: 'landscape'
      }),
      streams
    };
  }
}

module.exports = SpankbangProvider.create;