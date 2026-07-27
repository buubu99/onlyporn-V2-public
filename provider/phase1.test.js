const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BoundedTtlCache = require('./cache');
const {
  assertSafeHttpsUrl,
  decodeResourceId,
  encodeResourceId,
  isPrivateIp,
  parseHttpsUrl,
} = require('./url-security');

test('bounded cache rejects empty failures and evicts the oldest entry', () => {
  const cache = new BoundedTtlCache({ maxEntries: 2, ttlMs: 60_000 });

  assert.equal(cache.set('empty', ''), false);
  assert.equal(cache.set('null', null), false);
  cache.set('one', 'A');
  cache.set('two', 'B');
  cache.set('three', 'C');

  assert.equal(cache.get('one'), undefined);
  assert.equal(cache.get('two'), 'B');
  assert.equal(cache.get('three'), 'C');
  assert.equal(cache.size, 2);
});

test('bounded cache removes expired entries', async () => {
  const cache = new BoundedTtlCache({ maxEntries: 2, ttlMs: 5 });
  cache.set('short', 'value');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cache.get('short'), undefined);
  assert.equal(cache.size, 0);
});

test('provider-scoped resource IDs round-trip without exposing a raw URL', () => {
  const raw = 'https://www.xvideos.com/video.example/test';
  const encoded = encodeResourceId('xvideos', raw);

  assert.match(encoded, /^onlyporn:xvideos:/);
  assert.equal(encoded.includes('https://'), false);
  assert.equal(decodeResourceId(encoded, 'xvideos'), raw);
  assert.equal(decodeResourceId(encoded, 'xnxx'), null);
});

test('URL parser permits only standard HTTPS URLs without credentials', () => {
  assert.equal(parseHttpsUrl('https://example.com/a?b=1#fragment').toString(), 'https://example.com/a?b=1');
  assert.throws(() => parseHttpsUrl('http://example.com'), /Only HTTPS/);
  assert.throws(() => parseHttpsUrl('https://user:pass@example.com'), /Credentials/);
  assert.throws(() => parseHttpsUrl('https://example.com:8443'), /standard HTTPS port/);
  assert.throws(() => parseHttpsUrl('https://localhost/test'), /Local hostnames/);
});

test('private and reserved IP address ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  assert.equal(isPrivateIp('1.1.1.1'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});

test('approved-host validation rejects an unapproved redirect destination', async () => {
  const allowedHosts = new Set(['example.com']);
  assert.equal(
    await assertSafeHttpsUrl('https://example.com/path', { allowedHosts, checkDns: false }),
    'https://example.com/path'
  );
  await assert.rejects(
    assertSafeHttpsUrl('https://evil.example/path', { allowedHosts, checkDns: false }),
    /not approved/
  );
});

test('Phase 1 source fixes remain present', () => {
  const providerDir = __dirname;
  const providerSource = fs.readFileSync(path.join(providerDir, 'provider.js'), 'utf8');
  const porntrexSource = fs.readFileSync(path.join(providerDir, 'porntrex.js'), 'utf8');
  const xvideosSource = fs.readFileSync(path.join(providerDir, 'xvideos.js'), 'utf8');

  assert.match(providerSource, /Math\.floor\(numericSkip \/ this\.limit\) \+ 1/);
  assert.doesNotMatch(porntrexSource, /this\.perPage/);
  assert.match(porntrexSource, /search\/\$\{encodeURIComponent\(keyword\)\}/);
  assert.match(xvideosSource, /videoMatch \? videoMatch\[1\] : jsonContentUrl/);
  assert.doesNotMatch(
    xvideosSource.slice(xvideosSource.indexOf('async processStreams')),
    /\$\('script\[type="application\/ld\+json"\]'/
  );
});
