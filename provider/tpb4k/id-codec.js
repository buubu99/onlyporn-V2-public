'use strict';

const PREFIX = 'onlyporn:tpb4k:';
const LEGACY_VERSION = 1;
const TORRENT_VERSION = 2;
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 240;
const MAX_CATALOG_ID_LENGTH = 160;

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function normalizeInfoHash(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(text) ? text : '';
}

function compactText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeSize(value) {
  if (Number.isFinite(Number(value))) return Math.max(Math.floor(Number(value)), 0);
  const match = String(value || '').trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|KIB|MB|MIB|GB|GIB|TB|TIB)$/i);
  if (!match) return 0;
  const power = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
  }[match[2].toLowerCase()];
  return Math.max(Math.round(Number(match[1]) * (1024 ** power)), 0);
}

function normalizeBoundTorrent(value = {}) {
  const infoHash = normalizeInfoHash(value.infoHash || value.hash);
  if (!infoHash) return null;
  const fileIdx = Number.isInteger(value.fileIdx) && value.fileIdx >= 0 ? value.fileIdx : null;
  const seeders = Math.max(Number.parseInt(String(value.seeders ?? 0), 10) || 0, 0);
  const size = normalizeSize(value.size);
  return Object.freeze({
    infoHash,
    title: compactText(value.title || value.filename, MAX_TITLE_LENGTH),
    filename: compactText(value.filename || value.title, MAX_TITLE_LENGTH),
    resolution: compactText(value.resolution, 24),
    indexer: compactText(value.indexer || value.source, 32).toLowerCase(),
    seeders,
    size,
    fileIdx,
  });
}

function encodeTpb4kId({ source, sourceId, catalogId = '', torrent = null }) {
  const normalizedSource = String(source || '').trim().toLowerCase();
  const normalizedSourceId = String(sourceId || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedSource)) {
    throw new Error('Invalid TPB4K source');
  }
  if (!normalizedSourceId || normalizedSourceId.length > MAX_SOURCE_ID_LENGTH) {
    throw new Error('Invalid TPB4K source item ID');
  }
  const normalizedCatalogId = compactText(catalogId, MAX_CATALOG_ID_LENGTH);
  const boundTorrent = normalizeBoundTorrent(torrent || {});

  const payload = {
    v: boundTorrent ? TORRENT_VERSION : LEGACY_VERSION,
    s: normalizedSource,
    i: normalizedSourceId,
    c: normalizedCatalogId,
  };
  if (boundTorrent) {
    payload.h = boundTorrent.infoHash;
    if (boundTorrent.title) payload.t = boundTorrent.title;
    if (boundTorrent.filename && boundTorrent.filename !== boundTorrent.title) {
      payload.f = boundTorrent.filename;
    }
    if (boundTorrent.resolution) payload.r = boundTorrent.resolution;
    if (boundTorrent.indexer) payload.w = boundTorrent.indexer;
    if (boundTorrent.seeders) payload.n = boundTorrent.seeders;
    if (boundTorrent.size) payload.z = boundTorrent.size;
    if (boundTorrent.fileIdx !== null) payload.x = boundTorrent.fileIdx;
  }

  return `${PREFIX}${encodePayload(payload)}`;
}

function decodeTpb4kId(value) {
  const text = String(value || '');
  if (!text.startsWith(PREFIX)) return null;
  const payload = decodePayload(text.slice(PREFIX.length));
  if (!payload || ![LEGACY_VERSION, TORRENT_VERSION].includes(payload.v)) return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(payload.s || ''))) return null;
  if (!payload.i || String(payload.i).length > MAX_SOURCE_ID_LENGTH) return null;
  if (String(payload.c || '').length > MAX_CATALOG_ID_LENGTH) return null;
  const boundTorrent = payload.v === TORRENT_VERSION
    ? normalizeBoundTorrent({
      infoHash: payload.h,
      title: payload.t,
      filename: payload.f || payload.t,
      resolution: payload.r,
      indexer: payload.w,
      seeders: payload.n,
      size: payload.z,
      fileIdx: payload.x,
    })
    : null;
  if (payload.v === TORRENT_VERSION && !boundTorrent) return null;
  return Object.freeze({
    version: payload.v,
    source: String(payload.s),
    sourceId: String(payload.i),
    catalogId: String(payload.c || ''),
    ...(boundTorrent ? { torrent: boundTorrent } : {}),
  });
}

module.exports = {
  LEGACY_VERSION,
  PREFIX,
  TORRENT_VERSION,
  decodeTpb4kId,
  encodeTpb4kId,
  normalizeBoundTorrent,
};
