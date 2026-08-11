#!/usr/bin/env node
'use strict';

const BASE = String(process.env.TPB4K_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
if (!/^https:\/\//i.test(BASE)) {
  console.error('Set TPB4K_PUBLIC_BASE_URL to the HTTPS URL of the live addon.');
  process.exit(2);
}

const IDS = [
  'tpb4k.pornrips.recent', 'tpb4k.hentai.all', 'tpb4k.hentai.new', 'tpb4k.hentai.top',
  'tpb4k.stripchat.girls', 'tpb4k.stripchat.couples',
  'tpb4k.yesporn.recent', 'tpb4k.sukebei.top',
  'tpb4k.studio.brazzersexxtra.top', 'tpb4k.studio.cum4k.top',
  'tpb4k.studio.devilsfilm.top', 'tpb4k.studio.digitalplayground.top',
  'tpb4k.studio.dorcelclub.top', 'tpb4k.studio.metart.top', 'tpb4k.studio.metartx.top',
  'tpb4k.studio.milfty.top', 'tpb4k.studio.milfy.top', 'tpb4k.studio.newsensations.top',
  'tpb4k.studio.pornmegaload.top', 'tpb4k.studio.onlyfans.top',
  'tpb4k.studio.playboyplus.top', 'tpb4k.studio.sexmex.top',
  'tpb4k.studio.thelifeerotic.top', 'tpb4k.studio.vixen.top',
  'tpb4k.studio.wowgirls.top', 'tpb4k.studio.sexart.top',
];

const STUDIO_IDS = new Set(IDS.filter(id => id.startsWith('tpb4k.studio.')));
const REQUIRED_NONEMPTY = new Set([
  'tpb4k.sukebei.top', 'tpb4k.studio.onlyfans.top',
  'tpb4k.studio.brazzersexxtra.top', 'tpb4k.studio.cum4k.top',
  'tpb4k.studio.digitalplayground.top', 'tpb4k.studio.dorcelclub.top',
  'tpb4k.studio.metart.top', 'tpb4k.studio.metartx.top',
  'tpb4k.studio.milfy.top', 'tpb4k.studio.playboyplus.top',
  'tpb4k.studio.sexart.top', 'tpb4k.studio.thelifeerotic.top',
  'tpb4k.studio.vixen.top', 'tpb4k.studio.wowgirls.top',
]);
const FALLBACK_PATH = '/assets/tpb4k/studios/';
const REQUEST_TIMEOUT_MS = 30_000;

async function getResponse(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS} ms`);
    }
    throw new Error(`${label} request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(path) {
  const response = await getResponse(`${BASE}${path}`, path);
  return response.json();
}

function safePoster(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function isFallbackPoster(value) {
  const safe = safePoster(value);
  if (!safe) return false;
  try {
    const url = new URL(safe);
    return url.pathname.includes(FALLBACK_PATH);
  } catch {
    return false;
  }
}

(async () => {
  const manifest = await getJson('/manifest.json');
  const tpbCatalogs = (manifest.catalogs || []).filter(item => String(item.id).startsWith('tpb4k.'));
  if (tpbCatalogs.length !== 26) throw new Error(`Expected 26 TPB4K catalogs, found ${tpbCatalogs.length}`);
  const results = [];
  for (const id of IDS) {
    const started = Date.now();
    const payload = await getJson(`/catalog/movie/${encodeURIComponent(id)}/skip=0.json`);
    if (!Array.isArray(payload.metas)) throw new Error(`${id} did not return a metas array`);
    if (REQUIRED_NONEMPTY.has(id) && payload.metas.length === 0) {
      throw new Error(`${id} returned zero live records`);
    }
    const posters = payload.metas.filter(meta => safePoster(meta.poster)).length;
    if (posters !== payload.metas.length) {
      throw new Error(`${id} returned ${payload.metas.length - posters} card(s) without a safe HTTPS poster`);
    }
    if (STUDIO_IDS.has(id) && payload.metas.some(meta => meta.posterShape !== 'poster')) {
      throw new Error(`${id} returned a non-portrait poster shape`);
    }
    const fallbackPosters = (STUDIO_IDS.has(id) || id === 'tpb4k.sukebei.top')
      ? payload.metas.filter(meta => isFallbackPoster(meta.poster)).length
      : 0;
    const realMetadataPosters = STUDIO_IDS.has(id) ? posters - fallbackPosters : posters;
    results.push({
      id,
      metas: payload.metas.length,
      posters,
      realMetadataPosters,
      fallbackPosters,
      posterPercent: payload.metas.length ? 100 : 0,
      elapsedMs: Date.now() - started,
    });
  }
  const studioResults = results.filter(result => STUDIO_IDS.has(result.id));
  const totalStudioCards = studioResults.reduce((sum, result) => sum + result.metas, 0);
  const totalRealMetadataPosters = studioResults.reduce((sum, result) => sum + result.realMetadataPosters, 0);
  const strictStudioResults = studioResults.filter(result => result.id !== 'tpb4k.studio.onlyfans.top');
  const strictStudioCards = strictStudioResults.reduce((sum, result) => sum + result.metas, 0);
  const strictRealMetadataPosters = strictStudioResults.reduce((sum, result) => sum + result.realMetadataPosters, 0);
  const totalFallbackPosters = strictStudioResults.reduce((sum, result) => sum + result.fallbackPosters, 0);
  const onlyFansFallbackPosters = studioResults.find(result => result.id === 'tpb4k.studio.onlyfans.top')?.fallbackPosters || 0;
  const nonEmptyStudioCatalogs = studioResults.filter(result => result.metas > 0).length;
  if (nonEmptyStudioCatalogs < 13) {
    throw new Error(`Only ${nonEmptyStudioCatalogs}/18 studio catalogs were non-empty`);
  }
  if (totalFallbackPosters !== 0) {
    throw new Error(`${totalFallbackPosters} generic fallback poster(s) leaked into strict metadata-first studio catalogs`);
  }
  const sukebeiResult = results.find(result => result.id === 'tpb4k.sukebei.top');
  if (sukebeiResult?.fallbackPosters) {
    throw new Error(`${sukebeiResult.fallbackPosters} generic Sukebei fallback poster(s) remained visible`);
  }
  if (strictStudioCards > 0 && strictRealMetadataPosters !== strictStudioCards) {
    throw new Error('Not every strict metadata-first studio card uses a real metadata poster');
  }

  const firstPoster = results.length
    ? (await getJson(`/catalog/movie/${encodeURIComponent('tpb4k.studio.vixen.top')}/skip=0.json`)).metas?.[0]?.poster
    : '';
  if (firstPoster) {
    const response = await getResponse(safePoster(firstPoster), 'first Vixen poster');
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error('first Vixen poster did not return an image response');
  }

  console.log(JSON.stringify({
    base: new URL(BASE).origin,
    version: manifest.version,
    manifestCatalogs: manifest.catalogs.length,
    tpb4kCatalogs: tpbCatalogs.length,
    testedCatalogs: results.length,
    catalogs: results,
    nonEmptyStudioCatalogs,
    studioCards: totalStudioCards,
    realMetadataPosters: totalRealMetadataPosters,
    fallbackPosters: totalFallbackPosters,
    onlyFansFallbackPosters,
    allReturnedCardsHavePosters: true,
    allStrictStudioCardsUseLiveMetadataPosters: strictStudioCards > 0 && strictRealMetadataPosters === strictStudioCards,
    firstVixenPosterReachable: Boolean(firstPoster),
    streamsNotRequiredForPhase2: true,
  }, null, 2));
})().catch(error => {
  console.error(`TPB4K Render preview smoke failed: ${error.message}`);
  process.exit(1);
});
