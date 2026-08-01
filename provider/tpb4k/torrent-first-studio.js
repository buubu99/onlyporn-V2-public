'use strict';

const { indexerReliability, resolutionHeight } = require('./candidate');
const { normalizedAliasKeys, studioAliases } = require('./studio-aliases');
const { studioReleasePosterUrl } = require('./studio-release-poster');
const MAX_CANDIDATES_PER_SCENE = 12;
function validInfoHash(value) { const text = compact(value).toLowerCase(); return /^[a-f0-9]{40}$/.test(text) ? text : ''; }
function validPoster(value) {
  try {
    const url = new URL(compact(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (host === 'imagetwist.com' || host.endsWith('.imagetwist.com')
      || host === 'imgtwist.com' || host.endsWith('.imgtwist.com')) return false;
    return true;
  } catch { return false; }
}

const RELEASE_NOISE = new Set([
  '2160p', '1080p', '720p', '480p', '4k', '8k', 'uhd', 'hdr', 'hdr10', 'dv',
  'hevc', 'h265', 'h264', 'x265', 'x264', 'av1', 'aac', 'ac3', 'ddp', 'dts',
  'web', 'webrip', 'webdl', 'bluray', 'bdrip', 'dvdrip', 'remux', 'proper',
  'repack', 'internal', 'uncensored', 'xxx', 'porn', 'video', 'videos', 'com',
  'mp4', 'mkv', 'wmv', 'avi', 'torrent', 'pack', 'complete', 'collection',
]);
const WEAK_MINIMUMS = Object.freeze({ onlyfans: 40, digitalplayground: 20, xvideosred: 20, sexmex: 12 });

function compact(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
function compactKey(value) { return compact(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function studioKey(catalog = {}) { return compactKey(catalog.studio); }
function minimumCards(catalog = {}) { return WEAK_MINIMUMS[studioKey(catalog)] || 0; }
function shouldUseTorrentFirst(catalog = {}, currentCount = 0) {
  const required = minimumCards(catalog);
  return required > 0 && Number(currentCount || 0) < required;
}
function cleanReleaseTitle(value, studio = '') {
  let text = compact(value)
    .replace(/\[[^\]]{0,80}\]/g, ' ')
    .replace(/\([^)]{0,80}\)/g, ' ')
    .replace(/\b(?:19|20)\d{2}[._-]\d{2}[._-]\d{2}\b/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb|tb)\b/gi, ' ');
  for (const alias of studioAliases(studio)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]*');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'ig'), ' ');
  }
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length >= 2 && !RELEASE_NOISE.has(token) && !/^\d{1,4}$/.test(token));
  return Object.freeze([...new Set(tokens)].slice(0, 16));
}
function sceneCode(value) {
  const text = compact(value).toUpperCase();
  const fc2 = text.match(/\bFC2[\s._-]*(?:PPV[\s._-]*)?(\d{5,9})\b/);
  if (fc2) return `fc2ppv${Number(fc2[1])}`;
  const generic = text.match(/\b([A-Z]{2,14})[\s._-]+(\d{2,8})\b/);
  if (!generic) return '';
  const prefix = generic[1];
  if (/^(?:H26[45]|X26[45]|HEVC|AVC|AAC|WEB|HDR|UHD)$/.test(prefix)) return '';
  return `${prefix.toLowerCase()}${Number(generic[2])}`;
}
function creatorKey(item = {}, catalog = {}) {
  const direct = compactKey(item.creator || item.username || item.channel || item.account || item.model || item.performer || item.performers?.[0] || '');
  if (direct.length >= 4) return direct;
  if (studioKey(catalog) !== 'onlyfans') return '';
  const rawTitle = compact(item.title || item.filename);
  const bracketNames = [...rawTitle.matchAll(/\[([^\]]{3,80})\]/g)]
    .map(match => compact(match[1]))
    .filter(value => !/^(?:only\s*fans|4k|1080p|2160p|xxx|porn)$/i.test(value));
  for (const value of bracketNames) {
    const key = compactKey(value);
    if (key.length >= 4) return key;
  }
  const title = rawTitle.replace(/\[[^\]]+\]/g, ' ').replace(/\b(?:19|20)\d{2}[._-]\d{2}[._-]\d{2}\b/g, ' ');
  const parts = title.split(/only[\s._-]*fans/i);
  const before = compact(parts[0]);
  const after = compact(parts.slice(1).join(' '));
  const pick = value => value.split(/[^\p{L}\p{N}_]+/u)
    .filter(token => token.length >= 3 && !RELEASE_NOISE.has(token.toLowerCase()) && !/^\d+$/.test(token))
    .slice(0, 3)
    .join('');
  const beforeTokens = before.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  const candidate = beforeTokens.length ? beforeTokens.slice(-3).join('') : pick(after);
  return compactKey(candidate || pick(rawTitle));
}
function sceneIdentity(item = {}, catalog = {}) {
  const code = sceneCode(`${item.sceneCode || ''} ${item.title || ''} ${item.filename || ''}`);
  if (code) return `code:${code}`;
  const creator = creatorKey(item, catalog);
  const tokens = cleanReleaseTitle(item.title || item.filename, catalog.studio);
  const titleKey = tokens.slice(0, 10).join('');
  if (creator && titleKey) return `creator:${creator}:${titleKey}`;
  if (titleKey.length >= 10) return `title:${titleKey}`;
  return `hash:${validInfoHash(item.infoHash)}`;
}
function candidate(item = {}) {
  const infoHash = validInfoHash(item.infoHash);
  if (!infoHash) return null;
  return Object.freeze({
    infoHash,
    title: compact(item.title || item.filename),
    filename: compact(item.filename || item.title),
    resolution: compact(item.resolution || item.quality),
    indexer: compact(item.indexer || item.source || 'torrent-index').toLowerCase(),
    seeders: Math.max(Number.parseInt(String(item.seeders ?? 0), 10) || 0, 0),
    size: item.size ?? 0,
    fileIdx: Number.isInteger(item.fileIdx) && item.fileIdx >= 0 ? item.fileIdx : null,
    playbackBinding: 'torrent-first-release-identity',
    playbackScore: 0,
    playbackSourceId: compact(item.sourceId),
  });
}
function rankCandidate(value) {
  return resolutionHeight(value.resolution, '', value.title, value.filename) * 1_000_000_000
    + Math.min(value.seeders, 99_999) * 1_000
    + indexerReliability(value.indexer) * 10;
}
function sortBundle(values = []) {
  return [...values].sort((left, right) => rankCandidate(right) - rankCandidate(left)
    || right.seeders - left.seeders || left.infoHash.localeCompare(right.infoHash));
}
function bundleHashes(item = {}) {
  const rows = Array.isArray(item.playbackCandidates) && item.playbackCandidates.length
    ? item.playbackCandidates : (item.infoHash ? [item] : []);
  return rows.map(row => validInfoHash(row.infoHash)).filter(Boolean);
}
function bindCard(base, values) {
  const candidates = Object.freeze(sortBundle(values).slice(0, MAX_CANDIDATES_PER_SCENE));
  const primary = candidates[0];
  return Object.freeze({
    ...base,
    source: base.source || 'torrent-index',
    infoHash: primary.infoHash,
    filename: primary.filename || base.title,
    resolution: primary.resolution || base.resolution,
    indexer: primary.indexer,
    seeders: primary.seeders,
    size: primary.size,
    fileIdx: primary.fileIdx,
    playbackBinding: primary.playbackBinding,
    playbackSourceId: primary.playbackSourceId,
    lookupSource: 'torrent-first-studio',
    playbackCandidates: candidates,
  });
}
function metadataPosterValid(item = {}) { return Boolean(item && typeof item === 'object') && validPoster(item.poster) && !/fallback|placeholder|default/i.test(String(item.lookupSource || '')); }
function externalPosterValid(item = {}) {
  if (!metadataPosterValid(item)) return false;
  try {
    const url = new URL(compact(item.poster));
    const host = url.hostname.toLowerCase();
    if (host === 'imagetwist.com' || host.endsWith('.imagetwist.com')
      || host === 'imgtwist.com' || host.endsWith('.imgtwist.com')) return false;
    return !/\/onlyporn\/poster\/studio-release\//i.test(url.pathname)
      && !/\/assets\/tpb4k\/studios\//i.test(url.pathname);
  }
  catch { return false; }
}
function posterQuality(item = {}) {
  if (externalPosterValid(item)) return 2;
  return validPoster(item.poster) ? 1 : 0;
}
function tokenSet(value, studio = '') {
  return new Set(cleanReleaseTitle(value, studio).filter(token => token.length >= 3));
}
function dateKey(item = {}) {
  const explicit = compact(item.releaseDate).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const text = compact(`${item.title || ''} ${item.filename || ''}`);
  const full = text.match(/\b((?:19|20)\d{2})[._ -](\d{2})[._ -](\d{2})\b/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const short = text.match(/\b(\d{2})[._ -](\d{2})[._ -](\d{2})\b/);
  if (short) return `20${short[1]}-${short[2]}-${short[3]}`;
  return '';
}
function creatorAliases(item = {}, catalog = {}) {
  const values = [
    item.creator, item.username, item.channel, item.account, item.model, item.performer,
    ...(Array.isArray(item.performers) ? item.performers : []),
  ];
  const aliases = new Set(values.map(compactKey).filter(value => value.length >= 4));
  if (studioKey(catalog) === 'onlyfans') {
    const raw = compact(item.title || item.filename)
      .replace(/\b(?:19|20)?\d{2}[._ -]\d{2}[._ -]\d{2}\b/g, ' ')
      .replace(/\b(?:2160p|1080p|720p|4k|8k|xxx|porn|pack|collection)\b/gi, ' ');
    const after = compact(raw.split(/only[\s._-]*fans/i).slice(1).join(' '));
    const before = compact(raw.split(/only[\s._-]*fans/i)[0]);
    for (const segment of [after, before]) {
      const tokens = segment.split(/[^\p{L}\p{N}_]+/u)
        .filter(token => token.length >= 3 && !RELEASE_NOISE.has(token.toLowerCase()) && !/^\d+$/.test(token));
      for (const token of tokens.slice(0, 4)) {
        const key = compactKey(token);
        if (key.length >= 4) aliases.add(key);
      }
      if (tokens.length >= 2) aliases.add(compactKey(tokens.slice(0, 2).join('')));
    }
  }
  return aliases;
}
function overlapEvidence(left = new Set(), right = new Set()) {
  const common = [...left].filter(token => right.has(token));
  const distinctive = common.filter(token => token.length >= 5);
  const coverage = left.size ? common.length / left.size : 0;
  return { common, distinctive, coverage };
}
function metadataPosterMatch(item = {}, catalog = {}, metadataItems = []) {
  const itemCode = sceneCode(`${item.sceneCode || ''} ${item.title || ''} ${item.filename || ''}`);
  const itemCreators = creatorAliases(item, catalog);
  const itemTokens = tokenSet(item.title || item.filename, catalog.studio);
  const itemDate = dateKey(item);
  const itemCompactTitle = compactKey(cleanReleaseTitle(item.title || item.filename, catalog.studio).join(' '));
  const ranked = [];
  for (const meta of Array.isArray(metadataItems) ? metadataItems : []) {
    if (!externalPosterValid(meta)) continue;
    const metaCode = sceneCode(`${meta.sceneCode || ''} ${meta.title || ''}`);
    const metaCreators = creatorAliases(meta, catalog);
    const metaTokens = tokenSet(`${meta.title || ''} ${(meta.performers || []).join(' ')}`, catalog.studio);
    const metaDate = dateKey(meta);
    const metaCompactTitle = compactKey(cleanReleaseTitle(meta.title, catalog.studio).join(' '));
    const evidence = overlapEvidence(itemTokens, metaTokens);
    const creatorExact = [...itemCreators].some(value => metaCreators.has(value));
    const codeExact = Boolean(itemCode && metaCode && itemCode === metaCode);
    const dateExact = Boolean(itemDate && metaDate && itemDate === metaDate);
    const containment = Boolean(itemCompactTitle.length >= 8 && metaCompactTitle.length >= 8
      && (itemCompactTitle.includes(metaCompactTitle) || metaCompactTitle.includes(itemCompactTitle)));
    const platform = studioKey(catalog) === 'onlyfans';
    const score = (codeExact ? 3000 : 0)
      + (creatorExact ? (platform ? 1200 : 500) : 0)
      + (dateExact ? 350 : 0)
      + (containment ? 800 : 0)
      + evidence.common.length * 90
      + evidence.distinctive.length * 45
      + Math.round(evidence.coverage * 220);
    const eligible = codeExact
      || (platform && creatorExact && (evidence.common.length >= 1 || dateExact || containment))
      || (dateExact && evidence.distinctive.length >= 1)
      || (containment && evidence.common.length >= 1)
      || (evidence.distinctive.length >= 2 && evidence.coverage >= 0.4)
      || (evidence.common.length >= 3 && evidence.coverage >= 0.5);
    if (eligible) ranked.push({ score, strong: codeExact || creatorExact || dateExact || containment, meta });
  }
  ranked.sort((left, right) => right.score - left.score);
  if (!ranked.length) return null;
  if (ranked[0].strong) return ranked[0].meta;
  if (ranked[1] && ranked[0].score - ranked[1].score < 90) return null;
  return ranked[0].meta;
}
function studioEvidence(item = {}, catalog = {}) {
  const aliases = normalizedAliasKeys(catalog.studio);
  const haystack = compactKey(`${item.studio || ''} ${item.title || ''} ${item.filename || ''} ${item.lookupQuery || ''}`);
  if (aliases.some(alias => haystack.includes(alias))) return true;
  return compact(item.lookupSource).includes('torrent') || compact(item.metadataProvider).length > 0;
}
function baseCard(item, catalog, options = {}) {
  const matchedMetadata = metadataPosterMatch(item, catalog, options.metadataItems);
  const verifiedPoster = externalPosterValid(item)
    ? compact(item.poster)
    : (externalPosterValid(matchedMetadata) ? compact(matchedMetadata.poster) : '');
  if (!verifiedPoster && options.requireRealPoster) return null;
  const poster = verifiedPoster || studioReleasePosterUrl(item, catalog, options.config || {}, options.env || process.env);
  const background = verifiedPoster
    ? compact(matchedMetadata?.background || matchedMetadata?.poster || verifiedPoster)
    : poster;
  return Object.freeze({
    ...item,
    source: 'torrent-index',
    sourceId: compact(item.sourceId) || `torrent-first:${validInfoHash(item.infoHash)}`,
    title: compact(item.title || item.filename),
    studio: compact(catalog.studio || item.studio),
    poster,
    background,
    description: compact(item.description || matchedMetadata?.description || `OnlyPorn ${catalog.studio} torrent release`),
    performers: Array.isArray(item.performers) && item.performers.length
      ? item.performers : (Array.isArray(matchedMetadata?.performers) ? matchedMetadata.performers : []),
    tags: Array.isArray(item.tags) && item.tags.length
      ? item.tags : (Array.isArray(matchedMetadata?.tags) ? matchedMetadata.tags : []),
    releaseDate: compact(item.releaseDate || matchedMetadata?.releaseDate),
    sceneCode: compact(item.sceneCode || matchedMetadata?.sceneCode),
    metadataProvider: compact(item.metadataProvider || matchedMetadata?.metadataProvider),
    upstreamId: compact(item.upstreamId || matchedMetadata?.upstreamId),
    detailUrl: compact(item.detailUrl || matchedMetadata?.detailUrl),
  });
}

function mergeTorrentFirstStudio(options = {}) {
  const catalog = options.catalog || {};
  const limit = Math.min(Math.max(Number.parseInt(String(options.limit || 40), 10) || 40, 1), 100);
  const existing = Array.isArray(options.existingItems) ? options.existingItems : [];
  const discovered = Array.isArray(options.torrentItems) ? options.torrentItems : [];
  const metadataItems = Array.isArray(options.metadataItems) ? options.metadataItems : [];
  const groups = new Map();
  const order = [];
  const usedHashes = new Set();

  for (const item of existing) {
    const key = sceneIdentity(item, catalog);
    const values = (Array.isArray(item.playbackCandidates) ? item.playbackCandidates : [item]).map(candidate).filter(Boolean);
    for (const hash of values.map(value => value.infoHash)) usedHashes.add(hash);
    groups.set(key, { base: item, values, existing: true });
    order.push(key);
  }

  let rejectedPoster = 0;
  let rejectedGenericPoster = 0;
  let rejectedIdentity = 0;
  let acceptedTorrents = 0;
  for (const item of discovered) {
    const value = candidate(item);
    if (!value || usedHashes.has(value.infoHash)) continue;
    if (!metadataPosterValid(item)) rejectedPoster += 1;
    if (!studioEvidence(item, catalog)) { rejectedIdentity += 1; continue; }
    const key = sceneIdentity(item, catalog);
    if (!key || key.endsWith(':')) continue;
    let group = groups.get(key);
    const discoveredBase = baseCard(item, catalog, { ...options, metadataItems });
    if (!discoveredBase) {
      rejectedGenericPoster += 1;
      continue;
    }
    if (!group) {
      group = { base: discoveredBase, values: [], existing: false };
      groups.set(key, group);
      order.push(key);
    } else if (!group.existing && posterQuality(discoveredBase) > posterQuality(group.base)) {
      group.base = Object.freeze({
        ...group.base,
        poster: discoveredBase.poster,
        background: discoveredBase.background,
        description: discoveredBase.description || group.base.description,
        performers: discoveredBase.performers?.length ? discoveredBase.performers : group.base.performers,
        tags: discoveredBase.tags?.length ? discoveredBase.tags : group.base.tags,
        metadataProvider: discoveredBase.metadataProvider || group.base.metadataProvider,
      });
    }
    if (!group.values.some(row => row.infoHash === value.infoHash)) {
      group.values.push(value);
      usedHashes.add(value.infoHash);
      acceptedTorrents += 1;
    }
  }

  const cards = order.map(key => {
    const group = groups.get(key);
    return group?.values?.length ? bindCard(group.base, group.values) : null;
  }).filter(Boolean);
  const existingCards = cards.filter((_, index) => index < existing.length);
  const newCards = cards.slice(existing.length).sort((left, right) => {
    const leftBundle = Array.isArray(left.playbackCandidates) ? left.playbackCandidates : [];
    const rightBundle = Array.isArray(right.playbackCandidates) ? right.playbackCandidates : [];
    return posterQuality(right) - posterQuality(left)
      || rightBundle.length - leftBundle.length
      || Number(right.seeders || 0) - Number(left.seeders || 0);
  });
  const selected = [...existingCards, ...newCards].slice(0, limit);
  const candidateCount = selected.reduce((sum, item) => sum + (item.playbackCandidates?.length || 0), 0);
  return Object.freeze({
    items: Object.freeze(selected),
    stats: Object.freeze({
      catalogId: compact(catalog.id),
      studio: compact(catalog.studio),
      minimumCards: minimumCards(catalog),
      existingCards: existing.length,
      discoveredRecords: discovered.length,
      acceptedTorrents,
      rejectedPoster,
      rejectedGenericPoster,
      rejectedIdentity,
      returnedCards: selected.length,
      returnedCandidates: candidateCount,
      multiCandidateScenes: selected.filter(item => item.playbackCandidates?.length > 1).length,
      oneHashOneScene: true,
      maxCandidatesPerScene: MAX_CANDIDATES_PER_SCENE,
    }),
  });
}

module.exports = {
  WEAK_MINIMUMS,
  cleanReleaseTitle,
  creatorKey,
  externalPosterValid,
  mergeTorrentFirstStudio,
  metadataPosterMatch,
  minimumCards,
  sceneIdentity,
  shouldUseTorrentFirst,
};
