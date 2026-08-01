'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 3;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1_000;

function clean(value) { return String(value || '').trim(); }
function truthy(value) { return /^(?:1|true|yes|on)$/i.test(clean(value)); }
function safeHttps(value) {
  try {
    const url = new URL(clean(value));
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (host === 'imagetwist.com' || host.endsWith('.imagetwist.com')
      || host === 'imgtwist.com' || host.endsWith('.imgtwist.com')) return '';
    if (/(?:hotlink|hot-link|placeholder|deleted|not[-_ ]?found|error[-_ ]?image)/i.test(pathname)) return '';
    return url.toString();
  } catch { return ''; }
}
function isGeneratedRssPoster(value) {
  return /\/onlyporn\/poster\/sukebei-rss\//i.test(clean(value));
}
function defaultCacheDirectory(env = process.env) {
  return clean(env.ONLYPORN_PERSISTENT_CACHE_DIR || env.RENDER_DISK_PATH || env.ONLYPORN_CACHE_DIR)
    || path.join(process.cwd(), '.onlyporn-cache');
}
function arraysEqual(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}
function normalizedRecord(item, savedAt) {
  const sourceId = clean(item?.sourceId);
  const poster = safeHttps(item?.poster);
  const lookupSource = clean(item?.lookupSource);
  if (!sourceId || !poster || isGeneratedRssPoster(poster)) return null;
  if (lookupSource === 'sukebei-rss-fallback' || lookupSource === 'sukebei-persistent-cache') return null;
  const background = safeHttps(item?.background) || poster;
  return Object.freeze({
    sourceId,
    title: clean(item?.title).slice(0, 500),
    poster,
    background,
    metadataProvider: clean(item?.metadataProvider).slice(0, 80),
    lookupQuery: clean(item?.lookupQuery).slice(0, 240),
    sceneCode: clean(item?.sceneCode).slice(0, 80),
    releaseDate: clean(item?.releaseDate).slice(0, 40),
    studio: clean(item?.studio).slice(0, 120),
    performers: Array.isArray(item?.performers) ? item.performers.map(clean).filter(Boolean).slice(0, 20) : [],
    tags: Array.isArray(item?.tags) ? item.tags.map(clean).filter(Boolean).slice(0, 80) : [],
    contentTags: Array.isArray(item?.contentTags) ? item.contentTags.map(clean).filter(Boolean).slice(0, 80) : [],
    savedAt: Number(savedAt) || Date.now(),
  });
}
function equivalent(left, right) {
  return Boolean(left && right
    && left.poster === right.poster
    && left.background === right.background
    && left.title === right.title
    && left.metadataProvider === right.metadataProvider
    && left.lookupQuery === right.lookupQuery
    && left.sceneCode === right.sceneCode
    && left.releaseDate === right.releaseDate
    && left.studio === right.studio
    && arraysEqual(left.performers, right.performers)
    && arraysEqual(left.tags, right.tags)
    && arraysEqual(left.contentTags, right.contentTags));
}

function createSukebeiArtworkStore(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxAgeMs = Math.max(Number(options.maxAgeMs || env.ONLYPORN_SUKEBEI_ARTWORK_MAX_AGE_MS || DEFAULT_MAX_AGE_MS), 60_000);
  const refreshIntervalMs = Math.max(Number(options.refreshIntervalMs || env.ONLYPORN_SUKEBEI_ARTWORK_REFRESH_MS || DEFAULT_REFRESH_INTERVAL_MS), 60_000);
  const maxEntries = Math.min(Math.max(Number(options.maxEntries || env.ONLYPORN_SUKEBEI_ARTWORK_MAX_ENTRIES || DEFAULT_MAX_ENTRIES), 50), 5_000);
  const enabled = options.enabled !== false && !truthy(process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE || env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
  const filePath = enabled
    ? path.resolve(clean(options.filePath) || path.join(defaultCacheDirectory(env), 'sukebei-artwork-v3.json'))
    : '';
  let records = null;
  let writes = 0;
  let readErrors = 0;
  let writeErrors = 0;

  function load() {
    if (records) return records;
    records = new Map();
    if (!enabled) return records;
    try {
      if (!fs.existsSync(filePath)) return records;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Number(parsed?.version) !== STORE_VERSION || !Array.isArray(parsed?.records)) return records;
      const current = now();
      for (const raw of parsed.records) {
        const lookupSource = clean(raw?.lookupSource);
        const candidate = normalizedRecord({ ...raw, lookupSource: lookupSource || 'persisted-file' }, Number(raw?.savedAt || current));
        if (!candidate || current - candidate.savedAt > maxAgeMs) continue;
        records.set(candidate.sourceId, candidate);
      }
    } catch {
      readErrors += 1;
      records.clear();
    }
    return records;
  }

  function flush() {
    if (!enabled) return false;
    const values = [...load().values()]
      .filter(value => now() - value.savedAt <= maxAgeMs)
      .sort((left, right) => right.savedAt - left.savedAt)
      .slice(0, maxEntries);
    records = new Map(values.map(value => [value.sourceId, value]));
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify({ version: STORE_VERSION, records: values })}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, filePath);
      writes += 1;
      return true;
    } catch {
      writeErrors += 1;
      try { fs.rmSync(temporary, { force: true }); } catch {}
      return false;
    }
  }

  function get(sourceId) {
    if (!enabled) return null;
    const key = clean(sourceId);
    if (!key) return null;
    const value = load().get(key);
    if (!value) return null;
    if (now() - value.savedAt > maxAgeMs) {
      records.delete(key);
      flush();
      return null;
    }
    return Object.freeze({
      ...value,
      performers: Object.freeze([...value.performers]),
      tags: Object.freeze([...value.tags]),
      contentTags: Object.freeze([...value.contentTags]),
    });
  }

  function setMany(items = []) {
    if (!enabled) return 0;
    const current = now();
    let changed = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const previous = load().get(clean(item?.sourceId));
      const candidate = normalizedRecord(item, current);
      if (!candidate) continue;
      if (previous && equivalent(previous, candidate) && current - previous.savedAt < refreshIntervalMs) continue;
      records.set(candidate.sourceId, candidate);
      changed += 1;
    }
    if (changed) flush();
    return changed;
  }

  return Object.freeze({
    enabled,
    filePath,
    get,
    set(item) { return setMany([item]) === 1; },
    setMany,
    diagnostics() {
      return Object.freeze({ enabled, filePath, entries: load().size, writes, readErrors, writeErrors, maxAgeMs, refreshIntervalMs, maxEntries });
    },
  });
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  STORE_VERSION,
  createSukebeiArtworkStore,
  defaultCacheDirectory,
  isGeneratedRssPoster,
};
