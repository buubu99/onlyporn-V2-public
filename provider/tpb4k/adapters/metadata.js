'use strict';

const { buildSceneIdentity } = require('../identity');
const { normalizeScene } = require('../metadata-normalize');
const { StashBoxMetadataClient } = require('../stashbox-client');
const { TpdbMetadataClient } = require('../tpdb-client');

function parseSourceId(value) {
  const text = String(value || '').trim();
  const separator = text.indexOf(':');
  if (separator < 1 || separator === text.length - 1) return null;
  const provider = text.slice(0, separator).toLowerCase();
  const upstreamId = text.slice(separator + 1);
  if (!/^[a-z0-9_-]{1,32}$/.test(provider) || !upstreamId) return null;
  return Object.freeze({ provider, upstreamId });
}

function createClients(config, fetchImpl) {
  const common = {
    timeoutMs: config.requestTimeoutMs,
    cacheTtlMs: config.metadataCacheTtlMs,
    negativeTtlMs: config.metadataNegativeTtlMs,
    cacheMaxEntries: config.metadataCacheMaxEntries,
    fetchImpl,
  };
  return Object.freeze({
    tpdb: new TpdbMetadataClient({
      ...common,
      restEndpoint: config.tpdb.restEndpoint,
      apiKey: config.tpdb.apiKey,
    }),
    stashdb: new StashBoxMetadataClient({
      ...common,
      id: 'stashdb',
      endpoint: config.stashdb.endpoint,
      apiKey: config.stashdb.apiKey,
    }),
  });
}

async function fetchWindow(client, options = {}) {
  if (!client?.configured) return [];
  const skip = Math.max(Number.parseInt(String(options.skip || 0), 10) || 0, 0);
  const limit = Math.min(Math.max(Number.parseInt(String(options.limit || 40), 10) || 40, 1), 100);
  const perPage = Math.min(limit, 100);
  let page = Math.floor(skip / perPage) + 1;
  let offset = skip % perPage;
  const output = [];
  const seenIds = new Set();

  while (output.length < limit) {
    const scenes = await client.queryScenes({
      page,
      perPage,
      studio: options.studio,
      title: options.title,
      text: options.text,
      query: options.query,
      year: options.year,
      orderBy: options.orderBy,
      sort: options.sort,
    });
    if (!scenes.length) break;
    const window = scenes.slice(offset);
    offset = 0;
    for (const scene of window) {
      const id = String(scene?.id || '');
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      output.push(scene);
      if (output.length >= limit) break;
    }
    if (scenes.length < perPage) break;
    page += 1;
  }
  return output;
}

function dedupeMetadata(items) {
  const byIdentity = new Map();
  for (const item of items) {
    if (!item) continue;
    const identity = item.sceneIdentity || buildSceneIdentity(item).digest;
    if (!byIdentity.has(identity)) byIdentity.set(identity, item);
  }
  return [...byIdentity.values()];
}

function createMetadataAdapters(options = {}) {
  const clients = createClients(options.config, options.fetchImpl);

  async function findBySourceId(sourceId) {
    const parsed = parseSourceId(sourceId);
    if (!parsed) return null;
    const client = clients[parsed.provider];
    if (!client?.configured) return null;
    try {
      return normalizeScene(parsed.provider, await client.findScene(parsed.upstreamId));
    } catch {
      return null;
    }
  }

  const tpdb = {
    id: 'tpdb',
    async catalog({ skip, limit }) {
      if (!clients.tpdb.configured) return [];
      const scenes = await fetchWindow(clients.tpdb, {
        skip,
        limit,
        sort: 'DATE',
      });
      return scenes.map(scene => normalizeScene('tpdb', scene)).filter(Boolean);
    },
    async meta({ sourceId }) {
      return findBySourceId(sourceId);
    },
    async resolve() {
      return [];
    },
  };



  return Object.freeze({
    clients,
    adapters: Object.freeze([tpdb]),
  });
}

module.exports = {
  createMetadataAdapters,
  dedupeMetadata,
  fetchWindow,
  parseSourceId,
};
