'use strict';

const REQUIRED_METHODS = Object.freeze(['catalog', 'meta', 'resolve']);

function assertSourceAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('TPB4K source adapter is required');
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(adapter.id || ''))) {
    throw new TypeError('TPB4K source adapter requires a stable lowercase ID');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`TPB4K source adapter ${adapter.id} is missing ${method}()`);
    }
  }
  return adapter;
}

function normalizeDiscoveryItem(adapter, item = {}) {
  const sourceId = String(item.sourceId || item.id || '').trim();
  const title = String(item.title || item.name || '').replace(/\s+/g, ' ').trim();
  if (!sourceId || !title) return null;

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
    duration: Number.parseInt(String(item.duration ?? 0), 10) || 0,
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
};
