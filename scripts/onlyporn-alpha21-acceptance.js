#!/usr/bin/env node
'use strict';

const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');
const { validateImageResponse, blockedHost } = require('../provider/tpb4k/sukebei-image-validator');

const BASE = String(process.env.ONLYPORN_RENDER_BASE_URL || 'https://onlyporn-v2-public-k143.onrender.com').replace(/\/$/, '');
const EXPECTED = process.env.EXPECTED_VERSION || '2.7.0-alpha.21';
const CONCURRENCY = Math.min(Math.max(Number(process.env.ONLYPORN_ACCEPTANCE_CONCURRENCY || 5), 1), 10);
const STUDIOS = [
  'brazzersexxtra', 'cum4k', 'devilsfilm', 'digitalplayground', 'dorcelclub', 'metart', 'metartx', 'milfty', 'milfy',
  'newsensations', 'pornmegaload', 'onlyfans', 'playboyplus', 'sexmex', 'thelifeerotic', 'vixen', 'wowgirls', 'sexart', 'xvideosred',
].map(name => `tpb4k.studio.${name}.top`);
const BLOCKED = new Set(['gay', 'interracial']);
const issues = [];

function fail(message) { throw new Error(message); }
function record(section, error) {
  const message = error instanceof Error ? error.message : String(error);
  issues.push({ section, message });
  console.error(`ISSUE [${section}]: ${message}`);
}
async function json(path, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}a21=${Date.now()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) fail(`${path}: HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function pool(values, worker) {
  let index = 0;
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(values.length, 1)) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= values.length) return;
      try { await worker(values[current], current); }
      catch (error) { errors.push(error); }
    }
  }));
  return errors;
}
function explicitBlocked(meta) {
  const labels = [...(meta.genres || []), ...(meta.tags || [])].map(value => String(value).trim().toLowerCase());
  return labels.find(label => BLOCKED.has(label));
}
function bundleHashes(id) {
  const decoded = decodeTpb4kId(id);
  return decoded?.torrents?.map(value => value.infoHash) || [];
}
async function stream(type, id) { return json(`/stream/${type}/${encodeURIComponent(id)}.json`); }
async function meta(type, id) { return json(`/meta/${type}/${encodeURIComponent(id)}.json`); }
async function verifiedPoster(url) {
  if (blockedHost(url)) fail(`Sukebei Top blocked hotlink poster: ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' } });
    if (!response.ok) fail(`Sukebei poster HTTP ${response.status}: ${url}`);
    const result = await validateImageResponse(response, { url, maxResponseBytes: 2_000_000 });
    if (!result.valid) fail(`Sukebei poster rejected (${result.reason}): ${url}`);
  } finally { clearTimeout(timer); }
}

(async () => {
  // Hard safety contract: failure here means the service is not the intended build.
  let manifest;
  try {
    manifest = await json('/manifest.json');
    if (manifest.version !== EXPECTED) fail(`Render version ${manifest.version}; expected ${EXPECTED}`);
    for (const name of ['stream', 'meta']) {
      const resource = (manifest.resources || []).find(item => item && typeof item === 'object' && item.name === name);
      const prefixes = resource?.idPrefixes || [];
      if (JSON.stringify(prefixes) !== JSON.stringify(['onlyporn:', 'ophmm-'])) fail(`manifest ${name} prefixes are not exclusively OnlyPorn-owned: ${JSON.stringify(prefixes)}`);
    }
    const manifestCatalogs = Array.isArray(manifest.catalogs) ? manifest.catalogs : [];
    const internalCatalogs = manifestCatalogs.filter(item => String(item.id || '').startsWith('tpb4k.'));
    const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
    if (manifestCatalogs.length !== 38 || internalCatalogs.length !== 29 || manifestBytes >= 8192) {
      fail(`manifest contract ${manifestCatalogs.length}/${internalCatalogs.length}/${manifestBytes}; expected 38/29/<8192`);
    }
    console.log(`PASS hard contract: version ${EXPECTED}, exclusive ownership, 38/29 manifest`);
  } catch (error) {
    console.error(`HARD_FAIL: ${error.message}`);
    process.exit(2);
  }

  let studioCards = 0;
  let studioStreams = 0;
  let multiStreamCards = 0;
  const perCatalog = new Map();
  for (const catalogId of STUDIOS) {
    let metas = [];
    try {
      const body = await json(`/catalog/movie/${catalogId}.json`);
      metas = Array.isArray(body.metas) ? body.metas : [];
    } catch (error) {
      record(catalogId, error);
      perCatalog.set(catalogId, { cards: 0, multi: 0 });
      continue;
    }
    const minimum = catalogId.endsWith('.onlyfans.top') ? 12
      : (catalogId.endsWith('.digitalplayground.top') || catalogId.endsWith('.xvideosred.top') ? 8 : 1);
    if (metas.length < minimum) record(catalogId, `${metas.length} cards; minimum required ${minimum}`);
    for (const item of metas) {
      const blocked = explicitBlocked(item);
      if (blocked) record(catalogId, `explicit blocked label ${blocked} on ${item.id}`);
    }
    let catalogMulti = 0;
    const errors = await pool(metas, async item => {
      const expectedHashes = bundleHashes(item.id);
      if (!expectedHashes.length) fail(`${item.id} has no catalog-bound torrent bundle`);
      const result = await stream('movie', item.id);
      const streams = Array.isArray(result.streams) ? result.streams : [];
      const returned = [...new Set(streams.map(value => String(value.infoHash || '').toLowerCase()).filter(Boolean))];
      if (returned.length !== expectedHashes.length || expectedHashes.some(hash => !returned.includes(hash))) {
        fail(`${item.id} encoded ${expectedHashes.length} hashes but returned ${returned.length}`);
      }
      if (returned.length > 1) { catalogMulti += 1; multiStreamCards += 1; }
      studioStreams += returned.length;
    });
    errors.forEach(error => record(catalogId, error));
    perCatalog.set(catalogId, { cards: metas.length, multi: catalogMulti });
    studioCards += metas.length;
    console.log(`CHECK studio ${catalogId}: ${metas.length} cards, ${catalogMulti} multi-stream cards`);
  }
  if (multiStreamCards < 10) record('studio-summary', `Only ${multiStreamCards} studio cards returned multiple discovered hashes; one-link regression remains`);
  const sexmex = perCatalog.get('tpb4k.studio.sexmex.top');
  if (!sexmex || sexmex.multi < 1) record('sexmex', 'SexMex has no multi-candidate failover card');

  try {
    const topBody = await json('/catalog/movie/tpb4k.sukebei.top.json');
    const top = Array.isArray(topBody.metas) ? topBody.metas : [];
    if (!top.length) record('sukebei-top', 'Sukebei Top is empty; verified artwork/cache recovery failed');
    if (top.some(item => String(item.poster || '').includes('/onlyporn/poster/sukebei-rss/'))) record('sukebei-top', 'contains unresolved RSS fallback artwork');
    const errors = await pool(top, async item => {
      await verifiedPoster(String(item.poster || ''));
      const result = await stream('movie', item.id);
      if (!Array.isArray(result.streams) || !result.streams.length) fail(`${item.id}: no stream`);
    });
    errors.forEach(error => record('sukebei-top', error));
    console.log(`CHECK Sukebei Top: ${top.length} cards`);
  } catch (error) { record('sukebei-top', error); }

  try {
    const rssBody = await json('/catalog/movie/tpb4k.sukebei.rss.json');
    const rss = Array.isArray(rssBody.metas) ? rssBody.metas : [];
    if (!rss.length) record('sukebei-rss', 'fallback catalog is empty');
    const posterSet = new Set(rss.map(item => item.poster));
    if (posterSet.size !== rss.length) record('sukebei-rss', `${rss.length} cards but only ${posterSet.size} distinct posters`);
    if (rss.some(item => !String(item.poster || '').startsWith(`${BASE}/onlyporn/poster/sukebei-rss/`))) record('sukebei-rss', 'contains a non-OnlyPorn fallback poster');
    const errors = await pool(rss, async item => {
      const result = await stream('movie', item.id);
      if (!Array.isArray(result.streams) || !result.streams.length) fail(`${item.id}: no stream`);
    });
    errors.forEach(error => record('sukebei-rss', error));
    console.log(`CHECK Sukebei RSS: ${rss.length} cards`);
  } catch (error) { record('sukebei-rss', error); }

  for (const mode of ['all', 'new']) {
    const section = `hentai-${mode}`;
    try {
      const body = await json(`/catalog/series/tpb4k.hentai.${mode}.json`);
      const metas = Array.isArray(body.metas) ? body.metas : [];
      if (!metas.length) record(section, 'empty catalog');
      if (metas.some(item => !String(item.id).startsWith('ophmm-'))) record(section, 'non-OnlyPorn ID leaked');
      const sample = [metas[0], metas[Math.floor(metas.length / 2)], metas[metas.length - 1]]
        .filter((value, index, array) => value && array.findIndex(item => item.id === value.id) === index);
      for (const item of sample) {
        try {
          const detail = (await meta('series', item.id)).meta;
          if (!detail || !Array.isArray(detail.videos) || !detail.videos.length) fail(`${item.id}: no episodes`);
          const result = await stream('series', detail.videos[0].id);
          if (!Array.isArray(result.streams) || !result.streams.length) fail(`${detail.videos[0].id}: no direct stream`);
        } catch (error) { record(section, error); }
      }
      console.log(`CHECK Hentai ${mode}: ${sample.length} playback samples`);
    } catch (error) { record(section, error); }
  }

  try {
    const hentaiTopBody = await json('/catalog/series/tpb4k.hentai.top.json');
    const hentaiTop = Array.isArray(hentaiTopBody.metas) ? hentaiTopBody.metas : [];
    if (!hentaiTop.length) record('hentai-top', 'empty catalog');
    if (hentaiTop.some(item => !String(item.id).startsWith('ophmm-'))) record('hentai-top', 'contains a non-OnlyPorn ID');
    const preferred = hentaiTop.find(item => /gishi\s+wa\s+yan\s+mama\s+junyuu\s+chuu/i.test(String(item.name || '')));
    const topSamples = [preferred, ...hentaiTop.slice(0, 5)].filter((value, index, values) => value && values.findIndex(item => item.id === value.id) === index);
    let playableTop = 0;
    const errors = await pool(topSamples, async item => {
      const detail = (await meta('series', item.id)).meta;
      if (!detail || !Array.isArray(detail.videos) || !detail.videos.length) fail(`${item.id}: empty second layer`);
      const first = detail.videos[0];
      const result = await stream('series', first.id);
      if (!Array.isArray(result.streams) || !result.streams.length) fail(`${first.id}: no direct stream`);
      playableTop += 1;
    });
    errors.forEach(error => record('hentai-top', error));
    if (preferred && playableTop < 1) record('hentai-top', 'Known Gishi title did not resolve through the second layer');
    console.log(`CHECK Hentai Top/Gishi: ${playableTop}/${topSamples.length} playable`);
  } catch (error) { record('hentai-top', error); }

  console.log(`SUMMARY Alpha.21: ${studioCards} professional cards, ${studioStreams} exact bound streams, ${multiStreamCards} multi-link cards.`);
  if (issues.length) {
    console.error(`QUALITY_ISSUES=${issues.length}`);
    for (const [index, item] of issues.entries()) console.error(`${index + 1}. [${item.section}] ${item.message}`);
    process.exit(3);
  }
  console.log('SUCCESS Alpha.21: all hard and quality gates passed.');
})().catch(error => {
  console.error(`HARD_FAIL: ${error.message}`);
  process.exit(2);
});
