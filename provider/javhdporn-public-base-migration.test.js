'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  javPosterProxyUrl,
  decodeSource,
} = require('./javhdporn-poster-proxy');

const SOURCE = 'https://pics.pornfhd.com/s/mono/movie/adult/example/examplepl.jpg';

test('JAVHDPorn poster proxy honors ADDON_BASE_URL on non-Render deployments', () => {
  const url = javPosterProxyUrl(SOURCE, {
    ADDON_BASE_URL: 'https://onlyv2.example',
  });
  assert.match(url, /^https:\/\/onlyv2\.example\/onlyporn\/poster\/javhdporn\//);
  assert.equal(decodeSource(url.split('/').pop()), SOURCE);
});

test('explicit ONLYPORN_PUBLIC_BASE_URL has highest priority', () => {
  const url = javPosterProxyUrl(SOURCE, {
    ONLYPORN_PUBLIC_BASE_URL: 'https://explicit.example',
    ADDON_BASE_URL: 'https://addon.example',
    RENDER_EXTERNAL_URL: 'https://render.example',
  });
  assert.match(url, /^https:\/\/explicit\.example\/onlyporn\/poster\/javhdporn\//);
});

test('ADDON_BASE_URL beats historical Render environment/fallback', () => {
  const url = javPosterProxyUrl(SOURCE, {
    ADDON_BASE_URL: 'https://ovh.example',
    RENDER_EXTERNAL_URL: 'https://old-render.example',
  });
  assert.match(url, /^https:\/\/ovh\.example\/onlyporn\/poster\/javhdporn\//);
});
