const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');

const metaCache = new Map();
const META_TTL = 1000 * 60 * 10;

const htmlCache = new Map();
const inFlight = new Map();
const HTML_TTL = 1000 * 60 * 5;

const catalogCache = new Map();
const CATALOG_TTL = 1000 * 60 * 3;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(instance, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await instance(url);
    } catch (err) {
      if (err.response?.status === 429) {
        logger.debug(`429 retry (${i + 1})`);
        await delay(2000 * (i + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Max retries reached');
}

const pathMappings = {
  'Best (Daily)': '/best',
  'Best (Weekly)': '/best/weekly',
  'Best (Monthly)': '/best/monthly',
  'Best (2026)': '/best/year-2026',
  'Best (2025)': '/best/year-2025',
  'Best (2024)': '/best/year-2024',
  'Best (2023)': '/best/year-2023',
  'Best (2022)': '/best/year-2022',
};

class XhamsterProvider extends Provider {

  constructor() {
    super('https://xhamster.com', 'xhamster', 40);
  }

  static create() {
    return new XhamsterProvider();
  }

  toSlug(str) {
    return str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/&/g, '')
      .replace(/[^a-z0-9-]/g, '');
  }

getMode(catalogId = '') {
  const id = catalogId.toLowerCase();

  if (id.includes('best')) return 'best';

  return ''; // trending = homepage
}

  async fetchHtml(url) {
    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
      const cached = htmlCache.get(url);
      if (cached && Date.now() - cached.time < HTML_TTL) {
        return cached.data;
      }

      const html = await fetchWithRetry(
        (u) => super.fetchHtml(u, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/html',
            'Referer': 'https://xhamster.com/',
            'Cookie': 'x_content_preference_index=straight; parental-control=yes'
          }
        }),
        url
      );

      htmlCache.set(url, { data: html, time: Date.now() });
      return html;
    })();

    inFlight.set(url, promise);

    try {
      return await promise;
    } finally {
      inFlight.delete(url);
    }
  }

  getInitialUrl(catalogId) {
  const mode = this.getMode(catalogId);

  return mode
    ? `${this.baseUrl}/${mode}`
    : this.baseUrl;
}

  handleSearch({ extra: { search: keyword } }) {
    return `${this.baseUrl}/search/${encodeURIComponent(keyword)}/`;
  }

  handleGenre({ id, extra: { genre } }) {
  const mode = this.getMode(id);

  if (!genre) return this.getInitialUrl(id);

  const slug = this.toSlug(genre);

  // 🔥 SPECIAL CASES
  if (slug === '4k') {
    return mode
      ? `${this.baseUrl}/4k/${mode}`
      : `${this.baseUrl}/4k`;
  }

  if (pathMappings[genre]) {
    return this.baseUrl + pathMappings[genre];
  }

  // ✅ Trending
  if (!mode) {
    return `${this.baseUrl}/categories/${slug}`;
  }

  // ✅ Best
  return `${this.baseUrl}/categories/${slug}/${mode}`;
}

  handlePagination(url, { extra: { skip } }) {
  const page = this.page(skip);
  if (!page || page === '1') return url.replace(/\/1\/?$/, '/');

  const base = url.replace(/\/$/, '').replace(/\/\d+$/, '');
  return `${base}/${page}/`;
}

  async fetchCatalog(baseUrl, genreName) {

    const cacheKey = `${baseUrl}-${genreName}`;
    const cached = catalogCache.get(cacheKey);

    if (cached && Date.now() - cached.time < CATALOG_TTL) {
      return cached.data;
    }

    const globalSeen = new Set();
    let allVideos = [];

    const base = baseUrl.replace(/\/$/, '');

    // 🔥 PAGE 1
    try {
      const html = await this.fetchHtml(base);
      const vids = this.getCatalogMetas(html, globalSeen);
      allVideos.push(...vids);
    } catch (e) {
      logger.debug('HTML fetch failed');
    }

    // 🔥 PAGE 2 ONLY (max)
    if (allVideos.length < this.limit) {
      try {
        const html = await this.fetchHtml(`${base}/2/`);
        const vids = this.getCatalogMetas(html, globalSeen);
        allVideos.push(...vids);
      } catch {}
    }

    // ⚡ OPTIONAL API BACKFILL (only if very low results)
    if (allVideos.length < 20 && genreName) {
      const slug = this.toSlug(genreName);

      try {
        const apiUrl = `https://xhamster.com/api/v4/videos?category=${slug}&size=60`;
        const res = await fetch(apiUrl);
        const json = await res.json();

        for (const v of json?.videos || []) {
  const url = v.url || v.pageURL;
  if (!url || !url.includes('/videos/')) continue;
  if (globalSeen.has(url)) continue;

  const titleLower = (v.title || '').toLowerCase();

  // 🚫 FILTER VR HERE TOO
  if (/\bvr\b/.test(titleLower)) continue;
  if (titleLower.includes('virtual reality')) continue;

  allVideos.push(
  new meta.MetaPreview(
    url,
    'movie',
    v.title,
    v.thumbURL || v.thumb,
    {
      posterShape: 'landscape'
    }
  )
);

  globalSeen.add(url);

  if (allVideos.length >= this.limit) break;
}
      } catch {}
    }

    const finalData = allVideos.slice(0, this.limit);

    catalogCache.set(cacheKey, {
      data: finalData,
      time: Date.now()
    });

    return finalData;
  }

  getCatalogMetas(html, seen = new Set()) {
    if (!html || html.length < 1000) return [];

    const metadataList = [];

    const match = html.match(/window\.initials\s*=\s*(\{.*?\});/s);

    if (match) {
      try {
        const json = JSON.parse(match[1]);
        const videos = [];
        const visited = new WeakSet();

        const extract = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object') return;
          if (depth > 6) return;
          if (visited.has(obj)) return;
          visited.add(obj);

          if (Array.isArray(obj)) {
            for (const i of obj) extract(i, depth + 1);
            return;
          }

          if (
  obj.pageURL &&
  obj.title &&
  (obj.imageURL || obj.thumbURL)
) {
  if (!obj.pageURL.includes('/videos/')) return;

  // 🚫 FILTER OUT VR
  const title = obj.title.toLowerCase();

// 🚫 safer VR detection
if (obj.isVR === true) return;
if (/\bvr\b/.test(title)) return;
if (title.includes('virtual reality')) return;

  // 🚫 OPTIONAL: filter vertical / weird formats
  if (obj.isVertical === true) return;

  videos.push(obj);
            if (videos.length >= this.limit * 2) return;
          }

          for (const k in obj) extract(obj[k], depth + 1);
        };

        extract(json);

        for (const v of videos) {
          if (seen.has(v.pageURL)) continue;

          let poster = v.thumbURL || v.imageURL;
          if (poster && !poster.startsWith('http')) {
            poster = this.baseUrl + poster;
          }

          metadataList.push(
            new meta.MetaPreview(
              v.pageURL,
              'movie',
              v.title,
              poster,
              {
      posterShape: 'landscape'
    }
            )
          );

          seen.add(v.pageURL);
        }

        // ✅ STOP if JSON worked
        if (metadataList.length) return metadataList;

      } catch {}
    }

    // 🔻 FALLBACK (only if JSON failed)
    const $ = load(html);

    $('.thumb-list__item, .video-thumb').each((_, el) => {
      const $a = $(el).find('a').first();

      let url = $a.attr('href');
      if (!url) return;
      if (!url.includes('/videos/')) return;

      if (!url.startsWith('http')) url = this.baseUrl + url;
      if (seen.has(url)) return;

      seen.add(url);

      const $img = $a.find('img').first();

      let poster =
        $img.attr('data-src') ||
        $img.attr('src');

      if (poster && !poster.startsWith('http')) {
        poster = this.baseUrl + poster;
      }

      const titleRaw = $img.attr('alt') || $a.attr('title') || '';
const titleLower = titleRaw.toLowerCase();

if (!titleRaw) return;

// filter using lowercase
if (/\bvr\b/.test(titleLower) || titleLower.includes('virtual reality')) return;

// ✅ keep original title
metadataList.push(
  new meta.MetaPreview(
    url,
    'movie',
    titleRaw,
    poster,
    {
      posterShape: 'landscape'
    }
  )
);
    });

    return metadataList;
  }

  async getMetadata(args) {
    let { id } = args;
    if (!id.startsWith('http')) id = this.baseUrl + id;

    const cached = metaCache.get(id);
    if (cached && Date.now() - cached.time < META_TTL) return cached.data;

    const html = await this.fetchHtml(id);
    const data = this.parseVideoPage({ id, html });

    metaCache.set(id, { data, time: Date.now() });
    return data;
  }

  parseVideoPage({ id, html }) {
    const match =
      html.match(/window\.initials\s*=\s*(\{.*?\});/) ||
      html.match(/window\.initials\s*=\s*JSON\.parse\("(.+?)"\)/);

    if (!match) return {};

    let json;
    try {
      if (match[1].startsWith('{')) {
        json = JSON.parse(match[1]);
      } else {
        const decoded = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        json = JSON.parse(decoded);
      }
    } catch {
      return {};
    }

    const title = json?.videoEntity?.title || json?.videoModel?.title;
    const description = json?.videoModel?.description || title;
    const poster = json?.videoModel?.thumbURL;

    let streamUrl =
      json?.xplayerSettings?.sources?.hls?.h264?.url ||
      json?.xplayerSettings?.sources?.mp4?.high?.url;

    if (streamUrl && !streamUrl.startsWith('http')) streamUrl = null;

    return new meta.MetaResponse(
      id,
      Provider.TYPE,
      title,
      {
        videoPageUrl: streamUrl,
        description,
        poster,
        background: poster,
        posterShape: 'landscape',
        genres: []
      }
    );
  }

  transformStream(baseUrl, stream) {
    const resolvedStream = super.transformStream(baseUrl, stream);

    return {
      ...resolvedStream,
      behaviorHints: {
        ...(resolvedStream.behaviorHints || {}),
        notWebReady: true,
        proxyHeaders: {
          request: {
            Referer: 'https://xhamster.com/',
            Origin: 'https://xhamster.com',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            Cookie:
              'x_content_preference_index=straight; parental-control=yes',
          },
        },
      },
    };
  }
}

module.exports = XhamsterProvider.create;
