'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { readTpb4kConfig } = require('./tpb4k/config');
const { createSukebeiMetadataAdapter } = require('./tpb4k/sukebei-metadata');

test('Sukebei source has no eight-card output or artwork ceiling', () => {
  const source = fs.readFileSync(
    require.resolve('./tpb4k/sukebei-metadata'),
    'utf8'
  );
  assert.match(source, /const detailTargetLimit = detailLimit/);
  assert.match(source, /const needed = safeSkip \+ safeLimit/);
  assert.match(source, /allowed\.slice\(safeSkip, safeSkip \+ safeLimit\)/);
  assert.doesNotMatch(source, /Math\.min\(detailLimit, 8\)/);
  assert.doesNotMatch(source, /Math\.min\(safeSkip \+ safeLimit, 8\)/);
});

test('Sukebei has a dedicated catalogue cache revision', () => {
  const provider = fs.readFileSync(
    require.resolve('./tpb4k.js'),
    'utf8'
  );
  assert.match(
    provider,
    /SUKEBEI_CATALOG_CACHE_REVISION = 's2'/
  );
  assert.match(
    provider,
    /String\(args\?\.id \|\| ''\) === 'tpb4k\.sukebei\.top'/
  );
  assert.match(
    provider,
    /`\$\{CATALOG_CACHE_REVISION\}-\$\{SUKEBEI_CATALOG_CACHE_REVISION\}`/
  );
});

function hashFor(number) {
  return Number(number).toString(16).padStart(40, '0');
}

function topRow(number) {
  const hash = hashFor(number);
  const title = `JAV-${String(number).padStart(3, '0')} Fixture Release 1080p`;
  const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`;
  return `<tr>
    <td>2_2</td>
    <td><a href="/view/${number}" title="${title}">${title}</a></td>
    <td>
      <a href="/download/${number}.torrent">torrent</a>
      <a href="${magnet}">magnet</a>
    </td>
    <td>2.0 GiB</td>
    <td data-timestamp="1785800000">2026-08-04</td>
    <td>${200 - number}</td>
    <td>0</td>
    <td>5</td>
  </tr>`;
}

function rssItem(number) {
  const hash = hashFor(number);
  const title = `RSS-${String(number).padStart(3, '0')} Fixture Release 2160p`;
  return `<item>
    <guid>https://sukebei.nyaa.si/view/${number}</guid>
    <title>${title}</title>
    <link>https://sukebei.nyaa.si/download/${number}.torrent</link>
    <nyaa:infoHash>${hash}</nyaa:infoHash>
    <nyaa:seeders>${300 - number}</nyaa:seeders>
    <nyaa:size>3.0 GiB</nyaa:size>
  </item>`;
}

function response(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

test('Sukebei combines Top plus RSS and honors 40-card pagination without metadata services', async () => {
  const topHtml = `<html><body><table>${
    Array.from({ length: 45 }, (_, index) => topRow(index + 1)).join('')
  }</table></body></html>`;

  const rss = `<?xml version="1.0"?>
  <rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>${
    Array.from({ length: 20 }, (_, index) => rssItem(index + 101)).join('')
  }</channel></rss>`;

  const env = {
    TPB4K_ENABLED: 'true',
    TPB4K_CATALOG_LIMIT: '40',
    TPB4K_REQUEST_TIMEOUT_MS: '15000',
    ONLYPORN_DISABLE_PERSISTENT_CACHE: 'true',
    ONLYPORN_PUBLIC_BASE_URL: 'https://onlyporn.example',
  };
  const baseConfig = readTpb4kConfig(env);
  const requests = [];
  const adapter = createSukebeiMetadataAdapter({
    config: {
      ...baseConfig,
      sukebeiEnrichmentDeadlineMs: 4_000,
      sukebeiCodeLookupLimit: 1,
      sukebeiTitleLookupLimit: -1,
      sukebeiDetailImageLimit: -1,
      sukebeiRssPages: 1,
    },
    endpoint: 'https://sukebei.nyaa.si/?page=rss&c=0_0&f=0',
    metadataClients: {},
    env,
    checkDns: false,
    fetchImpl: async value => {
      const url = new URL(String(value));
      requests.push(url.toString());
      if (url.searchParams.get('page') === 'rss') {
        return response(rss, 'application/rss+xml');
      }
      if (url.searchParams.get('s') === 'seeders') {
        return response(topHtml, 'text/html');
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    },
  });

  const catalog = { id: 'tpb4k.sukebei.top', mode: 'top' };

  const first = await adapter.catalog({ catalog, skip: 0, limit: 40 });
  assert.equal(first.length, 40);
  assert.equal(new Set(first.map(item => item.sourceId)).size, 40);
  assert.ok(first.every(item => /^[a-f0-9]{40}$/.test(item.infoHash)));
  assert.ok(first.every(item => item.lookupSource === 'sukebei-rss-fallback'));
  assert.ok(first.every(item => /^https:\/\//.test(item.poster)));

  const firstDiagnostics = adapter.diagnostics().sukebeiMetadata;
  assert.equal(firstDiagnostics.discoveryMode, 'official-html-top+rss');
  assert.equal(firstDiagnostics.rssRecords, 65);
  assert.equal(firstDiagnostics.returned, 40);
  assert.equal(firstDiagnostics.rssFallbackCards, 40);

  const second = await adapter.catalog({ catalog, skip: 40, limit: 40 });
  assert.equal(second.length, 25);
  assert.equal(new Set(second.map(item => item.sourceId)).size, 25);
  assert.equal(
    new Set([...first, ...second].map(item => item.sourceId)).size,
    65
  );

  const secondDiagnostics = adapter.diagnostics().sukebeiMetadata;
  assert.equal(secondDiagnostics.rssRecords, 65);
  assert.equal(secondDiagnostics.returned, 25);
  assert.equal(secondDiagnostics.rssFallbackCards, 65);
  assert.ok(requests.some(url => url.includes('s=seeders')));
  assert.ok(requests.some(url => url.includes('page=rss')));
});
