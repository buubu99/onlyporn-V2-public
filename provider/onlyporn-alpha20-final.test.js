'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { bindCatalogIdentity } = require('./tpb4k/studio-metadata');
const { bindStudioPlayback } = require('./tpb4k/studio-playback-binding');
const { recoverStudioPlayback } = require('./tpb4k/studio-targeted-recovery');
const { createSukebeiArtworkStore } = require('./tpb4k/sukebei-artwork-store');
const { dedupeCandidates, indexerReliability, normalizeCandidate, sortCandidates, toStremioStream } = require('./tpb4k/candidate');

const ROOT = path.resolve(__dirname, '..');
const H = index => String(index).repeat(40).slice(0, 40);
function metadata(index, studio = 'DigitalPlayground') {
  return {
    sourceId: `tpdb:scene-${index}`,
    title: `Distinctive Scene Number ${index}`,
    studio,
    poster: `https://images.example/scene-${index}.jpg`,
    performers: [`Performer ${index}`],
  };
}
function torrent(index, studio = 'DigitalPlayground', extra = {}) {
  return {
    sourceId: `torrent:${index}`,
    title: `${studio} Distinctive Scene Number ${index} ${extra.resolution || '1080p'}`,
    filename: `${studio}.Distinctive.Scene.Number.${index}.${extra.resolution || '1080p'}.mp4`,
    studio,
    infoHash: extra.infoHash || H(index),
    resolution: extra.resolution || '1080p',
    indexer: extra.indexer || 'knaben',
    seeders: extra.seeders ?? 10,
    cacheStatus: extra.cacheStatus,
  };
}

test('enabled manifest has the intentional 37 total / 28 internal contract below 8 KiB', () => {
  const probe = spawnSync(process.execPath, ['-e', `
    const addon = require('./addon');
    const serialized = JSON.stringify(addon.manifest);
    const total = addon.manifest.catalogs.length;
    const internal = addon.manifest.catalogs.filter(item => String(item.id || '').startsWith('tpb4k.')).length;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    console.log(JSON.stringify({ total, internal, bytes }));
    if (total !== 37 || internal !== 28 || bytes >= 8192) process.exit(41);
  `], { cwd: ROOT, env: { ...process.env, TPB4K_ENABLED: 'true', LOG_ENABLED: 'false', ONLYPORN_DISABLE_PERSISTENT_CACHE: '1' }, encoding: 'utf8' });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});

test('candidate ranking uses resolution, seeders, and explicit indexer reliability', () => {
  assert.ok(indexerReliability('1337x') > indexerReliability('unknown-indexer'));
  const trusted = normalizeCandidate(torrent(1, 'SexMex', { infoHash: H(1), indexer: '1337x', seeders: 10 }));
  const unknown = normalizeCandidate(torrent(2, 'SexMex', { infoHash: H(2), indexer: 'unknown-indexer', seeders: 10 }));
  assert.equal(sortCandidates([unknown, trusted])[0].infoHash, H(1));
});

test('OnlyFans creator identity survives metadata binding and becomes searchable evidence', () => {
  const raw = {
    id: 'onlyfans-1',
    title: 'Private Shower',
    creator: { name: 'Alice Wonderland', username: 'alice_wonder' },
    account: { username: 'alice_wonder' },
  };
  const normalized = {
    upstreamId: 'onlyfans-1',
    title: 'Private Shower',
    poster: 'https://images.example/alice.jpg',
    background: 'https://images.example/alice-bg.jpg',
    performers: ['Alice Wonderland'],
    tags: ['OnlyFans'],
  };
  const bound = bindCatalogIdentity('tpdb', raw, normalized, 'OnlyFans');
  assert.equal(bound.creator, 'Alice Wonderland');
  assert.equal(bound.username, 'alice_wonder');
  assert.match(bound.lookupQuery, /Alice Wonderland|alice_wonder/i);
});

test('targeted recovery continues past a failed missing slot until the card target is reached', async () => {
  const metadataItems = Array.from({ length: 10 }, (_, index) => metadata(index + 1));
  const torrentItems = Array.from({ length: 7 }, (_, index) => torrent(index + 1));
  const calls = [];
  const result = await recoverStudioPlayback({
    catalog: { id: 'tpb4k.studio.digitalplayground.top', studio: 'DigitalPlayground' },
    metadataItems,
    torrentItems,
    resolverAdapter: {
      async resolve({ item }) {
        calls.push(item.sourceId);
        const index = Number(item.sourceId.split('-').pop());
        if (index === 8) return [];
        if (index === 9) return [torrent(9)];
        return [];
      },
    },
    limit: 8,
  });
  assert.equal(result.items.length, 8);
  assert.ok(result.recovery.attempted >= 2, JSON.stringify(result.recovery));
  assert.ok(calls.includes('tpdb:scene-9'));
});

test('SexMex queued candidate remains a standard P2P stream beside its alternative', () => {
  const queued = normalizeCandidate(torrent(1, 'SexMex', { infoHash: H(1), resolution: '720p', seeders: 18, indexer: 'knaben', cacheStatus: 'queued' }));
  const fallback = normalizeCandidate(torrent(2, 'SexMex', { infoHash: H(2), resolution: '1080p', seeders: 8, indexer: '1337x', cacheStatus: 'unknown' }));
  const streams = dedupeCandidates([queued, fallback]).map(toStremioStream).filter(Boolean);
  assert.deepEqual(new Set(streams.map(item => item.infoHash)), new Set([H(1), H(2)]));
  assert.equal(streams.length, 2);
  assert.ok(streams.every(item => !item.url));
});

test('one SexMex poster retains both exact hashes without click-time searching', () => {
  const result = bindStudioPlayback({
    catalog: { id: 'tpb4k.studio.sexmex.top', studio: 'SexMex' },
    metadataItems: [{ sourceId: 'tpdb:sexmex-1', title: 'Happy Hour For Three', studio: 'SexMex', poster: 'https://images.example/sexmex.jpg' }],
    torrentItems: [
      { ...torrent(1, 'SexMex', { infoHash: H(1), resolution: '720p', seeders: 18 }), title: 'SexMex Happy Hour For Three 720p' },
      { ...torrent(2, 'SexMex', { infoHash: H(2), resolution: '1080p', seeders: 8, indexer: '1337x' }), title: 'SexMex Happy Hour For Three 1080p' },
    ],
    limit: 40,
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(new Set(result.items[0].playbackCandidates.map(item => item.infoHash)), new Set([H(1), H(2)]));
});

test('process-level cache isolation cannot be shadowed by an adapter env object', () => {
  const probe = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createSukebeiArtworkStore } = require('./provider/tpb4k/sukebei-artwork-store');
    const shared = createSukebeiArtworkStore({ env: { ONLYPORN_CONTENT_FILTER_ENABLED: 'false' } });
    if (shared.enabled || shared.filePath) process.exit(51);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-sukebei-explicit-'));
    try {
      const explicit = createSukebeiArtworkStore({ env: {}, filePath: path.join(directory, 'art.json') });
      if (!explicit.enabled || !explicit.filePath) process.exit(52);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  `], {
    cwd: ROOT,
    env: { ...process.env, ONLYPORN_DISABLE_PERSISTENT_CACHE: '1' },
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, `${probe.stdout}
${probe.stderr}`);
});

test('Sukebei disk cache is atomic, bounded, expires, and cannot renew itself from a cache read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onlyporn-sukebei-store-'));
  const filePath = path.join(directory, 'art.json');
  let clock = 100_000;
  try {
    const first = createSukebeiArtworkStore({ filePath, env: {}, now: () => clock, maxAgeMs: 60_000, refreshIntervalMs: 10_000 });
    const networkItem = { sourceId: 'sukebei:item-1', title: 'Example', poster: 'https://images.example/poster.jpg', background: 'https://images.example/background.jpg', lookupSource: 'sukebei-detail' };
    assert.equal(first.set(networkItem), true);
    assert.equal(first.set(networkItem), false);
    clock = 100_500;
    const second = createSukebeiArtworkStore({ filePath, env: {}, now: () => clock, maxAgeMs: 60_000, refreshIntervalMs: 10_000 });
    const restored = second.get('sukebei:item-1');
    assert.equal(restored.poster, networkItem.poster);
    assert.equal(second.set({ ...restored, lookupSource: 'sukebei-persistent-cache' }), false);
    clock = 161_000;
    const expired = createSukebeiArtworkStore({ filePath, env: {}, now: () => clock, maxAgeMs: 60_000, refreshIntervalMs: 10_000 });
    assert.equal(expired.get('sukebei:item-1'), null);
    assert.equal(expired.set({ sourceId: 'sukebei:rss', poster: 'https://onlyporn.example/onlyporn/poster/sukebei-rss/abc.svg', lookupSource: 'sukebei-rss-fallback' }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
