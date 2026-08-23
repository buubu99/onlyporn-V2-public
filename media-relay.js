const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const axios = require('axios');
const BoundedTtlCache = require('./provider/cache');
const logger = require('./logger');

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 8000;
const CHILD_TOKEN_VERSION = 'c1';
const CHILD_TOKEN_SIGNATURE_BYTES = 18;
const PLAYLIST_CHILD_ERROR_CODE = 'HLS_CHILD_REJECTED';
const CHILD_TOKEN_SECRET = crypto.randomBytes(32);
const MAX_REDIRECTS = 5;
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;
const HLS_SNAPSHOT_MAX_PLAYLISTS = 12;
const HLS_SNAPSHOT_TIMEOUT_MS = 8_000;
const HLS_SNAPSHOT_REQUEST_TIMEOUT_MS = 5_000;
const JAV_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const JAV_SEGMENT_ATTEMPT_TIMEOUT_MS = 12_000;
const JAV_SEGMENT_MAX_ATTEMPTS = 2;
const entries = new BoundedTtlCache({ maxEntries: MAX_SESSIONS, ttlMs: SESSION_TTL_MS });

const PROVIDER_EXACT_HOSTS = {
  // Observed as a direct child of pianopic.com JAVHD playlists. Keep this
  // exact instead of trusting every host below the shared cdnsync.cloud zone.
  javhdporn: new Set(['redirector.cdnsync.cloud']),
};

const PROVIDER_SUFFIXES = {
  eporner: ['eporner.com'],
  xvideos: ['xvideos.com', 'xvideos-cdn.com'],
  xnxx: ['xnxx.com', 'xnxx-cdn.com'],
  pornhub: ['phncdn.com'],
  yesporn: ['yesporn.vip'],
  manyvids: ['manyvids.com'],
  javhdporn: [
    'javhdporn.net',
    'pornfhd.com',
    'storagexhd.com',
    'streamhls.click',
    'edge-hls.saawsedge.com',
    'pianopic.com',
    'qooglecdn.com',
    's2.maxstream.org',
    's4.maxstream.org',
    's8.maxstream.org',
    'tiktokcdn.com',
    'vdcdn.xyz',
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
    process.env.ONLYPORN_PUBLIC_BASE_URL ||
      process.env.ADDON_BASE_URL ||
      process.env.PUBLIC_URL ||
      ''
  );
}

function setPublicBase(value) {
  const normalized = normalizePublicBase(value);
  if (normalized) observedPublicBase = normalized;
}

function getPublicBase() {
  return configuredPublicBase() || observedPublicBase;
}

function mediaGeneration(env = process.env) {
  const configured = String(env.ONLYPORN_MEDIA_GENERATION || '').trim().toLowerCase();
  if (!configured) return '';
  const generation = configured.startsWith('g-') ? configured.slice(2) : configured;
  if (!/^[a-f0-9]{7,40}$/.test(generation)) {
    throw new Error(
      'ONLYPORN_MEDIA_GENERATION must be a 7-40 character hexadecimal commit identifier'
    );
  }
  return `g-${generation}`;
}

function mediaPathPrefix(env = process.env) {
  const generation = mediaGeneration(env);
  if (generation) return `/media/${generation}`;

  const slot = String(env.ONLYPORN_MEDIA_SLOT || '').trim().toLowerCase();
  if (!slot) return '/media';
  if (!/^(?:blue|green)$/.test(slot)) {
    throw new Error('ONLYPORN_MEDIA_SLOT must be blue or green');
  }
  return `/media/${slot}`;
}

function hostnameAllowed(hostname, provider) {
  const suffixes = PROVIDER_SUFFIXES[provider] || [];
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return (
    PROVIDER_EXACT_HOSTS[provider]?.has(normalized) ||
    suffixes.some(suffix => normalized === suffix || normalized.endsWith(`.${suffix}`))
  );
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

function filenameFor(kind, provider = '', sourceUrl = '') {
  if (kind === 'hls') return 'index.m3u8';
  if (kind === 'mp4') return 'video.mp4';
  if (kind === 'key') return 'key.bin';
  if (kind === 'segment' && provider === 'javhdporn') return 'segment.ts';
  if (kind === 'segment') {
    try {
      const extension = new URL(sourceUrl).pathname.match(/\.(ts|m4s|mp4|aac|m4a|vtt|webvtt)$/i)?.[1];
      if (extension) return `segment.${extension.toLowerCase()}`;
    } catch {
      // HLS transport streams are the safest fallback for extension-sensitive clients.
    }
    return 'segment.ts';
  }
  return 'segment.bin';
}

function relayContentType(entry = {}, upstreamValue = '') {
  const upstream = String(upstreamValue || '').trim();
  let pathname = '';
  try {
    pathname = new URL(String(entry.url || '')).pathname.toLowerCase();
  } catch {
    // Content-type repair is best effort; preserve the upstream value below.
  }

  // Some XVideos CDN edges serve valid MPEG-TS HLS chunks as generic binary.
  // Browser-based Stremio players can fetch and demux those bytes but reject
  // the resource contract before playback when the MIME type is not video.
  // The signed child URL retains the exact upstream URL, so a .ts suffix is a
  // safe, deterministic signal and does not require sniffing untrusted bytes.
  if (entry.kind === 'segment' && pathname.endsWith('.ts')) {
    return 'video/mp2t';
  }

  if (
    entry.kind === 'mp4' &&
    (!upstream || /^(?:application\/(?:force-download|octet-stream)|binary\/octet-stream)(?:;|$)/i.test(upstream))
  ) {
    return 'video/mp4';
  }
  return upstream;
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
  const trace = logger.currentTraceContext();
  const entry = {
    url: safeUrl,
    headers: sanitizeHeaders(headers),
    provider,
    kind: resolvedKind,
    sessionToken: token,
    originRid: String(trace.rid || ''),
    originTargetHash: String(trace.targetHash || ''),
    originPlatform: String(trace.platform || 'unknown'),
    originUaFamily: String(trace.uaFamily || 'unknown'),
  };

  entries.set(token, entry, ttlMs);
  logger.info(
    {
      event: 'RELAY_SESSION',
      provider,
      kind: resolvedKind,
      session: relaySessionFingerprint(token),
      originRid: entry.originRid,
      originTargetHash: entry.originTargetHash,
      originPlatform: entry.originPlatform,
      upstreamHostname: relayUpstreamHostname(entry),
      ttlMs,
    },
    'RELAY_SESSION'
  );
  return entry;
}

function register({ url, headers = {}, provider, kind, ttlMs = SESSION_TTL_MS }) {
  const publicBase = getPublicBase();
  if (!publicBase) throw new Error('Media relay public base URL is not initialized');

  const entry = createSessionEntry({ url, headers, provider, kind, ttlMs });
  return `${publicBase}${mediaPathPrefix()}/${entry.sessionToken}/${filenameFor(entry.kind, entry.provider, entry.url)}`;
}

async function registerHlsSnapshot({
  url,
  headers = {},
  provider,
  ttlMs = SESSION_TTL_MS,
}) {
  const publicBase = getPublicBase();
  if (!publicBase) throw new Error('Media relay public base URL is not initialized');

  const entry = createSessionEntry({ url, headers, provider, kind: 'hls', ttlMs });
  try {
    const snapshots = new Map();
    const visited = new Set();
    const queue = [entry.url];
    const deadlineAt = Date.now() + HLS_SNAPSHOT_TIMEOUT_MS;

    while (queue.length) {
      const playlistUrl = validateTargetUrl(queue.shift(), entry.provider);
      if (visited.has(playlistUrl)) continue;
      if (visited.size >= HLS_SNAPSHOT_MAX_PLAYLISTS) {
        throw new Error('HLS playlist snapshot exceeded its bounded child count');
      }
      visited.add(playlistUrl);

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error('HLS playlist snapshot exceeded its time budget');

      const playlistEntry = { ...entry, url: playlistUrl, kind: 'hls' };
      const { response, finalUrl } = await upstreamRequest(playlistEntry, {
        method: 'GET',
        text: true,
        timeoutMs: Math.min(HLS_SNAPSHOT_REQUEST_TIMEOUT_MS, remainingMs),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Upstream playlist snapshot failed with HTTP ${response.status}`);
      }

      const content = String(response.data || '');
      if (!content.includes('#EXTM3U')) {
        throw new Error('Upstream playlist snapshot was not HLS');
      }

      const rewritten = rewritePlaylist(content, finalUrl, entry);
      snapshots.set(playlistUrl, rewritten);
      snapshots.set(finalUrl, rewritten);
      queue.push(...hlsChildPlaylistUrls(content, finalUrl));
    }

    entry.playlistSnapshots = snapshots;
    logger.info(
      {
        event: 'RELAY_SNAPSHOT_READY',
        provider: entry.provider,
        ...relayDiagnosticFields(entry),
        upstreamHostname: relayUpstreamHostname(entry),
        playlists: visited.size,
        bytes: [...snapshots.values()].reduce(
          (total, playlist) => total + Buffer.byteLength(playlist),
          0
        ),
      },
      'Validated HLS playlist tree preserved'
    );
    return `${publicBase}${mediaPathPrefix()}/${entry.sessionToken}/${filenameFor(entry.kind, entry.provider, entry.url)}`;
  } catch (error) {
    logger.warn(
      {
        event: 'RELAY_SNAPSHOT_FAILED',
        provider: entry.provider,
        ...relayDiagnosticFields(entry),
        upstreamHostname: relayUpstreamHostname(entry),
        error: error.message,
        errorCode: error.code || '',
        childHostname: error.childHostname || '',
        cause: error.cause?.message || '',
      },
      'RELAY_SNAPSHOT_FAILED'
    );
    entries.delete(entry.sessionToken);
    throw error;
  }
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
  return entries.get(token) || resolveChildToken(token);
}

class PlaylistChildRelayError extends Error {
  constructor(message, cause, details = {}) {
    super(message);
    this.name = 'PlaylistChildRelayError';
    this.code = PLAYLIST_CHILD_ERROR_CODE;
    if (cause) this.cause = cause;
    if (details.childHostname) this.childHostname = details.childHostname;
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
    const token = createChildToken(sessionEntry, resolved, resolvedKind);
    return `${publicBase}${mediaPathPrefix()}/${token}/${filenameFor(resolvedKind, sessionEntry.provider, resolved)}`;
  } catch (error) {
    if (error instanceof PlaylistChildRelayError) throw error;
    let childHostname = '';
    try { childHostname = new URL(resolved).hostname.toLowerCase(); } catch { /* Invalid child. */ }
    throw new PlaylistChildRelayError(
      'HLS playlist child URL could not be relayed safely',
      error,
      { childHostname }
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

function hlsChildPlaylistUrls(content, finalUrl) {
  const children = new Set();
  let pendingKind = '';

  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!trimmed.startsWith('#')) {
      const resolved = resolveChildUrl(finalUrl, trimmed);
      const kind = pendingKind || kindFromUrl(resolved);
      pendingKind = '';
      if (resolved && kind === 'hls') children.add(resolved);
      continue;
    }

    if (trimmed.startsWith('#EXT-X-STREAM-INF')) pendingKind = 'hls';
    const uriKind = kindFromPlaylistTag(trimmed);
    if (uriKind !== 'hls') continue;
    for (const match of line.matchAll(/URI="([^"]+)"/g)) {
      const resolved = resolveChildUrl(finalUrl, match[1]);
      if (resolved) children.add(resolved);
    }
  }

  return [...children];
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

async function yespornFetchRequest(
  entry,
  {
    method = 'GET',
    range,
  } = {}
) {
  let currentUrl = entry.url;

  for (
    let redirects = 0;
    redirects <= MAX_REDIRECTS;
    redirects += 1
  ) {
    currentUrl = validateTargetUrl(
      currentUrl,
      entry.provider
    );

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      30_000
    );

    let response;

    try {
      const headers = {
        ...entry.headers,
        Accept:
          entry.headers.Accept ||
          'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.2',
      };

      if (range) headers.Range = range;

      response = await fetch(currentUrl, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (
      [301, 302, 303, 307, 308].includes(
        response.status
      )
    ) {
      if (redirects >= MAX_REDIRECTS) {
        try {
          await response.body?.cancel?.();
        } catch {
          // Best effort.
        }

        throw new Error(
          'Media relay exceeded redirect limit'
        );
      }

      const location =
        response.headers.get('location');

      try {
        await response.body?.cancel?.();
      } catch {
        // Best effort.
      }

      if (!location) {
        throw new Error(
          'Media redirect did not include a Location header'
        );
      }

      currentUrl = new URL(
        location,
        currentUrl
      ).toString();

      continue;
    }

    return {
      response,
      finalUrl: currentUrl,
    };
  }

  throw new Error(
    'YesPorn media relay request failed'
  );
}

async function pipeYespornResponse(
  entry,
  req,
  res
) {
  const {
    response,
  } = await yespornFetchRequest(entry, {
    method:
      req.method === 'HEAD'
        ? 'HEAD'
        : 'GET',
    range: req.headers.range,
  });

  res.status(response.status);

  for (
    const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
    ]
  ) {
    const upstreamValue = response.headers.get(name);
    const value = name === 'content-type'
      ? relayContentType(entry, upstreamValue)
      : upstreamValue;
    if (value != null) {
      res.setHeader(name, value);
    }
  }

  res.setHeader(
    'Cache-Control',
    'no-store, max-age=0'
  );

  if (req.method === 'HEAD') {
    try {
      await response.body?.cancel?.();
    } catch {
      // Best effort.
    }

    res.end();
    return;
  }

  if (!response.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(
    response.body
  );

  stream.on('error', error => {
    logger.warn(
      {
        provider: entry.provider,
        error: error.message,
      },
      'YesPorn media relay upstream stream failed'
    );

    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.destroy(error);
    }
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      stream.destroy();
    }
  });

  stream.pipe(res);
}

async function upstreamRequest(
  entry,
  { method = 'GET', range, text = false, buffer = false, timeoutMs = 30_000 } = {}
) {
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
      timeout: timeoutMs,
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

function javSegmentRetryableStatus(status) {
  return [403, 408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function disposeUpstreamResponse(response) {
  try { response?.data?.destroy?.(); } catch {}
}

async function requestJavSegment(
  entry,
  { method = 'GET', range, buffer = false } = {}
) {
  let lastResult;
  let lastError;

  for (let attempt = 1; attempt <= JAV_SEGMENT_MAX_ATTEMPTS; attempt += 1) {
    const attemptRange = attempt === 1 ? range : undefined;
    try {
      const result = await upstreamRequest(entry, {
        method,
        range: attemptRange,
        text: false,
        buffer,
        timeoutMs: JAV_SEGMENT_ATTEMPT_TIMEOUT_MS,
      });
      lastResult = result;
      if (!javSegmentRetryableStatus(result.response.status) || attempt === JAV_SEGMENT_MAX_ATTEMPTS) {
        if (attempt > 1) {
          const recovered = !javSegmentRetryableStatus(result.response.status);
          logger[recovered ? 'info' : 'warn'](
            {
              event: recovered
                ? 'JAVHD_SEGMENT_RECOVERY_RESULT'
                : 'JAVHD_SEGMENT_RECOVERY_EXHAUSTED',
              provider: entry.provider,
              ...relayDiagnosticFields(entry),
              attempt,
              upstreamStatus: result.response.status,
              recovered,
              rangeRemoved: Boolean(range),
              upstreamHostname: relayUpstreamHostname(entry),
            },
            recovered
              ? 'JAVHD segment recovery completed'
              : 'JAVHD segment recovery attempts exhausted'
          );
        }
        return result;
      }

      disposeUpstreamResponse(result.response);
      logger.warn(
        {
          event: 'JAVHD_SEGMENT_RECOVERY_ATTEMPT',
          provider: entry.provider,
          ...relayDiagnosticFields(entry),
          attempt: attempt + 1,
          upstreamStatus: result.response.status,
          rangeRemoved: Boolean(range),
          upstreamHostname: relayUpstreamHostname(entry),
        },
        'Retrying JAVHD segment without a byte range'
      );
    } catch (error) {
      lastError = error;
      if (attempt === JAV_SEGMENT_MAX_ATTEMPTS) throw error;
      logger.warn(
        {
          event: 'JAVHD_SEGMENT_RECOVERY_ATTEMPT',
          provider: entry.provider,
          ...relayDiagnosticFields(entry),
          attempt: attempt + 1,
          error: error.message,
          errorCode: error.code || '',
          rangeRemoved: Boolean(range),
          upstreamHostname: relayUpstreamHostname(entry),
        },
        'Retrying JAVHD segment after an upstream error'
      );
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error('JAVHD segment request failed');
}


function mediaUsageLoggingEnabled(env = process.env) {
  return !/^(?:0|false|off|no)$/i.test(
    String(env.ONLYPORN_MEDIA_USAGE_LOGGING ?? 'true').trim()
  );
}

function responseChunkBytes(value, encoding) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return Buffer.byteLength(String(value), encoding || 'utf8');
  } catch {
    return Buffer.byteLength(String(value));
  }
}

function relaySessionFingerprint(token) {
  return crypto
    .createHmac('sha256', CHILD_TOKEN_SECRET)
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 16);
}

function relayUpstreamHostname(entry) {
  try {
    return new URL(String(entry?.url || '')).hostname;
  } catch {
    return '';
  }
}

function relayDiagnosticFields(entry) {
  return {
    session: relaySessionFingerprint(entry?.sessionToken),
    originRid: String(entry?.originRid || ''),
    originTargetHash: String(entry?.originTargetHash || ''),
    originPlatform: String(entry?.originPlatform || 'unknown'),
    originUaFamily: String(entry?.originUaFamily || 'unknown'),
  };
}

function attachRelayUsageLogging(req, res, entry) {
  if (!mediaUsageLoggingEnabled()) return;

  let bytesSent = 0;
  let logged = false;
  const startedAt = Date.now();
  const originalWrite = res.write;
  const originalEnd = res.end;

  res.write = function countedWrite(chunk) {
    const encoding =
      typeof arguments[1] === 'string'
        ? arguments[1]
        : undefined;
    bytesSent += responseChunkBytes(chunk, encoding);
    return originalWrite.apply(this, arguments);
  };

  res.end = function countedEnd(chunk) {
    const encoding =
      typeof arguments[1] === 'string'
        ? arguments[1]
        : undefined;
    bytesSent += responseChunkBytes(chunk, encoding);
    return originalEnd.apply(this, arguments);
  };

  const logOnce = completed => {
    if (logged) return;
    logged = true;

    logger.info(
      {
        event: 'media_relay_usage',
        method: req.method,
        provider: entry.provider,
        kind: entry.kind,
        status: res.statusCode,
        requestRange: req.headers.range || '',
        responseContentRange: res.getHeader('content-range') || '',
        responseContentLength: res.getHeader('content-length') || '',
        responseContentType: res.getHeader('content-type') || '',
        bytesSent,
        durationMs: Date.now() - startedAt,
        completed: Boolean(completed),
        ...relayDiagnosticFields(entry),
        playbackPlatform: logger.currentTraceContext().platform || 'unknown',
        playbackUaFamily: logger.currentTraceContext().uaFamily || 'unknown',
        upstreamHostname: relayUpstreamHostname(entry),
      },
      'Media relay usage'
    );
  };

  if (typeof res.once === 'function') {
    res.once('finish', () => logOnce(true));
    res.once('close', () => logOnce(res.writableEnded));
  }
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

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.status(405).type('text/plain').send('Method Not Allowed');
    return;
  }

  const entry = resolveRelayEntry(req.params.token);
  if (!entry) {
    logger.warn(
      {
        event: 'RELAY_SESSION_EXPIRED',
        session: relaySessionFingerprint(req.params.token),
      },
      'RELAY_SESSION_EXPIRED'
    );
    res.status(410).type('text/plain').send('Media relay link expired');
    return;
  }

  attachRelayUsageLogging(req, res, entry);

  try {
    if (
      entry.provider === 'yesporn' &&
      entry.kind === 'mp4'
    ) {
      await pipeYespornResponse(
        entry,
        req,
        res
      );
      return;
    }

    if (entry.kind === 'hls') {
      const playlistSnapshot = entry.playlistSnapshots?.get(entry.url);
      if (playlistSnapshot) {
        res.status(200);
        // Stremio's HTMLVideo player compares this value as an exact string
        // before selecting hls.js. A charset parameter makes it fall through to
        // Chrome's native video element, which rejects HLS after the first TS
        // segment with MEDIA_ERR_SRC_NOT_SUPPORTED.
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Accept-Ranges', 'none');
        res.setHeader('Content-Length', Buffer.byteLength(playlistSnapshot));
        if (req.method === 'HEAD') res.end();
        else res.end(playlistSnapshot);
        return;
      }

      const { response, finalUrl } = await upstreamRequest(entry, {
        method: 'GET',
        text: true,
      });

      if (response.status < 200 || response.status >= 300) {
        logger.warn(
          {
            event: 'RELAY_UPSTREAM_STATUS',
            provider: entry.provider,
            ...relayDiagnosticFields(entry),
            stage: 'playlist',
            upstreamStatus: response.status,
            upstreamHostname: relayUpstreamHostname(entry),
          },
          'RELAY_UPSTREAM_STATUS'
        );
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
            event: 'RELAY_CHILD_REJECTED',
            provider: entry.provider,
            ...relayDiagnosticFields(entry),
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
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Content-Length', Buffer.byteLength(rewritten));
      if (req.method === 'HEAD') res.end();
      else res.end(rewritten);
      return;
    }

    if (isJavTransportSegment(entry)) {
      const { response } = await requestJavSegment(entry, {
        method: 'GET',
        buffer: true,
      });

      if (response.status < 200 || response.status >= 300) {
        logger.warn(
          {
            event: 'RELAY_UPSTREAM_STATUS',
            provider: entry.provider,
            ...relayDiagnosticFields(entry),
            stage: 'jav-segment',
            upstreamStatus: response.status,
            upstreamHostname: relayUpstreamHostname(entry),
          },
          'RELAY_UPSTREAM_STATUS'
        );
        res.status(response.status).type('text/plain').send('Upstream segment request failed');
        return;
      }

      const upstreamPayload = Buffer.from(response.data || '');
      const normalized = normalizeJavTransportSegment(upstreamPayload);
      if (!normalized) {
        logger.warn(
          {
            event: 'JAVHD_SEGMENT_REJECTED',
            provider: entry.provider,
            ...relayDiagnosticFields(entry),
            upstreamBytes: upstreamPayload.length,
            upstreamHostname: relayUpstreamHostname(entry),
          },
          'JAVHD_SEGMENT_REJECTED'
        );
        res.status(502).type('text/plain').send('JAVHDPorn segment payload was not recognized');
        return;
      }

      logger.debug(
        {
          event: 'JAVHD_SEGMENT_DECODED',
          provider: entry.provider,
          ...relayDiagnosticFields(entry),
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

    const requestOptions = {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      range: req.headers.range,
    };
    const { response, finalUrl } = entry.provider === 'javhdporn' && entry.kind === 'segment'
      ? await requestJavSegment(entry, requestOptions)
      : await upstreamRequest(entry, { ...requestOptions, text: false });

    if (entry.provider === 'eporner' && /\/na\.mp4(?:$|[?#])/i.test(finalUrl)) {
      response.data?.destroy?.();
      logger.warn({ provider: entry.provider }, 'Eporner rejected a relayed media URL');
      res.status(502).type('text/plain').send('Eporner media URL was rejected upstream');
      return;
    }

    res.status(response.status);
    if (response.status < 200 || response.status >= 400) {
      logger.warn(
        {
          event: 'RELAY_UPSTREAM_STATUS',
          provider: entry.provider,
          ...relayDiagnosticFields(entry),
          stage: entry.kind,
          upstreamStatus: response.status,
          upstreamHostname: relayUpstreamHostname(entry),
        },
        'RELAY_UPSTREAM_STATUS'
      );
    }
    const forwardedHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
    ];
    for (const name of forwardedHeaders) {
      const value = name === 'content-type'
        ? relayContentType(entry, response.headers[name])
        : response.headers[name];
      if (value != null) res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    if (req.method === 'HEAD') {
      response.data?.destroy?.();
      res.end();
      return;
    }

    response.data.on('error', error => {
      logger.warn(
        {
          event: 'RELAY_UPSTREAM_STREAM_ERROR',
          provider: entry.provider,
          ...relayDiagnosticFields(entry),
          upstreamHostname: relayUpstreamHostname(entry),
          error: error.message,
        },
        'Media relay upstream stream failed'
      );
      if (!res.headersSent) res.status(502).end();
      else res.destroy(error);
    });
    res.on('close', () => {
      if (!res.writableEnded) response.data.destroy();
    });
    response.data.pipe(res);
  } catch (error) {
    logger.warn(
      {
        event: 'RELAY_REQUEST_ERROR',
        provider: entry.provider,
        ...relayDiagnosticFields(entry),
        upstreamHostname: relayUpstreamHostname(entry),
        error: error.message,
      },
      'Media relay request failed'
    );
    if (!res.headersSent) res.status(502).type('text/plain').send('Media relay request failed');
    else res.destroy(error);
  }
}

module.exports = {
  getPublicBase,
  handleRequest,
  mediaGeneration,
  register,
  registerHlsSnapshot,
  setPublicBase,
  _test: {
    entries,
    MAX_SESSIONS,
    mediaGeneration,
    mediaPathPrefix,
    PLAYLIST_CHILD_ERROR_CODE,
    SESSION_TTL_MS,
    createChildToken,
    hostnameAllowed,
    isJavTransportSegment,
    javSegmentRetryableStatus,
    normalizeJavTransportSegment,
    kindFromPlaylistTag,
    hlsChildPlaylistUrls,
    kindFromUrl,
    normalizePublicBase,
    pngPayloadOffset,
    relayContentType,
    relayChild,
    resolveRelayEntry,
    requestJavSegment,
    rewritePlaylist,
    stripPngWrappedTsBuffer,
    validateTargetUrl,
  },
};
