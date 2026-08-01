'use strict';

const { hasStrongChallengeMarker } = require('../challenge-detection');
const { assertSafeHttpsUrl } = require('../url-security');
const {
  anchorRecords,
  cleanText,
  decodeStablePathId,
  firstContent,
  imageUrl,
  metaContent,
  uniqueBy,
} = require('./native-html');
const {
  NATIVE_MAX_CATALOG_PAGES_PER_REQUEST,
  SOURCES,
  buildCatalogUrl,
  parseHentaiCatalog,
} = require('./native-discovery');
const { SourceHttpClient } = require('./source-http');

const ORIGIN = SOURCES.hentai.origin;
const SERIES_PREFIX = 'ophmm-';
const SERIES_RE = /^ophmm-([a-z0-9][a-z0-9-]{0,199})$/i;
const EPISODE_RE = /^ophmm-([a-z0-9][a-z0-9-]{0,199}):1:(\d{1,4})$/i;
const SERIES_PATH_RE = /^\/(?:tvshows|hentai-series)\/([^/?#]+)\/?$/i;
const EPISODE_PATH_RE = /^\/episodes\/([^/?#]+)\/?$/i;
const TOP_TAXONOMY_SLUGS = new Set([
  '3d', 'all', 'anime', 'censored', 'english', 'hentai', 'hentai-series', 'latest',
  'new', 'ova', 'raw', 'series', 'top', 'top-rated', 'trending', 'uncensored',
]);
const TOP_TAXONOMY_TITLES = new Set([
  '3d', 'all', 'anime', 'censored', 'english', 'hentai', 'hentai series', 'latest',
  'new', 'ova', 'raw', 'series', 'top', 'top rated', 'trending', 'uncensored',
]);
const POST_ID_RE = /(?:get_player_contents|post[_-]?id|postid|data-post|data-id)[\s\S]{0,900}?(?:\ba\s*[:=]|post[_-]?id\s*[:=]|data-(?:post|id)\s*=)\s*['\"]?([0-9]{1,12})/i;
const MEDIA_RE = /(?:\bfile|\bsource|\bsrc|\burl|\bstream|\bvideo_url)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gi;
const PLAYER_KEY_RE = /(?:\bembed|\biframe|\bplayer|\bsrc|\burl)\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/gi;
const IFRAME_TAG_RE = /<iframe\b[^>]*>/gi;

function compact(value) {
  return cleanText(String(value || '')).slice(0, 2_000);
}

function safeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,199}$/.test(slug) ? slug : '';
}

function seriesId(slug) {
  const value = safeSlug(slug);
  return value ? `${SERIES_PREFIX}${value}` : '';
}

function episodeId(slug, number) {
  const value = safeSlug(slug);
  const episode = Math.max(Number.parseInt(String(number || 0), 10) || 0, 0);
  return value && episode ? `${SERIES_PREFIX}${value}:1:${episode}` : '';
}

function seriesPath(path) {
  try {
    const parsed = new URL(String(path || ''), ORIGIN);
    if (parsed.origin !== ORIGIN || !SERIES_PATH_RE.test(parsed.pathname)) return '';
    return parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  } catch { return ''; }
}
function slugFromPath(path) {
  const normalized = seriesPath(path);
  return normalized ? safeSlug(normalized.match(SERIES_PATH_RE)?.[1]) : '';
}
function safeSeriesPathUrl(path) {
  const normalized = seriesPath(path);
  return normalized ? `${ORIGIN}${normalized}` : '';
}

function parseRequestId(value) {
  const id = String(value || '').trim();
  const episode = id.match(EPISODE_RE);
  if (episode) {
    return Object.freeze({ kind: 'episode', slug: episode[1].toLowerCase(), episode: Number(episode[2]) });
  }
  const series = id.match(SERIES_RE);
  if (series) return Object.freeze({ kind: 'series', slug: series[1].toLowerCase() });
  const legacyPath = decodeStablePathId('hentai', id);
  const legacySlug = slugFromPath(legacyPath);
  return legacySlug ? Object.freeze({ kind: 'legacy-series', slug: legacySlug }) : null;
}

function safeSeriesUrl(slug) {
  const value = safeSlug(slug);
  return value ? `${ORIGIN}/tvshows/${value}/` : '';
}

function safeEpisodeUrl(slug) {
  const value = safeSlug(slug);
  return value ? `${ORIGIN}/episodes/${value}/` : '';
}

function hasHentaiCatalogEvidence(value) {
  const html = String(value || '');
  return html ? parseHentaiCatalog(html).length > 0 : false;
}
function hasHentaiSeriesEvidence(value) {
  const html = String(value || '');
  return Boolean(html && (metaContent(html, 'og:title') || firstContent(html, ['.single-page h1', '.sheader h1', 'h1'])) && anchorRecords(html).some(item => {
    try { const url = new URL(item.href, ORIGIN); return url.origin === ORIGIN && EPISODE_PATH_RE.test(url.pathname); } catch { return false; }
  }));
}
function hasHentaiEpisodeEvidence(value) {
  const html = String(value || '');
  return Boolean(html && (POST_ID_RE.test(html) || iframeUrls(html, ORIGIN).length || mediaUrls(html, ORIGIN).length));
}
function htmlUsable(value, options = {}) {
  const html = String(value || '');
  if (!html) return '';
  if (!hasStrongChallengeMarker(html)) return html;
  if (options.allowCatalogEvidence && hasHentaiCatalogEvidence(html)) return html;
  if (options.allowSeriesEvidence && hasHentaiSeriesEvidence(html)) return html;
  if (options.allowEpisodeEvidence && hasHentaiEpisodeEvidence(html)) return html;
  return '';
}
function topTaxonomyRecord(record, slug) {
  const title = compact(record?.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return TOP_TAXONOMY_SLUGS.has(slug) || TOP_TAXONOMY_TITLES.has(title);
}

function lazyImage(html) {
  const source = String(html || '');
  const block = source.match(/<(?:div|section)\b[^>]*class=["'][^"']*(?:poster|thumbnail|sheader)[^"']*["'][^>]*>[\s\S]{0,100000}?(?:<\/div>|<\/section>)/i)?.[0] || source;
  const direct = imageUrl(ORIGIN, block);
  if (direct && !direct.startsWith('data:')) return direct;
  return '';
}

function extractYear(html) {
  return String(html || '').match(/\b((?:19|20)\d{2})\b/)?.[1] || '';
}

function episodeNumber(slug, label, fallback) {
  const fromSlug = String(slug || '').match(/(?:^|-)episode-(\d+)(?:-|$)/i)?.[1]
    || String(slug || '').match(/(?:^|-)(\d+)(?:-|$)/)?.[1];
  const fromLabel = String(label || '').match(/(?:episode|ep\.?|e)\s*(\d+)/i)?.[1];
  return Math.max(Number(fromSlug || fromLabel || fallback || 0), 0);
}

function parseSeriesDetail(html, slug, detailUrl = '') {
  const body = htmlUsable(html, { allowSeriesEvidence: true });
  if (!body) return null;
  const title = compact(metaContent(body, 'og:title') || firstContent(body, ['.single-page h1', '.sheader h1', 'h1', 'h2']));
  if (!title) return null;
  const poster = metaContent(body, 'og:image') || lazyImage(body);
  const description = compact(
    firstContent(body, ['.wp-content p', '.sinopsis p', '.description p'])
    || metaContent(body, 'og:description')
    || metaContent(body, 'description')
  );
  const anchors = anchorRecords(body);
  const studio = compact(anchors.find(item => /\/studio\//i.test(item.href))?.text);
  const tags = uniqueBy(anchors
    .filter(item => /\/(?:genre|tag)\//i.test(item.href) && !/\/studio\//i.test(item.href))
    .map(item => compact(item.text))
    .filter(Boolean), value => value).slice(0, 40);
  const episodes = [];
  const seen = new Set();
  for (const anchor of anchors) {
    let parsed;
    try { parsed = new URL(anchor.href, ORIGIN); } catch { continue; }
    if (parsed.origin !== ORIGIN) continue;
    const episodeSlug = safeSlug(parsed.pathname.match(EPISODE_PATH_RE)?.[1]);
    if (!episodeSlug || seen.has(episodeSlug)) continue;
    seen.add(episodeSlug);
    episodes.push({
      slug: episodeSlug,
      number: episodeNumber(episodeSlug, anchor.text, episodes.length + 1),
      title: compact(anchor.text),
      sourceUrl: parsed.toString(),
    });
  }
  episodes.sort((left, right) => left.number - right.number || left.slug.localeCompare(right.slug));
  for (let index = 0; index < episodes.length; index += 1) {
    if (!episodes[index].number) episodes[index].number = index + 1;
    if (!episodes[index].title) episodes[index].title = `Episode ${episodes[index].number}`;
  }
  const uniqueNumbers = new Set();
  for (const item of episodes) {
    while (uniqueNumbers.has(item.number)) item.number += 1;
    uniqueNumbers.add(item.number);
  }
  return Object.freeze({
    sourceId: seriesId(slug),
    title,
    poster,
    background: poster,
    description,
    studio,
    tags,
    releaseDate: extractYear(body),
    detailUrl: safeSeriesPathUrl(detailUrl) || safeSeriesUrl(slug),
    upstreamId: slug,
    episodes: Object.freeze(episodes.map(item => Object.freeze({ ...item }))),
    videos: Object.freeze(episodes.map(item => Object.freeze({
      id: episodeId(slug, item.number),
      title: item.title || `Episode ${item.number}`,
      season: 1,
      episode: item.number,
      released: null,
    }))),
  });
}

function safePublicUrl(value, baseUrl = '') {
  try {
    const raw = String(value || '').trim();
    const normalized = raw.startsWith('//') ? `https:${raw}` : raw;
    const parsed = new URL(normalized, baseUrl || undefined);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (parsed.port && parsed.port !== '443') return '';
    if (!parsed.hostname || !parsed.hostname.includes('.')) return '';
    return parsed.toString();
  } catch { return ''; }
}

function iframeUrls(html, baseUrl) {
  const output = [];
  const source = normalizeEmbeddedMarkup(html);
  for (const match of source.matchAll(IFRAME_TAG_RE)) {
    const tag = match[0];
    const value = tag.match(/\b(?:data-src|data-lazy-src|data-url|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    const url = safePublicUrl(value?.[1] || value?.[2] || value?.[3] || '', baseUrl);
    if (url) output.push(url);
  }
  return [...new Set(output)];
}

function normalizeEmbeddedMarkup(value) {
  return String(value || '')
    .replace(/\\u003[aA]/g, ':')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\x2[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\`/g, '`')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function safePublicMediaUrl(value, baseUrl = '') {
  const url = safePublicUrl(value, baseUrl);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (/\.(?:jpe?g|png|gif|webp|avif|svg|css|js)(?:$|[?#])/i.test(parsed.pathname + parsed.search)) return '';
    return parsed.toString();
  } catch { return ''; }
}

function mediaUrls(html, baseUrl = '') {
  const output = [];
  // Iframe src values are player-page URLs, not direct media. Remove complete
  // iframe tags before scanning generic src/url fields so nested players are
  // handled only by nestedPlayerUrls(). This preserves extensionless direct
  // media in file/source/url fields without misclassifying player pages.
  const source = normalizeEmbeddedMarkup(html).replace(IFRAME_TAG_RE, ' ');
  for (const match of source.matchAll(MEDIA_RE)) {
    const value = safePublicMediaUrl(match[1] || match[2] || match[3] || '', baseUrl);
    if (value) output.push(value);
  }
  for (const match of source.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+/gi)) {
    const raw = match[0];
    if (!/\.(?:mp4|m3u8|mkv|webm)(?:$|[?#])|\/(?:hls|media|stream|video)\/|[?&](?:file|src|url)=/i.test(raw)) continue;
    const value = safePublicMediaUrl(raw, baseUrl);
    if (value) output.push(value);
  }
  return [...new Set(output)];
}

function nestedPlayerUrls(html, baseUrl) {
  const output = [...iframeUrls(html, baseUrl)];
  const source = normalizeEmbeddedMarkup(html);
  for (const match of source.matchAll(PLAYER_KEY_RE)) {
    const value = safePublicUrl(match[1] || match[2] || match[3] || '', baseUrl);
    if (!value) continue;
    const path = new URL(value).pathname + new URL(value).search;
    if (/\.(?:mp4|m3u8|mkv|webm|jpe?g|png|gif|webp|avif|svg|css|js)(?:$|[?#])/i.test(path)) continue;
    if (!/(?:embed|player|video|watch|stream|iframe|load|source)/i.test(value)) continue;
    output.push(value);
  }
  return [...new Set(output)];
}

function parseAjaxFields(payload) {
  const text = normalizeEmbeddedMarkup(payload).trim();
  if (!text) return [];
  const output = [];
  const visit = value => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value === 'object') { Object.values(value).forEach(visit); return; }
    const field = normalizeEmbeddedMarkup(String(value || '')).trim();
    if (field) output.push(field);
  };
  try { visit(JSON.parse(text)); } catch { output.push(text); }
  return [...new Set(output)];
}

function responseSize(response) {
  const range = String(response?.headers?.get?.('content-range') || '').match(/\/(\d+)$/)?.[1];
  const length = response?.headers?.get?.('content-length');
  return Math.max(Number.parseInt(range || length || '0', 10) || 0, 0);
}

function resolutionFromUrl(value) {
  const text = String(value || '');
  return text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|480|360)p?(?:[^0-9]|$)/i)?.[1]
    ? `${text.match(/(?:^|[^0-9])(2160|1440|1080|720|576|480|360)p?(?:[^0-9]|$)/i)[1]}p`
    : '';
}

async function safeFetch(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const allowedHosts = options.allowedHosts || new Set();
  const hostValidator = typeof options.hostValidator === 'function' ? options.hostValidator : hostname => allowedHosts.has(hostname);
  let current = new URL(String(url));
  const redirects = Math.min(Math.max(Number(options.maxRedirects ?? 3), 0), 5);
  for (let hop = 0; hop <= redirects; hop += 1) {
    if (current.protocol !== 'https:' || current.username || current.password || !hostValidator(current.hostname)) throw new Error('OnlyPorn Hentai redirect target is not allowlisted');
    const safeUrl = await assertSafeHttpsUrl(current.toString(), { allowedHosts: new Set([current.hostname]), checkDns: options.checkDns !== false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(Number(options.timeoutMs || 15_000), 1_000));
    let response;
    try {
      response = await fetchImpl(safeUrl, { method: options.method || 'GET', redirect: 'manual', signal: controller.signal, headers: options.headers, body: options.body });
    } finally { clearTimeout(timer); }
    if (![301, 302, 303, 307, 308].includes(Number(response.status))) return response;
    if (hop >= redirects) throw new Error('OnlyPorn Hentai redirect limit exceeded');
    const location = response.headers?.get?.('location');
    if (!location) throw new Error('OnlyPorn Hentai redirect lacks Location');
    current = new URL(location, current);
    if (Number(response.status) === 303) options = { ...options, method: 'GET', body: undefined };
  }
  throw new Error('OnlyPorn Hentai redirect loop');
}


function responseCookies(response) {
  try {
    if (typeof response?.headers?.getSetCookie === 'function') {
      return response.headers.getSetCookie()
        .map(value => String(value).split(';')[0])
        .filter(Boolean)
        .join('; ');
    }
    const value = String(response?.headers?.get?.('set-cookie') || '');
    return value.split(/,(?=[^;,]+=)/)
      .map(row => row.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  } catch { return ''; }
}
function mediaSignature(buffer) {
  if (!buffer?.length) return '';
  const ascii = buffer.subarray(0, Math.min(buffer.length, 65_536)).toString('latin1');
  if (/^\s*#EXTM3U/i.test(ascii)) return 'hls';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'FLV') return 'flv';
  return '';
}

async function validateMedia(url, options = {}) {
  const normalizedUrl = safePublicMediaUrl(url, options.baseUrl || '');
  if (!normalizedUrl) return null;
  const hostname = new URL(normalizedUrl).hostname;
  const allowedHosts = new Set([hostname]);
  const playbackHeaders = {
    Accept: 'video/*, application/vnd.apple.mpegurl, application/x-mpegURL, application/octet-stream, text/plain;q=0.7, */*;q=0.5',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    ...(options.referer ? { Referer: String(options.referer) } : {}),
    ...(options.cookie ? { Cookie: String(options.cookie) } : {}),
  };
  let response;
  try {
    response = await safeFetch(normalizedUrl, {
      ...options,
      method: 'HEAD',
      allowedHosts,
      hostValidator: () => true,
      headers: playbackHeaders,
    });
  } catch {
    response = null;
  }
  const headStatus = Number(response?.status || 0);
  const headType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const extensionAccepted = /\.(?:mp4|m3u8|mkv|webm)(?:$|[?#])/i.test(normalizedUrl);
  const headAccepted = [200, 206].includes(headStatus)
    && (/^video\//.test(headType) || /mpegurl|octet-stream/.test(headType) || extensionAccepted);
  try { if (typeof response?.body?.cancel === 'function') await response.body.cancel(); } catch {}
  if (headAccepted) {
    return Object.freeze({ url: normalizedUrl, size: responseSize(response), resolution: resolutionFromUrl(normalizedUrl) });
  }
  try {
    response = await safeFetch(normalizedUrl, {
      ...options,
      method: 'GET',
      allowedHosts,
      hostValidator: () => true,
      headers: { ...playbackHeaders, Range: 'bytes=0-65535' },
    });
  } catch {
    return null;
  }
  const status = Number(response.status || 0);
  if (![200, 206].includes(status)) {
    try { if (typeof response.body?.cancel === 'function') await response.body.cancel(); } catch {}
    return null;
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  let buffer = Buffer.alloc(0);
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    try { if (typeof response.body?.cancel === 'function') await response.body.cancel(); } catch {}
  }
  const signature = mediaSignature(buffer);
  const typeAccepted = /^video\//.test(contentType)
    || /mpegurl|octet-stream/.test(contentType)
    || extensionAccepted
    || Boolean(signature);
  if (!typeAccepted) return null;
  return Object.freeze({
    url: normalizedUrl,
    size: responseSize(response) || buffer.length,
    resolution: resolutionFromUrl(normalizedUrl),
  });
}

function createClient(options) {
  return new SourceHttpClient({
    id: 'hentai',
    endpoint: ORIGIN,
    timeoutMs: options.config.requestTimeoutMs,
    maxResponseBytes: options.config.discoveryMaxResponseBytes,
    cacheTtlMs: options.config.discoveryCacheTtlMs,
    negativeTtlMs: options.config.discoveryNegativeTtlMs,
    cacheMaxEntries: options.config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    allowHtml: true,
    accept: 'text/html, application/xhtml+xml;q=0.9',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    minRequestIntervalMs: options.minRequestIntervalMs ?? 350,
    maxRetries: options.maxRetries ?? 1,
    retryBaseDelayMs: options.retryBaseDelayMs,
    now: options.now,
    sleep: options.sleep,
  });
}

function createHentaiMamaSeriesAdapter(options = {}) {
  const client = createClient(options);
  const seriesIndex = new Map();
  const episodeIndex = new Map();
  const catalogWindows = new Map();
  const episodeDiagnostics = new Map();

  async function loadSeries(slug, pathHint = '', loadOptions = {}) {
    const requireEpisodes = Boolean(loadOptions.requireEpisodes);
    const remembered = seriesIndex.get(slug);
    if (remembered?.episodes?.length) return remembered;
    const candidates = [...new Set([safeSeriesPathUrl(pathHint), safeSeriesPathUrl(remembered?.detailUrl), safeSeriesUrl(slug), `${ORIGIN}/hentai-series/${slug}/`].filter(Boolean))];
    for (const url of candidates) {
      try {
        const html = htmlUsable(await client.fetchText(url, { cacheKey: `hentai:series:${slug}:${new URL(url).pathname}` }), { allowSeriesEvidence: true });
        const detailed = parseSeriesDetail(html, slug, new URL(url).pathname);
        if (!detailed) continue;
        if (requireEpisodes && !detailed.episodes?.length) continue;
        seriesIndex.set(slug, detailed);
        for (const episode of detailed.episodes) episodeIndex.set(episodeId(slug, episode.number), Object.freeze({ slug, ...episode }));
        return detailed;
      } catch { /* Try the next exact series path. */ }
    }
    if (!remembered) return null;
    return requireEpisodes && !remembered.episodes?.length ? null : remembered;
  }

  async function resolveEpisode(request) {
    const stages = { series: 0, episodePage: 0, inlineMedia: 0, ajaxPostId: 0, ajaxFields: 0, ajaxIframes: 0, ajaxMedia: 0, playerPages: 0, playerFetched: 0, playerDepth: 0, nestedPlayers: 0, playerMedia: 0, validated: 0, errors: [] };
    const diagnosticKey = episodeId(request.slug, request.episode || 1) || seriesId(request.slug);
    const series = await loadSeries(request.slug, '', { requireEpisodes: true });
    if (!series?.episodes?.length) { episodeDiagnostics.set(diagnosticKey, Object.freeze(stages)); return []; }
    stages.series = 1;
    const episode = request.kind === 'episode'
      ? series.episodes.find(item => item.number === request.episode)
      : series.episodes[0];
    if (!episode) { episodeDiagnostics.set(diagnosticKey, Object.freeze(stages)); return []; }
    const epUrl = safeEpisodeUrl(episode.slug);
    let episodeResponse;
    let html = '';
    let sessionCookie = '';
    try {
      episodeResponse = await safeFetch(epUrl, {
        fetchImpl: options.fetchImpl,
        checkDns: options.checkDns,
        timeoutMs: options.config.requestTimeoutMs,
        allowedHosts: new Set(['hentaimama.io']),
        headers: {
          Accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
          Referer: ORIGIN,
        },
      });
      sessionCookie = responseCookies(episodeResponse);
      html = htmlUsable(await episodeResponse.text(), { allowEpisodeEvidence: true });
    } catch (error) {
      stages.errors.push(`episode:${compact(error?.message || error)}`);
    }
    if (!html) {
      episodeDiagnostics.set(diagnosticKey, Object.freeze({ ...stages, errors: Object.freeze(stages.errors) }));
      return [];
    }
    stages.episodePage = 1;
    const playerPages = new Map(nestedPlayerUrls(html, epUrl).map(url => [url, Object.freeze({ depth: 1, referer: epUrl })]));
    const candidates = new Map();
    const rememberMedia = (url, referer = epUrl) => {
      const value = safePublicMediaUrl(url);
      if (value && !candidates.has(value)) candidates.set(value, referer);
    };
    for (const url of mediaUrls(html, epUrl)) rememberMedia(url, epUrl);
    stages.inlineMedia = candidates.size;
    const postId = html.match(POST_ID_RE)?.[1] || '';
    if (postId) {
      stages.ajaxPostId = 1;
      const ajaxBodies = [
        { action: 'get_player_contents', a: postId },
        { action: 'get_player_contents', post_id: postId },
        { action: 'get_player_contents', id: postId },
        { action: 'get_player_contents', post: postId },
      ];
      for (const fields of ajaxBodies) {
        try {
          const body = new URLSearchParams(fields).toString();
          const response = await safeFetch(`${ORIGIN}/wp-admin/admin-ajax.php`, {
            fetchImpl: options.fetchImpl,
            checkDns: options.checkDns,
            timeoutMs: options.config.requestTimeoutMs,
            method: 'POST',
            allowedHosts: new Set(['hentaimama.io']),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              Accept: 'application/json, text/plain, text/html, */*',
              Referer: epUrl,
              Origin: ORIGIN,
              'X-Requested-With': 'XMLHttpRequest',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
              ...(sessionCookie ? { Cookie: sessionCookie } : {}),
            },
            body,
          });
          if (!response.ok) continue;
          const text = await response.text();
          const ajaxFields = parseAjaxFields(text);
          stages.ajaxFields += ajaxFields.length;
          for (const field of ajaxFields) {
            const ajaxIframes = iframeUrls(field, epUrl);
            const ajaxMedia = mediaUrls(field, epUrl);
            stages.ajaxIframes += ajaxIframes.length;
            stages.ajaxMedia += ajaxMedia.length;
            for (const url of ajaxIframes) {
              if (!playerPages.has(url)) playerPages.set(url, Object.freeze({ depth: 1, referer: epUrl }));
            }
            for (const url of nestedPlayerUrls(field, epUrl)) {
              if (!playerPages.has(url)) playerPages.set(url, Object.freeze({ depth: 1, referer: epUrl }));
            }
            for (const url of ajaxMedia) rememberMedia(url, epUrl);
          }
          if (stages.ajaxMedia || stages.ajaxIframes) break;
        } catch (error) {
          stages.errors.push(`ajax:${compact(error?.message || error)}`);
        }
      }
    }

    const MAX_PLAYER_PAGES = 18;
    const MAX_PLAYER_DEPTH = 3;
    const queue = [...playerPages.entries()].map(([url, context]) => ({ url, ...context }));
    const visitedPlayers = new Set();
    while (queue.length && visitedPlayers.size < MAX_PLAYER_PAGES) {
      const batch = queue.splice(0, Math.min(4, MAX_PLAYER_PAGES - visitedPlayers.size));
      await Promise.all(batch.map(async entry => {
        const playerUrl = entry.url;
        if (visitedPlayers.has(playerUrl)) return;
        visitedPlayers.add(playerUrl);
        stages.playerDepth = Math.max(stages.playerDepth, entry.depth || 1);
        try {
          const player = await safeFetch(playerUrl, {
            fetchImpl: options.fetchImpl,
            checkDns: options.checkDns,
            timeoutMs: options.config.requestTimeoutMs,
            allowedHosts: new Set([new URL(playerUrl).hostname]),
            hostValidator: () => true,
            headers: {
              Accept: 'text/html, application/xhtml+xml;q=0.9, application/json;q=0.8, */*;q=0.5',
              Referer: entry.referer || epUrl,
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
              ...(sessionCookie ? { Cookie: sessionCookie } : {}),
            },
          });
          if (!player.ok) {
            stages.errors.push(`player-status:${player.status}:${new URL(playerUrl).hostname}`);
            return;
          }
          const body = await player.text();
          stages.playerFetched += 1;
          const found = mediaUrls(body, playerUrl);
          stages.playerMedia += found.length;
          for (const url of found) rememberMedia(url, playerUrl);
          if ((entry.depth || 1) < MAX_PLAYER_DEPTH) {
            for (const nestedUrl of nestedPlayerUrls(body, playerUrl)) {
              if (visitedPlayers.has(nestedUrl) || queue.some(value => value.url === nestedUrl)) continue;
              queue.push({ url: nestedUrl, depth: (entry.depth || 1) + 1, referer: playerUrl });
              stages.nestedPlayers += 1;
            }
          }
        } catch (error) {
          stages.errors.push(`player:${compact(error?.message || error)}`);
        }
      }));
    }
    stages.playerPages = visitedPlayers.size;

    const validated = (await Promise.all([...candidates.entries()].map(([url, referer]) => validateMedia(url, {
      fetchImpl: options.fetchImpl,
      checkDns: options.checkDns,
      timeoutMs: options.config.requestTimeoutMs,
      referer,
      cookie: sessionCookie,
      baseUrl: referer,
    })))).filter(Boolean);
    stages.validated = validated.length;
    episodeDiagnostics.set(diagnosticKey, Object.freeze({ ...stages, errors: Object.freeze(stages.errors.slice(0, 8)) }));
    return validated.map((media, index) => ({
      source: 'hentai',
      sourceId: episodeId(request.slug, episode.number),
      title: `${series.title} Episode ${episode.number}`,
      filename: `${series.title} E${episode.number}${media.url.match(/\.(mp4|m3u8|mkv|webm)(?:\?|$)/i)?.[0] || ''}`,
      url: media.url,
      validated: true,
      size: media.size || 0,
      resolution: media.resolution,
      episode: episode.number,
      seriesSlug: request.slug,
      indexer: 'hentaimama',
      provenance: ['hentaimama-series', 'exact-episode', `player-${index + 1}`],
    }));
  }

  return Object.freeze({
    id: 'hentai',
    configured: true,
    native: true,
    origin: ORIGIN,
    async catalog({ catalog, skip = 0, limit = 40 }) {
      const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
      const safeLimit = Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1);
      const targetEnd = safeSkip + safeLimit;
      const key = String(catalog?.id || `hentai:${catalog?.mode || 'all'}`);
      let state = catalogWindows.get(key);
      if (!state) {
        state = { nextPage: 1, records: [], seen: new Set(), rejectedTaxonomy: 0, rejectedNoEpisodes: 0 };
        catalogWindows.set(key, state);
      }
      let pages = 0;
      // All and New keep the existing fast listing path. Only Top performs
      // detail preflight, bounded to the normal addon request budget.
      const topDeadlineAt = catalog?.mode === 'top'
        ? Date.now() + Math.min(Math.max(Number(options.config.requestTimeoutMs || 15_000) + 7_000, 10_000), 24_000)
        : Infinity;
      while (state.records.length < targetEnd && pages < NATIVE_MAX_CATALOG_PAGES_PER_REQUEST) {
        if (catalog?.mode === 'top' && Date.now() >= topDeadlineAt) break;
        const page = state.nextPage;
        const url = buildCatalogUrl('hentai', catalog, page);
        const html = htmlUsable(
          await client.fetchText(url, { cacheKey: `hentai:${catalog?.mode || 'all'}:${page}` }),
          { allowCatalogEvidence: true }
        );
        if (!html) break;
        const records = parseHentaiCatalog(html);
        if (!records.length) break;
        state.nextPage += 1;
        pages += 1;
        for (const record of records) {
          const upstreamPath = seriesPath(record._path || record.upstreamId || decodeStablePathId('hentai', record.sourceId));
          const slug = slugFromPath(upstreamPath);
          if (!slug || state.seen.has(slug)) continue;
          state.seen.add(slug);
          if (catalog?.mode === 'top' && topTaxonomyRecord(record, slug)) { state.rejectedTaxonomy += 1; continue; }
          const transformed = Object.freeze({ ...record, sourceId: seriesId(slug), upstreamId: slug, detailUrl: safeSeriesPathUrl(upstreamPath) || safeSeriesUrl(slug), seriesPath: upstreamPath });
          if (catalog?.mode === 'top') {
            if (Date.now() >= topDeadlineAt) break;
            const detailed = await loadSeries(slug, upstreamPath, { requireEpisodes: true });
            if (!detailed?.episodes?.length) { state.rejectedNoEpisodes += 1; continue; }
            seriesIndex.set(slug, detailed);
            state.records.push(Object.freeze({ ...transformed, ...detailed, sourceId: seriesId(slug) }));
          } else {
            seriesIndex.set(slug, transformed);
            state.records.push(transformed);
          }
        }
      }
      return state.records.slice(safeSkip, targetEnd);
    },
    async meta({ sourceId }) {
      const request = parseRequestId(sourceId);
      if (!request) return null;
      const series = await loadSeries(request.slug);
      if (!series) return null;
      if (request.kind !== 'episode') return series;
      const episode = series.episodes.find(item => item.number === request.episode);
      return episode ? Object.freeze({
        ...series,
        sourceId: episodeId(request.slug, request.episode),
        title: `${series.title} Episode ${request.episode}`,
        episode: request.episode,
      }) : null;
    },
    async resolve({ sourceId }) {
      const request = parseRequestId(sourceId);
      return request ? resolveEpisode(request) : [];
    },
    diagnostics() {
      return Object.freeze({
        hentaiMamaSeries: Object.freeze({
          rememberedSeries: seriesIndex.size,
          rememberedEpisodes: episodeIndex.size,
          idPrefix: SERIES_PREFIX,
          episodeDiagnostics: Object.freeze([...episodeDiagnostics.entries()].slice(-20).map(([id, value]) => Object.freeze({ id, ...value }))),
          topWindows: Object.freeze([...catalogWindows.entries()].filter(([key]) => /hentai\.top|hentai:top/i.test(key)).map(([key, state]) => Object.freeze({ key, records: state.records.length, rejectedTaxonomy: state.rejectedTaxonomy || 0, rejectedNoEpisodes: state.rejectedNoEpisodes || 0 }))),
        }),
      });
    },
  });
}

module.exports = {
  EPISODE_RE,
  SERIES_RE,
  createHentaiMamaSeriesAdapter,
  episodeId,
  hasHentaiCatalogEvidence,
  hasHentaiEpisodeEvidence,
  hasHentaiSeriesEvidence,
  htmlUsable,
  iframeUrls,
  mediaUrls,
  nestedPlayerUrls,
  parseAjaxFields,
  parseRequestId,
  parseSeriesDetail,
  seriesId,
  seriesPath,
  topTaxonomyRecord,
  validateMedia,
};
