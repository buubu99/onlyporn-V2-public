'use strict';

const { buildSceneIdentity, normalizeDate, normalizeToken } = require('./identity');
const { extractTitleDate, normalizeSearchTitle, significantTokens } = require('./poster-enrichment');
const { normalizedAliasKeys } = require('./studio-aliases');
const { indexerReliability, resolutionHeight } = require('./candidate');

const MAX_CANDIDATES_PER_SCENE = 12;
const PLATFORM_NOISE = new Set(['onlyfans', 'only', 'fans', 'fansly', 'fanvue', 'premium', 'exclusive', 'official']);

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function compactKey(value) {
  return compactText(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
function validPoster(value) {
  try {
    const parsed = new URL(compactText(value));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch { return false; }
}
function metadataProvider(value) { return compactText(value).split(':', 1)[0].toLowerCase(); }
function validMetadataIdentity(item = {}) { return ['tpdb', 'stashdb'].includes(metadataProvider(item.sourceId)); }
function validInfoHash(value) {
  const normalized = compactText(value).toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}
function normalizedDate(value) { return normalizeDate(value) || ''; }
function releaseYear(value) {
  return normalizedDate(value).slice(0, 4) || compactText(value).match(/\b(20\d{2})\b/)?.[1] || '';
}
function performerKeys(values = []) {
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const key = compactKey(normalizeToken(value));
    if (key.length >= 4 && !output.includes(key)) output.push(key);
  }
  return output;
}
function platformTokens(title, studio) {
  return significantTokens(title, studio).filter(token => !PLATFORM_NOISE.has(String(token).toLowerCase()));
}
function itemFeatures(item = {}, studio = '') {
  const title = compactText(item.title || item.name);
  const identity = buildSceneIdentity({ ...item, title, studio: item.studio || studio });
  const parsedDate = extractTitleDate(title, item.studio || studio);
  const date = normalizedDate(item.releaseDate || item.date) || parsedDate.releaseDate;
  const isPlatform = compactKey(studio || item.studio) === 'onlyfans';
  const tokens = isPlatform ? platformTokens(title, studio) : significantTokens(title, item.studio || studio);
  const normalizedTitle = normalizeSearchTitle(title, item.studio || studio).query;
  return Object.freeze({
    title,
    compactTitle: compactKey(normalizedTitle),
    titleTokens: Object.freeze(tokens),
    tokenSet: new Set(tokens),
    date,
    year: releaseYear(date || parsedDate.releaseYear || item.releaseDate || item.date),
    sceneCode: compactKey(identity.sceneCode),
    performers: Object.freeze(performerKeys([
      ...(Array.isArray(item.performers) ? item.performers : []),
      item.creator,
      item.username,
      item.channel,
      item.account,
      item.model,
      item.performer,
    ])),
    studioKeys: normalizedAliasKeys(studio || item.studio),
    isPlatform,
  });
}
function tokenEvidence(metadata, torrent) {
  if (!metadata.titleTokens.length || !torrent.tokenSet.size) return { overlap: 0, coverage: 0, precision: 0 };
  const overlap = metadata.titleTokens.filter(token => torrent.tokenSet.has(token)).length;
  return { overlap, coverage: overlap / metadata.titleTokens.length, precision: overlap / torrent.tokenSet.size };
}
function performerEvidence(metadata, torrent) {
  return metadata.performers.filter(key => torrent.compactTitle.includes(key)).length;
}
function studioEvidence(metadata, torrent) {
  const haystack = compactKey(`${torrent.title} ${torrent.compactTitle}`);
  return metadata.studioKeys.some(key => key && haystack.includes(key));
}
function targetedEvidence(metadataSourceId, torrentItem) {
  return Boolean(torrentItem?.targetSourceId && compactText(torrentItem.targetSourceId) === compactText(metadataSourceId));
}

function scorePlatformPair(metadata, torrent, targeted) {
  const evidence = tokenEvidence(metadata, torrent.features);
  const performers = performerEvidence(metadata, torrent.features);
  const exactDate = Boolean(metadata.date && metadata.date === torrent.features.date);
  const exactTitle = Boolean(metadata.compactTitle && metadata.compactTitle === torrent.features.compactTitle);
  const containment = Boolean(
    metadata.compactTitle.length >= 10 && torrent.features.compactTitle.length >= 10
    && (metadata.compactTitle.includes(torrent.features.compactTitle) || torrent.features.compactTitle.includes(metadata.compactTitle))
  );
  let score = evidence.overlap * 100 + Math.round(evidence.coverage * 700) + Math.round(evidence.precision * 250);
  if (performers) score += Math.min(performers, 3) * 500;
  if (exactDate) score += 220;
  if (exactTitle) score += 1500;
  if (containment) score += 700;
  if (targeted) score += 250;
  score += Math.min(torrent.seeders, 500);

  if (exactTitle && (performers > 0 || evidence.overlap >= 2 || targeted)) {
    return Object.freeze({ accepted: true, score, reason: 'platform-exact-title' });
  }
  if (performers > 0 && evidence.overlap >= 2 && evidence.coverage >= 0.45) {
    return Object.freeze({ accepted: true, score, reason: 'platform-creator-title' });
  }
  if (targeted && evidence.overlap >= 3 && evidence.coverage >= 0.6) {
    return Object.freeze({ accepted: true, score, reason: 'platform-targeted-title' });
  }
  if (containment && evidence.overlap >= 2 && (performers > 0 || exactDate)) {
    return Object.freeze({ accepted: true, score, reason: 'platform-title-containment' });
  }
  return Object.freeze({ accepted: false, score, reason: 'platform-insufficient-evidence' });
}

function scorePair(metadata, torrent, metadataSourceId = '') {
  if (!torrent.infoHash) return Object.freeze({ accepted: false, score: 0, reason: 'invalid-hash' });
  const targeted = targetedEvidence(metadataSourceId, torrent.item);
  if (metadata.isPlatform) return scorePlatformPair(metadata, torrent, targeted);

  const hasStudio = studioEvidence(metadata, torrent.features);
  if (metadata.sceneCode && torrent.features.sceneCode) {
    if (metadata.sceneCode === torrent.features.sceneCode) {
      return Object.freeze({ accepted: true, score: 2600 + torrent.seeders + (targeted ? 200 : 0), reason: 'exact-scene-code' });
    }
    return Object.freeze({ accepted: false, score: 0, reason: 'scene-code-conflict' });
  }
  const exactTitle = Boolean(metadata.compactTitle && metadata.compactTitle === torrent.features.compactTitle);
  const distinctiveExactTitle = metadata.compactTitle.length >= 10 && metadata.titleTokens.length >= 2;
  if (exactTitle && (hasStudio || targeted || distinctiveExactTitle)) {
    return Object.freeze({ accepted: true, score: 2300 + torrent.seeders + (targeted ? 200 : 0), reason: 'exact-title' });
  }

  const evidence = tokenEvidence(metadata, torrent.features);
  const performerMatches = performerEvidence(metadata, torrent.features);
  const exactDate = Boolean(metadata.date && metadata.date === torrent.features.date);
  const sameYear = Boolean(metadata.year && metadata.year === torrent.features.year);
  const titleContainment = Boolean(
    metadata.compactTitle.length >= 10 && torrent.features.compactTitle.length >= 10
    && (metadata.compactTitle.includes(torrent.features.compactTitle) || torrent.features.compactTitle.includes(metadata.compactTitle))
  );
  let score = Math.round(evidence.coverage * 650 + evidence.precision * 220 + evidence.overlap * 60);
  if (titleContainment) score += 800;
  if (hasStudio) score += 450;
  if (targeted) score += 220;
  if (exactDate) score += 260;
  else if (sameYear) score += 70;
  if (performerMatches) score += Math.min(performerMatches, 3) * 160;
  score += Math.min(torrent.seeders, 500);

  const studioOrTargeted = hasStudio || targeted;
  if (titleContainment && studioOrTargeted && (evidence.overlap >= 1 || exactDate || sameYear)) {
    return Object.freeze({ accepted: true, score, reason: targeted ? 'targeted-title-containment' : 'studio-title-containment' });
  }
  if (studioOrTargeted && evidence.overlap >= 3 && evidence.coverage >= 0.6 && evidence.precision >= 0.2) {
    return Object.freeze({ accepted: true, score, reason: targeted ? 'targeted-strong-title-overlap' : 'studio-strong-title-overlap' });
  }
  if (studioOrTargeted && exactDate && evidence.overlap >= 2 && (evidence.coverage >= 0.5 || performerMatches > 0)) {
    return Object.freeze({ accepted: true, score, reason: targeted ? 'targeted-date-title' : 'studio-date-title' });
  }
  if (studioOrTargeted && evidence.overlap === 1 && metadata.titleTokens.length === 1 && metadata.titleTokens[0].length >= 8 && (exactDate || performerMatches > 0)) {
    return Object.freeze({ accepted: true, score, reason: targeted ? 'targeted-distinctive-token' : 'studio-distinctive-token' });
  }
  return Object.freeze({ accepted: false, score, reason: 'insufficient-evidence' });
}

function candidateFromTorrent(torrent, reason, score) {
  return Object.freeze({
    infoHash: torrent.infoHash,
    title: compactText(torrent.item.title || torrent.item.filename),
    filename: compactText(torrent.item.filename || torrent.item.title),
    resolution: compactText(torrent.item.resolution),
    indexer: compactText(torrent.item.indexer || torrent.item.source || 'torrent-index').toLowerCase(),
    seeders: Math.max(Number.parseInt(String(torrent.item.seeders ?? 0), 10) || 0, 0),
    size: torrent.item.size ?? 0,
    fileIdx: Number.isInteger(torrent.item.fileIdx) && torrent.item.fileIdx >= 0 ? torrent.item.fileIdx : null,
    playbackBinding: reason,
    playbackScore: score,
    playbackSourceId: compactText(torrent.item.sourceId),
  });
}
function bindTorrentBundle(metadataItem, candidates) {
  const primary = candidates[0];
  return Object.freeze({
    ...metadataItem,
    infoHash: primary.infoHash,
    filename: primary.filename || metadataItem.title,
    resolution: primary.resolution || metadataItem.resolution,
    indexer: primary.indexer,
    seeders: primary.seeders,
    size: primary.size,
    fileIdx: primary.fileIdx,
    lookupSource: 'torrent-index',
    playbackBinding: primary.playbackBinding,
    playbackSourceId: primary.playbackSourceId,
    playbackCandidates: Object.freeze(candidates),
  });
}

function bindStudioPlayback(options = {}) {
  const studio = compactText(options.catalog?.studio);
  const skip = Math.max(Number.parseInt(String(options.skip || 0), 10) || 0, 0);
  const limit = Math.min(Math.max(Number.parseInt(String(options.limit || 40), 10) || 40, 1), 100);
  const maxCandidates = Math.min(Math.max(Number.parseInt(String(options.maxCandidatesPerScene || MAX_CANDIDATES_PER_SCENE), 10) || MAX_CANDIDATES_PER_SCENE, 1), MAX_CANDIDATES_PER_SCENE);
  const metadataItems = (Array.isArray(options.metadataItems) ? options.metadataItems : []).filter(item =>
    item && validMetadataIdentity(item) && compactText(item.title) && validPoster(item.poster));
  const torrents = (Array.isArray(options.torrentItems) ? options.torrentItems : []).map(item => ({
    item,
    infoHash: validInfoHash(item?.infoHash),
    seeders: Math.max(Number.parseInt(String(item?.seeders ?? 0), 10) || 0, 0),
    resolutionHeight: resolutionHeight(item?.resolution, item?.quality, item?.title, item?.filename),
    reliability: indexerReliability(item?.indexer || item?.source),
    features: itemFeatures(item, studio),
  })).filter(item => item.infoHash);
  const metadata = metadataItems.map((item, index) => ({ index, item, features: itemFeatures(item, studio) }));

  const bestOwnerByHash = new Map();
  for (const metadataEntry of metadata) {
    for (let torrentIndex = 0; torrentIndex < torrents.length; torrentIndex += 1) {
      const torrent = torrents[torrentIndex];
      const result = scorePair(metadataEntry.features, torrent, metadataEntry.item.sourceId);
      if (!result.accepted) continue;
      const pair = {
        metadataIndex: metadataEntry.index,
        torrentIndex,
        score: result.score,
        reason: result.reason,
        seeders: torrent.seeders,
        resolutionHeight: torrent.resolutionHeight,
        reliability: torrent.reliability,
      };
      const previous = bestOwnerByHash.get(torrent.infoHash);
      if (!previous ||
          pair.score > previous.score ||
          (pair.score === previous.score && pair.resolutionHeight > previous.resolutionHeight) ||
          (pair.score === previous.score && pair.resolutionHeight === previous.resolutionHeight && pair.seeders > previous.seeders) ||
          (pair.score === previous.score && pair.resolutionHeight === previous.resolutionHeight && pair.seeders === previous.seeders && pair.reliability > previous.reliability)) {
        bestOwnerByHash.set(torrent.infoHash, pair);
      }
    }
  }

  const byMetadata = new Map();
  for (const pair of bestOwnerByHash.values()) {
    const rows = byMetadata.get(pair.metadataIndex) || [];
    rows.push(pair);
    byMetadata.set(pair.metadataIndex, rows);
  }
  const reasonCounts = {};
  const bound = [];
  let boundCandidates = 0;
  let multiCandidateScenes = 0;
  for (const metadataEntry of metadata) {
    const pairs = (byMetadata.get(metadataEntry.index) || [])
      .sort((left, right) => right.score - left.score || right.resolutionHeight - left.resolutionHeight || right.seeders - left.seeders || right.reliability - left.reliability || left.torrentIndex - right.torrentIndex)
      .slice(0, maxCandidates);
    if (!pairs.length) continue;
    const candidates = pairs.map(pair => {
      reasonCounts[pair.reason] = (reasonCounts[pair.reason] || 0) + 1;
      return candidateFromTorrent(torrents[pair.torrentIndex], pair.reason, pair.score);
    });
    boundCandidates += candidates.length;
    if (candidates.length > 1) multiCandidateScenes += 1;
    bound.push(bindTorrentBundle(metadataEntry.item, candidates));
  }

  const selected = bound.slice(skip, skip + limit);
  const selectedCandidates = selected.reduce((sum, item) => sum + item.playbackCandidates.length, 0);
  return Object.freeze({
    items: Object.freeze(selected),
    stats: Object.freeze({
      catalogId: compactText(options.catalog?.id),
      studio,
      metadataRecords: metadataItems.length,
      torrentRecords: Array.isArray(options.torrentItems) ? options.torrentItems.length : 0,
      validTorrentRecords: torrents.length,
      matched: bound.length,
      matchedScenes: bound.length,
      boundCandidates,
      multiCandidateScenes,
      averageCandidates: bound.length ? Number((boundCandidates / bound.length).toFixed(2)) : 0,
      unmatchedMetadata: Math.max(metadataItems.length - bound.length, 0),
      unusedTorrents: Math.max(torrents.length - bestOwnerByHash.size, 0),
      skip,
      limit,
      returned: selected.length,
      returnedCandidates: selectedCandidates,
      reasons: Object.freeze({ ...reasonCounts }),
      rejectedDateOnly: true,
      oneHashOneScene: true,
      maxCandidatesPerScene: maxCandidates,
    }),
  });
}

module.exports = {
  MAX_CANDIDATES_PER_SCENE,
  bindStudioPlayback,
  compactKey,
  itemFeatures,
  scorePair,
  validInfoHash,
  validMetadataIdentity,
  validPoster,
};
