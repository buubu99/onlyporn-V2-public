#!/usr/bin/env node
'use strict';

const { readTpb4kConfig } = require('../provider/tpb4k/config');
const { StashBoxMetadataClient } = require('../provider/tpb4k/stashbox-client');
const { TpdbMetadataClient } = require('../provider/tpb4k/tpdb-client');
const { createSukebeiMetadataAdapter } = require('../provider/tpb4k/sukebei-metadata');

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

(async () => {
  const config = readTpb4kConfig(process.env);
  if (!config.stashdb.configured) {
    throw new Error('STASHDB_API_KEY is required for the live staged Sukebei catalog gate');
  }
  const common = {
    timeoutMs: config.requestTimeoutMs,
    cacheTtlMs: config.metadataCacheTtlMs,
    negativeTtlMs: config.metadataNegativeTtlMs,
    cacheMaxEntries: config.metadataCacheMaxEntries,
  };
  const metadataClients = {
    stashdb: new StashBoxMetadataClient({
      ...common,
      id: 'stashdb',
      endpoint: config.stashdb.endpoint,
      apiKey: config.stashdb.apiKey,
    }),
    tpdb: new TpdbMetadataClient({
      ...common,
      restEndpoint: config.tpdb.restEndpoint,
      apiKey: config.tpdb.apiKey,
    }),
  };
  const adapter = createSukebeiMetadataAdapter({
    config,
    env: process.env,
    endpoint: config.discovery.sukebei,
    metadataClients,
    onProgress(progress) {
      if (progress.stage === 'code') {
        console.error(
          `Sukebei real catalog code stage: ${progress.completed}/${progress.total}; ` +
          `matches=${progress.matches}; provider=${progress.provider}`
        );
      }
    },
  });

  const started = Date.now();
  const records = await adapter.catalog({ skip: 0, limit: config.catalogLimit });
  const diagnostics = adapter.diagnostics().sukebeiMetadata;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`real staged catalog returned zero records: ${JSON.stringify(diagnostics)}`);
  }
  if (records.some(item => !safeHttps(item.poster))) {
    throw new Error('real staged catalog returned a card without a safe HTTPS poster');
  }
  if (records.some(item => new URL(item.poster).pathname.includes('/assets/tpb4k/studios/'))) {
    throw new Error('real staged catalog returned a generic fallback poster');
  }
  if (Number(diagnostics.codeStageJobs || 0) < 1 ||
      Number(diagnostics.codeStageCompleted || 0) !== Number(diagnostics.codeStageJobs || 0)) {
    throw new Error('real staged catalog did not complete its selected unique-code scan');
  }
  if (Number(diagnostics.exactCodeQueries || 0) !== Number(diagnostics.codeStageCompleted || 0)) {
    throw new Error('real staged catalog did not use exactly one exact-code request per completed code job');
  }
  if (Number(diagnostics.codeStageMatches || 0) < 1) {
    throw new Error('real staged catalog completed the code scan but preserved no exact-code match');
  }

  console.log(JSON.stringify({
    version: require('../package.json').version,
    elapsedMs: Date.now() - started,
    records: records.length,
    first: records.slice(0, 5).map(item => ({
      sourceId: item.sourceId,
      title: item.title,
      sceneCode: item.sceneCode || '',
      metadataProvider: item.metadataProvider || '',
      poster: item.poster,
    })),
    diagnostics,
    gate: 'the exact production Sukebei adapter returned verified-poster records',
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K staged Sukebei catalog gate failed: ${error.message}`);
  process.exit(1);
});
