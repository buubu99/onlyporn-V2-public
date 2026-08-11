'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const createJavHdPorn = require('./javhdporn');
const { decodeSource, javPosterProxyUrl } = require('./javhdporn-poster-proxy');
const { createSearchSqliteStore } = require('./search-sqlite');

test('JAV search cards ignore data placeholders and choose the largest real srcset poster', () => {
  const provider = createJavHdPorn();
  const html = `
    <article class="thumb-block loop-video">
      <a href="/ja/video/test-search-poster/" title="FC2 PPV Uncensored Test">
        <picture>
          <source data-srcset="
            https://pics.pornfhd.com/test-640.jpg 640w,
            https://pics.pornfhd.com/test-1280.jpg 1280w
          ">
          <img
            alt="FC2 PPV Uncensored Test"
            src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
            data-srcset="
              https://pics.pornfhd.com/test-320.jpg 320w,
              https://pics.pornfhd.com/test-960.jpg 960w
            ">
        </picture>
      </a>
    </article>`;
  const metas = provider.getCatalogMetas(
    html,
    'https://www.javhdporn.net/search/uncensored/'
  );
  assert.equal(metas.length, 1);
  assert.equal(metas[0].id, 'https://www.javhdporn.net/ja/video/test-search-poster/');
  assert.match(metas[0].poster, /\/onlyporn\/poster\/javhdporn\//);
  assert.equal(decodeSource(metas[0].poster.split('/').pop()), 'https://pics.pornfhd.com/test-1280.jpg');
  assert.notEqual(metas[0].poster, 'https://pics.pornfhd.com/404.jpeg');
});

test('search SQLite exposes live pool count and catalog rows without touching MetaTube', async t => {
  const root = fs.mkdtempSync('/tmp/onlyporn-search-v73-');
  const env = {
    ...process.env,
    ONLYPORN_RUNTIME_DIR: root,
    ONLYPORN_DISABLE_PERSISTENT_CACHE: 'false',
    ONLYPORN_SEARCH_SQLITE_ENABLED: 'true',
    ONLYPORN_SEARCH_MIN_FREE_BYTES: '1',
  };
  const store = createSearchSqliteStore({ env });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await store.upsertPool('tpb4k.test', [
    { source: 'studio-metadata', sourceId: 'm1', title: 'Visible Alpha', poster: 'https://img.example/a.jpg' },
    { source: 'torrent-index', sourceId: 't1', title: 'Visible Beta', infoHash: 'a'.repeat(40) },
  ]);

  assert.equal(await store.countPool('tpb4k.test'), 2);
  const rows = await store.listPool('tpb4k.test', 10);
  assert.equal(rows.length, 2);
  assert.equal(store.dbPath.includes('/search/search-v1.sqlite'), true);
  assert.equal(store.dbPath.includes('/metatube/metatube.db'), false);
});

test('V7.3 warm search paths are present and studio prewarm seeds torrent pools', () => {
  const source = fs.readFileSync(path.resolve(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(source, /tpb4k\.source\.hentai/);
  assert.match(source, /sqlite-warm-miss/);
  assert.match(source, /sqlite-local-binding/);
  assert.match(source, /mergeSearchItems\(metadataItems, torrentItems, enrichedTorrentItems\)/);
  assert.match(source, /countPool\(poolCatalogId\)/);
});

test('JAV live wp.com wrapper posters canonicalize to allowlisted JAVFun origin and stay on OnlyV2 proxy', () => {
  const samples = [
    'https://i1.wp.com/www9.javfun.me/Cms_Data/Contents/admin/example-a.jpg?resize=300%2C450&ssl=1',
    'https://i0.wp.com/www9.javfun.me/Cms_Data/Contents/admin/example-b.jpg?fit=320%2C480&ssl=1',
    'https://i2.wp.com/www9.javfun.me/Cms_Data/Contents/admin/example-c.jpg?ssl=1',
    'https://i3.wp.com/www9.javfun.me/Cms_Data/Contents/admin/example-d.jpg?ssl=1',
  ];

  for (const [index, source] of samples.entries()) {
    const proxied = javPosterProxyUrl(source, {
      ADDON_BASE_URL: 'https://onlyporn.example',
    });

    assert.match(
      proxied,
      /^https:\/\/onlyporn\.example\/onlyporn\/poster\/javhdporn\//
    );

    assert.equal(
      decodeSource(proxied.split('/').pop()),
      `https://www9.javfun.me/Cms_Data/Contents/admin/example-${String.fromCharCode(97 + index)}.jpg`
    );
  }
});
