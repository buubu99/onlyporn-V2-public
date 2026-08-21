'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  filterCatalogResponse,
  metaMatchesSearch,
  searchTokens,
} = require('./search-relevance');
const { normalizeStreamResponse } = require('./stream-contract');
const {
  normalizeCandidate,
  sortCandidates,
} = require('./tpb4k/candidate');

test('native relevance requires every meaningful query token across visible metadata', () => {
  const good = {
    name: 'Closeup scene',
    description: 'soft licking',
    tags: ['pussy'],
  };
  const bad = {
    name: 'Trending random scene',
    description: 'unrelated',
  };
  assert.deepEqual(searchTokens('Pussy  licking'), ['pussy', 'licking']);
  assert.equal(metaMatchesSearch(good, 'pussy licking'), true);
  assert.equal(metaMatchesSearch(bad, 'pussy licking'), false);
  assert.deepEqual(
    filterCatalogResponse({ metas: [bad, good] }, 'pussy licking').metas,
    [good]
  );
});

test('SpankBang and XVideos search responses pass through relevance filter', () => {
  const spank = fs.readFileSync(path.join(__dirname, 'spankbang.js'), 'utf8');
  const xv = fs.readFileSync(path.join(__dirname, 'xvideos.js'), 'utf8');
  assert.match(spank, /if \(extra\.search\) return filterCatalogResponse\(primary, extra\.search\)/);
  assert.match(xv, /return search \? filterCatalogResponse\(response, search\) : response/);
});

test('TPB4K general search ranks a broad local pool while Sukebei codes bypass mature misses', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(src, /this\.searchStore\.listPool\(poolCatalogId, poolLimit\)/);
  assert.match(src, /allPool\.length >= 80 \|\| \(metadataPool\.length >= 20 && torrentPool\.length >= 20\)/);
  assert.match(src, /else if \(poolCount >= 80 && !targetedCodeSearch\)[\s\S]{0,450}searchMode = 'sqlite-warm-miss'/);
  assert.match(src, /sukebei-upstream-code-query/);
  assert.match(src, /cachedRecord\?\.metas\?\.length/);
  assert.doesNotMatch(src, /if \(cachedMatches\.length >= 4\)/);
});

test('successful V7.1 Sukebei uncensored behavior remains wired', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  for (const text of [
    'OnlyPorn Sukebei uncensored JAV code fallback filtered',
    'OnlyPorn Sukebei alias local preflight',
    'allowSingleNetworkFallback',
    'mergeSukebeiAliasResponses',
  ]) assert.ok(src.includes(text), text);
});

test('measured TPB4K poster contracts are corrected centrally', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(src, /tpb4k\.sukebei\.top'\) return 'poster'/);
  assert.match(src, /tpb4k\.yesporn\.recent'\) return 'landscape'/);
  assert.match(src, /startsWith\('tpb4k\.hentai\.'\)/);
  assert.match(src, /tpb4k\.sukebei\.hentai'\) return 'poster'/);
  assert.doesNotMatch(src, /_snapshot_/);
  assert.doesNotMatch(src, /3d1_poster/);
  assert.match(src, /wide_/);
});

test('JAVHD keeps valid search cards when artwork must fall back locally', () => {
  const src = fs.readFileSync(path.join(__dirname, 'javhdporn.js'), 'utf8');
  assert.doesNotMatch(src, /if \(\/\\\/fallback\\\.png\$\/i\.test\(poster\)\) return/);
  assert.match(src, /new meta\.MetaPreview\(id, Provider\.TYPE, title, poster/);
});

test('Sukebei phase1 contract now declares portrait poster art as poster', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tpb4k-phase1.test.js'), 'utf8');
  assert.match(src, /assert\.equal\(catalog\.metas\[0\]\.posterShape, 'poster'\)/);
  assert.match(src, /assert\.equal\(meta\.meta\.posterShape, 'poster'\)/);
});

test('release and manifest contracts include every test, P2P disclosure, and standard logo field', () => {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const addon = fs.readFileSync(path.join(__dirname, '..', 'addon.js'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-release-tests.js'), 'utf8');
  assert.equal(packageInfo.scripts['test:release'], 'npm test');
  assert.match(packageInfo.scripts.test, /scripts\/run-release-tests\.js/);
  assert.match(packageInfo.scripts['test:live-providers'], /provider\/provider\.test\.js/);
  assert.match(packageInfo.scripts['test:live-providers'], /spankbang-production-retrieval\.test\.js/);
  assert.match(runner, /filter\(name => name\.endsWith\('\.test\.js'\)\)/);
  assert.match(addon, /logo:\s*'https:\/\//);
  assert.doesNotMatch(addon, /\bicon:\s*'https:\/\//);
  assert.match(addon, /behaviorHints:\s*\{[\s\S]{0,100}adult:\s*true,[\s\S]{0,100}p2p:\s*true/);
});

test('production npm install receives every postinstall input before npm ci runs', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const npmCiAt = dockerfile.indexOf('RUN npm ci --omit=dev --no-audit --no-fund');
  assert.ok(npmCiAt > 0, 'Dockerfile must use the reproducible npm ci install');
  assert.ok(
    dockerfile.indexOf('COPY package.json package-lock.json requirements.txt /app/') < npmCiAt,
    'requirements.txt must exist before the Python postinstall runs'
  );
  assert.ok(
    dockerfile.indexOf('COPY scripts/install-python-deps.js /app/scripts/install-python-deps.js') < npmCiAt,
    'the Python dependency installer must exist before the npm postinstall runs'
  );
});

test('server owns immutable generation paths and rejects requests for other generations', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server-sdk', 'index.js'), 'utf8');
  assert.match(server, /\/media\/:generation\(g-\[a-f0-9\]\{7,40\}\)\/:token/);
  assert.match(server, /req\.params\.generation !== expectedGeneration/);
  assert.match(server, /status\(410\)/);
});

test('Android-compatible H.264 torrents lead explicit HEVC and AV1 alternatives', () => {
  const candidates = [
    normalizeCandidate({
      infoHash: '1111111111111111111111111111111111111111',
      filename: 'Scene.2160p.AV1.mkv',
      seeders: 20,
    }),
    normalizeCandidate({
      infoHash: '2222222222222222222222222222222222222222',
      filename: 'Scene.2160p.HEVC.x265.mkv',
      seeders: 20,
    }),
    normalizeCandidate({
      infoHash: '3333333333333333333333333333333333333333',
      filename: 'Scene.1080p.H264.x264.mp4',
      seeders: 20,
    }),
  ];
  assert.deepEqual(
    sortCandidates(candidates).map(candidate => candidate.codec),
    ['h264', 'hevc', 'av1']
  );
});

test('global stream contract rejects ambiguous targets and fills stable URL filenames', () => {
  const response = normalizeStreamResponse({ streams: [
    { url: 'https://onlyporn.example/media/token/video.mp4', name: '1080p' },
    { url: 'https://onlyporn.example/media/token/index.m3u8', name: '720p' },
    { url: 'https://onlyporn.example/video.mp4', infoHash: 'a'.repeat(40) },
  ] });
  assert.equal(response.streams.length, 2);
  assert.equal(response.streams[0].behaviorHints.filename, 'video.mp4');
  assert.equal(response.streams[1].behaviorHints.filename, 'index.m3u8');
});

test('generic relayed MP4 downloads are exposed to Android players as video/mp4', () => {
  const mediaRelay = require('../media-relay');
  assert.equal(
    mediaRelay._test.relayContentType({ kind: 'mp4' }, 'application/force-download'),
    'video/mp4'
  );
  assert.equal(
    mediaRelay._test.relayContentType({ kind: 'mp4' }, 'application/octet-stream'),
    'video/mp4'
  );
  assert.equal(
    mediaRelay._test.relayContentType({ kind: 'hls' }, 'application/vnd.apple.mpegurl'),
    'application/vnd.apple.mpegurl'
  );
});
