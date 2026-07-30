'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSceneIdentity } = require('./tpb4k/identity');
const { readTpb4kConfig } = require('./tpb4k/config');
const { normalizeStudioName, studioAliases } = require('./tpb4k/metadata-normalize');
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

function scene(id, title, studio, date = '2026-07-29') {
  return {
    id,
    title,
    release_date: date,
    details: 'Verified metadata',
    studio: { name: studio },
    images: [{ url: `https://images.example/${id}.jpg`, width: 600, height: 900 }],
    performers: [],
  };
}

test('torrent title cleanup extracts full dates, compact dates and year-only prefixes', () => {
  assert.deepEqual(extractTitleDate(
    'Vixen 26 07 29 Cruella The Night Shift XXX 2160p WEB-DL x265',
    'Vixen'
  ), {
    releaseDate: '2026-07-29',
    releaseYear: '2026',
    remaining: 'Cruella The Night Shift XXX 2160p WEB-DL x265',
  });
  assert.deepEqual(extractTitleDate(
    'XVideosRED 2025 Cruella Pregnant Teen',
    'XVideosRED'
  ), {
    releaseDate: '',
    releaseYear: '2025',
    remaining: 'Cruella Pregnant Teen',
  });
  assert.deepEqual(extractTitleDate('Sex Art 20260716 Alice Example', 'SexArt'), {
    releaseDate: '2026-07-16',
    releaseYear: '2026',
    remaining: 'Alice Example',
  });
  assert.deepEqual(normalizeSearchTitle(
    'XVideosRED 2025 Cruella Pregnant Teen XXX 2160p WEB-DL x265 PRT',
    'XVideosRED'
  ), {
    query: 'Cruella Pregnant Teen',
    releaseDate: '',
    releaseYear: '2025',
  });
});

test('studio aliases canonicalize compact TPB names and provide provider-friendly queries', () => {
  assert.equal(normalizeStudioName('XVideos Red'), 'XVideosRED');
  assert.equal(normalizeStudioName('Digital Playground'), 'DigitalPlayground');
  assert.equal(normalizeStudioName("Devil's Film"), 'DevilsFilm');
  assert.equal(studioAliases('XVideosRED')[0], 'XVideos RED');
  assert.equal(studioAliases('DigitalPlayground')[0], 'Digital Playground');
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

test('alpha.14 retains bounded legacy enrichment for non-studio source cards', () => {
  const config = readTpb4kConfig({});
  assert.equal(config.metadataEnrichmentConcurrency, 10);
  assert.equal(config.metadataLookupTimeoutMs, 2500);
  assert.equal(config.metadataEnrichmentDeadlineMs, 16000);
  assert.equal(config.metadataPoolSize, 100);
  assert.equal('metadataEnrichmentLimit' in config, false);
});

test('StashDB scene input supports exact studio IDs plus optional title search', () => {
  const input = sceneInput({
    page: 1,
    perPage: 20,
    studioIds: ['xvideos-red-id'],
    title: 'Cruella Pregnant Teen',
  });
  assert.equal(input.title, 'Cruella Pregnant Teen');
  assert.deepEqual(input.studios, { value: ['xvideos-red-id'], modifier: 'INCLUDES' });
  assert.equal(Object.hasOwn(input, 'parentStudio'), false);
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
    perPage: 20,
    orderBy: 'date',
  });
  const url = new URL(observedUrl);
  assert.equal(url.searchParams.get('q'), 'Cruella The Night Shift');
  assert.equal(url.searchParams.get('site'), 'Vixen');
  assert.equal(url.searchParams.get('year'), '2026');
  assert.equal(url.searchParams.get('order_by'), 'date');
  assert.equal(observedAuth, 'Bearer test-token');
});

test('metadata matcher accepts aliases and strong title/date evidence but rejects studio conflicts', () => {
  const source = {
    sourceId: 'hiddenbay:abc',
    title: 'XVideosRED 2025 Cruella Pregnant Teen XXX 2160p',
    studio: 'XVideosRED',
  };
  const normalized = {
    title: 'Cruella Pregnant Teen',
    studio: 'XVideos RED',
    releaseDate: '2025-06-10',
    poster: 'https://images.example/poster.jpg',
    sceneCode: '',
  };
  const accepted = scoreMetadataCandidate(source, { site: { name: 'XVideos Red' } }, normalized);
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.score >= 0.8, accepted);

  const rejected = scoreMetadataCandidate(
    source,
    { studio: { name: 'Digital Playground' } },
    { ...normalized, studio: 'DigitalPlayground' }
  );
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'studio-conflict');
});

test('poster enricher uses a single studio pool and preserves all 40 torrent identities', async () => {
  let requests = 0;
  const items = Array.from({ length: 40 }, (_, index) => Object.freeze({
    sourceId: `hiddenbay:pool-${index}`,
    title: `Vixen 2025 Fixture Scene ${index}`,
    description: 'TPB result',
    studio: 'Vixen',
    detailUrl: `https://thehiddenbay.com/torrent/${index}/fixture`,
  }));
  const pool = items.map((item, index) => scene(`pool-${index}`, `Fixture Scene ${index}`, 'Vixen', '2025-06-10'));
  const enricher = createPosterEnricher({
    config: { metadataLookupTimeoutMs: 2000, metadataEnrichmentDeadlineMs: 12000 },
    clients: {
      stashdb: {
        configured: true,
        async queryScenes(options) {
          requests += 1;
          assert.equal(options.studio, 'Vixen');
          assert.equal(options.title, undefined);
          return pool;
        },
      },
      tpdb: { configured: false },
    },
  });

  const result = await enricher.enrichItems(items);
  assert.equal(result.items.length, 40);
  assert.equal(result.stats.eligible, 40);
  assert.equal(result.stats.attempted, 40);
  assert.equal(result.stats.skipped, 0);
  assert.equal(result.stats.matched, 40);
  assert.equal(result.stats.poolMatches, 40);
  assert.equal(result.stats.fallback, 0);
  assert.equal(requests, 1);
  for (let index = 0; index < items.length; index += 1) {
    assert.equal(result.items[index].sourceId, items[index].sourceId);
    assert.equal(result.items[index].title, items[index].title);
    assert.equal(result.items[index].sceneIdentity, buildSceneIdentity(items[index]).digest);
    assert.equal(result.items[index].posterSource, 'metadata:stashdb');
  }
});

test('all 40 unmatched pool records receive targeted lookup eligibility without a fixed item cap', async () => {
  let poolRequests = 0;
  let targetedRequests = 0;
  const items = Array.from({ length: 40 }, (_, index) => ({
    sourceId: `hiddenbay:target-${index}`,
    title: `XVideosRED 2025 Target Scene ${index}`,
    studio: 'XVideosRED',
  }));
  const enricher = createPosterEnricher({
    config: {
      metadataEnrichmentConcurrency: 12,
      metadataLookupTimeoutMs: 2000,
      metadataEnrichmentDeadlineMs: 15000,
    },
    clients: {
      stashdb: {
        configured: true,
        async queryScenes(options) {
          if (!options.title) {
            poolRequests += 1;
            return [];
          }
          targetedRequests += 1;
          const index = Number(options.title.match(/(\d+)$/)?.[1]);
          return [scene(`target-${index}`, `Target Scene ${index}`, 'XVideos Red', '2025-04-01')];
        },
      },
      tpdb: { configured: false },
    },
  });
  const result = await enricher.enrichItems(items);
  assert.equal(result.stats.eligible, 40);
  assert.equal(result.stats.attempted, 40);
  assert.equal(result.stats.skipped, 0);
  assert.equal(result.stats.targetedMatches, 40);
  assert.equal(result.stats.matched, 40);
  assert.equal(result.stats.fallback, 0);
  assert.equal(poolRequests, 2);
  assert.equal(targetedRequests, 40);
  assert.equal(result.items.every(item => item.posterSource === 'metadata:stashdb'), true);
});

test('network errors and timeouts are not negative-cached', async () => {
  let requests = 0;
  const item = { sourceId: 'hiddenbay:retry', title: 'Vixen 2025 Retry Scene', studio: 'Vixen' };
  const enricher = createPosterEnricher({
    config: { metadataLookupTimeoutMs: 1000, metadataEnrichmentDeadlineMs: 5000 },
    clients: {
      stashdb: {
        configured: true,
        async queryScenes() {
          requests += 1;
          throw new Error('temporary upstream failure');
        },
      },
      tpdb: { configured: false },
    },
  });
  const first = await enricher.enrichItems([item]);
  const afterFirst = requests;
  const second = await enricher.enrichItems([item]);
  assert.equal(first.items[0].posterSource, 'fallback:studio');
  assert.equal(second.items[0].posterSource, 'fallback:studio');
  assert.ok(requests > afterFirst, { requests, afterFirst });
  assert.equal(first.stats.notFound, 0);
  assert.equal(second.stats.negativeCacheHits, 0);
});

test('confirmed metadata not-found is briefly negative-cached', async () => {
  let requests = 0;
  const item = { sourceId: 'hiddenbay:not-found', title: 'Vixen 2025 Missing Scene', studio: 'Vixen' };
  const enricher = createPosterEnricher({
    config: { metadataNegativeTtlMs: 60000, metadataLookupTimeoutMs: 1000 },
    clients: {
      stashdb: {
        configured: true,
        async queryScenes() { requests += 1; return []; },
      },
      tpdb: { configured: false },
    },
  });
  const first = await enricher.enrichItems([item]);
  const afterFirst = requests;
  const second = await enricher.enrichItems([item]);
  assert.equal(first.stats.notFound, 1);
  assert.equal(second.stats.negativeCacheHits, 1);
  assert.equal(requests, afterFirst);
});

test('poster enricher guarantees a clean branded fallback when metadata is unavailable', async () => {
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
  assert.equal(result.stats.skipped, 0);
});
