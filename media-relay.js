const crypto = require('node:crypto');
const axios = require('axios');
const BoundedTtlCache = require('./provider/cache');
const logger = require('./logger');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 8000;
const MAX_COMPACT_CHILDREN_PER_SESSION = 12000;
const CHILD_TOKEN_VERSION = 'c1';
const COMPACT_CHILD_TOKEN_VERSION = 'r1';
const CHILD_TOKEN_SIGNATURE_BYTES = 18;
const PLAYLIST_CHILD_ERROR_CODE = 'HLS_CHILD_REJECTED';
const CHILD_TOKEN_SECRET = crypto.randomBytes(32);
const MAX_REDIRECTS = 5;
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;
const JAV_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const entries = new BoundedTtlCache({ maxEntries: MAX_SESSIONS, ttlMs: SESSION_TTL_MS });

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
    'vdcdn.xyz',
    'edge-hls.saawsedge.com',
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
  // Stremio's FFmpeg rejects HLS media objects whose public URL ends in .bin,
  // even when the response is a valid video/mp2t payload. The protected relay
  // may decode an upstream .image/.webp object, but its public transport name
  // must remain an FFmpeg-approved MPEG-TS extension.
  if (kind === 'segment') return 'segment.ts';
  return 'media.bin';
}

const KIND_TO_CODE = Object.freeze({
  hls: 'h',
  mp4: 'm',
  segment: 's',
  key: 'k',
  binary: 'b',
});

const CODE_TO_KIND = Object.freeze(
  Object.fromEntries(Object.entries(KIND_TO_CODE).map(([kind, code]) => [code, kind]))
);

function signChildToken(unsignedToken) {
  return crypto
    .createHmac('sha256', CHILD_TOKEN_SECRET)
    .update(unsignedToken)
    .digest()
    .subarray(0, CHILD_TOKEN_SIGNATURE_BYTES)
    .toString('base64url');
}

function signaturesEqual(left, right) {
  try {
    const a = Buffer.from(String(left), 'base64url');
    const b = Buffer.from(String(right), 'base64url');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function createSessionEntry({ url, headers = {}, provider, kind, ttlMs = SESSION_TTL_MS }) {
  const safeUrl = validateTargetUrl(url, provider);
  const resolvedKind = kind || kindFromUrl(safeUrl);
  const token = crypto.randomBytes(24).toString('base64url');
  const entry = {
    url: safeUrl,
    headers: sanitizeHeaders(headers),
    provider,
    kind: resolvedKind,
    sessionToken: token,
    compactChildren: new Map(),
    compactChildIds: new Map(),
    nextCompactChildId: 0,
  };

  entries.set(token, entry, ttlMs);
  logger.debug({ provider, kind: resolvedKind }, 'Media relay session registered');
  return entry;
}

function register({ url, headers = {}, provider, kind, ttlMs = SESSION_TTL_MS }) {
  const publicBase = getPublicBase();
  if (!publicBase) throw new Error('Media relay public base URL is not initialized');

  const entry = createSessionEntry({ url, headers, provider, kind, ttlMs });
  return `${publicBase}/media/${entry.sessionToken}/${filenameFor(entry.kind)}`;
}

function ensureSessionEntry(entry, parentUrl) {
  if (entry?.sessionToken) {
    const stored = entries.get(entry.sessionToken);
    if (stored) return stored;
  }

  if (!entry?.provider) throw new Error('Media relay provider is missing');
  return createSessionEntry({
    url: entry.url || parentUrl,
    headers: entry.headers,
    provider: entry.provider,
    kind: entry.kind || 'hls',
  });
}

function createChildToken(sessionEntry, url, kind) {
  const safeUrl = validateTargetUrl(url, sessionEntry.provider);
  const resolvedKind = kind || kindFromUrl(safeUrl);
  const kindCode = KIND_TO_CODE[resolvedKind] || KIND_TO_CODE.binary;
  const encodedUrl = Buffer.from(safeUrl, 'utf8').toString('base64url');
  const unsignedToken = [
    CHILD_TOKEN_VERSION,
    sessionEntry.sessionToken,
    kindCode,
    encodedUrl,
  ].join('.');
  return `${unsignedToken}.${signChildToken(unsignedToken)}`;
}

function createCompactChildToken(sessionEntry, url, kind) {
  const safeUrl = validateTargetUrl(url, sessionEntry.provider);
  const resolvedKind = kind || kindFromUrl(safeUrl);
  const kindCode = KIND_TO_CODE[resolvedKind] || KIND_TO_CODE.binary;
  const childKey = `${kindCode}\0${safeUrl}`;
  let childId = sessionEntry.compactChildIds.get(childKey);

  if (!childId) {
    if (sessionEntry.compactChildren.size >= MAX_COMPACT_CHILDREN_PER_SESSION) {
      throw new Error('Media relay compact child limit exceeded');
    }
    sessionEntry.nextCompactChildId += 1;
    childId = sessionEntry.nextCompactChildId.toString(36);
    sessionEntry.compactChildIds.set(childKey, childId);
    sessionEntry.compactChildren.set(childId, { url: safeUrl, kind: resolvedKind });
  }

  const unsignedToken = [
    COMPACT_CHILD_TOKEN_VERSION,
    sessionEntry.sessionToken,
    kindCode,
    childId,
  ].join('.');
  return `${unsignedToken}.${signChildToken(unsignedToken)}`;
}

function resolveCompactChildToken(token) {
  if (typeof token !== 'string' || token.length > 256) return undefined;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== COMPACT_CHILD_TOKEN_VERSION) return undefined;

  const [version, sessionToken, kindCode, childId, signature] = parts;
  const kind = CODE_TO_KIND[kindCode];
  if (!kind || !sessionToken || !childId || !signature) return undefined;

  const unsignedToken = [version, sessionToken, kindCode, childId].join('.');
  if (!signaturesEqual(signature, signChildToken(unsignedToken))) return undefined;

  const sessionEntry = entries.get(sessionToken);
  const child = sessionEntry?.compactChildren?.get(childId);
  if (!child || child.kind !== kind) return undefined;

  try {
    return {
      ...sessionEntry,
      url: validateTargetUrl(child.url, sessionEntry.provider),
      kind,
      sessionToken,
    };
  } catch {
    return undefined;
  }
}

function resolveChildToken(token) {
  if (typeof token !== 'string' || token.length > 16_384) return undefined;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== CHILD_TOKEN_VERSION) return undefined;

  const [version, sessionToken, kindCode, encodedUrl, signature] = parts;
  const kind = CODE_TO_KIND[kindCode];
  if (!kind || !sessionToken || !encodedUrl || !signature) return undefined;

  const unsignedToken = [version, sessionToken, kindCode, encodedUrl].join('.');
  if (!signaturesEqual(signature, signChildToken(unsignedToken))) return undefined;

  const sessionEntry = entries.get(sessionToken);
  if (!sessionEntry) return undefined;

  let decodedUrl;
  try {
    decodedUrl = Buffer.from(encodedUrl, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }

  try {
    return {
      ...sessionEntry,
      url: validateTargetUrl(decodedUrl, sessionEntry.provider),
      kind,
      sessionToken,
    };
  } catch {
    return undefined;
  }
}

function resolveRelayEntry(token) {
  return entries.get(token) || resolveCompactChildToken(token) || resolveChildToken(token);
}

class PlaylistChildRelayError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PlaylistChildRelayError';
    this.code = PLAYLIST_CHILD_ERROR_CODE;
    if (cause) this.cause = cause;
  }
}

function resolveChildUrl(parentUrl, value) {
  const childValue = String(value ?? '').trim();
  if (!childValue) return '';
  try {
    return new URL(childValue, parentUrl).toString();
  } catch {
    return '';
  }
}

function relayChild(entry, parentUrl, value, kind) {
  const resolved = resolveChildUrl(parentUrl, value);
  if (!resolved) {
    throw new PlaylistChildRelayError('HLS playlist contains an invalid child URL');
  }

  try {
    const publicBase = getPublicBase();
    if (!publicBase) throw new Error('Media relay public base URL is not initialized');
    const sessionEntry = ensureSessionEntry(entry, parentUrl);
    const resolvedKind = kind || kindFromUrl(resolved);
    // Keep child references compact because AIOStreams and Stremio wrap this URL
    // again. Targets live inside the one signed playback session, so a long VOD
    // still consumes one global cache entry while every child stays validated and
    // behind the OnlyPorn relay.
    const token = createCompactChildToken(sessionEntry, resolved, resolvedKind);
    return `${publicBase}/media/${token}/${filenameFor(resolvedKind)}`;
  } catch (error) {
    if (error instanceof PlaylistChildRelayError) throw error;
    throw new PlaylistChildRelayError(
      'HLS playlist child URL could not be relayed safely',
      error
    );
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
  const sessionEntry = ensureSessionEntry(entry, finalUrl);
  let pendingKind = '';
  return String(content)
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (!trimmed.startsWith('#')) {
        const rewritten = relayChild(sessionEntry, finalUrl, trimmed, pendingKind);
        pendingKind = '';
        return rewritten;
      }

      if (trimmed.startsWith('#EXT-X-STREAM-INF')) pendingKind = 'hls';
      else if (trimmed.startsWith('#EXTINF')) pendingKind = 'segment';

      if (!/URI="[^"]+"/.test(line)) return line;
      const uriKind = kindFromPlaylistTag(trimmed);
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        return `URI="${relayChild(sessionEntry, finalUrl, uri, uriKind)}"`;
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

function isJavTransportSegment(entry) {
  if (entry?.provider !== 'javhdporn' || entry?.kind !== 'segment') return false;
  try {
    const hostname = new URL(entry.url).hostname.toLowerCase();
    return (
      hostname === 'tiktokcdn.com' ||
      hostname.endsWith('.tiktokcdn.com') ||
      hostname === 'vdcdn.xyz' ||
      hostname.endsWith('.vdcdn.xyz')
    );
  } catch {
    return false;
  }
}

function normalizeJavTransportSegment(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (looksLikeTransportStream(input)) {
    return { payload: input, wrapperBytes: 0 };
  }

  const payload = stripPngWrappedTsBuffer(input);
  if (!payload) return null;
  return { payload, wrapperBytes: input.length - payload.length };
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

  const entry = resolveRelayEntry(req.params.token);
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

      let rewritten;
      try {
        rewritten = rewritePlaylist(content, finalUrl, entry);
      } catch (error) {
        if (error?.code !== PLAYLIST_CHILD_ERROR_CODE) throw error;
        logger.warn(
          {
            provider: entry.provider,
            code: error.code,
            error: error.message,
          },
          'HLS playlist was rejected because a child URL could not be relayed safely'
        );
        res.setHeader('X-OnlyPorn-Relay-Error', PLAYLIST_CHILD_ERROR_CODE);
        res.status(502).type('text/plain').send('HLS playlist could not be relayed safely');
        return;
      }
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

    if (isJavTransportSegment(entry)) {
      const { response } = await upstreamRequest(entry, {
        method: 'GET',
        text: false,
        buffer: true,
      });

      if (response.status < 200 || response.status >= 300) {
        res.status(response.status).type('text/plain').send('Upstream segment request failed');
        return;
      }

      const upstreamPayload = Buffer.from(response.data || '');
      const normalized = normalizeJavTransportSegment(upstreamPayload);
      if (!normalized) {
        res.status(502).type('text/plain').send('JAVHDPorn segment payload was not recognized');
        return;
      }

      logger.debug(
        {
          provider: entry.provider,
          wrapperBytes: normalized.wrapperBytes,
          payloadBytes: normalized.payload.length,
        },
        normalized.wrapperBytes
          ? 'JAVHDPorn PNG-wrapped MPEG-TS segment decoded'
          : 'JAVHDPorn image-labelled MPEG-TS segment normalized'
      );

      res.status(200);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Content-Length', normalized.payload.length);
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      if (req.method === 'HEAD') res.end();
      else res.end(normalized.payload);
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
    MAX_COMPACT_CHILDREN_PER_SESSION,
    MAX_SESSIONS,
    PLAYLIST_CHILD_ERROR_CODE,
    SESSION_TTL_MS,
    createChildToken,
    createCompactChildToken,
    resolveCompactChildToken,
    hostnameAllowed,
    isJavTransportSegment,
    normalizeJavTransportSegment,
    kindFromPlaylistTag,
    kindFromUrl,
    normalizePublicBase,
    pngPayloadOffset,
    relayChild,
    resolveRelayEntry,
    rewritePlaylist,
    stripPngWrappedTsBuffer,
    validateTargetUrl,
  },
};
