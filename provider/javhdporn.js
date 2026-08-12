const { load } = require('cheerio');
const logger = require('../logger');
const { javPosterProxyUrl } = require('./javhdporn-poster-proxy');
const BoundedTtlCache = require('./cache');
const mediaRelay = require('../media-relay');
const { meta } = require('../model');
const Provider = require('./provider');
const safariImpersonation = require('./javhdporn-safari-impersonation');
const { dex } = require('./javhdporn-player');
const {
  captureJwPlayerSources,
  getPlayerConfigMetadata,
  isJavPlayerHost,
} = require('./javhdporn-jw-config');
const {
  cleanMediaUrl,
  extractResolution,
  isDirectMp4,
  isHls,
  isPreviewMediaCandidate,
  normalizeAbsoluteUrl,
} = require('./media-utils');
const {
  findVideoObject,
  firstString,
  parseStructuredDataBlocks,
} = require('./structured-data');
const { assertSafeHttpsUrl, sanitizeUrlForLogs } = require('./url-security');

const PLAYBACK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const DEFAULT_POSTER = 'https://pics.pornfhd.com/404.jpeg';
const MAX_PLAYER_PAGES = 12;
const MAX_PLAYER_DEPTH = 3;
const PLAYER_SCRIPT_MAX_BYTES = 1024 * 1024;

const GENRE_ROUTES = new Map([
  ['Latest', '/v3/category/censored/'],
  ['Censored', '/v3/category/censored/'],
  ['Most Viewed', '/v3/category/censored/filter/most-viewed/'],
  ['English Subtitle', '/v2/category/censored/english-subtitle/'],
  ['Chinese Subtitle', '/v4/category/chinese-subtitle/'],
  ['Subtitle Indonesia', '/category/subtitle-indonesia/'],
  ['Uncensored', '/v2/category/uncensored/'],
  ['FC2 PPV', '/v1/category/uncensored/fc2-ppv/'],
  ['Tokyo Hot', '/category/uncensored/tokyo-hot/'],
  ['Amateur', '/category/amateur/'],
]);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanTitle(value) {
  return cleanText(value)
    .replace(/\s*[-|–]\s*JAV\s*HD\s*Porn\s*$/i, '')
    .trim();
}

function subtitleCanonicalPlaybackUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      (host !== 'javhdporn.net' && host !== 'www.javhdporn.net')
    ) {
      return '';
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const videoIndex = parts.lastIndexOf('video');
    if (videoIndex < 0 || videoIndex !== parts.length - 2) return '';

    const slug = parts[parts.length - 1];
    if (!/-sub$/i.test(slug)) return '';

    parts[parts.length - 1] = slug.replace(/-sub$/i, '');
    url.pathname = `/${parts.join('/')}/`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizePoster(value, baseUrl) {
  const url = normalizeAbsoluteUrl(value, baseUrl);
  if (!url || /^data:/i.test(url)) return DEFAULT_POSTER;
  return url;
}

function normalizePosterCandidate(value, baseUrl) {
  const raw = cleanText(value);
  if (!raw || /^(?:data|blob|javascript):/i.test(raw)) return '';
  const url = normalizeAbsoluteUrl(raw, baseUrl);
  if (!url || /^(?:data|blob|javascript):/i.test(url)) return '';
  return url;
}

function posterFromSrcset(value, baseUrl) {
  const entries = String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  let best = '';
  let bestScore = -1;
  entries.forEach((entry, index) => {
    const match = entry.match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?/i);
    if (!match) return;
    const url = normalizePosterCandidate(match[1], baseUrl);
    if (!url) return;
    const amount = Number(match[2] || 0);
    const unit = String(match[3] || '').toLowerCase();
    const score = unit === 'w'
      ? amount
      : unit === 'x'
        ? amount * 10_000
        : index;
    if (score >= bestScore) {
      best = url;
      bestScore = score;
    }
  });
  return best;
}

function extractCatalogPoster($, root, pageUrl) {
  const image = root.find('img').first();
  const directAttrs = [
    'data-lazy-src',
    'data-src',
    'data-wpsrc',
    'data-original',
    'data-lazy',
    'data-thumb',
    'data-image',
    'data-poster',
  ];
  for (const attr of directAttrs) {
    const candidate = normalizePosterCandidate(image.attr(attr), pageUrl);
    if (candidate) return candidate;
  }

  let bestSrcset = '';
  const srcsetValues = [
    image.attr('data-lazy-srcset'),
    image.attr('data-srcset'),
    image.attr('srcset'),
  ];
  root.find('picture source, source').each((_, element) => {
    const source = $(element);
    srcsetValues.push(
      source.attr('data-lazy-srcset'),
      source.attr('data-srcset'),
      source.attr('srcset')
    );
  });
  for (const value of srcsetValues) {
    const candidate = posterFromSrcset(value, pageUrl);
    if (candidate) bestSrcset = candidate;
  }
  if (bestSrcset) return bestSrcset;

  const src = normalizePosterCandidate(image.attr('src'), pageUrl);
  if (src) return src;

  const styled = image.add(root.find('[style*="background"]').first());
  for (const element of styled.toArray()) {
    const style = String($(element).attr('style') || '');
    const match = style.match(/(?:background(?:-image)?\s*:[^;]*url\(\s*['"]?)([^'")\s]+)[^)]*\)/i);
    const candidate = normalizePosterCandidate(match?.[1], pageUrl);
    if (candidate) return candidate;
  }

  return DEFAULT_POSTER;
}

function structuredDataFromPage($) {
  return parseStructuredDataBlocks(
    $('script[type="application/ld+json"]')
      .toArray()
      .map(element => $(element).text())
  );
}

function isoDurationToRuntime(value) {
  const match = String(value || '').match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
  );
  if (!match) return '';
  const minutes =
    (Number(match[1] || 0) * 24 * 60) +
    (Number(match[2] || 0) * 60) +
    Number(match[3] || 0) +
    Math.ceil(Number(match[4] || 0) / 60);
  return minutes > 0 ? `${minutes} min` : '';
}

function normalizeSourceValue(value, baseUrl) {
  if (typeof value !== 'string') return '';
  const cleaned = cleanMediaUrl(value).replace(/^['"]|['"]$/g, '');
  if (!cleaned || /^(?:javascript|data|blob):/i.test(cleaned)) return '';
  const looksLikeUrl =
    /^(?:https?:)?\/\//i.test(cleaned) ||
    /^\.?\//.test(cleaned) ||
    /\.(?:html?|php|m3u8|mp4)(?:[?#]|$)/i.test(cleaned);
  if (!looksLikeUrl) return '';
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  return normalizeAbsoluteUrl(cleaned, baseUrl);
}

function isFallbackPlayerUrl(value) {
  const lower = String(value || '').toLowerCase();
  return (
    /\/(?:black|white|ban|blocked|unavailable)\.html(?:[?#]|$)/i.test(lower) ||
    lower.includes('streaming-service-is-unavailable')
  );
}

function isAdvertisementMedia(value, context = '') {
  const text = `${value} ${context}`.toLowerCase();
  return (
    isPreviewMediaCandidate(value, context) ||
    /(?:^|[\/_-])(?:ad|ads|advert|banner|preroll|promo)(?:[\/_-]|$)/i.test(text) ||
    /(?:300x250|728x90|970x90|medium\.mp4|overlay-preview)/i.test(text)
  );
}

function isLikelyPlayerPage(value, context = '') {
  if (isHls(value) || isDirectMp4(value)) return true;
  const text = `${value} ${context}`.toLowerCase();
  return (
    /(?:iframe|player api|reserve|embed)/i.test(context) ||
    /(?:^|[.\/_-])(?:player|embed|video|stream|watch|play)(?:[.\/_-]|$)/i.test(text) ||
    /\.(?:html?|php)(?:[?#]|$)/i.test(value)
  );
}

function collectStrings(value, output = [], context = '') {
  if (typeof value === 'string') {
    output.push({ value, context });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, output, `${context}[${index}]`));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, item] of Object.entries(value)) {
    collectStrings(item, output, context ? `${context}.${key}` : key);
  }
  return output;
}

function decodeReservePlayers(reserve, bootstrap, videoPageUrl) {
  const values = Array.isArray(reserve) ? reserve : [reserve];
  const output = [];

  values.forEach((item, index) => {
    if (typeof item === 'string') {
      const direct = normalizeSourceValue(item, videoPageUrl);
      if (direct) output.push({ value: direct, context: `reserve[${index}]` });
      return;
    }
    if (!item || typeof item !== 'object' || typeof item.data !== 'string') return;

    const decrypted = dex(
      bootstrap.videoId,
      item.data,
      false,
      bootstrap.version
    );
    const url = normalizeSourceValue(decrypted, videoPageUrl);
    if (!url) return;

    const locale = cleanText(item.lo);
    output.push({
      value: url,
      context: locale ? `reserve[${index}] ${locale}` : `reserve[${index}]`,
    });
  });

  return output;
}

function extractPlayerCandidates(html, pageUrl) {
  const $ = load(String(html || ''));
  const candidates = [];
  const add = (value, context) => {
    const url = normalizeSourceValue(value, pageUrl);
    if (
      !url ||
      isFallbackPlayerUrl(url) ||
      isAdvertisementMedia(url, context) ||
      !isLikelyPlayerPage(url, context)
    ) return;
    candidates.push({ url, context });
  };

  $('iframe[src], video[src], source[src]').each((_, element) => {
    const tag = element.tagName || element.name || 'element';
    add($(element).attr('src'), `${tag} src`);
  });
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (/(?:embed|player|stream|watch|play)|\.(?:m3u8|mp4)(?:[?#]|$)/i.test(href || '')) {
      add(href, 'player anchor');
    }
  });

  const scripts = $('script')
    .toArray()
    .map(element => $(element).html() || '')
    .join('\n');
  const combined = `${String(html || '')}\n${scripts}`;

  const patterns = [
    /(?:file|src|url|hls|playlist|contentUrl|embedUrl)\s*[:=]\s*['"]([^'"]+)['"]/gi,
    /(?:setVideoHLS|setVideoUrlHigh|setVideoUrlLow)\s*\(\s*['"]([^'"]+)['"]/gi,
    /((?:https?:)?\/\/[^\s'"<>\\]+(?:\.m3u8|\.mp4)(?:\?[^\s'"<>\\]*)?)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(combined)) !== null) add(match[1], 'player script');
  }

  const structured = structuredDataFromPage($);
  for (const object of structured) {
    for (const key of ['contentUrl', 'embedUrl']) {
      const values = Array.isArray(object?.[key]) ? object[key] : [object?.[key]];
      values.forEach(value => add(value, `json-ld ${key}`));
    }
  }

  const unique = new Map();
  for (const candidate of candidates) {
    if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  }
  return [...unique.values()];
}

function prioritizePlayerCandidates(queue, visited, candidates, referer, depth) {
  const queued = new Set(queue.map(item => item?.url).filter(Boolean));
  const pending = [];

  for (const candidate of candidates) {
    if (
      !candidate?.url ||
      visited.has(candidate.url) ||
      queued.has(candidate.url)
    ) continue;

    queued.add(candidate.url);
    pending.push({
      url: candidate.url,
      context: candidate.context,
      referer,
      depth,
    });
  }

  // A decoded media URL may be extensionless or disguised. Inspect it before
  // spending the remaining 12-page budget on more reserve-player pages, while
  // preserving every fallback already in the queue.
  if (pending.length) queue.unshift(...pending);
}

class JavHdPornProvider extends Provider {
  constructor() {
    super('https://www.javhdporn.net', 'javhdporn', 24, {
      allowedPageHosts: ['javhdporn.net', 'video.javhdporn.net'],
    });
    this.playerScriptCache = new BoundedTtlCache({
      maxEntries: 12,
      ttlMs: 15 * 60 * 1000,
    });
  }

  approveDynamicPlayerHost(url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (isJavPlayerHost(hostname)) this.allowedPageHosts.add(hostname);
      return hostname;
    } catch {
      return '';
    }
  }

  static create() {
    return new JavHdPornProvider();
  }

  getInitialUrl() {
    return `${this.baseUrl}/v3/category/censored/`;
  }

  async fetchSafariResponse(url, options = {}) {
    this.approveDynamicPlayerHost(url);
    const safeUrl = await assertSafeHttpsUrl(url, {
      allowedHosts: this.allowedPageHosts,
    });
    const response = await safariImpersonation.fetchText(safeUrl, {
      method: options.method || 'GET',
      data: options.data,
      headers: options.headers || {},
      timeoutMs: options.timeoutMs || 30_000,
      maxBytes: options.maxBytes || 6 * 1024 * 1024,
    });

    logger.debug(
      {
        provider: this.name,
        url: sanitizeUrlForLogs(response.finalUrl || safeUrl),
        status: response.status,
        cfRay: response.headers?.['cf-ray'],
      },
      'JAVHDPorn Safari request succeeded'
    );
    return response;
  }

  async fetchHtml(url, requestOptions = {}) {
    const cacheKey = requestOptions.cacheKey || `jav-safari-html:${url}`;
    if (requestOptions.cache !== false) {
      const cached = this.htmlCache.get(cacheKey);
      if (cached !== undefined) return cached;
    }

    const pendingKey = `jav-safari:text:${cacheKey}`;
    if (this.pendingRequests.has(pendingKey)) {
      return this.pendingRequests.get(pendingKey);
    }

    const operation = (async () => {
      try {
        const response = await this.fetchSafariResponse(url, requestOptions);
        const html = String(response.data || '');
        if (requestOptions.cache !== false) this.htmlCache.set(cacheKey, html);
        return html;
      } catch (error) {
        logger.warn(
          { provider: this.name, url: sanitizeUrlForLogs(url), error: error.message },
          'JAVHDPorn Safari request failed'
        );
        throw error;
      }
    })();

    this.pendingRequests.set(pendingKey, operation);
    try {
      return await operation;
    } finally {
      this.pendingRequests.delete(pendingKey);
    }
  }

  async fetchSafariJson(url, options = {}) {
    this.approveDynamicPlayerHost(url);
    const safeUrl = await assertSafeHttpsUrl(url, {
      allowedHosts: this.allowedPageHosts,
    });
    const response = await safariImpersonation.fetchJson(safeUrl, {
      method: options.method || 'GET',
      data: options.data,
      headers: options.headers || {},
      timeoutMs: options.timeoutMs || 30_000,
      maxBytes: options.maxBytes || 2 * 1024 * 1024,
    });
    return response.data;
  }

  handleSearch({ extra: { search } }) {
    const url = new URL(this.baseUrl);
    url.searchParams.set('s', cleanText(search));
    return url.toString();
  }

  handleGenre({ extra: { genre } }) {
    const route = GENRE_ROUTES.get(cleanText(genre)) || GENRE_ROUTES.get('Latest');
    return new URL(route, this.baseUrl).toString();
  }

  handlePagination(url, { extra: { skip, search } }) {
    const page = Number(this.page(skip));
    if (page <= 1) return url;

    const parsed = new URL(url, this.baseUrl);
    if (search || parsed.searchParams.has('s')) {
      parsed.searchParams.set('paged', String(page));
      return parsed.toString();
    }

    parsed.pathname = `${parsed.pathname.replace(/\/?$/, '/') }page/${page}/`.replace(/\/{2,}/g, '/');
    return parsed.toString();
  }

  getCatalogMetas(html, pageUrl = this.baseUrl) {
    const $ = load(html);
    const results = [];
    const seen = new Set();

    $('article.thumb-block, .thumb-block.loop-video, .loop-video').each((_, element) => {
      const root = $(element);
      const anchor = root.find('a[href*="/video/"]').first();
      const href = anchor.attr('href');
      if (!href) return;

      let id;
      try {
        const parsed = new URL(href, pageUrl);
        if (
          parsed.protocol !== 'https:' ||
          !this.allowedPageHosts.has(parsed.hostname.toLowerCase()) ||
          !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?video\//i.test(parsed.pathname)
        ) return;
        parsed.search = '';
        parsed.hash = '';
        id = parsed.toString();
      } catch {
        return;
      }
      if (seen.has(id)) return;
      seen.add(id);

      const image = root.find('img').first();
      const poster = javPosterProxyUrl(extractCatalogPoster($, root, pageUrl));
      if (/\/fallback\.png$/i.test(poster)) return;
      const title = cleanTitle(
        anchor.attr('title') ||
          image.attr('alt') ||
          root.find('h2, h3, .title, .video-title').first().text() ||
          anchor.text() ||
          'JAV video'
      );
      const description = cleanText(
        root.find('.duration, .video-duration, .thumb-duration').first().text()
      );

      results.push(
        new meta.MetaPreview(id, Provider.TYPE, title, poster, {
          posterShape: 'landscape',
          description,
          videoPageUrl: id,
        })
      );
    });

    return results.slice(0, this.limit);
  }

  metadataFromPage(id, html) {
    const $ = load(html);
    const structured = structuredDataFromPage($);
    const videoObject = findVideoObject(structured);
    const article = structured.find(object => String(object?.['@type']).toLowerCase() === 'article');

    const title = cleanTitle(
      videoObject?.name ||
        article?.headline ||
        $('meta[property="og:title"]').attr('content') ||
        $('h1').first().text() ||
        'JAV HD Porn video'
    );
    const poster = normalizePoster(
      firstString(videoObject?.thumbnailUrl) ||
        firstString(videoObject?.image) ||
        $('meta[property="og:image"]').attr('content') ||
        $('#video-player img').attr('data-lazy-src') ||
        $('#video-player img').attr('src'),
      id
    );
    const keywords = [
      ...(Array.isArray(videoObject?.keywords) ? videoObject.keywords : [videoObject?.keywords]),
      ...(Array.isArray(article?.keywords) ? article.keywords : [article?.keywords]),
      ...(Array.isArray(article?.articleSection) ? article.articleSection : [article?.articleSection]),
    ]
      .map(cleanText)
      .filter(Boolean);
    const actors = (Array.isArray(videoObject?.actor) ? videoObject.actor : [videoObject?.actor])
      .map(actorValue => cleanText(actorValue?.name || actorValue))
      .filter(Boolean);

    const links = [];
    $('a[href*="/tag/"], a[href*="/pornstar/"], a[href*="/studio/"]').each((_, element) => {
      const name = cleanText($(element).text());
      const href = $(element).attr('href');
      if (!name || !href) return;
      links.push(new meta.MetaLink(name, href.includes('/pornstar/') ? 'Actor' : 'Genre', new URL(href, id).toString()));
    });

    const response = new meta.MetaResponse(id, Provider.TYPE, title, {
      links,
      description: cleanText(videoObject?.description || $('meta[name="description"]').attr('content') || title),
      poster,
      background: poster,
      posterShape: 'landscape',
      genres: [...new Set(keywords)],
      extra: {
        playerVideoId: $('#video-player-area').attr('data-video-id') || '',
        playerMpu: $('#video-player').attr('data-mpu') || '',
        playerVersion: $('#video-player').attr('data-ver') || '1',
      },
    });

    const runtime = isoDurationToRuntime(videoObject?.duration);
    if (runtime) response.runtime = runtime;
    const date = videoObject?.uploadDate || videoObject?.datePublished || article?.datePublished;
    if (date) response.releaseInfo = String(date).slice(0, 4);
    if (actors.length) response.cast = actors;

    return response;
  }

  async getMetadata({ id }) {
    const html = await this.fetchHtml(id);
    return this.metadataFromPage(id, html);
  }

  playerBootstrap(html) {
    const $ = load(html);
    return {
      videoId: cleanText($('#video-player-area').attr('data-video-id')),
      mpu: cleanText($('#video-player').attr('data-mpu')),
      version: cleanText($('#video-player').attr('data-ver')) || '1',
    };
  }

  async requestPlayerSources(videoPageUrl, bootstrap) {
    const sources = dex(
      bootstrap.videoId,
      bootstrap.mpu,
      true,
      bootstrap.version
    );
    if (!sources) return [];

    const body = new URLSearchParams({
      sources,
      ver: bootstrap.version,
    }).toString();
    const data = await this.fetchSafariJson(`${this.baseUrl}/api/play/`, {
      method: 'POST',
      data: body,
      cache: false,
      cacheKey: `jav-play:${bootstrap.videoId}:${bootstrap.version}`,
      headers: {
        Referer: videoPageUrl,
        Origin: this.baseUrl,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });

    if (!data || data.status === false || data.status === 0 || data.status === '0') {
      logger.warn({ provider: this.name }, 'JAVHDPorn player API reported unavailable media');
      return [];
    }

    const primaryCandidates = [];
    const reserveCandidates = [];
    if (typeof data.data === 'string') {
      const decrypted = dex(bootstrap.videoId, data.data, false, bootstrap.version);
      const primary = normalizeSourceValue(decrypted, videoPageUrl) ? decrypted : data.data;
      if (primary) primaryCandidates.push({ value: primary, context: data.lo || 'primary' });
    } else if (data.data && typeof data.data === 'object') {
      collectStrings(data.data, primaryCandidates, data.lo || 'primary');
    }
    if (typeof data.reserve === 'string' && data.reserve) {
      const reserveText = dex(bootstrap.videoId, data.reserve, false, bootstrap.version);
      try {
        const reserve = JSON.parse(reserveText);
        reserveCandidates.push(
          ...decodeReservePlayers(reserve, bootstrap, videoPageUrl)
        );
      } catch (error) {
        if (normalizeSourceValue(reserveText, videoPageUrl)) {
          reserveCandidates.push({ value: reserveText, context: 'reserve' });
        }
        logger.debug({ provider: this.name, error: error.message }, 'JAVHDPorn reserve player data was not JSON');
      }
    }

    // Reserve players are evaluated first because production testing showed the
    // primary player can resolve to a Render-blocked CDN while reserve[0]
    // resolves to the working streamhls/TikTok relay path.
    const decoded = [...reserveCandidates, ...primaryCandidates];
    logger.debug(
      {
        provider: this.name,
        decodedCandidates: decoded.length,
        reservePlayers: reserveCandidates.length,
      },
      'JAVHDPorn player API decoded'
    );
    return decoded;
  }

  async encryptedJwPlayerCandidates(html, playerUrl) {
    const metadata = getPlayerConfigMetadata(html, playerUrl);
    if (!metadata.encryptedConfig || !metadata.mainScriptUrl) return [];

    this.approveDynamicPlayerHost(metadata.mainScriptUrl);
    let mainScript = this.playerScriptCache.get(metadata.mainScriptUrl);
    if (mainScript === undefined) {
      const headers = await this.playbackHeaders(playerUrl, metadata.mainScriptUrl);
      const response = await this.fetchSafariResponse(metadata.mainScriptUrl, {
        headers,
        maxBytes: PLAYER_SCRIPT_MAX_BYTES,
      });
      mainScript = String(response.data || '');
      this.playerScriptCache.set(metadata.mainScriptUrl, mainScript);
    }

    const captured = await captureJwPlayerSources({
      html,
      script: mainScript,
      playerUrl,
    });
    if (captured.executionWarning) {
      logger.debug(
        { provider: this.name, warning: captured.executionWarning },
        'JAVHDPorn JWPlayer decoder completed with a non-fatal warning'
      );
    }
    logger.debug(
      { provider: this.name, jwSources: captured.sources.length },
      'JAVHDPorn encrypted JWPlayer configuration decoded'
    );

    return captured.sources.map(source => ({
      url: source.url,
      context: source.label || source.type || 'JWPlayer source',
    }));
  }

  async playbackHeaders(referer, mediaUrl = referer) {
    const headers = {
      Referer: referer || `${this.baseUrl}/`,
      Origin: (() => {
        try { return new URL(referer || this.baseUrl).origin; } catch { return this.baseUrl; }
      })(),
      'User-Agent': PLAYBACK_USER_AGENT,
    };

    const safariCookie = safariImpersonation.getCookieHeader();
    if (safariCookie) {
      headers.Cookie = safariCookie;
    } else if (typeof this.jar?.getCookieString === 'function') {
      try {
        const cookie = await this.jar.getCookieString(mediaUrl || this.baseUrl);
        if (cookie) headers.Cookie = cookie;
      } catch {
        // Cookie forwarding is best effort.
      }
    }
    return headers;
  }

  async discoverMedia(initial, videoPageUrl) {
    const queue = [];
    for (const item of initial) {
      const url = normalizeSourceValue(item.value, videoPageUrl);
      if (url && !isFallbackPlayerUrl(url) && !isAdvertisementMedia(url, item.context)) {
        queue.push({ url, context: item.context || 'player API', referer: videoPageUrl, depth: 0 });
      }
    }

    const visited = new Set();
    const media = new Map();

    while (queue.length && visited.size < MAX_PLAYER_PAGES) {
      const item = queue.shift();
      if (!item || visited.has(item.url)) continue;
      visited.add(item.url);

      if (isHls(item.url) || isDirectMp4(item.url)) {
        if (!isAdvertisementMedia(item.url, item.context)) {
          media.set(item.url, { ...item, kind: isHls(item.url) ? 'hls' : 'mp4' });
        }
        continue;
      }
      if (item.depth >= MAX_PLAYER_DEPTH) continue;

      try {
        this.approveDynamicPlayerHost(item.url);
        const safeUrl = await assertSafeHttpsUrl(item.url);
        const headers = await this.playbackHeaders(item.referer, safeUrl);

        const candidateHost = new URL(safeUrl).hostname.toLowerCase();
        const useSafari = this.allowedPageHosts.has(candidateHost);

        try {
          const probe = useSafari
            ? await this.fetchSafariResponse(safeUrl, {
                method: 'HEAD',
                headers,
                maxBytes: 1024,
              })
            : await this.request(safeUrl, {
                method: 'HEAD',
                responseType: 'text',
                allowedHosts: null,
                cache: null,
                retries: 0,
                headers,
              });
          const contentType = String(probe.headers?.['content-type'] || '').toLowerCase();
          if (/mpegurl|application\/vnd\.apple/i.test(contentType)) {
            media.set(probe.finalUrl, { ...item, url: probe.finalUrl, kind: 'hls' });
            continue;
          }
          if (/video\/mp4/i.test(contentType)) {
            media.set(probe.finalUrl, { ...item, url: probe.finalUrl, kind: 'mp4' });
            continue;
          }
        } catch {
          // Some player/CDN routes reject HEAD while accepting a normal GET.
        }

        const html = useSafari
          ? String((await this.fetchSafariResponse(safeUrl, {
              headers,
              maxBytes: 6 * 1024 * 1024,
            })).data || '')
          : await this.fetchMediaText(safeUrl, {
              cache: false,
              headers,
            });
        if (/sorry\s+streaming\s+service\s+is\s+unavailable/i.test(html)) continue;
        if (String(html).includes('#EXTM3U')) {
          media.set(safeUrl, { ...item, url: safeUrl, kind: 'hls' });
          continue;
        }

        let encryptedCandidates = [];
        if (useSafari && isJavPlayerHost(candidateHost)) {
          try {
            encryptedCandidates = await this.encryptedJwPlayerCandidates(html, safeUrl);
          } catch (error) {
            logger.debug(
              { provider: this.name, url: sanitizeUrlForLogs(safeUrl), error: error.message },
              'JAVHDPorn encrypted player configuration was not decoded'
            );
          }
        }

        prioritizePlayerCandidates(
          queue,
          visited,
          [
            ...encryptedCandidates,
            ...extractPlayerCandidates(html, safeUrl),
          ],
          safeUrl,
          item.depth + 1
        );
      } catch (error) {
        logger.debug(
          { provider: this.name, url: sanitizeUrlForLogs(item.url), error: error.message },
          'JAVHDPorn player candidate was not readable'
        );
      }
    }

    return [...media.values()];
  }

  async streamFromMedia(candidate) {
    const headers = await this.playbackHeaders(candidate.referer, candidate.url);
    const resolution = extractResolution(candidate.context, candidate.url);
    const name = `JAV HD Porn ${resolution || (candidate.kind === 'hls' ? 'HLS' : 'MP4')}`;

    try {
      return {
        type: Provider.TYPE,
        url: mediaRelay.register({
          url: candidate.url,
          headers,
          provider: this.name,
          kind: candidate.kind,
        }),
        name,
        behaviorHints: { notWebReady: false },
      };
    } catch (error) {
      logger.debug(
        {
          provider: this.name,
          url: sanitizeUrlForLogs(candidate.url),
          error: error.message,
        },
        'JAVHDPorn media candidate was rejected by the protected relay'
      );
      return null;
    }
  }

  async processStreams({ id }) {
    try {
      let videoPageUrl = id;
      let html = await this.fetchHtml(videoPageUrl, { cache: false });
      let bootstrap = this.playerBootstrap(html);

      const canonicalFallback = subtitleCanonicalPlaybackUrl(videoPageUrl);
      if ((!bootstrap.videoId || !bootstrap.mpu) && canonicalFallback) {
        try {
          const fallbackHtml = await this.fetchHtml(canonicalFallback, { cache: false });
          const fallbackBootstrap = this.playerBootstrap(fallbackHtml);
          if (fallbackBootstrap.videoId && fallbackBootstrap.mpu) {
            logger.info(
              {
                provider: this.name,
                subtitleUrl: sanitizeUrlForLogs(videoPageUrl),
                canonicalUrl: sanitizeUrlForLogs(canonicalFallback),
              },
              'JAVHDPorn subtitle card recovered through canonical player page'
            );
            videoPageUrl = canonicalFallback;
            html = fallbackHtml;
            bootstrap = fallbackBootstrap;
          }
        } catch (error) {
          logger.debug(
            {
              provider: this.name,
              canonicalUrl: sanitizeUrlForLogs(canonicalFallback),
              error: error.message,
            },
            'JAVHDPorn canonical subtitle fallback was unavailable'
          );
        }
      }

      if (!bootstrap.videoId || !bootstrap.mpu) return { streams: [] };

      const apiSources = await this.requestPlayerSources(videoPageUrl, bootstrap);
      const media = await this.discoverMedia(apiSources, videoPageUrl);
      logger.debug(
        { provider: this.name, mediaCandidates: media.length },
        'JAVHDPorn media discovery completed'
      );
      const streams = (await Promise.all(
        media.map(candidate => this.streamFromMedia(candidate))
      )).filter(Boolean);
      streams.sort((left, right) =>
        (Number.parseInt(extractResolution(right.name), 10) || 0) -
        (Number.parseInt(extractResolution(left.name), 10) || 0)
      );
      return { streams };
    } catch (error) {
      logger.warn({ provider: this.name, error: error.message }, 'JAVHDPorn stream extraction failed');
      return { streams: [] };
    }
  }
}

const create = JavHdPornProvider.create;
create._test = {
  GENRE_ROUTES,
  cleanTitle,
  extractPlayerCandidates,
  isAdvertisementMedia,
  isFallbackPlayerUrl,
  isLikelyPlayerPage,
  isoDurationToRuntime,
  normalizePoster,
  normalizePosterCandidate,
  posterFromSrcset,
  subtitleCanonicalPlaybackUrl,
  extractCatalogPoster,
  normalizeSourceValue,
  prioritizePlayerCandidates,
  decodeReservePlayers,
  isJavPlayerHost,
};
module.exports = create;
