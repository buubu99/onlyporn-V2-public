#!/usr/bin/env node
'use strict';

const { catalogDefinitions } = require('../catalog/tpb4k');
const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');

const BASE = String(
  process.env.TPB4K_RENDER_BASE_URL ||
  process.env.ONLYPORN_RENDER_BASE_URL ||
  'https://onlyporn-v2-public-k143.onrender.com'
).trim().replace(/\/$/, '');
const EXPECTED_VERSION = String(process.env.EXPECTED_VERSION || '2.7.0-alpha.17').trim();
const CONCURRENCY = Math.min(Math.max(Number(process.env.TPB4K_ACCEPTANCE_CONCURRENCY || 4), 1), 8);
const HENTAI_LIMIT = Math.max(Number.parseInt(String(process.env.TPB4K_HENTAI_SERIES_TEST_LIMIT ?? 6), 10) || 0, 0);
const TIMEOUT = Math.max(Number(process.env.TPB4K_ACCEPTANCE_TIMEOUT_MS || 70_000), 5_000);

function safeHttps(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function getJson(path, timeoutMs = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetch(`${BASE}${path}${separator}alpha17=${Date.now()}-${Math.random()}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimited(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      try {
        output[index] = await mapper(values[index], index);
      } catch (error) {
        output[index] = { error: error.message, value: values[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(values.length, 1)) }, () => worker()));
  return output;
}

async function verifyStudio(definition) {
  const payload = await getJson(`/catalog/movie/${encodeURIComponent(definition.id)}.json`);
  const metas = Array.isArray(payload?.metas) ? payload.metas : [];
  if (!metas.length) throw new Error('zero visible playable-bound cards');

  const cards = metas.map((meta, index) => {
    const decoded = decodeTpb4kId(meta.id);
    if (!decoded || decoded.version !== 2 || !decoded.torrent) {
      throw new Error(`card ${index + 1} is not a version-2 bound torrent ID`);
    }
    if (!/^[a-f0-9]{40}$/.test(decoded.torrent.infoHash || '')) {
      throw new Error(`card ${index + 1} has an invalid infoHash`);
    }
    if (decoded.catalogId !== definition.id || decoded.source !== definition.source) {
      throw new Error(`card ${index + 1} identity does not match ${definition.id}`);
    }
    if (!safeHttps(meta.poster)) throw new Error(`card ${index + 1} has no valid metadata poster`);
    return { meta, decoded };
  });

  const playback = await mapLimited(cards, CONCURRENCY, async (entry, index) => {
    const payload = await getJson(`/stream/movie/${encodeURIComponent(entry.meta.id)}.json`, 50_000);
    const streams = Array.isArray(payload?.streams) ? payload.streams : [];
    const matching = streams.filter(stream => String(stream.infoHash || '').toLowerCase() === entry.decoded.torrent.infoHash);
    if (!matching.length) throw new Error(`card ${index + 1}/${cards.length} returned no matching P2P/debrid handoff stream: ${entry.meta.name}`);
    return { index: index + 1, title: entry.meta.name, streams: streams.length, infoHash: entry.decoded.torrent.infoHash };
  });
  const failures = playback.filter(item => item?.error);
  if (failures.length) {
    throw new Error(`${failures.length}/${cards.length} bound cards failed stream handoff; first: ${failures[0].error}`);
  }
  return {
    catalogId: definition.id,
    studio: definition.studio,
    cards: cards.length,
    testedCards: playback.length,
    passedCards: playback.length,
  };
}

async function verifyHentaiSeries(id) {
  const metaPayload = await getJson(`/meta/series/${encodeURIComponent(id)}.json`, 50_000);
  const meta = metaPayload?.meta || {};
  if (meta.id !== id || meta.type !== 'series') throw new Error(`${id} did not return series metadata`);
  if (!safeHttps(meta.poster)) throw new Error(`${id} has no valid poster`);
  const videos = Array.isArray(meta.videos) ? meta.videos : [];
  if (!videos.length) throw new Error(`${id} has no episodes`);
  const selected = [...new Map([videos[0], videos[videos.length - 1]].map(video => [video.id, video])).values()];
  const episodeResults = [];
  for (const video of selected) {
    if (!new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1:\\d+$`).test(video.id)) {
      throw new Error(`${id} emitted an invalid exact episode ID: ${video.id}`);
    }
    const streamPayload = await getJson(`/stream/series/${encodeURIComponent(video.id)}.json`, 50_000);
    const streams = Array.isArray(streamPayload?.streams) ? streamPayload.streams : [];
    const direct = streams.filter(stream => safeHttps(stream.url) && !stream.infoHash);
    if (!direct.length) throw new Error(`${video.id} returned no direct HentaiMama stream`);
    for (const stream of direct) {
      if (Object.prototype.hasOwnProperty.call(stream, 'size') && stream.size == null) {
        throw new Error(`${video.id} emitted null size`);
      }
      if (stream.behaviorHints && Object.prototype.hasOwnProperty.call(stream.behaviorHints, 'videoSize') && stream.behaviorHints.videoSize == null) {
        throw new Error(`${video.id} emitted null behaviorHints.videoSize`);
      }
    }
    episodeResults.push({ id: video.id, directStreams: direct.length });
  }
  return { id, title: meta.name, episodes: videos.length, testedEpisodes: episodeResults };
}

async function verifyHentai() {
  const definitions = catalogDefinitions.filter(item => item.source === 'hentai');
  if (definitions.length !== 3) throw new Error(`Expected 3 Hentai catalogues, found ${definitions.length}`);
  const unique = new Map();
  const catalogs = [];
  for (const definition of definitions) {
    if (definition.type !== 'series') throw new Error(`${definition.id} is not declared as a series catalogue`);
    const payload = await getJson(`/catalog/series/${encodeURIComponent(definition.id)}.json`);
    const metas = Array.isArray(payload?.metas) ? payload.metas : [];
    if (!metas.length) throw new Error(`${definition.id} returned zero series cards`);
    for (const meta of metas) {
      if (meta.type !== 'series' || !/^hmm-[a-z0-9-]+$/.test(meta.id || '') || !safeHttps(meta.poster)) {
        throw new Error(`${definition.id} emitted an invalid HentaiMama series card`);
      }
      unique.set(meta.id, meta);
    }
    catalogs.push({ id: definition.id, cards: metas.length });
  }
  const ids = [...unique.keys()];
  const selected = HENTAI_LIMIT > 0 ? ids.slice(0, HENTAI_LIMIT) : ids;
  const results = await mapLimited(selected, Math.min(CONCURRENCY, 3), verifyHentaiSeries);
  const failures = results.filter(item => item?.error);
  if (failures.length) throw new Error(`${failures.length}/${selected.length} Hentai series failed; first: ${failures[0].error}`);
  return {
    catalogs,
    uniqueSeries: ids.length,
    testedSeries: selected.length,
    exhaustive: HENTAI_LIMIT === 0,
    results,
  };
}

(async () => {
  if (!safeHttps(BASE)) throw new Error('Base URL must be credential-free HTTPS');
  const manifest = await getJson('/manifest.json', 30_000);
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`Render version is ${manifest.version || 'unknown'}; expected ${EXPECTED_VERSION}`);
  }
  if (!Array.isArray(manifest.types) || !manifest.types.includes('series')) {
    throw new Error('Manifest does not expose series resources');
  }

  const studios = catalogDefinitions.filter(item => item.id.startsWith('tpb4k.studio.'));
  if (studios.length !== 19) throw new Error(`Expected 19 studio catalogues, found ${studios.length}`);
  const studioResults = await mapLimited(studios, Math.min(CONCURRENCY, 4), verifyStudio);
  const studioFailures = studioResults.filter(item => item?.error);
  if (studioFailures.length) {
    throw new Error(`All-19 exhaustive gate failed: ${studioFailures.map(item => item.error).join(' | ')}`);
  }

  const hentai = await verifyHentai();
  const output = {
    base: new URL(BASE).origin,
    version: manifest.version,
    studios: {
      catalogs: 19,
      visibleCardsTested: studioResults.reduce((total, item) => total + item.testedCards, 0),
      results: studioResults,
      meaning: 'Every displayed studio card returned its exact bound infoHash for AIOStreams Real-Debrid or P2P handling.',
    },
    hentai,
  };
  console.log(JSON.stringify(output, null, 2));
  console.log('SUCCESS — alpha.17 studio binding and independent HentaiMama series/episode acceptance passed.');
})().catch(error => {
  console.error(`ERROR — alpha.17 acceptance failed: ${error.message}`);
  process.exit(1);
});
