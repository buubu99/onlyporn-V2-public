#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { hasStrongChallengeMarker } = require('../provider/challenge-detection');
const { buildCatalogUrl, parseHentaiCatalog } = require('../provider/tpb4k/native-discovery');

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const routes = [
  ['all', 1], ['all', 2],
  ['new', 1], ['new', 2],
  ['top', 1], ['top', 2],
];

function exactPathEvidence(html) {
  return [...String(html || '').matchAll(/href\s*=\s*["'][^"']*\/tvshows\/[^"'?#]+\/?(?:[?#][^"']*)?["']/gi)].length;
}

function articleEvidence(html) {
  return [...String(html || '').matchAll(/<article\b[^>]*class=["'][^"']*\b(?:item|tvshows)\b[^"']*["']/gi)].length;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'text/html, application/xhtml+xml;q=0.9',
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': USER_AGENT,
      },
    });
    const contentType = String(response.headers.get('content-type') || '');
    const html = await response.text();
    return { status: response.status, contentType, html };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const reports = [];
  const signatures = new Map();

  for (const [mode, page] of routes) {
    const url = buildCatalogUrl('hentai', { mode }, page);
    const started = Date.now();
    const response = await fetchHtml(url);
    const bytes = Buffer.byteLength(response.html, 'utf8');
    const paths = exactPathEvidence(response.html);
    const articles = articleEvidence(response.html);
    const challengeMarker = hasStrongChallengeMarker(response.html);
    const items = parseHentaiCatalog(response.html);
    const ids = items.map(item => item.sourceId);

    assert.equal(response.status, 200, `${mode} page ${page} returned HTTP ${response.status}`);
    assert.match(response.contentType.toLowerCase(), /text\/html|application\/xhtml\+xml/, `${mode} page ${page} returned ${response.contentType}`);
    assert.ok(bytes >= 4_000, `${mode} page ${page} returned only ${bytes} bytes`);
    assert.ok(paths > 0, `${mode} page ${page} contained no exact /tvshows/ links`);
    assert.ok(articles > 0, `${mode} page ${page} contained no catalog articles`);
    assert.ok(items.length > 0, `${mode} page ${page} parser returned zero records`);
    assert.equal(new Set(ids).size, ids.length, `${mode} page ${page} parser returned duplicate IDs`);

    signatures.set(`${mode}:${page}`, ids);
    reports.push({
      mode,
      page,
      url,
      status: response.status,
      contentType: response.contentType,
      bytes,
      exactTvshowLinks: paths,
      catalogArticles: articles,
      challengeMarker,
      parsed: items.length,
      posters: items.filter(item => item.poster).length,
      elapsedMs: Date.now() - started,
      first: items.slice(0, 3).map(item => ({ title: item.title, detailUrl: item.detailUrl, poster: item.poster })),
    });
  }

  for (const mode of ['all', 'new', 'top']) {
    const first = new Set(signatures.get(`${mode}:1`) || []);
    const second = signatures.get(`${mode}:2`) || [];
    const overlap = second.filter(id => first.has(id)).length;
    assert.ok(overlap < second.length, `${mode} page two completely repeated page one`);
  }

  const modeSignature = mode => (signatures.get(`${mode}:1`) || []).join('|');
  assert.notEqual(modeSignature('all'), modeSignature('new'), 'Hentai All and New returned identical ordering');
  assert.notEqual(modeSignature('all'), modeSignature('top'), 'Hentai All and Top returned identical ordering');
  assert.notEqual(modeSignature('new'), modeSignature('top'), 'Hentai New and Top returned identical ordering');

  console.log(JSON.stringify({
    version: require('../package.json').version,
    status: 'passed',
    routes: reports,
  }, null, 2));
}

main().catch(error => {
  console.error(`TPB4K Hentai live smoke failed: ${error.message}`);
  process.exitCode = 1;
});
