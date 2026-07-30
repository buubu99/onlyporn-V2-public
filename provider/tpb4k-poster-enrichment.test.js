'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSceneIdentity } = require('./tpb4k/identity');
const { sceneInput } = require('./tpb4k/stashbox-client');
const { TpdbRestClient } = require('./tpb4k/tpdb-rest-client');
const {
  createPosterEnricher,
  extractTitleDate,
  fallbackPosterUrl,
  normalizeSearchTitle,
  scoreMetadataCandidate,
} = require('./tpb4k/poster-enrichment');

function headers(contentType = 'application/json') {
  return { get: name => String(name).toLowerCase() === 'content-type' ? contentType : '' };
}

test('torrent title cleanup extracts release date and removes technical release tags', () => {
  assert.deepEqual(extractTitleDate(
    'Vixen 26 07 29 Cruella The Night Shift XXX 2160p WEB-DL x265',
    'Vixen'
  ), {
    releaseDate: '2026-07-29',
    remaining: 'Cruella The Night Shift XXX 2160p WEB-DL x265',
  });
  assert.deepEqual(normalizeSearchTitle(
    'Vixen 26 07 29 Cruella The Night Shift XXX 2160p WEB-DL x265',
    'Vixen'
  ), {
    query: 'Cruella The Night Shift',
    releaseDate: '2026-07-29',
  });
});

test('fallback posters are stable credential-free HTTPS repository assets', () => {
  assert.equal(
    fallbackPosterUrl('DigitalPlayground'),
    'https://raw.githubusercontent.com/buubu99/onlyporn-V2-public/main/assets/tpb4k/studios/digitalplayground.png'
  );
  assert.throws(
    () => fallbackPosterUrl('Vixen', 'https://user:pass@example.com/assets'),
    /credential-free HTTPS/
  );
});

test('every configured fallback poster is a valid 600x900 PNG asset', () => {
  const keys = [
    'brazzersexxtra', 'cum4k', 'devilsfilm', 'digitalplayground', 'dorcelclub',
    'metart', 'metartx', 'milfty', 'milfy', 'newsensations', 'pornmegaload',
    'onlyfans', 'playboyplus', 'sexmex', 'thelifeerotic', 'vixen', 'wowgirls',
    'sexart', 'xvideosred', 'tpdb', 'pornrips', 'yesporn', 'hentai', 'sukebei',
    'stripchat', 'tpb4k',
  ];
  for (const key of keys) {
    const file = path.join(__dirname, '..', 'assets', 'tpb4k', 'studios', `${key}.png`);
    const buffer = fs.readFileSync(file);
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', file);
    assert.equal(buffer.readUInt32BE(16), 600, file);
    assert.equal(buffer.readUInt32BE(20), 900, file);
  }
});

test('StashDB scene input supports strict title and parent-studio searching', () => {
  const input = sceneInput({
    page: 1,
    perPage: 12,
    studio: 'Vixen',
    title: 'Cruella The Night Shift',
  });
  assert.equal(input.parentStudio, 'Vixen');
  assert.equal(input.title, 'Cruella The Night Shift');
  assert.equal(input.text, undefined);
});

test('TPDB REST scene search sends q, site, year and Bearer authorization', async () => {
  let observedUrl = '';
  let observedAuth = '';
  const client = new TpdbRestClient({
    endpoint: 'https://api.theporndb.net',
    apiKey: 'test-token',
    fetchImpl: async (url, options) => {
      observedUrl = String(url);
      observedAuth = options.headers.Authorization;
      return {
        ok: true,
        status: 200,
        headers: headers(),
        async text() { return JSON.stringify({ data: [] }); },
      };
    },
  });
  await client.queryScenes({
    query: 'Cruella The Night Shift',
    studio: 'Vixen',
    year: 2026,
    page: 1,
    perPage: 12,
    orderBy: 'date',
  });
  const url = new URL(observedUrl);
  assert.equal(url.searchParams.get('q'), 'Cruella The Night Shift');
  assert.equal(url.searchParams.get('site'), 'Vixen');
  assert.equal(url.searchParams.get('year'), '2026');
  assert.equal(url.searchParams.get('order_by'), 'date');
  assert.equal(observedAuth, 'Bearer test-token');
});

test('metadata matcher accepts strong same-studio title containment and rejects conflicts', () => {
  const source = {
    sourceId: 'hiddenbay:abc',
    title: 'Vixen 26 07 29 Cruella The Night Shift XXX 2160p',
    studio: 'Vixen',
    releaseDate: '2026-07-29',
  };
  const normalized = {
    title: 'Cruella: The Night Shift',
    studio: 'Vixen',
    releaseDate: '2026-07-29',
    poster: 'https://images.example/poster.jpg',
    sceneCode: '',
  };
  const accepted = scoreMetadataCandidate(source, { studio: { name: 'Vixen' } }, normalized);
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.score >= 0.8, accepted);

  const rejected = scoreMetadataCandidate(
    source,
    { studio: { name: 'DigitalPlayground' } },
    { ...normalized, studio: 'DigitalPlayground' }
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'studio-conflict');
});

test('poster enricher uses verified metadata without changing torrent identity', async () => {
  let requests = 0;
  const source = Object.freeze({
    sourceId: 'hiddenbay:0123456789',
    title: 'Vixen 26 07 29 Cruella The Night Shift XXX 2160p',
    description: 'TPB result',
    studio: 'Vixen',
    releaseDate: '2026-07-29',
    detailUrl: 'https://thehiddenbay.com/torrent/1/example',
  });
  const identity = buildSceneIdentity(source).digest;
  const enricher = createPosterEnricher({
    config: {
      metadataMatchThreshold: 72,
      metadataEnrichmentConcurrency: 2,
      metadataLookupTimeoutMs: 2000,
      metadataCacheTtlMs: 60000,
      metadataNegativeTtlMs: 10000,
      metadataCacheMaxEntries: 20,
    },
    clients: {
      stashdb: {
        configured: true,
        async queryScenes(options) {
          requests += 1;
          assert.equal(options.studio, 'Vixen');
          assert.equal(options.title, 'Cruella The Night Shift');
          return [{
            id: 'scene-1',
            title: 'Cruella The Night Shift',
            release_date: '2026-07-29',
            details: 'Verified metadata',
            studio: { name: 'Vixen' },
            images: [{ url: 'https://images.example/vixen-poster.jpg', width: 600, height: 900 }],
            performers: [{ performer: { name: 'Cruella' } }],
          }];
        },
      },
      tpdb: { configured: false },
    },
  });

  const first = await enricher.enrichItems([source]);
  assert.equal(first.items[0].sourceId, source.sourceId);
  assert.equal(first.items[0].title, source.title);
  assert.equal(first.items[0].poster, 'https://images.example/vixen-poster.jpg');
  assert.equal(first.items[0].posterSource, 'metadata:stashdb');
  assert.equal(first.items[0].sceneIdentity, identity);
  assert.equal(first.stats.matched, 1);

  const second = await enricher.enrichItems([source]);
  assert.equal(second.items[0].poster, 'https://images.example/vixen-poster.jpg');
  assert.equal(second.stats.cacheHits, 1);
  assert.equal(requests, 1);
});

test('poster enrichment bounds live metadata work and immediately falls back for remaining cards', async () => {
  let requests = 0;
  const items = Array.from({ length: 12 }, (_, index) => ({
    sourceId: `hiddenbay:bounded-${index}`,
    title: `Vixen 26 07 ${String(index + 1).padStart(2, '0')} Fixture Scene ${index}`,
    studio: 'Vixen',
  }));
  const enricher = createPosterEnricher({
    config: { metadataEnrichmentLimit: 3, metadataLookupTimeoutMs: 1000 },
    clients: {
      stashdb: { configured: true, async queryScenes() { requests += 1; return []; } },
      tpdb: { configured: false },
    },
  });
  const result = await enricher.enrichItems(items);
  assert.equal(result.items.length, 12);
  assert.equal(requests, 3);
  assert.equal(result.stats.attempted, 3);
  assert.equal(result.stats.skipped, 9);
  assert.equal(result.stats.fallback, 12);
  assert.equal(result.items.every(item => item.posterSource === 'fallback:studio'), true);
});

test('poster enricher guarantees a branded fallback when metadata is unavailable', async () => {
  const source = Object.freeze({
    sourceId: 'hiddenbay:fallback',
    title: 'DigitalPlayground 26 04 23 Sarah Arabic The Drifter Part 2 2160p',
    studio: 'DigitalPlayground',
  });
  const enricher = createPosterEnricher({ clients: {}, config: {} });
  const result = await enricher.enrichItems([source]);
  assert.equal(result.items[0].sourceId, source.sourceId);
  assert.equal(result.items[0].title, source.title);
  assert.match(result.items[0].poster, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.match(result.items[0].poster, /digitalplayground\.png$/);
  assert.equal(result.items[0].posterSource, 'fallback:studio');
  assert.equal(result.stats.fallback, 1);
});
