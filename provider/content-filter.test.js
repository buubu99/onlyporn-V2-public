'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluateContent,
  filterCatalogResponse,
  filterManifestCatalogs,
  filterMetaResponse,
  filterStreamResponse,
  readContentFilterConfig,
} = require('./content-filter');

function config(extra = {}) {
  return readContentFilterConfig({
    ONLYPORN_CONTENT_FILTER_ENABLED: 'true',
    ONLYPORN_FILTER_GAY: 'true',
    ONLYPORN_FILTER_INTERRACIAL: 'true',
    ONLYPORN_FILTER_UNKNOWN: 'false',
    ONLYPORN_FILTER_STRONG_TEXT: 'true',
    ...extra,
  });
}

test('global filter blocks explicit gay and male-male labels', () => {
  for (const tags of [['Gay'], ['Male/Male'], ['Male / Male'], ['Bisexual Male']]) {
    const result = evaluateContent({ tags }, config());
    assert.equal(result.excluded, true, tags.join(','));
    assert.equal(result.reason, 'gay');
  }
});

test('global filter blocks explicit interracial and black-male labels', () => {
  for (const tags of [
    ['Interracial'], ['Blacked'], ['Black Male'], ['Black Man'],
    ['Black Cock'], ['BBC'], ['BBCs'], ['BCC'],
  ]) {
    const result = evaluateContent({ tags }, config());
    assert.equal(result.excluded, true, tags.join(','));
    assert.equal(result.reason, 'interracial');
  }
});

test('filter does not infer race or orientation from a poster, performer name, or broad ebony label', () => {
  const item = {
    title: 'Romantic Outdoor Scene',
    poster: 'https://images.example/scene.jpg',
    performers: ['Example Performer'],
    tags: ['Ebony', 'Outdoor'],
    contentClassificationKnown: true,
  };
  assert.equal(evaluateContent(item, config()).excluded, false);
});

test('strong explicit title text is filtered while neutral text remains', () => {
  assert.equal(evaluateContent({ title: 'Interracial Couple Scene' }, config()).excluded, true);
  assert.equal(evaluateContent({ title: 'BLACKED scene with a huge black cock' }, config()).excluded, true);
  assert.equal(evaluateContent({ title: 'Two BBCs For Service' }, config()).excluded, true);
  assert.equal(evaluateContent({ title: 'Juniper Loves BCC In The Shower' }, config()).excluded, true);
  assert.equal(evaluateContent({ title: 'Two Women Romantic Scene' }, config()).excluded, false);
});

test('custom excluded tags and strict unknown policy are configurable', () => {
  assert.equal(
    evaluateContent({ tags: ['Custom Block'] }, config({ ONLYPORN_FILTER_EXCLUDED_TAGS: 'Custom Block' })).excluded,
    true
  );
  assert.equal(
    evaluateContent(
      { contentClassificationKnown: false },
      config({ ONLYPORN_FILTER_UNKNOWN: 'true' })
    ).reason,
    'unknown'
  );
});

test('catalog, metadata and stream response helpers remove explicitly labelled objects', () => {
  const safe = { id: 'safe', name: 'Safe', tags: ['Outdoor'] };
  const blocked = { id: 'blocked', name: 'Blocked', tags: ['Gay'] };
  const catalog = filterCatalogResponse({ metas: [safe, blocked] }, config());
  assert.deepEqual(catalog.response.metas.map(item => item.id), ['safe']);
  assert.equal(catalog.removed, 1);

  const meta = filterMetaResponse({ meta: blocked }, config());
  assert.deepEqual(meta.response.meta, {});
  assert.equal(meta.removed, 1);

  const streams = filterStreamResponse({ streams: [safe, blocked] }, config());
  assert.deepEqual(streams.response.streams.map(item => item.id), ['safe']);
  assert.equal(streams.removed, 1);
});

test('manifest genre options are filtered by the same global policy', () => {
  const result = filterManifestCatalogs([
    {
      id: 'example',
      extra: [{ name: 'genre', options: ['Asian', 'Interracial', 'Male / Male', 'Ebony'] }],
    },
  ], config());
  assert.deepEqual(result.catalogs[0].extra[0].options, ['Asian', 'Ebony']);
  assert.equal(result.removedOptions, 2);
  assert.deepEqual(result.reasons, { interracial: 1, gay: 1 });
});
