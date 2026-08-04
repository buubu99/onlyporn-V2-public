'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const resolver = require('./tpb4k/manyvids-authoritative');

function box(type, payload) {
  const body = Buffer.from(payload || []);
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, 'ascii');
  body.copy(out, 8);
  return out;
}

function mvhd(seconds, timescale = 1000) {
  const payload = Buffer.alloc(100);
  payload.writeUInt8(0, 0);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(Math.round(seconds * timescale), 16);
  return box('mvhd', payload);
}

function mp4(seconds) {
  const ftyp = box('ftyp', Buffer.from('isom0000isom'));
  const moov = box('moov', mvhd(seconds));
  return Buffer.concat([ftyp, moov, Buffer.alloc(2048)]);
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mediaResponse(url, seconds, status = 206) {
  const body = mp4(seconds);
  const response = new Response(body, {
    status,
    headers: {
      'content-type': 'video/mp4',
      'content-range': `bytes 0-${body.length - 1}/${body.length}`,
      'content-length': String(body.length),
    },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

test('parses provider and MP4 durations', () => {
  assert.equal(resolver.parseDurationSeconds('13:04'), 784);
  assert.equal(resolver.parseDurationSeconds('1:02:03'), 3723);
  assert.equal(Math.round(resolver.parseMvhdDuration(mp4(125))), 125);
});

test('returns every distinct duration-verified full variant and never requests the teaser', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/private')) return jsonResponse({ data: {
      transcodedFilepath: 'https://cdn10.manyvids.com/full_1080.mp4',
      filepath: 'https://cdn10.manyvids.com/full_original.mp4',
      teaser: { filepath: 'https://ods.manyvids.com/preview/short.mp4' },
    }});
    if (/\/bff\/store\/video\/123$/.test(value)) return jsonResponse({ data: {
      title: 'Exact Scene', videoDuration: '02:00',
    }});
    if (value.includes('full_1080')) return mediaResponse(value, 120);
    if (value.includes('full_original')) return mediaResponse(value, 121);
    throw new Error(`Unexpected ${value}`);
  };
  const candidates = await resolver.resolveAuthoritativeManyVids({
    item: {
      title: 'Exact Scene',
      duration: 120,
      detailUrl: 'https://www.manyvids.com/Video/123/exact-scene',
    },
    fetchImpl,
  });
  assert.equal(candidates.length, 2);
  assert.equal(candidates.every(candidate => candidate.quality === 'Full'), true);
  assert.equal(candidates.every(candidate => candidate.validated === true), true);
  assert.equal(
    candidates.every(candidate => candidate.provenance.includes('manyvids-duration-verified')),
    true
  );
  assert.equal(calls.some(url => url.includes('/preview/')), false);
});

test('rejects a ten-second file even when it is placed in transcodedFilepath', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const value = String(url);
    calls.push(value);
    if (value.endsWith('/private')) return jsonResponse({ data: {
      transcodedFilepath: 'https://cdn10.manyvids.com/not_really_full.mp4',
      teaser: { filepath: 'https://ods.manyvids.com/preview/teaser.mp4' },
    }});
    if (/\/bff\/store\/video\/456$/.test(value)) return jsonResponse({ data: {
      title: 'Long Scene', videoDuration: '13:04', size: '1.38 GB',
    }});
    if (value.includes('not_really_full')) return mediaResponse(value, 10);
    throw new Error(`Unexpected ${value}`);
  };
  const candidates = await resolver.resolveAuthoritativeManyVids({
    item: {
      title: 'Long Scene',
      duration: 784,
      detailUrl: 'https://www.manyvids.com/Video/456/long-scene',
    },
    fetchImpl,
  });
  assert.deepEqual(candidates, []);
  assert.equal(calls.some(url => url.includes('/preview/')), false);
});

test('a paid scene exposing only teaser media returns no direct stream', async () => {
  const fetchImpl = async url => {
    const value = String(url);
    if (value.endsWith('/private')) return jsonResponse({ data: {
      teaser: { filepath: 'https://ods.manyvids.com/preview/teaser.mp4' },
    }});
    return jsonResponse({ data: {
      title: 'Paid Scene', videoDuration: '20:00', size: '2 GB',
    }});
  };
  const candidates = await resolver.resolveAuthoritativeManyVids({
    item: {
      title: 'Paid Scene',
      duration: 1200,
      detailUrl: 'https://www.manyvids.com/Video/789/paid-scene',
    },
    fetchImpl,
  });
  assert.deepEqual(candidates, []);
});

test('finds duration in a tail-located moov atom', async () => {
  const ftyp = box('ftyp', Buffer.from('isom0000isom'));
  const large = Buffer.concat([
    ftyp,
    box('mdat', Buffer.alloc(2 * 1024 * 1024)),
    box('moov', mvhd(90)),
  ]);
  const url = 'https://cdn10.manyvids.com/tail-moov.mp4';
  const fetchImpl = async (_url, options = {}) => {
    const range = String(options?.headers?.Range || options?.headers?.range || '');
    let start = 0;
    let end = large.length - 1;
    const normal = range.match(/^bytes=(\d+)-(\d+)$/);
    const suffix = range.match(/^bytes=-(\d+)$/);
    if (normal) {
      start = Number(normal[1]);
      end = Math.min(Number(normal[2]), large.length - 1);
    } else if (suffix) {
      start = Math.max(large.length - Number(suffix[1]), 0);
    }
    const body = large.subarray(start, end + 1);
    const response = new Response(body, {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${large.length}`,
        'content-length': String(body.length),
      },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const probe = await resolver.probeManyvidsMedia(
    fetchImpl,
    url,
    'https://www.manyvids.com/Video/999/tail',
    { expectedDurationSeconds: 90 }
  );
  assert.equal(probe.valid, true);
  assert.equal(Math.round(probe.durationSeconds), 90);
});

test('ManyVids helper remains teaser-safe but is no longer wired to removed catalogues', () => {
  const resolverSource = fs.readFileSync(
    path.join(__dirname, 'tpb4k', 'manyvids-authoritative.js'),
    'utf8'
  );
  const providerSource = fs.readFileSync(path.join(__dirname, 'tpb4k.js'), 'utf8');
  assert.doesNotMatch(resolverSource, /official-preview|manyvids-official-preview/);
  assert.doesNotMatch(resolverSource, /candidateFromMedia\([\s\S]{0,500}preview:\s*true/);
  assert.match(resolverSource, /manyvids-duration-verified/);
  assert.match(resolverSource, /parseMvhdDuration/);
  assert.doesNotMatch(providerSource, /resolveAuthoritativeManyVids/);
  assert.match(providerSource, /if \(!rawCandidates\.length\)[\s\S]{0,300}resolverAdapter\.resolve/);
});
