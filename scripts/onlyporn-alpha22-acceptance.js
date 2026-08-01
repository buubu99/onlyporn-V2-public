#!/usr/bin/env node
'use strict';

const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');

const BASE = String(process.env.ONLYPORN_RENDER_BASE_URL || 'https://onlyporn-v2-public-k143.onrender.com').replace(/\/$/, '');
const EXPECTED = process.env.EXPECTED_VERSION || '2.7.0-alpha.22';
const STUDIOS = [
  'brazzersexxtra', 'cum4k', 'devilsfilm', 'digitalplayground', 'dorcelclub',
  'metart', 'metartx', 'milfty', 'milfy', 'newsensations', 'pornmegaload',
  'onlyfans', 'playboyplus', 'sexmex', 'thelifeerotic', 'vixen', 'wowgirls',
  'sexart', 'xvideosred',
].map(name => `tpb4k.studio.${name}.top`);
const MINIMUMS = Object.freeze({
  'tpb4k.studio.onlyfans.top': 20,
  'tpb4k.studio.digitalplayground.top': 8,
  'tpb4k.studio.xvideosred.top': 8,
  'tpb4k.studio.sexmex.top': 8,
});
const issues = [];

function issue(section, message) {
  issues.push({ section, message: String(message) });
  console.error(`ISSUE [${section}]: ${message}`);
}
async function json(path, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}a22=${Date.now()}-${Math.random()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
function bundleHashes(id) {
  try {
    return (decodeTpb4kId(id)?.torrents || []).map(item => String(item.infoHash || '').toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}
async function stream(type, id) {
  return json(`/stream/${type}/${encodeURIComponent(id)}.json`, 60_000);
}
async function meta(type, id) {
  return json(`/meta/${type}/${encodeURIComponent(id)}.json`, 60_000);
}

(async () => {
  const manifest = await json('/manifest.json', 30_000);
  const catalogs = Array.isArray(manifest.catalogs) ? manifest.catalogs : [];
  const internal = catalogs.filter(item => String(item?.id || '').startsWith('tpb4k.'));
  const resources = Object.fromEntries((manifest.resources || [])
    .filter(item => item && typeof item === 'object')
    .map(item => [item.name, item]));
  if (manifest.version !== EXPECTED
    || catalogs.length !== 38
    || internal.length !== 29
    || JSON.stringify(resources.stream?.idPrefixes || []) !== JSON.stringify(['onlyporn:', 'ophmm-'])
    || JSON.stringify(resources.meta?.idPrefixes || []) !== JSON.stringify(['onlyporn:', 'ophmm-'])) {
    console.error('HARD_FAIL: manifest/version/ownership contract failed');
    process.exit(2);
  }
  console.log(`PASS hard contract: ${EXPECTED}, 38/29, private prefixes`);

  const rounds = [];
  for (let round = 1; round <= 2; round += 1) {
    console.log(`CATALOG CONCURRENCY ROUND ${round}`);
    const results = await Promise.all(STUDIOS.map(async catalogId => {
      try {
        const body = await json(`/catalog/movie/${catalogId}.json`, 90_000);
        const metas = Array.isArray(body.metas) ? body.metas : [];
        console.log(`CHECK ${catalogId}: ${metas.length} cards`);
        return { catalogId, metas };
      } catch (error) {
        issue(catalogId, `catalog request failed in round ${round}: ${error.message}`);
        return { catalogId, metas: [] };
      }
    }));
    rounds.push(results);
  }

  const finalRound = new Map(rounds[1].map(value => [value.catalogId, value.metas]));
  for (const catalogId of STUDIOS) {
    const first = rounds[0].find(value => value.catalogId === catalogId)?.metas || [];
    const second = finalRound.get(catalogId) || [];
    const minimum = MINIMUMS[catalogId] || 1;
    if (first.length < minimum || second.length < minimum) {
      issue(catalogId, `inconsistent catalogue: round1=${first.length}, round2=${second.length}, minimum=${minimum}`);
    }
    for (const item of second.slice(0, 5)) {
      try {
        const expectedHashes = bundleHashes(item.id);
        if (!expectedHashes.length) throw new Error('card has no bound torrent');
        const result = await stream('movie', item.id);
        const returned = [...new Set((result.streams || [])
          .map(value => String(value.infoHash || '').toLowerCase())
          .filter(Boolean))];
        if (!returned.length) throw new Error('card returned no stream');
        if (expectedHashes.some(hash => !returned.includes(hash))) {
          throw new Error(`encoded ${expectedHashes.length} hashes but returned ${returned.length}`);
        }
      } catch (error) {
        issue(catalogId, `${item.id}: ${error.message}`);
      }
    }
  }

  for (const catalogId of ['tpb4k.sukebei.top', 'tpb4k.sukebei.rss']) {
    try {
      const body = await json(`/catalog/movie/${catalogId}.json`, 90_000);
      const metas = Array.isArray(body.metas) ? body.metas : [];
      if (!metas.length) issue(catalogId, 'empty catalogue');
      for (const item of metas) {
        const poster = String(item.poster || '');
        if (/imagetwist|imgtwist/i.test(poster)) issue(catalogId, `blocked poster leaked: ${poster}`);
        if (catalogId.endsWith('.rss') && !poster.startsWith(`${BASE}/onlyporn/poster/sukebei-rss/`)) {
          issue(catalogId, `RSS poster is not OnlyPorn-owned: ${poster}`);
        }
      }
      console.log(`CHECK ${catalogId}: ${metas.length} cards, no blocked host`);
    } catch (error) {
      issue(catalogId, error.message);
    }
  }

  for (const mode of ['all', 'new', 'top']) {
    const section = `hentai-${mode}`;
    try {
      const body = await json(`/catalog/series/tpb4k.hentai.${mode}.json`, 90_000);
      const metas = Array.isArray(body.metas) ? body.metas : [];
      if (!metas.length) {
        issue(section, 'empty catalogue');
        continue;
      }
      const preferred = mode === 'top'
        ? metas.find(item => /gishi\s+wa\s+yan\s+mama\s+junyuu\s+chuu/i.test(String(item.name || '')))
        : null;
      const samples = [preferred, ...metas.slice(0, mode === 'top' ? 5 : 3)]
        .filter((value, index, values) => value && values.findIndex(item => item.id === value.id) === index);
      let playable = 0;
      for (const item of samples) {
        try {
          if (!String(item.id).startsWith('ophmm-')) throw new Error('wrong namespace');
          const detail = (await meta('series', item.id)).meta;
          const episode = detail?.videos?.[0];
          if (!episode) throw new Error('no episode layer');
          const result = await stream('series', episode.id);
          if (!Array.isArray(result.streams) || !result.streams.length) throw new Error('no direct stream');
          playable += 1;
        } catch (error) {
          issue(section, `${item.id}: ${error.message}`);
        }
      }
      if (playable !== samples.length) issue(section, `${playable}/${samples.length} samples playable`);
      console.log(`CHECK ${section}: ${playable}/${samples.length} playable`);
    } catch (error) {
      issue(section, error.message);
    }
  }

  if (issues.length) {
    console.error(`QUALITY_ISSUES=${issues.length}`);
    issues.forEach((value, index) => console.error(`${index + 1}. [${value.section}] ${value.message}`));
    process.exit(3);
  }
  console.log('SUCCESS Alpha.22: all studio, Sukebei and Hentai live gates passed.');
})().catch(error => {
  console.error(`HARD_FAIL: ${error.message}`);
  process.exit(2);
});
