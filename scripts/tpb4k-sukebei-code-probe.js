#!/usr/bin/env node
'use strict';

const { readTpb4kConfig, redactSecrets } = require('../provider/tpb4k/config');
const { parseRssFeed, normalizeFeedItem } = require('../provider/tpb4k/discovery-normalize');
const { SourceHttpClient } = require('../provider/tpb4k/source-http');
const { StashBoxMetadataClient } = require('../provider/tpb4k/stashbox-client');
const {
  dedupeAndRank,
  extractSceneCodes,
  normalizedSceneCode,
  queryExactCodeProvider,
} = require('../provider/tpb4k/sukebei-metadata');

function createLimiter(maxConcurrency) {
  const limit = Math.max(Number(maxConcurrency || 1), 1);
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < limit && queue.length) {
      const task = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task.run)
        .then(task.resolve, task.reject)
        .finally(() => { active -= 1; drain(); });
    }
  };
  return run => new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject });
    drain();
  });
}

(async () => {
  const config = readTpb4kConfig(process.env);
  if (!config.stashdb.configured) {
    throw new Error('STASHDB_API_KEY is required for the Sukebei staged code probe');
  }

  const rssUrl = new URL(config.discovery.sukebei);
  if (rssUrl.hostname.toLowerCase() === 'sukebei.nyaa.si' &&
      rssUrl.searchParams.get('c') !== '0_0') {
    throw new Error('Sukebei RSS does not match the all-category contract (c=0_0)');
  }

  const rssClient = new SourceHttpClient({
    id: 'sukebei-code-probe',
    endpoint: config.discovery.sukebei,
    timeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.discoveryMaxResponseBytes,
    cacheTtlMs: 1_000,
    negativeTtlMs: 1_000,
    cacheMaxEntries: 10,
    allowedContentTypes: ['application/rss+xml', 'application/xml', 'text/xml'],
  });

  const feed = [];
  const pages = Math.min(Math.max(Number(config.sukebeiRssPages || 4), 1), 4);
  let fetchedPages = 0;
  for (let page = 1; page <= pages; page += 1) {
    const pageUrl = new URL(rssClient.endpoint);
    pageUrl.searchParams.set('p', String(page));
    const payload = await rssClient.fetchText(pageUrl.toString(), {
      cacheKey: `sukebei-staged-code-probe:${page}:${Date.now()}`,
    });
    const items = parseRssFeed(payload);
    if (!items.length) break;
    fetchedPages += 1;
    feed.push(...items);
  }

  const records = dedupeAndRank(
    feed
      .map((item, index) => normalizeFeedItem('sukebei', item, index))
      .filter(Boolean)
  );
  const codeRows = [];
  const seen = new Set();
  for (const item of records) {
    for (const code of extractSceneCodes(item.title)) {
      const key = normalizedSceneCode(code);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      codeRows.push({ code, item });
    }
  }
  if (!codeRows.length) throw new Error('Sukebei RSS returned no recognizable scene codes');

  const stashdb = new StashBoxMetadataClient({
    id: 'stashdb',
    endpoint: config.stashdb.endpoint,
    apiKey: config.stashdb.apiKey,
    timeoutMs: config.requestTimeoutMs,
    cacheTtlMs: config.metadataCacheTtlMs,
    negativeTtlMs: config.metadataNegativeTtlMs,
    cacheMaxEntries: 100,
  });
  const stats = {
    exactCodeQueries: 0,
    exactCodeMisses: 0,
    providerRequests: {},
    providerErrors: {},
  };
  const rows = codeRows.slice(0, Math.min(codeRows.length, config.sukebeiCodeLookupLimit));
  const runLimited = createLimiter(config.sukebeiLookupConcurrency);
  let completed = 0;
  const attempts = await Promise.all(rows.map(row => runLimited(async () => {
    const result = await queryExactCodeProvider('stashdb', stashdb, row.item, row.code, {
      stats,
      timeoutMs: Math.min(config.metadataLookupTimeoutMs, 3_500),
    });
    completed += 1;
    if (completed % 5 === 0 || completed === rows.length) {
      console.error(`Sukebei staged code probe: ${completed}/${rows.length} complete`);
    }
    return {
      code: row.code,
      returned: result.returned,
      exactPosterMatches: result.candidate ? 1 : 0,
      firstTitle: result.candidate?.normalized?.title || '',
      error: result.error ? redactSecrets(result.error, process.env) : undefined,
    };
  })));

  const matched = attempts.filter(item => item.exactPosterMatches > 0);
  const report = {
    version: require('../package.json').version,
    rss: {
      endpointCategory: rssUrl.searchParams.get('c') || '',
      pages: fetchedPages,
      records: records.length,
      uniqueCodes: codeRows.length,
    },
    stagedCodeScan: {
      operation: 'one searchScene(code) request per unique code',
      attemptedCodes: attempts.length,
      completed,
      matched: matched.length,
      providerRequests: stats.providerRequests,
      providerErrors: stats.providerErrors,
      attempts,
    },
    gate: matched.length
      ? 'shared staged code resolver found exact poster matches'
      : 'shared staged code resolver completed; current RSS snapshot had no exact metadata coverage',
  };
  console.log(JSON.stringify(report, null, 2));
  if (!completed || Number(stats.providerRequests.stashdb || 0) !== completed) {
    throw new Error('The staged code probe did not scan every selected unique code exactly once');
  }
})().catch(error => {
  console.error(`TPB4K Sukebei staged code probe failed: ${error.message}`);
  process.exit(1);
});
