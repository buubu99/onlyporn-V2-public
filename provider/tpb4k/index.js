'use strict';

const { readTpb4kConfig } = require('./config');
const { assertSourceAdapter } = require('./source-contract');

const adapters = new Map();

function registerAdapter(adapter) {
  const validated = assertSourceAdapter(adapter);
  adapters.set(validated.id, validated);
  return validated;
}

function registerAdapterIfAbsent(adapter) {
  const validated = assertSourceAdapter(adapter);
  if (!adapters.has(validated.id)) adapters.set(validated.id, validated);
  return adapters.get(validated.id);
}

function installBuiltInAdapters(options = {}) {
  const { createMetadataAdapters } = require('./adapters/metadata');
  const { createDiscoveryAdapters } = require('./adapters/discovery');
  const config = options.config || readTpb4kConfig(options.env || process.env);
  const metadata = createMetadataAdapters({ config, fetchImpl: options.fetchImpl });
  const discovery = createDiscoveryAdapters({
    config,
    fetchImpl: options.fetchImpl,
    checkDns: options.checkDns,
    minRequestIntervalMs: options.minRequestIntervalMs,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    now: options.now,
    sleep: options.sleep,
  });
  for (const adapter of [...metadata.adapters, ...discovery.adapters]) registerAdapterIfAbsent(adapter);
  return Object.freeze({
    installed: [...metadata.adapters, ...discovery.adapters].map(adapter => adapter.id).sort(),
    configuredProviders: Object.entries(metadata.clients)
      .filter(([, client]) => client.configured)
      .map(([id]) => id)
      .sort(),
    configuredDiscoverySources: discovery.configuredSources,
    phaseGates: discovery.phaseGates,
  });
}

function unregisterAdapter(id) {
  return adapters.delete(String(id || ''));
}

function getAdapter(id) {
  return adapters.get(String(id || '')) || null;
}

function listAdapters() {
  return [...adapters.keys()].sort();
}

function clearAdapters() {
  adapters.clear();
}

module.exports = {
  clearAdapters,
  getAdapter,
  installBuiltInAdapters,
  listAdapters,
  registerAdapter,
  registerAdapterIfAbsent,
  unregisterAdapter,
};
