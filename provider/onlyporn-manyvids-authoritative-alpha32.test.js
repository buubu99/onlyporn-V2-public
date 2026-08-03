'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const {
  allowedManyvidsMediaUrl,
  authoritativeManyvidsUrls,
  manyvidsVideoId,
  resolveAuthoritativeManyVids,
  titleMatches,
} = require('./tpb4k/manyvids-authoritative');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mp4Response(status = 206, url = 'https://cdn10.manyvids.com/test.mp4') {
  const body = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.alloc(128),
  ]);
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'video/mp4' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('accepts only exact authoritative ManyVids scene URLs', () => {
  const item = {
    detailUrl: 'https://www.manyvids.com/Video/123/Exact-Scene',
    _rawScene: {
      urls: [
        { url: 'https://www.manyvids.com/Video/123/Exact-Scene' },
        { url: 'https://example.com/Video/123/Exact-Scene' },
        { url: 'https://ods.manyvids.com/poster.jpg' },
      ],
    },
  };
  assert.deepEqual(authoritativeManyvidsUrls(item), [
    'https://www.manyvids.com/Video/123/Exact-Scene',
  ]);
  assert.equal(manyvidsVideoId(item.detailUrl), '123');
  assert.equal(
    allowedManyvidsMediaUrl('https://cdn10.manyvids.com/a.mp4'),
    'https://cdn10.manyvids.com/a.mp4'
  );
  assert.equal(allowedManyvidsMediaUrl('https://unrelated.example/a.mp4'), '');
});

test('title identity rejects unrelated provider media', () => {
  assert.equal(titleMatches('Exact Scene', 'EXACT SCENE'), true);
  assert.equal(titleMatches('Exact Scene', 'Corporate Training Presentation'), false);
});

test('prefers a validated full transcoded file and suppresses preview fallback', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/private')) {
      return jsonResponse({
        data: {
          transcodedFilepath: 'https://cdn10.manyvids.com/full.mp4?Expires=9999999999',
          filepath: 'https://cdn10.manyvids.com/original.mp4',
          teaser: { filepath: 'https://ods.manyvids.com/preview.mp4' },
        },
      });
    }
    if (/\/bff\/store\/video\/123$/.test(String(url))) {
      return jsonResponse({ data: { title: 'Exact Scene' } });
    }
    if (String(url).includes('full.mp4')) return mp4Response(206, String(url));
    if (String(url).includes('original.mp4')) return new Response('forbidden', { status: 403 });
    throw new Error(`Unexpected request: ${url}`);
  };

  const candidates = await resolveAuthoritativeManyVids({
    item: {
      title: 'Exact Scene',
      detailUrl: 'https://www.manyvids.com/Video/123/Exact-Scene',
    },
    fetchImpl,
  });

  assert.equal(candidates.length, 1);
  assert.match(candidates[0].title, /\[FULL\]$/);
  assert.equal(candidates[0].validated, true);
  assert.equal(candidates[0].relayProvider, 'manyvids');
  assert.equal(
    candidates[0].requestHeaders.Referer,
    'https://www.manyvids.com/Video/123/Exact-Scene'
  );
  assert.equal(calls.some(url => url.includes('preview.mp4')), false);
});

test('uses a clearly labelled official preview only when no full file validates', async () => {
  const fetchImpl = async url => {
    if (String(url).endsWith('/private')) {
      return jsonResponse({
        data: {
          transcodedFilepath: 'https://cdn10.manyvids.com/full.mp4',
          teaser: { filepath: 'https://ods.manyvids.com/preview_720.mp4' },
        },
      });
    }
    if (/\/bff\/store\/video\/456$/.test(String(url))) {
      return jsonResponse({ data: { title: 'Preview Scene' } });
    }
    if (String(url).includes('full.mp4')) return new Response('forbidden', { status: 403 });
    if (String(url).includes('preview_720.mp4')) return mp4Response(206, String(url));
    throw new Error(`Unexpected request: ${url}`);
  };

  const candidates = await resolveAuthoritativeManyVids({
    item: {
      title: 'Preview Scene',
      _rawScene: {
        urls: [{ url: 'https://www.manyvids.com/Video/456/Preview-Scene' }],
      },
    },
    fetchImpl,
  });

  assert.equal(candidates.length, 1);
  assert.match(candidates[0].title, /\[PREVIEW\]$/);
  assert.equal(candidates[0].quality, 'Preview');
  assert.equal(candidates[0].resolution, '720p');
});

test('mismatched BFF title produces no direct candidate', async () => {
  const fetchImpl = async url => {
    if (String(url).endsWith('/private')) {
      return jsonResponse({
        data: { transcodedFilepath: 'https://cdn10.manyvids.com/full.mp4' },
      });
    }
    return jsonResponse({ data: { title: 'Different Unrelated Scene' } });
  };

  const candidates = await resolveAuthoritativeManyVids({
    item: {
      title: 'Expected Scene',
      detailUrl: 'https://www.manyvids.com/Video/789/Expected-Scene',
    },
    fetchImpl,
  });
  assert.deepEqual(candidates, []);
});

test('relay permits only the narrow ManyVids suffix and preserves explicit YesPorn transport', () => {
  assert.equal(mediaRelay._test.hostnameAllowed('cdn10.manyvids.com', 'manyvids'), true);
  assert.equal(mediaRelay._test.hostnameAllowed('ods.manyvids.com', 'manyvids'), true);
  assert.equal(mediaRelay._test.hostnameAllowed('manyvids.example.com', 'manyvids'), false);

  const source = fs.readFileSync(path.join(__dirname, '..', 'media-relay.js'), 'utf8');
  assert.match(source, /entry\.provider === 'yesporn'\s*&&\s*entry\.kind === 'mp4'/);
  assert.doesNotMatch(source, /\[\s*'yesporn'\s*,\s*'manyvids'\s*\]\.includes/);
});

test('provider integration is restricted to the two unresolved catalog IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.match(source, /tpb4k\.studio\.xvideosred\.top/);
  assert.match(source, /tpb4k\.tpdb\.recent/);
  assert.match(source, /AUTHORITATIVE_MANYVIDS_CATALOGS/);
  assert.match(source, /resolveAuthoritativeManyVids/);
});
