#!/usr/bin/env node
'use strict';

const { Tpb4kProvider } = require('../provider/tpb4k');
const { clearAdapters, getAdapter, installBuiltInAdapters } = require('../provider/tpb4k/index');

const env = {
  ...process.env,
  TPB4K_ENABLED: 'true',
  TPB4K_CATALOG_LIMIT: process.env.TPB4K_CATALOG_LIMIT || '40',
  TPB4K_REQUEST_TIMEOUT_MS: process.env.TPB4K_REQUEST_TIMEOUT_MS || '30000',
  ONLYPORN_CONTENT_FILTER_ENABLED: process.env.ONLYPORN_CONTENT_FILTER_ENABLED || 'true',
  ONLYPORN_FILTER_GAY: process.env.ONLYPORN_FILTER_GAY || 'true',
  ONLYPORN_FILTER_INTERRACIAL: process.env.ONLYPORN_FILTER_INTERRACIAL || 'true',
};

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function genericPoster(value) {
  const poster = safeHttps(value);
  return poster ? new URL(poster).pathname.includes('/assets/tpb4k/studios/') : false;
}

(async () => {
  if (!String(env.TPDB_API_KEY || '').trim() && !String(env.STASHDB_API_KEY || '').trim()) {
    throw new Error('TPDB_API_KEY or STASHDB_API_KEY is required for the Sukebei metadata gate');
  }
  clearAdapters();
  installBuiltInAdapters({ env });
  const provider = new Tpb4kProvider({ env, installBuiltIns: false });

  const sukebei = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.sukebei.top',
    extra: { skip: 0 },
  });
  const metas = Array.isArray(sukebei?.metas) ? sukebei.metas : [];
  if (!metas.length) throw new Error('Sukebei returned zero verified-poster records');
  if (metas.some(item => !safeHttps(item.poster))) throw new Error('Sukebei returned a card without a safe HTTPS poster');
  if (metas.some(item => genericPoster(item.poster))) throw new Error('Sukebei still returned a generic purple fallback poster');

  const onlyFans = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.studio.onlyfans.top',
    extra: { skip: 0 },
  });
  const onlyFansMetas = Array.isArray(onlyFans?.metas) ? onlyFans.metas : [];
  if (!onlyFansMetas.length) throw new Error('OnlyFans platform hybrid returned zero records');
  if (onlyFansMetas.some(item => !safeHttps(item.poster))) throw new Error('OnlyFans returned a card without a safe HTTPS poster');

  const diagnostics = getAdapter('sukebei')?.diagnostics?.().sukebeiMetadata || {};
  if (String(diagnostics.rssCategory || '') !== '0_0') {
    throw new Error(`Sukebei RSS category is ${diagnostics.rssCategory || '<missing>'}; expected 0_0`);
  }
  if (Number(diagnostics.matchedByCode || 0) < 1 &&
      Number(diagnostics.nativeImages || 0) < 1 &&
      Number(diagnostics.detailImages || 0) < 1) {
    throw new Error('Sukebei produced no exact-code, RSS-image, or detail-page-image matches');
  }
  if (Number(diagnostics.exactCodeQueries || 0) < 1) {
    throw new Error('Sukebei did not execute the exact scene-code query path');
  }
  if (Number(diagnostics.codeStageJobs || 0) < 1 ||
      Number(diagnostics.codeStageCompleted || 0) !== Number(diagnostics.codeStageJobs || 0)) {
    throw new Error('Sukebei did not complete the staged unique-code scan');
  }
  if (Number(diagnostics.exactCodeQueries || 0) !== Number(diagnostics.codeStageCompleted || 0)) {
    throw new Error('Sukebei did not use exactly one exact-code request per completed code job');
  }
  if (Number(diagnostics.deadlineSkipped || 0) >= Number(diagnostics.lookupEligible || 0) &&
      Number(diagnostics.lookupEligible || 0) > 0) {
    throw new Error('Sukebei deadline skipped every eligible metadata lookup');
  }
  const platformDiagnostics = getAdapter('platform-hybrid')?.diagnostics?.() || {};
  console.log(JSON.stringify({
    version: require('../package.json').version,
    sukebei: {
      records: metas.length,
      realPosters: metas.length,
      genericPosters: 0,
      diagnostics,
    },
    onlyFans: {
      records: onlyFansMetas.length,
      genericPosters: onlyFansMetas.filter(item => genericPoster(item.poster)).length,
      diagnostics: platformDiagnostics.platformHybrid || {},
    },
    phase2ReadyForPhase3: true,
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K Phase 2 final smoke failed: ${error.message}`);
  process.exit(1);
});
