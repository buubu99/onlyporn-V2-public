'use strict';

const { TpdbRestClient } = require('./tpdb-rest-client');

class TpdbMetadataClient {
  constructor(options = {}) {
    this.id = 'tpdb';
    this.rest = new TpdbRestClient({
      endpoint: options.restEndpoint,
      apiKey: options.apiKey,
      timeoutMs: options.timeoutMs,
      cacheTtlMs: options.cacheTtlMs,
      negativeTtlMs: options.negativeTtlMs,
      cacheMaxEntries: options.cacheMaxEntries,
      fetchImpl: options.fetchImpl,
    });
  }

  get configured() {
    return this.rest.configured;
  }

  async queryScenes(options = {}) {
    return this.rest.queryScenes(options);
  }

  async findScene(id) {
    return this.rest.findScene(id);
  }
}

module.exports = {
  TpdbMetadataClient,
};
