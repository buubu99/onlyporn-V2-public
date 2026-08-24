'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createRdCatalogSqliteStore, normalizeJavCode } = require('./rd-catalog-sqlite');
const { createSukebeiMetadataAdapter } = require('./tpb4k/sukebei-metadata');

const ORIGINAL = '0123456789abcdef0123456789abcdef01234567';
const REPLACEMENT = '89abcdef0123456789abcdef0123456789abcdef';
const PENDING = 'fedcba9876543210fedcba9876543210fedcba98';
const LATER_REPLACEMENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function report() {
  return {
    version: 'test-v1',
    generated_at: '2026-08-21T00:00:00Z',
    universe: 3,
    summary: { complete: 1, pending: 1, missing: 1 },
    records: [
      {
        batch: 1, position: 1, code: 'IPX-663', original_hash: ORIGINAL,
        final_state: 'COMPLETE', hash_relation: 'MODIFIED_NEW_HASH', current_hash: REPLACEMENT,
        current_rd_id: 'RD-COMPLETE', status: 'downloaded', progress: 100,
        filename: 'hhd800.com@IPX-663.mp4', file_index: 1,
        file_path: '/  hhd800.com@IPX-663.mp4', file_bytes: 7_625_857_315,
        match_source: 'CURRENT_FILENAME', candidate_count: 1,
      },
      {
        batch: 1, position: 2, code: 'CAWB-023', original_hash: PENDING,
        final_state: 'PENDING', hash_relation: 'UNCHANGED_ORIGINAL_HASH', current_hash: PENDING,
        current_rd_id: 'RD-PENDING', status: 'downloading', progress: 99.9,
        filename: 'CAWB-023.mp4', match_source: 'ORIGINAL_HASH', candidate_count: 1,
      },
      {
        batch: 1, position: 3, code: 'HND-895', original_hash: ORIGINAL,
        final_state: 'MISSING', hash_relation: 'NO_CURRENT_IMPLEMENTATION', current_hash: '',
        current_rd_id: '', status: '', progress: 0, filename: '', match_source: '', candidate_count: 0,
      },
    ],
  };
}

function env(root) {
  return {
    ONLYPORN_RUNTIME_DIR: root,
    ONLYPORN_DISABLE_PERSISTENT_CACHE: 'false',
    ONLYPORN_RD_CATALOG_ENABLED: 'true',
  };
}

test('RD audit import persists only verified downloaded hashes and exact MetaTube associations', async t => {
  const root = fs.mkdtempSync(path.join('/tmp', 'onlyporn-rd-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, 'audit.json');
  fs.writeFileSync(reportPath, JSON.stringify(report()));

  let store = createRdCatalogSqliteStore({ env: env(root) });
  const imported = await store.importReport(reportPath);
  assert.equal(imported.codes, 3);
  assert.equal(imported.complete, 1);
  assert.equal(imported.modifiedHashes, 1);
  assert.equal(imported.verifiedDownloadedHashes, 1);
  const importedMappings = await store.mappingsForCode('ipx 663');
  assert.deepEqual(importedMappings.map(row => row.infoHash), [REPLACEMENT]);
  assert.equal(importedMappings[0].fileIdx, 1);
  assert.equal(importedMappings[0].filePath, '/  hhd800.com@IPX-663.mp4');
  assert.equal(importedMappings[0].fileBytes, 7_625_857_315);
  assert.deepEqual(await store.mappingsForCode('CAWB-023'), []);
  assert.deepEqual(await store.mappingsForCode('HND-895'), []);

  const later = report();
  later.generated_at = '2026-09-21T00:00:00Z';
  later.universe = 1;
  later.summary = { complete: 1, pending: 0, missing: 0 };
  later.records = [{
    ...later.records[0], current_hash: LATER_REPLACEMENT, current_rd_id: 'RD-LATER',
    filename: 'IPX-663-later.mp4',
  }];
  const laterPath = path.join(root, 'later-audit.json');
  fs.writeFileSync(laterPath, JSON.stringify(later));
  await store.importReport(laterPath);
  assert.deepEqual(
    (await store.mappingsForCode('IPX-663')).map(row => row.infoHash),
    [LATER_REPLACEMENT, REPLACEMENT]
  );

  await store.upsertPoster('IPX-663', {
    id: 'JavBus:ipx663', title: 'IPX-663 title', poster: 'https://onlyporn.example/onlyporn/poster/metatube/a/b/c',
    background: 'https://onlyporn.example/onlyporn/poster/metatube/a/b/c', studio: { name: 'IdeaPocket' },
    performers: ['Actor'], tags: ['Uncensored'], release_date: '2026-01-01',
  });
  await store.close();

  store = createRdCatalogSqliteStore({ env: env(root) });
  assert.deepEqual(
    (await store.mappingsForCode('IPX-663')).map(row => row.infoHash),
    [LATER_REPLACEMENT, REPLACEMENT]
  );
  const posters = await store.postersForCodes(['IPX-663']);
  assert.equal(posters['IPX-663'].provider, 'JavBus');
  assert.equal(posters['IPX-663'].studio, 'IdeaPocket');
  assert.equal((await store.importReport(reportPath)).alreadyImported, true);
  await store.close();
});

test('Sukebei cards and resolver prefer the verified RD hash while retaining the live source hash', async () => {
  const rss = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item>
    <guid>https://sukebei.example/view/663</guid><title>(Uncensored) IPX663</title>
    <link>https://sukebei.example/view/663</link><nyaa:infoHash>${ORIGINAL}</nyaa:infoHash>
    <nyaa:seeders>12</nyaa:seeders><nyaa:size>2.0 GiB</nyaa:size>
  </item></channel></rss>`;
  const rdStore = {
    enabled: true,
    async mappingsForCodes(codes) {
      return Object.fromEntries(codes.map(code => [code, code === 'IPX-663' ? [{
        infoHash: REPLACEMENT, filename: 'hhd800.com@IPX-663.mp4', fileIdx: 1,
        filePath: '/hhd800.com@IPX-663.mp4', preferred: true,
      }] : []]));
    },
    async mappingsForCode(code) {
      return code === 'IPX-663' ? [{
        infoHash: REPLACEMENT, filename: 'hhd800.com@IPX-663.mp4', fileIdx: 1,
        filePath: '/hhd800.com@IPX-663.mp4',
      }] : [];
    },
    async postersForCodes() {
      return {
        'IPX-663': {
          title: 'Japanese presentation title without a code', poster: 'https://onlyporn.example/onlyporn/poster/metatube/a/b/c',
          background: 'https://onlyporn.example/onlyporn/poster/metatube/a/b/c', provider: 'JavBus',
          providerId: 'ipx663', studio: 'IdeaPocket', performers: ['Actor'], tags: ['Uncensored'],
        },
      };
    },
    async stats() { return { enabled: true, codes: 3, hashes: 1, posters: 1 }; },
  };
  const adapter = createSukebeiMetadataAdapter({
    endpoint: 'https://sukebei.example/?page=rss&c=0_0&f=0',
    checkDns: false,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/rss+xml' : '' },
      async text() { return rss; },
    }),
    env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' },
    rdCatalogStore: rdStore,
    config: {
      requestTimeoutMs: 5_000, metadataLookupTimeoutMs: 1_000,
      discoveryMaxResponseBytes: 2_000_000, discoveryCacheTtlMs: 60_000,
      discoveryNegativeTtlMs: 10_000, discoveryCacheMaxEntries: 50,
      metadataCacheMaxEntries: 50, metadataCacheTtlMs: 60_000,
      metadataNegativeTtlMs: 10_000, sukebeiRssPages: 1,
      sukebeiCodeLookupLimit: 0, sukebeiTitleLookupLimit: 0,
      sukebeiDetailImageLimit: 0, sukebeiEnrichmentDeadlineMs: 4_000,
    },
    metadataClients: {},
  });

  const [item] = await adapter.catalog({ catalog: { id: 'tpb4k.sukebei.top', mode: 'top' }, limit: 40 });
  assert.equal(item.poster, 'https://onlyporn.example/onlyporn/poster/metatube/a/b/c');
  assert.equal(item.sceneCode, 'IPX-663');
  assert.equal(item.sourceTitle, '(Uncensored) IPX663');
  assert.equal(item.title, 'Japanese presentation title without a code');
  assert.deepEqual(item.playbackCandidates.map(row => row.infoHash), [REPLACEMENT, ORIGINAL]);
  assert.equal(item.playbackCandidates[0].title, '(Uncensored) IPX663');
  const resolved = await adapter.resolve({ sourceId: item.sourceId, item });
  assert.deepEqual(resolved.map(row => row.infoHash), [REPLACEMENT, ORIGINAL]);
  assert.equal(resolved[0].fileIdx, 1);
  assert.equal(resolved[0].filename, '/hhd800.com@IPX-663.mp4');
  assert.equal(resolved[0].provenance.includes('rd-catalog-verified-downloaded'), true);
});

test('JAV normalization covers long prefixes from the real monthly report', () => {
  assert.equal(normalizeJavCode('fellatiojapan 333'), 'FELLATIOJAPAN-333');
  assert.equal(normalizeJavCode('IPX663'), 'IPX-663');
  assert.equal(normalizeJavCode('fc2 ppv 1234567'), 'FC2-PPV-1234567');
});
