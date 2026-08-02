
'use strict';

const crypto = require('node:crypto');
const { hasStrongChallengeMarker } = require('../challenge-detection');
const { assertSafeHttpsUrl } = require('../url-security');
const { SourceHttpClient } = require('./source-http');
const {
  absoluteHttps,
  anchorRecords,
  attribute,
  blocksByStart,
  cleanText,
  decodeStablePathId,
  firstContent,
  firstTag,
  imageUrl,
  metaContent,
  parseDurationSeconds,
  sameOriginPath,
  stablePathId,
  uniqueBy,
} = require('./native-html');

const SOURCES = Object.freeze({
  pornrips: Object.freeze({ origin: 'https://pornrips.to', allowedPrefixes: ['/'] }),
  yesporn: Object.freeze({ origin: 'https://yesporn.vip', allowedPrefixes: ['/video/'] }),
  hentai: Object.freeze({ origin: 'https://hentaimama.io', allowedPrefixes: ['/tvshows/', '/hentai-series/'] }),
});

const NATIVE_MIN_REQUEST_INTERVAL_MS = 350;
const NATIVE_MAX_RETRIES = 1;
const NATIVE_MAX_CATALOG_PAGES_PER_REQUEST = 12;
const NATIVE_MAX_TORRENT_BYTES = 2_000_000;
const NATIVE_MAX_AJAX_BYTES = 1_000_000;
const HENTAI_MEDIA_HOST = /^(?:gdvid\.info|(?:[a-z0-9-]+\.)*javprovider\.com)$/i;
const YESPORN_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const YESPORN_STREAM_VALUE_RE =
  /\b(video(?:_alt)?_url\d*)\b\s*["']?\s*[:=]\s*(["'])([\s\S]*?)\2/gi;
const YESPORN_STREAM_LABEL_RE =
  /\b(video(?:_alt)?_url\d*)_text\b\s*["']?\s*[:=]\s*(["'])([\s\S]*?)\2/gi;
const YESPORN_COMMON_MEDIA_RE =
  /\b(?:file|src|hls|contentUrl|videoUrl)\b\s*["']?\s*[:=]\s*(["'])([\s\S]*?)\1/gi;
const YESPORN_MAX_PLAYER_PAGES = 4;

function createNativeClient(id, config, options = {}) {
  const source = SOURCES[id];
  return new SourceHttpClient({
    id,
    endpoint: source.origin,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    allowHtml: true,
    accept: 'text/html, application/xhtml+xml;q=0.9',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    minRequestIntervalMs: options.minRequestIntervalMs ?? NATIVE_MIN_REQUEST_INTERVAL_MS,
    maxRetries: options.maxRetries ?? NATIVE_MAX_RETRIES,
    retryBaseDelayMs: options.retryBaseDelayMs,
    now: options.now,
    sleep: options.sleep,
  });
}

function pageNumber(skip, limit) {
  return Math.floor(Math.max(Number(skip) || 0, 0) / Math.max(Number(limit) || 1, 1)) + 1;
}

function hasNativeCatalogEvidence(source, html) {
  const body = String(html || '');
  if (!body) return false;
  if (source === 'pornrips') {
    return /<article\b/i.test(body) && /href=[\"'][^\"']+\/[\"']/i.test(body);
  }
  if (source === 'yesporn') {
    return /href=[\"'][^\"']*\/video\/\d+\/[^\"'?#]+\/?(?:[?#][^\"']*)?[\"']/i.test(body);
  }
  if (source === 'hentai') {
    return /href=[\"'][^\"']*\/tvshows\/[^\"'?#]+\/?(?:[?#][^\"']*)?[\"']/i.test(body)
      && /<article\b[^>]*class=[\"'][^\"']*\b(?:item|tvshows)\b[^\"']*[\"']/i.test(body);
  }
  return false;
}

function safeHtml(payload, source) {
  const html = String(payload || '');
  if (!html) return '';
  if (!hasStrongChallengeMarker(html)) return html;
  return hasNativeCatalogEvidence(source, html) ? html : '';
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || '');
}

async function safeNativeRequest(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const allowedHosts = options.allowedHosts instanceof Set
    ? options.allowedHosts
    : new Set(options.allowedHosts || []);
  const origin = String(options.origin || new URL(String(url)).origin);
  const timeoutMs = Math.max(Number(options.timeoutMs || 15_000), 1_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let handedOff = false;
  let cleared = false;
  const clearTimeoutOnce = () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
  };
  let currentUrl;
  try {
    currentUrl = await assertSafeHttpsUrl(url, {
      allowedHosts,
      checkDns: options.checkDns !== false,
    });
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetchImpl(currentUrl, {
        method: options.method || 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: options.headers,
        body: options.body,
      });
      const status = Number(response?.status || 0);
      if (status < 300 || status >= 400) {
        handedOff = true;
        return { response, clearTimeout: clearTimeoutOnce };
      }
      const location = responseHeader(response, 'location');
      try {
        if (typeof response?.body?.cancel === 'function') await response.body.cancel();
      } catch {
        // Redirect body cancellation is best effort.
      }
      if (!location || redirects >= 3) throw new Error('Native source exceeded the safe redirect limit');
      const target = await assertSafeHttpsUrl(new URL(location, currentUrl).toString(), {
        allowedHosts,
        checkDns: options.checkDns !== false,
      });
      if (new URL(target).origin !== origin) throw new Error('Native source redirect changed origin unexpectedly');
      currentUrl = target;
    }
  } finally {
    if (!handedOff) clearTimeoutOnce();
  }
  throw new Error('Native source exceeded the safe redirect limit');
}

async function readBoundedBuffer(response, maxBytes) {
  const length = Number.parseInt(responseHeader(response, 'content-length'), 10) || 0;
  if (length > maxBytes) throw new Error('Native response exceeded the configured byte limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Native response exceeded the configured byte limit');
  return buffer;
}

async function readBoundedText(response, maxBytes) {
  const length = Number.parseInt(responseHeader(response, 'content-length'), 10) || 0;
  if (length > maxBytes) throw new Error('Native response exceeded the configured byte limit');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('Native response exceeded the configured byte limit');
  }
  return text;
}

function torrentUrlFromDetail(html) {
  const base = SOURCES.pornrips.origin;
  for (const anchor of anchorRecords(html)) {
    const path = sameOriginPath(base, anchor.href, ['/torrents/']);
    if (!path) continue;
    const parsed = new URL(path, base);
    if (/\.torrent$/i.test(parsed.pathname)) return parsed.toString();
  }
  return '';
}

function decodeTorrent(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Torrent payload is empty');
  let offset = 0;
  let nodes = 0;
  let infoStart = -1;
  let infoEnd = -1;

  function parseValue(depth = 0) {
    if (depth > 64 || nodes++ > 200_000 || offset >= buffer.length) {
      throw new Error('Torrent payload exceeded parser limits');
    }
    const marker = buffer[offset];
    if (marker === 0x69) {
      const end = buffer.indexOf(0x65, offset + 1);
      if (end < 0) throw new Error('Torrent integer is malformed');
      const raw = buffer.subarray(offset + 1, end).toString('ascii');
      if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) throw new Error('Torrent integer is malformed');
      offset = end + 1;
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error('Torrent integer exceeds safe limits');
      return value;
    }
    if (marker >= 0x30 && marker <= 0x39) {
      const colon = buffer.indexOf(0x3a, offset);
      if (colon < 0) throw new Error('Torrent string is malformed');
      const rawLength = buffer.subarray(offset, colon).toString('ascii');
      if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) throw new Error('Torrent string is malformed');
      const length = Number(rawLength);
      const start = colon + 1;
      const end = start + length;
      if (!Number.isSafeInteger(length) || end > buffer.length) throw new Error('Torrent string exceeds payload');
      offset = end;
      return buffer.subarray(start, end);
    }
    if (marker === 0x6c) {
      offset += 1;
      const value = [];
      while (buffer[offset] !== 0x65) value.push(parseValue(depth + 1));
      offset += 1;
      return value;
    }
    if (marker === 0x64) {
      offset += 1;
      const value = Object.create(null);
      while (buffer[offset] !== 0x65) {
        const keyBuffer = parseValue(depth + 1);
        if (!Buffer.isBuffer(keyBuffer)) throw new Error('Torrent dictionary key is malformed');
        const key = keyBuffer.toString('utf8');
        const valueStart = offset;
        value[key] = parseValue(depth + 1);
        if (depth === 0 && key === 'info') {
          infoStart = valueStart;
          infoEnd = offset;
        }
      }
      offset += 1;
      return value;
    }
    throw new Error('Torrent payload contains an unknown bencode marker');
  }

  const root = parseValue();
  if (offset !== buffer.length || !root || infoStart < 0 || infoEnd <= infoStart) {
    throw new Error('Torrent payload has no valid info dictionary');
  }
  const info = root.info;
  if (!info || typeof info !== 'object' || Buffer.isBuffer(info)) {
    throw new Error('Torrent info dictionary is malformed');
  }
  const nameBuffer = info['name.utf-8'] || info.name;
  const filename = Buffer.isBuffer(nameBuffer) ? cleanText(nameBuffer.toString('utf8')) : '';
  const files = Array.isArray(info.files)
    ? info.files.map((file, index) => {
      const pathParts = file?.['path.utf-8'] || file?.path;
      const relativePath = Array.isArray(pathParts)
        ? pathParts
          .filter(Buffer.isBuffer)
          .map(part => cleanText(part.toString('utf8')))
          .filter(Boolean)
          .join('/')
        : '';
      return Object.freeze({
        index,
        path: [filename, relativePath].filter(Boolean).join('/') || `file-${index}`,
        length: Number.isSafeInteger(file?.length) ? file.length : 0,
      });
    })
    : (Number.isSafeInteger(info.length)
      ? [Object.freeze({ index: 0, path: filename || 'file-0', length: info.length })]
      : []);
  const size = files.reduce((total, file) => total + file.length, 0);
  return {
    infoHash: crypto.createHash('sha1').update(buffer.subarray(infoStart, infoEnd)).digest('hex'),
    filename,
    size,
    files: Object.freeze(files),
  };
}

function decodeYespornPlayerValue(value) {
  return String(value || '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x0*2f;|&#0*47;/gi, '/')
    .replace(/&#x0*3a;|&#0*58;/gi, ':')
    .replace(/&#x0*26;|&#0*38;/gi, '&')
    .trim();
}

function yespornQualityRank(value) {
  const text = cleanText(value).toLowerCase();
  if (/\b(?:4320p|8k)\b/.test(text)) return 4320;
  if (/\b(?:2160p|4k)\b/.test(text)) return 2160;
  return Number(
    text.match(
      /\b(1440|1080|720|576|480|360|240|144)p?\b/
    )?.[1] || 0
  );
}

function yespornInferredLabel(url, fallback = '') {
  const value = cleanText(fallback);
  if (value) return value;

  const text = String(url || '');
  const quality = text.match(
    /(?:^|[^0-9])(4320|2160|1440|1080|720|576|480|360|240|144)p?(?:[^0-9]|$)/i
  )?.[1];

  return quality ? `${quality}p` : 'Direct';
}

function yespornMediaKind(url) {
  return /\.m3u8(?:$|[?#])/i.test(String(url || ''))
    ? 'hls'
    : 'mp4';
}

function yespornLooksLikeMediaUrl(url) {
  try {
    const parsed = new URL(String(url));
    const target = `${parsed.pathname}${parsed.search}`.toLowerCase();

    return (
      /\/get_file\//.test(target) ||
      /\.(?:mp4|m4v|webm|m3u8)(?:$|[?#])/.test(target) ||
      /\/(?:media|stream|video_file|download)\//.test(target)
    );
  } catch {
    return false;
  }
}

function yespornStreamPairs(
  html,
  pageUrl = SOURCES.yesporn.origin
) {
  const body = String(html || '');
  const labels = new Map();
  const output = [];
  const seen = new Set();

  const append = (rawValue, rawLabel = '', authoritative = false) => {
    let value = decodeYespornPlayerValue(rawValue);
    value = value.replace(/^function\/0\//i, '');

    const url = absoluteHttps(pageUrl, value);
    if (
      !url ||
      seen.has(url) ||
      (!authoritative && !yespornLooksLikeMediaUrl(url))
    ) {
      return;
    }

    seen.add(url);
    output.push(Object.freeze({
      label: yespornInferredLabel(url, rawLabel),
      url,
      mediaKind: yespornMediaKind(url),
    }));
  };

  for (const match of body.matchAll(YESPORN_STREAM_LABEL_RE)) {
    const label = cleanText(
      decodeYespornPlayerValue(match[3])
    );
    if (label) labels.set(match[1].toLowerCase(), label);
  }

  for (const match of body.matchAll(YESPORN_STREAM_VALUE_RE)) {
    const key = match[1].toLowerCase();
    append(match[3], labels.get(key), true);
  }

  for (
    const match of body.matchAll(
      /<(?:video|source)\b[^>]*>/gi
    )
  ) {
    const tag = match[0];
    const src =
      attribute(tag, 'src') ||
      attribute(tag, 'data-src') ||
      attribute(tag, 'data-file');

    append(
      src,
      attribute(tag, 'label') ||
      attribute(tag, 'title') ||
      attribute(tag, 'data-res') ||
      attribute(tag, 'res')
    );
  }

  for (const match of body.matchAll(YESPORN_COMMON_MEDIA_RE)) {
    append(match[2]);
  }

  for (
    const match of body.matchAll(
      /https:(?:\\\/|\/){2}[^"'<>\\\s]+/gi
    )
  ) {
    append(match[0]);
  }

  return Object.freeze(
    output.sort(
      (left, right) =>
        yespornQualityRank(right.label) -
        yespornQualityRank(left.label)
    )
  );
}

function yespornIframeUrls(html, pageUrl) {
  const output = [];
  const seen = new Set();

  for (const match of String(html || '').matchAll(/<iframe\b[^>]*>/gi)) {
    const tag = match[0];
    const raw =
      attribute(tag, 'src') ||
      attribute(tag, 'data-src') ||
      attribute(tag, 'data-lazy-src');

    const url = absoluteHttps(
      pageUrl,
      decodeYespornPlayerValue(raw)
    );

    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(url);

    if (output.length >= YESPORN_MAX_PLAYER_PAGES - 1) break;
  }

  return Object.freeze(output);
}

async function readYespornPlayerPage(
  url,
  referer,
  options
) {
  const safeUrl = await assertSafeHttpsUrl(url, {
    checkDns: options.checkDns !== false,
  });
  const parsed = new URL(safeUrl);
  const safeReferer = absoluteHttps(
    referer || SOURCES.yesporn.origin,
    referer || `${SOURCES.yesporn.origin}/`
  ) || `${SOURCES.yesporn.origin}/`;

  const request = await safeNativeRequest(safeUrl, {
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    timeoutMs: options.config.requestTimeoutMs,
    origin: parsed.origin,
    allowedHosts: new Set([parsed.hostname.toLowerCase()]),
    headers: {
      Accept:
        'text/html, application/xhtml+xml;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.3',
      'Accept-Language': 'en-US,en;q=0.8',
      Referer: safeReferer,
      Origin: new URL(safeReferer).origin,
      'User-Agent': YESPORN_BROWSER_USER_AGENT,
    },
  });

  try {
    const status = Number(request.response?.status || 0);
    if (status < 200 || status >= 300) return null;

    const contentType = responseHeader(
      request.response,
      'content-type'
    ).split(';')[0].trim().toLowerCase();

    if (
      contentType &&
      ![
        'text/html',
        'application/xhtml+xml',
        'application/json',
        'text/plain',
        'application/javascript',
        'text/javascript',
      ].includes(contentType)
    ) {
      return null;
    }

    const maxBytes = Math.max(
      Number(
        options.config.discoveryMaxResponseBytes || 0
      ),
      NATIVE_MAX_AJAX_BYTES
    );

    const html = await readBoundedText(
      request.response,
      maxBytes
    );

    if (
      hasStrongChallengeMarker(html) &&
      !/\bvideo(?:_alt)?_url\d*\b|<video\b|<source\b|<iframe\b|\/get_file\//i.test(html)
    ) {
      return null;
    }

    return Object.freeze({
      url: safeUrl,
      html,
    });
  } finally {
    request.clearTimeout();
  }
}

async function resolveYesporn({
  sourceId,
  item,
  options,
}) {
  const path = decodeStablePathId('yesporn', sourceId);
  if (!path) return [];

  const detailUrl = absoluteHttps(
    SOURCES.yesporn.origin,
    path
  );
  if (!detailUrl) return [];

  const queue = [{
    url: detailUrl,
    referer: `${SOURCES.yesporn.origin}/`,
    depth: 0,
  }];
  const visited = new Set();
  const discovered = [];

  while (
    queue.length &&
    visited.size < YESPORN_MAX_PLAYER_PAGES
  ) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);

    let page;
    try {
      page = await readYespornPlayerPage(
        current.url,
        current.referer,
        options
      );
    } catch {
      continue;
    }

    if (!page) continue;

    for (
      const value of yespornStreamPairs(
        page.html,
        page.url
      )
    ) {
      discovered.push({
        ...value,
        referer: page.url,
      });
    }

    if (current.depth >= 1) continue;

    for (
      const iframeUrl of yespornIframeUrls(
        page.html,
        page.url
      )
    ) {
      queue.push({
        url: iframeUrl,
        referer: page.url,
        depth: current.depth + 1,
      });
    }
  }

  const candidates = [];
  const seen = new Set();

  for (const value of discovered) {
    let safeUrl = '';

    try {
      safeUrl = await assertSafeHttpsUrl(value.url, {
        checkDns: options.checkDns !== false,
      });
    } catch {
      continue;
    }

    if (!safeUrl || seen.has(safeUrl)) continue;
    seen.add(safeUrl);

    const referer = await assertSafeHttpsUrl(
      value.referer || detailUrl,
      {
        checkDns: options.checkDns !== false,
      }
    );

    candidates.push(Object.freeze({
      source: 'yesporn',
      sourceId,
      title:
        item?.title ||
        slugTitle(path) ||
        'YesPorn',
      filename:
        `${item?.title || slugTitle(path) || 'YesPorn'}.mp4`,
      resolution: value.label,
      quality: value.label,
      mediaKind: value.mediaKind,
      url: safeUrl,
      validated: true,
      requestHeaders: Object.freeze({
        'User-Agent': YESPORN_BROWSER_USER_AGENT,
        Referer: referer,
        Origin: new URL(referer).origin,
      }),
      provenance: Object.freeze([
        'yesporn-authoritative-player-page',
        'yesporn-fresh-rotating-media',
      ]),
    }));
  }

  return Object.freeze(candidates);
}

async function resolvePornrips({ client, sourceId, item, options }) {
  const path = decodeStablePathId('pornrips', sourceId);
  if (!path) return [];
  const detailUrl = absoluteHttps(SOURCES.pornrips.origin, path);
  const html = safeHtml(
    await client.fetchText(detailUrl, { cacheKey: `pornrips:detail:${path}` }),
    'pornrips'
  );
  const torrentUrl = torrentUrlFromDetail(html);
  if (!torrentUrl) return [];
  const request = await safeNativeRequest(torrentUrl, {
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    timeoutMs: options.config.requestTimeoutMs,
    origin: SOURCES.pornrips.origin,
    allowedHosts: new Set(['pornrips.to']),
    headers: {
      Accept: 'application/x-bittorrent, application/octet-stream;q=0.9',
      'User-Agent': 'OnlyPorn-TPB4K/2.7',
    },
  });
  try {
    const status = Number(request.response?.status || 0);
    if (status < 200 || status >= 300) return [];
    const contentType = responseHeader(request.response, 'content-type').split(';')[0].trim().toLowerCase();
    if (contentType && !['application/x-bittorrent', 'application/octet-stream'].includes(contentType)) return [];
    const torrent = decodeTorrent(await readBoundedBuffer(request.response, NATIVE_MAX_TORRENT_BYTES));
    return [{
      source: 'pornrips',
      sourceId,
      title: item?.title || torrent.filename,
      filename: torrent.filename || item?.title,
      infoHash: torrent.infoHash,
      size: torrent.size || item?.size,
      seeders: 0,
      provenance: ['pornrips-authoritative-torrent'],
    }];
  } finally {
    request.clearTimeout();
  }
}

function firstHentaiEpisodePath(html) {
  for (const anchor of anchorRecords(html)) {
    const path = sameOriginPath(SOURCES.hentai.origin, anchor.href, ['/episodes/']);
    if (path && /^\/episodes\/[^/?#]+\/?$/i.test(new URL(path, SOURCES.hentai.origin).pathname)) return path;
  }
  return '';
}

function hentaiPostId(html) {
  return String(html || '').match(/\bname=["']idpost["'][^>]*\bvalue=["'](\d+)["']/i)?.[1]
    || String(html || '').match(/\bidpost\b[^0-9]{0,40}(\d+)/i)?.[1]
    || String(html || '').match(/\ba\s*:\s*["'](\d+)["']/i)?.[1]
    || '';
}

function iframeUrlsFromAjax(payload) {
  const source = String(payload || '').replaceAll('\\/', '/').replaceAll('\\"', '"');
  return [...source.matchAll(/\bsrc\s*=\s*["']([^"']+)["']/gi)]
    .map(match => absoluteHttps(SOURCES.hentai.origin, match[1]))
    .filter(Boolean);
}

function mediaUrlsFromPlayer(html) {
  return [...String(html || '').matchAll(/\bfile\s*:\s*["'](https:[^"']+\.mp4(?:\?[^"']*)?)["']/gi)]
    .map(match => match[1].replaceAll('&amp;', '&'));
}

async function validateHentaiMedia(url, options) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return '';
  }
  if (!HENTAI_MEDIA_HOST.test(parsed.hostname) || !/\.mp4$/i.test(parsed.pathname)) return '';
  const request = await safeNativeRequest(parsed.toString(), {
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    timeoutMs: options.config.requestTimeoutMs,
    origin: parsed.origin,
    allowedHosts: new Set([parsed.hostname.toLowerCase()]),
    method: 'HEAD',
    headers: {
      Accept: 'video/mp4, application/octet-stream;q=0.9',
      'User-Agent': 'OnlyPorn-TPB4K/2.7',
    },
  });
  try {
    const status = Number(request.response?.status || 0);
    const type = responseHeader(request.response, 'content-type').split(';')[0].trim().toLowerCase();
    try {
      if (typeof request.response?.body?.cancel === 'function') await request.response.body.cancel();
    } catch {
      // HEAD responses normally have no body.
    }
    return status >= 200
      && status < 300
      && ['video/mp4', 'application/octet-stream'].includes(type)
      ? parsed.toString()
      : '';
  } finally {
    request.clearTimeout();
  }
}

async function resolveHentai({ client, sourceId, item, options }) {
  const path = decodeStablePathId('hentai', sourceId);
  if (!path) return [];
  const seriesHtml = safeHtml(
    await client.fetchText(absoluteHttps(SOURCES.hentai.origin, path), {
      cacheKey: `hentai:detail:${path}`,
    }),
    'hentai'
  );
  const episodePath = firstHentaiEpisodePath(seriesHtml);
  if (!episodePath) return [];
  const episodeHtml = safeHtml(
    await client.fetchText(absoluteHttps(SOURCES.hentai.origin, episodePath), {
      cacheKey: `hentai:episode:${episodePath}`,
    }),
    'hentai'
  );
  const postId = hentaiPostId(episodeHtml);
  if (!postId) return [];

  const ajaxUrl = `${SOURCES.hentai.origin}/wp-admin/admin-ajax.php`;
  const request = await safeNativeRequest(ajaxUrl, {
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    timeoutMs: options.config.requestTimeoutMs,
    origin: SOURCES.hentai.origin,
    allowedHosts: new Set(['hentaimama.io']),
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'OnlyPorn-TPB4K/2.7',
    },
    body: new URLSearchParams({ action: 'get_player_contents', a: postId }).toString(),
  });
  let ajaxPayload = '';
  try {
    const status = Number(request.response?.status || 0);
    if (status < 200 || status >= 300) return [];
    ajaxPayload = await readBoundedText(request.response, NATIVE_MAX_AJAX_BYTES);
  } finally {
    request.clearTimeout();
  }
  const playerUrls = iframeUrlsFromAjax(ajaxPayload)
    .filter(url => {
      const parsed = new URL(url);
      return parsed.origin === SOURCES.hentai.origin && /^\/new(?:2|jav)\.php$/i.test(parsed.pathname);
    });

  const mediaUrls = [];
  for (const playerUrl of playerUrls) {
    const playerHtml = await client.fetchText(playerUrl, {
      cacheKey: `hentai:player:${playerUrl}`,
    });
    mediaUrls.push(...mediaUrlsFromPlayer(playerHtml));
  }
  mediaUrls.sort((left, right) => Number(!/\/\/gdvid\.info\//i.test(left)) - Number(!/\/\/gdvid\.info\//i.test(right)));
  for (const mediaUrl of uniqueBy(mediaUrls, value => value)) {
    const validatedUrl = await validateHentaiMedia(mediaUrl, options);
    if (!validatedUrl) continue;
    return [{
      source: 'hentai',
      sourceId,
      title: item?.title || slugTitle(episodePath),
      filename: `${slugTitle(episodePath)}.mp4`,
      url: validatedUrl,
      validated: true,
      provenance: ['hentaimama-episode-player'],
    }];
  }
  return [];
}

function descriptionFromBlock(block, labels = []) {
  const text = cleanText(block);
  for (const label of labels) {
    const match = text.match(new RegExp(`${label}\\s*:?\\s*([^|]{2,180})`, 'i'));
    if (match) return cleanText(match[1]);
  }
  return text.slice(0, 500);
}

function exactPath(base, href, prefix, pattern) {
  const path = sameOriginPath(base, href, [prefix]);
  if (!path) return '';
  const url = new URL(path, base);
  return pattern.test(url.pathname) ? url.pathname : '';
}

function imageTextFromBlock(block) {
  const img = firstTag(block, 'img');
  return cleanText(attribute(img, 'alt') || attribute(img, 'title'));
}

function slugTitle(path) {
  const slug = String(path || '').split('/').filter(Boolean).at(-1) || '';
  return cleanText(slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()));
}

function usefulStudio(value) {
  const text = cleanText(value);
  if (!text || /^(?:announcements?|uncategorized|news|updates?|featured|homepage)$/i.test(text)) return '';
  if (/\b(?:1080p|2160p|4k|720p|hevc|x265|x264)\b/i.test(text)) return '';
  return text;
}

function parsePornripsCatalog(html) {
  const base = SOURCES.pornrips.origin;
  const blocks = blocksByStart(html, /<article\b[^>]*>/gi);
  const candidates = blocks.length ? blocks : blocksByStart(html, /<h[12]\b[^>]*class=["'][^"']*(?:entry-title|post-title)[^"']*["'][^>]*>/gi);
  return uniqueBy(candidates.map((block, index) => {
    const anchors = anchorRecords(block);
    const link = anchors.find(item => /(?:entry-title|post-title)/i.test(item.className))
      || anchors.find(item => item.href && !/\/(?:category|tag|author)\//i.test(item.href));
    const path = sameOriginPath(base, link?.href, ['/']);
    const title = cleanText(link?.title || link?.text || firstContent(block));
    if (!path || !title || path === '/') return null;
    const text = cleanText(block);
    const size = text.match(/\b(?:file\s*size|size)\s*:?\s*([0-9.]+\s*(?:KB|MB|GB|TB))/i)?.[1]
      || text.match(/\b([0-9.]+\s*(?:GB|MB))\b/i)?.[1]
      || '';
    const timeTag = String(block).match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] || '';
    const category = anchors
      .filter(item => /\/(?:category|studios?|network)\//i.test(item.href))
      .map(item => usefulStudio(item.text))
      .find(Boolean) || '';
    const duration = parseDurationSeconds(text);
    return {
      sourceId: stablePathId('pornrips', path),
      title,
      poster: imageUrl(base, block),
      background: imageUrl(base, block),
      description: [size && `Size: ${size}`, duration && `Duration: ${duration}s`].filter(Boolean).join(' · '),
      studio: category,
      releaseDate: cleanText(timeTag),
      duration,
      size,
      detailUrl: absoluteHttps(base, path),
      upstreamId: path,
      _path: path,
      _index: index,
    };
  }).filter(Boolean), item => item.sourceId);
}

function pornripsSceneKey(item = {}) {
  return cleanText(item.title || '')
    .toLowerCase()
    .replace(/\b(?:2160p|1080p|720p|480p|4k|8k|uhd|hevc|h26[45]|x26[45]|av1|xvid|xxx|prt)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function pornripsReleaseRank(item = {}) {
  const title = cleanText(item.title);
  const resolution = /\b(?:2160p|4k)\b/i.test(title) ? 4
    : /\b1080p\b/i.test(title) ? 3
      : /\b720p\b/i.test(title) ? 2
        : /\b480p\b/i.test(title) ? 1 : 0;
  const compatibility = /\b(?:h264|x264|avc)\b/i.test(title) ? 2
    : /\b(?:hevc|h265|x265)\b/i.test(title) ? 0 : 1;
  return resolution * 10 + compatibility;
}

function dedupePornripsScenes(items = []) {
  const byScene = new Map();
  const order = [];
  for (const item of items) {
    const key = pornripsSceneKey(item) || String(item?.sourceId || '');
    if (!key) continue;
    const previous = byScene.get(key);
    if (!previous) {
      order.push(key);
      byScene.set(key, item);
    } else if (pornripsReleaseRank(item) > pornripsReleaseRank(previous)) {
      byScene.set(key, item);
    }
  }
  return order.map(key => byScene.get(key)).filter(Boolean);
}

function parseYespornCatalog(html) {
  const base = SOURCES.yesporn.origin;
  const links = anchorRecords(html)
    .map((link, index) => ({
      link,
      index,
      path: exactPath(base, link.href, '/video/', /^\/video\/\d+\/[^/?#]+\/?$/i),
    }))
    .filter(item => item.path);

  return uniqueBy(links.map(({ link, index, path }) => {
    const title = cleanText(
      imageTextFromBlock(link.tag)
      || link.title
      || firstContent(link.tag, ['strong', 'h2', 'h3'])
      || link.text
      || slugTitle(path)
    );
    if (!title) return null;
    const poster = imageUrl(base, link.tag);
    return {
      sourceId: stablePathId('yesporn', path),
      title,
      poster,
      background: poster,
      description: '',
      duration: parseDurationSeconds(link.text),
      detailUrl: absoluteHttps(base, path),
      upstreamId: path,
      _path: path,
      _index: index,
    };
  }).filter(Boolean), item => item.sourceId);
}

function enclosingArticle(source, offset) {
  const html = String(source || '');
  const start = html.lastIndexOf('<article', offset);
  if (start < 0) return '';
  const close = html.indexOf('</article>', offset);
  if (close < 0 || close - start > 180_000) return '';
  return html.slice(start, close + '</article>'.length);
}

function hentaiPathOccurrences(html) {
  const base = SOURCES.hentai.origin;
  const source = String(html || '');
  const records = [];
  const regex = /<a\b[^>]*href\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of source.matchAll(regex)) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    const path = exactPath(base, href, '/tvshows/', /^\/tvshows\/[^/?#]+\/?$/i);
    if (!path) continue;
    records.push({
      path,
      index: match.index ?? 0,
      tag: match[0],
      label: cleanText(attribute(match[0], 'title') || match[4]),
    });
  }
  return records;
}

function parseHentaiCatalog(html) {
  const base = SOURCES.hentai.origin;
  const source = String(html || '');
  const occurrences = hentaiPathOccurrences(source);
  const grouped = new Map();

  for (const occurrence of occurrences) {
    const existing = grouped.get(occurrence.path) || {
      path: occurrence.path,
      index: occurrence.index,
      labels: [],
      blocks: [],
      tags: [],
    };
    if (occurrence.label) existing.labels.push(occurrence.label);
    existing.tags.push(occurrence.tag);
    const block = enclosingArticle(source, occurrence.index);
    if (block && !existing.blocks.includes(block)) existing.blocks.push(block);
    grouped.set(occurrence.path, existing);
  }

  const items = [];
  for (const entry of grouped.values()) {
    const block = entry.blocks.sort((left, right) => right.length - left.length)[0]
      || source.slice(Math.max(entry.index - 4_000, 0), Math.min(entry.index + 16_000, source.length));
    const samePathLabels = anchorRecords(block)
      .filter(link => exactPath(base, link.href, '/tvshows/', /^\/tvshows\/[^/?#]+\/?$/i) === entry.path)
      .map(link => cleanText(link.title || link.text))
      .filter(Boolean);
    const title = cleanText(
      samePathLabels[0]
      || entry.labels[0]
      || firstContent(block, ['h3', 'h2', 'h1'])
      || imageTextFromBlock(block)
      || slugTitle(entry.path)
    );
    if (!title) continue;
    const text = cleanText(block);
    const rating = text.match(/\b([0-9](?:\.[0-9])?)\s*(?:\/\s*10)?\b/)?.[1] || '';
    const year = text.match(/\b((?:19|20)\d{2})\b/)?.[1] || '';
    const poster = imageUrl(base, block);
    items.push({
      sourceId: stablePathId('hentai', entry.path),
      title,
      poster,
      background: poster,
      description: [rating && `Rating: ${rating}/10`, year && `Year: ${year}`].filter(Boolean).join(' · '),
      releaseDate: year,
      detailUrl: absoluteHttps(base, entry.path),
      upstreamId: entry.path,
      _path: entry.path,
      _index: entry.index,
    });
  }

  return uniqueBy(items.sort((left, right) => left._index - right._index), item => item.sourceId);
}

function parseDetail(source, html, sourceId) {
  const base = SOURCES[source].origin;
  const path = decodeStablePathId(source, sourceId);
  if (!path) return null;
  const title = metaContent(html, 'og:title') || firstContent(html, ['h1', 'h2']);
  if (!title) return null;
  const poster = absoluteHttps(base, metaContent(html, 'og:image')) || imageUrl(base, html);
  const description = metaContent(html, 'og:description') || metaContent(html, 'description') || descriptionFromBlock(html, ['Description', 'Synopsis']);
  const anchors = anchorRecords(html);
  const performers = uniqueBy(anchors
    .filter(item => /\/(?:pornstar|performer|model|actor|actress)\//i.test(item.href))
    .map(item => cleanText(item.text))
    .filter(Boolean), item => item).slice(0, 30);
  const studio = anchors
    .filter(item => /\/(?:studio|network|category)\//i.test(item.href))
    .map(item => usefulStudio(item.text))
    .find(Boolean) || '';
  const releaseDate = String(html).match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1]
    || metaContent(html, 'video:release_date')
    || '';
  return {
    sourceId,
    title,
    poster,
    background: poster,
    description: cleanText(description).slice(0, 2_000),
    studio,
    performers,
    releaseDate: cleanText(releaseDate),
    duration: parseDurationSeconds(metaContent(html, 'video:duration') || html),
    detailUrl: absoluteHttps(base, path),
    upstreamId: path,
  };
}

function buildCatalogUrl(source, catalog, page) {
  if (source === 'pornrips') return page === 1 ? `${SOURCES.pornrips.origin}/` : `${SOURCES.pornrips.origin}/page/${page}/`;
  if (source === 'yesporn') return `${SOURCES.yesporn.origin}/latest-updates/${page}/`;
  const suffix = page === 1 ? '/hentai-series/' : `/hentai-series/page/${page}/`;
  const mode = String(catalog?.mode || '').toLowerCase();
  const query = mode === 'top' ? '?filter=rating' : mode === 'new' ? '?filter=latest' : '';
  return `${SOURCES.hentai.origin}${suffix}${query}`;
}

function createNativeAdapter(source, options = {}) {
  const client = createNativeClient(source, options.config, options);
  const index = new Map();
  const catalogWindows = new Map();
  const parser = source === 'pornrips' ? parsePornripsCatalog : source === 'yesporn' ? parseYespornCatalog : parseHentaiCatalog;
  return Object.freeze({
    id: source,
    configured: true,
    native: true,
    origin: SOURCES[source].origin,
    async catalog({ catalog, skip = 0, limit = 40 }) {
      const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
      const safeLimit = Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1);
      const targetEnd = safeSkip + safeLimit;
      const catalogKey = String(catalog?.id || `${source}:${catalog?.mode || 'recent'}`);
      let state = catalogWindows.get(catalogKey);
      if (!state) {
        state = { nextPage: 1, records: [], seen: new Set(), sceneSeen: new Set() };
        catalogWindows.set(catalogKey, state);
      }

      // Build one stable, deduplicated source timeline and slice it by the
      // Stremio skip. The global content filter can request an overscan limit
      // of 100 while the visible page remains 40; deriving the upstream page
      // from that overscan limit caused skip=40 to request page one again.
      // Keeping a canonical timeline also tolerates WordPress page overlap
      // when new posts shift between page requests.
      let pagesFetched = 0;
      while (
        state.records.length < targetEnd
        && pagesFetched < NATIVE_MAX_CATALOG_PAGES_PER_REQUEST
      ) {
        const page = state.nextPage;
        const url = buildCatalogUrl(source, catalog, page);
        const payload = safeHtml(
          await client.fetchText(url, { cacheKey: `${source}:${catalog?.mode || 'recent'}:${page}` }),
          source
        );
        if (!payload) break;
        const parsedRecords = parser(payload);
        const pageRecords = source === 'pornrips'
          ? dedupePornripsScenes(parsedRecords)
          : parsedRecords;
        if (!pageRecords.length) break;
        state.nextPage += 1;
        pagesFetched += 1;
        for (const record of pageRecords) {
          if (!record?.sourceId || state.seen.has(record.sourceId)) continue;
          if (source === 'pornrips') {
            const sceneKey = pornripsSceneKey(record);
            if (sceneKey && state.sceneSeen.has(sceneKey)) continue;
            if (sceneKey) state.sceneSeen.add(sceneKey);
          }
          state.seen.add(record.sourceId);
          state.records.push(record);
        }
      }

      const window = state.records.slice(safeSkip, targetEnd);
      for (const record of window) index.set(record.sourceId, record);
      return window;
    },
    async meta({ sourceId }) {
      const remembered = index.get(String(sourceId || ''));
      const path = decodeStablePathId(source, sourceId);
      if (!path) return remembered || null;
      const url = absoluteHttps(SOURCES[source].origin, path);
      const payload = safeHtml(await client.fetchText(url, { cacheKey: `${source}:detail:${path}` }), source);
      const detailed = payload ? parseDetail(source, payload, sourceId) : null;
      return detailed || remembered || null;
    },
    async resolve(args = {}) {
      if (source === 'pornrips') {
        return resolvePornrips({ client, ...args, options });
      }
      if (source === 'hentai') {
        return resolveHentai({ client, ...args, options });
      }
      if (source === 'yesporn') {
        return resolveYesporn({ ...args, options });
      }
      return [];
    },
  });
}

module.exports = {
  NATIVE_MAX_CATALOG_PAGES_PER_REQUEST,
  NATIVE_MAX_RETRIES,
  NATIVE_MIN_REQUEST_INTERVAL_MS,
  SOURCES,
  buildCatalogUrl,
  createNativeAdapter,
  dedupePornripsScenes,
  decodeTorrent,
  firstHentaiEpisodePath,
  hentaiPostId,
  iframeUrlsFromAjax,
  mediaUrlsFromPlayer,
  parseDetail,
  parseHentaiCatalog,
  parsePornripsCatalog,
  pornripsSceneKey,
  readBoundedBuffer,
  resolveYesporn,
  safeNativeRequest,
  parseYespornCatalog,
  torrentUrlFromDetail,
  yespornStreamPairs,
};
