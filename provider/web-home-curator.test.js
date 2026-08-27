'use strict';

const test = require('node:test');
const assert = require('node:assert').strict;
const {
  AI_HOME_PROVIDERS,
  HOME_LIMIT,
  SOURCE_PLANS,
  arrangeCandidates,
  bucketEvidenceReason,
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
  const requiredStarBuckets = [
    'popular-followed-stars',
    'award-winning-stars',
    'webcam-stars',
    'social-influencers',
    'cosplay-creators',
  ];
  for (const [provider, plan] of Object.entries(SOURCE_PLANS)) {
    assert.equal(plan.reduce((total, item) => total + item.quota, 0), HOME_LIMIT, provider);
    assert.ok(plan.length <= 7, `${provider} exceeds the two-wave source budget`);
    for (const bucket of requiredStarBuckets) {
      assert.equal(plan.some(item => item.bucket === bucket), true, `${provider}:${bucket}`);
    }
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
  assert.deepEqual(
    SOURCE_PLANS.porntrex.find(item => item.bucket === 'native-quality'),
    {
      kind: 'url',
      value: 'https://www.porntrex.com/most-favourited/',
      bucket: 'native-quality',
      quota: 4,
    }
  );
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
  assert.equal(evaluateHomeCandidate(preview('6', 'Transgender superstar'), filterConfig).reason, 'EXCLUDED_PRESENTATION');
  assert.equal(evaluateHomeCandidate(preview('7', 'Shemale creator'), filterConfig).reason, 'EXCLUDED_PRESENTATION');
  assert.equal(posterReason('https://cdn.example.test/default.jpg'), 'PLACEHOLDER');
  assert.equal(posterReason('https://cdn.example.test/small/poster.jpg'), 'LOW_RESOLUTION');
  assert.equal(posterReason('http://cdn.example.test/poster.jpg'), 'BROKEN_IMAGE');
});

test('candidate arrangement enforces source quotas and cross-source deduplication', () => {
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
    [duplicate.id, preview('safe-1').id, preview('safe-2').id, preview('ordinary').id, preview('ai').id]
  );
  assert.equal(arranged.reasons.PROHIBITED_AGE, 1);
  assert.ok(arranged.reasons.DUPLICATE >= 1);
});

test('every requested star bucket requires exact evidence from full metadata', () => {
  const examples = [
    ['popular-followed-stars', 'Most followed top pornstar'],
    ['award-winning-stars', 'AVN award winning performer'],
    ['webcam-stars', 'Top live cam model'],
    ['social-influencers', 'Instagram and TikTok influencer'],
    ['cosplay-creators', 'Cosplay creator'],
    ['ai', 'AI generated model'],
  ];
  for (const [bucket, title] of examples) {
    assert.equal(bucketEvidenceReason(bucket, preview(`good-${bucket}`, title)), '', bucket);
    assert.match(
      bucketEvidenceReason(bucket, preview(`bad-${bucket}`, 'Unrelated generic result')),
      /EVIDENCE_MISSING$/,
      bucket
    );
  }
  assert.equal(bucketEvidenceReason('native-quality', preview('native')), '');
});

test('strict detail validation rejects search pollution and retains native fallback cards', async () => {
  const provider = {
    name: 'xvideos',
    async fetchHtml(id) { return id; },
    parseVideoPage({ id }) {
      const native = id.includes('native');
      return {
        metaResponse: preview(id.split('.').pop(), native ? 'Safe native favorite' : 'Unrelated result'),
        directMp4Streams: [{ url: 'https://media.example.test/video.mp4' }],
      };
    },
  };
  const arranged = {
    candidates: [
      { meta: preview('polluted'), descriptor: { bucket: 'webcam-stars' } },
      { meta: preview('native'), descriptor: { bucket: 'native-quality' } },
    ],
    reasons: {},
  };
  const result = await _test.validateCandidates(provider, arranged, filterConfig, Date.now());
  assert.equal(result.metas.length, 1);
  assert.match(result.metas[0].name, /native/i);
  assert.equal(result.reasons.WEBCAM_STARS_EVIDENCE_MISSING, 1);
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

test('detail validation obeys the global Home deadline even when upstream detail pages hang', async () => {
  const provider = {
    name: 'xvideos',
    async fetchHtml() {
      return new Promise(() => {});
    },
    parseVideoPage() {
      throw new Error('unreachable');
    },
  };
  const arranged = {
    candidates: Array.from({ length: 16 }, (_, index) => ({ meta: preview(`hung-${index}`) })),
    reasons: {},
  };
  const startedAt = Date.now();
  const result = await _test.validateCandidates(
    provider,
    arranged,
    filterConfig,
    startedAt,
    { totalBudgetMs: 100, detailTimeoutMs: 5_000 }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.metas.length, 0);
  assert.equal(result.deadlineReached, true);
  assert.ok(result.reasons.GLOBAL_DEADLINE >= 1);
  assert.ok(elapsedMs < 500, `deadline overran: ${elapsedMs}ms`);
});
