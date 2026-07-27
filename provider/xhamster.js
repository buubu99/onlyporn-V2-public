const { load } = require('cheerio');
const logger = require('../logger');
const { meta } = require('../model');
const Provider = require('./provider');
const BoundedTtlCache = require('./cache');
const {
  extractResolution,
  isHls,
  isLikelyFullVideoMp4,
  normalizeAbsoluteUrl,
} = require('./media-utils');

const META_TTL = 1000 * 60 * 10;
const HTML_TTL = 1000 * 60 * 5;
const CATALOG_TTL = 1000 * 60 * 3;

const metaCache = new BoundedTtlCache({ maxEntries: 300, ttlMs: META_TTL });
const htmlCache = new BoundedTtlCache({ maxEntries: 200, ttlMs: HTML_TTL });
const catalogCache = new BoundedTtlCache({ maxEntries: 100, ttlMs: CATALOG_TTL });
const inFlight = new Map();

function parseWindowInitials(html) {
  if (!html || typeof html !== 'string') return null;

  const encodedMatch = html.match(
    /window\.initials\s*=\s*JSON\.parse\(("(?:\\.|[^"\\])*")\)\s*;?/s
  );

  if (encodedMatch) {
    try {
      const decodedJson = JSON.parse(encodedMatch[1]);
      return JSON.parse(decodedJson);
    } catch {
      // Continue to the direct object assignment fallback.
    }
  }

  const marker = 'window.initials';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const assignmentIndex = html.indexOf('=', markerIndex + marker.length);
  if (assignmentIndex === -1) return null;

  const objectStart = html.indexOf('{', assignmentIndex + 1);
  if (objectStart === -1) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = objectStart; index < html.length; index += 1) {
    const char = html[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') depth += 1;

    if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        try {
          return JSON.parse(html.slice(objectStart, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function findMediaUrl(value, cleanUrl, seen = new WeakSet(), depth = 0) {
  if (depth > 10 || value == null) return null;

  if (typeof value === 'string') {
    const cleaned = cleanUrl(value);
    if (
      typeof cleaned === 'string' &&
      /^https?:\/\//i.test(cleaned) &&
      /\.m3u8(?:[?#]|$)/i.test(cleaned)
    ) {
      return cleaned;
    }
    return null;
  }

  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMediaUrl(item, cleanUrl, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const preferredKeys = [
    'url',
    'src',
    'hls',
    'h264',
    'av1',
    'mp4',
    'high',
    'medium',
    'low',
  ];
  const keys = Object.keys(value);
  const orderedKeys = [
    ...preferredKeys.filter(key => keys.includes(key)),
    ...keys.filter(key => !preferredKeys.includes(key)),
  ];

  for (const key of orderedKeys) {
    const found = findMediaUrl(value[key], cleanUrl, seen, depth + 1);
    if (found) return found;
  }

  return null;
}


function collectDirectMp4Sources(
  value,
  cleanUrl,
  path = [],
  results = [],
  seen = new WeakSet(),
  depth = 0
) {
  if (depth > 10 || value == null) return results;

  if (typeof value === 'string') {
    const cleaned = cleanUrl(value);

    if (
      typeof cleaned === 'string' &&
      /^https?:\/\//i.test(cleaned) &&
      /\.mp4(?:[?#]|$)/i.test(cleaned)
    ) {
      results.push({ url: cleaned, path });
    }

    return results;
  }

  if (typeof value !== 'object') return results;
  if (seen.has(value)) return results;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectDirectMp4Sources(
        item,
        cleanUrl,
        [...path, String(index)],
        results,
        seen,
        depth + 1
      )
    );
    return results;
  }

  for (const [key, child] of Object.entries(value)) {
    collectDirectMp4Sources(
      child,
      cleanUrl,
      [...path, key],
      results,
      seen,
      depth + 1
    );
  }

  return results;
}

function directMp4Resolution(candidate) {
  const context = candidate.path.join(' ');
  const resolution = extractResolution(context, candidate.url);
  return resolution ? Number.parseInt(resolution, 10) : null;
}

function isPlayableDirectMp4(candidate) {
  const context = candidate.path.join(' ');
  return isLikelyFullVideoMp4(candidate.url, {
    allowKnownVideoPath: true,
    context,
  }) && directMp4Resolution(candidate) !== null;
}

function directMp4Label(candidate) {
  const resolution = directMp4Resolution(candidate);
  return resolution ? `${resolution}p MP4` : 'MP4';
}

function isBlockedXhamsterHtml(html) {
  if (typeof html !== 'string' || html.length < 500) return true;
  return /cf-chl|just a moment|captcha|access denied|verify you are human/i.test(html);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    const cached = htmlCache.get(url);
    if (cached !== undefined) return cached;
    if (inFlight.has(url)) return inFlight.get(url);

    const promise = (async () => {
      let lastError;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          // Disable the shared HTML cache here so a HTTP 200 challenge page is
          // inspected before any xHamster response is cached.
          const html = await super.fetchHtml(url, { cache: false });
          if (isBlockedXhamsterHtml(html)) {
            throw new Error('xHamster returned a challenge or incomplete page');
          }

          htmlCache.set(url, html);
          return html;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await sleep(400 * 2 ** attempt);
        }
      }

      throw lastError || new Error('xHamster request failed');
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

  catalogBaseUrl(url) {
    return String(url || '').replace(/\/$/, '');
  }

  catalogPageUrl(baseUrl, page) {
    const base = this.catalogBaseUrl(baseUrl);
    return page <= 1 ? base : `${base}/${page}/`;
  }

  async handleCatalog(args) {
    if (args.type !== Provider.TYPE || !this.activate(args.id)) return { metas: [] };

    try {
      const extra = args.extra || {};
      let baseUrl = this.getInitialUrl(args.id);
      if (extra.search) baseUrl = this.handleSearch(args);
      else if (extra.genre) baseUrl = this.handleGenre(args);

      const skip = Math.max(0, Number(extra.skip || 0) || 0);
      const parsed = await this.fetchCatalog(baseUrl, extra.genre || '', skip);
      const metas = parsed.map(item => ({
        ...item,
        id: this.toStremioId(item.id),
      }));

      return { metas };
    } catch (error) {
      logger.warn({ error: error.message }, 'xHamster catalog request failed');
      return { metas: [] };
    }
  }

  async fetchCatalog(baseUrl, genreName, skip = 0) {
    const normalizedBase = this.catalogBaseUrl(baseUrl);
    const cacheKey = `${normalizedBase}|${genreName}|${skip}`;
    const cached = catalogCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const globalSeen = new Set();
    const allVideos = [];
    const targetEnd = skip + this.limit;
    const maxPages = Math.min(8, Math.max(2, Math.ceil(targetEnd / this.limit) + 2));

    for (let page = 1; page <= maxPages; page += 1) {
      try {
        const html = await this.fetchHtml(this.catalogPageUrl(normalizedBase, page));
        const videos = this.getCatalogMetas(html, globalSeen);
        allVideos.push(...videos);

        if (allVideos.length >= targetEnd) break;
        if (page > 1 && videos.length === 0) break;
      } catch (error) {
        logger.debug({ page, error: error.message }, 'xHamster catalog page failed');
        if (page === 1) throw error;
        break;
      }
    }

    if (allVideos.length < targetEnd && genreName) {
      const slug = this.toSlug(genreName);
      try {
        const apiUrl = `${this.baseUrl}/api/v4/videos?category=${encodeURIComponent(slug)}&size=100`;
        const json = await this.fetchJson(apiUrl, { cache: false });

        for (const video of json?.videos || []) {
          const url = normalizeAbsoluteUrl(video.url || video.pageURL, this.baseUrl);
          if (!url || !url.includes('/videos/') || globalSeen.has(url)) continue;

          const title = String(video.title || '').trim();
          const titleLower = title.toLowerCase();
          if (!title || video.isVR === true || /\bvr\b/.test(titleLower)) continue;
          if (titleLower.includes('virtual reality') || video.isVertical === true) continue;

          const poster = normalizeAbsoluteUrl(video.thumbURL || video.thumb, this.baseUrl);
          allVideos.push(
            new meta.MetaPreview(url, Provider.TYPE, title, poster, {
              posterShape: 'landscape',
            })
          );
          globalSeen.add(url);
          if (allVideos.length >= targetEnd) break;
        }
      } catch (error) {
        logger.debug({ error: error.message }, 'xHamster API backfill failed');
      }
    }

    const finalData = allVideos.slice(skip, targetEnd);
    if (finalData.length) catalogCache.set(cacheKey, finalData);
    return finalData;
  }

  getCatalogMetas(html, seen = new Set()) {
    if (!html || html.length < 1000) return [];

    const metadataList = [];

    const json = parseWindowInitials(html);

    if (json) {
      try {
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
          const pageUrl = normalizeAbsoluteUrl(v.pageURL, this.baseUrl);
          if (!pageUrl || seen.has(pageUrl)) continue;

          const poster = normalizeAbsoluteUrl(v.thumbURL || v.imageURL, this.baseUrl);

          metadataList.push(
            new meta.MetaPreview(
              pageUrl,
              'movie',
              v.title,
              poster,
              {
      posterShape: 'landscape'
    }
            )
          );

          seen.add(pageUrl);
        }

        // ✅ STOP if JSON worked
        if (metadataList.length) return metadataList;

      } catch {}
    }

    // 🔻 FALLBACK (only if JSON failed)
    const $ = load(html);

    $('.thumb-list__item, .video-thumb').each((_, el) => {
      const $a = $(el).find('a').first();

      const href = $a.attr('href');
      if (!href || !href.includes('/videos/')) return;

      const url = normalizeAbsoluteUrl(href, this.baseUrl);
      if (!url || seen.has(url)) return;

      seen.add(url);

      const $img = $a.find('img').first();

      const poster = normalizeAbsoluteUrl(
        $img.attr('data-src') || $img.attr('src'),
        this.baseUrl
      );

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
    if (cached !== undefined) return cached;

    const html = await this.fetchHtml(id);
    const data = this.parseVideoPage({ id, html });

    // Do not cache a temporary fallback-only response. This allows the next
    // request to recover immediately if xHamster briefly returns a block page.
    if (data?.videoPageUrl || data?.poster) {
      metaCache.set(id, data);
    }

    return data;
  }

  parseVideoPage({ id, html }) {
    const pageHtml = typeof html === 'string' ? html : '';
    const json = parseWindowInitials(pageHtml);
    const $ = load(pageHtml);

    let structuredData = null;
    $('script[type="application/ld+json"]').each((_, element) => {
      if (structuredData) return;

      try {
        const parsed = JSON.parse($(element).text());
        structuredData = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        // Ignore malformed structured-data blocks.
      }
    });

    const title =
      json?.videoEntity?.title ||
      json?.videoModel?.title ||
      structuredData?.name ||
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() ||
      this.titleFromId(id);

    const description =
      json?.videoModel?.description ||
      json?.videoEntity?.description ||
      structuredData?.description ||
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      title;

    const structuredImage = Array.isArray(structuredData?.thumbnailUrl)
      ? structuredData.thumbnailUrl[0]
      : structuredData?.thumbnailUrl || structuredData?.image;

    const poster = normalizeAbsoluteUrl(
      json?.videoModel?.thumbURL ||
        json?.videoEntity?.thumbURL ||
        structuredImage ||
        $('meta[property="og:image"]').attr('content'),
      this.baseUrl
    );

    // Prefer direct MP4 files over HLS. xHamster's AV1 HLS media
    // playlists use nested relative init/segment paths such as
    // `480p.av1.mp4/init-v1-a1.mp4`. AIOStreams' built-in proxy route does
    // not accept those nested paths and returns 404 before reaching xhcdn.
    // Direct MP4 files avoid that proxy-path limitation entirely.
    const directMp4Candidates = collectDirectMp4Sources(
      json?.xplayerSettings?.sources?.mp4,
      value => this.cleanUrl(value)
    );

    // xHamster has moved MP4 source objects between releases. Scan the full
    // player payload too, while the collector still accepts only real .mp4
    // URLs (and therefore ignores .mp4.m3u8 AV1 playlists).
    collectDirectMp4Sources(
      json,
      value => this.cleanUrl(value),
      ['window.initials'],
      directMp4Candidates
    );

    // Also recover escaped absolute MP4 URLs directly from the page source.
    for (const match of pageHtml.matchAll(
      /https?:\\?\/\\?\/[^\s"'<>]+?\.mp4(?:\?[^\s"'<>]*)?/gi
    )) {
      const cleaned = this.cleanUrl(match[0]);
      if (cleaned?.startsWith('http')) {
        directMp4Candidates.push({
          url: cleaned,
          path: ['pageHtml'],
        });
      }
    }

    if (structuredData?.contentUrl) {
      collectDirectMp4Sources(
        structuredData.contentUrl,
        value => this.cleanUrl(value),
        ['structuredData', 'contentUrl'],
        directMp4Candidates
      );
    }

    // The page payload also contains tiny animated thumbnail MP4s such as
    // `thumb-v4.xhcdn.com/.../526x298...t.mp4`. They are only a few seconds
    // long and must never be exposed as playable streams. Keep only genuine
    // quality-labelled video files and one URL per resolution.
    const byResolution = new Map();

    for (const candidate of directMp4Candidates) {
      if (!isPlayableDirectMp4(candidate)) continue;

      const resolution = directMp4Resolution(candidate);
      if (!byResolution.has(resolution)) {
        byResolution.set(resolution, candidate);
      }
    }

    const directMp4Streams = [...byResolution.entries()]
      .sort(([left], [right]) => right - left)
      .map(([, candidate]) =>
        this.withPlaybackHeaders({
          type: Provider.TYPE,
          url: candidate.url,
          name: directMp4Label(candidate),
        })
      );

    // H.264 is preferred over AV1 when no direct MP4 source exists. This is
    // only a fallback; the direct MP4 path above is the compatible path for
    // AIOStreams' built-in proxy.
    const sourceCandidates = [
      json?.xplayerSettings?.sources?.hls?.h264?.url,
      json?.xplayerSettings?.sources?.hls?.url,
      json?.xplayerSettings?.sources?.hls?.av1?.url,
    ];

    let streamUrl = directMp4Streams[0]?.url || sourceCandidates
      .map(source => (typeof source === 'string' ? this.cleanUrl(source) : null))
      .find(source => typeof source === 'string' && source.startsWith('http') && isHls(source));

    if (!streamUrl && json) {
      const found = findMediaUrl(json, value => this.cleanUrl(value));
      if (found && isHls(found)) streamUrl = found;
    }

    if (!streamUrl) {
      const escapedMediaMatch = pageHtml.match(
        /https?:\?\/\?\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/i
      );

      if (escapedMediaMatch) {
        const cleaned = this.cleanUrl(escapedMediaMatch[0]);
        if (cleaned?.startsWith('http') && isHls(cleaned)) streamUrl = cleaned;
      }
    }

    // Always return a structurally valid Stremio meta object. Previously an
    // unrecognized page returned {}, which AIOStreams rejected because id and
    // type were undefined.
    const response = new meta.MetaResponse(id, Provider.TYPE, title, {
      videoPageUrl: streamUrl,
      description,
      poster,
      background: poster,
      posterShape: 'landscape',
      genres: []
    });

    // Provider.processStreams reads this property, but it must not be emitted
    // in the metadata JSON returned to Stremio.
    if (directMp4Streams.length) {
      Object.defineProperty(response, 'streams', {
        value: directMp4Streams,
        enumerable: false,
        configurable: true,
      });
    }

    return response;
  }

  async processStreams({ id }) {
    const html = await this.fetchHtml(id);
    const parsed = this.parseVideoPage({ id, html });

    if (!parsed) return { streams: [] };

    // Critical ordering: the shared Provider.processStreams() scans the raw
    // HTML for the first .m3u8 before calling parseVideoPage(). On xHamster
    // that always short-circuits to AV1 HLS, so the direct MP4 selection in
    // parseVideoPage() was never reached.
    if (parsed.streams?.length) {
      return { streams: parsed.streams };
    }

    if (/\.mp4(?:[?#]|$)/i.test(parsed.videoPageUrl || '')) {
      return {
        streams: [
          this.withPlaybackHeaders({
            type: Provider.TYPE,
            url: parsed.videoPageUrl,
            name: 'MP4',
          }),
        ],
      };
    }

    // Do not expose xHamster's nested AV1 HLS media playlists through the
    // AIOStreams built-in proxy: their relative init/segment subpaths are
    // rejected by that route. Returning no stream is safer than returning a
    // guaranteed broken item.
    return { streams: [] };
  }

  titleFromId(id) {
    try {
      const slug = new URL(id).pathname.split('/').filter(Boolean).pop() || '';
      const cleaned = decodeURIComponent(slug)
        .replace(/-xh[a-z0-9]+$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();

      return cleaned
        ? cleaned.replace(/\b\w/g, char => char.toUpperCase())
        : 'xHamster video';
    } catch {
      return 'xHamster video';
    }
  }

  withPlaybackHeaders(stream) {
    return {
      ...stream,
      behaviorHints: {
        ...(stream.behaviorHints || {}),
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

  transformStream(baseUrl, stream) {
    const resolvedStream = super.transformStream(baseUrl, stream);
    return this.withPlaybackHeaders(resolvedStream);
  }
}

const create = XhamsterProvider.create;
create._test = {
  directMp4Resolution,
  isBlockedXhamsterHtml,
  isPlayableDirectMp4,
  parseWindowInitials,
};
module.exports = create;
