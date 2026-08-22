'use strict';

const zlib = require('node:zlib');

const PREFIX = 'onlyporn:tpb4k:';
const COMPRESSED_MARKER = 'z';
const LEGACY_VERSION = 1;
const TORRENT_VERSION = 2;
const BUNDLE_VERSION = 3;
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 220;
const MAX_CATALOG_ID_LENGTH = 160;
const MAX_SCENE_CODE_LENGTH = 80;
const MAX_BUNDLE_TORRENTS = 12;
const MAX_DECODED_PAYLOAD_BYTES = 64 * 1024;

function encodePayload(payload, compressed = false) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  if (!compressed) return bytes.toString('base64url');
  return `${COMPRESSED_MARKER}${zlib.deflateRawSync(bytes, { level: 9 }).toString('base64url')}`;
}

function decodePayload(value) {
  try {
    const text = String(value || '');
    const bytes = text.startsWith(COMPRESSED_MARKER)
      ? zlib.inflateRawSync(Buffer.from(text.slice(1), 'base64url'), { maxOutputLength: MAX_DECODED_PAYLOAD_BYTES })
      : Buffer.from(text, 'base64url');
    if (!bytes.length || bytes.length > MAX_DECODED_PAYLOAD_BYTES) return null;
    return JSON.parse(bytes.toString('utf8'));
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
    b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4,
  }[match[2].toLowerCase()];
  return Math.max(Math.round(Number(match[1]) * (1024 ** power)), 0);
}

function normalizeBoundTorrent(value = {}) {
  const infoHash = normalizeInfoHash(value.infoHash || value.hash);
  if (!infoHash) return null;
  const fileIdx = Number.isInteger(value.fileIdx) && value.fileIdx >= 0 ? value.fileIdx : null;
  return Object.freeze({
    infoHash,
    title: compactText(value.title || value.filename, MAX_TITLE_LENGTH),
    filename: compactText(value.filename || value.title, MAX_TITLE_LENGTH),
    resolution: compactText(value.resolution, 24),
    indexer: compactText(value.indexer || value.source, 32).toLowerCase(),
    seeders: Math.max(Number.parseInt(String(value.seeders ?? 0), 10) || 0, 0),
    size: normalizeSize(value.size),
    fileIdx,
  });
}

function normalizeBoundTorrents(values = []) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const item = normalizeBoundTorrent(value);
    if (!item) continue;
    const key = `${item.infoHash}:${item.fileIdx ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length >= MAX_BUNDLE_TORRENTS) break;
  }
  return Object.freeze(output);
}

function torrentToCompact(item) {
  const row = { h: item.infoHash };
  if (item.title) row.t = item.title;
  if (item.filename && item.filename !== item.title) row.f = item.filename;
  if (item.resolution) row.r = item.resolution;
  if (item.indexer) row.w = item.indexer;
  if (item.seeders) row.n = item.seeders;
  if (item.size) row.z = item.size;
  if (item.fileIdx !== null) row.x = item.fileIdx;
  return row;
}

function compactToTorrent(row = {}) {
  return normalizeBoundTorrent({
    infoHash: row.h,
    title: row.t,
    filename: row.f || row.t,
    resolution: row.r,
    indexer: row.w,
    seeders: row.n,
    size: row.z,
    fileIdx: row.x,
  });
}

function encodeTpb4kId({ source, sourceId, catalogId = '', sceneCode = '', torrent = null, torrents = null }) {
  const normalizedSource = String(source || '').trim().toLowerCase();
  const normalizedSourceId = String(sourceId || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedSource)) throw new Error('Invalid OnlyPorn source');
  if (!normalizedSourceId || normalizedSourceId.length > MAX_SOURCE_ID_LENGTH) throw new Error('Invalid OnlyPorn source item ID');

  const normalizedCatalogId = compactText(catalogId, MAX_CATALOG_ID_LENGTH);
  const normalizedSceneCode = compactText(sceneCode, MAX_SCENE_CODE_LENGTH);
  const bundle = normalizeBoundTorrents(Array.isArray(torrents) ? torrents : (torrent ? [torrent] : []));
  const payload = {
    v: bundle.length > 1 ? BUNDLE_VERSION : (bundle.length === 1 ? TORRENT_VERSION : LEGACY_VERSION),
    s: normalizedSource,
    i: normalizedSourceId,
    c: normalizedCatalogId,
  };
  if (normalizedSceneCode) payload.k = normalizedSceneCode;
  if (payload.v === TORRENT_VERSION) Object.assign(payload, torrentToCompact(bundle[0]));
  if (payload.v === BUNDLE_VERSION) payload.b = bundle.map(torrentToCompact);
  return `${PREFIX}${encodePayload(payload, payload.v === BUNDLE_VERSION)}`;
}

function decodeTpb4kId(value) {
  const text = String(value || '');
  if (!text.startsWith(PREFIX)) return null;
  const payload = decodePayload(text.slice(PREFIX.length));
  if (!payload || ![LEGACY_VERSION, TORRENT_VERSION, BUNDLE_VERSION].includes(payload.v)) return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(payload.s || ''))) return null;
  if (!payload.i || String(payload.i).length > MAX_SOURCE_ID_LENGTH) return null;
  if (String(payload.c || '').length > MAX_CATALOG_ID_LENGTH) return null;

  let bundle = [];
  if (payload.v === TORRENT_VERSION) bundle = normalizeBoundTorrents([compactToTorrent(payload)]);
  if (payload.v === BUNDLE_VERSION) bundle = normalizeBoundTorrents((Array.isArray(payload.b) ? payload.b : []).map(compactToTorrent));
  if (payload.v !== LEGACY_VERSION && !bundle.length) return null;

  return Object.freeze({
    version: payload.v,
    source: String(payload.s),
    sourceId: String(payload.i),
    catalogId: String(payload.c || ''),
    ...(compactText(payload.k, MAX_SCENE_CODE_LENGTH)
      ? { sceneCode: compactText(payload.k, MAX_SCENE_CODE_LENGTH) }
      : {}),
    ...(bundle.length ? { torrents: bundle, torrent: bundle[0] } : {}),
  });
}

module.exports = {
  BUNDLE_VERSION,
  LEGACY_VERSION,
  MAX_BUNDLE_TORRENTS,
  PREFIX,
  TORRENT_VERSION,
  decodeTpb4kId,
  encodeTpb4kId,
  normalizeBoundTorrent,
  normalizeBoundTorrents,
};
