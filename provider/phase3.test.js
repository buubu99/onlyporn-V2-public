const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Provider = require('./provider');
const mediaRelay = require('../media-relay');
const { catalogs, catalogNames } = require('../catalog');
const { loadProvider } = require('./index');

const createEporner = require('./eporner');
const createSpankbang = require('./spankbang');
const createXhamster = require('./xhamster');
const createPorntrex = require('./porntrex');
const createXvideos = require('./xvideos');
const createXnxx = require('./xnxx');

const FIXTURE_ROOT = path.join(__dirname, '..', 'test', 'fixtures');
mediaRelay.setPublicBase('https://onlyporn.example');

function fixture(...parts) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, ...parts), 'utf8');
}

function assertCatalogEntries(entries, expectedNames) {
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, expectedNames.length);
  assert.deepEqual(entries.map(entry => entry.name), expectedNames);
  for (const entry of entries) {
    assert.equal(entry.type, 'movie');
    assert.match(entry.id, /^https:\/\//);
    assert.match(entry.poster, /^https:\/\//);
    assert.equal(entry.posterShape, 'landscape');
  }
}

test('saved catalog fixtures parse for all six provider implementations', () => {
  const eporner = createEporner();
  const spankbang = createSpankbang();
  const xhamster = createXhamster();
  const porntrex = createPorntrex();
  const xvideos = createXvideos();
  const xnxx = createXnxx();

  assertCatalogEntries(
    eporner.getCatalogMetas(fixture('eporner', 'catalog.html')),
    ['Eporner Alpha', 'Eporner Beta']
  );

  assertCatalogEntries(
    spankbang.getCatalogMetas(
      fixture('spankbang', 'catalog.html'),
      'https://spankbang.com/new_videos/'
    ),
    ['SpankBang Fixture', 'SpankBang Second']
  );

  assertCatalogEntries(
    xhamster.getCatalogMetas(fixture('xhamster', 'catalog.html')),
    ['xHamster Fixture One', 'xHamster Fixture Two']
  );

  assertCatalogEntries(
    porntrex.getCatalogMetas(fixture('porntrex', 'catalog.html')),
    ['Porntrex Fixture One', 'Porntrex Fixture Two']
  );

  assertCatalogEntries(
    xvideos.getCatalogMetas(fixture('xvideos', 'catalog.html')),
    ['Fixture One', 'Fixture Two']
  );

  assertCatalogEntries(
    xnxx.getCatalogMetas(fixture('xnxx', 'catalog.html')),
    ['Fixture One', 'Fixture Two']
  );
});

test('saved video fixtures preserve metadata and prefer genuine direct MP4 streams', async () => {
  const eporner = createEporner();
  const epornerMeta = eporner.parseVideoPage({
    id: 'https://www.eporner.com/video-fixture/test/',
    html: fixture('eporner', 'video.html'),
  });
  assert.equal(epornerMeta.name, 'Eporner Fixture Video');
  const epornerSources = JSON.parse(fixture('eporner', 'sources.json')).sources;
  const epornerStreams = await eporner.selectSources(epornerSources);
  assert.deepEqual(epornerStreams.streams.map(stream => stream.name), ['1080p MP4', '720p MP4']);
  assert.ok(epornerStreams.streams.every(stream => !/preview|\.t\.mp4/i.test(stream.url)));

  const spankbang = createSpankbang();
  const spankbangParsed = await spankbang.parseVideoPage({
    id: 'https://spankbang.com/abc12/video/fixture-one',
    html: fixture('spankbang', 'video.html'),
    is4kCategory: false,
  });
  assert.equal(spankbangParsed.metaResponse.name, 'SpankBang Fixture Video');
  assert.deepEqual(spankbangParsed.streams.map(stream => stream.name), ['1080p', '720p']);
  assert.ok(spankbangParsed.streams.every(stream => stream.behaviorHints?.proxyHeaders?.request?.Referer));

  const xhamster = createXhamster();
  const xhamsterMeta = xhamster.parseVideoPage({
    id: 'https://xhamster.com/videos/fixture-one-123',
    html: fixture('xhamster', 'video.html'),
  });
  assert.equal(xhamsterMeta.name, 'xHamster Fixture Video');
  assert.deepEqual(xhamsterMeta.streams.map(stream => stream.name), ['1080p MP4', '720p MP4']);
  assert.equal(JSON.stringify(xhamsterMeta).includes('streams'), false);

  const porntrex = createPorntrex();
  porntrex.resolveStream = async url => url;
  const porntrexParsed = await porntrex.parseVideoPage({
    id: 'https://www.porntrex.com/videos/12345/fixture-one/',
    html: fixture('porntrex', 'video.html'),
  });
  assert.equal(porntrexParsed.metaResponse.name, 'Porntrex Fixture Video');
  assert.deepEqual(
    porntrexParsed.streams.map(stream => stream.name),
    ['2160p', '1080p', '720p', '480p']
  );

  const xvideos = createXvideos();
  const xvideosParsed = xvideos.parseVideoPage({
    id: 'https://www.xvideos.com/video.abc123/fixture-one',
    html: fixture('xvideos', 'video.html'),
  });
  assert.equal(xvideosParsed.metaResponse.name, 'Fixture Video');
  assert.equal(xvideosParsed.directMp4Streams[0].name, 'XVideos 1080p MP4');
  assert.equal(xvideosParsed.videoPageUrl, 'https://hls-fixture.xvideos-cdn.com/xv-master.m3u8');
  assert.match(xvideosParsed.directMp4Streams[0].url, /^https:\/\/onlyporn\.example\/media\//);

  const xnxx = createXnxx();
  const xnxxParsed = xnxx.parseVideoPage({
    id: 'https://www.xnxx.com/video-abc123/fixture-one',
    html: fixture('xnxx', 'video.html'),
  });
  assert.equal(xnxxParsed.metaResponse.name, 'Fixture Video');
  assert.equal(xnxxParsed.directMp4Streams[0].name, 'XNXX 1080p MP4');
  assert.equal(xnxxParsed.videoPageUrl, 'https://cdn.example/xn-master.m3u8');
  assert.match(xnxxParsed.metaResponse.poster, /thumbs169ll/);
  assert.doesNotMatch(xnxxParsed.metaResponse.poster, /THUMBNUM/);
});

test('search, genre and pagination routes remain deterministic and page windows do not repeat', () => {
  const cases = [
    {
      name: 'eporner',
      provider: createEporner(),
      initial: 'https://www.eporner.com',
      search: 'https://www.eporner.com/search/fixture-term/',
      genre: 'https://www.eporner.com/search/4k-porn/SORT-top-weekly/',
      genreValue: '4k Porn (Weekly Top)',
    },
    {
      name: 'spankbang',
      provider: createSpankbang(),
      initial: 'https://spankbang.com/trending_videos/',
      search: 'https://spankbang.com/s/fixture%20term/',
      genre: 'https://spankbang.com/trending_videos/?q=uhd',
      genreValue: '4K (Trending)',
    },
    {
      name: 'xhamster',
      provider: createXhamster(),
      initial: 'https://xhamster.com',
      search: 'https://xhamster.com/search/fixture%20term/',
      genre: 'https://xhamster.com/4k',
      genreValue: '4K',
    },
    {
      name: 'porntrex',
      provider: createPorntrex(),
      initial: 'https://www.porntrex.com/latest-updates/',
      search: 'https://www.porntrex.com/search/fixture%20term/',
      genre: 'https://www.porntrex.com/top-rated/',
      genreValue: 'Top Rated',
    },
    {
      name: 'xvideos',
      provider: createXvideos(),
      initial: 'https://www.xvideos.com',
      search: 'https://www.xvideos.com/?k=fixture%20term',
      genre: 'https://www.xvideos.com/?k=Amateur',
      genreValue: 'Amateur',
    },
    {
      name: 'xnxx',
      provider: createXnxx(),
      initial: 'https://www.xnxx.com/todays-selection',
      search: 'https://www.xnxx.com/search/fixture+term/',
      genre: 'https://www.xnxx.com/hits',
      genreValue: 'hits',
    },
  ];

  for (const item of cases) {
    const args = { id: item.name, extra: { search: 'fixture term' } };
    assert.equal(item.provider.getInitialUrl(item.name), item.initial, item.name);
    assert.equal(item.provider.handleSearch(args), item.search, item.name);
    assert.equal(
      item.provider.handleGenre({ id: item.name, extra: { genre: item.genreValue } }),
      item.genre,
      item.name
    );

    const page1 = item.provider.handlePagination(item.initial, {
      extra: { skip: 0, search: '' },
    });
    const page2 = item.provider.handlePagination(item.initial, {
      extra: { skip: item.provider.limit, search: '' },
    });
    const page3 = item.provider.handlePagination(item.initial, {
      extra: { skip: item.provider.limit * 2, search: '' },
    });

    assert.equal(new Set([page1, page2, page3]).size, 3, `${item.name} pagination repeated`);
  }
});

test('HLS fixture parsing orders variants by resolution and resolves relative URLs', () => {
  const provider = new Provider('https://example.com/', 'fixture', 20, {
    allowedPageHosts: ['example.com'],
  });
  const parsed = provider.parseM3u8(fixture('hls', 'master.m3u8'));
  const transformed = parsed.map(stream =>
    provider.transformStream('https://cdn.example/path/master.m3u8', stream)
  );

  assert.deepEqual(transformed.map(stream => stream.name), ['1080p', '720p', '360p']);
  assert.deepEqual(transformed.map(stream => stream.url), [
    'https://cdn.example/1080/playlist.m3u8',
    'https://cdn.example/720/playlist.m3u8',
    'https://cdn.example/path/360/playlist.m3u8',
  ]);
});

test('central request layer retries recoverable failures and deduplicates concurrent calls', async () => {
  const provider = new Provider('https://example.com/', 'fixture', 20, {
    allowedPageHosts: ['example.com'],
  });
  provider.retryDelay = () => 0;

  let attempts = 0;
  provider.client.request = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { status: 503, data: 'temporary', headers: {} };
    }
    return { status: 200, data: 'recovered', headers: {} };
  };

  const recovered = await provider.request('https://example.com/retry', {
    checkDns: false,
    retries: 1,
    cache: null,
  });
  assert.equal(recovered.data, 'recovered');
  assert.equal(attempts, 2);

  let concurrentCalls = 0;
  provider.client.request = async () => {
    concurrentCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { status: 200, data: 'one response', headers: {} };
  };

  const [left, right] = await Promise.all([
    provider.request('https://example.com/same', { checkDns: false, cache: null }),
    provider.request('https://example.com/same', { checkDns: false, cache: null }),
  ]);
  assert.equal(left.data, 'one response');
  assert.equal(right.data, 'one response');
  assert.equal(concurrentCalls, 1);
});

test('manifest catalog IDs are unique and every catalog resolves to its intended provider', () => {
  const ids = catalogs.map(catalog => catalog.id);
  assert.equal(ids.length, 8);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('spankbang'), 'SpankBang remains declared even when Render is blocked upstream');

  for (const catalog of catalogs) {
    const expected = catalog.id.split('.')[0];
    assert.ok(catalogNames.includes(expected));
    assert.equal(loadProvider(catalog.id).getName(), expected);
  }
});

test('fixture suite is offline-only and contains no live provider snapshots or secrets', () => {
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(FIXTURE_ROOT);

  assert.ok(files.length >= 13);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/);
    assert.doesNotMatch(content, /(?:api[_-]?key|password|authorization)\s*[:=]\s*['"][^'"]+/i);
  }
});
