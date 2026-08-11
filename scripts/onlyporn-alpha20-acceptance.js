#!/usr/bin/env node
'use strict';

const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');

const BASE = String(process.env.ONLYPORN_PUBLIC_BASE_URL || 'https://onlyv2.51-79-157-182.sslip.io').replace(/\/$/, '');
const EXPECTED = process.env.EXPECTED_VERSION || '2.7.0-alpha.20';
const CONCURRENCY = Math.min(Math.max(Number(process.env.ONLYPORN_ACCEPTANCE_CONCURRENCY || 5), 1), 10);
const STUDIOS = [
  'brazzersexxtra', 'cum4k', 'devilsfilm', 'digitalplayground', 'dorcelclub', 'metart', 'metartx', 'milfty', 'milfy',
  'newsensations', 'pornmegaload', 'onlyfans', 'playboyplus', 'sexmex', 'thelifeerotic', 'vixen', 'wowgirls', 'sexart', 'xvideosred',
].map(name => `tpb4k.studio.${name}.top`);
const BLOCKED = new Set(['gay', 'interracial']);

function fail(message) { throw new Error(message); }
async function json(path, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}a20=${Date.now()}`, {
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
  if (errors.length) throw errors[0];
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

(async () => {
  const manifest = await json('/manifest.json');
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
  console.log(`PASS version ${EXPECTED}, exclusive OnlyPorn ownership, and 38/29 manifest contract`);

  let studioCards = 0;
  let studioStreams = 0;
  let multiStreamCards = 0;
  const perCatalog = new Map();
  for (const catalogId of STUDIOS) {
    const body = await json(`/catalog/movie/${catalogId}.json`);
    const metas = Array.isArray(body.metas) ? body.metas : [];
    const minimum = catalogId.endsWith('.onlyfans.top') ? 8
      : (catalogId.endsWith('.digitalplayground.top') || catalogId.endsWith('.xvideosred.top') ? 5 : 1);
    if (metas.length < minimum) fail(`${catalogId}: ${metas.length} cards; minimum required ${minimum}`);
    for (const item of metas) {
      const blocked = explicitBlocked(item);
      if (blocked) fail(`${catalogId}: explicit blocked label ${blocked}`);
    }
    let catalogMulti = 0;
    await pool(metas, async item => {
      const expectedHashes = bundleHashes(item.id);
      if (!expectedHashes.length) fail(`${catalogId}: ${item.id} has no catalog-bound torrent bundle`);
      const result = await stream('movie', item.id);
      const streams = Array.isArray(result.streams) ? result.streams : [];
      const returned = [...new Set(streams.map(value => String(value.infoHash || '').toLowerCase()).filter(Boolean))];
      if (returned.length !== expectedHashes.length || expectedHashes.some(hash => !returned.includes(hash))) {
        fail(`${catalogId}: ${item.id} encoded ${expectedHashes.length} hashes but returned ${returned.length}`);
      }
      if (returned.length > 1) { catalogMulti += 1; multiStreamCards += 1; }
      studioStreams += returned.length;
    });
    perCatalog.set(catalogId, { cards: metas.length, multi: catalogMulti });
    studioCards += metas.length;
    console.log(`PASS studio ${catalogId}: ${metas.length} cards, ${catalogMulti} multi-stream cards`);
  }
  if (multiStreamCards < 10) fail(`Only ${multiStreamCards} studio cards returned multiple discovered hashes; one-link regression remains`);
  const sexmex = perCatalog.get('tpb4k.studio.sexmex.top');
  if (!sexmex || sexmex.multi < 1) fail('SexMex has no multi-candidate failover card');

  const topBody = await json('/catalog/movie/tpb4k.sukebei.top.json');
  const top = Array.isArray(topBody.metas) ? topBody.metas : [];
  if (!top.length) fail('Sukebei Top is empty; verified artwork/cache recovery failed');
  if (top.some(item => String(item.poster || '').includes('/onlyporn/poster/sukebei-rss/'))) fail('Sukebei Top contains unresolved RSS fallback artwork');
  await pool(top, async item => {
    const result = await stream('movie', item.id);
    if (!Array.isArray(result.streams) || !result.streams.length) fail(`Sukebei Top ${item.id}: no stream`);
  });

  const rssBody = await json('/catalog/movie/tpb4k.sukebei.rss.json');
  const rss = Array.isArray(rssBody.metas) ? rssBody.metas : [];
  if (!rss.length) fail('Sukebei RSS fallback catalog is empty');
  const posterSet = new Set(rss.map(item => item.poster));
  if (posterSet.size !== rss.length) fail(`Sukebei RSS has ${rss.length} cards but only ${posterSet.size} distinct posters`);
  if (rss.some(item => !String(item.poster || '').startsWith(`${BASE}/onlyporn/poster/sukebei-rss/`))) fail('Sukebei RSS contains a non-OnlyPorn fallback poster');
  await pool(rss, async item => {
    const result = await stream('movie', item.id);
    if (!Array.isArray(result.streams) || !result.streams.length) fail(`Sukebei RSS ${item.id}: no stream`);
  });
  console.log(`PASS Sukebei separation: ${top.length} verified-art Top cards; ${rss.length} unique playable RSS cards`);

  for (const mode of ['all', 'new']) {
    const body = await json(`/catalog/series/tpb4k.hentai.${mode}.json`);
    const metas = Array.isArray(body.metas) ? body.metas : [];
    if (!metas.length) fail(`Hentai ${mode}: empty`);
    if (metas.some(item => !String(item.id).startsWith('ophmm-'))) fail(`Hentai ${mode}: non-OnlyPorn ID leaked`);
    const sample = [metas[0], metas[Math.floor(metas.length / 2)], metas[metas.length - 1]]
      .filter((value, index, array) => value && array.findIndex(item => item.id === value.id) === index);
    for (const item of sample) {
      const detail = (await meta('series', item.id)).meta;
      if (!detail || !Array.isArray(detail.videos) || !detail.videos.length) fail(`Hentai ${mode} ${item.id}: no episodes`);
      const result = await stream('series', detail.videos[0].id);
      if (!Array.isArray(result.streams) || !result.streams.length) fail(`Hentai ${mode} ${detail.videos[0].id}: no direct stream`);
    }
    console.log(`PASS Hentai ${mode}: ${sample.length} independent playback samples`);
  }

  const hentaiTopBody = await json('/catalog/series/tpb4k.hentai.top.json');
  const hentaiTop = Array.isArray(hentaiTopBody.metas) ? hentaiTopBody.metas : [];
  if (!hentaiTop.length) fail('Hentai Top is empty');
  if (hentaiTop.some(item => !String(item.id).startsWith('ophmm-'))) fail('Hentai Top contains a non-OnlyPorn ID');
  await pool(hentaiTop, async item => {
    const detail = (await meta('series', item.id)).meta;
    if (!detail || !Array.isArray(detail.videos) || !detail.videos.length) fail(`Hentai Top ${item.id}: empty second layer`);
    const first = detail.videos[0];
    const result = await stream('series', first.id);
    if (!Array.isArray(result.streams) || !result.streams.length) fail(`Hentai Top ${first.id}: no direct stream`);
  });
  console.log(`PASS Hentai Top: ${hentaiTop.length}/${hentaiTop.length} series have episodes and direct streams`);

  console.log(`SUCCESS Alpha.20: ${studioCards} professional cards returned ${studioStreams} exact bound streams; ${multiStreamCards} cards have alternatives.`);
})().catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
