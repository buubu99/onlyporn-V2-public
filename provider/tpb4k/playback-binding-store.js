'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeBoundTorrents } = require('./id-codec');

const STORE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 4096;
const sharedStores = new Map();

function clean(value) {
  return String(value || '').trim();
}

function truthy(value) {
  return /^(?:1|true|yes|on)$/i.test(clean(value));
}

function defaultCacheDirectory(env = process.env) {
  return path.resolve(
    clean(env.ONLYPORN_CACHE_DIR)
    || path.join(process.cwd(), '.onlyporn-cache')
  );
}

function playbackBindingKey(identity = {}) {
  const catalogId = clean(identity.catalogId).slice(0, 160);
  const source = clean(identity.source).toLowerCase().slice(0, 32);
  const sourceId = clean(identity.sourceId).slice(0, 512);
  if (!catalogId || !source || !sourceId) return '';

  return `playback-v1:${Buffer.from(
    JSON.stringify({ catalogId, source, sourceId }),
    'utf8'
  ).toString('base64url')}`;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const key = clean(value.key).slice(0, 1200);
  const savedAt = Math.max(Number(value.savedAt || 0), 0);
  const candidates = normalizeBoundTorrents(value.candidates);
  if (!key || !savedAt || !candidates.length) return null;

  return Object.freeze({
    key,
    savedAt,
    candidates,
  });
}

function createPlaybackBindingStore(options = {}) {
  const env = options.env || process.env;
  const explicitFilePath = Boolean(clean(options.filePath));
  const disabled = truthy(process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE)
    || truthy(env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  const enabled = options.enabled !== false && (!disabled || explicitFilePath);
  const filePath = enabled
    ? path.resolve(
      clean(options.filePath)
      || path.join(defaultCacheDirectory(env), 'playback-bindings-v1.json')
    )
    : '';
  const maxEntries = Math.min(
    Math.max(Number(options.maxEntries || DEFAULT_MAX_ENTRIES), 32),
    12000
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
    get(identity) {
      load();
      const key = playbackBindingKey(identity);
      const record = key ? records.get(key) : null;
      return record ? record.candidates : Object.freeze([]);
    },
    set(identity, candidates) {
      load();
      const key = playbackBindingKey(identity);
      const normalized = normalizeBoundTorrents(candidates);
      if (!key || !normalized.length) return false;

      const record = normalizeRecord({
        key,
        savedAt: now(),
        candidates: normalized,
      });
      if (!record) return false;

      records.set(key, record);
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

function getSharedPlaybackBindingStore(options = {}) {
  const env = options.env || process.env;
  const requestedPath = clean(options.filePath)
    || path.join(defaultCacheDirectory(env), 'playback-bindings-v1.json');
  const disabled = truthy(process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE)
    || truthy(env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  const key = disabled && !clean(options.filePath)
    ? 'disabled-memory'
    : path.resolve(requestedPath);

  if (!sharedStores.has(key)) {
    sharedStores.set(key, createPlaybackBindingStore(options));
  }
  return sharedStores.get(key);
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  STORE_VERSION,
  createPlaybackBindingStore,
  getSharedPlaybackBindingStore,
  playbackBindingKey,
};
