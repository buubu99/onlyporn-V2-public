'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const createJavHdPorn = require('./javhdporn');

test('JAVHD extracts exact catalog codes for MetaTube without guessing prose', () => {
  const { extractJavSceneCode } = createJavHdPorn._test;
  assert.equal(extractJavSceneCode('SONE-620 Uncensored'), 'SONE-620');
  assert.equal(extractJavSceneCode('FC2 PPV 4908412 Office Lady'), 'FC2-PPV-4908412');
  assert.equal(extractJavSceneCode('A title without a release code'), '');
});

test('JAVHD catalog cards use exact MetaTube artwork as portrait posters', async () => {
  const lookups = [];
  const metatubePoster =
    'https://onlyv2.example/onlyporn/poster/metatube/provider/id/signature';
  const provider = createJavHdPorn({
    env: {},
    metatubeClient: {
      configured: true,
      async searchExact(code, timeoutMs) {
        lookups.push({ code, timeoutMs });
        return { poster: metatubePoster };
      },
    },
  });
  const cards = provider.getCatalogMetas(`
    <article class="thumb-block loop-video">
      <a href="/video/sone-620/" title="SONE-620 Uncensored">
        <img src="https://pics.pornfhd.com/sone-620.jpg" alt="SONE-620">
      </a>
    </article>
  `);

  assert.equal(cards[0].posterShape, 'poster');
  const enriched = await provider.postProcessCatalogMetas(cards);
  assert.deepEqual(lookups.map(item => item.code), ['SONE-620']);
  assert.equal(enriched[0].poster, metatubePoster);
  assert.equal(enriched[0].posterShape, 'poster');
});

test('JAVHD keeps verified native artwork as a portrait fallback when MetaTube misses', async () => {
  const provider = createJavHdPorn({
    env: {},
    metatubeClient: {
      configured: true,
      async searchExact() { return null; },
    },
  });
  provider.metatubeTimeoutMs = 5_000;
  const item = {
    id: 'https://www.javhdporn.net/video/sone-620/',
    name: 'SONE-620',
    poster: 'https://onlyv2.example/onlyporn/poster/javhdporn/invalid-fixture',
    posterShape: 'landscape',
  };

  const results = await provider.postProcessCatalogMetas([item]);
  assert.equal(results.length, 1, 'a narrow result must survive a poster miss');
  assert.equal(results[0].poster, item.poster);
  assert.equal(results[0].posterShape, 'poster');
});

test('JAVHD relay narrowly accepts the observed StreamHLS child CDN', () => {
  const accepted = 'https://video.qooglecdn.com/token/segment-1.ts';
  assert.equal(mediaRelay._test.validateTargetUrl(accepted, 'javhdporn'), accepted);
  assert.throws(
    () => mediaRelay._test.validateTargetUrl(
      'https://qooglecdn.com.evil.example/token/segment-1.ts',
      'javhdporn'
    ),
    /not approved/
  );
  assert.throws(
    () => mediaRelay._test.validateTargetUrl(accepted, 'xvideos'),
    /not approved/
  );
});
