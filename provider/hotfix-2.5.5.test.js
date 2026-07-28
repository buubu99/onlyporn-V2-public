'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mediaRelay = require('../media-relay');
const createJavHdPorn = require('./javhdporn');

const ROOT = path.resolve(__dirname, '..');
mediaRelay.setPublicBase('https://onlyporn.example');

test('SpankBang treats homepage bootstrap as best effort and trusts the requested route', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'scripts', 'safari_fetch_helper.py'),
    'utf8'
  );

  assert.match(source, /Best-effort homepage warmup; the requested route remains authoritative/);
  assert.match(source, /Cloudflare may challenge the homepage while allowing the real catalog\/video route/);
  assert.doesNotMatch(source, /raise RuntimeError\(f"SpankBang bootstrap returned HTTP/);
  assert.doesNotMatch(source, /raise RuntimeError\("SpankBang bootstrap returned a Cloudflare challenge"\)/);
  assert.match(source, /if ok:\n\s+# A successful real route proves/);
});

test('JAVHDPorn decrypts the captured inner reserve player values', () => {
  const reserve = [
    {
      data: 'fh7HjJZhrBgZQ/CQA8gS2+LUS0s1MuWMZxinIzO/Vg1GEu2wyPM53ZqumUrGBolg5Z1xgeiBy6uARcHm5ai5cUALEAXzxr2ylvsH+e4PWeMgQyI5',
      lo: 'de',
    },
    {
      data: 'fh7HjJZhrBgZQICUO/0OhtnbW0o0bJuMSRjEfxvPLgxvS/G05PQI15mh+kbEfKhs7+oZiPWs9vaUVcK/8pWQKlcMBxLA6Mj5l8U1se0fY+AgUzJz',
      lo: 'fr',
    },
    {
      data: 'fh7HjJZhrBgZQICUO/0OhtnbW0o0bJuMSRjEfxvPLgxTEuG356oh3aCh+0T/c5Fl7+oZiOG806iDVtHi8riLc0MMBxLA6Mj5l8U1se0fY+AgUzJz',
      lo: 'us',
    },
    {
      data: 'fh7H0ZNhmg4fcf+JO/JknObbdQobMu6PTxj2OhmrAxJuaf2k8/RexpPFmgr8TqAk8p0k2/aC0LWDa86s7IafckIbCBHextT7lsUhpcFWd+gjfik9L6jZLA==',
      lo: 'de3',
    },
  ];

  const decoded = createJavHdPorn._test.decodeReservePlayers(
    reserve,
    { videoId: '867640', version: '2' },
    'https://www.javhdporn.net/video/sama-251/'
  );

  assert.equal(decoded.length, 4);
  assert.equal(
    decoded[0].value,
    'https://video1.javhdporn.net/p/vgn5iatrsbmd?t=fb5e4c7413&s=1785276540'
  );
  assert.equal(decoded[0].context, 'reserve[0] de');
  assert.equal(
    decoded[3].value,
    'https://hugstream.xyz/p/vgn5iatrsbmd?t=c7409c5003&s=1785276540&os=2&l=1'
  );
  assert.equal(decoded[3].context, 'reserve[3] de3');
});

test('JAVHDPorn evaluates reserve players before the primary player', () => {
  const source = fs.readFileSync(path.join(ROOT, 'provider', 'javhdporn.js'), 'utf8');
  assert.match(source, /const decoded = \[\.\.\.reserveCandidates, \.\.\.primaryCandidates\]/);
  assert.match(source, /reservePlayers: reserveCandidates\.length/);
});

test('JAVHDPorn never exposes a raw HLS URL rejected by the protected relay', async () => {
  const provider = createJavHdPorn();
  const result = await provider.streamFromMedia({
    url: 'https://s1.maxstream.org/hls2/test/master.m3u8',
    referer: 'https://video.javhdporn.net/p/test',
    context: 'primary',
    kind: 'hls',
  });

  assert.equal(result, null);
});

test('JAVHDPorn keeps a relay-compatible reserve stream and filters the blocked primary', async () => {
  const provider = createJavHdPorn();
  provider.fetchHtml = async () => '<html></html>';
  provider.playerBootstrap = () => ({ videoId: '867640', mpu: 'fixture', version: '2' });
  provider.requestPlayerSources = async () => [];
  provider.discoverMedia = async () => [
    {
      url: 'https://s1.maxstream.org/hls2/test/master.m3u8',
      referer: 'https://video.javhdporn.net/p/primary',
      context: 'primary',
      kind: 'hls',
    },
    {
      url: 'https://streamhls.click/hls/test/master.m3u8',
      referer: 'https://video1.javhdporn.net/p/reserve',
      context: 'reserve[0] de',
      kind: 'hls',
    },
  ];

  const response = await provider.processStreams({
    id: 'https://www.javhdporn.net/video/sama-251/',
  });

  assert.equal(response.streams.length, 1);
  assert.match(response.streams[0].url, /^https:\/\/onlyporn\.example\/media\//);
  assert.equal(response.streams[0].behaviorHints.notWebReady, false);
});

test('OnlyPorn hotfix release reports version 2.5.5', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.version, '2.5.5');
  assert.match(pkg.scripts['test:release'], /hotfix-2\.5\.5\.test\.js/);
});
