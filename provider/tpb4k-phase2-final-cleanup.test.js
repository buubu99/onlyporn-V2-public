'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  codesMatch,
  createSukebeiMetadataAdapter,
  detailPageImage,
  extractSceneCodes,
} = require('./tpb4k/sukebei-metadata');
const { createStudioMetadataAdapter, platformEvidence } = require('./tpb4k/studio-metadata');
const { getCatalogDefinition } = require('../catalog/tpb4k');
const { readTpb4kConfig, sukebeiRssEndpoint } = require('./tpb4k/config');
const {
  SEARCH_SCENES,
  StashBoxMetadataClient,
} = require('./tpb4k/stashbox-client');

function response(body, contentType = 'application/rss+xml') {
  return {
    status: 200,
    headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : '' },
    async text() { return body; },
  };
}

function scene(id, options = {}) {
  return {
    id,
    title: options.title || 'ADN-721 Example Scene',
    code: options.code || 'ADN-721',
    details: options.details || '',
    date: '2026-07-30',
    site: options.site || { name: 'Example Studio' },
    tags: (options.tags || ['Romantic']).map(name => ({ name })),
    images: [{ url: `https://images.example/${id}.jpg`, width: 600, height: 900 }],
    performers: [{ name: 'Performer One' }],
    urls: options.urls || [],
  };
}

const RSS = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>
  <item><guid>native-1</guid><title>Native Poster Item</title><link>https://sukebei.example/view/1</link><description><![CDATA[<img src="https://img.example/native.jpg">]]></description><nyaa:seeders>10</nyaa:seeders></item>
  <item><guid>code-1</guid><title>[H265 1080p] ADN-721</title><link>https://sukebei.example/view/2</link><nyaa:seeders>20</nyaa:seeders></item>
  <item><guid>blocked-1</guid><title>BTIS-100</title><link>https://sukebei.example/view/3</link><nyaa:seeders>30</nyaa:seeders></item>
  <item><guid>unmatched-1</guid><title>Unmatched Chinese Release 0510</title><link>https://sukebei.example/view/4</link><nyaa:seeders>5</nyaa:seeders></item>
</channel></rss>`;

test('Sukebei matches the working TPB4K all-category RSS contract and rewrites stale official endpoints', () => {
  assert.equal(
    new URL(readTpb4kConfig({}).discovery.sukebei).searchParams.get('c'),
    '0_0'
  );
  const repaired = new URL(sukebeiRssEndpoint('https://sukebei.nyaa.si/?page=rss'));
  assert.equal(repaired.searchParams.get('page'), 'rss');
  assert.equal(repaired.searchParams.get('c'), '0_0');
  assert.equal(repaired.searchParams.get('f'), '0');
});

test('StashDB JAV matching uses searchScene(term:) instead of SceneQueryInput.code', async () => {
  assert.match(SEARCH_SCENES, /searchScene\(term:\s*\$term,\s*limit:\s*\$limit\)/);
  let requestBody;
  const client = new StashBoxMetadataClient({
    id: 'stashdb',
    endpoint: 'https://stashdb.example/graphql',
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : '' },
        async text() {
          return JSON.stringify({ data: { searchScene: [scene('adn')] } });
        },
      };
    },
  });
  const rows = await client.searchScenes('ADN-721', 20);
  assert.equal(rows.length, 1);
  assert.equal(requestBody.variables.term, 'ADN-721');
  assert.equal(requestBody.variables.limit, 20);
  assert.match(requestBody.query, /searchScene/);
  assert.doesNotMatch(requestBody.query, /queryScenes/);
});



test('StashDB staged code requests honor the shorter per-lookup timeout', async () => {
  const client = new StashBoxMetadataClient({
    id: 'stashdb',
    endpoint: 'https://stashdb.example/graphql',
    apiKey: 'test-key',
    timeoutMs: 5000,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('staged request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const started = Date.now();
  await assert.rejects(
    client.searchScenes('ADN-721', 20, { timeoutMs: 250 }),
    /staged request aborted/
  );
  assert.ok(Date.now() - started < 1500);
});

test('StashDB lookup timeout remains active while the response body is read', async () => {
  const client = new StashBoxMetadataClient({
    id: 'stashdb',
    endpoint: 'https://stashdb.example/graphql',
    apiKey: 'test-key',
    timeoutMs: 5_000,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : '' },
      text: async () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('body read aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    }),
  });
  await assert.rejects(
    client.searchScenes('ADN-721', 20, { timeoutMs: 250 }),
    /body read aborted/
  );
});

test('Sukebei scene-code extraction ignores codecs and canonicalizes known release codes', () => {
  assert.deepEqual(extractSceneCodes('[H265 1080p] ADN-721 and FC2PPV 1234567'), [
    'FC2-PPV-1234567',
    'ADN-721',
  ]);
  assert.equal(codesMatch('SSIS-001', 'SSIS-00001'), true);
  assert.equal(codesMatch('FC2PPV 1234567', 'FC2-PPV-1234567'), true);
});

test('Sukebei detail pages provide honest native artwork without accepting site chrome', async () => {
  assert.equal(
    detailPageImage(
      '<div id="torrent-description"><img src="/static/img/logo.png"><img src="https://covers.example/adn.jpg"></div>',
      'https://sukebei.example/view/721'
    ),
    'https://covers.example/adn.jpg'
  );
  assert.equal(
    detailPageImage(
      '<div id="torrent-description">**COVER / SS**&#10;https://covers.example/plain-adn.jpg&#10;https://covers.example/plain-adn_s.jpg</div>',
      'https://sukebei.example/view/721'
    ),
    'https://covers.example/plain-adn.jpg'
  );
  const rss = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>
    <item><guid>https://sukebei.example/view/native-detail</guid><title>Unmatched Native Detail</title><link>https://sukebei.example/download/native.torrent</link><nyaa:seeders>10</nyaa:seeders></item>
  </channel></rss>`;
  const adapter = createSukebeiMetadataAdapter({
    endpoint: 'https://sukebei.example/?page=rss&c=0_0&f=0',
    checkDns: false,
    fetchImpl: async url => String(url).includes('/view/native-detail')
      ? response('<html><div id="torrent-description"><img src="https://covers.example/native-detail.jpg"></div></html>', 'text/html')
      : response(rss),
    env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' },
    config: {
      requestTimeoutMs: 15000,
      metadataLookupTimeoutMs: 2500,
      discoveryMaxResponseBytes: 2000000,
      discoveryCacheTtlMs: 300000,
      discoveryNegativeTtlMs: 60000,
      discoveryCacheMaxEntries: 100,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
      metadataNegativeTtlMs: 120000,
      sukebeiRssPages: 1,
      sukebeiDetailImageLimit: 5,
      sukebeiTitleLookupLimit: 0,
      sukebeiEnrichmentDeadlineMs: 12000,
    },
    metadataClients: {
      stashdb: { configured: false },
      tpdb: { configured: false },
    },
  });
  const items = await adapter.catalog({ skip: 0, limit: 40 });
  assert.equal(items.length, 1);
  assert.equal(items[0].poster, 'https://covers.example/native-detail.jpg');
  assert.equal(items[0].detailUrl, 'https://sukebei.example/view/native-detail');
  assert.equal(adapter.diagnostics().sukebeiMetadata.detailImages, 1);
});

test('Sukebei cuts duplicate RSS pages and fetches plaintext detail artwork concurrently', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    return `<item><guid>https://sukebei.example/view/${number}</guid><title>TST-${number}</title><link>https://sukebei.example/download/${number}.torrent</link><nyaa:seeders>${100 - index}</nyaa:seeders></item>`;
  }).join('');
  const rss = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>${rows}</channel></rss>`;
  let rssCalls = 0;
  let detailActive = 0;
  let maxDetailActive = 0;
  const adapter = createSukebeiMetadataAdapter({
    endpoint: 'https://sukebei.example/?page=rss&c=0_0&f=0',
    checkDns: false,
    fetchImpl: async url => {
      const parsed = new URL(String(url));
      if (parsed.pathname.startsWith('/view/')) {
        detailActive += 1;
        maxDetailActive = Math.max(maxDetailActive, detailActive);
        await new Promise(resolve => setTimeout(resolve, 100));
        detailActive -= 1;
        const code = parsed.pathname.split('/').filter(Boolean).pop();
        return response(
          `<html><div id="torrent-description">**COVER / SS**&#10;https://covers.example/${code}.jpg&#10;</div></html>`,
          'text/html'
        );
      }
      rssCalls += 1;
      return response(rss);
    },
    env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' },
    config: {
      requestTimeoutMs: 15_000,
      metadataLookupTimeoutMs: 1_000,
      discoveryMaxResponseBytes: 2_000_000,
      discoveryCacheTtlMs: 300_000,
      discoveryNegativeTtlMs: 60_000,
      discoveryCacheMaxEntries: 100,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600_000,
      metadataNegativeTtlMs: 120_000,
      sukebeiLookupConcurrency: 8,
      sukebeiRssPages: 4,
      sukebeiCodeLookupLimit: 20,
      sukebeiTitleLookupLimit: 0,
      sukebeiDetailImageLimit: 20,
      sukebeiEnrichmentDeadlineMs: 4_000,
    },
    metadataClients: {
      stashdb: {
        configured: true,
        async searchScenes() {
          return [];
        },
      },
      tpdb: { configured: false },
    },
  });

  const items = await adapter.catalog({ skip: 0, limit: 40 });
  const diagnostics = adapter.diagnostics().sukebeiMetadata;
  assert.ok(items.length >= 8 && items.length <= 9);
  assert.equal(items.every(item => /^https:\/\/covers\.example\/\d+\.jpg$/.test(item.poster)), true);
  assert.equal(rssCalls, 2);
  assert.equal(diagnostics.rssPages, 2);
  assert.equal(diagnostics.rssRecords, 20);
  assert.equal(diagnostics.rssRecordsRead, 40);
  assert.equal(diagnostics.rssDuplicateRecords, 20);
  assert.equal(diagnostics.rssDuplicatePages, 1);
  assert.equal(diagnostics.detailStageTarget, 8);
  assert.equal(diagnostics.detailImages, items.length);
  assert.equal(diagnostics.deadlineExceededMs, 0);
  assert.ok(diagnostics.totalElapsedMs < 1_500, JSON.stringify(diagnostics));
  assert.equal(maxDetailActive, 2);
});

test('Sukebei keeps native artwork, enriches exact codes, filters tagged content, and omits unresolved purple cards', async () => {
  const stashCalls = [];
  const tpdbCalls = [];
  const adapter = createSukebeiMetadataAdapter({
    endpoint: 'https://sukebei.example/?page=rss',
    checkDns: false,
    fetchImpl: async () => response(RSS),
    env: {
      ONLYPORN_CONTENT_FILTER_ENABLED: 'true',
      ONLYPORN_FILTER_GAY: 'true',
      ONLYPORN_FILTER_INTERRACIAL: 'true',
      ONLYPORN_FILTER_UNKNOWN: 'false',
    },
    config: {
      requestTimeoutMs: 15000,
      discoveryMaxResponseBytes: 2000000,
      discoveryCacheTtlMs: 300000,
      discoveryNegativeTtlMs: 60000,
      discoveryCacheMaxEntries: 100,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
      metadataNegativeTtlMs: 120000,
      metadataCatalogConcurrency: 4,
    },
    metadataClients: {
      stashdb: {
        configured: true,
        async searchScenes(term, limit) {
          stashCalls.push({ term, limit });
          if (String(term).includes('ADN-721')) return [scene('adn', { code: 'ADN-721' })];
          if (String(term).includes('BTIS-100')) {
            return [scene('btis', { code: 'BTIS-100', tags: ['Interracial'] })];
          }
          return [];
        },
      },
      tpdb: {
        configured: true,
        async queryScenes(options) {
          tpdbCalls.push(options);
          return [];
        },
      },
    },
  });

  const items = await adapter.catalog({ skip: 0, limit: 40 });
  assert.deepEqual(items.map(item => item.sourceId), ['code-1', 'native-1']);
  assert.equal(items[0].poster, 'https://images.example/adn.jpg');
  assert.equal(items[1].poster, 'https://img.example/native.jpg');
  assert.equal(items.some(item => /assets\/tpb4k\/studios/.test(item.poster)), false);
  assert.equal(stashCalls.some(call => call.term === 'ADN-721' && call.limit === 20), true);
  assert.equal(tpdbCalls.some(call => /ADN-721|BTIS-100/.test(String(call.query || ''))), false);
  const diagnostics = adapter.diagnostics().sukebeiMetadata;
  assert.equal(diagnostics.nativeImages, 1);
  assert.equal(diagnostics.matchedByCode, 2);
  assert.equal(diagnostics.providerMatches.stashdb, 2);
  assert.equal(diagnostics.exactCodeQueries, 2);
  assert.equal(diagnostics.filtered, 1);
  assert.equal(diagnostics.unmatched, 1);
  assert.equal(diagnostics.returned, 2);
});


test('Sukebei provider failures are retried and never negative-cached as metadata misses', async () => {
  let calls = 0;
  const rss = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>
    <item><guid>retry-1</guid><title>ADN-721</title><link>https://sukebei.example/view/retry</link><nyaa:seeders>10</nyaa:seeders></item>
  </channel></rss>`;
  const adapter = createSukebeiMetadataAdapter({
    endpoint: 'https://sukebei.example/?page=rss',
    checkDns: false,
    fetchImpl: async () => response(rss),
    env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' },
    config: {
      requestTimeoutMs: 15000,
      discoveryMaxResponseBytes: 2000000,
      discoveryCacheTtlMs: 300000,
      discoveryNegativeTtlMs: 60000,
      discoveryCacheMaxEntries: 100,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
      metadataNegativeTtlMs: 120000,
      metadataCatalogConcurrency: 1,
      sukebeiCodeLookupLimit: 30,
      sukebeiTitleLookupLimit: 0,
      sukebeiEnrichmentDeadlineMs: 12000,
    },
    metadataClients: {
      tpdb: {
        configured: true,
        async queryScenes() { calls += 1; throw new Error('temporary network failure'); },
      },
      stashdb: { configured: false },
    },
  });
  assert.deepEqual(await adapter.catalog({ skip: 0, limit: 40 }), []);
  assert.deepEqual(await adapter.catalog({ skip: 0, limit: 40 }), []);
  assert.equal(calls, 2);
  assert.equal(adapter.diagnostics().sukebeiMetadata.providerErrors.tpdb, 1);
});



test('Sukebei code stage scans late exact matches before any title or TPDB fallback', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    return `<item><guid>stage-${number}</guid><title>TST-${number}</title><link>https://sukebei.example/view/${number}</link><nyaa:seeders>${100 - index}</nyaa:seeders></item>`;
  }).join('');
  const rss = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>${rows}</channel></rss>`;
  const stashCalls = [];
  let tpdbCalls = 0;
  const adapter = createSukebeiMetadataAdapter({
    endpoint: 'https://sukebei.example/?page=rss&c=0_0&f=0',
    checkDns: false,
    fetchImpl: async () => response(rss),
    env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' },
    config: {
      requestTimeoutMs: 15000,
      metadataLookupTimeoutMs: 1000,
      discoveryMaxResponseBytes: 2000000,
      discoveryCacheTtlMs: 300000,
      discoveryNegativeTtlMs: 60000,
      discoveryCacheMaxEntries: 100,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
      metadataNegativeTtlMs: 120000,
      sukebeiLookupConcurrency: 8,
      sukebeiRssPages: 1,
      sukebeiCodeLookupLimit: 30,
      sukebeiTitleLookupLimit: 0,
      sukebeiDetailImageLimit: 0,
      sukebeiEnrichmentDeadlineMs: 2000,
    },
    metadataClients: {
      stashdb: {
        configured: true,
        async searchScenes(term) {
          stashCalls.push(term);
          await new Promise(resolve => setTimeout(resolve, 10));
          if (term === 'TST-021' || term === 'TST-023') {
            return [scene(term.toLowerCase(), { code: term, title: term })];
          }
          return [];
        },
      },
      tpdb: {
        configured: true,
        async queryScenes() {
          tpdbCalls += 1;
          return [];
        },
      },
    },
  });

  const items = await adapter.catalog({ skip: 0, limit: 40 });
  assert.deepEqual(items.map(item => item.sourceId), ['stage-021', 'stage-023']);
  assert.equal(stashCalls.length, 30);
  assert.equal(new Set(stashCalls).size, 30);
  assert.equal(tpdbCalls, 0);
  const diagnostics = adapter.diagnostics().sukebeiMetadata;
  assert.equal(diagnostics.codeStageJobs, 30);
  assert.equal(diagnostics.codeStageCompleted, 30);
  assert.equal(diagnostics.codeStageMatches, 2);
  assert.equal(diagnostics.matchedByCode, 2);
  assert.equal(diagnostics.codeStageDeadlineSkipped, 0);
  assert.equal(diagnostics.providerRequests.stashdb, 30);
  assert.equal(diagnostics.providerRequests.tpdb || 0, 0);
  assert.equal(diagnostics.returned, 2);
});

test('OnlyFans catalog uses explicit platform metadata queries instead of a nonexistent studio/site binding', async () => {
  const definition = getCatalogDefinition('tpb4k.studio.onlyfans.top');
  assert.equal(definition.metadataMode, 'platform-query');
  const calls = [];
  const adapter = createStudioMetadataAdapter({
    env: {
      ONLYPORN_CONTENT_FILTER_ENABLED: 'true',
      ONLYPORN_FILTER_GAY: 'true',
      ONLYPORN_FILTER_INTERRACIAL: 'true',
      ONLYPORN_FILTER_UNKNOWN: 'false',
    },
    config: {
      metadataCatalogMaxPages: 2,
      contentFilterOverscanFactor: 3,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
      metadataCatalogConcurrency: 4,
    },
    metadataClients: {
      tpdb: {
        configured: true,
        async queryScenes(options) {
          calls.push(options);
          return [scene('of-1', {
            title: 'Creator Exclusive',
            code: '',
            details: 'Official OnlyFans creator release',
            site: { name: 'Independent' },
          })];
        },
        async findScene() { return null; },
      },
      stashdb: { configured: false },
    },
  });
  const items = await adapter.catalog({ catalog: definition, skip: 0, limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].studio, 'OnlyFans');
  assert.equal(calls[0].query, 'OnlyFans');
  assert.equal(calls[0].studio, undefined);
  assert.deepEqual(
    platformEvidence({ details: 'Published on Only Fans' }, { title: 'A', tags: [] }, ['OnlyFans', 'Only Fans']),
    { accepted: true, reason: 'explicit-platform-label' }
  );
});

test('StashDB network circuit opens after one failure and TPDB remains available for following catalogs', async () => {
  let stashCalls = 0;
  const adapter = createStudioMetadataAdapter({
    env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' },
    config: {
      metadataCatalogMaxPages: 1,
      contentFilterOverscanFactor: 1,
      metadataCacheMaxEntries: 100,
      metadataCacheTtlMs: 600000,
      metadataCatalogConcurrency: 4,
      metadataProviderCircuitTtlMs: 300000,
    },
    metadataClients: {
      tpdb: {
        configured: true,
        async queryScenes(options) { return [scene(`tpdb-${options.studio || options.query}`, { site: { name: options.studio || 'Vixen' } })]; },
        async findScene() { return null; },
      },
      stashdb: {
        configured: true,
        async resolveStudioIds() { stashCalls += 1; throw new Error('network fetch failed'); },
        async queryScenes() { return []; },
        async findScene() { return null; },
      },
    },
  });
  const vixen = getCatalogDefinition('tpb4k.studio.vixen.top');
  const sexart = getCatalogDefinition('tpb4k.studio.sexart.top');
  assert.equal((await adapter.catalog({ catalog: vixen, skip: 0, limit: 1 })).length, 1);
  assert.equal((await adapter.catalog({ catalog: sexart, skip: 0, limit: 1 })).length, 1);
  assert.equal(stashCalls, 1);
  assert.equal(adapter.diagnostics().metadataCatalog.providerCircuitOpen.stashdb, 1);
});
