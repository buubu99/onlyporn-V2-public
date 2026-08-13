'use strict';

const { BoundedTtlCache } = require('./cache');
const { createSukebeiArtworkStore } = require('./sukebei-artwork-store');
const { validateImageResponse } = require('./sukebei-image-validator');
const { normalizeInfoHash, parseMagnet } = require('./candidate');
const { normalizeFeedItem, parseRssFeed } = require('./discovery-normalize');
const {
  mergeMetadataPreservingIdentity,
  normalizeScene,
  normalizeTags,
  safeHttpsUrl,
} = require('./metadata-normalize');
const { fallbackPosterUrl, normalizeSearchTitle, significantTokens } = require('./poster-enrichment');
const { sukebeiRssPosterUrl } = require('./sukebei-rss-poster');
const { SourceHttpClient, normalizeContentType } = require('./source-http');
const { detectResolution, extractMagnetFromHtml } = require('./torrent-index');
const { decodeTorrent, readBoundedBuffer, safeNativeRequest } = require('./native-discovery');
const { assertSafeHttpsUrl } = require('../url-security');
const { evaluateContent, readContentFilterConfig } = require('../content-filter');
const { createMetaTubeClient } = require('./metatube-client');
const { recordSukebeiResult } = require('../runtime-readiness');

const CODE_EXCLUSIONS = new Set([
  'H264', 'H265', 'X264', 'X265', 'HEVC', 'AV1', 'AAC', 'AC3', 'DDP',
  '1080P', '2160P', '720P', '480P', '4K', '8K',
]);

const CODE_PREFIX_EXCLUSIONS = new Set([
  'RELEASE', 'SCENE', 'EPISODE', 'PART', 'VOL', 'VOLUME', 'DISC', 'DISK',
  'PACK', 'VIDEO', 'MOVIE', 'TITLE', 'DATE', 'UPDATE', 'COMPILATION',
  'PPV',
]);

const SUKEBEI_MAX_TORRENT_BYTES = 2_000_000;
const PLAYABLE_VIDEO_EXTENSION = /\.(?:avi|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ts|webm|wmv)$/i;
const PROMOTIONAL_FILE_MARKER = /(?:^|[\s._/[\]()-])(?:ad|ads|advert(?:isement)?|promo|preview|sample|trailer)(?:$|[\s._/[\]()-])/i;

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function compactKey(value) {
  return compactText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}
function isMetaTubePoster(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && /\/onlyporn\/poster\/metatube\//i.test(url.pathname);
  } catch {
    return false;
  }
}

function extractSceneCodes(value) {
  const text = compactText(value).toUpperCase();
  const output = [];
  const seen = new Set();

  const fc2 = text.match(/\bFC2[\s._-]*(?:PPV[\s._-]*)?(\d{5,9})\b/g) || [];
  for (const raw of fc2) {
    const digits = raw.match(/\d{5,9}/)?.[0];
    if (!digits) continue;
    const code = `FC2-PPV-${digits}`;
    if (!seen.has(code)) {
      seen.add(code);
      output.push(code);
    }
  }

  const generic = text.match(/\b[A-Z]{2,12}[\s._-]+\d{2,7}\b/g) || [];
  for (const raw of generic) {
    const code = raw.replace(/[\s._-]+/g, '-');
    const key = compactKey(code);
    const prefix = code.split('-')[0];
    if (!key || CODE_EXCLUSIONS.has(key) || CODE_PREFIX_EXCLUSIONS.has(prefix) ||
        /^(?:19|20)\d{2}$/.test(key)) continue;
    if (!seen.has(code)) {
      seen.add(code);
      output.push(code);
    }
  }

  return Object.freeze(output.slice(0, 4));
}

function normalizedSceneCode(value) {
  const codes = extractSceneCodes(value);
  const code = String(codes[0] || '').toUpperCase();
  if (!code) return '';
  return code.replace(/\d+/g, digits => String(Number.parseInt(digits, 10) || 0));
}

function codesMatch(left, right) {
  const leftCodes = extractSceneCodes(left).map(normalizedSceneCode).filter(Boolean);
  const rightCodes = extractSceneCodes(right).map(normalizedSceneCode).filter(Boolean);
  if (!leftCodes.length || !rightCodes.length) return false;
  const rightSet = new Set(rightCodes);
  return leftCodes.some(code => rightSet.has(code));
}

function detailPageImage(html, detailUrl) {
  const document = String(html || '');
  if (!document || !detailUrl) return '';
  const candidates = [];
  const descriptionBlocks = [
    ...document.matchAll(/<div\b[^>]*\bid=["']torrent-description["'][^>]*>([\s\S]*?)(?:<\/div>|$)/gi),
    ...document.matchAll(/<div\b[^>]*\bclass=["'][^"']*torrent-description[^"']*["'][^>]*>([\s\S]*?)(?:<\/div>|$)/gi),
  ].map(match => match[1]);
  const scopes = descriptionBlocks.length ? descriptionBlocks : [document];
  for (const scope of scopes) {
    for (const match of scope.matchAll(/<img\b[^>]*\b(?:data-src|src)=["']([^"']+)["']/gi)) {
      candidates.push({ value: match[1], requireImageExtension: false });
    }
    // Live Sukebei descriptions are markdown rendered as text in the page.
    // Uploaders commonly paste cover URLs directly instead of using <img>.
    for (const match of scope.matchAll(/https:\/\/[^\s<>"'&]+/gi)) {
      candidates.push({ value: match[0], requireImageExtension: true });
    }
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(String(candidate.value || '').trim(), detailUrl);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      const path = url.pathname.toLowerCase();
      if (candidate.requireImageExtension &&
          !/\.(?:avif|jpe?g|png|webp)$/i.test(path)) continue;
      if (/\.(?:svg|gif)(?:$|\?)/i.test(url.toString())) continue;
      if (/(?:logo|favicon|avatar|icon|smiley|emoji|flag)/i.test(path)) continue;
      if (url.hostname.toLowerCase() === 'sukebei.nyaa.si' && /\/(?:static|img)\//.test(path)) continue;
      return url.toString();
    } catch {
      // Ignore malformed uploader-supplied image URLs.
    }
  }
  return '';
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_match, digits) =>
      String.fromCodePoint(Number.parseInt(digits, 10)));
}

function htmlText(value) {
  return compactText(decodeHtmlAttribute(
    String(value || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ));
}

function htmlAttribute(tag, name) {
  const match = String(tag || '').match(new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i'
  ));
  return decodeHtmlAttribute(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function parseSukebeiTopHtml(html, origin = 'https://sukebei.nyaa.si/') {
  const rows = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const output = [];
  for (const row of rows) {
    const anchors = [...row.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map(match => match[0]);
    const detailAnchor = anchors.find(anchor => /\/view\/\d+/i.test(htmlAttribute(anchor, 'href')));
    const torrentAnchor = anchors.find(anchor => /\/download\/\d+\.torrent(?:$|[?#])/i.test(htmlAttribute(anchor, 'href')));
    const magnetAnchor = anchors.find(anchor => /^magnet:\?/i.test(htmlAttribute(anchor, 'href')));
    if (!detailAnchor || !magnetAnchor) continue;

    let detailUrl = '';
    try {
      detailUrl = new URL(htmlAttribute(detailAnchor, 'href'), origin).toString();
    } catch {
      continue;
    }
    if (!safeHttpsUrl(detailUrl)) continue;

    let torrentUrl = '';
    try {
      torrentUrl = new URL(
        torrentAnchor ? htmlAttribute(torrentAnchor, 'href') : detailUrl.replace(/\/view\/(\d+)$/i, '/download/$1.torrent'),
        origin
      ).toString();
    } catch {
      torrentUrl = '';
    }
    if (!safeHttpsUrl(torrentUrl)) torrentUrl = '';

    const magnetLink = decodeHtmlAttribute(htmlAttribute(magnetAnchor, 'href'));
    const magnet = parseMagnet(magnetLink);
    const infoHash = normalizeInfoHash(magnet?.infoHash);
    if (!infoHash) continue;

    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
      .map(match => ({ attributes: match[1], text: htmlText(match[2]) }));
    const numericCells = cells
      .map(cell => cell.text)
      .filter(value => /^\d+$/.test(value));
    const dateCell = cells.find(cell => /\bdata-timestamp\s*=/i.test(cell.attributes));
    const timestamp = Number.parseInt(
      String(dateCell?.attributes || '').match(/\bdata-timestamp\s*=\s*["']?(\d+)/i)?.[1] || '',
      10
    );
    const title = htmlText(htmlAttribute(detailAnchor, 'title') || detailAnchor);
    if (!title) continue;

    output.push(Object.freeze({
      id: detailUrl,
      guid: detailUrl,
      title,
      link: detailUrl,
      detailUrl,
      torrentUrl,
      magnetLink,
      infoHash,
      trackers: magnet?.trackers || [],
      size: cells.length >= 5 ? cells[cells.length - 5].text : '',
      published: Number.isFinite(timestamp)
        ? new Date(timestamp * 1000).toISOString()
        : (dateCell?.text || ''),
      seeders: numericCells.length >= 3 ? numericCells[numericCells.length - 3] : '0',
      tags: ['Real Life', 'Videos'],
    }));
  }
  return output;
}

function selectSukebeiMainFile(files = []) {
  const playable = (Array.isArray(files) ? files : [])
    .filter(file => Number.isInteger(file?.index) && file.index >= 0)
    .filter(file => PLAYABLE_VIDEO_EXTENSION.test(compactText(file.path)))
    .map(file => Object.freeze({
      index: file.index,
      path: compactText(file.path),
      length: Math.max(Number(file.length || 0), 0),
      promotional: PROMOTIONAL_FILE_MARKER.test(compactText(file.path)),
    }));
  if (!playable.length) return null;
  const mainPool = playable.some(file => !file.promotional)
    ? playable.filter(file => !file.promotional)
    : playable;
  return [...mainPool].sort((left, right) => right.length - left.length || left.index - right.index)[0] || null;
}

function sukebeiTorrentUrl(source = {}) {
  const direct = safeHttpsUrl(source.torrentUrl) ? String(source.torrentUrl) : '';
  if (direct) return direct;
  try {
    const detail = new URL(String(source.detailUrl || ''));
    const match = detail.pathname.match(/^\/view\/(\d+)\/?$/i);
    if (!match) return '';
    detail.pathname = `/download/${match[1]}.torrent`;
    detail.search = '';
    detail.hash = '';
    return safeHttpsUrl(detail.toString()) ? detail.toString() : '';
  } catch {
    return '';
  }
}

function landingPageImage(html, pageUrl) {
  const document = String(html || '');
  if (!document || !pageUrl) return '';
  const candidates = [];
  const add = (value, score) => candidates.push({ value, score });

  for (const match of document.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = compactText(htmlAttribute(tag, 'property') || htmlAttribute(tag, 'name')).toLowerCase();
    if (!/^(?:og:image(?::url)?|twitter:image(?::src)?)$/.test(key)) continue;
    add(htmlAttribute(tag, 'content'), key.startsWith('og:') ? 400 : 380);
  }
  for (const match of document.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const className = htmlAttribute(tag, 'class');
    const score = /\bdata-fancybox\s*=/i.test(tag)
      ? 340
      : (/(?:download|full|image|photo|picture)/i.test(className) ? 260 : 0);
    if (score) add(htmlAttribute(tag, 'href'), score);
  }
  for (const match of document.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const className = htmlAttribute(tag, 'class');
    const score = /(?:\bpic\b|full|main|original|responsive)/i.test(className) ? 320 : 180;
    add(htmlAttribute(tag, 'data-src') || htmlAttribute(tag, 'src'), score);
  }
  for (const match of document.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    add(match[0], 80);
  }

  const page = new URL(pageUrl);
  const normalized = new Map();
  for (const candidate of candidates) {
    try {
      const url = new URL(String(candidate.value || '').trim(), page);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      if (url.toString() === page.toString()) continue;
      const path = url.pathname.toLowerCase();
      if (!/\.(?:avif|jpe?g|png|webp)(?:$|\/)/i.test(path)) continue;
      if (/\.(?:svg|gif)(?:$|[/?])/i.test(path)) continue;
      if (/(?:logo|favicon|avatar|icon|smiley|emoji|flag|banner|advert)/i.test(path)) continue;
      const previous = normalized.get(url.toString());
      if (!previous || candidate.score > previous.score) {
        normalized.set(url.toString(), { url: url.toString(), score: candidate.score });
      }
    } catch {
      // Ignore malformed or relative values that cannot be resolved safely.
    }
  }
  return [...normalized.values()]
    .sort((left, right) => right.score - left.score || right.url.length - left.url.length)[0]?.url || '';
}

async function cancelResponseBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') await response.body.cancel();
  } catch {
    // The response headers are sufficient for an image probe.
  }
}

async function fetchPosterResource(value, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const deadlineAt = Number(options.deadlineAt || Infinity);
  const checkDns = options.checkDns !== false;
  const maxResponseBytes = Math.max(Number(options.maxResponseBytes || 2_000_000), 1_024);
  let current = String(value || '');
  let probes = 0;

  for (let redirects = 0; redirects <= 4; redirects += 1) {
    if (Date.now() >= deadlineAt) throw new Error('Sukebei poster resolution deadline exceeded');
    const safeUrl = await assertSafeHttpsUrl(current, { checkDns });
    const remaining = Math.max(deadlineAt - Date.now(), 1);
    const timeoutMs = Math.min(
      Math.max(Number(options.timeoutMs || 3_000), 250),
      remaining
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      probes += 1;
      response = await fetchImpl(safeUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,text/html;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8',
          'User-Agent': 'OnlyPorn-TPB4K/2.7',
        },
      });
      const status = Number(response?.status || 0);
      if (status >= 300 && status < 400) {
        const location = response.headers?.get?.('location');
        await cancelResponseBody(response);
        if (!location) return Object.freeze({ url: '', html: '', pageUrl: safeUrl, probes });
        current = new URL(decodeHtmlAttribute(location), safeUrl).toString();
        continue;
      }
      if (status < 200 || status >= 300) {
        await cancelResponseBody(response);
        return Object.freeze({ url: '', html: '', pageUrl: safeUrl, probes });
      }

      const contentType = normalizeContentType(response.headers?.get?.('content-type'));
      if (/^image\/(?:avif|jpeg|jpg|pjpeg|png|webp)$/.test(contentType)) {
        const image = await validateImageResponse(response, { url: safeUrl, maxResponseBytes });
        if (!image.valid) return Object.freeze({ url: '', html: '', pageUrl: safeUrl, probes, rejectedImage: image.reason });
        return Object.freeze({ url: safeUrl, html: '', pageUrl: safeUrl, probes, image });
      }
      if (contentType !== 'text/html' && contentType !== 'application/xhtml+xml') {
        await cancelResponseBody(response);
        return Object.freeze({ url: '', html: '', pageUrl: safeUrl, probes });
      }

      const contentLength = Number.parseInt(
        String(response.headers?.get?.('content-length') || 0),
        10
      ) || 0;
      if (contentLength > maxResponseBytes) {
        throw new Error('Sukebei poster landing page exceeded the configured byte limit');
      }
      const html = await response.text();
      if (Buffer.byteLength(html, 'utf8') > maxResponseBytes) {
        throw new Error('Sukebei poster landing page exceeded the configured byte limit');
      }
      return Object.freeze({ url: '', html, pageUrl: safeUrl, probes });
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({ url: '', html: '', pageUrl: current, probes });
}

async function resolveVerifiedPosterUrl(value, options = {}) {
  let current = String(value || '');
  let probes = 0;
  let landingPages = 0;
  const seen = new Set();

  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || seen.has(current)) break;
    seen.add(current);
    const result = await fetchPosterResource(current, options);
    probes += result.probes;
    if (result.url) {
      return Object.freeze({ url: result.url, probes, landingPages });
    }
    if (!result.html) break;
    landingPages += 1;
    current = landingPageImage(result.html, result.pageUrl);
  }
  return Object.freeze({ url: '', probes, landingPages });
}

function titleOverlap(left, right) {
  const a = new Set(significantTokens(left));
  const b = new Set(significantTokens(right));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(Math.min(a.size, b.size), 1);
}

function dedupeAndRank(items = []) {
  const byIdentity = new Map();
  for (const item of items) {
    const key = compactKey(
      item.sourceId ||
      item.upstreamId ||
      item.detailUrl ||
      `${item.title}|${item.releaseDate || ''}`
    );
    if (!key) continue;
    const previous = byIdentity.get(key);
    if (!previous || Number(item.seeders || 0) > Number(previous.seeders || 0)) {
      byIdentity.set(key, item);
    }
  }
  return [...byIdentity.values()].sort((left, right) => {
    const seederDelta = Number(right.seeders || 0) - Number(left.seeders || 0);
    if (seederDelta) return seederDelta;
    return String(right.releaseDate || '').localeCompare(String(left.releaseDate || ''));
  });
}

function exactCodeEvidence(source, normalized) {
  return Boolean(
    codesMatch(source?.title, normalized?.sceneCode) ||
    codesMatch(source?.title, normalized?.title)
  );
}

function scoreCandidate(source, normalized) {
  if (!normalized?.poster) return 0;
  if (exactCodeEvidence(source, normalized)) return 140;
  const sourceCodes = extractSceneCodes(source.title);
  const candidateCode = compactKey(normalized.sceneCode);
  const candidateTitleKey = compactKey(normalized.title);
  for (const code of sourceCodes) {
    const key = compactKey(code);
    if (candidateCode && candidateCode === key) return 140;
    if (candidateTitleKey.includes(key)) return 125;
  }
  const overlap = titleOverlap(source.title, normalized.title);
  if (overlap >= 0.8) return 100;
  if (overlap >= 0.65) return 85;
  if (overlap >= 0.5) return 72;
  return 0;
}

function createLimiter(maxConcurrency = 4) {
  const limit = Math.max(Number.parseInt(String(maxConcurrency || 4), 10) || 4, 1);
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }
  return run => new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    drain();
  });
}

function freezeDiagnostics(stats) {
  return Object.freeze({
    ...stats,
    providerRequests: Object.freeze({ ...stats.providerRequests }),
    providerMatches: Object.freeze({ ...stats.providerMatches }),
    providerErrors: Object.freeze({ ...stats.providerErrors }),
    providerErrorReasons: Object.freeze({ ...(stats.providerErrorReasons || {}) }),
    providerCircuitOpen: Object.freeze({ ...(stats.providerCircuitOpen || {}) }),
    filterReasons: Object.freeze({ ...stats.filterReasons }),
  });
}


function incrementCounter(object, key, amount = 1) {
  object[key] = (object[key] || 0) + amount;
}

function classifyProviderError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (error?.name === 'AbortError' || /abort|timed?\s*out/.test(message)) return 'timeout';
  if (/http\s+429|rate\s*limit|too many requests/.test(message)) return 'rate-limit';
  if (/http\s+40[0134]/.test(message)) return 'authorization-or-request';
  if (/graphql|cannot query field|unknown field|not defined by type/.test(message)) return 'graphql';
  if (/fetch failed|network|econn|enotfound|dns/.test(message)) return 'network';
  return 'other';
}

async function queryExactCodeProvider(provider, metadataClient, source, code, options = {}) {
  const stats = options.stats || {
    exactCodeQueries: 0,
    exactCodeMisses: 0,
    providerRequests: {},
    providerErrors: {},
  };
  if (!metadataClient?.configured || !code) {
    return Object.freeze({ ok: false, provider, code, returned: 0, candidate: null });
  }

  incrementCounter(stats.providerRequests, provider);
  stats.exactCodeQueries += 1;
  try {
    let scenes = [];
    if (provider === 'stashdb' && typeof metadataClient.searchScenes === 'function') {
      scenes = await metadataClient.searchScenes(code, 20, {
        timeoutMs: options.timeoutMs,
      });
    } else if (typeof metadataClient.queryScenes === 'function') {
      scenes = await metadataClient.queryScenes({
        query: code,
        perPage: 20,
        page: 1,
        timeoutMs: options.timeoutMs,
      });
    }

    let best = null;
    for (const raw of Array.isArray(scenes) ? scenes : []) {
      const normalized = normalizeScene(provider, raw);
      if (!normalized || !safeHttpsUrl(normalized.poster) || !exactCodeEvidence(source, normalized)) {
        continue;
      }
      const score = scoreCandidate(source, normalized);
      if (!score) continue;
      const candidate = { provider, raw, normalized, score };
      if (!best || candidate.score > best.score) best = candidate;
    }
    if (!best) stats.exactCodeMisses += 1;
    return Object.freeze({
      ok: true,
      provider,
      code,
      returned: Array.isArray(scenes) ? scenes.length : 0,
      candidate: best,
    });
  } catch (error) {
    incrementCounter(stats.providerErrors, provider);
    if (!stats.providerErrorReasons) stats.providerErrorReasons = {};
    const errorReason = classifyProviderError(error);
    incrementCounter(stats.providerErrorReasons, `${provider}:${errorReason}`);
    return Object.freeze({
      ok: false,
      provider,
      code,
      returned: 0,
      candidate: null,
      errorReason,
      error: String(error?.message || error || 'metadata lookup failed'),
    });
  }
}

function createSukebeiMetadataAdapter(options = {}) {
  const config = options.config || {};
  const env = options.env || process.env;
  const metatubeClient = options.metatubeClient || createMetaTubeClient({ env, fetchImpl: options.fetchImpl });
  const metatubeStrict = Boolean(metatubeClient.configured && /^(?:1|true|yes|on)$/i.test(String(env.TPB4K_METATUBE_STRICT || '')));
  const clients = {
    ...(options.metadataClients || {}),
    ...(metatubeClient.configured ? { metatube: metatubeClient } : {}),
  };
  const posterFetchImpl = options.fetchImpl || globalThis.fetch;
  const posterCheckDns = options.checkDns;
  const providers = ['stashdb', 'tpdb'].filter(name => clients[name]?.configured);
  const filterConfig = options.filterConfig || readContentFilterConfig(options.env || process.env);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const client = new SourceHttpClient({
    id: 'sukebei',
    endpoint: options.endpoint,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['application/rss+xml', 'application/xml', 'text/xml'],
  });
  const detailOrigin = (() => {
    try { return `${new URL(options.endpoint).origin}/`; } catch { return ''; }
  })();
  const officialTopMode = (() => {
    try { return new URL(options.endpoint).hostname.toLowerCase() === 'sukebei.nyaa.si'; }
    catch { return false; }
  })();
  const topClient = officialTopMode && detailOrigin ? new SourceHttpClient({
    id: 'sukebei-top',
    endpoint: detailOrigin,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowHtml: true,
    accept: 'text/html,application/xhtml+xml;q=0.9',
    allowedContentTypes: ['text/html', 'application/xhtml+xml'],
  }) : null;
  const detailClient = detailOrigin ? new SourceHttpClient({
    id: 'sukebei-detail',
    endpoint: detailOrigin,
    timeoutMs: Math.min(Number(config.metadataLookupTimeoutMs || 4_000), 6_000),
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: config.discoveryCacheTtlMs,
    negativeTtlMs: config.discoveryNegativeTtlMs,
    cacheMaxEntries: config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    serializeRequests: false,
    allowHtml: true,
    allowedContentTypes: ['text/html'],
  }) : null;
  const cache = options.cache || new BoundedTtlCache({
    maxEntries: Math.max(Number(config.metadataCacheMaxEntries || 500), 50),
  });
  const index = new Map();
  const artworkStore = options.artworkStore || createSukebeiArtworkStore({
    env: options.env || process.env,
    maxEntries: Math.max(Number(config.metadataCacheMaxEntries || 500), 50),
  });
  // StashDB tolerates the general catalog queries but Render's Sukebei burst
  // produced 44 immediate failures at eight-way concurrency. Keep the exact
  // code scan bounded so it does not look like an abusive search burst.
  const metadataConcurrency = Math.min(
    Math.max(Number(config.sukebeiLookupConcurrency || 8), 1),
    3
  );
  const runLimited = createLimiter(metadataConcurrency);
  // Sukebei rate-limits bursts of detail-page GETs much more aggressively than
  // metadata APIs. Two concurrent native requests avoid both the old serial
  // queue and the 429/timeout storm caused by reusing metadata concurrency.
  const detailConcurrency = Math.min(
    Math.max(Number(config.sukebeiLookupConcurrency || 8), 1),
    2
  );
  const runDetailLimited = createLimiter(detailConcurrency);
  const positiveTtlMs = Math.max(Number(config.metadataCacheTtlMs || 600_000), 5_000);
  const negativeTtlMs = Math.max(Number(config.metadataNegativeTtlMs || 120_000), 5_000);
  const posterResolutionCache = options.posterResolutionCache || new BoundedTtlCache({
    maxEntries: Math.max(Number(config.discoveryCacheMaxEntries || 250), 50),
  });
  const torrentSelectionCache = options.torrentSelectionCache || new BoundedTtlCache({
    maxEntries: Math.max(Number(config.discoveryCacheMaxEntries || 250), 50),
  });
  let lastDiagnostics = freezeDiagnostics({
    budgetMs: 0,
    rssRecords: 0,
    rssRecordsRead: 0,
    rssDuplicateRecords: 0,
    rssDuplicatePages: 0,
    rssPages: 0,
    rssPagesRequested: 0,
    rssPagesEffective: 0,
    rssElapsedMs: 0,
    rssCategory: '',
    codeCandidates: 0,
    codeStageJobs: 0,
    codeStageCompleted: 0,
    codeStageMatches: 0,
    codeStageDeadlineSkipped: 0,
    codeStageProvider: '',
    titleStageJobs: 0,
    titleStageCompleted: 0,
    detailStageJobs: 0,
    detailStageCompleted: 0,
    detailStageTarget: 0,
    inspected: 0,
    lookupEligible: 0,
    lookupSkipped: 0,
    deadlineSkipped: 0,
    returned: 0,
    matchedByCode: 0,
    matchedByTitle: 0,
    exactCodeQueries: 0,
    exactCodeMisses: 0,
    detailImageRequests: 0,
    detailImageCandidates: 0,
    detailImageProbes: 0,
    detailImageLandingPages: 0,
    detailImageCacheHits: 0,
    detailImagesVerified: 0,
    detailImageRejected: 0,
    detailImages: 0,
    detailImageErrors: 0,
    nativeImages: 0,
      rssFallbackCards: 0,
    filtered: 0,
    unmatched: 0,
    cacheHits: 0,
    persistentArtworkHits: 0,
    persistentArtworkWrites: 0,
    providerRequests: {},
    providerMatches: {},
    providerErrors: {},
    providerErrorReasons: {},
    providerCircuitOpen: {},
    filterReasons: {},
    metadataConcurrency,
    detailReserveMs: 0,
    totalElapsedMs: 0,
    deadlineExceededMs: 0,
  });

  function remember(items) {
    for (const item of items) index.set(String(item.sourceId), item);
    return items;
  }

  async function queryProvider(provider, source, query, codeMode, stats, options = {}) {
    const metadataClient = clients[provider];
    if (!metadataClient?.configured || !query) return { candidates: [], ok: false };
    try {
      let scenes = [];
      if (provider === 'stashdb' && typeof metadataClient.searchScenes === 'function') {
        // The working TPB4K backend uses StashDB searchScene(term:) for JAV
        // product codes. SceneQueryInput.code returned no rows for the same
        // live feed, even though searchScene indexes the code column.
        const terms = codeMode
          ? [query, compactText(source.title)].filter((term, index, values) =>
              term && values.indexOf(term) === index)
          : [query];
        const byId = new Map();
        for (const term of terms) {
          stats.providerRequests[provider] = (stats.providerRequests[provider] || 0) + 1;
          if (codeMode) stats.exactCodeQueries += 1;
          const rows = await metadataClient.searchScenes(term, codeMode ? 20 : 10, {
            timeoutMs: options.timeoutMs,
          });
          for (const row of Array.isArray(rows) ? rows : []) {
            const key = String(row?.id || `${row?.code || ''}|${row?.title || ''}`);
            if (key) byId.set(key, row);
          }
          if ([...byId.values()].some(raw => {
            const candidate = normalizeScene(provider, raw);
            return candidate && (!codeMode || exactCodeEvidence(source, candidate));
          })) break;
        }
        scenes = [...byId.values()];
      } else {
        stats.providerRequests[provider] = (stats.providerRequests[provider] || 0) + 1;
        if (codeMode) stats.exactCodeQueries += 1;
        const request = provider === 'stashdb'
          ? {
              title: query,
              perPage: codeMode ? 20 : 10,
              page: 1,
              sort: 'DATE',
            }
          : {
              query,
              perPage: codeMode ? 20 : 30,
              page: 1,
            };
        scenes = await metadataClient.queryScenes({
          ...request,
          timeoutMs: options.timeoutMs,
        });
      }
      const output = [];
      for (const raw of Array.isArray(scenes) ? scenes : []) {
        const normalized = normalizeScene(provider, raw);
        if (codeMode && !exactCodeEvidence(source, normalized)) continue;
        const score = scoreCandidate(source, normalized);
        if (!score) continue;
        output.push({ provider, raw, normalized, score });
      }
      if (codeMode && !output.length) stats.exactCodeMisses += 1;
      return { candidates: output, ok: true };
    } catch (error) {
      stats.providerErrors[provider] = (stats.providerErrors[provider] || 0) + 1;
      incrementCounter(
        stats.providerErrorReasons,
        `${provider}:${classifyProviderError(error)}`
      );
      return { candidates: [], ok: false };
    }
  }

  async function metadataMatch(source, stats, options = {}) {
    const cacheKey = `sukebei:${source.sourceId}`;
    const cached = cache.getEntry(cacheKey);
    if (cached) {
      stats.cacheHits += 1;
      return cached.negative ? null : cached.value;
    }

    const codes = options.skipCodes ? [] : extractSceneCodes(source.title);
    let best = null;
    let successfulLookup = false;
    let lookupError = false;
    for (const code of codes) {
      for (const provider of providers) {
        if (Date.now() >= Number(options.deadlineAt || Infinity)) break;
        const remaining = Math.max(Number(options.deadlineAt || Infinity) - Date.now(), 250);
        const result = await queryProvider(provider, source, code, true, stats, {
          timeoutMs: Math.min(
            Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
            remaining
          ),
        });
        successfulLookup ||= result.ok;
        lookupError ||= !result.ok;
        for (const candidate of result.candidates) {
          if (!best || candidate.score > best.score) best = candidate;
        }
        if (best?.score >= 120) break;
      }
      if (best?.score >= 120 || Date.now() >= Number(options.deadlineAt || Infinity)) break;
    }
    if (best) stats.matchedByCode += 1;

    if (!best && options.allowTitle && Date.now() < Number(options.deadlineAt || Infinity)) {
      const query = normalizeSearchTitle(source.title).query.slice(0, 140);
      if (query.length >= 6) {
        for (const provider of providers) {
          if (Date.now() >= Number(options.deadlineAt || Infinity)) break;
          const remaining = Math.max(Number(options.deadlineAt || Infinity) - Date.now(), 250);
          const result = await queryProvider(provider, source, query, false, stats, {
            timeoutMs: Math.min(
              Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
              remaining
            ),
          });
          successfulLookup ||= result.ok;
          lookupError ||= !result.ok;
          for (const candidate of result.candidates) {
            if (!best || candidate.score > best.score) best = candidate;
          }
          if (best?.score >= 85) break;
        }
      }
      if (best) stats.matchedByTitle += 1;
    }

    if (!best) {
      // Cache only a confirmed metadata miss. A timeout/network/provider error
      // must be retried on the next request rather than becoming a false miss.
      if (successfulLookup && !lookupError) cache.setNegative(cacheKey, negativeTtlMs);
      return null;
    }

    stats.providerMatches[best.provider] = (stats.providerMatches[best.provider] || 0) + 1;
    const merged = mergeMetadataPreservingIdentity(source, {
      ...best.normalized,
      tags: normalizeTags(best.normalized.tags),
      contentTags: normalizeTags(best.normalized.contentTags || best.normalized.tags),
      metadataProvider: best.provider,
    });
    const enriched = Object.freeze({
      ...merged,
      metadataProvider: best.provider,
      lookupSource: 'sukebei',
      lookupQuery: compactText(codes[0] || normalizeSearchTitle(source.title).query).slice(0, 240),
      contentClassificationKnown: Array.isArray(merged.tags) && merged.tags.length > 0,
    });
    cache.set(cacheKey, enriched, positiveTtlMs);
    return enriched;
  }


  function mergeCandidateForSource(source, candidate, stats, lookupQuery) {
    if (!candidate?.normalized?.poster) return null;
    incrementCounter(stats.providerMatches, candidate.provider);
    const merged = mergeMetadataPreservingIdentity(source, {
      ...candidate.normalized,
      tags: normalizeTags(candidate.normalized.tags),
      contentTags: normalizeTags(candidate.normalized.contentTags || candidate.normalized.tags),
      metadataProvider: candidate.provider,
    });
    const enriched = Object.freeze({
      ...merged,
      metadataProvider: candidate.provider,
      lookupSource: 'sukebei',
      lookupQuery: compactText(lookupQuery || extractSceneCodes(source.title)[0] || '').slice(0, 240),
      contentClassificationKnown: Array.isArray(merged.tags) && merged.tags.length > 0,
    });
    cache.set(`sukebei:${source.sourceId}`, enriched, positiveTtlMs);
    return enriched;
  }

  async function nativeDetailMatch(source, stats, options = {}) {
    if (!detailClient?.configured || !safeHttpsUrl(source.detailUrl)) return null;
    const deadlineAt = Number(options.deadlineAt || Infinity);
    if (Date.now() >= deadlineAt) return null;
    stats.detailImageRequests += 1;
    try {
      const remaining = Math.max(deadlineAt - Date.now(), 250);
      const html = await detailClient.fetchText(source.detailUrl, {
        cacheKey: `sukebei:detail:${source.sourceId}`,
        timeoutMs: Math.min(detailClient.timeoutMs, remaining),
      });
      const candidate = detailPageImage(html, source.detailUrl);
      if (!candidate) return null;
      stats.detailImageCandidates += 1;
      const posterKey = `sukebei:poster:${candidate}`;
      const cachedPoster = posterResolutionCache.getEntry(posterKey);
      let verification;
      if (cachedPoster) {
        stats.detailImageCacheHits += 1;
        verification = Object.freeze({
          url: cachedPoster.negative ? '' : String(cachedPoster.value || ''),
          probes: 0,
          landingPages: 0,
        });
      } else {
        verification = await resolveVerifiedPosterUrl(candidate, {
          fetchImpl: posterFetchImpl,
          checkDns: posterCheckDns,
          deadlineAt,
          timeoutMs: Math.min(
            Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
            3_000
          ),
          maxResponseBytes: config.discoveryMaxResponseBytes,
        });
        if (verification.url) {
          posterResolutionCache.set(posterKey, verification.url, positiveTtlMs);
        } else {
          posterResolutionCache.setNegative(posterKey, Math.min(negativeTtlMs, 30_000));
        }
      }
      stats.detailImageProbes += verification.probes;
      stats.detailImageLandingPages += verification.landingPages;
      if (!verification.url) {
        stats.detailImageRejected += 1;
        return null;
      }
      const poster = verification.url;
      stats.detailImagesVerified += 1;
      stats.detailImages += 1;
      return Object.freeze({
        ...source,
        poster,
        background: poster,
        lookupSource: 'sukebei-detail',
        contentClassificationKnown: Array.isArray(source.tags) && source.tags.length > 0,
      });
    } catch {
      stats.detailImageErrors += 1;
      return null;
    }
  }

  async function enrichOne(source, stats, options = {}) {
    if (safeHttpsUrl(source.poster)) {
      stats.nativeImages += 1;
      return Object.freeze({
        ...source,
        lookupSource: 'sukebei',
        contentClassificationKnown: Array.isArray(source.tags) && source.tags.length > 0,
      });
    }
    const metadata = options.allowMetadata === false
      ? null
      : await metadataMatch(source, stats, options);
    if (metadata) return metadata;
    return nativeDetailMatch(source, stats, options);
  }

  async function catalog({ catalog: catalogDefinition, skip = 0, limit = 40 }) {
    if (!client.configured) return [];
    const requestStartedAt = Date.now();
    const searchQuery = compactText(catalogDefinition?.searchQuery || '').slice(0, 120);
    const searchMode = Boolean(searchQuery);
    const configuredBudgetMs = Math.min(
      Math.max(Number(config.sukebeiEnrichmentDeadlineMs || 24_000), 4_000),
      900_000
    );
    const searchBudgetMs = Math.min(
      Math.max(Number(env.ONLYPORN_SEARCH_SUKEBEI_BUDGET_MS || 45_000), 10_000),
      90_000
    );
    const budgetMs = searchMode
      ? Math.min(configuredBudgetMs, searchBudgetMs)
      : configuredBudgetMs;
    const deadlineAt = requestStartedAt + budgetMs;
    const rssDeadlineAt = Math.min(
      deadlineAt,
      requestStartedAt + Math.min(Math.max(Math.floor(budgetMs * 0.35), 4_000), 10_000)
    );
    const safeSkip = Math.max(Number.parseInt(String(skip || 0), 10) || 0, 0);
    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);
    const needed = safeSkip + safeLimit;
    const strictMinimum = searchMode ? 0 : (safeSkip === 0 ? Math.min(24, safeLimit) : 0);
    const feed = [];
    const useOfficialTopPage = officialTopMode && catalogDefinition?.mode === 'top';
    const requestedRssPages = Math.min(Math.max(Number(config.sukebeiRssPages || 4), 1), 8);
    const rssPages = (() => {
      try {
        return new URL(client.endpoint).hostname.toLowerCase() === 'sukebei.nyaa.si'
          ? 1
          : requestedRssPages;
      } catch {
        return requestedRssPages;
      }
    })();
    const seenFeedRecords = new Set();
    let fetchedPages = 0;
    let rssRecordsRead = 0;
    let rssDuplicateRecords = 0;
    let rssDuplicatePages = 0;
    const appendFeedItems = items => {
      let newRecords = 0;
      for (const item of items) {
        const key = compactText(item.id || item.guid || item.link || item.detailUrl);
        if (!key || seenFeedRecords.has(key)) {
          rssDuplicateRecords += 1;
          continue;
        }
        seenFeedRecords.add(key);
        feed.push(item);
        newRecords += 1;
      }
      return newRecords;
    };
    // The single Sukebei catalogue combines two honest upstream windows:
    // seed-ranked Real Life Videos from the official HTML table, followed by
    // the all-category rolling RSS feed. Identity-based dedupe prevents the
    // same torrent appearing twice.
    if (useOfficialTopPage) {
      const topUrl = new URL(detailOrigin);
      topUrl.searchParams.set('f', '0');
      topUrl.searchParams.set('c', '2_2');
      topUrl.searchParams.set('q', searchQuery);
      topUrl.searchParams.set('s', 'seeders');
      topUrl.searchParams.set('o', 'desc');
      const remaining = Math.max(rssDeadlineAt - Date.now(), 250);
      const payload = await topClient.fetchText(topUrl.toString(), {
        cacheKey: `sukebei:top:real-life-videos:seeders:${compactKey(searchQuery) || 'BROWSE'}`,
        timeoutMs: Math.min(topClient.timeoutMs, remaining),
      });
      const pageItems = parseSukebeiTopHtml(payload, detailOrigin);
      if (!pageItems.length) throw new Error('Sukebei top page returned no playable video rows');
      fetchedPages += 1;
      rssRecordsRead += pageItems.length;
      appendFeedItems(pageItems);
    }
    for (let page = 1; page <= rssPages; page += 1) {
      if (Date.now() >= rssDeadlineAt) break;
      const pageUrl = new URL(client.endpoint);
      pageUrl.searchParams.set('p', String(page));
      if (searchMode) pageUrl.searchParams.set('q', searchQuery);
      const remaining = Math.max(rssDeadlineAt - Date.now(), 250);
      const payload = await client.fetchText(pageUrl.toString(), {
        cacheKey: `sukebei:rss:${compactKey(searchQuery) || 'BROWSE'}:${page}`,
        timeoutMs: Math.min(client.timeoutMs, remaining),
      });
      const pageItems = parseRssFeed(payload);
      if (!pageItems.length) break;
      fetchedPages += 1;
      rssRecordsRead += pageItems.length;
      const newRecords = appendFeedItems(pageItems);
      // The official RSS endpoint currently ignores `p` and returns the same
      // rolling window. Stop once a later response is at least 90% duplicate.
      if (page > 1 && newRecords <= Math.max(Math.floor(pageItems.length * 0.1), 1)) {
        rssDuplicatePages += 1;
        break;
      }
    }
    const stats = {
      budgetMs,
      rssRecords: feed.length,
      rssRecordsRead,
      rssDuplicateRecords,
      rssDuplicatePages,
      rssPages: fetchedPages,
      rssPagesRequested: requestedRssPages,
      rssPagesEffective: rssPages,
      rssElapsedMs: Date.now() - requestStartedAt,
      rssCategory: useOfficialTopPage ? '2_2' : (() => {
        try { return new URL(client.endpoint).searchParams.get('c') || ''; } catch { return ''; }
      })(),
      discoveryMode: `${useOfficialTopPage ? 'official-html-top+rss' : 'rss'}${searchMode ? '-search' : ''}`,
      codeCandidates: 0,
      codeStageJobs: 0,
      codeStageCompleted: 0,
      codeStageMatches: 0,
      codeStageDeadlineSkipped: 0,
      codeStageProvider: '',
      titleStageJobs: 0,
      titleStageCompleted: 0,
      detailStageJobs: 0,
      detailStageCompleted: 0,
      detailStageTarget: 0,
      inspected: 0,
      lookupEligible: 0,
      lookupSkipped: 0,
      deadlineSkipped: 0,
      returned: 0,
      matchedByCode: 0,
      matchedByTitle: 0,
      exactCodeQueries: 0,
      exactCodeMisses: 0,
      detailImageRequests: 0,
      detailImageCandidates: 0,
      detailImageProbes: 0,
      detailImageLandingPages: 0,
      detailImageCacheHits: 0,
      detailImagesVerified: 0,
      detailImageRejected: 0,
      detailImages: 0,
      detailImageErrors: 0,
      nativeImages: 0,
      rssFallbackCards: 0,
      filtered: 0,
      unmatched: 0,
      cacheHits: 0,
      persistentArtworkHits: 0,
      persistentArtworkWrites: 0,
      providerRequests: {},
      providerMatches: {},
      providerErrors: {},
      providerErrorReasons: {},
      providerCircuitOpen: {},
      filterReasons: {},
      metadataConcurrency,
      detailReserveMs: 0,
      totalElapsedMs: 0,
      deadlineExceededMs: 0,
    };

    const normalized = dedupeAndRank(
      feed
        .map((item, position) => normalizeFeedItem('sukebei', item, position))
        .filter(Boolean)
    );
    stats.inspected = normalized.length;
    stats.codeCandidates = normalized.filter(item => extractSceneCodes(item.title).length > 0).length;

    const codeLimit = searchMode
      ? Math.min(Math.max(Number(env.ONLYPORN_SEARCH_SUKEBEI_CODE_LIMIT || 12), 1), 24)
      : Math.min(Math.max(Number(config.sukebeiCodeLookupLimit || 130), 1), 180);
    const titleLimit = metatubeStrict ? 0 : Math.min(Math.max(Number(config.sukebeiTitleLookupLimit || 4), 0), 20);
    const detailLimit = metatubeStrict ? 0 : Math.min(Math.max(Number(config.sukebeiDetailImageLimit || 20), 0), 40);
    const detailTargetLimit = detailLimit;
    const detailLookupTimeoutMs = Math.min(
      Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
      6_000
    );
    const detailWaves = detailTargetLimit ? Math.ceil(detailTargetLimit / detailConcurrency) : 0;
    const detailReserveMs = detailTargetLimit
      ? Math.min(
          Math.max((detailWaves * detailLookupTimeoutMs) + 500, 4_000),
          Math.floor(budgetMs / 2)
        )
      : 0;
    const metadataDeadlineAt = Math.max(Date.now(), deadlineAt - detailReserveMs);
    stats.detailReserveMs = detailReserveMs;
    stats.detailStageTarget = detailTargetLimit;
    const resolvedById = new Map();

    // Keep native RSS artwork immediately. A later metadata stage must never
    // overwrite or discard a source record that already has honest artwork.
    for (const item of normalized) {
      if (!safeHttpsUrl(item.poster)) continue;
      stats.nativeImages += 1;
      resolvedById.set(String(item.sourceId), Object.freeze({
        ...item,
        lookupSource: 'sukebei',
        contentClassificationKnown: Array.isArray(item.tags) && item.tags.length > 0,
      }));
    }

    // Rehydrate positive source matches before making any network request.
    for (const item of normalized) {
      if (resolvedById.has(String(item.sourceId))) continue;
      const cached = cache.getEntry(`sukebei:${item.sourceId}`);
      if (cached && !cached.negative && cached.value?.poster) {
        stats.cacheHits += 1;
        resolvedById.set(String(item.sourceId), cached.value);
      }
    }

    // Rehydrate disk-backed last-known-good artwork after the in-memory cache.
    for (const item of normalized) {
      const sourceId = String(item.sourceId);
      if (resolvedById.has(sourceId)) continue;
      const persisted = artworkStore.get(sourceId);
      if (!persisted?.poster) continue;
      const restored = Object.freeze({
        ...item,
        poster: persisted.poster,
        background: persisted.background || persisted.poster,
        metadataProvider: persisted.metadataProvider || item.metadataProvider,
        lookupQuery: persisted.lookupQuery || item.lookupQuery,
        sceneCode: item.sceneCode || persisted.sceneCode,
        releaseDate: item.releaseDate || persisted.releaseDate,
        studio: item.studio || persisted.studio,
        performers: Array.isArray(item.performers) && item.performers.length ? item.performers : persisted.performers,
        tags: Array.isArray(item.tags) && item.tags.length ? item.tags : persisted.tags,
        contentTags: Array.isArray(item.contentTags) && item.contentTags.length ? item.contentTags : persisted.contentTags,
        lookupSource: 'sukebei-persistent-cache',
        contentClassificationKnown: Boolean(item.tags?.length || persisted.tags?.length),
      });
      stats.persistentArtworkHits += 1;
      cache.set(`sukebei:${sourceId}`, restored, positiveTtlMs);
      resolvedById.set(sourceId, restored);
    }
    if (metatubeStrict) {
      for (const [sourceId, item] of resolvedById) {
        if (!isMetaTubePoster(item?.poster)) resolvedById.delete(sourceId);
      }
    }
    // Stage 1: scan every selected unique JAV code through the primary provider.
    // A confirmed miss stays a miss, but a provider error falls through to the
    // secondary provider. This prevents a StashDB outage from suppressing every
    // TPDB exact-code match while keeping the scan bounded.
    const codeJobsByKey = new Map();
    for (const item of normalized) {
      if (resolvedById.has(String(item.sourceId))) continue;
      for (const code of extractSceneCodes(item.title)) {
        const key = normalizedSceneCode(code);
        if (!key) continue;
        let job = codeJobsByKey.get(key);
        if (!job) {
          if (codeJobsByKey.size >= codeLimit) break;
          job = { code, key, sources: [] };
          codeJobsByKey.set(key, job);
        }
        if (!job.sources.some(source => source.sourceId === item.sourceId)) job.sources.push(item);
      }
      if (codeJobsByKey.size >= codeLimit) continue;
    }
    const codeJobs = [...codeJobsByKey.values()];
    stats.codeStageJobs = codeJobs.length;
    const codeProviders = (metatubeStrict ? ['metatube'] : ['metatube', 'stashdb', 'tpdb'])
      .filter(provider => clients[provider]?.configured);
    const providerFailures = Object.fromEntries(codeProviders.map(provider => [provider, 0]));
    stats.codeStageProvider = codeProviders.join(',');

    if (codeProviders.length) {
      await Promise.all(codeJobs.map(job => runLimited(async () => {
        if (metatubeStrict && resolvedById.size >= needed) return;
        if (Date.now() >= metadataDeadlineAt) {
          stats.codeStageDeadlineSkipped += 1;
          stats.deadlineSkipped += 1;
          return;
        }
        let result = null;
        for (const provider of codeProviders) {
          if (provider !== 'metatube' && stats.providerCircuitOpen[provider]) {
            stats.providerCircuitOpen[provider] += 1;
            continue;
          }
          const remaining = Math.max(metadataDeadlineAt - Date.now(), 250);
          const lookupTimeoutMs = provider === 'metatube'
            ? Math.min(210_000, remaining)
            : Math.min(
                Math.max(Number(config.metadataLookupTimeoutMs || 2_500), 750),
                remaining,
                3_500
              );
          result = await queryExactCodeProvider(
            provider,
            clients[provider],
            job.sources[0],
            job.code,
            { stats, timeoutMs: lookupTimeoutMs }
          );
          if (!result.ok) {
            if (provider !== 'metatube') {
              providerFailures[provider] = (providerFailures[provider] || 0) + 1;
              if (providerFailures[provider] >= 3) stats.providerCircuitOpen[provider] = 1;
            }
            continue;
          }
          providerFailures[provider] = 0;
          if (result.candidate || provider !== 'metatube') break;
        }
        stats.codeStageCompleted += 1;
        if (result?.candidate) {
          let newMatches = 0;
          for (const source of job.sources) {
            const sourceId = String(source.sourceId);
            if (resolvedById.has(sourceId)) continue;
            const enriched = mergeCandidateForSource(source, result.candidate, stats, job.code);
            if (!enriched) continue;
            resolvedById.set(sourceId, enriched);
            newMatches += 1;
          }
          stats.codeStageMatches += newMatches;
          stats.matchedByCode += newMatches;
        }
        if (onProgress && (
          stats.codeStageCompleted === stats.codeStageJobs ||
          stats.codeStageCompleted % 5 === 0
        )) {
          onProgress(Object.freeze({
            stage: 'code',
            completed: stats.codeStageCompleted,
            total: stats.codeStageJobs,
            matches: stats.codeStageMatches,
            provider: codeProviders.join(','),
          }));
        }
      })));
    }

    // Stage 2: a very small title fallback only after the complete code scan.
    // Exact-code matches already stored above remain available even if this
    // optional stage reaches the deadline.
    const titleJobs = normalized
      .filter(item => !resolvedById.has(String(item.sourceId)))
      .filter(item => {
        const query = normalizeSearchTitle(item.title).query;
        return (query.match(/[A-Za-z]{3,}/g) || []).length >= 2;
      })
      .slice(0, titleLimit);
    stats.titleStageJobs = titleJobs.length;
    await Promise.all(titleJobs.map(item => runLimited(async () => {
      if (Date.now() >= metadataDeadlineAt) {
        stats.deadlineSkipped += 1;
        return;
      }
      const result = await metadataMatch(item, stats, {
        allowTitle: true,
        skipCodes: true,
        deadlineAt: metadataDeadlineAt,
      });
      stats.titleStageCompleted += 1;
      if (result?.poster && !resolvedById.has(String(item.sourceId))) {
        resolvedById.set(String(item.sourceId), result);
      }
    })));

    // Stage 3: native detail-page images use a reserved final window inside
    // the one end-to-end deadline, so fallback work cannot extend the request.
    const unresolvedDetails = normalized
      .filter(item => !resolvedById.has(String(item.sourceId)) && safeHttpsUrl(item.detailUrl));
    const detailJobs = [
      ...unresolvedDetails.filter(item => extractSceneCodes(item.title).length > 0),
      ...unresolvedDetails.filter(item => extractSceneCodes(item.title).length === 0),
    ].slice(0, detailLimit);
    const detailDeadlineAt = Math.min(deadlineAt, Date.now() + detailReserveMs);
    stats.detailStageJobs = detailJobs.length;
    await Promise.all(detailJobs.map(item => runDetailLimited(async () => {
      if (resolvedById.size >= detailTargetLimit) return;
      if (Date.now() >= detailDeadlineAt) {
        stats.deadlineSkipped += 1;
        return;
      }
      const result = await nativeDetailMatch(item, stats, { deadlineAt: detailDeadlineAt });
      stats.detailStageCompleted += 1;
      if (result?.poster && !resolvedById.has(String(item.sourceId))) {
        resolvedById.set(String(item.sourceId), result);
      }
    })));

    stats.lookupEligible = normalized.filter(item =>
      safeHttpsUrl(item.poster) ||
      extractSceneCodes(item.title).length > 0 ||
      safeHttpsUrl(item.detailUrl)
    ).length;
    stats.lookupSkipped = normalized.length - stats.lookupEligible;
    stats.unmatched = Math.max(normalized.length - resolvedById.size, 0);

    const allowed = [];
    for (const source of normalized) {
      const item = resolvedById.get(String(source.sourceId));
      if (!item) continue;
      const evaluation = evaluateContent(item, filterConfig);
      if (!evaluation.excluded) {
        if (!metatubeStrict || isMetaTubePoster(item.poster)) allowed.push(item);
        continue;
      }
      stats.filtered += 1;
      incrementCounter(stats.filterReasons, evaluation.reason);
    }

    if (metatubeStrict && strictMinimum > 0 && allowed.length < strictMinimum) {
      stats.returned = 0;
      stats.totalElapsedMs = Date.now() - requestStartedAt;
      stats.deadlineExceededMs = Math.max(Date.now() - deadlineAt, 0);
      lastDiagnostics = freezeDiagnostics(stats);
      if (!searchMode) recordSukebeiResult({ ready: false, cards: 0, metatubePosters: allowed.length, generatedPosters: 0 });
      return remember([]);
    }
    stats.persistentArtworkWrites += artworkStore.setMany(allowed);
    // Keep one Sukebei catalogue. Prefer verified scene artwork, then fill the
    // complete requested Stremio window with honest title-specific cards backed
    // by each real upstream torrent identity. Artwork failure must not discard
    // a valid playable info hash.
    if (catalogDefinition?.mode === 'top' && allowed.length < needed && !metatubeStrict) {
      const existing = new Set(allowed.map(item => String(item.sourceId)));
      for (const source of normalized) {
        if (allowed.length >= needed || existing.has(String(source.sourceId))) continue;
        const parsedMagnet = parseMagnet(source.magnetLink || source.magnet);
        const infoHash = normalizeInfoHash(source.infoHash || parsedMagnet?.infoHash);
        if (!infoHash) continue;
        const evaluation = evaluateContent(source, filterConfig);
        if (evaluation.excluded) {
          stats.filtered += 1;
          incrementCounter(stats.filterReasons, evaluation.reason);
          continue;
        }
        const fallback = Object.freeze({
          ...source,
          infoHash,
          poster: sukebeiRssPosterUrl(source, config),
          background: sukebeiRssPosterUrl(source, config),
          description: compactText(source.description || 'Sukebei RSS torrent · scene artwork pending'),
          lookupSource: 'sukebei-rss-fallback',
          contentClassificationKnown: Array.isArray(source.tags) && source.tags.length > 0,
        });
        allowed.push(fallback);
        existing.add(String(source.sourceId));
        stats.rssFallbackCards += 1;
      }
    }

    // Honor Stremio pagination over the combined, deduplicated upstream pool.
    const window = allowed.slice(safeSkip, safeSkip + safeLimit);
    stats.returned = window.length;
    if (!searchMode && metatubeStrict && safeSkip === 0) {
      const cards = window.length;
      const metatubePosters = window.filter(item => isMetaTubePoster(item.poster)).length;
      recordSukebeiResult({
        ready: cards >= strictMinimum && cards <= safeLimit && metatubePosters === cards && stats.rssFallbackCards === 0,
        cards,
        metatubePosters,
        generatedPosters: stats.rssFallbackCards,
      });
    }
    stats.totalElapsedMs = Date.now() - requestStartedAt;
    stats.deadlineExceededMs = Math.max(Date.now() - deadlineAt, 0);
    lastDiagnostics = freezeDiagnostics(stats);
    return remember(window);
  }

  async function meta({ sourceId }) {
    return index.get(String(sourceId || '')) || null;
  }

  async function resolve({ sourceId, item }) {
    const encodedDetailUrl = safeHttpsUrl(item?.detailUrl)
      ? String(item.detailUrl)
      : (safeHttpsUrl(sourceId) ? String(sourceId) : '');
    const encodedInfoHash = normalizeInfoHash(item?.infoHash);
    const encodedSource = encodedDetailUrl && encodedInfoHash
      ? Object.freeze({
        ...item,
        source: 'sukebei',
        sourceId: String(sourceId || encodedDetailUrl),
        detailUrl: encodedDetailUrl,
        infoHash: encodedInfoHash,
        title: compactText(item?.title || item?.filename),
        filename: compactText(item?.filename || item?.title),
        seeders: Math.max(Number.parseInt(String(item?.seeders ?? 0), 10) || 0, 0),
        size: item?.size,
      })
      : null;
    const source = index.get(String(sourceId || '')) || encodedSource;
    if (!source) return [];

    let magnet = parseMagnet(source.magnetLink);
    let infoHash = normalizeInfoHash(source.infoHash || magnet?.infoHash);
    let magnetLink = magnet ? source.magnetLink : '';
    let trackers = magnet?.trackers || source.trackers || [];
    let filename = magnet?.displayName || source.title;

    if (!infoHash && detailClient?.configured && safeHttpsUrl(source.detailUrl)) {
      let html = '';
      try {
        html = await detailClient.fetchText(source.detailUrl, {
          cacheKey: `sukebei:detail:${source.sourceId}`,
        });
      } catch {
        return [];
      }
      const detail = extractMagnetFromHtml(html);
      if (!detail?.infoHash) return [];
      infoHash = detail.infoHash;
      magnetLink = detail.magnetLink;
      trackers = detail.trackers;
      filename = detail.filename || filename;
    }
    if (!infoHash) return [];

    let selectedFile = null;
    const selectionKey = `sukebei:torrent-file:${infoHash}`;
    const cachedSelection = torrentSelectionCache.getEntry(selectionKey);
    if (cachedSelection && !cachedSelection.negative) {
      selectedFile = cachedSelection.value;
    } else if (!cachedSelection) {
      const torrentUrl = sukebeiTorrentUrl(source);
      if (torrentUrl) {
        let request;
        try {
          const parsedTorrentUrl = new URL(torrentUrl);
          request = await safeNativeRequest(torrentUrl, {
            fetchImpl: options.fetchImpl,
            checkDns: options.checkDns,
            timeoutMs: Math.min(Math.max(Number(config.requestTimeoutMs || 15_000), 1_000), 8_000),
            origin: parsedTorrentUrl.origin,
            allowedHosts: new Set([parsedTorrentUrl.hostname.toLowerCase()]),
            headers: {
              Accept: 'application/x-bittorrent, application/octet-stream;q=0.9',
              'User-Agent': 'OnlyPorn-TPB4K/2.7',
            },
          });
          const status = Number(request.response?.status || 0);
          const contentType = normalizeContentType(request.response?.headers?.get?.('content-type'));
          if (status >= 200 && status < 300 && (!contentType || [
            'application/x-bittorrent',
            'application/octet-stream',
          ].includes(contentType))) {
            const torrent = decodeTorrent(await readBoundedBuffer(
              request.response,
              SUKEBEI_MAX_TORRENT_BYTES
            ));
            if (normalizeInfoHash(torrent.infoHash) === infoHash) {
              selectedFile = selectSukebeiMainFile(torrent.files);
            }
          }
        } catch {
          selectedFile = null;
        } finally {
          request?.clearTimeout?.();
        }
      }
      if (selectedFile) torrentSelectionCache.set(selectionKey, selectedFile, positiveTtlMs);
      else torrentSelectionCache.setNegative(selectionKey, negativeTtlMs);
    }

    return [Object.freeze({
      source: 'sukebei',
      sourceId: source.sourceId,
      title: source.title,
      filename: selectedFile?.path || filename,
      magnet: magnetLink,
      infoHash,
      ...(selectedFile ? { fileIdx: selectedFile.index } : {}),
      trackers: Object.freeze([...(trackers || [])]),
      seeders: source.seeders,
      size: selectedFile?.length || source.size,
      resolution: detectResolution(selectedFile?.path || filename || source.title),
      detailUrl: source.detailUrl,
    })];
  }

  return Object.freeze({
    id: 'sukebei',
    configured: client.configured,
    catalog,
    meta,
    resolve,
    diagnostics() {
      return Object.freeze({ sukebeiMetadata: lastDiagnostics, sukebeiArtworkStore: artworkStore.diagnostics() });
    },
  });
}

module.exports = {
  CODE_PREFIX_EXCLUSIONS,
  classifyProviderError,
  codesMatch,
  createSukebeiMetadataAdapter,
  dedupeAndRank,
  detailPageImage,
  exactCodeEvidence,
  extractSceneCodes,
  landingPageImage,
  normalizedSceneCode,
  parseSukebeiTopHtml,
  queryExactCodeProvider,
  resolveVerifiedPosterUrl,
  scoreCandidate,
  selectSukebeiMainFile,
  sukebeiTorrentUrl,
  titleOverlap,
};
