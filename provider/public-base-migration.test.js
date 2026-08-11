'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { javPosterProxyUrl, decodeSource } = require('./javhdporn-poster-proxy');

const SOURCE = 'https://pics.pornfhd.com/s/mono/movie/adult/example/examplepl.jpg';

test('JAVHDPorn poster proxy honors ADDON_BASE_URL on OVH', () => {
  const url = javPosterProxyUrl(SOURCE, { ADDON_BASE_URL: 'https://onlyv2.example' });
  assert.match(url, /^https:\/\/onlyv2\.example\/onlyporn\/poster\/javhdporn\//);
  assert.equal(decodeSource(url.split('/').pop()), SOURCE);
});

test('JAVHDPorn poster proxy default is OVH when explicit public variables are absent', () => {
  const url = javPosterProxyUrl(SOURCE, {});
  assert.match(url, /^https:\/\/onlyv2\.51-79-157-182\.sslip\.io\/onlyporn\/poster\/javhdporn\//);
});
