'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const createJavHdPorn = require('./javhdporn');

const {
  JAV_HOME_FAMILIES,
  JAV_HOME_FAMILY_COUNT,
  JAV_HOME_ROTATION_MS,
  isJavCodeFamilyTitle,
  rotatingJavFamilies,
} = createJavHdPorn._test;

test('JAVHD rotating Home accepts real family codes and rejects surname text matches', () => {
  assert.equal(isJavCodeFamilyTitle('SONE-622 Uncensored release', 'SONE'), true);
  assert.equal(isJavCodeFamilyTitle('JRZD-386 Chieko Sone documentary', 'SONE'), false);
  assert.equal(isJavCodeFamilyTitle('FC2 PPV 4908412 Office Lady', 'FC2 PPV'), true);
  assert.equal(isJavCodeFamilyTitle('FC2 introduction without an identifier', 'FC2 PPV'), false);
});

test('JAVHD Home family selection is stable, unique, and rotates by time or page', () => {
  const first = rotatingJavFamilies(100, 1);
  assert.equal(first.length, JAV_HOME_FAMILY_COUNT);
  assert.equal(new Set(first).size, first.length);
  assert.ok(first.every(family => JAV_HOME_FAMILIES.includes(family)));
  assert.deepEqual(rotatingJavFamilies(100, 1), first);
  assert.notDeepEqual(rotatingJavFamilies(101, 1), first);
  assert.notDeepEqual(rotatingJavFamilies(100, 2), first);
});

test('JAVHD Home interleaves five code-family searches and caches the 24-card rotation', async () => {
  const provider = createJavHdPorn();
  const fixedNow = 100 * JAV_HOME_ROTATION_MS;
  provider.homeClock = () => fixedNow;
  provider.postProcessCatalogMetas = async items => items;
  const requested = [];
  provider.fetchHtml = async value => {
    const url = new URL(String(value));
    const family = url.searchParams.get('s');
    requested.push(family);
    const slug = family.toLowerCase().replace(/\s+/g, '-');
    const cards = Array.from({ length: 7 }, (_, index) => {
      const number = family === 'FC2 PPV' ? 4_900_000 + index : 100 + index;
      return `<article class="thumb-block loop-video">
        <a href="/video/${slug}-${number}/" title="${family}-${number} Rotating fixture">
          <img src="https://pics.pornfhd.com/${slug}-${number}.jpg" alt="${family}-${number}">
        </a>
      </article>`;
    }).join('');
    const falsePositive = family === 'SONE'
      ? '<article class="thumb-block loop-video"><a href="/video/jrzd-386/"><img src="https://pics.pornfhd.com/jrzd.jpg" alt="JRZD-386 Chieko Sone documentary"></a></article>'
      : '';
    return `<html><body>${falsePositive}${cards}</body></html>`;
  };

  const args = { type: 'movie', id: 'javhdporn', extra: {} };
  const response = await provider.handleCatalog(args);
  const selected = rotatingJavFamilies(100, 1);
  assert.deepEqual(requested, selected);
  assert.equal(response.metas.length, 24);
  assert.equal(new Set(response.metas.map(item => item.id)).size, 24);
  assert.ok(response.metas.every(item => item.id.startsWith('onlyporn:javhdporn:')));
  assert.deepEqual(
    response.metas.slice(0, JAV_HOME_FAMILY_COUNT).map(item => selected.find(family => isJavCodeFamilyTitle(item.name, family))),
    selected
  );
  assert.ok(response.metas.every(item => !/JRZD-386/i.test(item.name)));

  const cached = await provider.handleCatalog(args);
  assert.equal(cached, response);
  assert.equal(requested.length, JAV_HOME_FAMILY_COUNT);

  provider.homeClock = () => fixedNow + JAV_HOME_ROTATION_MS;
  provider.fetchHtml = async () => { throw new Error('temporary JAVHD outage'); };
  const stale = await provider.handleCatalog(args);
  assert.equal(stale, response, 'a failed rotation must keep the last known good mixed Home');
});
