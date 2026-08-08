'use strict';

const { normalizeFeedItem, parseJsonFeed, parseRssFeed } = require('../discovery-normalize');
const { SourceHttpClient } = require('../source-http');
const { createNativeAdapter } = require('../native-discovery');
const { createHentaiMamaSeriesAdapter } = require('../hentaimama-series');
const { createTorrentIndexAdapter } = require('../torrent-index');
const { createStudioMetadataAdapter } = require('../studio-metadata');
const { createSukebeiMetadataAdapter } = require('../sukebei-metadata');
const { createSukebeiHentaiAdapter } = require('../sukebei-hentai');
const { createPlatformHybridAdapter } = require('../platform-hybrid');

function createMemoryIndex() {
  const entries = new Map();
  return {
    remember(items) {
      for (const item of items) entries.set(String(item.sourceId), item);
      return items;
    },
    get(id) {
      return entries.get(String(id || '')) || null;
    },
  };
}

function createJsonFeedAdapter(options) {
  const index = createMemoryIndex();
  const client = new SourceHttpClient({
    id: options.id,
    endpoint: options.endpoint,
    timeoutMs: options.config.requestTimeoutMs,
    maxResponseBytes: options.config.discoveryMaxResponseBytes,
    cacheTtlMs: options.config.discoveryCacheTtlMs,
    negativeTtlMs: options.config.discoveryNegativeTtlMs,
    cacheMaxEntries: options.config.discoveryCacheMaxEntries,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    allowedContentTypes: ['application/json'],
  });

  return Object.freeze({
    id: options.id,
    configured: client.configured,
    async catalog({ catalog, skip, limit }) {
      if (!client.configured) return [];
      const url = client.buildUrl({ skip, limit, mode: catalog?.mode });
      const payload = await client.fetchText(url, { cacheKey: `${catalog?.id}:${skip}:${limit}` });
      const records = parseJsonFeed(payload)
        .map((item, position) => normalizeFeedItem(options.id, item, skip + position))
        .filter(Boolean)
        .slice(0, limit);
      return index.remember(records);
    },
    async meta({ sourceId }) {
      return index.get(sourceId);
    },
    async resolve() {
      return [];
    },
  });
}

function createSukebeiAdapter(options) {
  return createSukebeiMetadataAdapter(options);
}

function createStripchatGateAdapter() {
  return Object.freeze({
    id: 'stripchat',
    configured: false,
    phase: 7,
    async catalog() {
      return [];
    },
    async meta() {
      return null;
    },
    async resolve() {
      return [];
    },
  });
}

function createDiscoveryAdapters(options = {}) {
  const config = options.config;
  const common = {
    config,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    minRequestIntervalMs: options.minRequestIntervalMs,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    now: options.now,
    sleep: options.sleep,
    metadataClients: options.metadataClients,
    env: options.env || process.env,
  };
  const torrentIndex = createTorrentIndexAdapter(common);
  const studioMetadata = createStudioMetadataAdapter(common);
  const platformHybrid = createPlatformHybridAdapter({
    metadataAdapter: studioMetadata,
    torrentAdapter: torrentIndex,
  });
  const adapters = [
    createNativeAdapter('pornrips', common),
    createNativeAdapter('yesporn', common),
    createHentaiMamaSeriesAdapter(common),
    torrentIndex,
    studioMetadata,
    platformHybrid,
    createSukebeiAdapter({ ...common, endpoint: config.discovery.sukebei }),
    createSukebeiHentaiAdapter(common),
    createStripchatGateAdapter(),
  ];
  return Object.freeze({
    adapters: Object.freeze(adapters),
    configuredSources: adapters.filter(adapter => adapter.configured).map(adapter => adapter.id).sort(),
    phaseGates: Object.freeze({ stripchat: 7 }),
  });
}

module.exports = {
  createDiscoveryAdapters,
  createJsonFeedAdapter,
  createStripchatGateAdapter,
  createSukebeiAdapter,
  createTorrentIndexAdapter,
};
