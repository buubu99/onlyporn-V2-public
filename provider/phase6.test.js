'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const { catalogs, catalogNames, getActiveProvider } = require('../catalog');
const { loadProvider } = require('./index');
const createPornhub = require('./pornhub');

const ROOT = path.resolve(__dirname, '..');

function versionAtLeast(actual, minimum) {
  const a = String(actual).split('.').map(Number);
  const b = String(minimum).split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}
const fixture = name => fs.readFileSync(
  path.join(ROOT, 'test', 'fixtures', 'pornhub', name),
  'utf8'
);

mediaRelay.setPublicBase('https://onlyporn.example');

function relayEntryFromUrl(relayUrl) {
  const token = new URL(relayUrl).pathname.split('/')[2];
  return mediaRelay._test.resolveRelayEntry(token);
}

test('Pornhub catalog parser keeps same-origin viewkeys, posters, and titles', () => {
  const provider = createPornhub();
  const results = provider.getCatalogMetas(
    fixture('catalog.html'),
    'https://www.pornhub.com/video'
  );

  assert.equal(results.length, 1);
  assert.equal(
    results[0].id,
    'https://www.pornhub.com/view_video.php?viewkey=phfixture001'
  );
  assert.equal(results[0].name, 'Fixture Pornhub Video');
  assert.match(results[0].poster, /^https:\/\/ei\.phncdn\.com\//);
  assert.equal(results[0].posterShape, 'landscape');
});

test('Pornhub metadata parser uses canonical page metadata and JSON-LD', () => {
  const provider = createPornhub();
  const response = provider.metadataFromPage(
    'https://www.pornhub.com/view_video.php?viewkey=phfixture001',
    fixture('video.html')
  );

  assert.equal(response.name, 'Fixture Pornhub Video');
  assert.equal(response.description, 'Fixture description');
  assert.match(response.poster, /^https:\/\/ei\.phncdn\.com\//);
  assert.deepEqual(response.genres, [
    'Fixture',
    '1080p',
    'Test',
    'Verified Models',
    'Interracial',
    'MILF',
    'bbc',
    'big black cock',
  ]);
  assert.equal(response.posterShape, 'landscape');
});

test('Pornhub extracts every signed HLS definition and the remote MP4 API', () => {
  const provider = createPornhub();
  const definitions = provider.mediaDefinitionsFromPage(
    fixture('video.html'),
    'https://www.pornhub.com/view_video.php?viewkey=phfixture001'
  );

  assert.deepEqual(
    definitions.map(item => `${item.quality || 'none'}:${item.kind}`),
    ['1080p:hls', '720p:hls', '480p:hls', '240p:hls', 'none:api']
  );
  assert.match(definitions[0].url, /h=abc%2B123&e=9999999999&f=1$/);
  assert.match(definitions[4].url, /\/video\/get_media\?/);
});

test('Pornhub returns all unique HLS and MP4 resolutions through the protected relay', async () => {
  const provider = createPornhub();
  provider.fetchPornhubText = async () => fixture('video.html');
  provider.fetchPornhubJson = async () => JSON.parse(fixture('mp4-response.json'));

  const response = await provider.processStreams({
    id: 'https://www.pornhub.com/view_video.php?viewkey=phfixture001',
  });

  assert.equal(response.streams.length, 6);
  assert.deepEqual(
    response.streams.map(stream => stream.name),
    [
      'Pornhub 1080p HLS',
      'Pornhub 1080p MP4',
      'Pornhub 720p HLS',
      'Pornhub 720p MP4',
      'Pornhub 480p HLS',
      'Pornhub 240p HLS',
    ]
  );
  assert.ok(response.streams.every(stream => /^https:\/\/onlyporn\.example\/media\//.test(stream.url)));
  assert.ok(response.streams.every(stream => stream.behaviorHints.notWebReady === false));
});

test('Pornhub relay allows safe phncdn subdomains and rejects lookalike hosts', () => {
  assert.equal(mediaRelay._test.hostnameAllowed('hv-h.phncdn.com', 'pornhub'), true);
  assert.equal(mediaRelay._test.hostnameAllowed('ev-h.phncdn.com', 'pornhub'), true);
  assert.equal(mediaRelay._test.hostnameAllowed('cv-h.phncdn.com', 'pornhub'), true);
  assert.equal(mediaRelay._test.hostnameAllowed('phncdn.com.evil.example', 'pornhub'), false);
  assert.equal(mediaRelay._test.hostnameAllowed('evilphncdn.com', 'pornhub'), false);
});

test('Pornhub HLS rewriting preserves signed child query parameters', () => {
  const masterUrl =
    'https://hv-h.phncdn.com/hls/fixture/1080P_4000K_fixture.mp4/master.m3u8?h=root&e=1785293935&f=1';
  const relayUrl = mediaRelay.register({
    url: masterUrl,
    headers: {
      Referer: 'https://www.pornhub.com/view_video.php?viewkey=phfixture001',
      Origin: 'https://www.pornhub.com',
    },
    provider: 'pornhub',
    kind: 'hls',
  });
  const entry = relayEntryFromUrl(relayUrl);
  const rewrittenMaster = mediaRelay._test.rewritePlaylist(
    fixture('master.m3u8'),
    masterUrl,
    entry
  );
  const childRelayUrl = rewrittenMaster
    .split(/\r?\n/)
    .find(line => line.startsWith('https://onlyporn.example/media/'));
  const childEntry = relayEntryFromUrl(childRelayUrl);

  assert.equal(
    childEntry.url,
    'https://hv-h.phncdn.com/hls/fixture/1080P_4000K_fixture.mp4/index-v1-a1.m3u8?h=Mo6pCF9y%2F%2FimDigLoywFr8113%2BE%3D&e=1785293935&f=1'
  );

  const rewrittenVariant = mediaRelay._test.rewritePlaylist(
    fixture('variant.m3u8'),
    childEntry.url,
    childEntry
  );
  const segmentRelayUrl = rewrittenVariant
    .split(/\r?\n/)
    .find(line => line.startsWith('https://onlyporn.example/media/'));
  const segmentEntry = relayEntryFromUrl(segmentRelayUrl);

  assert.equal(segmentEntry.kind, 'segment');
  assert.equal(
    segmentEntry.url,
    'https://hv-h.phncdn.com/hls/fixture/1080P_4000K_fixture.mp4/seg-1-v1-a1.ts?h=Mo6pCF9y%2F%2FimDigLoywFr8113%2BE%3D&e=1785293935&f=1'
  );
});

test('Pornhub Chrome helper is isolated and preloads public-access cookies', () => {
  const helper = fs.readFileSync(
    path.join(ROOT, 'scripts', 'pornhub_safari_fetch_helper.py'),
    'utf8'
  );
  const client = fs.readFileSync(
    path.join(ROOT, 'provider', 'pornhub-safari-impersonation.js'),
    'utf8'
  );

  assert.match(helper, /PORNHUB_IMPERSONATE", "chrome"/);
  assert.match(helper, /"age_verified": "1"/);
  assert.match(helper, /"accessAgeDisclaimerPH": "1"/);
  assert.match(helper, /"accessAgeDisclaimerUK": "1"/);
  assert.match(helper, /"accessPH": "1"/);
  assert.match(helper, /"platform": "pc"/);
  assert.match(helper, /"pornhub\.org"/);
  assert.doesNotMatch(helper, /spankbang|javhdporn/i);
  assert.match(client, /pornhub_safari_fetch_helper\.py/);
});

test('Pornhub accepts only its exact public .com and .org page hosts', () => {
  const { canonicalVideoUrl } = createPornhub._test;
  assert.equal(
    canonicalVideoUrl('https://www.pornhub.org/view_video.php?viewkey=phfixture001'),
    'https://www.pornhub.com/view_video.php?viewkey=phfixture001'
  );
  assert.equal(
    canonicalVideoUrl('https://redirect.pornhub.org/view_video.php?viewkey=phfixture001'),
    ''
  );
  assert.equal(
    canonicalVideoUrl('https://pornhub.org.attacker.example/view_video.php?viewkey=phfixture001'),
    ''
  );
});

test('Pornhub routes, manifest wiring, and release version are deterministic', () => {
  const provider = createPornhub();
  assert.equal(
    provider.handleSearch({ extra: { search: 'Japanese Amateur' } }),
    'https://www.pornhub.com/video/search?search=Japanese+Amateur'
  );
  assert.equal(
    provider.handlePagination('https://www.pornhub.com/video', { extra: { skip: 40 } }),
    'https://www.pornhub.com/video?page=2'
  );
  assert.equal(catalogNames.includes('pornhub'), true);
  assert.equal(catalogNames.length, 8);
  assert.equal(catalogs.length, 9);
  assert.equal(new Set(catalogs.map(item => item.id)).size, 9);
  assert.equal(getActiveProvider('onlyporn:pornhub:test'), 'pornhub');
  assert.equal(loadProvider('pornhub').getName(), 'pornhub');

  const pkg = require('../package.json');
  assert.equal(versionAtLeast(pkg.version, '2.6.0'), true);
  assert.equal(pkg.scripts['test:release'], 'npm test');
});
