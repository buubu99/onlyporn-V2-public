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
  const bundle = createMetadataAdapters({
    config: options.config || readTpb4kConfig(options.env || process.env),
    fetchImpl: options.fetchImpl,
  });
  for (const adapter of bundle.adapters) registerAdapterIfAbsent(adapter);
  return Object.freeze({
    installed: bundle.adapters.map(adapter => adapter.id),
    configuredProviders: Object.entries(bundle.clients)
      .filter(([, client]) => client.configured)
      .map(([id]) => id)
      .sort(),
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
