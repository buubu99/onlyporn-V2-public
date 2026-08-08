const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const { catalogs, catalogNames, getActiveProvider } = require('../catalog');
const { loadProvider } = require('./index');
const createJavHdPorn = require('./javhdporn');
const { decodeSource } = require('./javhdporn-poster-proxy');
const { dex, playerKey, rc4 } = require('./javhdporn-player');

const fixture = name => fs.readFileSync(
  path.join(__dirname, '..', 'test', 'fixtures', 'javhdporn', name),
  'utf8'
);

const KNOWN_MPU = 'akC0aU8htw9clDvQW3GDO7LQCFhKOqZc6uZ++6s1BS+yTFAr6pi2aK6HLvUc21dwKF05NQE9zB1onWA2vXpXQXEeQfx6TaXK4ObAPF9o0RyQQhBAN9xKMk9oAY9eH4gNO9pW2ZdDzV2MF8JrRWr9FvXU4dLTKzRRVqeYdl1gSweXhZm5Ro9lJV4QL6dsNiEQ6XfMj58ozXRNTKlh+rvmVRMzDDSoIzm+3+imyUBCtZhVOd1TikggiNXrPEwYTsOHrbsImVJjg//QUWhn/t4OwIbTRv5KLdoZ9opnYFbyrKN81ev/JdMGvj13yl3uGGr39YvcZNRgJhLBuzVKE0O6b+TsGonr0d2wqoKov+uhcQBPUOnEK8rSobfFVeF3LdzXvAqbxaQQ5HtSv2uPiUvnXfqQYjAvD4Db8V5OtI5qgOHc0mrVqLvdcCCiEVRdMU/WfFlfkp49hPOCHAtp5l9L0utpSR9mvCIfnRd/r1p+ZXTpLJdU8iss+BsgKcNPakzy2G5LRB+WWGoYiFs/tx6QGvg5sevz3591+aGETpIJFYf0xfe+UFB6SCNJEAioHaX2hRaHkuQDmFmCsbEU7JZuf5ZWNZYPkjzsx+V79yZT1EDiRxdYzQeyA+H/V81D+5HJzHuubXi11Bg=';
const KNOWN_SOURCES = 'hVzwA35nqP0GZAH-jVyRu3Khc-t7APQSDFvifzgPJNmBJsFBKGs-G8Nx05em_HaPp9XafDKoBLs9b2lLbSyei4ot6O2q8zuaClX9lQZAZvLTYNireLV_IndNuwwaKK3Fis7oE54sas8JdYnmlQ1jJK61Lu59SDcXK5-UE9thejV5boEEkraxZh_2ojVcU8G7AYzBfP9c50A-fWKYtE6uH3lTsKWqFrBtfJwGlQUxp1ltVrLj9MdUL6QJ9F_90hLI6NB8R-WBEflZ5pZhIdbzkSCLzTv9v39sy-5AlACIu8GNTF740CJUxtizsjVeHIP7HE1SNwTop1UguJ5CcJduRwlvLpBwzuYygIVe3hfL_7XgsA';

function encryptPlayerValue(videoId, plaintext, version = '2') {
  const base64Plaintext = Buffer.from(plaintext, 'latin1').toString('base64');
  return rc4(
    Buffer.from(base64Plaintext, 'latin1'),
    playerKey(videoId, version, false)
  ).toString('base64');
}

test('JAVHDPorn player bootstrap decoder matches the captured version-2 vector', () => {
  assert.equal(dex('867641', KNOWN_MPU, true, '2'), KNOWN_SOURCES);
});

test('JAVHDPorn catalog parser accepts same-origin videos and rejects external links', () => {
  const provider = createJavHdPorn();
  const results = provider.getCatalogMetas(fixture('catalog.html'), provider.baseUrl);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'https://www.javhdporn.net/video/seo-001/');
  assert.equal(results[0].posterShape, 'landscape');
  assert.match(results[0].poster, /\/onlyporn\/poster\/javhdporn\//);
  assert.match(decodeSource(results[0].poster.split('/').pop()), /pics\.pornfhd\.com/);
});

test('JAVHDPorn metadata uses JSON-LD and preserves player bootstrap values', () => {
  const provider = createJavHdPorn();
  const response = provider.metadataFromPage(
    'https://www.javhdporn.net/video/seo-001/',
    fixture('video.html')
  );
  assert.equal(response.name, 'SEO-001 Body Bukkake 2 + Cult Of Selling Daughter Amateur');
  assert.equal(response.runtime, '120 min');
  assert.equal(response.releaseInfo, '2026');
  assert.deepEqual(response.cast, ['Kotone Amamiya']);
  assert.equal(response.extra.playerVideoId, '867641');
  assert.equal(response.extra.playerVersion, '2');
});

test('JAVHDPorn player API request posts the decoded sources token and decrypts the result', async () => {
  const provider = createJavHdPorn();
  let captured;
  provider.fetchSafariJson = async (url, options) => {
    captured = { url, options };
    return {
      status: true,
      data: encryptPlayerValue('867641', '//video.javhdporn.net/player/master.m3u8'),
    };
  };

  const values = await provider.requestPlayerSources(
    'https://www.javhdporn.net/video/seo-001/',
    { videoId: '867641', mpu: KNOWN_MPU, version: '2' }
  );
  assert.equal(captured.url, 'https://www.javhdporn.net/api/play/');
  assert.equal(captured.options.method, 'POST');
  assert.match(captured.options.data, new RegExp(`sources=${encodeURIComponent(KNOWN_SOURCES)}`));
  assert.equal(values[0].value, '//video.javhdporn.net/player/master.m3u8');
});

test('JAVHDPorn player-page parser ignores advertising MP4s and keeps genuine media', () => {
  const { extractPlayerCandidates } = createJavHdPorn._test;
  const candidates = extractPlayerCandidates(`
    <iframe src="https://video.javhdporn.net/embed/abc"></iframe>
    <video src="https://cdn.storagexhd.com/banner_300x250/9202-1-300x250.medium.mp4"></video>
    <script>const file = "https://video.javhdporn.net/media/1080p/master.m3u8";</script>
  `, 'https://www.javhdporn.net/video/seo-001/');
  assert.ok(candidates.some(candidate => candidate.url.includes('/embed/abc')));
  assert.ok(candidates.some(candidate => candidate.url.endsWith('/1080p/master.m3u8')));
  assert.ok(candidates.every(candidate => !candidate.url.includes('300x250')));
});

test('JAVHDPorn media relay hosts and manifest wiring are present', () => {
  mediaRelay.setPublicBase('https://onlyporn.example');
  const relayUrl = mediaRelay.register({
    url: 'https://video.javhdporn.net/media/master.m3u8',
    headers: { Referer: 'https://www.javhdporn.net/video/seo-001/' },
    provider: 'javhdporn',
    kind: 'hls',
  });
  assert.match(relayUrl, /^https:\/\/onlyporn\.example\/media\//);
  assert.equal(catalogNames.includes('javhdporn'), true);
  assert.equal(catalogs.length >= 8, true);
  assert.equal(new Set(catalogs.map(item => item.id)).size, catalogs.length);
  assert.equal(getActiveProvider('onlyporn:javhdporn:test'), 'javhdporn');
  assert.equal(loadProvider('javhdporn').getName(), 'javhdporn');
});

test('JAVHDPorn search, genres, and pagination build deterministic routes', () => {
  const provider = createJavHdPorn();
  assert.equal(provider.handleSearch({ extra: { search: 'Kotone Amamiya' } }), 'https://www.javhdporn.net/?s=Kotone+Amamiya');
  assert.equal(provider.handleGenre({ extra: { genre: 'Uncensored' } }), 'https://www.javhdporn.net/v2/category/uncensored/');
  assert.equal(
    provider.handlePagination('https://www.javhdporn.net/v3/category/censored/', { extra: { skip: 24 } }),
    'https://www.javhdporn.net/v3/category/censored/page/2/'
  );
});
