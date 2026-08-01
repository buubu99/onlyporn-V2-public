'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodeTpb4kId } = require('./id-codec');

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;

function clean(value) { return String(value || '').trim(); }
function truthy(value) { return /^(?:1|true|yes|on)$/i.test(clean(value)); }
function validValue(value) {
  return Boolean(value && typeof value === 'object' && Array.isArray(value.metas) && value.metas.length);
}
function defaultCacheDirectory(env = process.env) {
  return path.resolve(clean(env.ONLYPORN_CACHE_DIR) || path.join(process.cwd(), '.onlyporn-cache'));
}
function normalizeRecord(value, now, ttlMs) {
  if (!value || typeof value !== 'object') return null;
  const key = clean(value.key).slice(0, 500);
  const savedAt = Math.max(Number(value.savedAt || 0), 0);
  if (!key || !savedAt || now - savedAt > ttlMs || !validValue(value.value)) return null;
  return Object.freeze({ key, savedAt, value: Object.freeze({ metas: Object.freeze([...value.value.metas]) }) });
}

function sameIdentity(metaId, identity = {}) {
  const decoded = decodeTpb4kId(metaId);
  if (!decoded || clean(decoded.catalogId) !== clean(identity.catalogId)) return false;
  if (clean(decoded.source) === clean(identity.source)
    && clean(decoded.sourceId) === clean(identity.sourceId)) return true;
  const expectedHashes = new Set((Array.isArray(identity.torrents) ? identity.torrents : [])
    .map(torrent => clean(torrent?.infoHash).toLowerCase())
    .filter(hash => /^[a-f0-9]{40}$/.test(hash)));
  return (Array.isArray(decoded.torrents) ? decoded.torrents : [])
    .some(torrent => expectedHashes.has(clean(torrent?.infoHash).toLowerCase()));
}

function createCatalogResponseStore(options = {}) {
  const env = options.env || process.env;
  const explicitFilePath = Boolean(clean(options.filePath));
  const disabled = truthy(process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE)
    || truthy(env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  const enabled = options.enabled !== false && (!disabled || explicitFilePath);
  const filePath = enabled
    ? path.resolve(clean(options.filePath) || path.join(defaultCacheDirectory(env), 'catalog-responses-v1.json'))
    : '';
  const ttlMs = Math.max(Number(options.ttlMs || DEFAULT_TTL_MS), 60_000);
  const maxEntries = Math.min(Math.max(Number(options.maxEntries || DEFAULT_MAX_ENTRIES), 8), 256);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let loaded = false;
  let records = new Map();

  function load() {
    if (loaded) return;
    loaded = true;
    if (!enabled || !filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Number(parsed?.version) !== STORE_VERSION || !Array.isArray(parsed?.records)) return;
      const current = now();
      for (const row of parsed.records) {
        const record = normalizeRecord(row, current, ttlMs);
        if (record) records.set(record.key, record);
      }
      records = new Map([...records.entries()]
        .sort((left, right) => right[1].savedAt - left[1].savedAt)
        .slice(0, maxEntries));
    } catch { records = new Map(); }
  }

  function persist() {
    if (!enabled || !filePath) return false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = `${JSON.stringify({
        version: STORE_VERSION,
        records: [...records.values()].sort((a, b) => b.savedAt - a.savedAt),
      })}\n`;
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, filePath);
      return true;
    } catch { return false; }
  }

  return Object.freeze({
    enabled,
    filePath,
    get(key) {
      load();
      const normalizedKey = clean(key).slice(0, 500);
      const record = records.get(normalizedKey);
      if (!record) return null;
      if (now() - record.savedAt > ttlMs) {
        records.delete(normalizedKey);
        persist();
        return null;
      }
      return record;
    },
    findMeta(id) {
      load();
      const normalizedId = clean(id);
      if (!normalizedId) return null;
      const current = now();
      for (const [key, record] of records) {
        if (current - record.savedAt > ttlMs) {
          records.delete(key);
          continue;
        }
        const meta = record.value.metas.find(item => clean(item?.id) === normalizedId);
        if (meta) return meta;
      }
      return null;
    },
    findMetaByIdentity(identity) {
      load();
      if (!clean(identity?.catalogId)) return null;
      const hasSourceIdentity = clean(identity?.source) && clean(identity?.sourceId);
      const hasTorrentIdentity = Array.isArray(identity?.torrents) && identity.torrents.length > 0;
      if (!hasSourceIdentity && !hasTorrentIdentity) return null;
      const current = now();
      for (const [key, record] of records) {
        if (current - record.savedAt > ttlMs) {
          records.delete(key);
          continue;
        }
        const meta = record.value.metas.find(item => sameIdentity(item?.id, identity));
        if (meta) return meta;
      }
      return null;
    },
    set(key, value) {
      load();
      const normalizedKey = clean(key).slice(0, 500);
      if (!normalizedKey || !validValue(value)) return false;
      const record = normalizeRecord({ key: normalizedKey, savedAt: now(), value }, now(), ttlMs);
      if (!record) return false;
      records.set(normalizedKey, record);
      records = new Map([...records.entries()]
        .sort((left, right) => right[1].savedAt - left[1].savedAt)
        .slice(0, maxEntries));
      return persist();
    },
    size() { load(); return records.size; },
  });
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  STORE_VERSION,
  createCatalogResponseStore,
};
