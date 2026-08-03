'use strict';

const DEFAULT_TIMEOUT_MS = 15_000;
const MANYVIDS_ORIGIN = 'https://www.manyvids.com';
const MANYVIDS_VIDEO_API = `${MANYVIDS_ORIGIN}/bff/store/video`;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/150.0 Safari/537.36';

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

async function firstResponseChunk(response) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    try {
      const { value } = await reader.read();
      return Buffer.from(value || []);
    } finally {
      try { await reader.cancel(); } catch {}
    }
  }
  if (typeof response?.arrayBuffer === 'function') {
    return Buffer.from(await response.arrayBuffer());
  }
  return Buffer.alloc(0);
}

async function probeManyvidsMedia(fetchImpl, mediaUrl, pageUrl, timeoutMs) {
  const url = allowedManyvidsMediaUrl(mediaUrl);
  if (!url) return false;
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: {
        ...requestHeaders(pageUrl),
        Range: 'bytes=0-65535',
      },
      redirect: 'follow',
    }, timeoutMs);
  } catch {
    return false;
  }

  if (![200, 206].includes(Number(response?.status || 0))) return false;
  const finalUrl = allowedManyvidsMediaUrl(response?.url || url);
  if (!finalUrl) return false;
  const contentType = cleanText(response?.headers?.get?.('content-type')).toLowerCase();
  const chunk = await firstResponseChunk(response);
  const hasFtyp = chunk.subarray(0, 512).includes(Buffer.from('ftyp'));
  return hasFtyp || contentType.startsWith('video/mp4') || contentType === 'application/octet-stream';
}

function resolutionFromUrl(value) {
  const text = cleanText(value);
  const match = text.match(/(?:^|[_./-])(2160|1440|1080|720|576|480|360)p?(?:[_./?-]|$)/i);
  return match ? `${match[1]}p` : '';
}

function candidateFromMedia({ item, pageUrl, videoId, mediaUrl, label, preview }) {
  const access = preview ? 'PREVIEW' : 'FULL';
  const title = `${cleanText(item?.title) || 'ManyVids scene'} — ManyVids [${access}]`;
  return Object.freeze({
    source: 'manyvids',
    sourceId: `manyvids:${videoId}:${label}`,
    title,
    filename: title,
    studio: cleanText(item?.studio),
    performers: Array.isArray(item?.performers) ? item.performers : [],
    releaseDate: cleanText(item?.releaseDate),
    quality: preview ? 'Preview' : 'Full',
    resolution: resolutionFromUrl(mediaUrl),
    url: mediaUrl,
    detailUrl: pageUrl,
    mediaKind: 'mp4',
    requestHeaders: requestHeaders(pageUrl),
    relayProvider: 'manyvids',
    validated: true,
    provenance: [
      'tpdb-authoritative-url',
      'manyvids-bff',
      preview ? 'manyvids-official-preview' : 'manyvids-full-media',
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

  const fullSpecs = [
    ['full-transcoded', privateData.transcodedFilepath],
    ['full-original', privateData.filepath],
  ];
  const fullCandidates = [];
  for (const [label, rawUrl] of fullSpecs) {
    const mediaUrl = allowedManyvidsMediaUrl(rawUrl);
    if (!mediaUrl) continue;
    if (!await probeManyvidsMedia(fetchImpl, mediaUrl, pageUrl, timeoutMs)) continue;
    fullCandidates.push(candidateFromMedia({
      item,
      pageUrl,
      videoId,
      mediaUrl,
      label,
      preview: false,
    }));
  }
  if (fullCandidates.length) return fullCandidates;

  const previewUrl = allowedManyvidsMediaUrl(privateData?.teaser?.filepath);
  if (!previewUrl) return [];
  if (!await probeManyvidsMedia(fetchImpl, previewUrl, pageUrl, timeoutMs)) return [];
  return [candidateFromMedia({
    item,
    pageUrl,
    videoId,
    mediaUrl: previewUrl,
    label: 'official-preview',
    preview: true,
  })];
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
  isManyvidsHostname,
  manyvidsVideoId,
  normalizeManyvidsPageUrl,
  probeManyvidsMedia,
  resolveAuthoritativeManyVids,
  titleMatches,
};
