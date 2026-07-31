'use strict';

const { buildSceneIdentity, normalizeDate, normalizeToken } = require('./identity');
const {
  extractTitleDate,
  normalizeSearchTitle,
  significantTokens,
} = require('./poster-enrichment');

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
  } catch {
    return false;
  }
}

function metadataProvider(value) {
  return compactText(value).split(':', 1)[0].toLowerCase();
}

function validMetadataIdentity(item = {}) {
  return ['tpdb', 'stashdb'].includes(metadataProvider(item.sourceId));
}

function validInfoHash(value) {
  const normalized = compactText(value).toLowerCase();
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}

function normalizedDate(value) {
  return normalizeDate(value) || '';
}

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

function itemFeatures(item = {}, studio = '') {
  const title = compactText(item.title || item.name);
  const identity = buildSceneIdentity({ ...item, title, studio: item.studio || studio });
  const parsedDate = extractTitleDate(title, item.studio || studio);
  const date = normalizedDate(item.releaseDate || item.date) || parsedDate.releaseDate;
  const tokens = significantTokens(title, item.studio || studio);
  const normalizedTitle = normalizeSearchTitle(title, item.studio || studio).query;
  return Object.freeze({
    title,
    compactTitle: compactKey(normalizedTitle),
    titleTokens: Object.freeze(tokens),
    tokenSet: new Set(tokens),
    date,
    year: releaseYear(date || parsedDate.releaseYear || item.releaseDate || item.date),
    sceneCode: compactKey(identity.sceneCode),
    performers: Object.freeze(performerKeys(item.performers)),
  });
}

function countBy(values, keyOf) {
  const counts = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function tokenEvidence(metadata, torrent) {
  const expected = metadata.titleTokens;
  const actual = torrent.tokenSet;
  if (!expected.length || !actual.size) {
    return Object.freeze({ overlap: 0, coverage: 0, precision: 0 });
  }
  const overlap = expected.filter(token => actual.has(token)).length;
  return Object.freeze({
    overlap,
    coverage: overlap / expected.length,
    precision: overlap / actual.size,
  });
}

function performerEvidence(metadata, torrent) {
  if (!metadata.performers.length) return 0;
  const haystack = torrent.compactTitle;
  return metadata.performers.filter(key => haystack.includes(key)).length;
}

function scorePair(metadata, torrent, context) {
  if (!torrent.infoHash) return Object.freeze({ accepted: false, score: 0, reason: 'invalid-hash' });
  if (metadata.sceneCode && torrent.features.sceneCode) {
    if (metadata.sceneCode === torrent.features.sceneCode) {
      return Object.freeze({ accepted: true, score: 2000 + torrent.seeders, reason: 'exact-scene-code' });
    }
    return Object.freeze({ accepted: false, score: 0, reason: 'scene-code-conflict' });
  }

  const exactTitle = Boolean(
    metadata.compactTitle &&
    torrent.features.compactTitle &&
    metadata.compactTitle === torrent.features.compactTitle
  );
  if (exactTitle) {
    return Object.freeze({ accepted: true, score: 1700 + torrent.seeders, reason: 'exact-title' });
  }

  const titleContainment = Boolean(
    metadata.compactTitle.length >= 10 &&
    torrent.features.compactTitle.length >= 10 &&
    (metadata.compactTitle.includes(torrent.features.compactTitle) ||
      torrent.features.compactTitle.includes(metadata.compactTitle))
  );
  const evidence = tokenEvidence(metadata, torrent.features);
  const performerMatches = performerEvidence(metadata, torrent.features);
  const exactDate = Boolean(metadata.date && metadata.date === torrent.features.date);
  const sameYear = Boolean(metadata.year && metadata.year === torrent.features.year);
  const uniqueDate = Boolean(
    exactDate &&
    context.metadataDateCounts.get(metadata.date) === 1 &&
    context.torrentDateCounts.get(metadata.date) === 1
  );

  let score = Math.round(evidence.coverage * 500 + evidence.precision * 180 + evidence.overlap * 35);
  if (titleContainment) score += 700;
  if (exactDate) score += 500;
  else if (sameYear) score += 80;
  if (uniqueDate) score += 350;
  if (performerMatches) score += performerMatches * 220;
  score += Math.min(torrent.seeders, 500);

  if (titleContainment && (evidence.overlap >= 1 || exactDate || sameYear)) {
    return Object.freeze({ accepted: true, score, reason: 'title-containment' });
  }
  if (uniqueDate) {
    return Object.freeze({ accepted: true, score, reason: 'unique-release-date' });
  }
  if (exactDate && (performerMatches > 0 || evidence.overlap >= 1)) {
    return Object.freeze({
      accepted: true,
      score,
      reason: performerMatches ? 'date-and-performer' : uniqueDate ? 'unique-date-and-title' : 'date-and-title',
    });
  }
  if (
    evidence.overlap >= 2 &&
    evidence.coverage >= 0.66 &&
    (evidence.precision >= 0.25 || sameYear || performerMatches > 0)
  ) {
    return Object.freeze({ accepted: true, score, reason: 'strong-title-overlap' });
  }
  if (
    evidence.overlap === 1 &&
    metadata.titleTokens.length === 1 &&
    metadata.titleTokens[0].length >= 7 &&
    (exactDate || performerMatches > 0)
  ) {
    return Object.freeze({ accepted: true, score, reason: 'distinctive-title-token' });
  }

  return Object.freeze({ accepted: false, score, reason: 'insufficient-evidence' });
}

function bindTorrent(metadataItem, torrent, reason) {
  return Object.freeze({
    ...metadataItem,
    infoHash: torrent.infoHash,
    filename: compactText(torrent.item.filename || torrent.item.title || metadataItem.title),
    resolution: compactText(torrent.item.resolution || metadataItem.resolution),
    indexer: compactText(torrent.item.indexer || torrent.item.source || 'torrent-index').toLowerCase(),
    seeders: Math.max(Number.parseInt(String(torrent.item.seeders ?? 0), 10) || 0, 0),
    size: torrent.item.size ?? 0,
    fileIdx: Number.isInteger(torrent.item.fileIdx) && torrent.item.fileIdx >= 0
      ? torrent.item.fileIdx
      : null,
    lookupSource: 'torrent-index',
    playbackBinding: reason,
    playbackSourceId: compactText(torrent.item.sourceId),
  });
}

function bindStudioPlayback(options = {}) {
  const studio = compactText(options.catalog?.studio);
  const skip = Math.max(Number.parseInt(String(options.skip || 0), 10) || 0, 0);
  const limit = Math.min(Math.max(Number.parseInt(String(options.limit || 40), 10) || 40, 1), 100);
  const metadataItems = (Array.isArray(options.metadataItems) ? options.metadataItems : [])
    .filter(item => (
      item &&
      validMetadataIdentity(item) &&
      compactText(item.title) &&
      validPoster(item.poster)
    ));
  const torrents = (Array.isArray(options.torrentItems) ? options.torrentItems : [])
    .map(item => ({
      item,
      infoHash: validInfoHash(item?.infoHash),
      seeders: Math.max(Number.parseInt(String(item?.seeders ?? 0), 10) || 0, 0),
      features: itemFeatures(item, studio),
    }))
    .filter(item => item.infoHash);
  const metadata = metadataItems.map((item, index) => ({
    index,
    item,
    features: itemFeatures(item, studio),
  }));
  const context = Object.freeze({
    metadataDateCounts: countBy(metadata, value => value.features.date),
    torrentDateCounts: countBy(torrents, value => value.features.date),
  });
  const pairs = [];
  for (const metadataEntry of metadata) {
    for (let torrentIndex = 0; torrentIndex < torrents.length; torrentIndex += 1) {
      const torrent = torrents[torrentIndex];
      const result = scorePair(metadataEntry.features, torrent, context);
      if (!result.accepted) continue;
      pairs.push(Object.freeze({
        metadataIndex: metadataEntry.index,
        torrentIndex,
        score: result.score,
        reason: result.reason,
        seeders: torrent.seeders,
      }));
    }
  }
  pairs.sort((left, right) =>
    right.score - left.score ||
    right.seeders - left.seeders ||
    left.metadataIndex - right.metadataIndex ||
    left.torrentIndex - right.torrentIndex
  );

  const metadataMatches = new Map();
  const usedHashes = new Set();
  const reasonCounts = {};
  for (const pair of pairs) {
    const torrent = torrents[pair.torrentIndex];
    if (metadataMatches.has(pair.metadataIndex) || usedHashes.has(torrent.infoHash)) continue;
    metadataMatches.set(pair.metadataIndex, pair);
    usedHashes.add(torrent.infoHash);
    reasonCounts[pair.reason] = (reasonCounts[pair.reason] || 0) + 1;
  }

  const bound = [];
  for (const metadataEntry of metadata) {
    const pair = metadataMatches.get(metadataEntry.index);
    if (!pair) continue;
    bound.push(bindTorrent(metadataEntry.item, torrents[pair.torrentIndex], pair.reason));
  }
  const selected = bound.slice(skip, skip + limit);
  const stats = Object.freeze({
    catalogId: compactText(options.catalog?.id),
    studio,
    metadataRecords: metadataItems.length,
    torrentRecords: Array.isArray(options.torrentItems) ? options.torrentItems.length : 0,
    validTorrentRecords: torrents.length,
    matched: bound.length,
    unmatchedMetadata: Math.max(metadataItems.length - bound.length, 0),
    unusedTorrents: Math.max(torrents.length - usedHashes.size, 0),
    skip,
    limit,
    returned: selected.length,
    reasons: Object.freeze({ ...reasonCounts }),
  });
  return Object.freeze({ items: Object.freeze(selected), stats });
}

module.exports = {
  bindStudioPlayback,
  compactKey,
  itemFeatures,
  scorePair,
  validInfoHash,
  validMetadataIdentity,
  validPoster,
};
