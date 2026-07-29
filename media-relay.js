const crypto = require('node:crypto');
const axios = require('axios');
const BoundedTtlCache = require('./provider/cache');
const logger = require('./logger');

const ENTRY_TTL_MS = 45 * 60 * 1000;
const MAX_ENTRIES = 8000;
const MAX_REDIRECTS = 5;
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;
const JAV_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const entries = new BoundedTtlCache({ maxEntries: MAX_ENTRIES, ttlMs: ENTRY_TTL_MS });

const PROVIDER_SUFFIXES = {
  eporner: ['eporner.com'],
  xvideos: ['xvideos.com', 'xvideos-cdn.com'],
  xnxx: ['xnxx.com', 'xnxx-cdn.com'],
  pornhub: ['phncdn.com'],
  javhdporn: [
    'javhdporn.net',
    'pornfhd.com',
    'storagexhd.com',
    'streamhls.click',
    'tiktokcdn.com',
  ],
};

const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'origin',
  'cookie',
  'referer',
  'user-agent',
]);

let observedPublicBase = '';

function normalizePublicBase(value) {
  if (!value) return '';
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function configuredPublicBase() {
  return normalizePublicBase(
    process.env.ADDON_BASE_URL ||
      process.env.PUBLIC_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      (process.env.RENDER_EXTERNAL_HOSTNAME
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
        : '')
  );
}

function setPublicBase(value) {
  const normalized = normalizePublicBase(value);
  if (normalized) observedPublicBase = normalized;
}

function getPublicBase() {
  return configuredPublicBase() || observedPublicBase;
}

function hostnameAllowed(hostname, provider) {
  const suffixes = PROVIDER_SUFFIXES[provider] || [];
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return suffixes.some(suffix => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function validateTargetUrl(value, provider) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('Invalid media relay URL');
  }

  if (parsed.protocol !== 'https:') throw new Error('Media relay permits HTTPS only');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in media URLs');
  if (parsed.port && parsed.port !== '443') throw new Error('Non-standard media ports are not allowed');
  if (!hostnameAllowed(parsed.hostname, provider)) {
    throw new Error(`Media host is not approved for ${provider}`);
  }

  parsed.hash = '';
  return parsed.toString();
}

function sanitizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || !SAFE_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    result[key] = String(value);
  }
  return result;
}

function kindFromUrl(value, fallback = 'binary') {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    if (pathname.endsWith('.m3u8')) return 'hls';
    if (pathname.endsWith('.mp4')) return 'mp4';
    if (pathname.endsWith('.m4s')) return 'segment';
    if (pathname.endsWith('.ts')) return 'segment';
    if (pathname.endsWith('.key')) return 'key';
  } catch {
    // Use fallback.
  }
  return fallback;
}

function filenameFor(kind) {
  if (kind === 'hls') return 'index.m3u8';
  if (kind === 'mp4') return 'video.mp4';
  if (kind === 'key') return 'key.bin';
  return 'segment.bin';
}

function register({ url, headers = {}, provider, kind, ttlMs = ENTRY_TTL_MS }) {
  const publicBase = getPublicBase();
  if (!publicBase) throw new Error('Media relay public base URL is not initialized');

  const safeUrl = validateTargetUrl(url, provider);
  const resolvedKind = kind || kindFromUrl(safeUrl);
  const token = crypto.randomBytes(24).toString('base64url');
  entries.set(
    token,
    {
      url: safeUrl,
      headers: sanitizeHeaders(headers),
      provider,
      kind: resolvedKind,
    },
    ttlMs
  );

  logger.debug({ provider, kind: resolvedKind }, 'Media relay token registered');
  return `${publicBase}/media/${token}/${filenameFor(resolvedKind)}`;
}

function resolveChildUrl(parentUrl, value) {
  try {
    return new URL(value, parentUrl).toString();
  } catch {
    return '';
  }
}

function relayChild(entry, parentUrl, value, kind) {
  const resolved = resolveChildUrl(parentUrl, value);
  if (!resolved) return value;
  try {
    return register({
      url: resolved,
      headers: entry.headers,
      provider: entry.provider,
      kind: kind || kindFromUrl(resolved),
    });
  } catch {
    return resolved;
  }
}

function kindFromPlaylistTag(line, fallbackUrl = '') {
  const normalized = String(line || '').toUpperCase();
  if (normalized.startsWith('#EXT-X-STREAM-INF')) return 'hls';
  if (normalized.startsWith('#EXT-X-I-FRAME-STREAM-INF')) return 'hls';
  if (normalized.startsWith('#EXT-X-MEDIA')) return 'hls';
  if (normalized.startsWith('#EXT-X-KEY')) return 'key';
  if (normalized.startsWith('#EXT-X-MAP')) return 'segment';
  if (normalized.startsWith('#EXTINF')) return 'segment';
  return kindFromUrl(fallbackUrl);
}

function rewritePlaylist(content, finalUrl, entry) {
  let pendingKind = '';
  return String(content)
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (!trimmed.startsWith('#')) {
        const rewritten = relayChild(entry, finalUrl, trimmed, pendingKind);
        pendingKind = '';
        return rewritten;
      }

      if (trimmed.startsWith('#EXT-X-STREAM-INF')) pendingKind = 'hls';
      else if (trimmed.startsWith('#EXTINF')) pendingKind = 'segment';

      if (!/URI="[^"]+"/.test(line)) return line;
      const uriKind = kindFromPlaylistTag(trimmed);
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        return `URI="${relayChild(entry, finalUrl, uri, uriKind)}"`;
      });
    })
    .join('\n');
}

function pngPayloadOffset(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  if (input.length < signature.length || !input.subarray(0, 8).equals(signature)) return -1;

  let offset = 8;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataEnd = typeStart + 4 + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > input.length) return -1;
    const type = input.subarray(typeStart, typeStart + 4).toString('ascii');
    if (type === 'IEND') return chunkEnd;
    offset = chunkEnd;
  }
  return -1;
}

function looksLikeTransportStream(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 188 || buffer[0] !== 0x47) return false;
  const checks = Math.min(4, Math.floor(buffer.length / 188));
  for (let index = 1; index < checks; index += 1) {
    if (buffer[index * 188] !== 0x47) return false;
  }
  return true;
}

function stripPngWrappedTsBuffer(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const payloadOffset = pngPayloadOffset(input);
  if (payloadOffset < 0) return null;
  const payload = input.subarray(payloadOffset);
  return looksLikeTransportStream(payload) ? payload : null;
}

function isJavWrappedSegment(entry) {
  if (entry?.provider !== 'javhdporn' || entry?.kind !== 'segment') return false;
  try {
    const hostname = new URL(entry.url).hostname.toLowerCase();
    return hostname === 'tiktokcdn.com' || hostname.endsWith('.tiktokcdn.com');
  } catch {
    return false;
  }
}

async function upstreamRequest(entry, { method = 'GET', range, text = false, buffer = false } = {}) {
  let currentUrl = entry.url;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    currentUrl = validateTargetUrl(currentUrl, entry.provider);
    const headers = {
      ...entry.headers,
      Accept: text
        ? 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*'
        : entry.headers.Accept || '*/*',
    };
    if (!text && range) headers.Range = range;

    const response = await axios.request({
      url: currentUrl,
      method,
      headers,
      maxRedirects: 0,
      responseType: text ? 'text' : (buffer ? 'arraybuffer' : 'stream'),
      timeout: 30_000,
      validateStatus: () => true,
      decompress: true,
      maxContentLength: text
        ? PLAYLIST_MAX_BYTES
        : (buffer ? JAV_SEGMENT_MAX_BYTES : Infinity),
      maxBodyLength: buffer ? JAV_SEGMENT_MAX_BYTES : Infinity,
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects >= MAX_REDIRECTS) throw new Error('Media relay exceeded redirect limit');
      const location = response.headers.location;
      if (!location) throw new Error('Media redirect did not include a Location header');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl };
  }

  throw new Error('Media relay request failed');
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
}

async function handleRequest(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const entry = entries.get(req.params.token);
  if (!entry) {
    res.status(410).type('text/plain').send('Media relay link expired');
    return;
  }

  try {
    if (entry.kind === 'hls') {
      const { response, finalUrl } = await upstreamRequest(entry, {
        method: 'GET',
        text: true,
      });

      if (response.status < 200 || response.status >= 300) {
        res.status(response.status).type('text/plain').send('Upstream playlist request failed');
        return;
      }

      const content = String(response.data || '');
      if (!content.includes('#EXTM3U')) {
        res.status(502).type('text/plain').send('Upstream did not return an HLS playlist');
        return;
      }

      const rewritten = rewritePlaylist(content, finalUrl, entry);
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Content-Length', Buffer.byteLength(rewritten));
      if (req.method === 'HEAD') res.end();
      else res.end(rewritten);
      return;
    }

    if (isJavWrappedSegment(entry)) {
      const { response } = await upstreamRequest(entry, {
        method: 'GET',
        text: false,
        buffer: true,
      });

      if (response.status < 200 || response.status >= 300) {
        res.status(response.status).type('text/plain').send('Upstream segment request failed');
        return;
      }

      const wrapped = Buffer.from(response.data || '');
      const payload = stripPngWrappedTsBuffer(wrapped);
      if (!payload) {
        res.status(502).type('text/plain').send('JAVHDPorn segment wrapper was not recognized');
        return;
      }

      logger.debug(
        {
          provider: entry.provider,
          wrapperBytes: wrapped.length - payload.length,
          payloadBytes: payload.length,
        },
        'JAVHDPorn PNG-wrapped MPEG-TS segment decoded'
      );

      res.status(200);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Content-Length', payload.length);
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      if (req.method === 'HEAD') res.end();
      else res.end(payload);
      return;
    }

    const { response, finalUrl } = await upstreamRequest(entry, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      range: req.headers.range,
      text: false,
    });

    if (entry.provider === 'eporner' && /\/na\.mp4(?:$|[?#])/i.test(finalUrl)) {
      response.data?.destroy?.();
      logger.warn({ provider: entry.provider }, 'Eporner rejected a relayed media URL');
      res.status(502).type('text/plain').send('Eporner media URL was rejected upstream');
      return;
    }

    res.status(response.status);
    const forwardedHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
    ];
    for (const name of forwardedHeaders) {
      const value = response.headers[name];
      if (value != null) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'HEAD') {
      response.data?.destroy?.();
      res.end();
      return;
    }

    response.data.on('error', error => {
      logger.warn({ provider: entry.provider, error: error.message }, 'Media relay upstream stream failed');
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    });
    res.on('close', () => {
      if (!res.writableEnded) response.data.destroy();
    });
    response.data.pipe(res);
  } catch (error) {
    logger.warn({ provider: entry.provider, error: error.message }, 'Media relay request failed');
    if (!res.headersSent) res.status(502).type('text/plain').send('Media relay request failed');
    else res.destroy(error);
  }
}

module.exports = {
  getPublicBase,
  handleRequest,
  register,
  setPublicBase,
  _test: {
    entries,
    hostnameAllowed,
    isJavWrappedSegment,
    kindFromPlaylistTag,
    kindFromUrl,
    normalizePublicBase,
    pngPayloadOffset,
    rewritePlaylist,
    stripPngWrappedTsBuffer,
    validateTargetUrl,
  },
};
