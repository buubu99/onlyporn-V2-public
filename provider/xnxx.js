const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');

const DEFAULT_POSTER =
  'https://thumb-cdn77.xnxx-cdn.com/default.jpg';

/* =========================
   HELPERS
========================= */
const cleanTitle = (title = '') =>
  title
    .replace(/^xnxx\s*/i, '')
    .trim();

const normalizeUrl = (url) => {
  if (!url || typeof url !== 'string') return undefined;

  if (!url.startsWith('http')) {
    return 'https:' + url;
  }

  return url;
};


const resolvePoster = (url) => {
  if (!url) return DEFAULT_POSTER;

  url = normalizeUrl(url);
  return url || DEFAULT_POSTER;
};

/* =========================
   🔥 XNXX THUMB HELPERS
========================= */

// upgrades CDN quality (from header.static.js logic)
const upgradeThumbQuality = (url) => {
  if (!url) return url;

  return url
    .replace(/\/thumbs169xnxx\//g, '/thumbs169ll/')
    .replace(/\/thumbs169\//g, '/thumbs169ll/')
    .replace(/\/thumbs\//g, '/thumbs169ll/');
};

// resolves THUMBNUM like site JS does
const resolveThumbNum = (url) => {
  if (!url) return url;

  const frame = Math.floor(Math.random() * 30) + 1;

  return url
    .replace(/THUMBNUM/g, frame)
    .replace(/\.[0-9]+\.jpg/, `.${frame}.jpg`);
};

/* =========================
   CACHE
========================= */
const htmlCache = new Map();
const metaCache = new Map();
const inFlight = new Map();

const HTML_TTL = 1000 * 60 * 5;
const META_TTL = 1000 * 60 * 5;

/* =========================
   REGEX
========================= */
const REGEX = {
  videoHLS: /html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/,
  videoHigh: /html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/,
  videoLow: /html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/,
  thumb169: /html5player\.setThumbUrl169\(['"]([^'"]+)['"]\)/
};

/* =========================
   PROVIDER
========================= */
class XnxxProvider extends Provider {

  constructor() {
    super('https://www.xnxx.com', 'xnxx', 48);
  }

  static create() {
    return new XnxxProvider();
  }

  /* =========================
     FETCH (CACHED + DEDUPE)
  ========================= */
  async fetchHtml(url) {

    const cached = htmlCache.get(url);
    if (cached && (Date.now() - cached.time < HTML_TTL)) {
      return cached.data;
    }

    if (inFlight.has(url)) {
      return inFlight.get(url);
    }

    const promise = (async () => {
      try {
        const html = await super.fetchHtml(url);

        htmlCache.set(url, {
          data: html,
          time: Date.now()
        });

        if (htmlCache.size > 300) {
          const firstKey = htmlCache.keys().next().value;
          htmlCache.delete(firstKey);
        }

        return html;
      } finally {
        inFlight.delete(url);
      }
    })();

    inFlight.set(url, promise);
    return promise;
  }

  /* =========================
     URL HANDLERS
  ========================= */

  getInitialUrl() {
    return `${this.baseUrl}/todays-selection`;
  }

  handleSearch({ extra: { search } }) {
    const formatted = encodeURIComponent(search).replace(/%20/g, '+');
    return `${this.baseUrl}/search/${formatted}/`;
  }

  handleGenre(args) {
    if (args.extra.genre === 'hits') {
      return `${this.baseUrl}/hits`;
    }

    return this.handleSearch({
      ...args,
      extra: { search: args.extra.genre }
    });
  }

  handlePagination(url, { extra: { skip, search } }) {

    const page = Math.floor(skip / 48);

    // SEARCH
    if (search) {
      const formatted = encodeURIComponent(search).replace(/%20/g, '+');
      return page === 0
        ? `${this.baseUrl}/search/${formatted}/`
        : `${this.baseUrl}/search/${formatted}/${page}`;
    }

    // HITS
    if (url.includes('hits')) {
      return page === 0
        ? `${this.baseUrl}/hits`
        : `${this.baseUrl}/hits/${page}`;
    }

    // DEFAULT
    return page === 0
      ? `${this.baseUrl}/todays-selection`
      : `${this.baseUrl}/todays-selection/${page}`;
  }

  /* =========================
     CATALOG
  ========================= */
  getCatalogMetas(html) {
    const $ = load(html);
    const metadatas = [];
    const seen = new Set();

    $('div.thumb-block a').each((_, el) => {

      const href = $(el).attr('href');
      if (!href || !href.startsWith('/video')) return;

      let id = new URL(href, this.baseUrl).href;


// 🔥 CLEAN BAD URLS
id = id
  .split('?')[0]
  .replace(/\/THUMBNUM.*/, '')
  .replace(/\/$/, '');

      if (seen.has(id)) return;
      seen.add(id);

      const parent = $(el).closest('.thumb-block');
const img = parent.find('img').first();

      let thumb =
  img.attr('data-src') ||
  img.attr('data-lazy-src') ||   // 🔥 NEW
  img.attr('data-original') ||
  img.attr('data-preview') ||
  img.attr('data-thumb') ||
  img.attr('src');

// ✅ srcset
if (!thumb) {
  const srcset = img.attr('data-srcset') || img.attr('srcset');
  if (srcset) {
    thumb = srcset.split(',')[0].split(' ')[0];
  }
}

// ✅ parent-level lazy attrs (VERY COMMON EDGE)
if (!thumb) {
  thumb =
    parent.attr('data-src') ||
    parent.attr('data-lazy-src');
}

// ✅ style fallback
if (!thumb) {
  const style = $(el).attr('style') || parent.attr('style');
  const match = style && style.match(/url\((.*?)\)/);
  if (match) thumb = match[1];
}

// ✅ brute fallback
if (!thumb) {
  const htmlBlock = parent.html();
  const match = htmlBlock && htmlBlock.match(/https?:\/\/[^"]+_t\.jpg/);
  if (match) thumb = match[0];
}

// ❌ ignore placeholders
if (thumb && thumb.includes('lightbox-blank')) {
  thumb = null;
}

// ✅ normalize
thumb = normalizeUrl(thumb);


thumb = resolvePoster(thumb);

if (thumb.includes('THUMBNUM') || /\.\d+\.jpg/.test(thumb)) {
  thumb = resolveThumbNum(thumb);
}

thumb = upgradeThumbQuality(thumb);

// 🔥 final safety
thumb = thumb || DEFAULT_POSTER;


      const titleAnchor = parent.find('.thumb-under p > a').first();

let titleRaw =
  titleAnchor.text().trim() ||   // ✅ PRIMARY (real title)
  titleAnchor.attr('title') ||   // fallback
  img.attr('alt') ||
  $(el).attr('title') ||
  'Video';
titleRaw = titleRaw.replace(/\s+/g, ' ').trim();

      metadatas.push(
  new meta.MetaPreview(
    id,
    Provider.TYPE,
    cleanTitle(titleRaw),
    thumb,
    {
      posterShape: 'landscape'
    }
  )
);
    });

    return metadatas;
  }

  /* =========================
     METADATA (CACHED)
  ========================= */
  async getMetadata(args) {

    const cached = metaCache.get(args.id);
    if (cached && (Date.now() - cached.time < META_TTL)) {
      return cached.data.metaResponse;
    }

    const html = await this.fetchHtml(args.id);
    const parsed = this.parseVideoPage({ id: args.id, html });

    metaCache.set(args.id, {
      data: parsed,
      time: Date.now()
    });

    if (metaCache.size > 300) {
      const firstKey = metaCache.keys().next().value;
      metaCache.delete(firstKey);
    }

    return parsed.metaResponse;
  }

  /* =========================
     PARSER
  ========================= */
  parseVideoPage({ id, html }) {

    const $ = load(html);

    let jsonContentUrl = null;

    try {
      const json = JSON.parse(
        $('script[type="application/ld+json"]').first().text()
      );
      jsonContentUrl = json?.contentUrl || null;
    } catch (e) {}

    const videoMatch =
      html.match(REGEX.videoHLS) ||
      html.match(REGEX.videoHigh) ||
      html.match(REGEX.videoLow);

    const videoPageUrl = videoMatch ? videoMatch[1] : null;

    const isBroken =
      !videoPageUrl &&
      !jsonContentUrl &&
      !html.includes('html5player');

    if (isBroken) {
      logger.warn('Invalid video page');

      return {
  metaResponse: new meta.MetaResponse(
    id,
    Provider.TYPE,
    'Unavailable Video',
    {
      links: [],
      description: '',
      background: null,
      poster: DEFAULT_POSTER,
      posterShape: 'landscape', // 👈 ADD
      genres: []
    }
  ),
  videoPageUrl: null
};
    }

    /* TAGS */
    const links = [];
    $('a[href*="/search/"]').each((_, e) => {
      const $tag = $(e);

      links.push(
        new meta.MetaLink(
          $tag.text(),
          'Genre',
          this.baseUrl + $tag.attr('href')
        )
      );
    });

    /* META */
    const title = $('meta[property="og:title"]').attr('content');
    const description = $('meta[name="description"]').attr('content');
    const ogImage = $('meta[property="og:image"]').attr('content');
    const keywords = $('meta[name="keywords"]').attr('content');

    const thumbMatch = html.match(REGEX.thumb169);

let background =
  thumbMatch?.[1] ||
  ogImage ||
  $('video').attr('poster') || // 🔥 NEW
  DEFAULT_POSTER;

background = resolvePoster(background);

    let poster = background;

    const genres = keywords
      ? keywords.split(',').map(g => g.trim())
      : [];

    const metaResponse = new meta.MetaResponse(
  id,
  Provider.TYPE,
  cleanTitle(title || 'Video'),
  {
    links,
    description,
    background,
    poster,
    posterShape: 'landscape', // 👈 ADD
    genres
  }
);

    return {
      metaResponse,
      videoPageUrl
    };
  }

  /* =========================
     STREAMS (OPTIMIZED)
  ========================= */
  async processStreams({ id }) {

    let cached = metaCache.get(id);
    let metaData;

    if (cached && (Date.now() - cached.time < META_TTL)) {
      metaData = cached.data;
    } else {
      const html = await this.fetchHtml(id);
      metaData = this.parseVideoPage({ id, html });

      metaCache.set(id, {
        data: metaData,
        time: Date.now()
      });
    }

    let streamsResponse = await super.getStreams(metaData);

    if (streamsResponse?.streams?.length) {

      streamsResponse.streams = streamsResponse.streams.map(s => {

        const match = s.url?.match(/(\d{3,4})p/);
        const resolution =
          s.resolution ||
          (match ? match[1] + 'p' : null) ||
          'unknown';

        let finalUrl = s.url;

        if (!s.url.startsWith('http') && metaData.videoPageUrl) {
  const base = metaData.videoPageUrl.substring(
    0,
    metaData.videoPageUrl.lastIndexOf('/') + 1
  );

  finalUrl = base + s.url.replace(/^\/+/, '');
}

        return {
          ...s,
          url: finalUrl,
          name: `XNXX ${resolution}`,
          quality: resolution
        };
      });

      streamsResponse.streams.sort((a, b) => {
        const getNum = (r) => parseInt(r) || 0;
        return getNum(b.quality) - getNum(a.quality);
      });

      return streamsResponse;
    }

    return { streams: [] };
  }

  transformStream(url, stream) {
    return {
      ...stream,
      url: url.includes('hls.m3u8')
        ? url.replace('hls.m3u8', '') + stream.url
        : url + stream.url
    };
  }
}

module.exports = XnxxProvider.create;