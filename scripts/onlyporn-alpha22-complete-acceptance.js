#!/usr/bin/env node
'use strict';

const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');
const { validateImageResponse } = require('../provider/tpb4k/sukebei-image-validator');

const BASE = String(process.env.ONLYPORN_PUBLIC_BASE_URL || 'https://onlyv2.51-79-157-182.sslip.io').replace(/\/$/, '');
const EXPECTED = process.env.EXPECTED_VERSION || '2.7.0-alpha.22';
const CATALOG_TIMEOUT_MS = Number(process.env.ONLYPORN_ACCEPTANCE_CATALOG_TIMEOUT_MS || 90_000);
const CONCURRENT_MAX_MS = Number(process.env.ONLYPORN_ACCEPTANCE_CONCURRENT_MAX_MS || 20_000);
const STUDIOS = [
  'brazzersexxtra', 'cum4k', 'devilsfilm', 'digitalplayground', 'dorcelclub',
  'metart', 'metartx', 'milfty', 'milfy', 'newsensations', 'pornmegaload',
  'onlyfans', 'playboyplus', 'sexmex', 'thelifeerotic', 'vixen', 'wowgirls',
  'sexart',
].map(name => `tpb4k.studio.${name}.top`);
const MINIMUMS = Object.freeze({
  'tpb4k.studio.brazzersexxtra.top': 30,
  'tpb4k.studio.cum4k.top': 30,
  'tpb4k.studio.devilsfilm.top': 6,
  'tpb4k.studio.digitalplayground.top': 20,
  'tpb4k.studio.dorcelclub.top': 30,
  'tpb4k.studio.metart.top': 30,
  'tpb4k.studio.metartx.top': 30,
  'tpb4k.studio.milfty.top': 10,
  'tpb4k.studio.milfy.top': 30,
  'tpb4k.studio.newsensations.top': 30,
  'tpb4k.studio.pornmegaload.top': 30,
  'tpb4k.studio.onlyfans.top': 35,
  'tpb4k.studio.playboyplus.top': 30,
  'tpb4k.studio.sexmex.top': 12,
  'tpb4k.studio.thelifeerotic.top': 30,
  'tpb4k.studio.vixen.top': 30,
  'tpb4k.studio.wowgirls.top': 30,
  'tpb4k.studio.sexart.top': 30,
});
const issues = [];

function issue(section, message) {
  const row = { section, message: String(message) };
  issues.push(row);
  console.error(`ISSUE [${section}]: ${row.message}`);
}
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function json(path, timeoutMs = CATALOG_TIMEOUT_MS) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetchWithTimeout(`${BASE}${path}${separator}a22=${Date.now()}-${Math.random()}`, {
    headers: { Accept: 'application/json' },
  }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function catalog(type, id, timeoutMs = CATALOG_TIMEOUT_MS) {
  const startedAt = Date.now();
  const body = await json(`/catalog/${type}/${id}.json?skip=0`, timeoutMs);
  return { metas: Array.isArray(body.metas) ? body.metas : [], elapsedMs: Date.now() - startedAt };
}
async function meta(type, id) { return json(`/meta/${type}/${encodeURIComponent(id)}.json`, 60_000); }
async function stream(type, id) { return json(`/stream/${type}/${encodeURIComponent(id)}.json`, 60_000); }
function bundleHashes(id) {
  try {
    return [...new Set((decodeTpb4kId(id)?.torrents || [])
      .map(item => String(item.infoHash || '').toLowerCase())
      .filter(value => /^[a-f0-9]{40}$/.test(value)))];
  } catch { return []; }
}
function isInternalStudioPoster(value) { return /\/onlyporn\/poster\/studio-release\//i.test(String(value || '')); }

async function validateStudioStreams(catalogId, metas) {
  let multi = 0;
  for (const item of metas.slice(0, 6)) {
    try {
      const expectedHashes = bundleHashes(item.id);
      if (!expectedHashes.length) throw new Error('card has no catalogue-bound torrent');
      if (expectedHashes.length > 1) multi += 1;
      const body = await stream('movie', item.id);
      const returned = [...new Set((body.streams || [])
        .map(value => String(value.infoHash || '').toLowerCase())
        .filter(value => /^[a-f0-9]{40}$/.test(value)))];
      const missing = expectedHashes.filter(hash => !returned.includes(hash));
      if (missing.length) throw new Error(`encoded ${expectedHashes.length}, returned ${returned.length}, missing ${missing.length}`);
    } catch (error) { issue(catalogId, `${item.id}: ${error.message}`); }
  }
  return multi;
}

(async () => {
  const manifest = await json('/manifest.json', 60_000);
  const internal = (manifest.catalogs || []).filter(item => String(item.id || '').startsWith('tpb4k.'));
  if (manifest.version !== EXPECTED) throw new Error(`manifest version ${manifest.version}, expected ${EXPECTED}`);
  if ((manifest.catalogs || []).length !== 38 || internal.length !== 29) {
    throw new Error(`manifest catalogues ${(manifest.catalogs || []).length}/${internal.length}, expected 38/29`);
  }
  console.log(`MANIFEST ${manifest.version}: 38 total / 29 internal`);

  const prewarmed = new Map();
  console.log('\n=== SEQUENTIAL PREWARM ===');
  for (const catalogId of STUDIOS) {
    try {
      const result = await catalog('movie', catalogId, 120_000);
      prewarmed.set(catalogId, result.metas);
      console.log(`PREWARM ${catalogId}: ${result.metas.length} cards in ${result.elapsedMs}ms`);
    } catch (error) { issue(catalogId, `prewarm failed: ${error.message}`); }
  }

  const rounds = [];
  for (let round = 1; round <= 2; round += 1) {
    console.log(`\n=== CATALOG CONCURRENCY ROUND ${round} ===`);
    const results = await Promise.all(STUDIOS.map(async catalogId => {
      try {
        const result = await catalog('movie', catalogId, 45_000);
        console.log(`ROUND ${round} ${catalogId}: ${result.metas.length} cards in ${result.elapsedMs}ms`);
        if (result.elapsedMs > CONCURRENT_MAX_MS) issue(catalogId, `concurrent response ${result.elapsedMs}ms exceeds ${CONCURRENT_MAX_MS}ms`);
        return { catalogId, ...result };
      } catch (error) {
        issue(catalogId, `concurrent round ${round} failed: ${error.message}`);
        return { catalogId, metas: [], elapsedMs: Infinity };
      }
    }));
    rounds.push(new Map(results.map(item => [item.catalogId, item])));
  }

  for (const catalogId of STUDIOS) {
    const warm = prewarmed.get(catalogId) || [];
    const first = rounds[0].get(catalogId)?.metas || [];
    const second = rounds[1].get(catalogId)?.metas || [];
    const minimum = MINIMUMS[catalogId];
    if (warm.length < minimum || first.length < minimum || second.length < minimum) {
      issue(catalogId, `catalogue count warm/round1/round2=${warm.length}/${first.length}/${second.length}; minimum=${minimum}`);
    }
    await validateStudioStreams(catalogId, second);
  }

  const onlyFans = rounds[1].get('tpb4k.studio.onlyfans.top')?.metas || [];
  const realOnlyFansPosters = onlyFans.filter(item => /^https:\/\//i.test(String(item.poster || '')) && !isInternalStudioPoster(item.poster)).length;
  if (onlyFans.length < MINIMUMS['tpb4k.studio.onlyfans.top']) issue('onlyfans', `only ${onlyFans.length} cards`);
  if (realOnlyFansPosters < Math.min(20, Math.ceil(onlyFans.length * 0.5))) {
    issue('onlyfans', `only ${realOnlyFansPosters}/${onlyFans.length} cards have external metadata artwork`);
  }
  console.log(`ONLYFANS ${onlyFans.length} cards, ${realOnlyFansPosters} external posters`);

  console.log('\n=== SUKEBEI ===');
  for (const catalogId of ['tpb4k.sukebei.top', 'tpb4k.sukebei.rss']) {
    try {
      const { metas } = await catalog('movie', catalogId, 120_000);
      if (!metas.length) issue(catalogId, 'empty catalogue');
      for (const item of metas) {
        const poster = String(item.poster || '');
        if (/imagetwist|imgtwist/i.test(poster)) issue(catalogId, `blocked host leaked: ${poster}`);
        if (catalogId.endsWith('.rss') && !poster.startsWith(`${BASE}/onlyporn/poster/sukebei-rss/`)) {
          issue(catalogId, `RSS poster is not OnlyPorn-owned: ${poster}`);
        }
      }
      if (catalogId.endsWith('.top')) {
        for (const item of metas.slice(0, 10)) {
          try {
            const response = await fetchWithTimeout(item.poster, { headers: { Accept: 'image/*' } }, 30_000);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const checked = await validateImageResponse(response, { url: item.poster });
            if (!checked.valid) throw new Error(checked.reason);
          } catch (error) { issue(catalogId, `${item.id}: poster bytes invalid: ${error.message}`); }
        }
      }
      console.log(`CHECK ${catalogId}: ${metas.length} cards`);
    } catch (error) { issue(catalogId, error.message); }
  }

  console.log('\n=== HENTAI ALL / NEW / TOP ===');
  for (const mode of ['all', 'new', 'top']) {
    const section = `hentai-${mode}`;
    try {
      const { metas } = await catalog('series', `tpb4k.hentai.${mode}`, 120_000);
      if (!metas.length) { issue(section, 'empty catalogue'); continue; }
      const samples = metas.slice(0, 2);
      let playable = 0;
      for (const item of samples) {
        try {
          if (!String(item.id || '').startsWith('ophmm-')) throw new Error('wrong namespace');
          const detail = (await meta('series', item.id)).meta;
          const episode = detail?.videos?.[0];
          if (!episode?.id) throw new Error('no episode metadata');
          const result = await stream('series', episode.id);
          if (!Array.isArray(result.streams) || !result.streams.some(value => /^https:\/\//i.test(String(value.url || '')))) {
            throw new Error('no validated direct stream');
          }
          playable += 1;
        } catch (error) { issue(section, `${item.id}: ${error.message}`); }
      }
      if (playable !== samples.length) issue(section, `${playable}/${samples.length} samples playable`);
      console.log(`CHECK ${section}: ${playable}/${samples.length} playable`);
    } catch (error) { issue(section, error.message); }
  }

  if (issues.length) {
    console.error(`QUALITY_ISSUES=${issues.length}`);
    issues.forEach((value, index) => console.error(`${index + 1}. [${value.section}] ${value.message}`));
    process.exit(3);
  }
  console.log('\nSUCCESS: Alpha.22 complete live acceptance passed.');
})().catch(error => {
  console.error(`HARD_FAIL: ${error.message}`);
  process.exit(2);
});
