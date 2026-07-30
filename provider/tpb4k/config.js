'use strict';

const { validateConfiguredEndpoint } = require('./source-http');


const DEFAULT_TPB_MIRRORS = Object.freeze([
  'https://thehiddenbay.com',
  'https://thepiratebay0.org',
  'https://piratebay.live',
]);

function endpointOrigins(value, fallback = DEFAULT_TPB_MIRRORS) {
  const raw = String(value || '').trim();
  const values = raw ? raw.split(',') : fallback;
  const output = [];
  const seen = new Set();
  for (const item of values) {
    const url = new URL(String(item || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      throw new Error('TPB4K torrent mirrors must be bare credential-free HTTPS origins');
    }
    if (seen.has(url.origin)) continue;
    seen.add(url.origin);
    output.push(url.origin);
  }
  if (!output.length) throw new Error('TPB4K requires at least one torrent mirror');
  return Object.freeze(output);
}

const SECRET_NAMES = Object.freeze([
  'TPDB_API_KEY',
  'STASHDB_API_KEY',
  'REALDEBRID_API_KEY',
  'REAL_DEBRID_API_KEY',
]);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function endpoint(value, fallback) {
  const text = String(value || fallback).trim();
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('TPB4K API endpoints must use credential-free HTTPS URLs');
  }
  return url.toString().replace(/\/$/, '');
}

function readTpb4kConfig(env = process.env) {
  const tpdbApiKey = String(env.TPDB_API_KEY || '').trim();
  const stashdbApiKey = String(env.STASHDB_API_KEY || '').trim();

  return Object.freeze({
    enabled: booleanValue(env.TPB4K_ENABLED, false),
    renderPreview: booleanValue(env.IS_PULL_REQUEST, false),
    catalogLimit: positiveInteger(env.TPB4K_CATALOG_LIMIT, 40, { min: 1, max: 100 }),
    minimumSeeders: positiveInteger(env.TPB4K_MIN_SEEDERS, 3, { min: 0, max: 100_000 }),
    requestTimeoutMs: positiveInteger(env.TPB4K_REQUEST_TIMEOUT_MS, 15_000, {
      min: 1_000,
      max: 30_000,
    }),
    metadataCacheTtlMs: positiveInteger(env.TPB4K_METADATA_CACHE_TTL_MS, 10 * 60 * 1000, {
      min: 5_000,
      max: 24 * 60 * 60 * 1000,
    }),
    metadataNegativeTtlMs: positiveInteger(env.TPB4K_METADATA_NEGATIVE_TTL_MS, 2 * 60 * 1000, {
      min: 1_000,
      max: 60 * 60 * 1000,
    }),
    metadataCacheMaxEntries: positiveInteger(env.TPB4K_METADATA_CACHE_MAX_ENTRIES, 500, {
      min: 10,
      max: 5_000,
    }),
    metadataEnrichmentConcurrency: positiveInteger(
      env.TPB4K_METADATA_ENRICHMENT_CONCURRENCY,
      10,
      { min: 1, max: 16 }
    ),
    metadataLookupTimeoutMs: positiveInteger(env.TPB4K_METADATA_LOOKUP_TIMEOUT_MS, 2_500, {
      min: 750,
      max: 8_000,
    }),
    metadataEnrichmentDeadlineMs: positiveInteger(
      env.TPB4K_METADATA_ENRICHMENT_DEADLINE_MS,
      16_000,
      { min: 4_000, max: 25_000 }
    ),
    metadataPoolSize: positiveInteger(env.TPB4K_METADATA_POOL_SIZE, 100, {
      min: 20,
      max: 100,
    }),
    metadataPoolAliasLimit: positiveInteger(env.TPB4K_METADATA_POOL_ALIAS_LIMIT, 2, {
      min: 1,
      max: 3,
    }),
    metadataTargetedAliasLimit: positiveInteger(
      env.TPB4K_METADATA_TARGETED_ALIAS_LIMIT,
      2,
      { min: 1, max: 3 }
    ),
    metadataPoolCacheMaxEntries: positiveInteger(
      env.TPB4K_METADATA_POOL_CACHE_MAX_ENTRIES,
      100,
      { min: 10, max: 500 }
    ),
    metadataMatchThreshold: positiveInteger(env.TPB4K_METADATA_MATCH_THRESHOLD, 72, {
      min: 50,
      max: 98,
    }),
    metadataCatalogMaxPages: positiveInteger(env.TPB4K_METADATA_CATALOG_MAX_PAGES, 3, {
      min: 1,
      max: 5,
    }),
    metadataCatalogConcurrency: positiveInteger(
      env.TPB4K_METADATA_CATALOG_CONCURRENCY,
      4,
      { min: 1, max: 8 }
    ),
    contentFilterOverscanFactor: positiveInteger(env.ONLYPORN_FILTER_OVERSCAN_FACTOR, 3, {
      min: 1,
      max: 5,
    }),
    posterAssetBaseUrl: endpoint(
      env.TPB4K_POSTER_ASSET_BASE_URL,
      'https://raw.githubusercontent.com/buubu99/onlyporn-V2-public/main/assets/tpb4k/studios'
    ),
    discoveryCacheTtlMs: positiveInteger(env.TPB4K_DISCOVERY_CACHE_TTL_MS, 5 * 60 * 1000, {
      min: 5_000,
      max: 60 * 60 * 1000,
    }),
    discoveryNegativeTtlMs: positiveInteger(env.TPB4K_DISCOVERY_NEGATIVE_TTL_MS, 60 * 1000, {
      min: 1_000,
      max: 15 * 60 * 1000,
    }),
    discoveryCacheMaxEntries: positiveInteger(env.TPB4K_DISCOVERY_CACHE_MAX_ENTRIES, 250, {
      min: 10,
      max: 2_000,
    }),
    discoveryMaxResponseBytes: positiveInteger(env.TPB4K_DISCOVERY_MAX_RESPONSE_BYTES, 2_000_000, {
      min: 64 * 1024,
      max: 10 * 1024 * 1024,
    }),
    discovery: Object.freeze({
      pornrips: 'https://pornrips.to/',
      yesporn: 'https://yesporn.vip/',
      hentai: 'https://hentaimama.io/',
      sukebei: validateConfiguredEndpoint(
        env.TPB4K_SUKEBEI_RSS_URL || 'https://sukebei.nyaa.si/?page=rss',
        'Sukebei RSS endpoint'
      ),
    }),
    torrentIndex: Object.freeze({
      mirrors: endpointOrigins(env.TPB4K_TPB_MIRRORS),
      category: '507',
      sort: '7',
      pageSize: 30,
    }),
    tpdb: Object.freeze({
      configured: Boolean(tpdbApiKey),
      apiKey: tpdbApiKey,
      restEndpoint: endpoint(env.TPDB_REST_API_URL, 'https://api.theporndb.net'),
    }),
    stashdb: Object.freeze({
      configured: Boolean(stashdbApiKey),
      apiKey: stashdbApiKey,
      endpoint: endpoint(env.STASHDB_API_URL, 'https://stashdb.org/graphql'),
    }),
  });
}

function publicConfigStatus(config = readTpb4kConfig()) {
  return Object.freeze({
    enabled: config.enabled,
    catalogLimit: config.catalogLimit,
    minimumSeeders: config.minimumSeeders,
    requestTimeoutMs: config.requestTimeoutMs,
    tpdbConfigured: config.tpdb.configured,
    stashdbConfigured: config.stashdb.configured,
    configuredDiscoverySources: [
      ...Object.entries(config.discovery)
        .filter(([, value]) => Boolean(value))
        .map(([name]) => name),
      ...(config.torrentIndex?.mirrors?.length ? ['torrent-index'] : []),
      ...(config.tpdb.configured || config.stashdb.configured ? ['studio-metadata'] : []),
    ].sort(),
    stripchatPhaseRequired: 7,
    renderPreview: config.renderPreview,
  });
}

function redactSecrets(value, env = process.env) {
  let text = String(value || '');
  for (const name of SECRET_NAMES) {
    const secret = String(env[name] || '').trim();
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

module.exports = {
  DEFAULT_TPB_MIRRORS,
  SECRET_NAMES,
  endpointOrigins,
  publicConfigStatus,
  readTpb4kConfig,
  redactSecrets,
};
