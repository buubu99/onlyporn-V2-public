#!/usr/bin/env node
'use strict';

const BASE = String(process.env.TPB4K_RENDER_BASE_URL || '').trim().replace(/\/$/, '');
if (!/^https:\/\//i.test(BASE)) {
  console.error('Set TPB4K_RENDER_BASE_URL to the HTTPS URL of the Render feature preview.');
  process.exit(2);
}

const IDS = [
  'tpb4k.pornrips.recent', 'tpb4k.hentai.all', 'tpb4k.hentai.new', 'tpb4k.hentai.top',
  'tpb4k.stripchat.girls', 'tpb4k.stripchat.couples', 'tpb4k.tpdb.recent',
  'tpb4k.yesporn.recent', 'tpb4k.sukebei.top',
  'tpb4k.studio.brazzersexxtra.top', 'tpb4k.studio.cum4k.top',
  'tpb4k.studio.devilsfilm.top', 'tpb4k.studio.digitalplayground.top',
  'tpb4k.studio.dorcelclub.top', 'tpb4k.studio.metart.top', 'tpb4k.studio.metartx.top',
  'tpb4k.studio.milfty.top', 'tpb4k.studio.milfy.top', 'tpb4k.studio.newsensations.top',
  'tpb4k.studio.pornmegaload.top', 'tpb4k.studio.onlyfans.top',
  'tpb4k.studio.playboyplus.top', 'tpb4k.studio.sexmex.top',
  'tpb4k.studio.thelifeerotic.top', 'tpb4k.studio.vixen.top',
  'tpb4k.studio.wowgirls.top', 'tpb4k.studio.sexart.top', 'tpb4k.studio.xvideosred.top',
];

async function getJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const manifest = await getJson('/manifest.json');
  const tpbCatalogs = (manifest.catalogs || []).filter(item => String(item.id).startsWith('tpb4k.'));
  if (tpbCatalogs.length !== 28) throw new Error(`Expected 28 TPB4K catalogs, found ${tpbCatalogs.length}`);
  const results = [];
  for (const id of IDS) {
    const started = Date.now();
    const payload = await getJson(`/catalog/movie/${encodeURIComponent(id)}/skip=0.json`);
    if (!Array.isArray(payload.metas)) throw new Error(`${id} did not return a metas array`);
    results.push({ id, metas: payload.metas.length, elapsedMs: Date.now() - started });
  }
  console.log(JSON.stringify({
    base: new URL(BASE).origin,
    version: manifest.version,
    manifestCatalogs: manifest.catalogs.length,
    tpb4kCatalogs: tpbCatalogs.length,
    testedCatalogs: results.length,
    catalogs: results,
    streamsNotRequiredForPhase2: true,
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K Render preview smoke failed: ${error.message}`);
  process.exit(1);
});
