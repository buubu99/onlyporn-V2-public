'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { bindStudioPlayback, scorePair, itemFeatures } = require('./tpb4k/studio-playback-binding');
const { recoverStudioPlayback } = require('./tpb4k/studio-targeted-recovery');
const { BUNDLE_VERSION, decodeTpb4kId, encodeTpb4kId } = require('./tpb4k/id-codec');
const { normalizeKnabenHit } = require('./tpb4k/knaben');
const { iframeUrls, mediaUrls, parseAjaxFields, episodeId, seriesId } = require('./tpb4k/hentaimama-series');
const { renderSukebeiRssSvg, sukebeiRssPosterUrl } = require('./tpb4k/sukebei-rss-poster');
const { audit } = require('../tools/audit-zero-comparison-dependency');

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';

function metadata(sourceId = 'tpdb:scene-1', title = 'Pool Day With Her Was Perfect') {
  return {
    sourceId,
    title,
    studio: 'Vixen',
    releaseDate: '2026-07-28',
    performers: ['Summer Kline'],
    poster: 'https://images.example/scene.jpg',
  };
}
function torrent(infoHash, suffix, seeders) {
  return {
    sourceId: `torrent:${infoHash}`,
    title: `Vixen Pool Day With Her Was Perfect 2026 07 28 ${suffix}`,
    studio: 'Vixen',
    filename: `Vixen.Pool.Day.${suffix}.mkv`,
    infoHash,
    resolution: suffix,
    indexer: 'knaben',
    seeders,
  };
}

test('version-3 IDs preserve every distinct catalog-bound torrent', () => {
  const id = encodeTpb4kId({
    source: 'studio-metadata',
    sourceId: 'tpdb:scene-1',
    catalogId: 'tpb4k.studio.vixen.top',
    torrents: [torrent(H1, '2160p', 12), torrent(H2, '1080p', 22), torrent(H3, '720p', 30)],
  });
  const decoded = decodeTpb4kId(id);
  assert.equal(decoded.version, BUNDLE_VERSION);
  assert.deepEqual(decoded.torrents.map(value => value.infoHash), [H1, H2, H3]);
  assert.equal(decoded.torrent.infoHash, H1);
  assert.ok(id.length < 4096);
});

test('one poster keeps multiple high-confidence hashes while one hash owns one poster', () => {
  const result = bindStudioPlayback({
    catalog: { id: 'tpb4k.studio.vixen.top', studio: 'Vixen' },
    metadataItems: [metadata(), metadata('tpdb:scene-2', 'Completely Different Scene')],
    torrentItems: [torrent(H1, '2160p', 12), torrent(H2, '1080p', 22), torrent(H3, '720p', 30)],
    limit: 40,
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(new Set(result.items[0].playbackCandidates.map(value => value.infoHash)), new Set([H1, H2, H3]));
  assert.equal(result.stats.multiCandidateScenes, 1);
  assert.equal(result.stats.boundCandidates, 3);
});

test('OnlyFans never matches merely because both rows contain the platform word', () => {
  const meta = itemFeatures({ title: 'Alice Wonderland Private Shower', performers: ['Alice Wonderland'], studio: 'OnlyFans' }, 'OnlyFans');
  const unrelated = {
    infoHash: H1,
    seeders: 10,
    item: { title: 'OnlyFans Bob Random Clip', infoHash: H1 },
    features: itemFeatures({ title: 'OnlyFans Bob Random Clip', studio: 'OnlyFans' }, 'OnlyFans'),
  };
  const related = {
    infoHash: H2,
    seeders: 10,
    item: { title: 'Alice Wonderland Private Shower OnlyFans', infoHash: H2 },
    features: itemFeatures({ title: 'Alice Wonderland Private Shower OnlyFans', studio: 'OnlyFans' }, 'OnlyFans'),
  };
  assert.equal(scorePair(meta, unrelated, 'tpdb:alice').accepted, false);
  assert.equal(scorePair(meta, related, 'tpdb:alice').accepted, true);
});

test('targeted recovery can restore an empty studio and preserve multiple candidates', async () => {
  const resolverAdapter = {
    async resolve({ item }) {
      return [
        { ...torrent(H1, '2160p', 10), studio: 'DigitalPlayground', title: `Digital Playground ${item.title} 2160p` },
        { ...torrent(H2, '1080p', 20), studio: 'DigitalPlayground', title: `Digital Playground ${item.title} 1080p` },
      ];
    },
  };
  const result = await recoverStudioPlayback({
    catalog: { id: 'tpb4k.studio.digitalplayground.top', studio: 'DigitalPlayground' },
    metadataItems: [{ ...metadata(), studio: 'DigitalPlayground' }],
    torrentItems: [],
    resolverAdapter,
    skip: 0,
    limit: 40,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].playbackCandidates.length, 2);
  assert.equal(result.recovery.recoveredCandidates, 2);
});


test('targeted Knaben matching accepts token-overlap results without weakening broad studio searches', () => {
  const hit = {
    hash: H1,
    title: 'Alice Wonderland - Private Shower Adventure - 1080p',
    seeders: 12,
    bytes: 123456,
  };
  assert.equal(normalizeKnabenHit(hit, 'OnlyFans', {}), null);
  const targeted = normalizeKnabenHit(hit, 'Alice Wonderland Private Shower OnlyFans', { targeted: true });
  assert.equal(targeted.infoHash, H1);
  assert.equal(normalizeKnabenHit({ ...hit, title: 'Bob Random Clip' }, 'Alice Wonderland Private Shower', { targeted: true }), null);
});

test('OnlyPorn owns a private Hentai namespace and extracts direct AJAX media', () => {
  assert.equal(seriesId('example-series'), 'ophmm-example-series');
  assert.equal(episodeId('example-series', 2), 'ophmm-example-series:1:2');
  const fields = parseAjaxFields(JSON.stringify({ html: '<iframe src="https://player.hentaimama.io/embed/1"></iframe>', file: 'https:\\/\\/cdn.example.org\\/video-1080p.mp4' }));
  assert.ok(fields.length >= 2);
  assert.deepEqual(mediaUrls(fields.join('\n')), ['https://cdn.example.org/video-1080p.mp4']);
  assert.deepEqual(iframeUrls('<iframe src=\"https://changing-player.example.net/embed/1\"></iframe>', 'https://hentaimama.io/'), ['https://changing-player.example.net/embed/1']);
});

test('Sukebei RSS posters are distinct title-bearing internal assets', () => {
  const left = sukebeiRssPosterUrl({ infoHash: H1, title: 'First Japanese release' }, {}, { ONLYPORN_PUBLIC_BASE_URL: 'https://onlyporn.example' });
  const right = sukebeiRssPosterUrl({ infoHash: H2, title: 'Second Japanese release' }, {}, { ONLYPORN_PUBLIC_BASE_URL: 'https://onlyporn.example' });
  assert.notEqual(left, right);
  assert.match(left, /^https:\/\/onlyporn\.example\/onlyporn\/poster\/sukebei-rss\//);
  assert.match(renderSukebeiRssSvg(H1, 'First Japanese release'), /First Japanese release/);
});


test('requested catalog capacity prevents a second resolver search for an already-bound card', async () => {
  let resolverCalls = 0;
  const result = await recoverStudioPlayback({
    catalog: { id: 'tpb4k.studio.vixen.top', studio: 'Vixen' },
    metadataItems: [metadata('tpdb:vixen-one', 'Scene One')],
    torrentItems: [{
      sourceId: 'torrent:vixen-one',
      title: 'Vixen Scene One 2160p',
      studio: 'Vixen',
      filename: 'Vixen.Scene.One.2160p.mkv',
      infoHash: H1,
      resolution: '4K',
      indexer: 'hiddenbay',
      seeders: 20,
    }],
    resolverAdapter: { async resolve() { resolverCalls += 1; return []; } },
    skip: 0,
    limit: 1,
  });
  assert.equal(result.items.length, 1);
  assert.equal(resolverCalls, 0);
  assert.equal(result.recovery.attempted, 0);
});

test('the Alpha.20 installer preserves the retained single-token Scene matching threshold', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../tools/apply-alpha20.js'), 'utf8');
  assert.match(installer, /expectedTokens\[0\]\.length >= 3/);
  assert.doesNotMatch(installer, /expectedTokens\[0\]\.length >= 6/);
  assert.match(installer, /coverage >= 0\.75/);
});

test('catalog, manifest, stream labels, and runtime code are independent from the comparison addon', () => {
  const root = path.resolve(__dirname, '..');
  const catalogs = require('../catalog/tpb4k').catalogDefinitions;
  assert.equal(catalogs.filter(item => item.id.startsWith('tpb4k.sukebei.')).length, 2);
  assert.ok(catalogs.some(item => item.id === 'tpb4k.sukebei.top'));
  assert.ok(catalogs.some(item => item.id === 'tpb4k.sukebei.hentai'));
  const addon = fs.readFileSync(path.join(root, 'addon.js'), 'utf8');
  assert.match(addon, /idPrefixes: \['onlyporn:', 'ophmm-', 'ophtop-'\]/);
  assert.doesNotMatch(addon, /(['"`])hmm-/);
  const candidate = fs.readFileSync(path.join(__dirname, 'tpb4k/candidate.js'), 'utf8');
  assert.match(candidate, /OnlyPorn ·/);
  assert.doesNotMatch(candidate, /TPB 4K IMPROVED/);
  audit(root);
});
