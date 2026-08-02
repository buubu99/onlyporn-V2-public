'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 512;
const sharedStores = new Map();

function clean(value) {
  return String(value || '').trim();
}

function truthy(value) {
  return /^(?:1|true|yes|on)$/i.test(clean(value));
}

function validValue(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray(value.metas)
    && value.metas.length
  );
}

function defaultCacheDirectory(env = process.env) {
  return path.resolve(
    clean(env.ONLYPORN_CACHE_DIR)
    || path.join(process.cwd(), '.onlyporn-cache')
  );
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const key = clean(value.key).slice(0, 700);
  const savedAt = Math.max(Number(value.savedAt || 0), 0);
  if (!key || !savedAt || !validValue(value.value)) return null;

  return Object.freeze({
    key,
    savedAt,
    value: Object.freeze({
      metas: Object.freeze([...value.value.metas]),
    }),
  });
}

function createLegacyCatalogStore(options = {}) {
  const env = options.env || process.env;
  const explicitFilePath = Boolean(clean(options.filePath));
  const disabled = truthy(process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE)
    || truthy(env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  const enabled = options.enabled !== false && (!disabled || explicitFilePath);
  const filePath = enabled
    ? path.resolve(
      clean(options.filePath)
      || path.join(defaultCacheDirectory(env), 'legacy-catalog-lkg-v1.json')
    )
    : '';
  const maxEntries = Math.min(
    Math.max(Number(options.maxEntries || DEFAULT_MAX_ENTRIES), 16),
    2048
  );
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let loaded = false;
  let records = new Map();

  function load() {
    if (loaded) return;
    loaded = true;
    if (!enabled || !filePath) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (
        Number(parsed?.version) !== STORE_VERSION
        || !Array.isArray(parsed?.records)
      ) {
        return;
      }

      for (const row of parsed.records) {
        const record = normalizeRecord(row);
        if (record) records.set(record.key, record);
      }

      records = new Map(
        [...records.entries()]
          .sort((left, right) => right[1].savedAt - left[1].savedAt)
          .slice(0, maxEntries)
      );
    } catch {
      records = new Map();
    }
  }

  function persist() {
    if (!enabled || !filePath) return false;

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = `${JSON.stringify({
        version: STORE_VERSION,
        records: [...records.values()]
          .sort((left, right) => right.savedAt - left.savedAt),
      })}\n`;
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, payload, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporary, filePath);
      return true;
    } catch {
      return false;
    }
  }

  return Object.freeze({
    enabled,
    filePath,
    get(key) {
      load();
      return records.get(clean(key).slice(0, 700)) || null;
    },
    set(key, value) {
      load();
      const normalizedKey = clean(key).slice(0, 700);
      if (!normalizedKey || !validValue(value)) return false;

      const record = normalizeRecord({
        key: normalizedKey,
        savedAt: now(),
        value,
      });
      if (!record) return false;

      records.set(normalizedKey, record);
      records = new Map(
        [...records.entries()]
          .sort((left, right) => right[1].savedAt - left[1].savedAt)
          .slice(0, maxEntries)
      );
      return persist();
    },
    size() {
      load();
      return records.size;
    },
  });
}

function getSharedLegacyCatalogStore(options = {}) {
  const env = options.env || process.env;
  const requestedPath = clean(options.filePath)
    || path.join(defaultCacheDirectory(env), 'legacy-catalog-lkg-v1.json');
  const disabled = truthy(process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE)
    || truthy(env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  const key = disabled && !clean(options.filePath)
    ? 'disabled-memory'
    : path.resolve(requestedPath);

  if (!sharedStores.has(key)) {
    sharedStores.set(key, createLegacyCatalogStore(options));
  }
  return sharedStores.get(key);
}

function legacyCatalogKey(providerName, args = {}) {
  const extra = args.extra || {};
  const identity = {
    provider: clean(providerName).toLowerCase(),
    type: clean(args.type).toLowerCase(),
    id: clean(args.id),
    skip: Math.max(Number.parseInt(String(extra.skip || 0), 10) || 0, 0),
    search: clean(extra.search).slice(0, 180),
    genre: clean(extra.genre).slice(0, 180),
  };
  return `legacy-v1:${Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url')}`;
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  STORE_VERSION,
  createLegacyCatalogStore,
  getSharedLegacyCatalogStore,
  legacyCatalogKey,
};
