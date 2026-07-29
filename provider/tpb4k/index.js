'use strict';

const { assertSourceAdapter } = require('./source-contract');

const adapters = new Map();

function registerAdapter(adapter) {
  const validated = assertSourceAdapter(adapter);
  adapters.set(validated.id, validated);
  return validated;
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
  listAdapters,
  registerAdapter,
  unregisterAdapter,
};
