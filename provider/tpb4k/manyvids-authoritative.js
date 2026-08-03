'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const MANYVIDS_ORIGIN = 'https://www.manyvids.com';
const MANYVIDS_VIDEO_API = `${MANYVIDS_ORIGIN}/bff/store/video`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/150.0 Safari/537.36';
const HEAD_PROBE_BYTES = 1024 * 1024;
const TAIL_PROBE_BYTES = 4 * 1024 * 1024;
const MIN_UNKNOWN_FULL_DURATION_SECONDS = 45;
const MIN_KNOWN_FULL_DURATION_SECONDS = 12;
const MIN_EXPECTED_DURATION_RATIO = 0.80;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function normalizeTitle(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function titleTokens(value) {
  return new Set(normalizeTitle(value).split(/\s+/).filter(Boolean));
}
function titleMatches(expected, actual) {
  const left = normalizeTitle(expected);
  const right = normalizeTitle(actual);
  if (!left || !right) return false;
  if (left === right) return true;
  if (Math.min(left.length, right.length) >= 12 && (left.includes(right) || right.includes(left))) {
    return true;
  }
  const leftTokens = titleTokens(left);
  const rightTokens = titleTokens(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.9;
}
function safeHttpsUrl(value) {
  const text = cleanText(value);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (parsed.port && parsed.port !== '443') return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}
function isManyvidsHostname(hostname) {
  const host = cleanText(hostname).toLowerCase().replace(/\.$/, '');
  return host === 'manyvids.com' || host.endsWith('.manyvids.com');
}
function normalizeManyvidsPageUrl(value) {
  const url = safeHttpsUrl(value);
  if (!url) return '';
  const parsed = new URL(url);
  if (!isManyvidsHostname(parsed.hostname)) return '';
  if (!/^\/video\/\d+(?:\/|$)/i.test(parsed.pathname)) return '';
  return parsed.toString();
}
function manyvidsVideoId(value) {
  const pageUrl = normalizeManyvidsPageUrl(value);
  if (!pageUrl) return '';
  return new URL(pageUrl).pathname.match(/^\/video\/(\d+)(?:\/|$)/i)?.[1] || '';
}
function explicitSceneLinks(scene = {}) {
  const collected = [];
  const visit = value => {
    if (typeof value === 'string') {
      const url = safeHttpsUrl(value);
      if (url) collected.push(url);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of ['url', 'link', 'href', 'value']) {
      if (value[key] != null) visit(value[key]);
    }
  };
  for (const key of ['url', 'urls', 'links', 'external_urls', 'externalUrls']) {
    if (scene?.[key] != null) visit(scene[key]);
  }
  return collected;
}
function authoritativeManyvidsUrls(item = {}) {
  const values = [
    ...explicitSceneLinks(item?._rawScene || {}),
    item?.detailUrl,
  ];
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const url = normalizeManyvidsPageUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push(url);
  }
  return output;
}
function allowedManyvidsMediaUrl(value) {
  const url = safeHttpsUrl(value);
  if (!url) return '';
  const parsed = new URL(url);
  if (!isManyvidsHostname(parsed.hostname)) return '';
  if (!/\.(?:mp4|m4v|mov)(?:$|[/?#])/i.test(parsed.pathname)) return '';
  return parsed.toString();
}
function isPreviewLikeMediaUrl(value) {
  const url = allowedManyvidsMediaUrl(value);
  if (!url) return true;
  const parsed = new URL(url);
  const evidence = `${parsed.pathname} ${parsed.search}`.toLowerCase();
  return /(?:^|[\/_-])(?:preview|teaser|trailer|sample)(?:[\/_\-.]|$)/i.test(evidence);
}
function requestHeaders(pageUrl) {
  return Object.freeze({
    'User-Agent': USER_AGENT,
    Referer: pageUrl,
    Origin: MANYVIDS_ORIGIN,
    Accept: 'video/mp4,application/octet-stream,*/*',
  });
}
async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const implementation = fetchImpl || globalThis.fetch;
  if (typeof implementation !== 'function') throw new Error('Fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000));
  try {
    return await implementation(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJson(fetchImpl, url, headers, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    headers: {
      ...headers,
      Accept: 'application/json',
    },
    redirect: 'follow',
  }, timeoutMs);
  if (!response?.ok) throw new Error(`ManyVids API HTTP ${response?.status || 0}`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error('ManyVids API returned invalid JSON');
  return payload;
}
async function readResponseLimited(response, maximumBytes) {
  const maximum = Math.max(Number(maximumBytes) || 0, 1);
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (size < maximum) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value || []);
        if (!chunk.length) continue;
        const remaining = maximum - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) break;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return Buffer.concat(chunks, size);
  }
  if (typeof response?.arrayBuffer === 'function') {
    return Buffer.from(await response.arrayBuffer()).subarray(0, maximum);
  }
  return Buffer.alloc(0);
}
function contentLengthFromHeaders(headers, status = 0) {
  const contentRange = cleanText(headers?.get?.('content-range'));
  const rangeMatch = contentRange.match(/\/(\d+)\s*$/);
  if (rangeMatch) return Number.parseInt(rangeMatch[1], 10) || 0;
  if (Number(status) === 200) {
    return Number.parseInt(cleanText(headers?.get?.('content-length')), 10) || 0;
  }
  return 0;
}
function parseDurationSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seconds = value > 86_400 ? value / 1000 : value;
    return seconds > 0 && seconds < 86_400 ? seconds : 0;
  }
  const text = cleanText(value);
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return parseDurationSeconds(Number(text));
  const parts = text.split(':').map(part => Number.parseFloat(part));
  if (!parts.length || parts.some(part => !Number.isFinite(part) || part < 0)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}
function expectedDurationSeconds(item = {}, metadata = {}) {
  for (const value of [
    item.duration,
    item?._rawScene?.duration,
    metadata.videoDuration,
    metadata.duration,
    metadata.durationSeconds,
    metadata.length,
  ]) {
    const seconds = parseDurationSeconds(value);
    if (seconds > 0) return seconds;
  }
  return 0;
}
function parseSizeBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(value, 0);
  const text = cleanText(value);
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)\b/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]);
  const powers = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
  return amount * (1024 ** powers[match[2].toUpperCase()]);
}
function parseMvhdDuration(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  let best = 0;
  // mvhd is authoritative for the movie. mdhd is a safe fallback for files
  // whose movie header carries zero duration but whose media tracks do not.
  for (const type of ['mvhd', 'mdhd']) {
    const marker = Buffer.from(type);
    let offset = 0;
    while (offset >= 0 && offset < input.length) {
      const index = input.indexOf(marker, offset);
      if (index < 0) break;
      const boxStart = index - 4;
      if (boxStart >= 0 && index + 32 <= input.length) {
        const boxSize = input.readUInt32BE(boxStart);
        const version = input[index + 4];
        try {
          if (version === 0 && index + 24 <= input.length) {
            const timescale = input.readUInt32BE(index + 16);
            const duration = input.readUInt32BE(index + 20);
            if (boxSize >= 28 && timescale > 0 && duration > 0) {
              best = Math.max(best, duration / timescale);
            }
          }
          if (version === 1 && index + 36 <= input.length) {
            const timescale = input.readUInt32BE(index + 24);
            const duration = Number(input.readBigUInt64BE(index + 28));
            if (boxSize >= 40 && timescale > 0 && duration > 0) {
              best = Math.max(best, duration / timescale);
            }
          }
        } catch {
          // Keep scanning for another valid duration box.
        }
      }
      offset = index + marker.length;
    }
    if (type === 'mvhd' && best > 0) return best;
  }
  return best;
}
function fullDurationGate(actualSeconds, expectedSeconds) {
  const actual = Number(actualSeconds) || 0;
  const expected = Number(expectedSeconds) || 0;
  if (expected > 0) {
    const required = Math.max(
      Math.min(expected * MIN_EXPECTED_DURATION_RATIO, expected),
      Math.min(MIN_KNOWN_FULL_DURATION_SECONDS, expected)
    );
    return actual >= required;
  }
  return actual >= MIN_UNKNOWN_FULL_DURATION_SECONDS;
}
async function fetchMediaRange(fetchImpl, url, pageUrl, range, maximumBytes, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    headers: {
      ...requestHeaders(pageUrl),
      Range: range,
    },
    redirect: 'follow',
  }, timeoutMs);
  if (![200, 206].includes(Number(response?.status || 0))) {
    return { response, buffer: Buffer.alloc(0), finalUrl: '', contentLength: 0 };
  }
  const finalUrl = allowedManyvidsMediaUrl(response?.url || url);
  if (!finalUrl || isPreviewLikeMediaUrl(finalUrl)) {
    try { await response.body?.cancel?.(); } catch {}
    return { response, buffer: Buffer.alloc(0), finalUrl: '', contentLength: 0 };
  }
  const buffer = await readResponseLimited(response, maximumBytes);
  return {
    response,
    buffer,
    finalUrl,
    contentLength: contentLengthFromHeaders(response.headers, response.status),
  };
}
async function probeManyvidsMedia(fetchImpl, mediaUrl, pageUrl, options = {}) {
  const url = allowedManyvidsMediaUrl(mediaUrl);
  const expectedDuration = Number(options.expectedDurationSeconds) || 0;
  const expectedSize = parseSizeBytes(options.expectedSize);
  if (!url || isPreviewLikeMediaUrl(url)) {
    return Object.freeze({ valid: false, reason: 'preview-like-url', durationSeconds: 0, contentLength: 0, url: '' });
  }
  let head;
  try {
    head = await fetchMediaRange(
      fetchImpl,
      url,
      pageUrl,
      `bytes=0-${HEAD_PROBE_BYTES - 1}`,
      HEAD_PROBE_BYTES,
      options.timeoutMs || DEFAULT_TIMEOUT_MS
    );
  } catch {
    return Object.freeze({ valid: false, reason: 'head-request-failed', durationSeconds: 0, contentLength: 0, url: '' });
  }
  if (!head.finalUrl) {
    return Object.freeze({ valid: false, reason: `media-http-${Number(head?.response?.status || 0)}`, durationSeconds: 0, contentLength: 0, url: '' });
  }
  const contentType = cleanText(head.response?.headers?.get?.('content-type')).toLowerCase();
  const hasFtyp = head.buffer.subarray(0, 512).includes(Buffer.from('ftyp'));
  if (!hasFtyp && !contentType.startsWith('video/mp4') && contentType !== 'application/octet-stream') {
    return Object.freeze({ valid: false, reason: 'not-mp4', durationSeconds: 0, contentLength: head.contentLength, url: '' });
  }
  let durationSeconds = parseMvhdDuration(head.buffer);
  let contentLength = head.contentLength;
  if (!durationSeconds) {
    try {
      const tailRange = contentLength > 0
        ? `bytes=${Math.max(contentLength - TAIL_PROBE_BYTES, 0)}-${contentLength - 1}`
        : `bytes=-${TAIL_PROBE_BYTES}`;
      const tail = await fetchMediaRange(
        fetchImpl,
        head.finalUrl,
        pageUrl,
        tailRange,
        TAIL_PROBE_BYTES,
        options.timeoutMs || DEFAULT_TIMEOUT_MS
      );
      durationSeconds = parseMvhdDuration(tail.buffer);
      contentLength = contentLength || tail.contentLength;
    } catch {
      // A missing tail probe fails closed below.
    }
  }
  if (!durationSeconds) {
    return Object.freeze({ valid: false, reason: 'mp4-duration-unavailable', durationSeconds: 0, contentLength, url: '' });
  }
  if (!fullDurationGate(durationSeconds, expectedDuration)) {
    return Object.freeze({ valid: false, reason: 'short-or-incomplete-media', durationSeconds, contentLength, url: '' });
  }
  if (expectedSize >= 4 * 1024 * 1024 && contentLength > 0 && contentLength < expectedSize * 0.20) {
    return Object.freeze({ valid: false, reason: 'media-size-too-small', durationSeconds, contentLength, url: '' });
  }
  return Object.freeze({
    valid: true,
    reason: 'duration-verified-full-media',
    durationSeconds,
    expectedDurationSeconds: expectedDuration,
    contentLength,
    url: head.finalUrl,
  });
}
function resolutionFromUrl(value) {
  const text = cleanText(value);
  const match = text.match(/(?:^|[_./-])(2160|1440|1080|720|576|480|360)p?(?:[_./?-]|$)/i);
  return match ? `${match[1]}p` : '';
}
function durationLabel(seconds) {
  const total = Math.max(Math.round(Number(seconds) || 0), 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}
function candidateFromMedia({ item, pageUrl, videoId, mediaUrl, label, probe }) {
  const title = `${cleanText(item?.title) || 'ManyVids scene'} — ManyVids [FULL ${durationLabel(probe.durationSeconds)}]`;
  return Object.freeze({
    source: 'manyvids',
    sourceId: `manyvids:${videoId}:${label}`,
    title,
    filename: title,
    studio: cleanText(item?.studio),
    performers: Array.isArray(item?.performers) ? item.performers : [],
    releaseDate: cleanText(item?.releaseDate),
    quality: 'Full',
    resolution: resolutionFromUrl(mediaUrl),
    url: probe.url || mediaUrl,
    detailUrl: pageUrl,
    mediaKind: 'mp4',
    requestHeaders: requestHeaders(pageUrl),
    relayProvider: 'manyvids',
    validated: true,
    durationSeconds: probe.durationSeconds,
    expectedDurationSeconds: probe.expectedDurationSeconds,
    contentLength: probe.contentLength,
    provenance: [
      'tpdb-authoritative-url',
      'manyvids-bff',
      'manyvids-full-media',
      'manyvids-duration-verified',
    ],
  });
}
async function resolvePage({ item, pageUrl, fetchImpl, timeoutMs }) {
  const videoId = manyvidsVideoId(pageUrl);
  if (!videoId) return [];
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: pageUrl,
    Origin: MANYVIDS_ORIGIN,
  };
  const [privatePayload, metadataPayload] = await Promise.all([
    fetchJson(fetchImpl, `${MANYVIDS_VIDEO_API}/${videoId}/private`, headers, timeoutMs),
    fetchJson(fetchImpl, `${MANYVIDS_VIDEO_API}/${videoId}`, headers, timeoutMs),
  ]);
  const privateData = privatePayload?.data && typeof privatePayload.data === 'object'
    ? privatePayload.data
    : {};
  const metadata = metadataPayload?.data && typeof metadataPayload.data === 'object'
    ? metadataPayload.data
    : {};
  if (!titleMatches(item?.title, metadata.title)) return [];
  const expectedDuration = expectedDurationSeconds(item, metadata);
  const teaserUrl = allowedManyvidsMediaUrl(privateData?.teaser?.filepath || metadata?.teaser?.filepath);
  const fullSpecs = [
    ['full-transcoded', privateData.transcodedFilepath],
    ['full-original', privateData.filepath],
  ];
  const fullCandidates = [];
  const seen = new Set();
  const seenFinal = new Set();
  for (const [label, rawUrl] of fullSpecs) {
    const mediaUrl = allowedManyvidsMediaUrl(rawUrl);
    if (!mediaUrl || seen.has(mediaUrl) || mediaUrl === teaserUrl || isPreviewLikeMediaUrl(mediaUrl)) continue;
    seen.add(mediaUrl);
    const probe = await probeManyvidsMedia(fetchImpl, mediaUrl, pageUrl, {
      expectedDurationSeconds: expectedDuration,
      expectedSize: metadata.size,
      timeoutMs,
    });
    if (!probe.valid || seenFinal.has(probe.url)) continue;
    seenFinal.add(probe.url);
    fullCandidates.push(candidateFromMedia({
      item,
      pageUrl,
      videoId,
      mediaUrl,
      label,
      probe,
    }));
  }
  return fullCandidates;
}
async function resolveAuthoritativeManyVids(options = {}) {
  const item = options.item || {};
  const pageUrls = authoritativeManyvidsUrls(item);
  for (const pageUrl of pageUrls) {
    try {
      const candidates = await resolvePage({
        item,
        pageUrl,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      });
      if (candidates.length) return candidates;
    } catch {
      // A failed exact provider request falls through to the existing torrent resolver.
    }
  }
  return [];
}
module.exports = {
  MANYVIDS_ORIGIN,
  MANYVIDS_VIDEO_API,
  USER_AGENT,
  allowedManyvidsMediaUrl,
  authoritativeManyvidsUrls,
  expectedDurationSeconds,
  fullDurationGate,
  isManyvidsHostname,
  isPreviewLikeMediaUrl,
  manyvidsVideoId,
  normalizeManyvidsPageUrl,
  parseDurationSeconds,
  parseMvhdDuration,
  probeManyvidsMedia,
  resolveAuthoritativeManyVids,
  titleMatches,
};
