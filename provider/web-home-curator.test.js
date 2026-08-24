'use strict';

const test = require('node:test');
const assert = require('node:assert').strict;
const {
  AI_HOME_PROVIDERS,
  HOME_LIMIT,
  SOURCE_PLANS,
  arrangeCandidates,
  curateWebHome,
  evaluateHomeCandidate,
  posterReason,
  shouldCurateWebHome,
  sourcePlanFor,
  _test,
} = require('./web-home-curator');
const { readContentFilterConfig } = require('./content-filter');

const filterConfig = readContentFilterConfig({
  ONLYPORN_CONTENT_FILTER_ENABLED: 'true',
  ONLYPORN_FILTER_GAY: 'true',
  ONLYPORN_FILTER_INTERRACIAL: 'true',
});

function preview(id, name = `Safe HD title ${id}`) {
  return {
    id: `https://www.xvideos.com/video.${id}`,
    type: 'movie',
    name,
    poster: `https://cdn.example.test/posters/${id}-1280x720.jpg`,
    posterShape: 'landscape',
  };
}

test('web Home plans publish 40 slots and reserve only four global AI positions', () => {
  let aiSlots = 0;
  for (const [provider, plan] of Object.entries(SOURCE_PLANS)) {
    assert.equal(plan.reduce((total, item) => total + item.quota, 0), HOME_LIMIT, provider);
    const providerAi = plan.filter(item => item.bucket === 'ai');
    if (AI_HOME_PROVIDERS.has(provider)) {
      assert.equal(providerAi.length, 1, provider);
      assert.equal(providerAi[0].quota, 1, provider);
      aiSlots += providerAi[0].quota;
    } else {
      assert.equal(providerAi.length, 0, provider);
    }
  }
  assert.equal(aiSlots, 4);
  const bestPlan = sourcePlanFor({ name: 'xhamster' }, { id: 'xhamster.best' });
  assert.equal(bestPlan.reduce((total, item) => total + item.quota, 0), HOME_LIMIT);
  assert.equal(bestPlan.some(item => item.bucket === 'ai'), false);
  assert.equal(sourcePlanFor({ name: 'xhamster' }, { id: 'xhamster.trending' }).some(item => item.bucket === 'ai'), true);
});

test('curation activates only for an unfiltered first Home page', () => {
  const provider = { name: 'xvideos' };
  assert.equal(shouldCurateWebHome(provider, { extra: {} }), true);
  assert.equal(shouldCurateWebHome(provider, { extra: { skip: 0 } }), true);
  assert.equal(shouldCurateWebHome(provider, { extra: { search: 'wife' } }), false);
  assert.equal(shouldCurateWebHome(provider, { extra: { genre: 'Japanese' } }), false);
  assert.equal(shouldCurateWebHome(provider, { extra: { skip: 40 } }), false);
  assert.equal(shouldCurateWebHome({ name: 'javhdporn' }, { extra: {} }), false);
  assert.equal(shouldCurateWebHome({ name: 'tpb4k' }, { extra: {} }), false);
});

test('strict Home evaluation blocks prohibited age, older, graphic, global, and bad-poster evidence', () => {
  assert.equal(evaluateHomeCandidate(preview('1'), filterConfig).excluded, false);
  assert.equal(evaluateHomeCandidate(preview('2', 'Barely legal teen'), filterConfig).reason, 'PROHIBITED_AGE');
  assert.equal(evaluateHomeCandidate(preview('3', 'Mature granny'), filterConfig).reason, 'OLDER_CONTENT');
  assert.equal(evaluateHomeCandidate(preview('4', 'Hidden camera forced scene'), filterConfig).reason, 'GRAPHIC_CONTENT');
  assert.match(evaluateHomeCandidate(preview('5', 'Interracial scene'), filterConfig).reason, /^PROHIBITED_TAG:/);
  assert.equal(posterReason('https://cdn.example.test/default.jpg'), 'PLACEHOLDER');
  assert.equal(posterReason('https://cdn.example.test/small/poster.jpg'), 'LOW_RESOLUTION');
  assert.equal(posterReason('http://cdn.example.test/poster.jpg'), 'BROKEN_IMAGE');
});

test('candidate arrangement enforces source quotas, exact AI evidence, and cross-source deduplication', () => {
  const plan = SOURCE_PLANS.xvideos;
  const aiSource = plan.find(item => item.bucket === 'ai');
  const duplicate = preview('duplicate');
  const sourceResults = [
    { descriptor: plan[0], metas: [duplicate, preview('safe-1'), preview('bad-age', 'Schoolgirl scene')] },
    { descriptor: plan[1], metas: [duplicate, preview('safe-2')] },
    { descriptor: aiSource, metas: [preview('ordinary'), preview('ai', 'AI generated model')] },
  ];
  const arranged = arrangeCandidates(sourceResults, plan, filterConfig);
  assert.deepEqual(
    arranged.candidates.map(item => item.meta.id),
    [duplicate.id, preview('safe-1').id, preview('safe-2').id, preview('ai').id]
  );
  assert.equal(arranged.reasons.PROHIBITED_AGE, 1);
  assert.equal(arranged.reasons.AI_EVIDENCE_MISSING, 1);
  assert.ok(arranged.reasons.DUPLICATE >= 1);
});

test('curated Home validates detail playback, enriches metadata, and caches the result', async () => {
  _test.homeCache.clear();
  _test.lastKnownGoodCache.clear();
  _test.pendingHomes.clear();
  let sourceCalls = 0;
  let detailCalls = 0;
  const provider = {
    name: 'xvideos',
    limit: 50,
    async _fetchCatalogPage(args) {
      sourceCalls += 1;
      const marker = args.extra?.search || args.extra?.genre || args.extra?.skip || 'home';
      return Array.from({ length: 14 }, (_, index) => {
        const ai = marker === 'AI generated';
        return preview(`${String(marker).replace(/\W+/g, '-')}-${index}`, ai
          ? `AI generated model ${index}`
          : `Safe HD title ${marker} ${index}`);
      });
    },
    async _fetchCatalogUrl(args, url) {
      return this._fetchCatalogPage({ ...args, extra: { search: new URL(url).pathname } });
    },
    async fetchHtml(id) {
      detailCalls += 1;
      return id;
    },
    parseVideoPage({ id }) {
      return {
        metaResponse: {
          ...preview(id.split('.').pop(), `Enriched ${id.split('.').pop()}`),
          id,
          description: 'Verified detail metadata',
        },
        directMp4Streams: [{ url: 'https://media.example.test/video.mp4' }],
      };
    },
  };

  const args = { type: 'movie', id: 'xvideos', extra: {} };
  const first = await curateWebHome(provider, args);
  assert.equal(first.length, HOME_LIMIT);
  assert.equal(first[0].posterShape, 'landscape');
  assert.match(first[0].description, /Verified/);
  assert.equal(sourceCalls, SOURCE_PLANS.xvideos.length);
  assert.ok(detailCalls >= HOME_LIMIT);

  const second = await curateWebHome(provider, args);
  assert.deepEqual(second, first);
  assert.equal(sourceCalls, SOURCE_PLANS.xvideos.length);
});
