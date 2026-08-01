'use strict';

const { buildSceneIdentity } = require('./identity');

const METADATA_FILL_CATALOGS = new Set([
  'tpb4k.tpdb.recent',
  'tpb4k.studio.digitalplayground.top',
  'tpb4k.studio.dorcelclub.top',
  'tpb4k.studio.onlyfans.top',
  'tpb4k.studio.xvideosred.top',
]);

function compact(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function itemIdentity(item = {}) {
  const scene = buildSceneIdentity(item);
  return compact(scene?.digest) || compact(item.sourceId) || compact(item.title).toLowerCase();
}

function fillCatalogWithMetadata(catalog = {}, playableItems = [], metadataItems = [], limit = 40) {
  const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 40, 1), 100);
  const playable = Array.isArray(playableItems) ? playableItems : [];
  if (!METADATA_FILL_CATALOGS.has(compact(catalog.id))) {
    return Object.freeze(playable.slice(0, normalizedLimit));
  }

  const output = [];
  const seen = new Set();
  for (const item of [...playable, ...(Array.isArray(metadataItems) ? metadataItems : [])]) {
    const identity = itemIdentity(item);
    if (!item || !identity || seen.has(identity)) continue;
    seen.add(identity);
    output.push(item);
    if (output.length >= normalizedLimit) break;
  }
  return Object.freeze(output);
}

module.exports = { METADATA_FILL_CATALOGS, fillCatalogWithMetadata };
