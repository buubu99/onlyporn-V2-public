'use strict';

const REQUIRED_METHODS = Object.freeze(['catalog', 'meta', 'resolve']);

function assertSourceAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('OnlyPorn source adapter is required');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(adapter.id || ''))) {
    throw new TypeError('OnlyPorn source adapter requires a stable lowercase ID');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') throw new TypeError(`OnlyPorn source adapter ${adapter.id} is missing ${method}()`);
  }
  return adapter;
}

function normalizeHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(text) ? text : '';
}

function normalizePlaybackCandidate(value = {}) {
  const infoHash = normalizeHash(value.infoHash);
  if (!infoHash) return null;
  return Object.freeze({
    infoHash,
    title: String(value.title || value.filename || '').replace(/\s+/g, ' ').trim(),
    filename: String(value.filename || value.title || '').replace(/\s+/g, ' ').trim(),
    resolution: String(value.resolution || '').trim(),
    indexer: String(value.indexer || value.source || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    seeders: Math.max(Number.parseInt(String(value.seeders ?? 0), 10) || 0, 0),
    size: value.size ?? 0,
    fileIdx: Number.isInteger(value.fileIdx) && value.fileIdx >= 0 ? value.fileIdx : null,
    playbackBinding: String(value.playbackBinding || '').trim(),
    playbackScore: Number(value.playbackScore || 0),
    playbackSourceId: String(value.playbackSourceId || value.sourceId || '').trim(),
  });
}

function normalizeDiscoveryItem(adapter, item = {}) {
  const sourceId = String(item.sourceId || item.id || '').trim();
  const title = String(item.title || item.name || '').replace(/\s+/g, ' ').trim();
  if (!sourceId || !title) return null;
  const infoHash = normalizeHash(item.infoHash);
  const playbackCandidates = [];
  const seen = new Set();
  for (const value of Array.isArray(item.playbackCandidates) ? item.playbackCandidates : []) {
    const candidate = normalizePlaybackCandidate(value);
    const candidateKey = candidate ? `${candidate.infoHash}:${candidate.fileIdx ?? ''}` : '';
    if (!candidate || seen.has(candidateKey)) continue;
    seen.add(candidateKey);
    playbackCandidates.push(candidate);
  }
  if (infoHash && !playbackCandidates.some(value => value.infoHash === infoHash)) {
    playbackCandidates.unshift(normalizePlaybackCandidate(item));
  }

  return Object.freeze({
    source: adapter.id,
    sourceId,
    title,
    poster: String(item.poster || '').trim(),
    background: String(item.background || item.poster || '').trim(),
    description: String(item.description || '').trim(),
    studio: String(item.studio || '').trim(),
    performers: Array.isArray(item.performers) ? item.performers.map(String) : [],
    tags: Array.isArray(item.tags)
      ? item.tags.map(value => String(value?.name || value || '').trim()).filter(Boolean)
      : [],
    contentTags: Array.isArray(item.contentTags)
      ? item.contentTags.map(value => String(value?.name || value || '').trim()).filter(Boolean)
      : [],
    contentClassificationKnown: Boolean(item.contentClassificationKnown),
    releaseDate: String(item.releaseDate || '').trim(),
    sceneCode: String(item.sceneCode || '').trim(),
    resolution: String(item.resolution || '').trim(),
    quality: String(item.quality || '').trim(),
    seeders: Number.parseInt(String(item.seeders ?? 0), 10) || 0,
    size: item.size ?? 0,
    infoHash,
    filename: String(item.filename || item.title || item.name || '').replace(/\s+/g, ' ').trim(),
    indexer: String(item.indexer || '').replace(/\s+/g, ' ').trim().toLowerCase(),
    fileIdx: Number.isInteger(item.fileIdx) && item.fileIdx >= 0 ? item.fileIdx : null,
    playbackCandidates: Object.freeze(playbackCandidates.filter(Boolean)),
    duration: Number.parseInt(String(item.duration ?? 0), 10) || 0,
    episode: Number.parseInt(String(item.episode ?? 0), 10) || 0,
    seriesSlug: String(item.seriesSlug || '').trim(),
    videos: Array.isArray(item.videos) ? item.videos.map(video => Object.freeze({ ...video })) : [],
    sceneIdentity: String(item.sceneIdentity || '').trim(),
    provenance: Object.freeze({
      catalogId: String(item.catalogId || '').trim(),
      detailUrl: String(item.detailUrl || '').trim(),
      metadataProvider: String(item.metadataProvider || '').trim(),
      upstreamId: String(item.upstreamId || '').trim(),
      lookupSource: String(item.lookupSource || '').trim(),
      lookupQuery: String(item.lookupQuery || '').trim(),
    }),
  });
}

module.exports = {
  REQUIRED_METHODS,
  assertSourceAdapter,
  normalizeDiscoveryItem,
  normalizePlaybackCandidate,
};
