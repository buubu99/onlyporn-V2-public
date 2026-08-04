#!/usr/bin/env node
'use strict';

const { decodeTpb4kId } = require('../provider/tpb4k/id-codec');

const BASE = String(process.env.ONLYPORN_RENDER_BASE_URL || 'https://onlyporn-v2-public-k143.onrender.com').replace(/\/$/, '');
const EXPECTED = process.env.EXPECTED_VERSION || '2.7.0-alpha.24';
const TIMEOUT_MS = Math.max(Number(process.env.ONLYPORN_ACCEPTANCE_TIMEOUT_MS || 120_000), 10_000);
const WEAK_STUDIOS = [
  'tpb4k.studio.digitalplayground.top',
  'tpb4k.studio.onlyfans.top',
  'tpb4k.studio.sexmex.top',
];

function fail(message) { throw new Error(message); }
function fakePoster(value) {
  return /(?:imagetwist|imgtwist|\/assets\/tpb4k\/studios\/|\/onlyporn\/poster\/studio-release\/)/i.test(String(value || ''));
}
async function json(path) {
  const separator = path.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}${separator}a24=${Date.now()}-${Math.random()}`, {
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    if (!response.ok) fail(`${path}: HTTP ${response.status}`);
    return response.json();
  } finally { clearTimeout(timer); }
}
async function catalog(type, id) { return json(`/catalog/${type}/${id}.json?skip=0`); }
async function meta(type, id) { return json(`/meta/${type}/${encodeURIComponent(id)}.json`); }
async function stream(type, id) { return json(`/stream/${type}/${encodeURIComponent(id)}.json`); }

(async () => {
  const manifest = await json('/manifest.json');
  const internal = (manifest.catalogs || []).filter(item => String(item.id || '').startsWith('tpb4k.'));
  const sukebeiRows = internal.filter(item => String(item.id || '').startsWith('tpb4k.sukebei.'));
  if (manifest.version !== EXPECTED) fail(`manifest ${manifest.version}; expected ${EXPECTED}`);
  if ((manifest.catalogs || []).length !== 35 || internal.length !== 26) fail(`manifest counts ${(manifest.catalogs || []).length}/${internal.length}; expected 35/26`);
  if (sukebeiRows.length !== 1 || sukebeiRows[0].id !== 'tpb4k.sukebei.top') fail('Sukebei must expose exactly one Top catalogue');
  console.log(`MANIFEST ${manifest.version}: 35 total / 26 internal / one Sukebei`);

  for (const id of WEAK_STUDIOS) {
    const body = await catalog('movie', id);
    const cards = Array.isArray(body.metas) ? body.metas : [];
    if (!cards.length) fail(`${id}: no verified playable cards`);
    for (const card of cards) {
      if (!/^https:\/\//i.test(String(card.poster || '')) || fakePoster(card.poster)) fail(`${id}: fake or missing poster leaked`);
    }
    let sample = cards[0];
    if (id === 'tpb4k.studio.sexmex.top') {
      sample = cards.slice(0, 8).find(card => (decodeTpb4kId(card.id)?.torrents || []).length > 1);
      if (!sample) fail(`${id}: no early card contains multiple failover hashes`);
    }
    const expectedHashes = (decodeTpb4kId(sample.id)?.torrents || []).map(item => String(item.infoHash || '').toLowerCase());
    if (!expectedHashes.length) fail(`${id}: first card has no catalogue-bound torrent`);
    const resolved = await stream('movie', sample.id);
    const returned = new Set((resolved.streams || []).map(item => String(item.infoHash || '').toLowerCase()));
    if (!expectedHashes.every(hash => returned.has(hash))) fail(`${id}: not every catalogue-bound torrent was returned by stream endpoint`);
    console.log(`STUDIO ${id}: ${cards.length} verified cards; ${expectedHashes.length} playback candidate(s) bound`);
  }

  const sukebei = await catalog('movie', 'tpb4k.sukebei.top');
  const sukebeiCards = Array.isArray(sukebei.metas) ? sukebei.metas : [];
  if (!sukebeiCards.length || sukebeiCards.length > 8) fail(`Sukebei returned ${sukebeiCards.length}; expected 1..8`);
  if (sukebeiCards.some(item => /imagetwist|imgtwist/i.test(String(item.poster || '')))) fail('Sukebei leaked ImageTwist artwork');
  console.log(`SUKEBEI: ${sukebeiCards.length}/8 cards; no duplicate catalogue`);

  const top = await catalog('series', 'tpb4k.hentai.top');
  const topCard = top.metas?.[0];
  if (!topCard || !String(topCard.id || '').startsWith('ophtop-')) fail('Hentai Top did not publish its fresh series identity');
  const detail = (await meta('series', topCard.id)).meta;
  const episode = detail?.videos?.[0];
  if (!episode?.id) fail('Hentai Top stopped before the episode layer');
  const playback = await stream('series', episode.id);
  if (!(playback.streams || []).some(item => /^https:\/\//i.test(String(item.url || '')))) fail('Hentai Top episode has no validated HentaiMama playback');
  console.log(`HENTAI TOP: ${topCard.id} -> ${detail.videos.length} episodes -> playable`);

  console.log('SUCCESS: Alpha.24 recovery live acceptance passed.');
})().catch(error => {
  console.error(`ALPHA24_LIVE_FAIL: ${error.message}`);
  process.exit(1);
});
